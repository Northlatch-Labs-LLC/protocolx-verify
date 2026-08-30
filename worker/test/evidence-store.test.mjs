// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// The evidence permalink: the content-addressed store and the digest it is addressed by.
//
// Two things are being proved here, and the first is the load-bearing one.
//
// 1. THE DIGEST IS COMPUTED TWICE, IN TWO LANGUAGES, AND MUST AGREE. The bundle's
//    digest is produced by engine/evidence/evidence_bundle.py; the worker recomputes it
//    to verify a manifest before storing or serving it. If the two ever disagree, the
//    store rejects real bundles and the permalink is worthless. So these tests hash
//    manifests the PYTHON side actually wrote — not hand-built objects — and demand the
//    same answer, including on manifests deliberately stuffed with the characters most
//    likely to split a Python json.dumps from a JavaScript one.
//
// 2. THE STORE IS INERT UNTIL DELIBERATELY ENABLED, and refuses anything whose content
//    does not hash to its address.
//
// Run: node --test worker/test/evidence-store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalDigest, canonicalJson } from '../src/lib.js';
import worker from '../src/index.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const FIXTURES = join(REPO_ROOT, 'engine/test/fixtures');
const MEASURED_ARGS = [
  '--gates-log', join(FIXTURES, 'nested-fixture-gates.log'),
  '--mutation-report', join(FIXTURES, 'nested-fixture-mutation-report.json'),
];

// A real manifest, written by the real writer. Never a mock: a mock would drift from
// the Python canonicalisation the first time a field moved, and these tests exist
// precisely to catch that drift.
function realManifest(extraArgs = []) {
  const out = mkdtempSync(join(tmpdir(), 'pvs-store-'));
  execFileSync('python3', [
    join(REPO_ROOT, 'engine/evidence/evidence_bundle.py'),
    '--out', out,
    '--repository', 'Northlatch-Labs-LLC/nested-fixture',
    '--commit', 'eaad914a40513abb1a530340c0a2edb1d7f31e1f',
    '--package-path', 'sui-contracts',
    '--mutation-limit', '5',
    '--generated-at', '2026-08-30T00:00:00Z',
    ...extraArgs,
  ], { stdio: 'pipe' });
  return JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
}

// The smallest thing that behaves like a KV namespace binding.
function fakeKv(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    calls: { put: 0 },
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { this.calls.put += 1; map.set(key, value); },
  };
}

const ON = (kv, extra = {}) => ({
  EVIDENCE_STORE_ENABLED: 'on',
  EVIDENCE_STORE: kv,
  EVIDENCE_WRITE_TOKEN: 'a-write-token',
  ...extra,
});

const put = (body, env, { token = 'a-write-token', path = '/evidence/' } = {}) => worker.fetch(
  new Request(`https://verify.example${path}`, {
    method: 'PUT',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }),
  env,
);

const get = (hex, env) => worker.fetch(
  new Request(`https://verify.example/evidence/${hex}`), env,
);

// --- 1. the two implementations must agree ------------------------------------

test('the JavaScript digest matches the Python digest', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  assert.equal(await canonicalDigest(manifest), manifest.bundleDigest);
});

test('the two digests agree on the characters that usually split them', async () => {
  // Each of these is a real divergence risk between Python's json.dumps and
  // JavaScript's: the em dash and the emoji exercise ensure_ascii escaping (and, for
  // the emoji, surrogate pairs), the quote and backslash exercise escaping, and the
  // tab exercises the short-form escapes. Written as escapes so the source file itself
  // stays plain ASCII.
  const nasty = 'ø—"\\\t😀 Zażółć/ﬁ';
  const manifest = realManifest([...MEASURED_ARGS, '--repository', nasty]);
  assert.equal(manifest.subject.repository, nasty, 'the fixture must actually carry it');
  assert.equal(await canonicalDigest(manifest), manifest.bundleDigest);
});

test('the JavaScript digest ignores exactly what the Python side excludes', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.run.generatedAtUtc = '1999-01-01T00:00:00Z';
  tampered.run.workflow.runId = '42';
  tampered.run.mutationReportPackageAbsolutePath = '/somewhere/else';
  assert.equal(await canonicalDigest(tampered), manifest.bundleDigest);
});

test('the JavaScript digest moves when the document does', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.gates['mutation-smoke'].counts.survived = 3;
  assert.notEqual(await canonicalDigest(changed), manifest.bundleDigest);
});

test('canonicalJson refuses what it cannot reproduce across languages', () => {
  // Refusing loudly at write time beats publishing an address the other implementation
  // can never re-derive.
  assert.throws(() => canonicalJson({ n: 1.5 }), /non-integer number/);
  assert.throws(() => canonicalJson({ 'kéy': 1 }), /non-ASCII object key/);
  assert.throws(() => canonicalJson({ u: undefined }), /cannot serialise/);
});

test('canonicalJson sorts keys and emits no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
});

// --- 2. inert until deliberately enabled --------------------------------------

test('with no switch, the store serves nothing and stores nothing', async () => {
  const kv = fakeKv();
  for (const env of [{}, { EVIDENCE_STORE: kv }, { EVIDENCE_STORE_ENABLED: 'true', EVIDENCE_STORE: kv }]) {
    const r = await get('a'.repeat(64), env);
    assert.equal(r.status, 503, 'a disabled store must not serve');
    assert.equal((await r.json()).error, 'evidence store disabled');

    const w = await put({ bundleDigest: 'sha256:x' }, env);
    assert.equal(w.status, 503, 'a disabled store must not accept writes');
  }
  assert.equal(kv.calls.put, 0, 'a disabled store must not touch storage at all');
});

test('"on" is the only value that enables it', async () => {
  // Deliberately not truthy-tested: "1", "yes" and "true" all leave it off, so nobody
  // turns real client evidence public by guessing at a config value.
  for (const value of ['1', 'yes', 'true', 'ON', 'on ']) {
    const r = await get('a'.repeat(64), { EVIDENCE_STORE_ENABLED: value, EVIDENCE_STORE: fakeKv() });
    assert.equal(r.status, 503, `"${value}" must not enable the store`);
  }
});

test('enabled without a bound namespace names what is missing', async () => {
  const r = await get('a'.repeat(64), { EVIDENCE_STORE_ENABLED: 'on' });
  assert.equal(r.status, 503);
  assert.deepEqual((await r.json()).missing, ['EVIDENCE_STORE']);
});

test('healthz reports whether the store is live', async () => {
  const off = await worker.fetch(new Request('https://verify.example/healthz'), {});
  assert.equal((await off.json()).evidence_store, 'disabled');
  const on = await worker.fetch(new Request('https://verify.example/healthz'), ON(fakeKv()));
  assert.equal((await on.json()).evidence_store, 'enabled');
});

// --- 3. the address is the content --------------------------------------------

test('a real bundle round-trips, and the URL is its digest', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  const kv = fakeKv();
  const env = ON(kv);

  const w = await put(manifest, env);
  assert.equal(w.status, 201);
  const body = await w.json();
  assert.equal(body.digest, manifest.bundleDigest);
  const hex = manifest.bundleDigest.slice('sha256:'.length);
  assert.equal(body.url, `/evidence/${hex}`);

  const r = await get(hex, env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-bundle-digest'), manifest.bundleDigest);
  assert.match(r.headers.get('cache-control'), /immutable/);
  // The served document must hash to the address it was served from — that is the
  // whole promise, checked here the way a third party would check it.
  assert.equal(await canonicalDigest(await r.json()), `sha256:${hex}`);
});

test('a document whose stated digest is not its real digest is refused', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  const lying = { ...manifest, bundleDigest: `sha256:${'0'.repeat(64)}` };
  const kv = fakeKv();
  const w = await put(lying, ON(kv));
  assert.equal(w.status, 422);
  const body = await w.json();
  assert.equal(body.claimed, lying.bundleDigest);
  assert.equal(body.recomputed, manifest.bundleDigest);
  assert.equal(kv.calls.put, 0, 'nothing may be stored at a mismatched address');
});

test('an edited document cannot keep the original digest', async () => {
  // The substitution attack the content-addressing exists to stop: change a count,
  // keep the digest, hope nobody rehashes.
  const manifest = realManifest(MEASURED_ARGS);
  const edited = JSON.parse(JSON.stringify(manifest));
  edited.gates['mutation-smoke'].counts.survived = 0;
  const kv = fakeKv();
  assert.equal((await put(edited, ON(kv))).status, 422);
  assert.equal(kv.calls.put, 0);
});

test('asking for an address the document does not have is refused', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  const kv = fakeKv();
  const w = await put(manifest, ON(kv), { path: `/evidence/${'b'.repeat(64)}` });
  assert.equal(w.status, 422);
  assert.equal(kv.calls.put, 0);
});

test('writes need the token, and the wrong one is refused', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  const kv = fakeKv();
  assert.equal((await put(manifest, ON(kv), { token: 'wrong' })).status, 401);
  assert.equal((await put(manifest, ON(kv), { token: '' })).status, 401);
  assert.equal(kv.calls.put, 0);
  // Reads need nothing: the point of a permalink is that anyone can follow it.
  await put(manifest, ON(kv));
  const read = await get(manifest.bundleDigest.slice('sha256:'.length), ON(kv));
  assert.equal(read.status, 200, 'reads must need no credential at all');
});

test('the same bundle written twice is stored once', async () => {
  const manifest = realManifest(MEASURED_ARGS);
  const kv = fakeKv();
  const env = ON(kv);
  assert.equal((await put(manifest, env)).status, 201);
  const again = await put(manifest, env);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).stored, 'already');
  assert.equal(kv.calls.put, 1, 'a settled address is written once');
});

test('a missing bundle is a plain 404, not a guess', async () => {
  const r = await get('c'.repeat(64), ON(fakeKv()));
  assert.equal(r.status, 404);
});

test('a malformed address is rejected before the store is touched', async () => {
  const kv = fakeKv();
  for (const bad of ['nothex', 'a'.repeat(63), 'A'.repeat(64)]) {
    assert.equal((await get(bad, ON(kv))).status, 400, bad);
  }
});

test('the store refuses to serve content that does not match its own address', async () => {
  // Our storage, corrupted or tampered with. Serving it anyway would break the only
  // promise this endpoint makes, so it refuses and says so.
  const manifest = realManifest(MEASURED_ARGS);
  const hex = manifest.bundleDigest.slice('sha256:'.length);
  const swapped = JSON.parse(JSON.stringify(manifest));
  swapped.gates.build.status = 'fail';
  const kv = fakeKv({ [hex]: JSON.stringify(swapped) });

  const r = await get(hex, ON(kv));
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.error, 'stored bundle does not match its address');
  assert.equal(body.expected, manifest.bundleDigest);
});

test('oversized and non-JSON bodies are refused', async () => {
  const kv = fakeKv();
  const env = ON(kv);
  assert.equal((await put('x'.repeat(300 * 1024), env)).status, 413);
  assert.equal((await put('not json', env)).status, 400);
  assert.equal((await put('[1,2,3]', env)).status, 400);
  assert.equal(kv.calls.put, 0);
});

test('the webhook is untouched by any of this', async () => {
  // The permalink must not have widened or altered the front door.
  const r = await worker.fetch(new Request('https://verify.example/webhook', { method: 'POST', body: '{}' }), {});
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'unconfigured');
  const nf = await worker.fetch(new Request('https://verify.example/nope'), {});
  assert.equal(nf.status, 404);
});
