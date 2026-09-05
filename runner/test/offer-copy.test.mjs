// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// The published offer, asserted as a structure rather than trusted as a habit.
//
// WHY THIS FILE EXISTS. Twice now the offer copy has said something the licence
// contradicts. On 2026-08-30 the wording "free forever on one public repository per
// organisation, $149/repository/month beyond that" applied the App's price to the
// Action — which BUSL-1.1's Additional Use Grant makes false, because a client may run
// the Action in their own CI against their own code, public or private, in production,
// at no charge. app/OPERATIONS.md carries that correction in its own words and ends it
// with "Do not quote the per-repository price for the Action." That sentence is a
// comment, and a comment is not a constraint. This file is.
//
// The second failure was quieter and is what this file was written for: the free grant
// was true, published and correct, and it sat in prose three-quarters of the way down
// the page under a heading about licensing, while the offer table near the bottom
// showed two prices and no free row at all. A reader who skims the table — which is
// what a table is for — saw $1,000 and $149/repository/month and no free option, and
// the honest answer to "I'll just run the free CLI" is that ours already is one.
//
// So these tests hold two properties that no other check in this repository holds:
// the free row exists and is first, and the free claim reaches the reader BEFORE the
// first price does. Prominence is the property; a document can be entirely truthful and
// still fail it.
//
// Run: node --test runner/test/offer-copy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

// The offer table is the one under this heading. Scoped deliberately: a rule that
// scanned the whole document for "$149" would also read the licence prose and the
// correction note in OPERATIONS.md, and would then have to be loosened with exceptions
// until it matched nothing. This reads the table itself.
function offerTable() {
  const heading = README.indexOf('## If you would rather we ran it');
  assert.notEqual(heading, -1, 'the offer section heading is gone');
  const after = README.slice(heading);
  return after
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .filter((l) => !/^\|[\s|-]*\|$/.test(l)) // drop the header separator and the empty header
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
}

test('the offer table carries exactly three rows and the free one is first', () => {
  const rows = offerTable();
  assert.equal(rows.length, 3,
    `expected three offer rows, found ${rows.length}. This is exact in BOTH directions on ` +
    'purpose: a new paid row should be a deliberate edit here, and a deleted free row must ' +
    'not be able to leave quietly.');

  const [free, report, app] = rows;
  assert.match(free[1], /\bfree\b/i, 'the first offer row must be the free one');
  assert.match(free[0], /own CI/i, 'the free row must say where the reader runs it');
  assert.match(report[1], /\$1,000/, 'the First Report row lost its price');
  assert.match(app[1], /\$149/, 'the App row lost its price');
});

test('the per-repository price is attached to the App and to nothing else', () => {
  // The exact defect of 2026-08-30: the Action priced per repository. The licence grant
  // makes that false, not merely unattractive.
  for (const row of offerTable()) {
    if (!row[1].includes('$149')) continue;
    assert.match(row[0], /\*\*The App\*\*/,
      `the per-repository price appears on a row that is not the App: ${row[0]}`);
  }
  const actionRow = offerTable().find((r) => /\*\*The Action/.test(r[0]));
  assert.ok(actionRow, 'the Action is no longer on the offer table');
  assert.doesNotMatch(actionRow[1], /\$/,
    'the Action carries a price. BUSL-1.1\'s Additional Use Grant says it does not.');
});

test('the free claim is not qualified into a trial', () => {
  const [free] = offerTable();
  // NARROWED DELIBERATELY, and this is the whole of the judgement in the file. The first
  // version of this test failed the row for saying "free, and not a trial" — it read a
  // DENIAL as the thing denied. A rule that flags a sentence for preempting the reader's
  // doubt teaches people to delete the reassurance, which is the same mistake as flagging
  // a disclaimer. Any "not a <word>" is stripped before the scan; a bare qualifier is not.
  const row = free.join(' ').toLowerCase().replace(/\bnot an? [a-z-]+/g, '');
  for (const weasel of ['trial', 'beta', 'for now', 'limited time', 'introductory', 'up to']) {
    assert.ok(!row.includes(weasel),
      `the free row says "${weasel}". The grant is a term of the published licence, ` +
      'not an offer we can withdraw, and wording it as one is untrue in our favour.');
  }
});

test('the reader meets the free grant before the first price', () => {
  // This is the assertion the document already failed while every sentence in it was
  // true. Position, not presence.
  const freeLede = README.search(/\*\*Running it yourself is free[^*]*\*\*/);
  assert.notEqual(freeLede, -1,
    'the lede that says running it yourself is free is gone from the top of the page');
  const firstPrice = README.indexOf('$');
  assert.notEqual(firstPrice, -1, 'no price on the page at all — check this test, not the page');
  assert.ok(freeLede < firstPrice,
    `the first price appears at character ${firstPrice}, before the free lede at ${freeLede}. ` +
    'A reader who stops halfway down is told only what it costs.');
});

test('the free lede names both kinds of repository, which is where the old wording went wrong', () => {
  // "free forever on one public repository per organisation" was the retired sentence.
  // It was wrong because the grant is not limited to public repositories and not
  // limited to one. Saying "public and private alike" is what stops it coming back.
  const lede = README.match(/\*\*Running it yourself is free[^*]*\*\*/);
  assert.ok(lede, 'the free lede is gone');
  assert.match(lede[0], /public and private/i,
    'the free lede must say the grant covers private repositories too — the retired ' +
    'wording restricted it to one public repository per organisation, and that was the error.');
});

test('the licence section still states the grant the offer table points at', () => {
  // The table calls the free row "the Additional Use Grant in the licence". If the
  // licence section stops saying it, the table is citing a document that no longer
  // agrees with it — the same failure as a compliance page citing a 404.
  const licence = README.slice(README.indexOf('## Licence'));
  assert.match(licence, /Additional Use Grant/,
    'the licence section no longer names the Additional Use Grant the offer table cites');
  assert.match(licence, /at no charge/,
    'the licence section no longer says the grant is at no charge');
});
