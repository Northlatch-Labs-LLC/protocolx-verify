#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# sync-engine.sh — propagate the CANONICAL engine into protocolx-verify.
#
# This repository is canonical (see CANONICAL.md). The App's engine is a
# downstream artifact of this tree and must never be hand-edited.
#
# This is a SCRIPT, not a build step. Nothing forces it to run before a
# release. The drift GATE on the other side is what makes that survivable:
# an un-synced or hand-edited engine fails CI loudly rather than shipping
# quietly.
#
# Usage: ./sync-engine.sh <path-to-protocolx-verify> [--dry-run]
set -euo pipefail

DEST_REPO="${1:?usage: sync-engine.sh <path-to-protocolx-verify> [--dry-run]}"
DRY=0; [[ "${2:-}" == "--dry-run" ]] && DRY=1

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/move-mutate"
DEST="$DEST_REPO/engine/move-mutate"
[[ -d "$SRC"  ]] || { echo "no engine at $SRC" >&2; exit 2; }
[[ -d "$DEST" ]] || { echo "no destination engine at $DEST" >&2; exit 2; }

# Files to ship. lib/*.py is a GLOB on purpose: a hardcoded list is exactly
# how lib/shadow.py went missing from the shipped engine on 2026-08-30.
# bash 3.2 on macOS has no mapfile; portable read loop.
LIBS=()
while IFS= read -r l; do LIBS+=("$l"); done < <(cd "$SRC" && ls lib/*.py | sort)
FILES=("move-mutate.sh" "${LIBS[@]}")
# The ci scripts and their tests ship the same way, from the same tree, for the same reason:
# until 2026-09-01 `engine/ci/` was maintained by hand in the destination while a stale copy sat
# here, and the two had diverged by seventy-nine lines. One source, one sync, one manifest.
CI_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci"
TEST_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test"
CI_FILES=(); while IFS= read -r l; do CI_FILES+=("$l"); done < <(cd "$CI_SRC" && ls *.sh *.py 2>/dev/null | sort)
TEST_FILES=(); while IFS= read -r l; do TEST_FILES+=("$l"); done < <(cd "$TEST_SRC" && ls *.sh 2>/dev/null | sort)
echo "ci files to ship: ${#CI_FILES[@]}; test files to ship: ${#TEST_FILES[@]} (both discovered by glob)"
echo "engine files to ship: ${#FILES[@]} (${#LIBS[@]} lib modules, discovered by glob)"

# The loader inside move-mutate.sh must name exactly the lib modules we ship,
# minus deps.py which is imported rather than sourced. Catching a mismatch
# HERE means the shipped engine can never load a different module set than it
# carries — the shadow.py defect, made structurally impossible.
LOADED="$(grep -oE '^for f in [a-z_. ]+\.py; do' "$SRC/move-mutate.sh" | sed 's/^for f in //; s/; do$//' | tr ' ' '\n' | sort | tr '\n' ' ')"
PRESENT="$(printf '%s\n' "${LIBS[@]}" | sed 's|^lib/||' | grep -v '^deps.py$' | sort | tr '\n' ' ')"
if [[ "$LOADED" != "$PRESENT" ]]; then
  echo "!! REFUSING TO SYNC — loader/module mismatch in the CANONICAL engine" >&2
  echo "   loader names : $LOADED" >&2
  echo "   lib contains : $PRESENT" >&2
  exit 1
fi
echo "loader/module list agree: $PRESENT"

if [[ $DRY == 1 ]]; then echo "(dry run — nothing copied)"; exit 0; fi

SRC_COMMIT="$(git -C "$(dirname "$SRC")" rev-parse HEAD 2>/dev/null || echo UNCOMMITTED)"
SRC_DIRTY="$(git -C "$(dirname "$SRC")" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

mkdir -p "$DEST/lib"
for f in "${FILES[@]}"; do
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$SRC/$f" "$DEST/$f"
done
chmod +x "$DEST/move-mutate.sh"

# Stamp every shipped file so the warning is where the editor's cursor is.
#
# ENGINE_PROVENANCE already said DO NOT EDIT, but it is a separate file, and nobody opens it on
# their way to changing `lib/shadow.py`. On 2026-08-30 the shipped engine was hand-edited and the
# two copies diverged within hours of a sync. A banner in a neighbouring file prevents nothing;
# a banner on line 2 of the file being edited is the one a person actually reads.
#
# Inserted after the shebang, never before it: a `#!` that is not the first line is not a shebang,
# and `move-mutate.sh` is executed directly.
BANNER_1="# ─────────────────────────────────────────────────────────────────────────────"
BANNER_2="# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools."
BANNER_3="# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost"
BANNER_4="# on the next sync and cause the engine to differ from the tree it claims."
BANNER_5="# source_commit: $SRC_COMMIT"
BANNER_6="# ─────────────────────────────────────────────────────────────────────────────"
for f in "${FILES[@]}"; do
  t="$DEST/$f"
  head -1 "$t" | grep -q '^#!' && SHEBANG="$(head -1 "$t")" && BODY="$(tail -n +2 "$t")" || { SHEBANG=""; BODY="$(cat "$t")"; }
  {
    [[ -n "$SHEBANG" ]] && printf '%s\n' "$SHEBANG"
    printf '%s\n' "$BANNER_1" "$BANNER_2" "$BANNER_3" "$BANNER_4" "$BANNER_5" "$BANNER_6"
    printf '%s\n' "$BODY"
  } > "$t.stamped"
  mv "$t.stamped" "$t"
done
chmod +x "$DEST/move-mutate.sh"
# Stale modules in the destination are removed: a lib file that is no longer
# canonical must not linger and get imported.
for f in "$DEST"/lib/*.py; do
  b="lib/$(basename "$f")"
  printf '%s\n' "${FILES[@]}" | grep -qx "$b" || { echo "removing stale $b"; rm "$f"; }
done

stamp() {  # stamp <file>: the same banner the engine files carry, after the shebang if any
  local t="$1" SHEBANG BODY
  head -1 "$t" | grep -q '^#!' && SHEBANG="$(head -1 "$t")" && BODY="$(tail -n +2 "$t")" || { SHEBANG=""; BODY="$(cat "$t")"; }
  { [[ -n "$SHEBANG" ]] && printf '%s\n' "$SHEBANG"
    printf '%s\n' "$BANNER_1" "$BANNER_2" "$BANNER_3" "$BANNER_4" "$BANNER_5" "$BANNER_6"
    printf '%s\n' "$BODY"; } > "$t.stamped"
  mv "$t.stamped" "$t"
}
mkdir -p "$DEST_REPO/engine/ci" "$DEST_REPO/engine/test"
for f in "${CI_FILES[@]}"; do cp "$CI_SRC/$f" "$DEST_REPO/engine/ci/$f"; stamp "$DEST_REPO/engine/ci/$f"; done
for f in "${TEST_FILES[@]}"; do cp "$TEST_SRC/$f" "$DEST_REPO/engine/test/$f"; stamp "$DEST_REPO/engine/test/$f"; done
chmod +x "$DEST_REPO"/engine/ci/*.sh "$DEST_REPO"/engine/test/*.sh
echo "ci/test   -> ${#CI_FILES[@]} ci files and ${#TEST_FILES[@]} test files shipped and stamped"

PROV="$DEST_REPO/engine/ENGINE_PROVENANCE"
{
  echo "# Generated by verification-tools/sync-engine.sh — DO NOT EDIT BY HAND."
  echo "# The engine below is a downstream artifact of verification-tools,"
  echo "# which is canonical. See verification-tools/CANONICAL.md."
  echo "source_repo: verification-tools"
  echo "source_commit: $SRC_COMMIT"
  echo "source_dirty_files: $SRC_DIRTY"
  echo "engine_files: ${#FILES[@]}"
  echo "loader_modules: $PRESENT"
  echo "--- sha256 ---"
  for f in "${FILES[@]}"; do
    echo "$(shasum -a 256 "$DEST/$f" | cut -d' ' -f1)  engine/move-mutate/$f"
  done
  for f in "${CI_FILES[@]}"; do
    echo "$(shasum -a 256 "$DEST_REPO/engine/ci/$f" | cut -d' ' -f1)  engine/ci/$f"
  done
  for f in "${TEST_FILES[@]}"; do
    echo "$(shasum -a 256 "$DEST_REPO/engine/test/$f" | cut -d' ' -f1)  engine/test/$f"
  done
} > "$PROV"

# Regenerate the client-facing checksum manifest.
#
# THIS STEP DID NOT EXIST. `engine/CHECKSUMS` pins fifteen files and `action.yml` verifies it with
# `sha256sum -c` on EVERY client run — and eight of those pinned files are the ones this script
# copies. So a sync left the manifest stale and the next customer run died on the checksum gate.
# It only ever passed because somebody remembered to refresh it by hand afterwards, which is not a
# safeguard, it is a habit.
#
# Rebuilt in full from the destination tree so the manifest describes what is actually shipped,
# and verified immediately: a manifest that does not check out is worse than none, because
# `action.yml` trusts it.
CHK="$DEST_REPO/engine/CHECKSUMS"
if [[ -f "$CHK" ]]; then
  ( cd "$DEST_REPO" && { awk '{print $2}' engine/CHECKSUMS
      for f in "${FILES[@]}"; do echo "engine/move-mutate/$f"; done
      for f in "${CI_FILES[@]}"; do echo "engine/ci/$f"; done
      for f in "${TEST_FILES[@]}"; do echo "engine/test/$f"; done; } | sort -u > /tmp/.chk-files
    : > engine/CHECKSUMS.new
    while read -r rel; do
      [[ -f "$rel" ]] && shasum -a 256 "$rel" >> engine/CHECKSUMS.new \
        || echo "WARNING: CHECKSUMS names $rel, which is not in the tree" >&2
    done < /tmp/.chk-files
    mv engine/CHECKSUMS.new engine/CHECKSUMS
    if sha256sum -c engine/CHECKSUMS >/dev/null 2>&1; then
      echo "checksums  -> engine/CHECKSUMS rebuilt and verified ($(wc -l < engine/CHECKSUMS | tr -d ' ') files)"
    else
      echo "checksums  -> REBUILT BUT DOES NOT VERIFY — do not ship this tree" >&2
      exit 3
    fi )
else
  echo "checksums  -> no engine/CHECKSUMS in the destination; nothing to rebuild" >&2
fi

echo "synced ${#FILES[@]} files -> $DEST"
echo "provenance -> $PROV (source_commit $SRC_COMMIT, dirty $SRC_DIRTY)"
[[ "$SRC_DIRTY" != "0" ]] && echo "NOTE: canonical tree had $SRC_DIRTY uncommitted file(s) at sync time; recorded, not hidden."
exit 0
