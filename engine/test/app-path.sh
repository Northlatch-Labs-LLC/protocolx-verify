#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# app-path — prove the ENGINE COPY, the one the GitHub App actually ships as
# `PVS · mutation-smoke`, derives mutations from a nested package.
#
# WHY THIS EXISTS. The shipped engine once derived mutations with a FLAT
# `sources/*.move` glob. Any client nesting modules in subdirectories — which is
# every codebase large enough to afford us — derived ZERO mutations, and our own
# product reported "nothing to mutate" and failed its own gate on their flagship
# repository. The tool was fixed; the shipped copy was not, for two generations.
#
# This test runs the SHIPPED PATH, not the tool it was copied from. A fix that works
# in verification-tools and not through the App is not a fix.
#
# It needs python3 but NOT sui: `--list` derives and exits before the baseline.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$HERE/../move-mutate/move-mutate.sh"
FIXTURE="$HERE/nested-fixture"

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -x "$ENGINE" ]] || fail "engine copy missing or not executable at $ENGINE"

OUT="$("$ENGINE" "$FIXTURE" --list 2>&1)" || fail "engine --list exited non-zero:
$OUT"

echo "$OUT"
echo "── assertions ──"

# 1. THE DEFECT'S OWN SHAPE. A flat glob derives zero here.
# Tolerant of the count's wording so an OLD engine is read and reported as the
# zero it is, rather than as an unparseable output.
DERIVED="$(echo "$OUT" | sed -n 's/^derived \([0-9][0-9]*\) .*/\1/p' | head -1)"
[[ -n "$DERIVED" ]] || fail "could not read the derived count from the engine's output"
[[ "$DERIVED" -gt 0 ]] || fail "engine derived ZERO mutations from a nested package.
  This is the flat-glob defect. The shipped engine cannot measure any client whose
  modules live in subdirectories."
echo "  derived $DERIVED mutations from a nested package (must be > 0): OK"

# 2. Both nested directories must be represented — not just the first one found.
echo "$OUT" | grep -q "sources/obligation/access.move" \
  || fail "no mutation derived from sources/obligation/access.move (nested one level)"
echo "$OUT" | grep -q "sources/market/model.move" \
  || fail "no mutation derived from sources/market/model.move (nested one level)"
echo "  both nested module directories represented: OK"

# 3. Exactly the four production guards, and no more.
[[ "$DERIVED" -eq 4 ]] || fail "expected 4 production asserts, got $DERIVED.
  Over-derivation means test code is being mutated; under-derivation means a
  production guard is invisible. Both are wrong."
echo "  derived exactly the 4 production guards: OK"

# 4. Inline #[test] / #[test_only] asserts excluded, counted, and PRINTED.
TI="$(echo "$OUT" | sed -n 's/^derived .*, \([0-9][0-9]*\) test-internal asserts excluded.*/\1/p')"
[[ "$TI" == "3" ]] || fail "expected 3 test-internal asserts excluded, got '${TI:-none}'.
  Inline #[test] bodies in a production module must not be mutated: those mutations
  can never be killed and inflate the survivor count."
echo "$OUT" | grep -q "EXCLUDED (test-internal" \
  || fail "test-internal exclusions were counted but not PRINTED — silent exclusion
  reads as 'covered everything' when it did not."
echo "  3 test-internal asserts excluded, counted and printed: OK"

# 5. The in-sources test DIRECTORY is excluded and counted too.
echo "$OUT" | grep -q "1 in-sources test files excluded" \
  || fail "the in-sources tests/ directory was not counted as excluded"
echo "$OUT" | grep -q "sources/tests/helper.move" \
  && fail "an assert inside sources/tests/ was derived — test directories must not be mutated"
echo "  in-sources test directory excluded and counted: OK"

echo
echo "APP PATH OK — the shipped engine measures nested packages."
