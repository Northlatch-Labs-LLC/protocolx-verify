#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# classify — guard the outcome classifier against the SIGPIPE regression.
#
# The engine decides "killed" vs "did not compile" by looking for a marker in the
# test output. Written as `echo "$out" | grep -q MARKER` under `set -o pipefail`,
# grep exits on the first match, echo takes SIGPIPE, and the pipeline reports 141
# even though the pattern MATCHED. The test is then read as "no marker" and a
# genuine kill is recorded as a mutant that never compiled.
#
# It is output-size dependent: on a small package echo finishes before grep exits
# and the bug is invisible. On a real client package it inverted the headline —
# 0 killed / 13 invalid, where the truth was 13 killed / 0 invalid. A wrong number
# that only appears at client scale is the worst failure mode this tool has.
set -uo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }

MARKER="Running Move unit tests"
BIG="$(for i in $(seq 1 20000); do echo "line $i $MARKER padding padding padding"; done)"

# The form the engine must use.
if [[ "$BIG" == *"$MARKER"* ]]; then
  echo "  native substring test matches on large output: OK"
else
  fail "the native substring test did not match — the classifier is broken"
fi

# The form it must NOT use, asserted to be broken so the reason stays documented.
if echo "$BIG" | grep -q "$MARKER"; then
  echo "  note: the pipe form happened to work here; it is still forbidden (racy)"
else
  echo "  pipe form fails on large output as expected (status 141): OK"
fi

# The shipped engine must not contain the forbidden idiom.
ENGINE="$(cd "$(dirname "$0")" && pwd)/../move-mutate/move-mutate.sh"
# Strip comments first: the engine documents the forbidden idiom in a comment
# explaining why it is forbidden, and that explanation must not trip the check.
if sed 's/[[:space:]]*#.*$//' "$ENGINE" | grep -q 'echo "\$out" | grep -q'; then
  fail "the shipped engine still classifies outcomes through a pipe.
  Under pipefail that misreports kills as compile failures on large output."
fi
echo "  shipped engine does not classify through a pipe: OK"
echo
echo "CLASSIFIER OK"
