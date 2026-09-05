// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// What the README is allowed to claim about mutation testing.
//
// WHY THIS FILE EXISTS. `mutation-smoke` is the gate that tells a reader something they
// did not already know, so it is the one the copy will always want to oversell. The
// oversell has a specific and checkable shape: claiming the technique is ours. It is
// not. Mutation testing for Move exists elsewhere as an installable command, and the
// first person to check would find that out — at which point every other measured
// sentence on the page is worth less than it was.
//
// What IS true, and what the copy is for, is delivery: this one runs on every pull
// request inside CI the reader already has, and reports counts as a check run beside
// the other four gates. A command measures a suite on the day somebody types it. That
// difference is defensible without a superlative, and superlatives here are the failure
// mode this file forbids.
//
// The rule is deliberately narrow: a superlative is only refused when it lands in the
// same sentence as the technique. "The only interesting thing this tool does" is the
// README's own line about a red gate and it is a claim about US, not about the field —
// flagging it would teach the next person to delete a true sentence, which is how a
// guard becomes something people route around.
//
// Run: node --test runner/test/mutation-claim.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

// Sentences, roughly: split on terminal punctuation followed by space or newline.
// Deliberately not a parser. A superlative and the technique it exaggerates have to be
// close enough to read as one claim, and a sentence is the unit a reader takes as one.
function sentences(text) {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SUPERLATIVES = [
  'the only', 'the first', 'no other', 'nobody else', 'unique', 'nothing else',
  'the sole', 'exclusively ours', 'we alone',
];

const TECHNIQUE = /mutation (testing|engine|smoke|coverage)|mutation-smoke/i;

test('no sentence claims the technique itself is ours alone', () => {
  const offenders = [];
  for (const s of sentences(README)) {
    if (!TECHNIQUE.test(s)) continue;
    const lower = s.toLowerCase();
    for (const sup of SUPERLATIVES) {
      if (lower.includes(sup)) offenders.push(`${sup} → ${s}`);
    }
  }
  assert.deepEqual(offenders, [],
    'A superlative sits in the same sentence as mutation testing. The technique is not ' +
    'ours — it exists elsewhere as an installable command — and a reader who checks will ' +
    'discount every other measured claim on the page. Say what the delivery is instead.\n' +
    offenders.join('\n'));
});

test('the delivery claim is on the page, because it is what the superlative would have been standing in for', () => {
  // Exact in both directions with the test above: that one forbids the false claim,
  // this one requires the true one, so removing the paragraph fails rather than
  // silently leaving the section making no distinction at all.
  const para = README.match(/\*\*And it runs whether or not anyone remembers to run it\.\*\*[\s\S]{0,600}?\n\n/);
  assert.ok(para, 'the paragraph saying where the mutation gate runs is gone from the README');
  const text = para[0];
  assert.match(text, /every pull request/i,
    'the delivery claim no longer says it runs on every pull request, which is the whole difference');
  assert.match(text, /not ours alone|exists as a command/i,
    'the paragraph no longer concedes that the technique exists elsewhere. The concession ' +
    'is what makes the rest of it credible, and it is the first thing an editor will cut.');
});
