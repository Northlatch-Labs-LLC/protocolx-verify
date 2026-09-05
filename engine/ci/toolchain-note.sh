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
# What a digest verdict is allowed to SAY about the compiler that produced it.
#
# A package digest is a function of the SOURCE and the COMPILER. Only the source is versioned in
# git, and `ci-expected-digest` is a bare hash that records neither the toolchain that produced it
# nor the fact that it depends on one. `Published.toml` records `toolchain-version` one file away
# and the gate did not read it.
#
# That matters at exactly one moment: when the toolchain has to move. A CLI too old to reach the
# chain must be upgraded, and if a newer compiler emits different bytes for identical source, the
# gate fails saying "the source no longer builds to the recorded package" — which is FALSE. Worse,
# the gate's own instruction is never to update the expectation to make CI pass, so the honest
# action and the forbidden one become indistinguishable from the output.
#
# Held in its own file so it can be tested without building a Move package. `digest-guard.sh`
# sources it; nothing here decides pass or fail, only what the verdict is entitled to claim.
#
# Reads: RECORDED_TOOLCHAIN, RUNNING_TOOLCHAIN. Either may be empty, and empty means NOT COMPARED —
# never agreement. An unmeasured fact is reported as unmeasured, which is the same rule the build
# and read failures already follow.

# $1 is "match" or "mismatch" — the same three compiler states mean different things either way,
# and a note written for one of them reads as nonsense under the other.
toolchain_note() {
  local verdict="$1"
  if [[ -z "$RECORDED_TOOLCHAIN" || -z "$RUNNING_TOOLCHAIN" ]]; then
    echo "  compiler: NOT COMPARED (recorded='${RECORDED_TOOLCHAIN:-none}' running='${RUNNING_TOOLCHAIN:-none}')."
    echo "  A digest is a function of the source AND the compiler, and this run could not establish"
    echo "  whether the compiler is the one that produced the expectation."
  elif [[ "$RECORDED_TOOLCHAIN" != "$RUNNING_TOOLCHAIN" ]]; then
    echo "  compiler: DIFFERENT. Published.toml records $RECORDED_TOOLCHAIN; this run used $RUNNING_TOOLCHAIN."
    if [[ "$verdict" == "match" ]]; then
      echo "  The digest matched anyway, which is a stronger result than it looks: this source builds to"
      echo "  the recorded package under BOTH compilers, so the expectation survives the upgrade."
    else
      echo "  A DIGEST MISMATCH UNDER A CHANGED COMPILER IS NOT EVIDENCE THAT THE SOURCE DRIFTED."
      echo "  Rebuild with $RECORDED_TOOLCHAIN to establish which of the two moved. Until that is done"
      echo "  this failure does not say the contract was tampered with, and must not be read as saying so."
    fi
  else
    if [[ "$verdict" == "match" ]]; then
      echo "  compiler: same as recorded ($RUNNING_TOOLCHAIN)."
    else
      echo "  compiler: same as recorded ($RUNNING_TOOLCHAIN), so the source is the only thing that differs."
    fi
  fi
}
