#!/usr/bin/env bash
# Built-by: @projectx.sui
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# Reruns, on this laptop, the same 24 steps that .github/workflows/ci.yml runs in the job
# named "Self-gates" — in the same order, with the same strictness. This tool measures gates
# for a living; a version of it that only measures OTHER repositories' gates is not credible,
# so it gates itself too, on demand rather than only in the cloud.
#
# WHY THIS FILE EXISTS
#
# The job existed in ci.yml and a hand-run of it was recorded once, on 2026-09-03, and that
# record cannot be reproduced without redoing the work by hand, step by step, from the workflow
# file. Nothing translated ci.yml into a script that reruns those steps here on demand. This is
# that script.
#
#   bash scripts/run-self-gates.sh
#
# It fails at the first failed step, same as `set -e` under GitHub Actions: a step is not
# considered to have passed because a later step also ran.
#
# A step this file cannot honestly run locally is not silently dropped and is not folded into a
# pass. It is named, it prints why it is skipped, and the skip is carried into the final verdict
# — a run with a skip records "pass-with-skips", never a bare "pass". Read on for which ones and
# why; as of this writing every step DOES run here, so this is a contingency, not the normal
# case.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# Where a run gets written down, when there is somewhere to write it. The recorder is a tool of
# the environment this repository is developed in, not of the repository: a clone that has no
# recorder still runs every gate below and still fails on a failure — it simply keeps no ledger.
# Set GATE_RECORDER to a recorder's path to have runs recorded; leave it unset and runs are not.
RECORDER="${GATE_RECORDER:-}"
SOLUTION_ID="protocolx-verify"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Every step that actually ran, in order, with its own outcome word. A step's word is appended
# only on the line AFTER its command, so under `set -e` a word can only be reached by a command
# that exited 0 — the log is a record of what ran, not a list written in advance.
#
# The rule is worth stating because the opposite has already cost us once: a sibling gate runner
# wrote a fixed summary string naming a security scan CLEAN on every pass, whatever the scanner
# had actually said, and every pass it recorded was therefore evidence of nothing.
declare -a STEP_LOG=()
SKIPPED=0

record_step() {
  # record_step <name> <verdict-word>
  STEP_LOG+=("$1: $2")
}

# Record the outcome either way, exactly once. The recorder never fails the gate — it warns and
# exits 0 on its own error, per its own docstring — so this trap only decides WHAT gets recorded,
# never whether recording is allowed to fail the run.
GATE_RECORDED=0
record_gate() {
  [ "$GATE_RECORDED" = "1" ] && return 0
  GATE_RECORDED=1
  [ -n "$RECORDER" ] && [ -f "$RECORDER" ] || return 0
  python3 "$RECORDER" "$SOLUTION_ID" "$1" "$2" "$3" || true
}

on_exit() {
  local rc=$?
  local elapsed=$(( $(date +%s) - started ))
  if [ "$rc" != "0" ]; then
    record_gate fail "$elapsed" "failed — see the output above for the step ($rc)"
  fi
  exit $rc
}
trap on_exit EXIT

started=$(date +%s)

# --- Step 1 ------------------------------------------------------------------------------------
step "Unit tests (crypto, routing, engine-output parsing)"
node --test worker/test/lib.test.mjs
record_step "unit-tests-lib" "OK"

# --- Step 2 ------------------------------------------------------------------------------------
step "Usage ledger (metering, absence, and the closed door)"
node --test worker/test/ledger.test.mjs
record_step "usage-ledger" "OK"

# --- Step 3 ------------------------------------------------------------------------------------
step "Evidence store and cross-language digest"
node --test worker/test/evidence-store.test.mjs
record_step "evidence-store" "OK"

# --- Step 4 ------------------------------------------------------------------------------------
step "Preflight — the values a stranger's repository gets to choose"
node --test runner/test/preflight.test.mjs
record_step "preflight" "OK"

# --- Step 5 ------------------------------------------------------------------------------------
step "Secret distance — the step that runs client code holds no credential"
bash runner/test/secret-distance.sh
record_step "secret-distance" "OK"

# --- Step 6 ------------------------------------------------------------------------------------
step "Mutation engine unit tests"
python3 engine/move-mutate/test/test_movemutate.py
record_step "mutation-engine-unit-tests" "OK"

# --- Step 7 ------------------------------------------------------------------------------------
step "The action's closure does not reach into the worker"
node --test runner/test/gates-output-mirror.test.mjs
record_step "gates-output-mirror" "OK"

# --- Step 8 ------------------------------------------------------------------------------------
step "The tamper tripwire trips in a tree with no worker/"
bash runner/test/tripwire.test.sh
record_step "tripwire" "OK"

# --- Step 9 ------------------------------------------------------------------------------------
step "Runner wiring (measurement must not depend on reporting)"
node --test runner/test/wiring.test.mjs
record_step "runner-wiring" "OK"

# --- Step 10 -----------------------------------------------------------------------------------
step "The published offer agrees with the published licence"
node --test runner/test/offer-copy.test.mjs
record_step "offer-copy" "OK"

# --- Step 11 -----------------------------------------------------------------------------------
step "The mutation gate is described by what it delivers, not by a superlative"
node --test runner/test/mutation-claim.test.mjs
record_step "mutation-claim" "OK"

# --- Step 12 -----------------------------------------------------------------------------------
step "Evidence bundle unit tests"
python3 engine/test/test_evidence_bundle.py
record_step "evidence-bundle-unit-tests" "OK"

# --- Step 13 -----------------------------------------------------------------------------------
step "Outcome classifier is not pipe-dependent"
bash engine/test/classify.sh
record_step "classifier-pipe-safety" "OK"

# --- Step 14 -----------------------------------------------------------------------------------
step "The shipped engine is the engine it claims to be"
bash engine/test/engine-drift.sh
record_step "engine-drift" "OK"

# --- Step 15 -----------------------------------------------------------------------------------
step "A digest that cannot be read is not a digest that disagreed"
bash engine/test/digest-reader.sh
record_step "digest-reader" "OK"

# --- Step 16 -----------------------------------------------------------------------------------
step "The digest comparison accepts exactly the deployed and the intended digest"
bash engine/test/digest-compare.sh
record_step "digest-compare" "OK"

# --- Step 17 -----------------------------------------------------------------------------------
step "A digest verdict does not accuse the source when the compiler moved"
bash engine/test/toolchain-note.sh
record_step "toolchain-note" "OK"

# --- Step 18 -----------------------------------------------------------------------------------
step "The shipped engine measures a nested package"
bash engine/test/app-path.sh
record_step "app-path" "OK"

# --- Step 19 -----------------------------------------------------------------------------------
step "Every shell script parses"
for f in scripts/*.sh engine/ci/*.sh engine/move-mutate/*.sh engine/test/*.sh \
         runner/*.sh runner/test/*.sh; do
  bash -n "$f"
  echo "$f: OK"
done
record_step "shell-scripts-parse" "OK"

# --- Step 20 -----------------------------------------------------------------------------------
step "Every JS entrypoint parses"
node --check worker/src/index.js
node --check worker/src/lib.js
node --check worker/src/ledger.js
node --check worker/test/ledger.test.mjs
node --check runner/mint-token.mjs
node --check runner/report-gates.mjs
node --check runner/preflight.mjs
node --check runner/lib/preflight.mjs
node --check runner/test/wiring.test.mjs
node --check runner/test/offer-copy.test.mjs
node --check runner/test/mutation-claim.test.mjs
node --check worker/test/evidence-store.test.mjs

node --check runner/test/preflight.test.mjs
node --check action/resolve-package.mjs
node --check action/summary.mjs
node --check action/gates-output.mjs
node --check runner/test/gates-output-mirror.test.mjs
record_step "js-entrypoints-parse" "OK"

# --- Step 21 -----------------------------------------------------------------------------------
step "Every module the worker imports is actually deployed"
node -e '
  const fs = require("fs");
  const src = fs.readFileSync("worker/src/index.js", "utf8");
  const deploy = fs.readFileSync("scripts/deploy.sh", "utf8");
  const imported = [...src.matchAll(/from\s+["\x27]\.\/([A-Za-z0-9_.-]+)["\x27]/g)].map((m) => m[1]);
  let bad = 0;
  for (const f of new Set(["index.js", ...imported])) {
    if (deploy.includes(f + "=@$HERE/worker/src/" + f)) {
      console.log("deploy.sh uploads " + f + ": OK");
    } else {
      console.error("deploy.sh does NOT upload worker/src/" + f + " — the deployed worker could not resolve it");
      bad = 1;
    }
  }
  process.exit(bad);
'
record_step "worker-modules-deployed" "OK"

# --- Step 22 -----------------------------------------------------------------------------------
step "Engine copies match their recorded hashes"
sha256sum -c engine/CHECKSUMS
record_step "engine-checksums" "OK"

# --- Step 23 -----------------------------------------------------------------------------------
step "Every Python entrypoint parses"
python3 -m py_compile runner/test/workflow-audit.py engine/move-mutate/lib/*.py
record_step "python-entrypoints-parse" "OK"

# --- Step 24 -----------------------------------------------------------------------------------
step "Manifest and workflow files are valid"
node -e 'JSON.parse(require("fs").readFileSync("app/app-manifest.json", "utf8")); console.log("manifest: valid JSON")'
node -e 'const fs = require("fs"); for (const f of fs.readdirSync(".github/workflows")) fs.readFileSync(".github/workflows/" + f, "utf8"); console.log("workflows: readable")'
record_step "manifest-and-workflows-valid" "OK"

elapsed=$(( $(date +%s) - started ))

# Build the summary from STEP_LOG — what actually ran and what it actually printed — never from
# a string written in advance. See the header note above for why that rule exists.
SUMMARY="$(IFS='; '; echo "${STEP_LOG[*]}")"

if [ "$SKIPPED" -gt 0 ]; then
  printf '\n\033[1m%s of %s steps ran; %s SKIPPED — see above. %ss.\033[0m\n' \
    "$(( ${#STEP_LOG[@]} ))" 24 "$SKIPPED" "$elapsed"
  record_gate pass "$elapsed" "pass-with-skips ($SKIPPED skipped): $SUMMARY"
else
  printf '\n\033[1mAll 24 self-gate steps passed in %ss.\033[0m\n' "$elapsed"
  record_gate pass "$elapsed" "24/24 self-gate steps, all rc=0: $SUMMARY"
fi
