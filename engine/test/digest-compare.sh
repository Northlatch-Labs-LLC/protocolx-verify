#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 095fd383d981aee15ad3a49ab9d2683c511eb366
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# The comparison must accept exactly two things — the deployed digest and a deliberately recorded
# next digest — and nothing else, and must say which of the two it matched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMP="$HERE/../ci/digest-compare.sh"
fails=0
check() { local name="$1" want="$2" got="$3"; if [[ "$want" == "$got" ]]; then echo "  ok    $name (exit $got)"; else echo "  FAIL  $name — expected exit $want, got $got"; fails=$((fails+1)); fi; }
A=aaaa; B=bbbb; C=cccc
"$CMP" $A $A     >/dev/null; check "deployed match passes" 0 $?
"$CMP" $B $A     >/dev/null; check "no next: anything else fails" 1 $?
"$CMP" $B $A $B  >/dev/null; check "next match passes" 0 $?
"$CMP" $C $A $B  >/dev/null; check "neither deployed nor next fails" 1 $?
"$CMP" $A $A $B  >/dev/null; check "deployed still passes when next exists" 0 $?
out="$("$CMP" $B $A $B)"; [[ "$out" == *"ci-next-digest"* ]]; check "a next match names the file it matched" 0 $?
out="$("$CMP" $A $A $B)"; [[ "$out" == *"ci-expected-digest"* ]]; check "a deployed match names the file it matched" 0 $?
out="$("$CMP" $C $A $B)"; [[ "$out" == *"next (intended):     $B"* ]]; check "a mismatch shows both recorded digests" 0 $?
[[ $fails -eq 0 ]] && echo "digest-compare: all checks passed" || { echo "digest-compare: $fails failing"; exit 1; }
