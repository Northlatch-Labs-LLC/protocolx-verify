#!/usr/bin/env bash
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# sandbox — run untrusted client code with no credentials within reach.
#
# THE THREAT THIS EXISTS FOR. ProtocolX Verify fetches a stranger's repository and runs
# `sui move build`, `sui move test`, the mutation engine, and — because gates.sh honours
# it — the client's own `scripts/check-framework-pin.sh`, which is arbitrary shell. In
# In some deployments the same job also holds credentials of its own. Those two facts
# must never be true of the same process.
#
# This wrapper enforces the separation at the only two boundaries a shell can reach:
#
#   1. ENVIRONMENT. The child is started from `env -i` with an explicit allowlist. It is
#      not "the job's environment minus some names" — it is an empty environment plus a
#      short list of variables the Move toolchain genuinely needs. A new secret added to
#      the workflow tomorrow is excluded by default rather than included by default,
#      which is the only direction that stays correct as the workflow grows.
#
#      Excluded by construction and by name: GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT,
#      GITHUB_STATE and GITHUB_STEP_SUMMARY. Those are not just information — they are
#      WRITE HANDLES INTO LATER STEPS. A client test that appends to $GITHUB_PATH puts a
#      binary of its choosing ahead of `node` in the step that reports verdicts with the
#      token. Unsetting the variable removes the address, so the write has nowhere to go.
#
#   2. UID. When PVS_SANDBOX_USER names an account and passwordless sudo is available,
#      the command runs as that unprivileged user, whose reach is one directory tree we
#      staged for it. It cannot read the runner's home, the workspace, the Actions
#      temp directory, or the tooling that later steps execute.
#
# WHAT IT DOES NOT DO, said plainly rather than implied: it does not stop outbound
# network traffic, and it does not stop the client's code from reading anything the
# world can read. See "Network and persistence" in README.md.
#
# Usage: sandbox.sh <workdir> <command> [args...]
#
# Env:
#   PVS_SANDBOX_USER      unprivileged account to drop to (empty = no privilege drop)
#   PVS_SANDBOX_REQUIRED  "1" (default) = refuse to run at all if the drop is impossible
#   PVS_SANDBOX_PASS      extra variable NAMES to forward, space separated. Every name
#                         is still checked against the forbidden patterns below, so this
#                         is a convenience, not an escape hatch.

set -uo pipefail

# A name is refused if it looks like a credential, if it belongs to the runner's own
# control plane, or if it is one of our own storage handles — EVIDENCE_STORE and
# USAGE_LEDGER are not secrets, but they are write handles to our own records and
# the client's build has no business holding one. Anchored on underscore boundaries so
# PATH is not caught by PAT.
#
# This is the SECOND belt. The first is that the child's environment is built from
# `env -i` plus an allowlist, so an unlisted name never reaches it whether or not these
# patterns know about it. These patterns exist so that PVS_SANDBOX_PASS cannot be used
# to walk something dangerous through the front door.
FORBIDDEN_NAME_RE='(^|_)(TOKEN|TOKENS|SECRET|SECRETS|KEY|KEYS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|CREDENTIALS|PRIVATE|AUTH|SESSION|COOKIE|SIGNATURE|SIGNING|APIKEY|BEARER|PAT|STORE|LEDGER)(_|$)'
FORBIDDEN_PREFIX_RE='^(GITHUB_|ACTIONS_|RUNNER_|GH_|CLIENT_|PVS_|EVIDENCE_|USAGE_|AWS_|AZURE_|GOOGLE_|CF_|CLOUDFLARE_|NPM_|NODE_AUTH|INPUT_|SSH_|OP_)'

# A value is refused if it is shaped like a bearer credential, whatever it is called.
# This catches the case the name check cannot: a secret smuggled into an innocuous name.
FORBIDDEN_VALUE_RE='(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'

# The Move toolchain's genuine needs, and nothing else.
DEFAULT_PASS='PATH HOME LANG LC_ALL LANGUAGE TERM TMPDIR MOVE_HOME RUST_BACKTRACE'

say() { echo "sandbox: $*"; }
die() { echo "sandbox: $*" >&2; exit 2; }

name_forbidden() {
  local n="$1"
  [[ "$n" =~ $FORBIDDEN_NAME_RE ]] && return 0
  [[ "$n" =~ $FORBIDDEN_PREFIX_RE ]] && return 0
  return 1
}

WORKDIR="${1:-}"
[[ -n "$WORKDIR" ]] || die "usage: sandbox.sh <workdir> <command> [args...]"
shift
[[ $# -gt 0 ]] || die "usage: sandbox.sh <workdir> <command> [args...]"
[[ -d "$WORKDIR" ]] || die "no such workdir: $WORKDIR"

SANDBOX_USER="${PVS_SANDBOX_USER:-}"
SANDBOX_REQUIRED="${PVS_SANDBOX_REQUIRED:-1}"

# --- decide the containment level -------------------------------------------------
DROP=0
if [[ -n "$SANDBOX_USER" ]]; then
  if ! id -u "$SANDBOX_USER" >/dev/null 2>&1; then
    [[ "$SANDBOX_REQUIRED" == "1" ]] && die "PVS_SANDBOX_USER='$SANDBOX_USER' does not exist and the sandbox is required. Refusing to run client code as the account that holds our credentials."
    say "WARNING: user '$SANDBOX_USER' does not exist — no privilege drop"
  elif ! sudo -n true >/dev/null 2>&1; then
    [[ "$SANDBOX_REQUIRED" == "1" ]] && die "passwordless sudo is unavailable and the sandbox is required. Refusing to run client code as the account that holds our credentials."
    say "WARNING: passwordless sudo unavailable — no privilege drop"
  else
    DROP=1
  fi
elif [[ "$SANDBOX_REQUIRED" == "1" ]]; then
  die "PVS_SANDBOX_USER is not set and the sandbox is required. Set PVS_SANDBOX_REQUIRED=0 only for local development against code you wrote."
fi

# --- build the child environment from nothing --------------------------------------
CHILD_HOME="$WORKDIR"
CHILD_TMP="$WORKDIR/tmp"
if [[ $DROP == 1 ]]; then
  # The staged tree is the sandbox user's whole world; its home lives inside it so that
  # ~/.move, cargo scratch and anything else the toolchain writes lands where we can
  # delete it, and nowhere it could outlive the job.
  CHILD_HOME="$WORKDIR/home"
  CHILD_TMP="$WORKDIR/tmp"
fi

declare -a PAIRS=()
add_pair() {
  local n="$1" v="$2"
  if name_forbidden "$n"; then
    die "refusing to forward '$n' into the sandbox — it matches a forbidden pattern. This is the check working, not a bug."
  fi
  if [[ "$v" =~ $FORBIDDEN_VALUE_RE ]]; then
    die "refusing to forward '$n' into the sandbox — its VALUE is shaped like a bearer credential."
  fi
  PAIRS+=("$n=$v")
}

for name in $DEFAULT_PASS ${PVS_SANDBOX_PASS:-}; do
  case "$name" in
    HOME|TMPDIR|TMP|TEMP) continue ;;   # set explicitly below
  esac
  # Indirect expansion: unset variables are simply not forwarded.
  if [[ -n "${!name:-}" ]]; then
    add_pair "$name" "${!name}"
  fi
done
add_pair HOME "$CHILD_HOME"
add_pair TMPDIR "$CHILD_TMP"

# Belt and braces: re-read the assembled list and refuse if anything forbidden survived.
for pair in "${PAIRS[@]}"; do
  n="${pair%%=*}"
  name_forbidden "$n" && die "assembled environment still carries '$n' — refusing to start"
done

mkdir -p "$CHILD_TMP" 2>/dev/null || true

# --- run ---------------------------------------------------------------------------
if [[ $DROP == 1 ]]; then
  say "containment: uid=$SANDBOX_USER · env=allowlist(${#PAIRS[@]}) · cwd=$WORKDIR"
  # Leave the caller's directory before dropping: it is inside the tree the sandbox uid
  # was just locked out of, and sudo grumbles about a cwd the target user cannot reach.
  cd / || exit 2
  sudo -n -u "$SANDBOX_USER" env -i "${PAIRS[@]}" \
    /usr/bin/env bash -c 'cd "$1" || exit 2; shift; exec "$@"' _ "$WORKDIR" "$@"
else
  say "containment: uid=UNCHANGED · env=allowlist(${#PAIRS[@]}) · cwd=$WORKDIR"
  env -i "${PAIRS[@]}" \
    /usr/bin/env bash -c 'cd "$1" || exit 2; shift; exec "$@"' _ "$WORKDIR" "$@"
fi
