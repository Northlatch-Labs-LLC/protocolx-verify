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
# A digest verdict must not accuse the source when the compiler is what moved.
#
# A package digest is a function of the SOURCE and the COMPILER. Only the source is versioned in
# git. `ci-expected-digest` is a bare hash recording neither the toolchain that produced it nor the
# fact that it depends on one — while `Published.toml` records `toolchain-version` one file away,
# unread by the gate.
#
# This is not theoretical. On 2026-09-01 the upgrade ceremony was blocked by a CLI at protocol 133
# against a chain at 135, so the toolchain HAD to move. The next digest failure would have said
# "the source no longer builds to the recorded package" — false — and the gate's own instruction is
# never to update the expectation to make CI pass. The honest action and the forbidden one would
# have been indistinguishable from the output.
#
# The verdict itself is unchanged. A mismatch still fails. Only what the failure is entitled to
# CLAIM has changed, which is the same distinction `digest-reader.sh` draws between "drift" and
# "I could not measure".
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../ci/toolchain-note.sh"

checks=0
failures=0
check() {
  local what="$1" haystack="$2" needle="$3" want="$4"
  checks=$((checks + 1))
  local found=no
  case "$haystack" in *"$needle"*) found=yes ;; esac
  if [[ "$found" == "$want" ]]; then
    echo "  ok  $what"
  else
    failures=$((failures + 1))
    echo "FAIL  $what"
    echo "      wanted '$needle' to be $want, was $found"
  fi
}

# --- a mismatch under a CHANGED compiler must not accuse the source --------------------------
RECORDED_TOOLCHAIN="1.77.2"; RUNNING_TOOLCHAIN="1.78.1"
out="$(toolchain_note mismatch)"
check "names both compilers"                    "$out" "records 1.77.2" yes
check "names the one that ran"                  "$out" "used 1.78.1"    yes
check "says a mismatch here is NOT source drift" "$out" "NOT EVIDENCE THAT THE SOURCE DRIFTED" yes
check "tells the reader how to settle it"       "$out" "Rebuild with 1.77.2" yes
# The sentence the old gate printed unconditionally. Under a changed compiler it is a false
# accusation, and this is the assertion that fails if somebody restores it.
check "does not claim the contract was tampered with" "$out" "must not be read as saying so" yes

# --- a mismatch under the SAME compiler must still accuse the source --------------------------
RECORDED_TOOLCHAIN="1.77.2"; RUNNING_TOOLCHAIN="1.77.2"
out="$(toolchain_note mismatch)"
# The converse half. A note that refused to blame the source in every case would pass every
# assertion above while destroying the gate's entire purpose.
check "says the source is the only thing that differs" "$out" "source is the only thing that differs" yes
check "does not excuse it as a compiler change"        "$out" "NOT EVIDENCE" no

# --- a MATCH under a changed compiler is a stronger result, not a weaker one -------------------
RECORDED_TOOLCHAIN="1.77.2"; RUNNING_TOOLCHAIN="1.78.1"
out="$(toolchain_note match)"
check "reports the match survived the upgrade" "$out" "survives the upgrade" yes
# Written for the failure path and printed on the success path, this sentence reads as nonsense.
# The note takes the verdict as an argument precisely so that cannot happen.
check "does not print the failure wording"     "$out" "must not be read as saying so" no

# --- either side missing is NOT COMPARED, never agreement --------------------------------------
RECORDED_TOOLCHAIN=""; RUNNING_TOOLCHAIN="1.78.1"
out="$(toolchain_note mismatch)"
check "absent record reports NOT COMPARED" "$out" "NOT COMPARED" yes
RECORDED_TOOLCHAIN="1.77.2"; RUNNING_TOOLCHAIN=""
out="$(toolchain_note match)"
check "absent running compiler reports NOT COMPARED" "$out" "NOT COMPARED" yes
# An unmeasured fact must never be reported as a match. Same rule the read failure already follows.
check "absent side is not called the same"           "$out" "same as recorded" no

echo
echo "$((checks - failures))/$checks checks passed, $failures failed"
[[ $failures -eq 0 ]] || exit 1
