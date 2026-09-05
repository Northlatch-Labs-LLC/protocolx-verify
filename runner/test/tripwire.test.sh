#!/usr/bin/env bash
# Built-by: @projectx.sui
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# tripwire.test — prove the tamper tripwire TRIPS in a tree that has no worker/.
#
# THE DEFECT THIS GUARDS. The tripwire was three copies of one command line inside
# action.yml, each naming a fixed directory list:
#
#     find runner worker engine action -type f ...
#
# `find` exits non-zero on a directory that does not exist, and the step runs under
# `set -euo pipefail`. In a tree published without the Cloudflare worker the arming
# step therefore ERRORED rather than fingerprinting anything — and a tripwire that
# errors is a tripwire that is not there. The sandbox proof is the whole reason our
# verdict is defensible to a reader, so "it errors instead" is not a path bug.
#
# A fix without this test is not a fix: the assertion that matters is not that the
# command no longer errors, it is that a file edited under engine/ mid-run still
# stops the run in a tree shaped like the published one.
#
# Runs anywhere bash, find and a sha256 tool exist. No sui, no python, no network.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TRIPWIRE="$HERE/../tripwire.sh"
ACTION_YML="$HERE/../../action.yml"

pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { pass=$((pass + 1)); echo "  $*: OK"; }

[ -x "$TRIPWIRE" ] || fail "tripwire.sh missing or not executable at $TRIPWIRE"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── a tree shaped like the PUBLISHED action: runner/, engine/, action/, no worker/
TREE="$TMP/public-tree"
mkdir -p "$TREE/runner/lib" "$TREE/engine/ci" "$TREE/engine/move-mutate/lib" "$TREE/action"
echo 'shipped' > "$TREE/runner/sandbox.sh"
echo 'shipped' > "$TREE/runner/lib/preflight.mjs"
echo 'shipped' > "$TREE/engine/ci/gates.sh"
echo 'shipped' > "$TREE/engine/move-mutate/lib/derive.py"
echo 'shipped' > "$TREE/action/summary.mjs"
[ -d "$TREE/worker" ] && fail "the fixture tree must NOT contain worker/"

echo "── 1. arming in a worker-less tree ──"
ARM_OUT="$("$TRIPWIRE" arm "$TREE" "$TMP/before.sha256" 2>&1)" \
  || fail "arming errored in a tree with no worker/. This is the original defect:
$ARM_OUT"
echo "$ARM_OUT"
[ -s "$TMP/before.sha256" ] || fail "arming produced an empty fingerprint"
[ "$(wc -l < "$TMP/before.sha256" | tr -d ' ')" -eq 5 ] \
  || fail "expected 5 shipped files fingerprinted, got $(wc -l < "$TMP/before.sha256")"
case "$ARM_OUT" in *worker*) fail "the fingerprint claims to cover worker/, which is absent" ;; esac
ok "armed over runner/, engine/ and action/ with worker/ absent"

echo "── 2. an untouched tree verifies clean ──"
"$TRIPWIRE" verify "$TREE" "$TMP/before.sha256" "$TMP/after-clean.sha256" >/dev/null 2>&1 \
  || fail "an untouched tree must verify clean — a tripwire that cries wolf gets disabled"
ok "untouched tree verifies clean"

echo "── 3. THE ASSERTION: a file edited under engine/ trips it ──"
echo 'tampered by the client run' >> "$TREE/engine/move-mutate/lib/derive.py"
BREACH="$("$TRIPWIRE" verify "$TREE" "$TMP/before.sha256" "$TMP/after-breach.sha256" 2>&1)"
rc=$?
[ "$rc" -ne 0 ] || fail "THE TRIPWIRE DID NOT TRIP. A file under engine/ changed and the
  run was allowed to continue. In the published tree this is the difference between
  a verdict and a claim."
case "$BREACH" in
  *"PVS sandbox breach"*) ;;
  *) fail "it failed, but not with the breach annotation a reader can find:
$BREACH" ;;
esac
ok "edited engine/ file trips it, with the PVS sandbox breach annotation"

echo "── 4. it trips on a file ADDED under action/ too ──"
"$TRIPWIRE" arm "$TREE" "$TMP/before2.sha256" >/dev/null
echo 'planted' > "$TREE/action/planted.mjs"
"$TRIPWIRE" verify "$TREE" "$TMP/before2.sha256" "$TMP/after2.sha256" >/dev/null 2>&1
rc=$?
[ "$rc" -ne 0 ] || fail "a file PLANTED under action/ did not trip the tripwire"
ok "planted file trips it"

echo "── 5. a tree with worker/ present is still covered ──"
FULL="$TMP/full-tree"
mkdir -p "$FULL/engine" "$FULL/worker/src"
echo 'shipped' > "$FULL/engine/gates.sh"
echo 'shipped' > "$FULL/worker/src/index.js"
FULL_OUT="$("$TRIPWIRE" arm "$FULL" "$TMP/full-before.sha256")"
case "$FULL_OUT" in *worker*) ;; *) fail "worker/ was present and was not fingerprinted" ;; esac
echo 'tampered' >> "$FULL/worker/src/index.js"
"$TRIPWIRE" verify "$FULL" "$TMP/full-before.sha256" "$TMP/full-after.sha256" >/dev/null 2>&1
rc=$?
[ "$rc" -ne 0 ] || fail "worker/ is present but edits to it do not trip the tripwire"
ok "worker/ still covered when it exists"

echo "── 6. a tree with NONE of them refuses, loudly ──"
BARE="$TMP/bare"; mkdir -p "$BARE/docs"; echo x > "$BARE/docs/a.md"
BARE_OUT="$("$TRIPWIRE" arm "$BARE" "$TMP/bare.sha256" 2>&1)"
rc=$?
[ "$rc" -ne 0 ] || fail "a tree with no shipped directory must refuse to arm, not arm empty"
case "$BARE_OUT" in
  *"PVS tripwire unarmed"*) ;;
  *) fail "it refused, but said nothing a reader can act on:
$BARE_OUT" ;;
esac
ok "a tree with nothing of ours refuses to arm"

echo "── 7. action.yml goes through this script, not its own find ──"
# Structural, and the one a future edit breaks: the wrapper can be perfect and
# unused. The original defect was three copies of a command line, so the check is
# that no copy has come back.
grep -q 'runner/tripwire.sh" arm' "$ACTION_YML" \
  || fail "action.yml does not arm the tripwire through runner/tripwire.sh"
grep -q 'runner/tripwire.sh" verify' "$ACTION_YML" \
  || fail "action.yml does not verify the tripwire through runner/tripwire.sh"
if grep -qE '^[^#]*find +runner +worker' "$ACTION_YML"; then
  fail "action.yml has an inline 'find runner worker …' again — that is the defect,
  and it errors in any tree without one of those directories"
fi
ok "action.yml arms and verifies through the wrapper, with no inline copy"

echo
echo "TRIPWIRE OK — $pass checks. It trips in a worker-less tree."
