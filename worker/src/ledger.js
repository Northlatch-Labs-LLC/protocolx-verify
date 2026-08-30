// Built-by: @projectx.sui /|\
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// THE USAGE LEDGER — the measurement that makes an invoice possible.
//
// ProtocolX Verify is priced at $149 per repository per month. Before this file there
// was no way to know what to invoice, which made the price fictional. This is not a
// billing system: no payments, no cards, no subscriptions, no vendor. The estate
// invoices in USDC on Sui, by hand, and this is the document a human reads on the
// first of the month to write those invoices.
//
// THREE RULES GOVERN IT, and they matter more than the feature.
//
// 1. ABSENCE IS NOT ZERO. A repository whose runs we did not record reads as
//    `{value: null, reason: "…"}`, never as 0. Rendering "we measured nothing" and
//    "we measured nothing happening" identically under-bills silently and, worse,
//    tells the desk a paying customer is idle when they are not. This is the same
//    convention engine/evidence/evidence_bundle.py already holds the estate to, and
//    it is copied deliberately rather than reinvented.
//
// 2. THE COUNTER IS APPEND-ONLY, NOT READ-MODIFY-WRITE. Workers KV has no atomic
//    increment and is eventually consistent, so `get → n+1 → put` loses a count every
//    time two pull requests land on one repository at once — silent under-billing, the
//    exact failure this file exists to prevent. Instead every delivered batch writes
//    its own key and the count is the number of distinct delivery ids under a prefix.
//    Nothing to race, and GitHub's own webhook redelivery de-duplicates for free
//    because a redelivery carries the same X-GitHub-Delivery guid.
//
// 3. IDENTIFIERS AND COUNTS ONLY. Account login/id/type, repository full name/id, the
//    public-or-private flag (the free tier turns on it), timestamps, counts. NOTHING
//    about what the client's code contains: no findings, no survivors, no gate
//    verdicts, no commit shas, no file paths, no diff. A usage ledger that leaks what
//    we measured is a breach of the thing we sell. The commit sha is deliberately NOT
//    the uniqueness key for a run — the webhook delivery guid is, which is opaque,
//    tells us nothing about their repository, and de-duplicates better.
//
// EVENT SHAPES ARE MEASURED, NOT GUESSED. Every field read here was read out of a real
// delivery our own App received, pulled from GET /app/hook/deliveries with an App JWT
// on 2026-08-30 and committed verbatim as worker/test/fixtures/installation-created
// .delivery.json. That capture is also where `installation.created_at` being an ISO
// 8601 string with an offset ("2026-08-28T16:53:32.000-07:00") comes from rather than
// the epoch integer older references show — `asIsoTimestamp` accepts both and says so.
//
// A NOTE ON SUBSCRIPTION: our App is not subscribed to `installation` in its event
// list (its own payload shows events: check_suite, deployment, …, pull_request) and it
// received the installation/created delivery anyway. GitHub delivers the App-lifecycle
// events to a GitHub App's webhook whether or not they are subscribed. That is why
// this ledger can be fed at all without touching the App's registration.

// --- absence, stated once -----------------------------------------------------

export const LEDGER_SCHEMA = 'protocolx-verify/usage-ledger/1';

export const ABSENCE_CONVENTION =
  'Every count in this ledger is an integer or null. Null never means zero: it means '
  + 'the number was not recorded, and the reason is beside it. A repository with no '
  + 'recorded batch is not a repository we know to be idle.';

export const BILLING_UNIT =
  'One billable unit is one repository with at least one recorded check-run batch '
  + 'inside the window. A repository we never ran for is a repository we do not bill.';

// A field that is either a value or an explicit absence carrying its reason. The exact
// shape of `valued()` in engine/evidence/evidence_bundle.py — same convention, same
// name, so a reader who knows one knows the other.
export function valued(value, reason) {
  if (value !== null && value !== undefined) return { value, reason: null };
  return { value: null, reason: reason || 'not recorded; no reason recorded' };
}

// --- keys ---------------------------------------------------------------------
//
// `:` is a safe delimiter: GitHub owner and repository names are limited to
// alphanumerics, `-`, `_`, `.` and the single `/` between them, so a full name can
// never contain one. `#` terminates the repository segment so that a prefix scan for
// `acme/foo` cannot also sweep up `acme/foobar`.

export const INSTALLATION_PREFIX = 'installation:';
export const RUN_PREFIX = 'run:';
export const FAULT_PREFIX = 'fault:';

export const installationKey = (id) => `${INSTALLATION_PREFIX}${id}`;
export const runScope = (installationId, repository) => `${installationId}:${repository}#`;
export const runPrefix = (installationId, repository) => `${RUN_PREFIX}${runScope(installationId, repository)}`;
export const runKey = (installationId, repository, atMillis, deliveryId) =>
  `${runPrefix(installationId, repository)}${String(atMillis).padStart(14, '0')}#${deliveryId}`;
export const faultKey = (installationId, repository, atMillis, deliveryId) =>
  `${FAULT_PREFIX}${runScope(installationId, repository)}${String(atMillis).padStart(14, '0')}#${deliveryId}`;

// Read a run/fault key back into its parts. Returns null for anything unparseable —
// an unreadable key is reported as an integrity fault, never silently dropped, because
// a dropped key is a batch we delivered and would not invoice.
export function parseRunKey(key) {
  const prefix = key.startsWith(RUN_PREFIX) ? RUN_PREFIX
    : key.startsWith(FAULT_PREFIX) ? FAULT_PREFIX : null;
  if (!prefix) return null;
  const rest = key.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 1) return null;
  const installationId = rest.slice(0, firstColon);
  const afterId = rest.slice(firstColon + 1);
  const hash = afterId.indexOf('#');
  if (hash < 1) return null;
  const repository = afterId.slice(0, hash);
  const tail = afterId.slice(hash + 1);
  const second = tail.indexOf('#');
  if (second < 1) return null;
  const atMillis = Number(tail.slice(0, second));
  const deliveryId = tail.slice(second + 1);
  if (!Number.isInteger(atMillis) || !deliveryId) return null;
  return { installationId, repository, atMillis, deliveryId };
}

// --- normalising what GitHub sends ---------------------------------------------

// GitHub has shipped both forms of this field over the App's life. The live capture in
// worker/test/fixtures shows the ISO string with an offset; older payloads and some
// references show Unix epoch seconds. Accept both, normalise to UTC ISO, and refuse
// anything else rather than inventing a date.
export function asIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds until the year 5138; anything larger is already milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// Only the three fields an invoice needs. The account object GitHub sends carries
// nineteen keys — avatars, gravatar ids, a dozen API URLs. None of them help anyone
// write an invoice, so none of them are stored.
export function accountOf(installation) {
  const a = installation?.account;
  if (!a || typeof a !== 'object') return null;
  return {
    login: typeof a.login === 'string' ? a.login : null,
    id: Number.isInteger(a.id) ? a.id : null,
    type: typeof a.type === 'string' ? a.type : null,
  };
}

// The repository objects GitHub sends in `repositories`, `repositories_added` and
// `repositories_removed` carry exactly: id, node_id, name, full_name, private
// (measured, from the live capture). We keep three of them and drop node_id and the
// duplicate short name.
export function repositoriesOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const fullName = typeof r.full_name === 'string' ? r.full_name : null;
    if (!fullName) continue; // no name, no billable unit — counted as an integrity fault below
    out.push({
      repository: fullName,
      repositoryId: Number.isInteger(r.id) ? r.id : null,
      private: typeof r.private === 'boolean' ? r.private : null,
    });
  }
  return out;
}

export function unnamedRepositoryCount(list) {
  if (!Array.isArray(list)) return 0;
  return list.filter((r) => !r || typeof r !== 'object' || typeof r.full_name !== 'string').length;
}

// --- the installation record ----------------------------------------------------
//
// One JSON document per installation, and it is never deleted. An uninstall sets
// endedAt and status; a removed repository gets removedAt. The estate archives, it
// does not destroy: a repository dropped from the selection is still a repository we
// billed for the days it was there, and a deleted record is an invoice we cannot
// defend.

export const LEDGER_EVENTS = ['installation', 'installation_repositories'];

function blankRecord(installationId, observedAt) {
  return {
    schema: LEDGER_SCHEMA,
    installationId,
    account: null,
    status: 'unknown',
    installedAt: valued(null, 'no installation event has been recorded for this installation'),
    endedAt: null,
    suspendedAt: null,
    repositorySelection: null,
    repositorySelectionChangedAt: null,
    observedSince: observedAt,
    repositories: {},
    history: [],
  };
}

/**
 * Fold one webhook event into an installation record. Pure: takes the record as it
 * stands (or null) and returns the record as it should stand. All the branching that
 * an invoice depends on lives here, where a test can reach it without a store.
 */
export function applyInstallationEvent(existing, { event, payload, observedAt, deliveryId }) {
  const installation = payload?.installation ?? {};
  const installationId = installation.id;
  const record = existing
    ? {
      ...blankRecord(installationId, existing.observedSince ?? observedAt),
      ...existing,
      // Defensive against a record written by an older shape: a missing field is
      // filled from the blank, never assumed present and then dereferenced.
      installedAt: existing.installedAt ?? blankRecord(installationId, observedAt).installedAt,
      repositories: { ...(existing.repositories ?? {}) },
      history: Array.isArray(existing.history) ? [...existing.history] : [],
    }
    : blankRecord(installationId, observedAt);

  const action = typeof payload?.action === 'string' ? payload.action : null;
  const account = accountOf(installation);
  if (account) record.account = account;

  const githubInstalledAt = asIsoTimestamp(installation.created_at);
  if (githubInstalledAt) {
    record.installedAt = valued(githubInstalledAt, null);
  } else if (record.installedAt.value === null && event === 'installation' && action === 'created') {
    // We saw the install; GitHub's own timestamp was unreadable. Say which is which
    // rather than passing our clock off as theirs.
    record.installedAt = valued(
      observedAt,
      'installation.created_at was absent or unreadable in the delivery; this is the '
      + 'time the ledger observed the installation event, not GitHub\'s own',
    );
  }

  const suspendedAt = asIsoTimestamp(installation.suspended_at);

  // `repository_selection` sits on the installation object for `installation`, and at
  // the top level for `installation_repositories`. Both shapes are read.
  const selection = typeof payload?.repository_selection === 'string'
    ? payload.repository_selection
    : (typeof installation.repository_selection === 'string' ? installation.repository_selection : null);

  let selectionChanged = false;
  if (selection && selection !== record.repositorySelection) {
    selectionChanged = record.repositorySelection !== null;
    record.repositorySelection = selection;
  }

  const addRepos = (list, at) => {
    for (const r of list) {
      const prior = record.repositories[r.repository];
      record.repositories[r.repository] = {
        repository: r.repository,
        repositoryId: r.repositoryId ?? prior?.repositoryId ?? null,
        private: r.private ?? prior?.private ?? null,
        firstSeenAt: prior?.firstSeenAt ?? at,
        addedAt: at,
        removedAt: null,
      };
    }
  };

  const removeRepos = (list, at) => {
    for (const r of list) {
      const prior = record.repositories[r.repository];
      // Archived, never dropped. A repository we cannot see any more is still a
      // repository whose recorded batches must survive to be invoiced.
      record.repositories[r.repository] = {
        repository: r.repository,
        repositoryId: r.repositoryId ?? prior?.repositoryId ?? null,
        private: r.private ?? prior?.private ?? null,
        firstSeenAt: prior?.firstSeenAt ?? at,
        addedAt: prior?.addedAt ?? at,
        removedAt: at,
      };
    }
  };

  const entry = {
    at: observedAt,
    event,
    action,
    deliveryId: deliveryId ?? null,
    repositorySelection: selection,
    added: [],
    removed: [],
    unnamedRepositories: 0,
  };

  if (event === 'installation') {
    const named = repositoriesOf(payload?.repositories);
    entry.unnamedRepositories = unnamedRepositoryCount(payload?.repositories);
    if (action === 'created') {
      record.status = 'active';
      record.endedAt = null;
      addRepos(named, observedAt);
      entry.added = named.map((r) => r.repository);
    } else if (action === 'deleted') {
      record.status = 'ended';
      record.endedAt = observedAt;
      // Repositories keep their rows and their history. Marking the installation
      // ended is the whole change; nothing about what we already delivered moves.
      for (const name of Object.keys(record.repositories)) {
        if (record.repositories[name].removedAt === null) {
          record.repositories[name] = { ...record.repositories[name], removedAt: observedAt };
        }
      }
    } else if (action === 'suspend') {
      record.status = 'suspended';
      record.suspendedAt = suspendedAt ?? observedAt;
    } else if (action === 'unsuspend') {
      record.status = 'active';
      record.suspendedAt = null;
    } else {
      // new_permissions_accepted, and anything GitHub adds later. Recorded in the
      // history, changes nothing an invoice depends on.
      if (record.status === 'unknown') record.status = 'active';
      if (named.length > 0) addRepos(named, observedAt);
      entry.added = named.map((r) => r.repository);
    }
  } else if (event === 'installation_repositories') {
    const added = repositoriesOf(payload?.repositories_added);
    const removed = repositoriesOf(payload?.repositories_removed);
    entry.unnamedRepositories = unnamedRepositoryCount(payload?.repositories_added)
      + unnamedRepositoryCount(payload?.repositories_removed);
    addRepos(added, observedAt);
    removeRepos(removed, observedAt);
    entry.added = added.map((r) => r.repository);
    entry.removed = removed.map((r) => r.repository);
    if (record.status === 'unknown') {
      // The ledger was switched on after this installation existed. Say so, rather
      // than back-dating an install we never saw.
      record.status = 'active';
      record.installedAt = valued(
        githubInstalledAt,
        'no installation event was recorded; this installation was first seen through '
        + 'a repository-selection change, so the ledger cannot vouch for when it began',
      );
    }
  }

  if (selectionChanged) record.repositorySelectionChangedAt = observedAt;
  if (suspendedAt && record.status !== 'suspended' && !record.suspendedAt) record.suspendedAt = suspendedAt;

  record.history.push(entry);
  return record;
}

// --- the store ------------------------------------------------------------------
//
// Two calls into the binding — get/put/list — so that moving off Workers KV later is a
// binding swap, not a rewrite. The ledger is INERT when USAGE_LEDGER is not bound: the
// webhook path is untouched, /usage answers a named 503, and nothing anywhere reports
// a zero it did not measure.

export function usageLedger(env) {
  const kv = env?.USAGE_LEDGER;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function' || typeof kv.list !== 'function') {
    return { ok: false, missing: ['USAGE_LEDGER'] };
  }
  return { ok: true, kv };
}

/**
 * Record an installation-lifecycle event. Never throws: a ledger failure must not cost
 * a client their check runs, so the caller gets an outcome to report and log, and the
 * verification path carries on regardless.
 */
export async function recordInstallationEvent(env, event, payload, { now = Date.now(), deliveryId = null } = {}) {
  const store = usageLedger(env);
  if (!store.ok) return { recorded: false, reason: 'the usage ledger is not bound (USAGE_LEDGER)' };
  const installationId = payload?.installation?.id;
  if (!Number.isInteger(installationId)) {
    return { recorded: false, reason: 'the event carries no installation id' };
  }
  const observedAt = new Date(now).toISOString();
  try {
    const key = installationKey(installationId);
    const raw = await store.kv.get(key);
    let existing = null;
    if (raw) {
      try {
        existing = JSON.parse(raw);
      } catch {
        // Refuse to overwrite a record we cannot read: that would destroy history to
        // tidy up a parse error. Park it and say so.
        await store.kv.put(`${key}:unreadable:${observedAt}`, raw).catch(() => {});
        return { recorded: false, reason: 'the stored installation record is not JSON; it has been preserved, not overwritten' };
      }
    }
    const record = applyInstallationEvent(existing, { event, payload, observedAt, deliveryId });
    await store.kv.put(key, JSON.stringify(record));
    return { recorded: true, installationId, status: record.status };
  } catch (cause) {
    return { recorded: false, reason: `the ledger write failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/**
 * Record one delivered check-run batch. Append-only: a new key per delivery, so
 * concurrent batches on one repository cannot lose each other.
 *
 * Called only AFTER the runner has been dispatched. A batch whose runner never started
 * is work we did not deliver, and we do not bill for it.
 */
export async function recordRunBatch(env, { installationId, repository, now = Date.now(), deliveryId }) {
  const store = usageLedger(env);
  if (!store.ok) return { recorded: false, reason: 'the usage ledger is not bound (USAGE_LEDGER)' };
  if (!installationId || !repository) {
    return { recorded: false, reason: 'the batch carries no installation id or repository' };
  }
  const id = deliveryId || `no-delivery-guid-${now}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await store.kv.put(runKey(installationId, repository, now, id), '1');
    return { recorded: true };
  } catch (cause) {
    const note = cause instanceof Error ? cause.message : String(cause);
    // The count write failed, so the count is now short by one and nothing in the
    // ledger would say so. Try to leave a fault marker: if it lands, /usage reports
    // this repository's count as degraded instead of quietly under-billing. If it does
    // not land, the outcome below is the only record, in the worker's log and in the
    // webhook response.
    let faultRecorded = false;
    try {
      await store.kv.put(faultKey(installationId, repository, now, id), note.slice(0, 200));
      faultRecorded = true;
    } catch { /* the store is unreachable; the outcome below is what is left */ }
    return { recorded: false, reason: `the ledger write failed: ${note}`, faultRecorded };
  }
}

// --- reading the picture ----------------------------------------------------------

const LIST_PAGE = 1000;
// A hard ceiling so one read cannot walk forever. Hitting it does not produce a smaller
// number — it produces "unknown, and here is why", because a truncated scan under-counts
// and an under-count is an under-invoice.
const MAX_PAGES = 20;

async function listAll(kv, prefix) {
  const keys = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await kv.list({ prefix, limit: LIST_PAGE, ...(cursor ? { cursor } : {}) });
    for (const k of res.keys ?? []) keys.push(k.name);
    if (res.list_complete || !res.cursor) return { keys, complete: true };
    cursor = res.cursor;
  }
  return { keys, complete: false };
}

/**
 * The current picture, as JSON. This is what a human reads on the first of the month.
 *
 * `from`/`to` are optional ISO instants bounding the window; counts outside it are not
 * counted, and the window is stated in the output so nobody has to guess which month
 * they are looking at.
 */
export async function usageSnapshot(env, { from = null, to = null, now = Date.now() } = {}) {
  const store = usageLedger(env);
  if (!store.ok) return { ok: false, missing: store.missing };

  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  const windowFaults = [];
  if (from && Number.isNaN(fromMs)) windowFaults.push(`the "from" parameter ${JSON.stringify(from)} is not a date; it was ignored`);
  if (to && Number.isNaN(toMs)) windowFaults.push(`the "to" parameter ${JSON.stringify(to)} is not a date; it was ignored`);
  const lo = Number.isNaN(fromMs) ? null : fromMs;
  const hi = Number.isNaN(toMs) ? null : toMs;
  const inWindow = (ms) => (lo === null || ms >= lo) && (hi === null || ms < hi);

  const installScan = await listAll(store.kv, INSTALLATION_PREFIX);
  const runScan = await listAll(store.kv, RUN_PREFIX);
  const faultScan = await listAll(store.kv, FAULT_PREFIX);
  const complete = installScan.complete && runScan.complete && faultScan.complete;

  // Bucket the run keys by scope. Distinct delivery ids, so a GitHub redelivery of one
  // webhook counts once however many times it arrives.
  const byScope = new Map();
  let unparseableKeys = 0;
  const bucket = (keyName, kind) => {
    const parsed = parseRunKey(keyName);
    if (!parsed) { unparseableKeys += 1; return; }
    const scope = runScope(parsed.installationId, parsed.repository);
    let b = byScope.get(scope);
    if (!b) {
      b = { installationId: parsed.installationId, repository: parsed.repository, deliveries: new Set(), faults: 0, lastMs: null };
      byScope.set(scope, b);
    }
    if (!inWindow(parsed.atMillis)) return;
    if (kind === 'fault') { b.faults += 1; return; }
    b.deliveries.add(parsed.deliveryId);
    if (b.lastMs === null || parsed.atMillis > b.lastMs) b.lastMs = parsed.atMillis;
  };
  for (const k of runScan.keys) bucket(k, 'run');
  for (const k of faultScan.keys) bucket(k, 'fault');

  const truncationReason = complete ? null
    : `the ledger scan hit its ${MAX_PAGES * LIST_PAGE}-key ceiling, so this reading is `
      + 'incomplete; a partial scan under-counts, and an under-count is an under-invoice';

  // Runs for one scope, as a value-or-reason. Never 0: a scope with no recorded
  // delivery has no row at all and is answered by the caller with its own reason.
  const runsFor = (scope, absentReason) => {
    if (!complete) return { runs: valued(null, truncationReason), lastRunAt: null, faults: 0 };
    const b = byScope.get(scope);
    if (!b || b.deliveries.size === 0) {
      // A scope with faults and no successful writes is the worst case in this file:
      // we KNOW batches were delivered and we have none of them counted. It must not
      // read like a repository we simply never heard from.
      if (b && b.faults > 0) {
        return {
          runs: valued(null, `${b.faults} ledger write fault(s) are recorded for this repository and `
            + 'no batch write succeeded. Batches WERE delivered and none of them were counted. '
            + 'This is a known measurement failure, not an idle repository.'),
          lastRunAt: null,
          faults: b.faults,
        };
      }
      return { runs: valued(null, absentReason), lastRunAt: null, faults: b?.faults ?? 0 };
    }
    const runs = valued(b.deliveries.size, null);
    if (b.faults > 0) {
      // A count we know to be short. Report the floor and say it is a floor — never
      // the bare number, which would read as complete.
      runs.confidence = 'degraded';
      runs.reason = `${b.faults} recorded ledger write fault(s) for this repository: at least `
        + `${b.faults} delivered batch(es) are missing from this count, so ${b.deliveries.size} is a floor, not a total`;
    } else {
      runs.confidence = 'counted';
    }
    return { runs, lastRunAt: new Date(b.lastMs).toISOString(), faults: b.faults };
  };

  const installations = [];
  const seenScopes = new Set();
  const unreadable = [];
  let billable = 0;
  let unknownRepos = 0;
  let selectedRepos = 0;
  let active = 0;

  for (const key of installScan.keys) {
    if (key.includes(':unreadable:')) { unreadable.push(key); continue; }
    const raw = await store.kv.get(key);
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      unreadable.push(key);
      continue;
    }
    if (record.status === 'active' || record.status === 'suspended') active += 1;

    const repositories = [];
    for (const name of Object.keys(record.repositories ?? {}).sort()) {
      const r = record.repositories[name];
      const scope = runScope(record.installationId, name);
      seenScopes.add(scope);
      selectedRepos += 1;
      const absentReason =
        'no check-run batch has been recorded for this repository. This is NOT a count '
        + `of zero: the ledger has been observing this installation since ${record.observedSince}, `
        + 'and a delivery whose ledger write failed reads exactly the same way as one that '
        + 'never happened. Confirm against the App\'s delivery log before invoicing or writing off.';
      const { runs, lastRunAt, faults } = runsFor(scope, absentReason);
      if (runs.value === null) unknownRepos += 1; else billable += 1;
      repositories.push({
        repository: name,
        repositoryId: r.repositoryId ?? null,
        private: r.private ?? null,
        firstSeenAt: r.firstSeenAt ?? null,
        addedAt: r.addedAt ?? null,
        removedAt: r.removedAt ?? null,
        runs,
        lastRunAt,
        ledgerWriteFaults: faults,
        // Never `false`. A repository we cannot count is unknown, and unknown is a
        // question for a human, not a write-off.
        billable: runs.value === null ? null : runs.value > 0,
      });
    }

    installations.push({
      installationId: record.installationId,
      account: record.account,
      status: record.status,
      installedAt: record.installedAt,
      endedAt: record.endedAt ?? null,
      suspendedAt: record.suspendedAt ?? null,
      repositorySelection: record.repositorySelection ?? null,
      repositorySelectionChangedAt: record.repositorySelectionChangedAt ?? null,
      observedSince: record.observedSince ?? null,
      repositories,
      history: record.history ?? [],
    });
  }

  // Batches recorded against a repository no installation record claims. This is the
  // opposite failure to an absent count and just as expensive: work we delivered and
  // would never invoice. It happens when the ledger was switched on after an install,
  // or if a record were ever lost.
  const unattributed = [];
  for (const [scope, b] of byScope) {
    if (seenScopes.has(scope)) continue;
    if (b.deliveries.size === 0 && b.faults === 0) continue;
    unattributed.push({
      installationId: b.installationId,
      repository: b.repository,
      runs: b.deliveries.size > 0
        ? valued(b.deliveries.size, null)
        : valued(null, `${b.faults} ledger write fault(s) and no successful batch write`),
      ledgerWriteFaults: b.faults,
      lastRunAt: b.lastMs === null ? null : new Date(b.lastMs).toISOString(),
      reason: 'batches are recorded for this repository but no installation record '
        + 'claims it — most likely the ledger began recording runs before it saw this '
        + 'installation. It is billable work; attribute it to an account before invoicing.',
    });
  }

  const windowFrom = lo === null ? null : new Date(lo).toISOString();
  const windowTo = hi === null ? null : new Date(hi).toISOString();
  const period = windowFrom || windowTo
    ? `${windowFrom ?? 'the beginning of the ledger'} to ${windowTo ?? 'now'}`
    : 'the whole life of the ledger';

  const invoiceSentence =
    `For ${period}, ${billable} repositor${billable === 1 ? 'y' : 'ies'} across `
    + `${installations.length} installation${installations.length === 1 ? '' : 's'} `
    + `${billable === 1 ? 'has' : 'have'} at least one recorded check-run batch and `
    + `${billable === 1 ? 'is' : 'are'} billable at the per-repository rate; `
    + `${unknownRepos} further selected repositor${unknownRepos === 1 ? 'y has' : 'ies have'} no `
    + `recorded batch, which is unmeasured usage and not zero usage, and ${unattributed.length} `
    + `repositor${unattributed.length === 1 ? 'y has' : 'ies have'} recorded batches no `
    + 'installation record claims — read those two lists before you send anything.';

  return {
    ok: true,
    snapshot: {
      schema: LEDGER_SCHEMA,
      generatedAt: new Date(now).toISOString(),
      window: { from: windowFrom, to: windowTo },
      absenceConvention: ABSENCE_CONVENTION,
      billingUnit: BILLING_UNIT,
      invoiceSentence,
      totals: {
        installations: installations.length,
        activeInstallations: active,
        selectedRepositories: selectedRepos,
        billableRepositories: {
          value: complete ? billable : null,
          reason: complete ? null : truncationReason,
          isFloor: true,
          basis: 'repositories with at least one recorded check-run batch inside the window',
        },
        repositoriesWithNoRecordedBatch: unknownRepos,
        unattributedRepositories: unattributed.length,
      },
      installations,
      unattributed,
      integrity: {
        scanComplete: complete,
        scanTruncatedReason: truncationReason,
        unparseableKeys,
        unreadableRecords: unreadable,
        windowFaults,
        residualGap:
          'A ledger write that failed AND whose fault marker also failed to write is '
          + 'invisible here; the worker\'s response and log are the only record of it. '
          + 'Counts marked degraded are floors.',
      },
    },
  };
}
