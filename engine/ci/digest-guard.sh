#!/usr/bin/env bash
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# digest-guard — the deployed-drift tripwire.
#
# A contract that is live on mainnet has one legitimate source: the one that builds to the
# byte-identical package the chain holds. This gate builds the package and compares its digest
# to the committed expectation (`ci-expected-digest` beside Move.toml). Any mismatch fails CI
# loudly — an accidental edit to deployed source is caught on the pull request, not during a
# ceremony.
#
# Updating the expectation is a DELIBERATE act that belongs in the same commit as an intended
# contract change (a planned upgrade), never a fix to make CI pass.
#
# Usage: digest-guard.sh <package-dir>
set -euo pipefail
# Resolved BEFORE the cd, because the helper lives beside this script and the package does not.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="${1:?usage: digest-guard.sh <package-dir>}"
cd "$PKG"
[[ -f Move.toml ]] || { echo "no Move.toml in $PKG" >&2; exit 2; }
[[ -f ci-expected-digest ]] || { echo "no ci-expected-digest in $PKG — record one first:"; echo "  (build digest) > ci-expected-digest"; exit 2; }

EXPECTED="$(cat ci-expected-digest | tr -d '[:space:]')"

# Build on its own, with the compiler's stderr VISIBLE, into a file.
#
# This was a single pipeline ending `2>/dev/null | python3 -c "… json.load …"`, and it had three
# faults that combined into one false accusation:
#
#   1. `2>/dev/null` discarded the compiler's error, so a build failure produced no reason.
#   2. Without `--no-tree-shaking` the dump tree-shakes the dependency list through RPC calls, and
#      on a fresh runner that path has produced an EMPTY dump with exit code 0.
#   3. The resulting JSONDecodeError propagated out of the pipeline and this script exited
#      non-zero — which the runner published as `digest: fail`, meaning DRIFT.
#
# So a gate that COULD NOT MEASURE the digest reported that the source no longer builds to the
# deployed package. That is a failed read presented as a measurement, and it is the one thing this
# product exists to refuse.
#
# Observed 2026-09-01 on weir PR #88: no Move source changed at all, the digest gate said fail, and
# the next push on byte-identical source said pass. The only remedy available to the reader was to
# push again and watch it go green — exactly the habit a verification gate must never teach.
#
# `weir`'s own ci.yml already carries both fixes and both comments, including "that opaque shape is
# exactly how this gate's first real run died". The fix travelled to the consumer and never came
# back to the product.
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT
if ! sui move build --dump-bytecode-as-base64 --no-tree-shaking > "$DUMP"; then
  echo "digest-guard: ERROR — the package did not build; the compiler's output is above." >&2
  echo "This is NOT a drift verdict: the digest was not measured, so nothing can be said of it." >&2
  exit 2
fi

# Exit 2, never 1. The runner maps a non-zero exit to a gate verdict, and `fail` on this gate means
# DRIFT — an accusation about somebody's source. "I could not measure" is a different answer and
# must not wear the same badge.
if ! ACTUAL="$(python3 "$SCRIPT_DIR/digest-of-dump.py" "$DUMP")"; then
  echo "digest-guard: ERROR — the digest could not be read, so no verdict is given." >&2
  exit 2
fi

if [[ "$ACTUAL" == "$EXPECTED" ]]; then
  echo "digest-guard: OK ($ACTUAL)"
else
  echo "digest-guard: MISMATCH"
  echo "  expected: $EXPECTED"
  echo "  actual:   $ACTUAL"
  echo "The source no longer builds to the recorded package. If this change is a deliberate"
  echo "upgrade, update ci-expected-digest in the same commit and say so; otherwise the source"
  echo "has drifted from the deployed contract and this failure is doing its job."
  exit 1
fi
