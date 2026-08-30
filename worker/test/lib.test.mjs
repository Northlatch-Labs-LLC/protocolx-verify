// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// Unit tests for the pure logic — run with: node --test worker/test/
// The crypto tests verify against Node's own crypto as the independent implementation:
// the HMAC expectation is computed with createHmac, and the App JWT's RS256 signature is
// checked with crypto.verify against a keypair generated fresh per run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify as rsaVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  verifyWebhookSignature,
  appJwt,
  pemToPkcs8Bytes,
  routeEvent,
  parseGatesOutput,
  evidenceSummary,
  timingSafeEqual,
  FORBIDDEN_SUMMARY_TERMS,
  GATES,
  checkName,
} from '../src/lib.js';

const te = new TextEncoder();

test('webhook signature: accepts the genuine HMAC and rejects everything else', async () => {
  const secret = 'a-webhook-secret';
  const body = te.encode('{"action":"opened"}');
  const genuine = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(await verifyWebhookSignature(secret, body, genuine), true);
  assert.equal(await verifyWebhookSignature('wrong-secret', body, genuine), false);
  assert.equal(await verifyWebhookSignature(secret, te.encode('tampered'), genuine), false);
  assert.equal(await verifyWebhookSignature(secret, body, genuine.slice(0, -2) + 'ff'), false);
  assert.equal(await verifyWebhookSignature(secret, body, 'sha1=deadbeef'), false);
  assert.equal(await verifyWebhookSignature(secret, body, 'sha256=nothex!!'), false);
  assert.equal(await verifyWebhookSignature(secret, body, null), false);
});

test('timingSafeEqual: equal, unequal, and length-mismatch', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test('appJwt: RS256 signature verifies against the public key, claims are honest', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const now = 1_700_000_000;
  const jwt = await appJwt('12345', pem, now);
  const [header, payload, signature] = jwt.split('.');

  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const claims = decode(payload);
  assert.equal(claims.iss, '12345');
  assert.equal(claims.iat, now - 60);
  assert.equal(claims.exp, now + 540);

  const genuine = rsaVerify(
    'sha256',
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  assert.equal(genuine, true);
});

test('pemToPkcs8Bytes: names the PKCS#1 trap with the conversion command', () => {
  assert.throws(
    () => pemToPkcs8Bytes('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'),
    /openssl pkcs8 -topk8/,
  );
  assert.throws(() => pemToPkcs8Bytes('not a key at all'), /PKCS#8/);
});

test('routeEvent: verifies on PR activity and re-run, ignores the rest', () => {
  const prPayload = {
    action: 'opened',
    installation: { id: 77 },
    repository: { full_name: 'acme/contracts' },
    pull_request: { head: { sha: 'abc123' } },
  };
  assert.deepEqual(routeEvent('pull_request', prPayload), {
    kind: 'verify',
    installationId: 77,
    repository: 'acme/contracts',
    headSha: 'abc123',
  });
  assert.equal(routeEvent('pull_request', { ...prPayload, action: 'closed' }).kind, 'ignore');

  const suitePayload = {
    action: 'rerequested',
    installation: { id: 77 },
    repository: { full_name: 'acme/contracts' },
    check_suite: { head_sha: 'def456' },
  };
  assert.equal(routeEvent('check_suite', suitePayload).kind, 'verify');
  // "requested" fires on every push alongside pull_request — answering both would run
  // every commit twice, so requested is deliberately ignored.
  assert.equal(routeEvent('check_suite', { ...suitePayload, action: 'requested' }).kind, 'ignore');

  assert.equal(routeEvent('ping', {}).kind, 'pong');
  assert.equal(routeEvent('issues', { action: 'opened' }).kind, 'ignore');
  assert.equal(routeEvent(undefined, undefined).kind, 'ignore');
});

test('parseGatesOutput: reads the engine format — pass, fail, skipped, silent', () => {
  // This block mirrors engine/ci/gates.sh's echo lines verbatim; if the engine's format
  // ever changes, this test is the tripwire that says the adapter must move with it.
  const log = [
    '── gate: build',
    '   build: PASS',
    '── gate: digest — skipped (no ci-expected-digest; not a deployed package)',
    '── gate: tests',
    '   tests: FAIL',
    '── gate: pin — skipped (no check-framework-pin.sh)',
    '',
    'GATES FAILED',
  ].join('\n');

  const results = parseGatesOutput(log);
  assert.equal(results.build.conclusion, 'success');
  assert.equal(results.digest.conclusion, 'neutral');
  assert.match(results.digest.note, /no ci-expected-digest/);
  assert.equal(results.tests.conclusion, 'failure');
  assert.equal(results.pin.conclusion, 'neutral');
  assert.equal(results['mutation-smoke'], undefined); // silence stays absent — sweep's job
});

test('gate names are stable product surface', () => {
  assert.deepEqual(GATES, ['build', 'digest', 'tests', 'pin', 'mutation-smoke']);
  assert.equal(checkName('build'), 'PVS · build');
});

// --- the evidence summary on the check run -----------------------------------
//
// These build a REAL manifest by running the Python writer against the recorded
// nested-fixture gate run, rather than hand-writing a mock. A mock of the manifest
// would drift from the writer the first time a field moved, and the renderer would
// keep passing its tests while rendering nothing on a client's pull request.

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

function realManifest(extraArgs = []) {
  const out = mkdtempSync(join(tmpdir(), 'pvs-evidence-'));
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

const FIXTURES = join(REPO_ROOT, 'engine/test/fixtures');
const MEASURED_ARGS = [
  '--gates-log', join(FIXTURES, 'nested-fixture-gates.log'),
  '--mutation-report', join(FIXTURES, 'nested-fixture-mutation-report.json'),
];

test('evidence summary carries the digest and the counts onto the check run', () => {
  const manifest = realManifest(MEASURED_ARGS);
  const summary = evidenceSummary(manifest, 'mutation-smoke');

  assert.ok(summary.includes(manifest.bundleDigest), 'the digest must be on the check run');
  assert.match(summary, /Internal review of the code as committed at eaad914a40513abb1a530340c0a2edb1d7f31e1f — measured evidence, not an audit/);
  assert.ok(summary.includes(manifest.independenceClause));
  // The engine's real numbers from the recorded run, verbatim.
  assert.match(summary, /killed 0/);
  assert.match(summary, /survived 4/);
  assert.match(summary, /executed 4/);
  assert.match(summary, /excluded 4/);
  assert.match(summary, /skipped 0/);
});

test('evidence summary renders an unmeasured count as its reason, never as zero', () => {
  // No gates log at all: nothing was measured, and the summary must say so rather
  // than printing a column of zeroes that reads as a clean run.
  const manifest = realManifest(['--gates-log', '/nonexistent/gates.log']);
  const summary = evidenceSummary(manifest, 'mutation-smoke');

  assert.match(summary, /no counts\./i);
  assert.ok(!/survived 0/.test(summary), 'an unmeasured survivor count must not render as 0');
  assert.ok(!/killed 0/.test(summary), 'an unmeasured kill count must not render as 0');
  for (const gate of GATES) assert.match(summary, new RegExp(`${gate} \\*\\*not-run\\*\\*`));
});

test('evidence summary renders a partially measured run without inventing the rest', () => {
  // The gates ran, but no unlimited derivation was recorded: the count that exists
  // is published and the one that does not is named, in the same line.
  const manifest = realManifest(MEASURED_ARGS);
  const summary = evidenceSummary(manifest, 'mutation-smoke');
  assert.match(summary, /in package not measured \(/);
  assert.match(summary, /survived 4/);
});

test('evidence summary uses no severity language, measured or not', () => {
  for (const args of [MEASURED_ARGS, ['--gates-log', '/nonexistent/gates.log']]) {
    const manifest = realManifest(args);
    for (const gate of GATES) {
      const lowered = evidenceSummary(manifest, gate).toLowerCase();
      for (const term of FORBIDDEN_SUMMARY_TERMS) {
        assert.ok(!lowered.includes(term),
          `check-run summary for ${gate} says "${term}" — a surviving mutation is an untested invariant and carries no rating`);
      }
    }
  }
});

test('the reason breakdown goes on the gate it belongs to, and nowhere else', () => {
  const manifest = realManifest(MEASURED_ARGS);
  assert.match(evidenceSummary(manifest, 'mutation-smoke'), /test-internal \(enclosing/);
  for (const gate of ['build', 'digest', 'tests', 'pin']) {
    assert.ok(!evidenceSummary(manifest, gate).includes('test-internal (enclosing'),
      `${gate} must not carry the mutation exclusion breakdown`);
  }
});

test('a missing evidence bundle costs the client nothing', () => {
  // The gates are the product; the summary is the record of them. No manifest means
  // the caller falls back to the log alone — it never means no verdict.
  assert.equal(evidenceSummary(null, 'build'), null);
  assert.equal(evidenceSummary({}, 'build'), null);
  assert.equal(evidenceSummary('not a manifest', 'build'), null);
});
