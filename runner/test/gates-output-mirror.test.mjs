// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// gates-output-mirror — the gate-output parser exists twice on purpose, so this
// proves the two copies still agree.
//
// WHY TWICE. action/summary.mjs used to import the parser from worker/src/lib.js.
// The worker does not ship with the composite action, so in a tree without it the
// final step of every run died with ERR_MODULE_NOT_FOUND — after installing the
// toolchain, sandboxing the client's code and measuring all five gates. The action's
// closure must not reach outside action/, runner/ and engine/, and the worker is
// deployed as an explicit module list and must not reach across the tree either.
//
// Duplication is the lesser evil here, but only while something checks it. Two
// parsers that quietly disagree would have the check runs and the step summary
// reporting different verdicts from the same log, and nothing would say so.
//
// The second half of this file is the structural guard: no file the action executes
// at runtime may import from a directory the published tree does not carry. That is
// the check the original defect needed and did not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as actionCopy from '../../action/gates-output.mjs';
import * as workerCopy from '../../worker/src/lib.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CASES = {
  'all five ruled, mixed': [
    '── gate: build',
    '   build: PASS',
    '── gate: digest — skipped (no ci-expected-digest; not a deployed package)',
    '── gate: tests',
    '   tests: PASS',
    '── gate: pin — skipped (no scripts/check-framework-pin.sh)',
    '── gate: mutation-smoke',
    '   mutation-smoke: FAIL',
  ].join('\n'),
  'empty log': '',
  'silence on one gate': ['── gate: build', '   build: PASS'].join('\n'),
  'skipped with no reason': '── gate: pin — skipped',
  'a PASS line that is not at column 3 must not count':
    '── gate: build\n  build: PASS',
  'gate name appearing inside prose must not count':
    'the build: PASS you are looking for is not a gate line',
  'trailing whitespace after the verdict': '── gate: tests\n   tests: PASS ',
  'CRLF line endings': '── gate: build\r\n   build: PASS\r\n',
};

const captured = join(ROOT, 'engine', 'test', 'fixtures', 'nested-fixture-gates.log');
if (existsSync(captured)) {
  CASES['a real captured gates.log'] = readFileSync(captured, 'utf8');
}

test('GATES is the same list, in the same order, in both copies', () => {
  assert.deepEqual(actionCopy.GATES, workerCopy.GATES);
});

for (const [name, input] of Object.entries(CASES)) {
  test(`parseGatesOutput agrees across both copies: ${name}`, () => {
    assert.deepEqual(
      actionCopy.parseGatesOutput(input),
      workerCopy.parseGatesOutput(input),
      'the action copy and the worker copy have drifted — one of them is now '
      + 'reporting a verdict the other would not',
    );
  });
}

test('the captured gates.log parses to a real, non-empty verdict set', () => {
  if (!existsSync(captured)) return;
  const parsed = actionCopy.parseGatesOutput(readFileSync(captured, 'utf8'));
  assert.ok(Object.keys(parsed).length > 0,
    'the mirror test proves nothing if the shared fixture parses to {}');
});

// ── the structural guard ────────────────────────────────────────────────────────
//
// Directories the published composite action does not carry. A runtime file that
// imports from one of them works in this repository and crashes in the published
// tree, at the last step, after all the work is done.
const NOT_SHIPPED = ['worker', 'scripts', 'app'];

// Everything action.yml executes with node, plus what those files reach.
const RUNTIME_FILES = [
  'action/summary.mjs',
  'action/resolve-package.mjs',
  'action/gates-output.mjs',
  'runner/preflight.mjs',
  'runner/lib/preflight.mjs',
];

test('no runtime file imports from a directory the published tree does not carry', () => {
  for (const rel of RUNTIME_FILES) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*import[^'"]*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      for (const dir of NOT_SHIPPED) {
        assert.ok(
          !new RegExp(`(^|/)${dir}/`).test(spec),
          `${rel} imports "${spec}" — ${dir}/ does not ship with the action, so this `
          + 'resolves here and throws ERR_MODULE_NOT_FOUND in the published tree',
        );
      }
    }
  }
});

test('action.yml runs no node entrypoint outside action/ and runner/', () => {
  const yml = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  for (const m of yml.matchAll(/node "\$GITHUB_ACTION_PATH\/([^"]+)"/g)) {
    const rel = m[1];
    assert.ok(/^(action|runner)\//.test(rel),
      `action.yml runs ${rel}, which is outside the shipped closure`);
    assert.ok(existsSync(join(ROOT, rel)), `action.yml runs ${rel}, which does not exist`);
  }
});

test('every .mjs under action/ is part of the declared runtime set', () => {
  // A new file under action/ that nobody adds to RUNTIME_FILES is a file the guard
  // above silently stops covering.
  for (const f of readdirSync(join(ROOT, 'action'))) {
    if (!f.endsWith('.mjs')) continue;
    assert.ok(RUNTIME_FILES.includes(`action/${f}`),
      `action/${f} is not in RUNTIME_FILES, so the import guard does not check it`);
  }
});
