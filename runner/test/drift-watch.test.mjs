// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// drift-watch — what it must notice, and what it must refuse to say.
//
// Every fixture under fixtures/drift-watch/ is a REAL response captured from Sui mainnet's
// GraphQL endpoint (`https://graphql.mainnet.sui.io/graphql`, chain
// 4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S) on 2026-09-05: a real published package
// with its real bytecode, a real 0x2::package::UpgradeCap with its real owner and policy,
// the real 22-module MoveStdlib package in one page and again in three, a real GraphQL
// error envelope, and the real answer for an address that holds nothing. Nothing here is
// invented chain data. Drifted states are produced by taking one of those readings and
// moving a named field, which is the only way to write a before-and-after when the "after"
// has not happened.
//
// These tests never open a socket. That is deliberate: mainnet is a live third party, and a
// gate that goes red because a public endpoint had a bad minute teaches the reader to press
// the button again — the exact habit this product exists to break.
//
// THE RULE UNDER MOST OF THIS FILE: `drift` is an accusation about somebody's live
// deployment. Every path that could not read the chain must answer `unmeasured` instead,
// and several tests below exist only to hold that line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SNAPSHOT_SCHEMA, UPGRADE_CAP_TYPE, policyName, normaliseAddress,
  parsePackage, parseUpgradeCap, buildSnapshot, validateSnapshot,
  compareSnapshots, observePackage, observeUpgradeCap,
} from '../lib/drift-watch.mjs';
import { cmdCheck, cmdSnapshot, observe } from '../drift-watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'drift-watch');
const fixture = (name) => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

const MAINNET = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

// A request function that answers from fixtures and never touches a network. It dispatches
// on the query text, because that is what the real transport is handed.
function fixtureRequest(pages, capResponse) {
  let page = 0;
  return async function request(query) {
    if (query.includes('UpgradeCap(')) {
      if (!capResponse) throw new Error('this test did not stage an UpgradeCap response');
      return capResponse;
    }
    const response = pages[Math.min(page, pages.length - 1)];
    page += 1;
    return response;
  };
}

// Captures what a command wrote so an exit code can be asserted without a wall of output.
async function quietly(fn) {
  const out = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { out.push(String(s)); return true; };
  try {
    const code = await fn();
    return { code, text: out.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

// A recorded snapshot of the real single-module mainnet package, with the real UpgradeCap
// that actually governs it. Both readings are of the same real pair: the cap's `package`
// field is that package's address.
function recordedPair() {
  const pkg = parsePackage(fixture('package'));
  assert.equal(pkg.ok, true, pkg.reason);
  const cap = parseUpgradeCap(fixture('upgrade-cap'));
  assert.equal(cap.ok, true, cap.reason);
  return buildSnapshot({
    chain: pkg.value.chain,
    pkg: pkg.value,
    upgradeCap: cap.value,
    observedAt: '2026-09-05T00:00:00.000Z',
    endpoint: 'https://graphql.mainnet.sui.io/graphql',
  });
}

// --- reading a real package ------------------------------------------------------------

test('a real mainnet package parses into named module digests, a version and sorted linkage', () => {
  const parsed = parsePackage(fixture('package'));
  assert.equal(parsed.ok, true, parsed.reason);
  const p = parsed.value;
  assert.equal(p.chain, MAINNET);
  assert.equal(p.address, '0x743646865d4a67ec6e6826cf1ffccf653f1afe8a986f5c1386b509f3c017dbc1');
  assert.equal(p.version, 1);
  assert.equal(p.moduleCount, 1);
  assert.deepEqual(Object.keys(p.modules), ['blub']);
  assert.match(p.modules.blub, /^[0-9a-f]{64}$/);
  assert.equal(p.linkage.length, 2);
  // Sorted, so that a reordered response is not reported as drift.
  assert.ok(p.linkage[0].originalId < p.linkage[1].originalId);
});

test('the module digest is over the bytecode, so identical bytes give an identical digest', () => {
  const a = parsePackage(fixture('package'));
  const b = parsePackage(fixture('package'));
  assert.deepEqual(a.value.modules, b.value.modules);
  // And a byte that moves moves it. Flipping one character of the real base64 is the
  // smallest change that can be made to real bytecode.
  const mutated = clone(fixture('package'));
  const node = mutated.data.object.asMovePackage.modules.nodes[0];
  node.bytes = `${node.bytes.slice(0, -8)}AAAAAAA=`;
  const c = parsePackage(mutated);
  assert.equal(c.ok, true, c.reason);
  assert.notEqual(c.value.modules.blub, a.value.modules.blub);
});

test('a half-read module list is refused rather than reported on', () => {
  // The raw first page of the real 22-module MoveStdlib read: it still says hasNextPage.
  // Accepting it would let a package report `match` on the strength of its first 8 modules.
  const parsed = parsePackage(fixture('stdlib-page-1'));
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /incomplete|hasNextPage/i);
});

test('an address that holds nothing is unreadable, not empty', () => {
  const parsed = parsePackage(fixture('package-absent'));
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /no object exists at that address/);
});

test('a GraphQL error envelope is a failure to read, and it carries the endpoint message', () => {
  // The endpoint answers HTTP 200 with an `errors` array. A caller that only checked the
  // status would read this as a package with no modules.
  const parsed = parsePackage(fixture('graphql-errors'));
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /GraphQL errors/);
  assert.match(parsed.reason, /notAField/);
});

test('a response with no chainIdentifier is refused, because a comparison needs to know the network', () => {
  const noChain = clone(fixture('package'));
  delete noChain.data.chainIdentifier;
  assert.equal(parsePackage(noChain).ok, false);
});

test('an object that is not a Move package is named as such', () => {
  const notAPackage = clone(fixture('package'));
  notAPackage.data.object.asMovePackage = null;
  const parsed = parsePackage(notAPackage);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /not a Move package/);
});

test('a package reporting zero modules is refused, because no published package has none', () => {
  // The dangerous shape: an empty module map compares equal to another empty module map, so
  // a reading that lost its modules would report `match` for ever. Found by mutation.
  const empty = clone(fixture('package'));
  empty.data.object.asMovePackage.modules.nodes = [];
  const parsed = parsePackage(empty);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /zero modules/);
});

test('a module repeated in the response is refused rather than silently collapsed', () => {
  const doubled = clone(fixture('package'));
  const nodes = doubled.data.object.asMovePackage.modules.nodes;
  nodes.push(clone(nodes[0]));
  const parsed = parsePackage(doubled);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /appears twice/);
});

// --- pagination, cross-checked against the same real package read whole ------------------

test('three real pages assemble into exactly the same package as one real page', async () => {
  // MoveStdlib (0x1), 22 modules, fetched from mainnet twice: once with first:50 (one page)
  // and once with first:8 (8, 8, 6). If the assembler drops, duplicates or reorders a
  // module, these two disagree.
  const whole = parsePackage(fixture('stdlib-single-page'));
  assert.equal(whole.ok, true, whole.reason);
  assert.equal(whole.value.moduleCount, 22);

  const paged = await observePackage(
    fixtureRequest([fixture('stdlib-page-1'), fixture('stdlib-page-2'), fixture('stdlib-page-3')]),
    '0x1',
  );
  assert.equal(paged.ok, true, paged.reason);
  assert.equal(paged.value.moduleCount, 22);
  assert.deepEqual(paged.value.modules, whole.value.modules);
  assert.deepEqual(paged.value.linkage, whole.value.linkage);
  assert.equal(paged.value.version, whole.value.version);
});

test('a cursor that repeats is refused instead of looped on', async () => {
  const page1 = fixture('stdlib-page-1');
  const again = clone(page1); // same endCursor, still hasNextPage
  const result = await observePackage(fixtureRequest([page1, again, again]), '0x1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /repeated module cursor|not advancing/);
});

test('another page promised with no cursor to reach it is a failure to read', async () => {
  const truncated = clone(fixture('stdlib-page-1'));
  truncated.data.object.asMovePackage.modules.pageInfo.endCursor = null;
  const result = await observePackage(fixtureRequest([truncated]), '0x1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /no cursor/);
});

test('a transport that throws is a failure to read and never a verdict', async () => {
  const exploding = async () => { throw new Error('socket hang up'); };
  const result = await observePackage(exploding, '0x1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be read/);
  assert.match(result.reason, /socket hang up/);
});

test('an address that is not hex never reaches the query', async () => {
  let called = false;
  const spy = async () => { called = true; return {}; };
  for (const bad of ['', 'notanaddress', '0x', '0xzz', `0x${'a'.repeat(65)}`, '0x2; drop']) {
    const result = await observePackage(spy, bad);
    assert.equal(result.ok, false, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(called, false, 'a rejected address must not be sent to the endpoint');
});

test('short addresses are padded to the 64-digit form the chain returns', () => {
  assert.equal(normaliseAddress('0x2').value, `0x${'0'.repeat(63)}2`);
  assert.equal(normaliseAddress('0xAB').value, `0x${'0'.repeat(62)}ab`);
});

// --- reading a real UpgradeCap ------------------------------------------------------------

test('a real UpgradeCap parses into its package, version, policy and owner', () => {
  const parsed = parseUpgradeCap(fixture('upgrade-cap'));
  assert.equal(parsed.ok, true, parsed.reason);
  const c = parsed.value;
  assert.equal(c.present, true);
  assert.equal(c.package, '0x743646865d4a67ec6e6826cf1ffccf653f1afe8a986f5c1386b509f3c017dbc1');
  assert.equal(c.version, '1');
  assert.equal(c.policy, 0);
  assert.equal(c.policyName, 'compatible');
  assert.equal(c.owner.kind, 'AddressOwner');
  assert.equal(c.owner.address, '0xd09052d5d59822b8e3e61c794f0c5998af6d0b2edb69b375663589ce340a324b');
  assert.equal(c.upgradeInFlight, false);
});

test('policy numbers are named, and an unrecognised one is not quietly called compatible', () => {
  assert.equal(policyName(0), 'compatible');
  assert.equal(policyName(128), 'additive');
  assert.equal(policyName(192), 'dep-only');
  assert.match(policyName(7), /unrecognised\(7\)/);
});

test('watching an object that is not an UpgradeCap is refused, not assumed', () => {
  // A gate pointed at the wrong object would be permanently green, which is worse than no
  // gate at all.
  const wrongType = clone(fixture('upgrade-cap'));
  wrongType.data.object.asMoveObject.contents.type.repr = '0x2::coin::Coin<0x2::sui::SUI>';
  const parsed = parseUpgradeCap(wrongType);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /not 0x0*2::package::UpgradeCap/);
  assert.ok(UPGRADE_CAP_TYPE.endsWith('::package::UpgradeCap'));
});

test('an UpgradeCap that no longer exists reads as absent-with-a-reason, not as an error', async () => {
  // make_immutable DELETES the cap. That is a real, meaningful, usually good state, and it
  // must survive as a fact rather than being thrown away as a read failure.
  const gone = { data: { chainIdentifier: MAINNET, object: null } };
  const parsed = parseUpgradeCap(gone);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.present, false);
  assert.match(parsed.value.reason, /make_immutable/);
  const viaObserve = await observeUpgradeCap(fixtureRequest([], gone), '0x1');
  assert.equal(viaObserve.value.present, false);
});

test('a cap caught between authorize_upgrade and commit_upgrade is flagged in flight', () => {
  const inFlight = clone(fixture('upgrade-cap'));
  inFlight.data.object.asMoveObject.contents.json.package = `0x${'0'.repeat(64)}`;
  const parsed = parseUpgradeCap(inFlight);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.value.upgradeInFlight, true);
});

// --- the snapshot ---------------------------------------------------------------------

test('a snapshot never claims a source verification it did not perform', () => {
  const snap = recordedPair();
  assert.equal(snap.schema, SNAPSHOT_SCHEMA);
  // The rule the evidence bundle already follows: unmeasured is null with a reason beside
  // it, never a value that reads as a result.
  assert.equal(snap.sourceVerification, null);
  assert.match(snap.sourceVerificationReason, /verify-source/);
});

test('an UpgradeCap that was never watched is null with a reason, not a silent absence', () => {
  const pkg = parsePackage(fixture('package'));
  const snap = buildSnapshot({ chain: pkg.value.chain, pkg: pkg.value, observedAt: 'x', endpoint: 'y' });
  assert.equal(snap.upgradeCap, null);
  assert.match(snap.upgradeCapReason, /not requested/);
  // And when one IS recorded, the reason field is null rather than stale prose.
  assert.equal(recordedPair().upgradeCapReason, null);
});

test('a snapshot from a future schema is refused rather than half-understood', () => {
  const snap = recordedPair();
  snap.schema = 'protocolx-verify/drift-watch/9';
  const valid = validateSnapshot(snap);
  assert.equal(valid.ok, false);
  assert.match(valid.reason, /schema/);
});

// --- the comparison ---------------------------------------------------------------------

test('a package that has not moved is a match, with no findings', () => {
  const result = compareSnapshots(recordedPair(), recordedPair());
  assert.equal(result.verdict, 'match');
  assert.deepEqual(result.findings, []);
});

test('an upgrade is drift, and it is named as the bytecode no longer being the verified bytecode', () => {
  const observed = recordedPair();
  observed.package.version = 2;
  observed.package.modules.blub = 'b'.repeat(64);
  const result = compareSnapshots(recordedPair(), observed);
  assert.equal(result.verdict, 'drift');
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes('package-upgraded'), codes.join(','));
  assert.ok(codes.includes('module-changed'), codes.join(','));
  const upgraded = result.findings.find((f) => f.code === 'package-upgraded');
  assert.match(upgraded.detail, /replaced since it was verified/);
});

test('a module added or removed is drift on its own', () => {
  const added = recordedPair();
  added.package.modules.newthing = 'c'.repeat(64);
  added.package.moduleCount = 2;
  assert.ok(compareSnapshots(recordedPair(), added).findings.some((f) => f.code === 'module-added'));

  const removed = recordedPair();
  removed.package.modules = { onlyother: 'd'.repeat(64) };
  const codes = compareSnapshots(recordedPair(), removed).findings.map((f) => f.code);
  assert.ok(codes.includes('module-removed'), codes.join(','));
  assert.ok(codes.includes('module-added'), codes.join(','));
});

test('the same bytecode linked against a moved dependency is still drift', () => {
  // The package's own modules are byte-identical; what changed is which version of a
  // dependency it executes against. A comparison that only hashed modules would call this
  // a match.
  const observed = recordedPair();
  observed.package.linkage[1].version += 1;
  const result = compareSnapshots(recordedPair(), observed);
  assert.equal(result.verdict, 'drift');
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes('linkage-removed-or-moved'), codes.join(','));
  assert.ok(codes.includes('linkage-added-or-moved'), codes.join(','));
});

test('linkage returned in a different order is not drift', () => {
  // The reversal is applied to the RAW response and both sides then go through parsePackage,
  // which is where the sort lives. An earlier version of this test sorted the observed side
  // itself before comparing, which meant deleting the sort from the parser did not fail it —
  // the test was checking its own arithmetic rather than the code. Found by mutation.
  const reordered = clone(fixture('package'));
  reordered.data.object.asMovePackage.linkage.reverse();
  const observedPkg = parsePackage(reordered);
  assert.equal(observedPkg.ok, true, observedPkg.reason);

  const observed = buildSnapshot({
    chain: observedPkg.value.chain,
    pkg: observedPkg.value,
    upgradeCap: parseUpgradeCap(fixture('upgrade-cap')).value,
    observedAt: '2026-09-05T01:00:00.000Z',
    endpoint: 'x',
  });
  assert.equal(compareSnapshots(recordedPair(), observed).verdict, 'match');

  // And the stronger property, which is what the sort in parsePackage is actually for. The
  // verdict alone does not need it — the comparison is set-based and would survive its
  // removal, which is how mutation testing found this line was doing nothing a test knew
  // about. What it IS for is the snapshot FILE: a committed drift-watch.json must not churn
  // in `git diff` because an endpoint returned the same linkage in a different order.
  assert.deepEqual(observed.package.linkage, recordedPair().package.linkage);
});

test('the object digest moving at an unchanged version is reported', () => {
  const observed = recordedPair();
  observed.package.objectDigest = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const codes = compareSnapshots(recordedPair(), observed).findings.map((f) => f.code);
  assert.ok(codes.includes('package-object-digest-changed'), codes.join(','));
});

// --- the authority half -------------------------------------------------------------------

test('byte-identical bytecode whose upgrade authority moved is drift', () => {
  // Nothing about the code changed. Somebody else can now replace it.
  const observed = recordedPair();
  observed.upgradeCap.owner = { kind: 'AddressOwner', address: `0x${'9'.repeat(64)}` };
  const result = compareSnapshots(recordedPair(), observed);
  assert.equal(result.verdict, 'drift');
  const finding = result.findings.find((f) => f.code === 'upgrade-cap-owner-changed');
  assert.ok(finding, result.findings.map((f) => f.code).join(','));
  assert.match(finding.detail, /authority to upgrade/);
});

test('a tightened policy and a loosened one are different findings', () => {
  const tightened = recordedPair();
  tightened.upgradeCap.policy = 192;
  tightened.upgradeCap.policyName = 'dep-only';
  const up = compareSnapshots(recordedPair(), tightened).findings.map((f) => f.code);
  assert.ok(up.includes('upgrade-cap-policy-tightened'), up.join(','));

  // sui::package can only raise a policy. A reading that shows one going down did not come
  // from that interface, and the wording has to say so rather than shrug.
  const recorded = recordedPair();
  recorded.upgradeCap.policy = 192;
  recorded.upgradeCap.policyName = 'dep-only';
  const loosened = compareSnapshots(recorded, recordedPair());
  const finding = loosened.findings.find((f) => f.code === 'upgrade-cap-policy-loosened');
  assert.ok(finding, loosened.findings.map((f) => f.code).join(','));
  assert.match(finding.detail, /no call that lowers a policy/);
});

test('the cap version advancing is reported as a committed upgrade', () => {
  const observed = recordedPair();
  observed.upgradeCap.version = '2';
  const codes = compareSnapshots(recordedPair(), observed).findings.map((f) => f.code);
  assert.ok(codes.includes('upgrade-cap-version-advanced'), codes.join(','));
});

test('a cap made immutable is reported as a change and explained as a freeze, not an alarm', () => {
  const observed = recordedPair();
  observed.upgradeCap = { chain: MAINNET, address: recordedPair().upgradeCap.address, present: false, reason: 'gone' };
  const result = compareSnapshots(recordedPair(), observed);
  assert.equal(result.verdict, 'drift');
  const finding = result.findings.find((f) => f.code === 'upgrade-cap-gone');
  assert.ok(finding);
  assert.match(finding.detail, /deliberately frozen|make_immutable/);
});

test('a snapshot with a cap checked against a run without one says the authority went unchecked', () => {
  const observed = recordedPair();
  observed.upgradeCap = null;
  const codes = compareSnapshots(recordedPair(), observed).findings.map((f) => f.code);
  assert.ok(codes.includes('upgrade-cap-not-read'), codes.join(','));
});

// --- the line between "it moved" and "we could not look" ------------------------------------

test('two different chains are unmeasured, never drift', () => {
  const observed = recordedPair();
  observed.chain = 'someOtherChainIdentifier';
  const result = compareSnapshots(recordedPair(), observed);
  assert.equal(result.verdict, 'unmeasured');
  assert.equal(result.findings.length, 0);
  assert.match(result.reason, /chain/);
});

test('a mid-upgrade cap is unmeasured, because the chain is not in a settled state', () => {
  const observed = recordedPair();
  observed.upgradeCap.upgradeInFlight = true;
  observed.package.version = 2;
  const result = compareSnapshots(recordedPair(), observed);
  assert.equal(result.verdict, 'unmeasured');
  assert.match(result.reason, /mid-upgrade|commit_upgrade/);
});

test('a malformed snapshot on either side is unmeasured, never drift', () => {
  const good = recordedPair();
  const noModules = clone(good);
  noModules.package.modules = {};
  const noLinkage = clone(good);
  delete noLinkage.package.linkage;
  const noVersion = clone(good);
  noVersion.package.version = '1'; // a string, not an integer
  const noChain = clone(good);
  delete noChain.chain;
  // The empty-module case is the one that matters most and the one a first pass misses:
  // two empty module maps compare equal, so a snapshot that lost its modules would report
  // `match` for ever rather than refusing to answer. Found by mutation.
  for (const bad of [
    null, {}, { schema: SNAPSHOT_SCHEMA }, { ...clone(good), package: null },
    noModules, noLinkage, noVersion, noChain,
  ]) {
    assert.equal(compareSnapshots(bad, good).verdict, 'unmeasured', `recorded: ${JSON.stringify(bad).slice(0, 60)}`);
    assert.equal(compareSnapshots(good, bad).verdict, 'unmeasured', `observed: ${JSON.stringify(bad).slice(0, 60)}`);
  }
});

test('a package and an UpgradeCap read from different chains is unmeasured, not a snapshot', async () => {
  // Two endpoints, or one endpoint that moved, would otherwise produce a snapshot whose two
  // halves describe different networks — and it would then compare cleanly against itself
  // for ever. Found by mutation.
  const capElsewhere = clone(fixture('upgrade-cap'));
  capElsewhere.data.chainIdentifier = 'someOtherChainIdentifier';
  const result = await observe(fixtureRequest([fixture('package')], capElsewhere), '0x2', '0x3');
  assert.equal(result.ok, false);
  assert.match(result.reason, /different chains/);
});

// --- the command, and its exit codes ---------------------------------------------------------

test('check exits 0 on a match, 1 on drift and 2 when the chain could not be read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-watch-'));
  const snapPath = join(dir, 'snapshot.json');

  // Record from the real fixtures, exactly as `snapshot` would.
  const recorded = await quietly(() => cmdSnapshot(
    { package: '0x743646865d4a67ec6e6826cf1ffccf653f1afe8a986f5c1386b509f3c017dbc1',
      'upgrade-cap': '0x00002291352bf71d0522e82f7b5be95f6d351005fe4104d5debacf90b01acb1c',
      out: snapPath },
    fixtureRequest([fixture('package')], fixture('upgrade-cap')),
  ));
  assert.equal(recorded.code, 0, recorded.text);

  // The chain still holds it.
  const match = await quietly(() => cmdCheck(
    { snapshot: snapPath }, fixtureRequest([fixture('package')], fixture('upgrade-cap')),
  ));
  assert.equal(match.code, 0, match.text);
  assert.match(match.text, /MATCH/);

  // The package was upgraded under it.
  const upgraded = clone(fixture('package'));
  upgraded.data.object.version = 2;
  upgraded.data.object.asMovePackage.version = 2;
  const drift = await quietly(() => cmdCheck(
    { snapshot: snapPath }, fixtureRequest([upgraded], fixture('upgrade-cap')),
  ));
  assert.equal(drift.code, 1, drift.text);
  assert.match(drift.text, /DRIFT/);
  assert.match(drift.text, /package-upgraded/);
  assert.match(drift.text, /verify-source/); // it must say what to do next

  // The endpoint fell over. This must NOT be reported as drift.
  const broken = await quietly(() => cmdCheck(
    { snapshot: snapPath }, async () => { throw new Error('ETIMEDOUT'); },
  ));
  assert.equal(broken.code, 2, broken.text);
  assert.match(broken.text, /UNMEASURED/);
  assert.doesNotMatch(broken.text, /DRIFT/);
  assert.match(broken.text, /NOT a drift verdict/);
});

test('check reads its target from the snapshot, so the gate cannot be aimed elsewhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-watch-'));
  const snapPath = join(dir, 'snapshot.json');
  writeFileSync(snapPath, JSON.stringify(recordedPair()));

  const asked = [];
  const request = async (query, variables) => {
    asked.push(variables.address);
    return query.includes('UpgradeCap(') ? fixture('upgrade-cap') : fixture('package');
  };
  // A --package argument is offered and must be ignored.
  const result = await quietly(() => cmdCheck({ snapshot: snapPath, package: '0x1' }, request));
  assert.equal(result.code, 0, result.text);
  assert.ok(asked.includes('0x743646865d4a67ec6e6826cf1ffccf653f1afe8a986f5c1386b509f3c017dbc1'));
  assert.ok(!asked.includes(`0x${'0'.repeat(63)}1`), `asked: ${asked.join(',')}`);
});

test('check refuses a snapshot file it cannot read or does not understand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-watch-'));
  const missing = await quietly(() => cmdCheck({ snapshot: join(dir, 'nope.json') }, fixtureRequest([])));
  assert.equal(missing.code, 2);

  const junkPath = join(dir, 'junk.json');
  writeFileSync(junkPath, '{"schema":"something-else"}');
  const junk = await quietly(() => cmdCheck({ snapshot: junkPath }, fixtureRequest([])));
  assert.equal(junk.code, 2);
  assert.doesNotMatch(junk.text, /DRIFT/);
});

test('snapshot refuses to write a file when the chain could not be read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drift-watch-'));
  const out = join(dir, 'should-not-exist.json');
  const result = await quietly(() => cmdSnapshot(
    { package: '0x1', out }, async () => fixture('graphql-errors'),
  ));
  assert.equal(result.code, 2, result.text);
  assert.throws(() => readFileSync(out), /ENOENT/);
});
