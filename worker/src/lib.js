// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// The pure logic of ProtocolX Verify, shared by the Cloudflare Worker (webhook receiver)
// and the GitHub Actions runner scripts. Everything here is isomorphic — Web Crypto only,
// no Node-specific imports — so the same functions that run at the edge are the ones the
// unit tests exercise under `node --test`.

const te = new TextEncoder();

export function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesFromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('not a hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Constant-time comparison: the loop always runs full length, accumulating differences,
// so a mismatch's position leaks nothing through timing.
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// GitHub signs each webhook delivery: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, body).
export async function verifyWebhookSignature(secret, bodyBytes, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  let given;
  try {
    given = hexToBytes(signatureHeader.slice('sha256='.length));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, bodyBytes));
  return timingSafeEqual(mac, given);
}

// GitHub hands out App keys in PKCS#1 ("BEGIN RSA PRIVATE KEY"); Web Crypto imports only
// PKCS#8. Refusing with the exact conversion command beats a cryptic DataError at import.
export function pemToPkcs8Bytes(pem) {
  if (typeof pem !== 'string') throw new Error('private key must be a PEM string');
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'This is a PKCS#1 key — the format GitHub downloads. Convert it once with: ' +
        'openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem — then use app-pkcs8.pem.',
    );
  }
  const m = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (!m) throw new Error('Not a PEM private key: expected a "BEGIN PRIVATE KEY" (PKCS#8) block.');
  return bytesFromBase64(m[1].replace(/\s+/g, ''));
}

// The App JWT that authenticates us to GitHub as the App itself (RS256, 9-minute life,
// clock skew absorbed by backdating iat — both per GitHub's own guidance).
export async function appJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!appId) throw new Error('appId is required');
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8Bytes(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = b64urlFromBytes(te.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64urlFromBytes(
    te.encode(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) })),
  );
  const signingInput = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, te.encode(signingInput)));
  return `${signingInput}.${b64urlFromBytes(sig)}`;
}

// The five gates, in the exact order and spelling of engine/ci/gates.sh — these names are
// parsed back out of its output, so they are a contract, not a label.
export const GATES = ['build', 'digest', 'tests', 'pin', 'mutation-smoke'];

export function checkName(gate) {
  return `PVS · ${gate}`;
}

// Which webhook deliveries start a verification run.
//
// Deliberately pull_request-shaped: pull_request opened/synchronize/reopened starts a run,
// and check_suite is honored only for "rerequested" (the human pressing Re-run). Answering
// check_suite "requested" as well would run every push twice — once per event — and burn
// runner minutes proving the same commit.
export function routeEvent(event, payload) {
  if (event === 'ping') return { kind: 'pong' };
  const base = {
    installationId: payload?.installation?.id,
    repository: payload?.repository?.full_name,
  };
  if (event === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(payload?.action)) {
    return { kind: 'verify', ...base, headSha: payload?.pull_request?.head?.sha };
  }
  if (event === 'check_suite' && payload?.action === 'rerequested') {
    return { kind: 'verify', ...base, headSha: payload?.check_suite?.head_sha };
  }
  return { kind: 'ignore', reason: `${event ?? 'no-event'}/${payload?.action ?? 'no-action'}` };
}

// Read gates.sh output back into per-gate verdicts. The formats matched here are the
// engine's own echo lines, verbatim:
//   "── gate: build"       then "   build: PASS" | "   build: FAIL"
//   "── gate: digest — skipped (…)"          (a skipped gate never gets a PASS/FAIL line)
export function parseGatesOutput(text) {
  const results = {};
  for (const gate of GATES) {
    const skipped = text.match(new RegExp(`^── gate: ${gate} — skipped ?(.*)$`, 'm'));
    if (skipped) {
      results[gate] = { conclusion: 'neutral', note: (skipped[1] || 'skipped').trim() };
      continue;
    }
    if (new RegExp(`^   ${gate}: PASS$`, 'm').test(text)) {
      results[gate] = { conclusion: 'success', note: 'pass' };
      continue;
    }
    if (new RegExp(`^   ${gate}: FAIL$`, 'm').test(text)) {
      results[gate] = { conclusion: 'failure', note: 'fail' };
    }
    // A gate with no line at all stays absent — the runner's sweep step turns silence
    // into an explicit failure, because "never ran" must not read as "passed".
  }
  return results;
}
