// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// Unit tests for the pure logic — run with: node --test worker/test/
// The crypto tests verify against Node's own crypto as the independent implementation:
// the HMAC expectation is computed with createHmac, and the App JWT's RS256 signature is
// checked with crypto.verify against a keypair generated fresh per run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify as rsaVerify } from 'node:crypto';

import {
  verifyWebhookSignature,
  appJwt,
  pemToPkcs8Bytes,
  routeEvent,
  parseGatesOutput,
  timingSafeEqual,
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
