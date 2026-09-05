// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// drift-watch — the continuity half of deployed-package verification, as pure functions
// so the whole of it can be tested without a network.
//
// WHAT THIS IS NOT, SAID FIRST
//
// It is not source verification. `sui client verify-source` already does that, first
// party, free, and correctly — it rebuilds a local package with the toolchain version it
// was published with and compares the result to the on-chain bytecode and linkage. There
// is no honest reason to reimplement that here, and a second, worse implementation of it
// would be a liability rather than a product.
//
// What that command cannot do is notice that it needs running again. It is a point in
// time. Somebody types it, reads `Source verification succeeded`, and that fact decays
// silently the moment an UpgradeCap holder publishes a new version — which they can do
// without touching the repository anyone verified, without a pull request, and without
// telling the people who read the audit.
//
// So this file measures the OTHER thing: given a state that somebody verified once, has
// the chain moved away from it? That is the whole idea. A recorded snapshot of what was
// on chain at verification time, re-read on every CI run, and a loud failure the moment
// the live package, its linkage, or the authority to upgrade it is no longer what was
// checked.
//
// THREE VERDICTS, AND THE THIRD IS THE IMPORTANT ONE
//
//   match       the chain still holds what was recorded
//   drift       it does not, and here is every field that moved
//   unmeasured  we could not read it, so we say nothing about it
//
// The third exists for the same reason `engine/ci/digest-of-dump.py` exits 2 and never 1:
// `drift` is an accusation about somebody's deployment. A timed-out endpoint, a truncated
// module page or a snapshot from a different chain must never be published wearing that
// badge. Every failure path in this file returns `unmeasured` with a reason attached.

import { createHash } from 'node:crypto';

export const SNAPSHOT_SCHEMA = 'protocolx-verify/drift-watch/1';

// Mainnet's public GraphQL endpoint. JSON-RPC on public fullnodes was retired — a
// `sui_getObject` call against fullnode.mainnet.sui.io answers `Method not found. JSON-RPC
// on public fullnodes has been deprecated`, so this is a GraphQL client on purpose and not
// by preference.
export const DEFAULT_ENDPOINT = 'https://graphql.mainnet.sui.io/graphql';

// Modules are a paginated connection. 50 is a page, not a limit: the fetcher follows the
// cursor and `parsePackage` REFUSES a page set that still says `hasNextPage`, because a
// silently truncated module list would let a package with 51 modules report `match` on the
// strength of the first 50.
export const MODULE_PAGE_SIZE = 50;

export const PACKAGE_QUERY = `query Package($address: SuiAddress!, $first: Int!, $after: String) {
  chainIdentifier
  object(address: $address) {
    address
    version
    digest
    asMovePackage {
      version
      modules(first: $first, after: $after) {
        nodes { name bytes }
        pageInfo { hasNextPage endCursor }
      }
      linkage { originalId upgradedId version }
    }
  }
}`;

export const UPGRADE_CAP_QUERY = `query UpgradeCap($address: SuiAddress!) {
  chainIdentifier
  object(address: $address) {
    address
    version
    digest
    owner {
      __typename
      ... on AddressOwner { address { address } }
      ... on Shared { initialSharedVersion }
    }
    asMoveObject { contents { type { repr } json } }
  }
}`;

export const UPGRADE_CAP_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::package::UpgradeCap';

// `sui::package`: COMPATIBLE = 0, ADDITIVE = 128, DEP_ONLY = 192. The numbers are ordered
// by restriction, and the module's own API can only ever RAISE one — `only_additive_upgrades`
// and `only_dep_upgrades` assign upward and there is no call that assigns downward. A policy
// that went DOWN between two readings therefore did not happen through the published
// interface, and that is worth saying in those words rather than reporting "policy changed".
export const POLICY_NAMES = { 0: 'compatible', 128: 'additive', 192: 'dep-only' };

export function policyName(policy) {
  return POLICY_NAMES[policy] ?? `unrecognised(${policy})`;
}

const ZERO_ADDRESS = `0x${'0'.repeat(64)}`;

// --- helpers -------------------------------------------------------------------------

function fail(reason) {
  return { ok: false, reason };
}

// A Sui address as GraphQL returns it: 0x + 64 lowercase hex. Callers may pass the short
// forms people actually type ("0x2"), so this pads rather than refuses — but it refuses
// anything that is not hex, because the value is interpolated into a query.
export function normaliseAddress(value) {
  if (typeof value !== 'string') return fail('address is not a string');
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    return fail(`"${value}" is not a 0x-prefixed hex Sui address of 1-64 digits`);
  }
  return { ok: true, value: `0x${trimmed.slice(2).toLowerCase().padStart(64, '0')}` };
}

export function moduleDigest(base64Bytes) {
  return createHash('sha256').update(Buffer.from(base64Bytes, 'base64')).digest('hex');
}

// GraphQL answers 200 with an `errors` array rather than an HTTP status, so a caller that
// only checked the status would read a failure as an empty package.
function graphqlPayload(json) {
  if (json === null || typeof json !== 'object') return fail('response is not a JSON object');
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const messages = json.errors.map((e) => (e && e.message) || String(e)).join('; ');
    return fail(`the endpoint returned GraphQL errors: ${messages}`);
  }
  if (json.data === null || typeof json.data !== 'object') return fail('response carries no `data`');
  return { ok: true, value: json.data };
}

// --- reading a package off the chain --------------------------------------------------

export function parsePackage(json) {
  const payload = graphqlPayload(json);
  if (!payload.ok) return payload;
  const data = payload.value;

  const chain = data.chainIdentifier;
  if (typeof chain !== 'string' || chain.length === 0) return fail('response carries no chainIdentifier');

  const object = data.object;
  // A null object is a real, meaningful answer: nothing lives at that address on this
  // chain. It is still not a measurement of drift — a recorded package that has vanished
  // is either the wrong address or an endpoint serving the wrong network, and both are
  // reasons to stop rather than to accuse.
  if (object === null || object === undefined) return fail('no object exists at that address on this chain');
  if (typeof object !== 'object') return fail('`object` is not an object');

  const pkg = object.asMovePackage;
  if (pkg === null || pkg === undefined) {
    return fail('the object at that address is not a Move package (asMovePackage is null)');
  }

  const modules = pkg.modules;
  if (!modules || !Array.isArray(modules.nodes)) return fail('the package carries no `modules.nodes` array');
  if (modules.pageInfo && modules.pageInfo.hasNextPage === true) {
    // Reached when a caller queried one page and handed the raw response straight here.
    // Reporting on a partial module set is the failure mode this whole file exists to
    // avoid, so it is refused rather than trimmed.
    return fail('the module list is incomplete — pageInfo.hasNextPage is still true, so the '
      + 'cursor was not followed and only part of the package was read');
  }
  if (modules.nodes.length === 0) return fail('the package reports zero modules, which no published package has');

  const moduleDigests = {};
  for (const node of modules.nodes) {
    if (!node || typeof node.name !== 'string' || node.name.length === 0) {
      return fail('a module in the response has no name');
    }
    if (typeof node.bytes !== 'string' || node.bytes.length === 0) {
      return fail(`module "${node.name}" carries no bytecode in the response`);
    }
    if (Object.prototype.hasOwnProperty.call(moduleDigests, node.name)) {
      return fail(`module "${node.name}" appears twice in the response`);
    }
    moduleDigests[node.name] = moduleDigest(node.bytes);
  }

  const version = pkg.version ?? object.version;
  if (!Number.isInteger(version)) return fail('the package has no integer version');

  const linkage = [];
  for (const entry of Array.isArray(pkg.linkage) ? pkg.linkage : []) {
    if (!entry || typeof entry.originalId !== 'string' || typeof entry.upgradedId !== 'string'
      || !Number.isInteger(entry.version)) {
      return fail('a linkage entry is missing originalId, upgradedId or an integer version');
    }
    linkage.push({ originalId: entry.originalId, upgradedId: entry.upgradedId, version: entry.version });
  }
  // Sorted so that two readings of the same package compare equal regardless of the order
  // the endpoint happened to return them in. An ordering difference is not drift.
  linkage.sort((a, b) => (a.originalId < b.originalId ? -1 : a.originalId > b.originalId ? 1 : 0));

  return {
    ok: true,
    value: {
      chain,
      address: typeof object.address === 'string' ? object.address : null,
      version,
      objectDigest: typeof object.digest === 'string' ? object.digest : null,
      moduleCount: Object.keys(moduleDigests).length,
      modules: moduleDigests,
      linkage,
    },
  };
}

// --- reading the UpgradeCap -----------------------------------------------------------

export function parseUpgradeCap(json) {
  const payload = graphqlPayload(json);
  if (!payload.ok) return payload;
  const data = payload.value;

  const chain = data.chainIdentifier;
  if (typeof chain !== 'string' || chain.length === 0) return fail('response carries no chainIdentifier');

  const object = data.object;
  // A cap that no longer exists is the ONE disappearance that is good news: `make_immutable`
  // deletes the object, and a package nobody can upgrade cannot drift. It is still a change
  // from a snapshot that recorded a live cap, so it is returned as a state rather than as an
  // error, and the comparison below decides what to call it.
  if (object === null || object === undefined) {
    return { ok: true, value: { chain, address: null, present: false, reason: 'no object at that address — an UpgradeCap is deleted by make_immutable, so this may mean the package was frozen' } };
  }
  if (typeof object !== 'object') return fail('`object` is not an object');

  const contents = object.asMoveObject && object.asMoveObject.contents;
  if (!contents) return fail('the object at that address has no Move contents');
  const repr = contents.type && contents.type.repr;
  if (repr !== UPGRADE_CAP_TYPE) {
    // Watching the wrong object would produce a permanently green gate, which is worse
    // than no gate. The type is checked rather than assumed.
    return fail(`the object at that address is ${repr ?? 'of no readable type'}, not ${UPGRADE_CAP_TYPE}`);
  }

  const fields = contents.json;
  if (!fields || typeof fields !== 'object') return fail('the UpgradeCap has no readable fields');

  const pkgField = fields.package;
  if (typeof pkgField !== 'string') return fail('the UpgradeCap has no `package` field');
  if (!Number.isInteger(fields.policy)) return fail('the UpgradeCap has no integer `policy` field');

  // `version` arrives as a string because it is a u64 and JSON numbers are not.
  const versionRaw = fields.version;
  if (typeof versionRaw !== 'string' || !/^[0-9]+$/.test(versionRaw)) {
    return fail('the UpgradeCap has no decimal `version` field');
  }

  let owner = { kind: 'unknown', address: null };
  if (object.owner && typeof object.owner === 'object') {
    const kind = object.owner.__typename;
    if (kind === 'AddressOwner' && object.owner.address && typeof object.owner.address.address === 'string') {
      owner = { kind, address: object.owner.address.address };
    } else if (typeof kind === 'string') {
      owner = { kind, address: null };
    }
  }

  return {
    ok: true,
    value: {
      chain,
      address: typeof object.address === 'string' ? object.address : null,
      present: true,
      package: pkgField,
      version: versionRaw,
      policy: fields.policy,
      policyName: policyName(fields.policy),
      owner,
      // During `authorize_upgrade` the cap's package field is zeroed and only restored by
      // `commit_upgrade`. Reading that state means a transaction is mid-flight, and a
      // comparison run against it would be measuring a half-applied upgrade.
      upgradeInFlight: pkgField === ZERO_ADDRESS,
    },
  };
}

// --- the snapshot ---------------------------------------------------------------------

// `observedAt` and `endpoint` are recorded but are not compared: they say when and where a
// reading happened, not what was read.
export function buildSnapshot({ chain, pkg, upgradeCap, upgradeCapReason, observedAt, endpoint }) {
  return {
    schema: SNAPSHOT_SCHEMA,
    chain,
    observedAt,
    endpoint,
    package: {
      address: pkg.address,
      version: pkg.version,
      objectDigest: pkg.objectDigest,
      moduleCount: pkg.moduleCount,
      modules: pkg.modules,
      linkage: pkg.linkage,
    },
    upgradeCap: upgradeCap ?? null,
    // The null-with-a-reason rule the evidence bundle already follows: an UpgradeCap that
    // was never watched and an UpgradeCap that was watched and found absent are different
    // facts about a package, and a file that renders them identically is worse than none.
    upgradeCapReason: upgradeCap ? null : (upgradeCapReason ?? 'not requested'),
    // Source verification is `sui client verify-source`, run by a person against a source
    // tree this tool does not have. Recording anything but null here without having run it
    // would be asserting a measurement that never happened.
    sourceVerification: null,
    sourceVerificationReason:
      'not recorded by drift-watch — establish it with `sui client verify-source`; see runner/DRIFT-WATCH.md',
  };
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return fail('the snapshot is not a JSON object');
  if (snapshot.schema !== SNAPSHOT_SCHEMA) {
    return fail(`the snapshot declares schema ${JSON.stringify(snapshot.schema)}, not ${SNAPSHOT_SCHEMA}`);
  }
  if (typeof snapshot.chain !== 'string' || snapshot.chain.length === 0) {
    return fail('the snapshot records no chain identifier');
  }
  const pkg = snapshot.package;
  if (!pkg || typeof pkg !== 'object') return fail('the snapshot records no package');
  if (!Number.isInteger(pkg.version)) return fail('the snapshot records no integer package version');
  if (!pkg.modules || typeof pkg.modules !== 'object' || Object.keys(pkg.modules).length === 0) {
    return fail('the snapshot records no module digests');
  }
  if (!Array.isArray(pkg.linkage)) return fail('the snapshot records no linkage array');
  return { ok: true, value: snapshot };
}

// --- the comparison ---------------------------------------------------------------------

function finding(code, detail) {
  return { code, detail };
}

// compareSnapshots(recorded, observed) -> { verdict, findings, reason? }
//
// `recorded` is the state somebody verified. `observed` is what the chain says now. The
// argument order is not cosmetic: every finding is phrased as a change FROM the verified
// state, because that is the sentence a reader needs.
export function compareSnapshots(recorded, observed) {
  const rec = validateSnapshot(recorded);
  if (!rec.ok) return { verdict: 'unmeasured', findings: [], reason: `recorded snapshot: ${rec.reason}` };
  const obs = validateSnapshot(observed);
  if (!obs.ok) return { verdict: 'unmeasured', findings: [], reason: `observed snapshot: ${obs.reason}` };

  // Two snapshots of the same address on different networks are not a before and an after.
  // Comparing them would answer a question nobody asked, and a mismatch here is far more
  // likely to be a misconfigured endpoint than a compromised package.
  if (recorded.chain !== observed.chain) {
    return {
      verdict: 'unmeasured',
      findings: [],
      reason: `the snapshot was taken on chain ${recorded.chain} and the reading came from ${observed.chain}`,
    };
  }

  if (observed.upgradeCap && observed.upgradeCap.present && observed.upgradeCap.upgradeInFlight) {
    // authorize_upgrade has run and commit_upgrade has not. Anything measured now is a
    // half-applied upgrade, so no verdict is given on it.
    return {
      verdict: 'unmeasured',
      findings: [],
      reason: 'the UpgradeCap is mid-upgrade — its package field is zeroed between '
        + 'authorize_upgrade and commit_upgrade, so the chain is not in a settled state',
    };
  }

  const findings = [];
  const r = recorded.package;
  const o = observed.package;

  if (r.address !== o.address) {
    findings.push(finding('package-address-changed', `verified ${r.address}, chain now serves ${o.address}`));
  }
  if (r.version !== o.version) {
    // The headline case, and the reason this tool exists: the bytecode running under this
    // package is not the bytecode anyone verified, and no repository changed to say so.
    findings.push(finding('package-upgraded',
      `verified version ${r.version}, chain is now at version ${o.version} — the deployed bytecode `
      + 'has been replaced since it was verified'));
  }
  if (r.objectDigest && o.objectDigest && r.objectDigest !== o.objectDigest && r.version === o.version) {
    findings.push(finding('package-object-digest-changed',
      `the package object digest moved from ${r.objectDigest} to ${o.objectDigest} at the same version`));
  }

  const recordedNames = Object.keys(r.modules).sort();
  const observedNames = Object.keys(o.modules).sort();
  for (const name of recordedNames) {
    if (!Object.prototype.hasOwnProperty.call(o.modules, name)) {
      findings.push(finding('module-removed', `module "${name}" is no longer published`));
    } else if (o.modules[name] !== r.modules[name]) {
      findings.push(finding('module-changed',
        `module "${name}" bytecode digest moved from ${r.modules[name]} to ${o.modules[name]}`));
    }
  }
  for (const name of observedNames) {
    if (!Object.prototype.hasOwnProperty.call(r.modules, name)) {
      findings.push(finding('module-added', `module "${name}" was not present when this package was verified`));
    }
  }

  // Linkage is what the package's dependencies resolve to at runtime. A package whose own
  // bytecode is untouched but whose linkage moved is executing against different code than
  // the one that was reviewed, which is drift by any definition a reader would accept.
  const linkageKey = (l) => `${l.originalId}@${l.upgradedId}#${l.version}`;
  const recLink = new Set(r.linkage.map(linkageKey));
  const obsLink = new Set(o.linkage.map(linkageKey));
  for (const entry of r.linkage) {
    if (!obsLink.has(linkageKey(entry))) {
      findings.push(finding('linkage-removed-or-moved',
        `linkage to ${entry.originalId} at version ${entry.version} (${entry.upgradedId}) is no longer what was verified`));
    }
  }
  for (const entry of o.linkage) {
    if (!recLink.has(linkageKey(entry))) {
      findings.push(finding('linkage-added-or-moved',
        `the package now links ${entry.originalId} at version ${entry.version} (${entry.upgradedId})`));
    }
  }

  findings.push(...compareUpgradeCap(recorded.upgradeCap, observed.upgradeCap));

  return { verdict: findings.length === 0 ? 'match' : 'drift', findings };
}

// The authority half. Nothing here is about bytecode: it is about who may replace it and
// under what policy. A package can be byte-identical to the one that was audited while the
// capability to overwrite it has moved to an address nobody has ever looked at, and that is
// a fact about the deployment that a verification report should carry.
export function compareUpgradeCap(recorded, observed) {
  const findings = [];
  if (!recorded && !observed) return findings;
  if (!recorded && observed) {
    return [finding('upgrade-cap-now-watched',
      'the snapshot recorded no UpgradeCap but one was read on this run — re-record the snapshot so the two are comparable')];
  }
  if (recorded && !observed) {
    return [finding('upgrade-cap-not-read',
      'the snapshot records an UpgradeCap but this run did not read one — the authority to upgrade was not checked')];
  }

  if (recorded.present && !observed.present) {
    // The good disappearance, named as such. `make_immutable` deletes the cap; the package
    // can never be upgraded again. It is reported because it is a change, not because it is
    // bad, and the wording has to make that plain or a reader will treat it as an alarm.
    findings.push(finding('upgrade-cap-gone',
      'the UpgradeCap no longer exists. `make_immutable` deletes it, so this most likely means the '
      + 'package was deliberately frozen and can no longer be upgraded. Confirm before assuming either way'));
    return findings;
  }
  if (!recorded.present && observed.present) {
    findings.push(finding('upgrade-cap-reappeared',
      'the snapshot recorded no UpgradeCap at that address and one is there now'));
    return findings;
  }
  if (!recorded.present && !observed.present) return findings;

  if (recorded.package !== observed.package) {
    findings.push(finding('upgrade-cap-package-moved',
      `the UpgradeCap now points at package ${observed.package}, not the verified ${recorded.package}`));
  }
  if (recorded.version !== observed.version) {
    findings.push(finding('upgrade-cap-version-advanced',
      `the UpgradeCap version moved from ${recorded.version} to ${observed.version} — an upgrade was committed`));
  }
  if (recorded.policy !== observed.policy) {
    const loosened = observed.policy < recorded.policy;
    findings.push(finding(loosened ? 'upgrade-cap-policy-loosened' : 'upgrade-cap-policy-tightened',
      `the upgrade policy moved from ${policyName(recorded.policy)} (${recorded.policy}) to `
      + `${policyName(observed.policy)} (${observed.policy})`
      + (loosened
        ? '. `sui::package` has no call that lowers a policy, so this did not happen through the '
          + 'published interface — establish what this object is before trusting it'
        : '')));
  }
  const ro = recorded.owner || {};
  const oo = observed.owner || {};
  if (ro.kind !== oo.kind || ro.address !== oo.address) {
    findings.push(finding('upgrade-cap-owner-changed',
      `the authority to upgrade this package moved from ${ro.kind}${ro.address ? ` ${ro.address}` : ''} `
      + `to ${oo.kind}${oo.address ? ` ${oo.address}` : ''}`));
  }
  return findings;
}

// One line per finding, for a CI log a person reads at eight in the morning.
export function describeFindings(findings) {
  return findings.map((f) => `  ${f.code}: ${f.detail}`);
}

// --- assembling a reading from however many pages it takes -------------------------------
//
// `request(query, variables)` is injected rather than imported so that every branch below —
// including the ones that only happen against a real endpoint, like a second module page or
// a cursor that stops advancing — is reachable from a test with no network. The one place
// `fetch` is actually called is runner/drift-watch.mjs, and it is four lines long.

export async function observePackage(request, address) {
  const addr = normaliseAddress(address);
  if (!addr.ok) return fail(`package address: ${addr.reason}`);

  const nodes = [];
  const seenCursors = new Set();
  let after = null;
  let chain = null;
  let last = null;

  for (let page = 0; ; page += 1) {
    if (page > 200) return fail('the module list did not end after 200 pages; refusing to keep asking');
    let json;
    try {
      json = await request(PACKAGE_QUERY, { address: addr.value, first: MODULE_PAGE_SIZE, after });
    } catch (err) {
      return fail(`the endpoint could not be read: ${err && err.message ? err.message : String(err)}`);
    }
    const payload = graphqlPayload(json);
    if (!payload.ok) return payload;
    const data = payload.value;
    if (!data.object || !data.object.asMovePackage) {
      // Hand the whole response to the strict parser so the caller gets its precise reason
      // — "no object at that address" and "not a Move package" are different sentences.
      return parsePackage(json);
    }
    chain = data.chainIdentifier;
    const conn = data.object.asMovePackage.modules;
    if (!conn || !Array.isArray(conn.nodes)) return fail('the package carries no `modules.nodes` array');
    nodes.push(...conn.nodes);
    last = json;
    const info = conn.pageInfo || {};
    if (info.hasNextPage !== true) break;
    if (typeof info.endCursor !== 'string' || info.endCursor.length === 0) {
      return fail('the endpoint says there is another module page but returned no cursor for it');
    }
    if (seenCursors.has(info.endCursor)) {
      // A cursor that repeats would loop forever and, worse, would silently duplicate
      // modules into the digest map. Refused as unreadable rather than assembled.
      return fail(`the endpoint repeated module cursor ${info.endCursor}; the page set is not advancing`);
    }
    seenCursors.add(info.endCursor);
    after = info.endCursor;
  }

  // Re-present the assembled pages as one complete response and let the single strict
  // parser judge it, rather than having a second, looser validation path here.
  const assembled = {
    data: {
      chainIdentifier: chain,
      object: {
        ...last.data.object,
        asMovePackage: {
          ...last.data.object.asMovePackage,
          modules: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  };
  return parsePackage(assembled);
}

export async function observeUpgradeCap(request, address) {
  const addr = normaliseAddress(address);
  if (!addr.ok) return fail(`upgrade-cap address: ${addr.reason}`);
  let json;
  try {
    json = await request(UPGRADE_CAP_QUERY, { address: addr.value });
  } catch (err) {
    return fail(`the endpoint could not be read: ${err && err.message ? err.message : String(err)}`);
  }
  return parseUpgradeCap(json);
}
