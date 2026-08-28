#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# Sets one secret on the deployed worker, reading the VALUE from stdin so it never
# appears in shell history or a process list.
#
# Usage:  CF_ACCOUNT_ID=... scripts/set-worker-secret.sh GH_APP_ID
#         (then type or paste the value, press Enter, then Ctrl+D)
#         For a multi-line value (the private key):
#         CF_ACCOUNT_ID=... scripts/set-worker-secret.sh GH_APP_PRIVATE_KEY < app-pkcs8.pem
set -euo pipefail

ACCOUNT="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.config/protocolx/cloudflare-workers.token}"
NAME="${WORKER_NAME:-protocolx-verify}"
SECRET_NAME="${1:?usage: set-worker-secret.sh <SECRET_NAME>  (value on stdin)}"

[[ -f "$TOKEN_FILE" ]] || { echo "no token at $TOKEN_FILE — see scripts/deploy.sh"; exit 2; }
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"

VALUE="$(cat)"
[[ -n "$VALUE" ]] || { echo "empty value — refusing to set an empty secret"; exit 2; }

node -e '
const [account, name, secretName, token] = process.argv.slice(1);
let value = "";
process.stdin.on("data", (c) => { value += c; });
process.stdin.on("end", async () => {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/secrets`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: secretName, text: value, type: "secret_text" }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!body.success) { console.error("FAILED:", JSON.stringify(body.errors)); process.exit(1); }
  console.log(`secret ${secretName}: set`);
});
' "$ACCOUNT" "$NAME" "$SECRET_NAME" "$TOKEN" <<< "$VALUE"
