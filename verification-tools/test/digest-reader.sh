#!/usr/bin/env bash
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# The digest reader must never answer "drift" when it means "I could not measure".
#
# On 2026-09-01 the digest gate published `fail` — which this product defines as the source no
# longer building to the deployed package — for a pull request that changed no Move source at all.
# The cause was an empty build dump: `json.load` raised, the pipeline exited non-zero, and a
# failed READ was reported as a failed MEASUREMENT. The next push, on byte-identical source,
# passed. The only remedy available to the reader was to push again and watch it go green, which
# is precisely the habit a verification gate must never teach.
#
# So the exit codes carry meaning and this file holds them to it:
#   0  a digest was read
#   2  it could not be read, for a stated reason
#   1  is reserved for a real mismatch and must never come from here
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
READER="$HERE/../ci/digest-of-dump.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

check() {
  local name="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    echo "  ok    $name (exit $got)"
  else
    echo "  FAIL  $name — expected exit $want, got $got"
    fails=$((fails + 1))
  fi
}

: > "$TMP/empty"
python3 "$READER" "$TMP/empty" >/dev/null 2>&1
check "an empty dump is unmeasurable, not drift" 2 $?

printf 'terminal noise, no object' > "$TMP/noise"
python3 "$READER" "$TMP/noise" >/dev/null 2>&1
check "output with no JSON object is unmeasurable" 2 $?

printf '{"digest": ' > "$TMP/truncated"
python3 "$READER" "$TMP/truncated" >/dev/null 2>&1
check "a truncated dump is unmeasurable" 2 $?

printf '{"nodigest": true}' > "$TMP/nofield"
python3 "$READER" "$TMP/nofield" >/dev/null 2>&1
check "a dump with no digest field is unmeasurable" 2 $?

# The converse half. Without it every assertion above would pass on a reader that refused
# everything, which would be a gate that never speaks rather than one that speaks truthfully.
printf 'warning: something\n{"digest":[171,205]}' > "$TMP/good"
OUT="$(python3 "$READER" "$TMP/good" 2>/dev/null)"
check "a real dump behind leading noise still reads" 0 $?
if [[ "$OUT" == "abcd" ]]; then
  echo "  ok    and the digest it returns is correct (abcd)"
else
  echo "  FAIL  wrong digest: expected abcd, got '$OUT'"
  fails=$((fails + 1))
fi

if [[ "$fails" -eq 0 ]]; then
  echo "engine/test/digest-reader.sh: OK"
else
  echo "engine/test/digest-reader.sh: $fails failed"
  exit 1
fi
