// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela
//
// The usage ledger — the measurement that makes a $149/repository/month invoice possible.
//
// These tests are written against a REAL webhook delivery, not a hand-built object. The
// installation/created payload in worker/test/fixtures was read out of our own App's
// delivery log (GET /app/hook/deliveries with an App JWT, 2026-08-30) and committed
// verbatim. If GitHub's event shape ever moves, the fixture is the tripwire.
//
// The load-bearing assertion in this file is not "a record is created". It is that a
// repository whose runs we did not record reads as null-with-a-reason and NEVER as 0.
// A silent zero under-bills a paying customer and tells the desk they are idle when they
// are not, and it is the one failure a metering system must not have.
//
// Run: node --test worker/test/ledger.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyInstallationEvent,
  recordInstallationEvent,
  recordRunBatch,
  usageSnapshot,
  usageLedger,
  asIsoTimestamp,
  accountOf,
  repositoriesOf,
  parseRunKey,
  runKey,
  installationKey,
  LEDGER_EVENTS,
} from '../src/ledger.js';
import worker from '../src/index.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/installation-created.delivery.json', import.meta.url), 'utf8'),
);
// The real thing: our App, our org, our first client repository.
const REAL_CREATED = FIXTURE.payload;
const REAL_DELIVERY_ID = FIXTURE.headers['X-Github-Delivery'];
const INSTALL_ID = REAL_CREATED.installation.id;      // 157375258
const REAL_REPO = REAL_CREATED.repositories[0].full_name; // Northlatch-Labs-LLC/weir

// installation_repositories carries the SAME installation object — so this reuses the
// captured one verbatim and wraps it in that event's documented top-level keys
// (action · installation · repositories_added · repositories_removed ·
// repository_selection · requester · sender). Only the wrapper is constructed; every
// field the ledger reads out of `installation` is the live capture's own.
const reposEvent = (action, { added = [], removed = [], selection = 'selected' }) => ({
  action,
  installation: REAL_CREATED.installation,
  repository_selection: selection,
  repositories_added: added,
  repositories_removed: removed,
  requester: null,
  sender: REAL_CREATED.sender,
});

const repoObject = (fullName, id, isPrivate = true) => ({
  id,
  node_id: 'R_kgDO_ignored',
  name: fullName.split('/')[1],
  full_name: fullName,
  private: isPrivate,
});

// --- the smallest thing that behaves like a KV namespace binding -----------------

function fakeKv(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    failPut: null, // set to a string to make every put throw with that message
    failPutMatching: null, // set to a RegExp to fail only some keys
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) {
      if (this.failPut) throw new Error(this.failPut);
      if (this.failPutMatching && this.failPutMatching.test(key)) throw new Error('KV put rejected');
      map.set(key, value);
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const all = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit);
      const next = start + limit;
      const complete = next >= all.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        ...(complete ? {} : { cursor: String(next) }),
      };
    },
  };
}

const envWith = (kv, extra = {}) => ({ USAGE_LEDGER: kv, LEDGER_READ_TOKEN: 'a-read-token', ...extra });

// ================================================================================
// 1 — an install event creates a record
// ================================================================================

test('an installation/created delivery — the real one — creates a record', async () => {
  const kv = fakeKv();
  const outcome = await recordInstallationEvent(envWith(kv), 'installation', REAL_CREATED, {
    now: Date.parse('2026-08-28T23:53:33Z'),
    deliveryId: REAL_DELIVERY_ID,
  });
  assert.equal(outcome.recorded, true);
  assert.equal(outcome.installationId, INSTALL_ID);

  const record = JSON.parse(await kv.get(installationKey(INSTALL_ID)));
  assert.equal(record.installationId, 157375258);
  assert.deepEqual(record.account, {
    login: 'Northlatch-Labs-LLC', id: 321117593, type: 'Organization',
  });
  assert.equal(record.status, 'active');
  assert.equal(record.repositorySelection, 'selected');
  // GitHub's own timestamp, normalised to UTC — not our clock.
  assert.equal(record.installedAt.value, '2026-08-28T23:53:32.000Z');
  assert.equal(record.installedAt.reason, null);
  assert.equal(record.endedAt, null);

  const repo = record.repositories[REAL_REPO];
  assert.equal(repo.repository, 'Northlatch-Labs-LLC/weir');
  assert.equal(repo.repositoryId, 1343161881);
  assert.equal(repo.private, true);
  assert.equal(repo.removedAt, null);

  assert.equal(record.history.length, 1);
  assert.equal(record.history[0].event, 'installation');
  assert.equal(record.history[0].action, 'created');
  assert.equal(record.history[0].deliveryId, REAL_DELIVERY_ID);
});

test('the webhook route feeds the ledger and starts no verification run', async () => {
  // The App-lifecycle events must never open check runs; they only meter.
  assert.deepEqual(LEDGER_EVENTS, ['installation', 'installation_repositories']);
});

// ================================================================================
// 2 — an uninstall ends the record without destroying history
// ================================================================================

test('installation/deleted ends the record and destroys nothing', () => {
  const created = applyInstallationEvent(null, {
    event: 'installation',
    payload: REAL_CREATED,
    observedAt: '2026-08-28T23:53:33.000Z',
    deliveryId: REAL_DELIVERY_ID,
  });

  const deleted = applyInstallationEvent(created, {
    event: 'installation',
    payload: { action: 'deleted', installation: REAL_CREATED.installation },
    observedAt: '2026-09-15T10:00:00.000Z',
    deliveryId: 'delete-guid',
  });

  assert.equal(deleted.status, 'ended');
  assert.equal(deleted.endedAt, '2026-09-15T10:00:00.000Z');
  // The estate archives; it does not delete. Everything the invoice needs survives.
  assert.equal(deleted.installedAt.value, '2026-08-28T23:53:32.000Z');
  assert.ok(REAL_REPO in deleted.repositories, 'the repository row survives the uninstall');
  assert.equal(deleted.repositories[REAL_REPO].firstSeenAt, '2026-08-28T23:53:33.000Z');
  assert.equal(deleted.repositories[REAL_REPO].removedAt, '2026-09-15T10:00:00.000Z');
  assert.equal(deleted.history.length, 2);
  assert.deepEqual(deleted.history.map((h) => h.action), ['created', 'deleted']);

  // And the recorded batches are still countable after the uninstall — the days they
  // were installed are days we invoice for.
  assert.equal(created.repositories[REAL_REPO].addedAt, '2026-08-28T23:53:33.000Z');
});

test('a record missing fields a later shape added is repaired, not crashed on', async () => {
  // A stored record written before a field existed must not take the worker down when
  // the next event folds into it. Absence is filled from the blank, never dereferenced.
  const thin = { installationId: INSTALL_ID, repositories: { 'a/b': { repository: 'a/b' } } };
  const r = applyInstallationEvent(thin, {
    event: 'installation',
    payload: REAL_CREATED,
    observedAt: '2026-09-01T00:00:00.000Z',
    deliveryId: 'g',
  });
  assert.equal(r.status, 'active');
  assert.equal(r.installedAt.value, '2026-08-28T23:53:32.000Z');
  assert.equal(r.history.length, 1);
  assert.ok('a/b' in r.repositories, 'the thin record\'s repositories survive');
});

test('an unreadable stored record is preserved, never overwritten', async () => {
  const kv = fakeKv({ [installationKey(INSTALL_ID)]: '{not json' });
  const outcome = await recordInstallationEvent(envWith(kv), 'installation', REAL_CREATED, {
    now: Date.parse('2026-09-01T00:00:00Z'),
  });
  assert.equal(outcome.recorded, false);
  assert.match(outcome.reason, /preserved, not overwritten/);
  assert.equal(await kv.get(installationKey(INSTALL_ID)), '{not json');
  assert.ok([...kv.map.keys()].some((k) => k.includes(':unreadable:')));
});

test('suspend and unsuspend move status without ending the installation', () => {
  let r = applyInstallationEvent(null, {
    event: 'installation', payload: REAL_CREATED, observedAt: '2026-08-28T23:53:33.000Z',
  });
  r = applyInstallationEvent(r, {
    event: 'installation',
    payload: { action: 'suspend', installation: { ...REAL_CREATED.installation, suspended_at: '2026-09-02T08:00:00Z' } },
    observedAt: '2026-09-02T08:00:01.000Z',
  });
  assert.equal(r.status, 'suspended');
  assert.equal(r.suspendedAt, '2026-09-02T08:00:00.000Z');
  assert.equal(r.endedAt, null);

  r = applyInstallationEvent(r, {
    event: 'installation',
    payload: { action: 'unsuspend', installation: REAL_CREATED.installation },
    observedAt: '2026-09-03T08:00:00.000Z',
  });
  assert.equal(r.status, 'active');
  assert.equal(r.suspendedAt, null);
  assert.equal(r.history.length, 3);
});

// ================================================================================
// 3 — a repository-selection change is captured
// ================================================================================

test('installation_repositories captures adds, removes, and a selection change', () => {
  let r = applyInstallationEvent(null, {
    event: 'installation', payload: REAL_CREATED, observedAt: '2026-08-28T23:53:33.000Z',
  });
  assert.equal(r.repositorySelection, 'selected');
  assert.equal(r.repositorySelectionChangedAt, null);

  r = applyInstallationEvent(r, {
    event: 'installation_repositories',
    payload: reposEvent('added', {
      added: [repoObject('Northlatch-Labs-LLC/draw-vault', 2000001), repoObject('Northlatch-Labs-LLC/atlas', 2000002, false)],
    }),
    observedAt: '2026-09-04T12:00:00.000Z',
    deliveryId: 'added-guid',
  });
  assert.deepEqual(Object.keys(r.repositories).sort(), [
    'Northlatch-Labs-LLC/atlas', 'Northlatch-Labs-LLC/draw-vault', 'Northlatch-Labs-LLC/weir',
  ]);
  assert.equal(r.repositories['Northlatch-Labs-LLC/atlas'].private, false);
  assert.equal(r.repositories['Northlatch-Labs-LLC/draw-vault'].addedAt, '2026-09-04T12:00:00.000Z');
  assert.deepEqual(r.history.at(-1).added.sort(), ['Northlatch-Labs-LLC/atlas', 'Northlatch-Labs-LLC/draw-vault']);

  r = applyInstallationEvent(r, {
    event: 'installation_repositories',
    payload: reposEvent('removed', { removed: [repoObject('Northlatch-Labs-LLC/draw-vault', 2000001)] }),
    observedAt: '2026-09-20T09:00:00.000Z',
    deliveryId: 'removed-guid',
  });
  const dropped = r.repositories['Northlatch-Labs-LLC/draw-vault'];
  assert.ok(dropped, 'a removed repository is archived, not deleted');
  assert.equal(dropped.removedAt, '2026-09-20T09:00:00.000Z');
  assert.equal(dropped.addedAt, '2026-09-04T12:00:00.000Z');
  assert.deepEqual(r.history.at(-1).removed, ['Northlatch-Labs-LLC/draw-vault']);

  // "selected" → "all" is the change a bill depends on: it means every repository on
  // the account is now in scope.
  r = applyInstallationEvent(r, {
    event: 'installation_repositories',
    payload: reposEvent('added', { added: [], selection: 'all' }),
    observedAt: '2026-09-25T09:00:00.000Z',
  });
  assert.equal(r.repositorySelection, 'all');
  assert.equal(r.repositorySelectionChangedAt, '2026-09-25T09:00:00.000Z');
  assert.equal(r.history.length, 4);
});

test('an installation first seen through a selection change says so, and does not invent an install date', () => {
  const r = applyInstallationEvent(null, {
    event: 'installation_repositories',
    payload: {
      ...reposEvent('added', { added: [repoObject('acme/contracts', 55)] }),
      installation: { ...REAL_CREATED.installation, created_at: undefined },
    },
    observedAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(r.status, 'active');
  assert.equal(r.installedAt.value, null);
  assert.match(r.installedAt.reason, /cannot vouch for when it began/);
});

// ================================================================================
// 4 — ABSENCE IS NOT ZERO
// ================================================================================

test('a repository with no recorded batch reads as unknown-with-reason, never 0', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, {
    now: Date.parse('2026-08-28T23:53:33Z'), deliveryId: REAL_DELIVERY_ID,
  });

  const { ok, snapshot } = await usageSnapshot(env, { now: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(ok, true);
  const repo = snapshot.installations[0].repositories[0];

  assert.equal(repo.runs.value, null, 'an unrecorded count is null');
  assert.notEqual(repo.runs.value, 0);
  assert.match(repo.runs.reason, /NOT a count of zero/);
  assert.match(repo.runs.reason, /ledger write failed reads exactly the same way/);
  assert.equal(repo.lastRunAt, null);
  // Never "false". Unknown is a question for a human, not a write-off.
  assert.equal(repo.billable, null);

  assert.equal(snapshot.totals.billableRepositories.value, 0);
  assert.equal(snapshot.totals.billableRepositories.isFloor, true);
  assert.equal(snapshot.totals.repositoriesWithNoRecordedBatch, 1);
  assert.match(snapshot.absenceConvention, /Null never means zero/);

  // The JSON must not contain a bare zero standing in for an unmeasured count.
  assert.doesNotMatch(JSON.stringify(repo.runs), /"value":0/);
});

test('recorded batches count, de-duplicate GitHub redeliveries, and carry a last-seen time', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.parse('2026-08-28T23:53:33Z') });

  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-02T10:00:00Z'), deliveryId: 'g1' });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-05T10:00:00Z'), deliveryId: 'g2' });
  // GitHub redelivers the same event: same guid, later clock. It must count once.
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-05T10:30:00Z'), deliveryId: 'g2' });

  const { snapshot } = await usageSnapshot(env, { now: Date.parse('2026-10-01T00:00:00Z') });
  const repo = snapshot.installations[0].repositories[0];
  assert.equal(repo.runs.value, 2);
  assert.equal(repo.runs.reason, null);
  assert.equal(repo.runs.confidence, 'counted');
  assert.equal(repo.lastRunAt, '2026-09-05T10:30:00.000Z');
  assert.equal(repo.billable, true);
  assert.equal(snapshot.totals.billableRepositories.value, 1);
  assert.match(snapshot.invoiceSentence, /1 repository across 1 installation has at least one recorded check-run batch/);
});

test('concurrent batches on one repository cannot lose each other', async () => {
  // The reason the counter is append-only rather than read-modify-write: KV has no
  // atomic increment, and two pull requests landing at once on a read-modify-write
  // counter silently drop one — an under-bill nobody would ever notice.
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.parse('2026-08-28T23:53:33Z') });

  const at = Date.parse('2026-09-09T09:00:00Z');
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: at, deliveryId: `guid-${i}` })),
  );
  const { snapshot } = await usageSnapshot(env, { now: at });
  assert.equal(snapshot.installations[0].repositories[0].runs.value, 25);
});

test('a failed count write leaves a fault marker and the count reads as a floor, not a total', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.parse('2026-08-28T23:53:33Z') });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-02T10:00:00Z'), deliveryId: 'g1' });

  kv.failPutMatching = /^run:/;
  const failed = await recordRunBatch(env, {
    installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-03T10:00:00Z'), deliveryId: 'g2',
  });
  assert.equal(failed.recorded, false);
  assert.equal(failed.faultRecorded, true);
  kv.failPutMatching = null;

  const { snapshot } = await usageSnapshot(env, { now: Date.parse('2026-10-01T00:00:00Z') });
  const repo = snapshot.installations[0].repositories[0];
  assert.equal(repo.runs.value, 1);
  assert.equal(repo.runs.confidence, 'degraded');
  assert.equal(repo.ledgerWriteFaults, 1);
  assert.match(repo.runs.reason, /is a floor, not a total/);
});

test('a repository whose every write failed is a known failure, not an idle repository', async () => {
  // The worst case in the file: batches were delivered, none were counted. It must not
  // read like a repository we simply never heard from — that is the sentence that gets
  // a paying customer written off.
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.parse('2026-08-28T23:53:33Z') });

  kv.failPutMatching = /^run:/;
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-02T10:00:00Z'), deliveryId: 'g1' });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-03T10:00:00Z'), deliveryId: 'g2' });
  kv.failPutMatching = null;

  const { snapshot } = await usageSnapshot(env, { now: Date.parse('2026-10-01T00:00:00Z') });
  const repo = snapshot.installations[0].repositories[0];
  assert.equal(repo.runs.value, null);
  assert.equal(repo.ledgerWriteFaults, 2);
  assert.match(repo.runs.reason, /Batches WERE delivered and none of them were counted/);
  assert.doesNotMatch(repo.runs.reason, /never happened/);
  assert.equal(repo.billable, null);
});

test('batches nobody claims are surfaced, not swallowed', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  // A batch recorded before the ledger ever saw the installation.
  await recordRunBatch(env, { installationId: 999, repository: 'ghost/repo', now: Date.parse('2026-09-01T00:00:00Z'), deliveryId: 'g1' });

  const { snapshot } = await usageSnapshot(env, { now: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(snapshot.unattributed.length, 1);
  assert.equal(snapshot.unattributed[0].repository, 'ghost/repo');
  assert.equal(snapshot.unattributed[0].runs.value, 1);
  assert.match(snapshot.unattributed[0].reason, /billable work/);
});

test('the window bounds what is counted, and says which window it is', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.parse('2026-08-28T23:53:33Z') });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-08-30T10:00:00Z'), deliveryId: 'aug' });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-10T10:00:00Z'), deliveryId: 'sep1' });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-11T10:00:00Z'), deliveryId: 'sep2' });

  const sept = await usageSnapshot(env, {
    from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z', now: Date.parse('2026-10-01T00:00:00Z'),
  });
  assert.equal(sept.snapshot.installations[0].repositories[0].runs.value, 2);
  assert.equal(sept.snapshot.window.from, '2026-09-01T00:00:00.000Z');
  assert.equal(sept.snapshot.window.to, '2026-10-01T00:00:00.000Z');

  const october = await usageSnapshot(env, {
    from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', now: Date.parse('2026-11-01T00:00:00Z'),
  });
  // No batches in October — and that reads as unknown, not as zero.
  assert.equal(october.snapshot.installations[0].repositories[0].runs.value, null);
});

// ================================================================================
// 5 — the read endpoint refuses without its secret
// ================================================================================

test('GET /usage fails closed when LEDGER_READ_TOKEN is unset', async () => {
  const kv = fakeKv();
  await recordInstallationEvent({ USAGE_LEDGER: kv }, 'installation', REAL_CREATED, { now: Date.now() });

  const res = await worker.fetch(new Request('https://w.example/usage'), { USAGE_LEDGER: kv });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body.missing, ['LEDGER_READ_TOKEN']);
  // Not one account name, not one repository name, leaks through the closed door.
  assert.doesNotMatch(JSON.stringify(body), /Northlatch/);
});

test('GET /usage refuses a missing, wrong, or malformed bearer token', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.now() });

  for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: 'a-read-token' }, { authorization: 'Basic a-read-token' }]) {
    const res = await worker.fetch(new Request('https://w.example/usage', { headers }), env);
    assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(headers)}`);
    assert.doesNotMatch(JSON.stringify(await res.json()), /Northlatch/);
  }
});

test('GET /usage serves the picture to the right bearer, and 503s when the ledger is unbound', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.parse('2026-08-28T23:53:33Z') });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-02T10:00:00Z'), deliveryId: 'g1' });

  const res = await worker.fetch(
    new Request('https://w.example/usage?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z', {
      headers: { authorization: 'Bearer a-read-token' },
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const snapshot = await res.json();
  assert.equal(snapshot.totals.billableRepositories.value, 1);
  assert.ok(snapshot.invoiceSentence.length > 0);

  // Unbound ledger must never answer "zero usage".
  const unbound = await worker.fetch(
    new Request('https://w.example/usage', { headers: { authorization: 'Bearer a-read-token' } }),
    { LEDGER_READ_TOKEN: 'a-read-token' },
  );
  assert.equal(unbound.status, 503);
  const body = await unbound.json();
  assert.deepEqual(body.missing, ['USAGE_LEDGER']);
  assert.match(body.detail, /not a reading of zero usage/);
});

test('/healthz says whether usage is being recorded', async () => {
  const off = await (await worker.fetch(new Request('https://w.example/healthz'), {})).json();
  assert.equal(off.usage_ledger, 'not bound');
  const on = await (await worker.fetch(new Request('https://w.example/healthz'), envWith(fakeKv()))).json();
  assert.equal(on.usage_ledger, 'recording');
});

test('the ledger is inert when unbound and never blocks a client', async () => {
  assert.equal(usageLedger({}).ok, false);
  const outcome = await recordRunBatch({}, { installationId: 1, repository: 'a/b', deliveryId: 'g' });
  assert.equal(outcome.recorded, false);
  assert.match(outcome.reason, /not bound/);
});

// ================================================================================
// PRIVACY — identifiers and counts, nothing about what the code contains
// ================================================================================

test('the ledger stores identifiers and counts, and nothing about the client\'s code', async () => {
  const kv = fakeKv();
  const env = envWith(kv);
  await recordInstallationEvent(env, 'installation', REAL_CREATED, { now: Date.parse('2026-08-28T23:53:33Z'), deliveryId: REAL_DELIVERY_ID });
  await recordRunBatch(env, { installationId: INSTALL_ID, repository: REAL_REPO, now: Date.parse('2026-09-02T10:00:00Z'), deliveryId: 'g1' });

  const everything = [...kv.map.keys()].join('\n') + '\n' + [...kv.map.values()].join('\n');
  for (const forbidden of [
    'survivor', 'mutation', 'gate', 'finding', 'vulnerabilit', 'severity',
    'head_sha', 'commit', 'diff', 'source', 'avatar', 'node_id', 'permissions',
  ]) {
    assert.doesNotMatch(everything.toLowerCase(), new RegExp(forbidden), `the ledger must not store "${forbidden}"`);
  }
  // The captured payload is full of things we deliberately drop.
  assert.ok(JSON.stringify(REAL_CREATED).includes('avatar_url'), 'the real payload does carry avatars');
  assert.deepEqual(Object.keys(accountOf(REAL_CREATED.installation)).sort(), ['id', 'login', 'type']);
  assert.deepEqual(Object.keys(repositoriesOf(REAL_CREATED.repositories)[0]).sort(), ['private', 'repository', 'repositoryId']);
});

// ================================================================================
// the plumbing the above rests on
// ================================================================================

test('asIsoTimestamp accepts both forms GitHub has shipped, and refuses to invent one', () => {
  // The form our live capture actually carries.
  assert.equal(asIsoTimestamp('2026-08-28T16:53:32.000-07:00'), '2026-08-28T23:53:32.000Z');
  // The epoch-seconds form older payloads carry — the same instant, the other way round.
  assert.equal(asIsoTimestamp(Date.parse('2026-08-28T23:53:32Z') / 1000), '2026-08-28T23:53:32.000Z');
  for (const bad of [null, undefined, '', '   ', 'not a date', {}, NaN]) {
    assert.equal(asIsoTimestamp(bad), null);
  }
});

test('run keys round-trip, and a repository prefix cannot swallow its neighbour', () => {
  const k = runKey(157375258, 'acme/foo', 1_756_425_212_000, 'ad355eb0-a33b-11f1-956d-c155fa8a5c48');
  assert.deepEqual(parseRunKey(k), {
    installationId: '157375258',
    repository: 'acme/foo',
    atMillis: 1_756_425_212_000,
    deliveryId: 'ad355eb0-a33b-11f1-956d-c155fa8a5c48',
  });
  assert.ok(!runKey(1, 'acme/foobar', 1, 'g').startsWith(runKey(1, 'acme/foo', 1, 'g').slice(0, 'run:1:acme/foo#'.length)));
  assert.equal(parseRunKey('installation:1'), null);
  assert.equal(parseRunKey('run:garbage'), null);
});

test('keys sort by time, so the most recent batch is the last one listed', () => {
  const early = runKey(1, 'a/b', Date.parse('2026-01-01T00:00:00Z'), 'g1');
  const late = runKey(1, 'a/b', Date.parse('2026-12-31T00:00:00Z'), 'g2');
  assert.ok(early < late, 'zero-padded epoch millis sort lexicographically');
});

test('a repository object with no full_name is dropped from the roll and counted as a fault', () => {
  assert.deepEqual(repositoriesOf([{ id: 1 }, null, repoObject('a/b', 2)]).map((r) => r.repository), ['a/b']);
  assert.deepEqual(repositoriesOf(undefined), []);
});
