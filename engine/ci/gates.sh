#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 095fd383d981aee15ad3a49ab9d2683c511eb366
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# gates — the ordered verification gates for a Move package, runnable locally or in CI.
#
#   1. build        the package compiles
#   2. digest       deployed-drift tripwire (only when ci-expected-digest exists)
#   3. tests        the suite is green
#   4. pin          scripts/check-framework-pin.sh, when the repo has one
#   5. mutation     move-mutate smoke (--limit N); the full run is a scheduled/manual job,
#                   never a per-push gate — it costs one suite run per assert
#
# On CD, for the avoidance of ambition: contracts do not auto-deploy. Deployment is a multisig
# ceremony with a human saying "send" — that is a control, not a gap, and no pipeline should
# ever replace it. CD here means: the gates green-light a tree the ceremony can trust.
#
# Usage: gates.sh <package-dir> [--mutation-limit N] [--skip-mutation]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="${1:?usage: gates.sh <package-dir> [--mutation-limit N] [--skip-mutation]}"
shift
MLIMIT=5; SKIPMUT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mutation-limit) MLIMIT="$2"; shift 2 ;;
    --skip-mutation) SKIPMUT=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

FAILED=0
gate() {  # gate <name> <command...>
  local name="$1"; shift
  echo "── gate: $name"
  if "$@"; then echo "   $name: PASS"; else echo "   $name: FAIL"; FAILED=1; fi
}

gate "build" bash -c "cd '$PKG' && sui move build >/dev/null 2>&1"
if [[ -f "$PKG/ci-expected-digest" ]]; then
  gate "digest" "$HERE/digest-guard.sh" "$PKG"
else
  echo "── gate: digest — skipped (no ci-expected-digest; not a deployed package)"
fi
gate "tests" bash -c "cd '$PKG' && sui move test >/dev/null 2>&1"
if [[ -x "$PKG/scripts/check-framework-pin.sh" ]]; then
  gate "pin" bash -c "cd '$PKG' && scripts/check-framework-pin.sh"
else
  echo "── gate: pin — skipped (no check-framework-pin.sh)"
fi
if [[ $SKIPMUT == 0 ]]; then
  gate "mutation-smoke" "$HERE/../move-mutate/move-mutate.sh" "$PKG" --limit "$MLIMIT"
else
  echo "── gate: mutation-smoke — skipped by flag"
fi

echo
[[ $FAILED == 0 ]] && echo "ALL GATES PASS" || echo "GATES FAILED"
exit $FAILED
