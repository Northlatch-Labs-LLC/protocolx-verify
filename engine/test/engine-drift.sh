#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# engine-drift.sh — fail the build when the shipped engine is not the engine
# it claims to be.
#
# WHY THIS EXISTS. On 2026-08-30 the shipped engine was found missing
# lib/shadow.py entirely, hours after being synced from canonical. The App
# ran a measurably different engine from the canonical one.
# That is the precise failure our own digest gate sells against — the thing
# that runs is not the thing in the repository. We cannot sell drift defence
# while shipping drift.
#
# Three independent checks. Each catches a different way the engine rots.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2

PROV="engine/ENGINE_PROVENANCE"
ENGINE="engine/move-mutate"
FAIL=0
note() { echo "  $*"; }
fail() { echo "FAIL: $*" >&2; FAIL=1; }

echo "=== engine drift gate ==="

# ---- 1. provenance exists and is machine-readable -------------------------
if [[ ! -f "$PROV" ]]; then
  fail "no $PROV — the shipped engine cannot prove where it came from."
  echo "  Run verification-tools/sync-engine.sh <this-repo> to produce it."
  exit 1
fi
SRC_COMMIT="$(awk '/^source_commit:/{print $2}' "$PROV")"
LOADER_MODS="$(sed -n 's/^loader_modules: //p' "$PROV" | tr -s ' ' | sed 's/ *$//')"
note "provenance present · canonical commit ${SRC_COMMIT:-UNKNOWN}"

# ---- 2. every recorded file is present and unmodified ---------------------
# Catches hand-edits to the shipped engine and truncated syncs.
RECORDED=0; MISSING=0; MODIFIED=0
while read -r want path; do
  [[ -z "${want:-}" || -z "${path:-}" ]] && continue
  RECORDED=$((RECORDED+1))
  if [[ ! -f "$path" ]]; then
    fail "recorded file MISSING from the shipped tree: $path"; MISSING=$((MISSING+1)); continue
  fi
  got="$(shasum -a 256 "$path" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    fail "shipped file MODIFIED since sync: $path"
    note "    recorded $want"
    note "    actual   $got"
    MODIFIED=$((MODIFIED+1))
  fi
done < <(sed -n '/^--- sha256 ---$/,$p' "$PROV" | tail -n +2)
note "recorded files: $RECORDED · missing: $MISSING · modified: $MODIFIED"

# ---- 3. the loader and the shipped modules must agree ---------------------
# THE shadow.py CHECK. A module present but never loaded is dead weight; a
# module loaded but absent is a crash. Either way the engine is not what it
# claims. This check is self-contained — it needs no access to the canonical
# repo, so it runs in CI here.
LOADED="$(grep -oE '^for f in [a-z_. ]+\.py; do' "$ENGINE/move-mutate.sh" \
          | sed 's/^for f in //; s/; do$//' | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ' | sed 's/ *$//')"
PRESENT="$(ls "$ENGINE"/lib/*.py 2>/dev/null | xargs -n1 basename | grep -v '^deps.py$' | sort | tr '\n' ' ' | sed 's/ *$//')"
note "loader names : ${LOADED:-<none>}"
note "lib contains : ${PRESENT:-<none>}"
[[ "$LOADED" == "$PRESENT" ]] || fail "loader/module MISMATCH — the engine loads a different module set than it ships."

# Provenance's own record of the loader must match reality too, so a stale
# provenance file cannot certify a changed engine.
if [[ -n "$LOADER_MODS" && "$LOADER_MODS" != "$PRESENT" ]]; then
  fail "provenance loader_modules ($LOADER_MODS) != shipped lib ($PRESENT) — provenance is stale."
fi

echo
if [[ $FAIL -eq 0 ]]; then
  echo "PASS — shipped engine matches its provenance and loads exactly what it ships."
  exit 0
fi
echo "DRIFT DETECTED. The shipped engine is not the engine it claims to be."
echo "Fix at source: edit verification-tools (canonical), then re-run its sync-engine.sh."
echo "Never hand-edit engine/ in this repository."
exit 1
