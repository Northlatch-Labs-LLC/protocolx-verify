// Built-by: @projectx.sui /|\
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// The runner's wiring, asserted as a structure rather than trusted as a habit.
//
// WHY THIS FILE EXISTS. The runner once conditioned the gates on a step whose only job
// was to colour five check runs yellow. A GitHub API hiccup there skipped the gates
// entirely: the client lost the whole MEASUREMENT rather than merely its display, and
// nothing in the repository would have caught the regression, because the coupling was
// invisible — an ordinary success chain in a YAML file.
//
// These tests read verify-run.yml and assert the shape that keeps measurement
// independent of delivery. They are deliberately structural: a future edit that drops
// an `always()` or removes `continue-on-error` re-introduces the defect silently, and
// this is the tripwire.
//
// Run: node --test runner/test/wiring.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/verify-run.yml', import.meta.url), 'utf8');

// Pull one step's block out of the job. A step starts at `      - name: <name>` and
// ends at the next step's `      - ` at the same indentation.
function step(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => l === `      - name: ${name}`);
  assert.notEqual(start, -1, `verify-run.yml has no step named "${name}"`);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- (name|uses):/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

// The `if:` expression of a step, as written.
function condition(name) {
  const m = step(name).match(/^ {8}if: (.*)$/m);
  return m ? m[1].trim() : null;
}

test('the gates do not depend on the check runs being marked in progress', () => {
  // The defect, stated as an assertion. `always()` is what decouples the measurement
  // from every step above it that is not a genuine precondition.
  const gates = condition('Run the gates');
  assert.match(gates, /always\(\)/,
    'Run the gates must be always()-conditioned, or a failure in any earlier step — '
    + 'including the purely cosmetic in-progress marking — silently skips the '
    + 'measurement and the client loses their gates, not just their yellow rows.');
  assert.match(gates, /steps\.ready\.outputs\.ready == '1'/,
    'Run the gates must depend on the precondition gate, so that a broken toolchain or '
    + 'a failed client checkout is reported as not-run rather than as the client\'s '
    + 'code failing to build.');
});

test('marking in progress cannot fail the job', () => {
  assert.match(step('Mark gates in progress'), /^ {8}continue-on-error: true$/m,
    'the in-progress marking is a liveness signal, not evidence; it must never be able '
    + 'to stop or fail a measurement');
});

test('the precondition gate covers what measuring actually needs, and only that', () => {
  const ready = step('Preconditions met');
  // No always(): this step MUST fall out of the ordinary success chain, so that a
  // failed fetch or a missing toolchain leaves `ready` unset and the gates do not run.
  assert.ok(!/always\(\)/.test(ready),
    'Preconditions met must not be always() — it is precisely the step that should be '
    + 'skipped when a real precondition failed');
  assert.match(ready, /if: steps\.cfg\.outputs\.found == '1'/);

  // Ordering is load-bearing: the precondition gate has to sit after the toolchain and
  // engine self-test, and before the first delivery step.
  const order = ['Install Sui CLI (pinned)', 'Verify the mutation engine before touching client code',
    'Preconditions met', 'Mark gates in progress', 'Run the gates'];
  const positions = order.map((n) => WORKFLOW.indexOf(`      - name: ${n}`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1],
      `"${order[i]}" must come after "${order[i - 1]}"`);
  }
});

test('the evidence bundle is written and uploaded whatever else failed', () => {
  for (const name of ['Build the evidence bundle', 'Upload the evidence bundle']) {
    assert.match(condition(name), /always\(\)/,
      `${name} must be always(): a reporting failure must degrade to "measured, could `
      + 'not report" with the evidence still on disk and still uploaded');
  }
  assert.match(step('Upload the evidence bundle'), /if-no-files-found: warn/,
    'a missing bundle must not fail the job on top of whatever already went wrong');
});

test('reporting is attempted whatever happened upstream, and the sweep gets the log', () => {
  assert.match(condition('Report gate verdicts'), /always\(\)/);
  assert.match(step('Sweep unfinished check runs'), /report-gates\.mjs sweep gates\.log/,
    'the sweep must be handed the gates log, or it cannot tell a gate that ran and '
    + 'failed to post from a gate that never ran, and will overwrite the first with the '
    + 'second');
});
