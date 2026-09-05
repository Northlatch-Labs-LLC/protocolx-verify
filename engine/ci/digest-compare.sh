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
# The comparison at the heart of the digest gate, on its own so it can be tested without a
# compiler. Usage: digest-compare.sh <actual> <expected> [next]
#
# Two digests are legitimate. `expected` is what is DEPLOYED and must not change until the chain
# does. `next`, when present, is what is INTENDED: written by hand with the pinned compiler after
# the change it describes was reviewed, and promoted into `expected` by the upgrade ceremony.
# Before `next` existed, every upgrade branch was red on this gate by design for its whole life —
# and a gate that is red by design is a gate nobody reads, which is the failure it exists to
# prevent. Accepting a deliberately recorded intention is not weakening the tripwire: the
# tripwire is against UNINTENDED drift, and a hash somebody wrote down on purpose is intent.
#
# Exit 0 on a match (and say which file matched — they are different facts), 1 on a mismatch.
set -uo pipefail
ACTUAL="${1:?actual}"; EXPECTED="${2:?expected}"; NEXT="${3:-}"
if [[ "$ACTUAL" == "$EXPECTED" ]]; then
  echo "digest-compare: OK — matches ci-expected-digest, the deployed package ($ACTUAL)"
  exit 0
fi
if [[ -n "$NEXT" && "$ACTUAL" == "$NEXT" ]]; then
  echo "digest-compare: OK — matches ci-next-digest, the intended upgrade ($ACTUAL); deployed is $EXPECTED"
  exit 0
fi
echo "digest-compare: MISMATCH"
echo "  expected (deployed): $EXPECTED"
[[ -n "$NEXT" ]] && echo "  next (intended):     $NEXT"
echo "  actual:              $ACTUAL"
exit 1
