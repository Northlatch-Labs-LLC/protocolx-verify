#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# Deploys the worker straight through the Cloudflare API — no wrangler, no npm install.
#
# Needs two things, both named, neither defaulted to anything dangerous:
#   CF_ACCOUNT_ID  — the Cloudflare account id (visible on the dashboard's right sidebar)
#   a token file   — ~/.config/protocolx/cloudflare-workers.token by default, holding an
#                    API token created from the "Edit Cloudflare Workers" template.
#                    The DNS token the estate already has CANNOT deploy workers — that was
#                    tested against the API, not assumed.
#
# Usage: CF_ACCOUNT_ID=... scripts/deploy.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

ACCOUNT="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID (Cloudflare dashboard → right sidebar → Account ID)}"
TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.config/protocolx/cloudflare-workers.token}"
NAME="${WORKER_NAME:-protocolx-verify}"

[[ -f "$TOKEN_FILE" ]] || {
  echo "No token at $TOKEN_FILE."
  echo "Create one: dash.cloudflare.com → My Profile → API Tokens → Create Token →"
  echo "'Edit Cloudflare Workers' template → save the value to that file (chmod 600)."
  exit 2
}
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"

echo "── uploading worker '$NAME' to account $ACCOUNT"
UPLOAD=$(curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$NAME" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'metadata={"main_module":"index.js","compatibility_date":"2026-08-01"};type=application/json' \
  -F "index.js=@$HERE/worker/src/index.js;type=application/javascript+module" \
  -F "lib.js=@$HERE/worker/src/lib.js;type=application/javascript+module")
echo "$UPLOAD" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(!j.success){console.error("upload FAILED:",JSON.stringify(j.errors));process.exit(1)}console.log("upload: OK")})'

echo "── enabling the workers.dev route"
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/$NAME/subdomain" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{"enabled":true}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.success?"route: OK":"route: FAILED "+JSON.stringify(j.errors))})'

SUB=$(curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/subdomain" \
  -H "Authorization: Bearer $TOKEN" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.result&&j.result.subdomain?j.result.subdomain:"")})')

echo
if [[ -n "$SUB" ]]; then
  echo "Deployed. The worker answers at: https://$NAME.$SUB.workers.dev"
  echo "Health check:                    https://$NAME.$SUB.workers.dev/healthz"
  echo "Webhook URL for the GitHub App:  https://$NAME.$SUB.workers.dev/webhook"
else
  echo "Deployed, but the workers.dev subdomain could not be read — find the URL on the"
  echo "Cloudflare dashboard under Workers & Pages → $NAME."
fi
echo
echo "Until the secrets are set (scripts/set-worker-secret.sh), /healthz reports what is"
echo "missing and the webhook answers 503 by design."
