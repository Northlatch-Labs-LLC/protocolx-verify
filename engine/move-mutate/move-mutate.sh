#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# move-mutate — systematic mutation testing for any Sui Move package.
#
# A passing suite is not evidence. This tool derives mutations from the package's
# own sources, applies each in turn, and proves the suite notices. A mutation that
# survives names an invariant nothing tests. The mutation set is derived from the
# source itself — no curation, no blind spots by choice.
#
# Discipline, all of it load-bearing:
#   - BASELINE GUARD: the suite must be fully green before the first mutation. A red
#     baseline "kills" everything and proves nothing. A red baseline is REPORTED as
#     the finding it is; it is never worked around by weakening the suite.
#   - Byte-verified restore: every source file is SHA-256 hashed before and after; a
#     restore mismatch fails the run loudly.
#   - Applied-mutation check: if the edit changed nothing (stale line numbers, a race
#     with another writer), the run aborts rather than reporting a phantom kill.
#   - Every excluded or skipped item is COUNTED and PRINTED. Silent truncation reads
#     as "covered everything" when it wasn't.
#   - Mutants that fail to COMPILE are classified `invalid` and excluded from the
#     score. Counting them as kills would flatter the number.
#   - Assertions inside `#[test]` / `#[test_only]` declarations are excluded. They are
#     not production code, never reach deployed bytecode, and deleting one can never
#     fail the test that contains it — every such mutation is a phantom survivor.
#
# DEFAULTS ARE FROZEN ON PURPOSE. Bare `move-mutate.sh <pkg>` derives deletion-only,
# single-line-only, exactly as the first-pass tool did, so a published report stays
# reproducible from the tool's own defaults. Wider reach is opt-in.
#
# Usage:
#   move-mutate.sh <package-dir> [options]
#
#   --list                 print the derived mutation set and exit (no tests run)
#   --limit N              run only the first N mutations
#   --filter S             only mutate files whose path contains S
#   --operators SET        delete (default) | standard | all | CLS,CLS,...
#                          classes: DEL CMP BND NEG ARI ARG RET
#   --multiline            derive multi-line asserts too (implies parse derivation)
#   --jobs N               parallel workers, each in an isolated package copy (default 1)
#   --test-filter          run only tests matching the mutated module (FASTER, LESS SOUND)
#   --shared-move-home     do NOT give each worker its own Move cache (see below)
#   --out DIR              where reports are written (default: the package dir)
#   --delta-base FILE      a previous run's mutation-report.json; also emit MUTATION-DELTA.md
#
# PARALLELISM, AND WHY IT NEEDS ITS OWN MOVE CACHE. `sui move test` takes a lock on
# the shared Move package cache (MOVE_HOME, default ~/.move), so concurrent runs
# serialise completely: measured on this estate, four concurrent runs against four
# separate package copies took 32.0s versus 8.3s for one — exactly 4x, no gain at all.
# Giving each worker its own MOVE_HOME (an APFS clone of the cache, so it costs
# metadata rather than gigabytes) took the same four runs to 10.4s at 484% CPU. The
# driver therefore clones the cache per worker unless --shared-move-home is passed.
# Cache setup is a one-time cost of roughly 20s per worker; on short runs it will not
# pay for itself, which is why --jobs defaults to 1.
#
# Exit 0: every executed, valid mutation was killed. Exit 1: survivors, restore
# mismatch, red baseline, or nothing to mutate — the report names which.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib"

# --- dependency check: a clear message, never a stack trace or a silent empty set ---
if ! command -v python3 >/dev/null 2>&1; then
  echo "move-mutate: python3 is required but was not found on PATH." >&2
  echo "  The derivation and reporting stages are Python 3 (standard library only," >&2
  echo "  no pip packages). Install python3 and re-run. See README.md." >&2
  exit 2
fi
for f in movelex.py operators.py derive.py apply.py report.py; do
  [[ -f "$LIB/$f" ]] || { echo "move-mutate: missing library file $LIB/$f" >&2; exit 2; }
done

PKG="${1:?usage: move-mutate.sh <package-dir> [options]}"
shift
LIMIT=0; LIST=0; FILTER=""; OPERATORS="delete"; MULTILINE=0; JOBS=1
TEST_FILTER=0; OUTDIR=""; DELTA_BASE=""; SHARED_MH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --list) LIST=1; shift ;;
    --filter) FILTER="$2"; shift 2 ;;
    --operators) OPERATORS="$2"; shift 2 ;;
    --multiline) MULTILINE=1; shift ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --test-filter) TEST_FILTER=1; shift ;;
    --out) OUTDIR="$2"; shift 2 ;;
    --delta-base) DELTA_BASE="$2"; shift 2 ;;
    --shared-move-home) SHARED_MH=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$PKG" || exit 2
PKG_ABS="$(pwd)"
[[ -f Move.toml ]] || { echo "no Move.toml in $PKG" >&2; exit 2; }
[[ -z "$OUTDIR" ]] && OUTDIR="$PKG_ABS"

hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

# ---- derive ----
DERIVE_ARGS=(--operators "$OPERATORS")
[[ $MULTILINE == 1 ]] && DERIVE_ARGS+=(--multiline)
[[ -n "$FILTER" ]] && DERIVE_ARGS+=(--filter "$FILTER")
[[ $LIMIT -gt 0 ]] && DERIVE_ARGS+=(--limit "$LIMIT")

SET_JSON="$(mktemp)"
if ! PYTHONPATH="$LIB" python3 "$LIB/derive.py" "$PKG_ABS" "${DERIVE_ARGS[@]}" > "$SET_JSON"; then
  echo "move-mutate: derivation failed" >&2; rm -f "$SET_JSON"; exit 2
fi

read_field() { PYTHONPATH="$LIB" python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
v=d
for k in sys.argv[2].split('.'): v=v[k]
print(v if not isinstance(v,list) else ','.join(map(str,v)))" "$SET_JSON" "$1"; }

TOTAL="$(read_field derived)"
SKIP_N="$(read_field skipped_count)"
TI_N="$(read_field excluded_test_internal_count)"
EXCL_N="$(read_field excluded_test_files)"
MODE="$(read_field derivation_mode)"
SETHASH="$(read_field mutation_set_sha256)"
CLASSES="$(read_field operator_classes)"

echo "=== move-mutate: $PKG ==="
echo "derivation: $MODE · operators: $CLASSES · set sha256: ${SETHASH:0:16}"
echo "derived $TOTAL mutations, $SKIP_N multi-line skipped, $TI_N test-internal asserts excluded, $EXCL_N in-sources test files excluded"

if [[ $LIST == 1 ]]; then
  PYTHONPATH="$LIB" python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for m in d['mutations']: print('  %s  %s' % (m['id'], m['original']))
for s in d['skipped']: print('  SKIPPED (%s): %s:%d  %s' % (s['reason'], s['file'], s['line'], s['text']))
for e in d['excluded_test_internal']: print('  EXCLUDED (%s): %s:%d  %s' % (e['reason'], e['file'], e['line'], e['text']))
" "$SET_JSON"
  rm -f "$SET_JSON"; exit 0
fi
[[ $TOTAL -eq 0 ]] && { echo "nothing to mutate"; rm -f "$SET_JSON"; exit 1; }

# ---- baseline guard ----
echo "checking baseline (sui move test)…"
if ! sui move test >/dev/null 2>&1; then
  echo "!! BASELINE IS NOT GREEN. Fix the suite before measuring it."
  echo "   A red baseline kills every mutation and proves nothing. This is the"
  echo "   finding; it is not resolved by weakening the suite."
  rm -f "$SET_JSON"; exit 1
fi
echo "baseline green. mutating."

# ---- backups (full relative paths: same basename in two subdirs must not collide) ----
BACKUP_DIR="$(mktemp -d)"; WORKROOT="$(mktemp -d)"; RESULTS="$(mktemp -d)"
cleanup() {
  while IFS= read -r f; do
    [[ -f "$BACKUP_DIR/$f" ]] && cp "$BACKUP_DIR/$f" "$f"
  done < <(find sources -name "*.move")
  rm -rf "$BACKUP_DIR" "$WORKROOT" "$RESULTS" "$SET_JSON"
}
trap cleanup EXIT
PRE_HASH_FILE="$(mktemp)"
while IFS= read -r f; do
  mkdir -p "$BACKUP_DIR/$(dirname "$f")"
  cp "$f" "$BACKUP_DIR/$f"
  echo "$f:$(hash_of "$f")" >> "$PRE_HASH_FILE"
done < <(find sources -name '*.move')

# ---- worker ----
# Classification of a failing run is deliberate: a mutant that does not COMPILE was
# never given to the suite, so calling it "killed" would credit the suite for a
# failure it had no part in.
run_slice() {
  local widx="$1" workdir="$2"
  local n=-1
  while IFS=$'\t' read -r mid mfile mline; do
    n=$((n + 1))
    [[ $((n % JOBS)) -ne $widx ]] && continue
    cp "$BACKUP_DIR/$mfile" "$workdir/$mfile"
    local before after
    before="$(hash_of "$workdir/$mfile")"
    if ! PYTHONPATH="$LIB" python3 "$LIB/apply.py" --set "$SET_JSON" --id "$mid" \
         --src "$BACKUP_DIR/$mfile" --dst "$workdir/$mfile" 2>/dev/null; then
      echo -e "$mid\tapply_failed" >> "$RESULTS/w$widx.tsv"
      cp "$BACKUP_DIR/$mfile" "$workdir/$mfile"
      continue
    fi
    after="$(hash_of "$workdir/$mfile")"
    if [[ "$before" == "$after" ]]; then
      echo "!! mutation applied nothing at $mid — stale state, aborting" >&2
      echo -e "$mid\tapply_noop" >> "$RESULTS/w$widx.tsv"
      cp "$BACKUP_DIR/$mfile" "$workdir/$mfile"
      continue
    fi
    local out rc outcome tf=""
    if [[ $TEST_FILTER == 1 ]]; then
      tf="$(basename "$mfile" .move)"
    fi
    if [[ -d "$WORKROOT/mh$widx" ]]; then
      out="$( cd "$workdir" && MOVE_HOME="$WORKROOT/mh$widx" sui move test $tf 2>&1 )"
    else
      out="$( cd "$workdir" && sui move test $tf 2>&1 )"
    fi
    rc=$?
    # Native substring test, NOT `echo "$out" | grep -q`. Under `set -o pipefail`,
    # grep -q exits on first match, echo takes SIGPIPE, and the PIPELINE status is
    # 141 even though the pattern matched — so every genuine kill was classified
    # "did not compile". It is output-size dependent, so it passed on small packages
    # and silently inverted the result on large ones: a real run reported 0 killed /
    # 13 invalid where the truth was 13 killed / 0 invalid. No subprocess, no pipe,
    # no way for this to depend on how much the compiler printed.
    if [[ $rc -eq 0 ]]; then
      outcome="survived"
    elif [[ "$out" == *"Running Move unit tests"* ]]; then
      outcome="killed"
    else
      outcome="invalid"
    fi
    echo -e "$mid\t$outcome" >> "$RESULTS/w$widx.tsv"
    if [[ $JOBS -eq 1 ]]; then
      case "$outcome" in
        survived) echo "  SURVIVED  $mid" ;;
        killed)   echo "  killed    $mid" ;;
        invalid)  echo "  invalid   $mid (did not compile)" ;;
      esac
    fi
    cp "$BACKUP_DIR/$mfile" "$workdir/$mfile"
  done < "$WORKLIST"
}

WORKLIST="$(mktemp)"
PYTHONPATH="$LIB" python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for m in d['mutations']: print('%s\t%s\t%d' % (m['id'], m['file'], m['line']))" "$SET_JSON" > "$WORKLIST"

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ $JOBS -le 1 ]]; then
  JOBS=1
  run_slice 0 "$PKG_ABS"
else
  echo "parallel: $JOBS workers, each in an isolated package copy (the package itself is not mutated)"
  # A Move package may declare `local = "../libs/math"` dependencies that live
  # OUTSIDE it. Copying only the package breaks them and every build fails, which
  # presents as "every mutant is invalid" — a broken run wearing the costume of a
  # measured one. Copy the smallest tree containing the whole local closure.
  COPY_ROOT="$(PYTHONPATH="$LIB" python3 "$LIB/deps.py" "$PKG_ABS")"
  REL_PKG="$(python3 -c "import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$PKG_ABS" "$COPY_ROOT")"
  if [[ "$REL_PKG" != "." ]]; then
    echo "  local dependencies escape the package; copying $COPY_ROOT (package at ./$REL_PKG)"
  fi
  MH_SRC="${MOVE_HOME:-$HOME/.move}"
  if [[ $SHARED_MH == 1 ]]; then
    echo "  --shared-move-home: workers share $MH_SRC. NOTE: sui move test locks the"
    echo "  shared cache, so the workers will serialise and you should expect no speedup."
  else
    echo "  cloning the Move cache per worker (sui move test locks it; without this,"
    echo "  parallel workers serialise on the lock and gain nothing)"
  fi
  i=0
  while [[ $i -lt $JOBS ]]; do
    cp -R "$COPY_ROOT" "$WORKROOT/w$i"
    if [[ $SHARED_MH == 0 && -d "$MH_SRC" ]]; then
      cp -Rc "$MH_SRC" "$WORKROOT/mh$i" 2>/dev/null || cp -R "$MH_SRC" "$WORKROOT/mh$i"
    fi
    i=$((i + 1))
  done

  # WORKER SANITY CHECK. A worker that cannot build a PRISTINE copy will classify
  # its entire slice as invalid. Prove each worker green before mutating anything,
  # so an environment fault aborts loudly here instead of masquerading as a result.
  echo "  verifying each worker builds a pristine copy…"
  SANITY_DIR="$(mktemp -d)"
  i=0
  while [[ $i -lt $JOBS ]]; do
    ( cd "$WORKROOT/w$i/$REL_PKG" && MOVE_HOME="$WORKROOT/mh$i" sui move test >/dev/null 2>&1 \
        && echo ok > "$SANITY_DIR/w$i" || echo FAIL > "$SANITY_DIR/w$i" ) &
    i=$((i + 1))
  done
  wait
  SANITY_BAD=0
  i=0
  while [[ $i -lt $JOBS ]]; do
    [[ "$(cat "$SANITY_DIR/w$i" 2>/dev/null)" == "ok" ]] || SANITY_BAD=$((SANITY_BAD + 1))
    i=$((i + 1))
  done
  rm -rf "$SANITY_DIR"
  if [[ $SANITY_BAD -gt 0 ]]; then
    echo "!! $SANITY_BAD of $JOBS workers cannot build an UNMUTATED copy of the package."
    echo "   Every mutation in those workers would be reported as 'did not compile',"
    echo "   which would look like a measurement and would not be one. Aborting."
    echo "   Re-run with --jobs 1 to mutate the package in place."
    exit 2
  fi
  echo "  all $JOBS workers green on a pristine copy."
  i=0
  while [[ $i -lt $JOBS ]]; do
    run_slice "$i" "$WORKROOT/w$i/$REL_PKG" &
    i=$((i + 1))
  done
  wait
fi
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---- byte-verified restore ----
RESTORE_OK=1
while IFS= read -r entry; do
  f="${entry%%:*}"; h="${entry#*:}"
  [[ "$(hash_of "$f")" == "$h" ]] || { echo "RESTORE MISMATCH: $f"; RESTORE_OK=0; }
done < "$PRE_HASH_FILE"
[[ $RESTORE_OK == 1 ]] && echo "sources restored byte-identical"
rm -f "$PRE_HASH_FILE"

# ---- manifest + results ----
REPO_URL="$(git -C "$PKG_ABS" remote get-url origin 2>/dev/null || echo '')"
COMMIT="$(git -C "$PKG_ABS" rev-parse HEAD 2>/dev/null || echo '')"
DIRTY="$(git -C "$PKG_ABS" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
TOOLCHAIN="$(sui --version 2>/dev/null | head -1)"

COMBINED="$(mktemp)"
cat "$RESULTS"/w*.tsv 2>/dev/null > "$RESULTS/all.tsv" || true

MM_REPO_URL="$REPO_URL" MM_COMMIT="$COMMIT" MM_DIRTY="$DIRTY" MM_TOOLCHAIN="$TOOLCHAIN" \
MM_JOBS="$JOBS" MM_TESTFILTER="$([[ $TEST_FILTER == 1 ]] && echo 'ON (results are filtered; a survivor may be a false survivor)' || echo off)" \
MM_STARTED="$STARTED" MM_FINISHED="$FINISHED" MM_RESTORE="$([[ $RESTORE_OK == 1 ]] && echo verified || echo MISMATCH)" \
PYTHONPATH="$LIB" python3 - "$SET_JSON" "$RESULTS/all.tsv" "$COMBINED" <<'PYEOF'
import json, sys, os
setj, tsv, out = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(setj))
outcomes = {}
if os.path.exists(tsv):
    for line in open(tsv):
        parts = line.rstrip('\n').split('\t')
        if len(parts) == 2:
            outcomes[parts[0]] = parts[1]
results = []
for m in d['mutations']:
    o = outcomes.get(m['id'])
    if o is None:
        continue
    results.append({
        'id': m['id'], 'file': m['file'], 'line': m['line'],
        'rule_id': m['rule_id'], 'original': m['original'],
        'outcome': o, 'proposals': m.get('proposals', []),
    })
manifest = {
    'package': d['package'],
    'repo_url': os.environ.get('MM_REPO_URL', ''),
    'commit_sha': os.environ.get('MM_COMMIT', ''),
    'working_tree_dirty_files': os.environ.get('MM_DIRTY', ''),
    'toolchain': os.environ.get('MM_TOOLCHAIN', ''),
    'tool_version': '0.2.0',
    'derivation_mode': d['derivation_mode'],
    'operator_classes': d['operator_classes'],
    'multiline_enabled': d['multiline_enabled'],
    'derived': d['derived'],
    'mutation_set_sha256': d['mutation_set_sha256'],
    'excluded_test_files': d['excluded_test_files'],
    'jobs': os.environ.get('MM_JOBS', '1'),
    'test_filtering': os.environ.get('MM_TESTFILTER', 'off'),
    'started_utc': os.environ.get('MM_STARTED', ''),
    'finished_utc': os.environ.get('MM_FINISHED', ''),
    'restore_verified': os.environ.get('MM_RESTORE', ''),
}
json.dump({'manifest': manifest, 'results': results,
           'skipped': d['skipped'],
           'excluded_test_internal': d['excluded_test_internal']},
          open(out, 'w'), indent=2)
PYEOF

REPORT_ARGS=(--manifest "$COMBINED" --outdir "$OUTDIR")
[[ -n "$DELTA_BASE" ]] && REPORT_ARGS+=(--delta-base "$DELTA_BASE")
PYTHONPATH="$LIB" python3 "$LIB/report.py" "${REPORT_ARGS[@]}"

SUMMARY="$(PYTHONPATH="$LIB" python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
r=d['results']
k=sum(1 for x in r if x['outcome']=='killed')
s=sum(1 for x in r if x['outcome']=='survived')
i=sum(1 for x in r if x['outcome']=='invalid')
print('%d %d %d %d' % (len(r), k, s, i))" "$COMBINED")"
set -- $SUMMARY
RUN=$1; KILLED=$2; SURVIVED=$3; INVALID=$4
rm -f "$COMBINED" "$WORKLIST"

echo
echo "executed: $RUN  killed: $KILLED  survived: $SURVIVED  invalid(no compile): $INVALID"
echo "reports: $OUTDIR/MUTATION-REPORT.md · mutation-report.json · mutation-report.sarif"

# A mutant that did not compile measured nothing. If NOTHING compiled, the run
# measured nothing at all and must not report success — an all-invalid run that
# exits 0 is a broken run wearing the costume of a clean one.
VALID=$((KILLED + SURVIVED))
if [[ $VALID -eq 0 ]]; then
  echo "!! NO MUTANT COMPILED. This run measured nothing — it is not a pass."
  echo "   $INVALID of $RUN mutations failed to build. That is an environment or"
  echo "   dependency fault, not a property of the suite."
  exit 1
fi
if [[ $INVALID -gt 0 ]]; then
  PCT=$(( INVALID * 100 / RUN ))
  echo "note: $INVALID of $RUN mutants ($PCT%) did not compile and are excluded from the score."
  if [[ $PCT -ge 20 ]]; then
    echo "      That fraction is high enough to suspect an environment fault rather than"
    echo "      a property of the operators. Treat the score as provisional."
  fi
fi
[[ $SURVIVED -eq 0 && $RESTORE_OK == 1 ]] || exit 1
exit 0
