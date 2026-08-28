#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# move-mutate — systematic mutation testing for any Sui Move package.
#
# A passing suite is not evidence. This tool derives one mutation per single-line `assert!`
# in the package's sources, deletes each in turn, and proves the suite notices. A mutation
# that survives names an invariant nothing tests. Unlike a hand-picked harness, the mutation
# set is derived from the source itself — every assert, no curation, no blind spots by choice.
#
# Discipline inherited from the estate's hand-built harnesses, all of it load-bearing:
#   - BASELINE GUARD: the suite must be fully green before the first mutation. A red baseline
#     "kills" everything and proves nothing.
#   - Byte-verified restore: every source file is SHA-256 hashed before and after; a restore
#     mismatch fails the run loudly.
#   - Applied-mutation check: if blanking the line changed nothing (stale line numbers, a race
#     with another writer), the run aborts rather than reporting a phantom kill.
#   - Multi-line asserts are SKIPPED and counted — a capability gap stated, never silently
#     dropped. (Silent truncation reads as "covered everything" when it wasn't.)
#
# Usage:
#   move-mutate.sh <package-dir> [--limit N] [--list] [--filter <substring>]
#
#   <package-dir>  directory containing Move.toml
#   --list         print the derived mutation set and exit (no tests run)
#   --limit N      run only the first N mutations (acceptance runs, smoke checks)
#   --filter S     only mutate lines whose file path contains S
#
# Exit 0: every executed mutation was killed. Exit 1: survivors, skipped-only run, restore
# mismatch, or red baseline — the report names which.
set -uo pipefail

PKG="${1:?usage: move-mutate.sh <package-dir> [--limit N] [--list] [--filter S]}"
shift
LIMIT=0; LIST=0; FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    --filter) FILTER="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$PKG" || exit 2
[[ -f Move.toml ]] || { echo "no Move.toml in $PKG" >&2; exit 2; }

hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

# ---- derive the mutation set: every single-line `assert!(...);` in sources/ ----
# Multi-line asserts (no closing `);` on the same line) are recorded as skipped.
MUTATIONS=()   # "file:line:text"
SKIPPED=()
SKIP_N=0; MUT_N=0
while IFS= read -r hit; do
  file="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; text="${rest#*:}"
  [[ -n "$FILTER" && "$file" != *"$FILTER"* ]] && continue
  trimmed="$(echo "$text" | sed 's/^[[:space:]]*//')"
  [[ "$trimmed" == //* ]] && continue                      # commented-out code
  if [[ "$trimmed" == assert!* && "$trimmed" == *");"* ]]; then
    MUTATIONS+=("$file:$line:$trimmed"); MUT_N=$((MUT_N + 1))
  elif [[ "$trimmed" == assert!* ]]; then
    SKIPPED+=("$file:$line:$trimmed"); SKIP_N=$((SKIP_N + 1))
  fi
done < <(grep -Hn "assert!" sources/*.move 2>/dev/null)

TOTAL=$MUT_N
echo "=== move-mutate: $PKG ==="
echo "derived $TOTAL single-line assert mutations, $SKIP_N multi-line skipped"
if [[ $LIST == 1 ]]; then
  for m in ${MUTATIONS[@]+"${MUTATIONS[@]}"}; do echo "  $m"; done
  for s in ${SKIPPED[@]+"${SKIPPED[@]}"}; do echo "  SKIPPED (multi-line): $s"; done
  exit 0
fi
[[ $TOTAL -eq 0 ]] && { echo "nothing to mutate"; exit 1; }

# ---- baseline guard ----
echo "checking baseline (sui move test)…"
if ! sui move test >/dev/null 2>&1; then
  echo "!! BASELINE IS NOT GREEN. Fix the suite before measuring it."; exit 1
fi
echo "baseline green. mutating."

# ---- backups ----
BACKUP_DIR="$(mktemp -d)"
trap 'for f in sources/*.move; do [[ -f "$BACKUP_DIR/$(basename "$f")" ]] && cp "$BACKUP_DIR/$(basename "$f")" "$f"; done; rm -rf "$BACKUP_DIR"' EXIT
declare -a PRE_HASHES=()
for f in sources/*.move; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
  PRE_HASHES+=("$f:$(hash_of "$f")")
done

KILLED=0; SURVIVED=0; RUN=0
declare -a SURVIVORS=()
for m in ${MUTATIONS[@]+"${MUTATIONS[@]}"}; do
  [[ $LIMIT -gt 0 && $RUN -ge $LIMIT ]] && break
  file="${m%%:*}"; rest="${m#*:}"; line="${rest%%:*}"; text="${rest#*:}"
  cp "$BACKUP_DIR/$(basename "$file")" "$file"
  before="$(hash_of "$file")"
  sed -i '' "${line}s/.*//" "$file"
  after="$(hash_of "$file")"
  if [[ "$before" == "$after" ]]; then
    echo "!! mutation applied nothing at $file:$line — stale state, aborting"; exit 1
  fi
  RUN=$((RUN + 1))
  if sui move test >/dev/null 2>&1; then
    echo "  SURVIVED  $file:$line  $text"
    SURVIVED=$((SURVIVED + 1)); SURVIVORS+=("$file:$line  $text")
  else
    echo "  killed    $file:$line"
    KILLED=$((KILLED + 1))
  fi
  cp "$BACKUP_DIR/$(basename "$file")" "$file"
done

# ---- byte-verified restore ----
RESTORE_OK=1
for entry in "${PRE_HASHES[@]}"; do
  f="${entry%%:*}"; h="${entry#*:}"
  [[ "$(hash_of "$f")" == "$h" ]] || { echo "RESTORE MISMATCH: $f"; RESTORE_OK=0; }
done
[[ $RESTORE_OK == 1 ]] && echo "sources restored byte-identical"

# ---- report ----
REPORT="MUTATION-REPORT.md"
{
  echo "# Mutation report — $(basename "$(pwd)")"
  echo
  echo "Derived: $TOTAL single-line assert mutations ($SKIP_N multi-line skipped)."
  echo "Executed: $RUN · killed: $KILLED · survived: $SURVIVED"
  echo
  if [[ $SURVIVED -gt 0 ]]; then
    echo "## Survivors — invariants nothing tests"
    for s in ${SURVIVORS[@]+"${SURVIVORS[@]}"}; do echo "- \`$s\`"; done
    echo
  fi
  if [[ $SKIP_N -gt 0 ]]; then
    echo "## Skipped (multi-line asserts — mutate by hand)"
    for s in ${SKIPPED[@]+"${SKIPPED[@]}"}; do echo "- \`$s\`"; done
  fi
} > "$REPORT"
echo
echo "executed: $RUN  killed: $KILLED  survived: $SURVIVED  (report: $PKG/$REPORT)"
[[ $SURVIVED -eq 0 && $RESTORE_OK == 1 ]] || exit 1
exit 0
