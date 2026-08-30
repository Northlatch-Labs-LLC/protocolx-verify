#!/usr/bin/env bash
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# secret-distance — prove that the step which executes a stranger's code carries no
# credential.
#
# Two halves, because the claim has two halves:
#
#   RUNTIME  — poison this shell with every shape of secret the runner actually holds,
#              send a command through runner/sandbox.sh, and read back the environment
#              the child was actually given. If any secret survives, the test fails.
#              Nothing is mocked: it is the real wrapper, and the child really is
#              /usr/bin/env printing what it received.
#
#   STATIC   — runner/test/workflow-audit.py reads verify-run.yml and proves the workflow
#              puts client code behind that wrapper with no credential in scope. The
#              runtime half proves the wrapper works; the static half proves it is used.
#
# Run from the repository root.

set -uo pipefail

PASS=0
FAIL=0
ok()   { echo "  ok   — $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL — $1" >&2; FAIL=$((FAIL + 1)); }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

SANDBOX="$ROOT/runner/sandbox.sh"
[[ -f "$SANDBOX" ]] || { echo "secret-distance: no runner/sandbox.sh" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "secret-distance: runtime — the sandboxed child's environment"

# Every credential the runner genuinely handles, plus the runner's own write handles into
# later steps, plus a plain variable that simply is not on the allowlist.
FAKE_KEY='-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqhkiG9w0BAQEFAASC-----END PRIVATE KEY-----'
FAKE_TOKEN='ghs_0123456789abcdefghijklmnopqrstuvwxyz'
FAKE_PAT='github_pat_11ABCDEFG0abcdefghijklmnop'

export GH_APP_ID='123456'
export GH_APP_PRIVATE_KEY="$FAKE_KEY"
export CLIENT_TOKEN="$FAKE_TOKEN"
export RUNNER_TOKEN="$FAKE_PAT"
export GH_WEBHOOK_SECRET='s3cr3t'
export EVIDENCE_WRITE_TOKEN='another-secret'
export ACTIONS_RUNTIME_TOKEN='eyJhbGciOiJSUzI1NiJ9.fake'
export ACTIONS_ID_TOKEN_REQUEST_TOKEN='fake'
export GITHUB_OUTPUT="$WORK/step-output"
export GITHUB_ENV="$WORK/step-env"
export GITHUB_PATH="$WORK/step-path"
export GITHUB_STATE="$WORK/step-state"
export GITHUB_STEP_SUMMARY="$WORK/step-summary"
export GITHUB_TOKEN='ghs_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
export AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI'
export CF_API_TOKEN='cloudflare'
# Not credentials, but write handles to the estate's own records: a KV binding and a
# flag. The client's build must not hold either.
export EVIDENCE_STORE='kv-binding-object'
export EVIDENCE_STORE_ENABLED='on'
export USAGE_LEDGER='kv-binding-object'
export NOT_ON_THE_ALLOWLIST='ordinary value'

SEEN="$WORK/child-env.txt"
PVS_SANDBOX_USER='' PVS_SANDBOX_REQUIRED=0 \
  bash "$SANDBOX" "$WORK" /usr/bin/env > "$SEEN" 2>"$WORK/child-err.txt"
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "  sandbox.sh exited $rc" >&2
  cat "$WORK/child-err.txt" >&2
  bad "sandbox.sh could not start the child"
else
  ok "sandbox.sh started the child"
fi

# --- no secret-shaped NAME survives -------------------------------------------------
LEAKED_NAMES="$(cut -d= -f1 < "$SEEN" \
  | grep -Ei '(^|_)(TOKEN|SECRET|KEY|KEYS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|PRIVATE|AUTH|SESSION|COOKIE|SIGNATURE|APIKEY|BEARER)(_|$)' || true)"
if [[ -n "$LEAKED_NAMES" ]]; then
  bad "secret-shaped variables reached the child: $(echo "$LEAKED_NAMES" | tr '\n' ' ')"
else
  ok "no secret-shaped variable name reached the child"
fi

# --- no secret VALUE survives, under any name ----------------------------------------
VALUE_LEAK=0
for secret in "$FAKE_KEY" "$FAKE_TOKEN" "$FAKE_PAT" 's3cr3t' 'wJalrXUtnFEMI' 'cloudflare'; do
  if grep -qF -- "$secret" "$SEEN"; then
    bad "a secret VALUE reached the child: ${secret:0:12}…"
    VALUE_LEAK=1
  fi
done
[[ $VALUE_LEAK == 0 ]] && ok "no secret value reached the child under any name"

# --- the runner's write handles into later steps are gone -----------------------------
HANDLE_LEAK=0
for handle in GITHUB_OUTPUT GITHUB_ENV GITHUB_PATH GITHUB_STATE GITHUB_STEP_SUMMARY \
              ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN GITHUB_TOKEN \
              EVIDENCE_STORE EVIDENCE_STORE_ENABLED USAGE_LEDGER; do
  if grep -q "^${handle}=" "$SEEN"; then
    bad "$handle reached the child — client code could write into a later step or into our own records"
    HANDLE_LEAK=1
  fi
done
[[ $HANDLE_LEAK == 0 ]] && ok "no runner or estate write handle reached the child (GITHUB_*, ACTIONS_*, EVIDENCE_*, USAGE_*)"

# --- it is an allowlist, not a denylist ------------------------------------------------
if grep -q '^NOT_ON_THE_ALLOWLIST=' "$SEEN"; then
  bad "an unlisted, innocuous variable was forwarded — the wrapper is filtering, not allowlisting"
else
  ok "an unlisted variable was NOT forwarded (allowlist, not denylist)"
fi

# --- what the toolchain does need is present -------------------------------------------
for needed in PATH HOME TMPDIR; do
  grep -q "^${needed}=" "$SEEN" || bad "$needed missing — the Move toolchain cannot run"
done
grep -q "^HOME=${WORK}" "$SEEN" \
  && ok "HOME points inside the sandbox tree" \
  || bad "HOME does not point inside the sandbox tree"

# --- the wrapper refuses to be talked into forwarding a secret ---------------------------
PASS_ESCAPE=0
for forbidden in CLIENT_TOKEN GH_APP_PRIVATE_KEY GITHUB_PATH EVIDENCE_STORE USAGE_LEDGER; do
  if PVS_SANDBOX_USER='' PVS_SANDBOX_REQUIRED=0 PVS_SANDBOX_PASS="$forbidden" \
       bash "$SANDBOX" "$WORK" /usr/bin/env >/dev/null 2>&1; then
    bad "PVS_SANDBOX_PASS=$forbidden was accepted — the pass list is an escape hatch"
    PASS_ESCAPE=1
  fi
done
[[ $PASS_ESCAPE == 0 ]] && ok "PVS_SANDBOX_PASS cannot be used to forward any forbidden name"

# --- a required sandbox that cannot be built refuses to run at all ------------------------
if PVS_SANDBOX_USER='pvs-sandbox-that-does-not-exist' PVS_SANDBOX_REQUIRED=1 \
     bash "$SANDBOX" "$WORK" /usr/bin/env >/dev/null 2>&1; then
  bad "a required sandbox silently degraded to running as the current user"
else
  ok "a required sandbox that cannot be built refuses to run client code"
fi

echo
echo "secret-distance: static — the workflow puts client code behind the wrapper"
if python3 runner/test/workflow-audit.py; then
  ok "workflow-audit passed"
else
  bad "workflow-audit failed"
fi

echo
echo "secret-distance: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] || exit 1
