#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
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
PKG="${1:?usage: digest-guard.sh <package-dir>}"
cd "$PKG"
[[ -f Move.toml ]] || { echo "no Move.toml in $PKG" >&2; exit 2; }
[[ -f ci-expected-digest ]] || { echo "no ci-expected-digest in $PKG — record one first:"; echo "  (build digest) > ci-expected-digest"; exit 2; }

EXPECTED="$(cat ci-expected-digest | tr -d '[:space:]')"
ACTUAL="$(sui move build --dump-bytecode-as-base64 2>/dev/null | python3 -c "import json,sys; print(bytes(json.load(sys.stdin)['digest']).hex())")"

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
