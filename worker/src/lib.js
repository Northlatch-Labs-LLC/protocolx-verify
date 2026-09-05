// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
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

// --- how wide a stolen token is ------------------------------------------------------
//
// `POST /app/installations/:id/access_tokens` with an empty body mints a token carrying
// EVERY permission the App holds on EVERY repository in the installation. That is the
// default, and it is the wrong default for us: an installation on an org with forty
// repositories hands the runner a key to all forty in order to verify one commit in one
// of them.
//
// This narrows both axes to what the job at hand actually needs. GitHub enforces the
// narrowing server-side, so the resulting token cannot be widened by anything that
// steals it — the blast radius of a leak is one repository and two permissions for the
// token's remaining lifetime.
//
// Note the `repositories` field takes bare NAMES, not owner/name; passing owner/name is
// a silent 422 that reads like a permissions problem.
export const RUNNER_TOKEN_PERMISSIONS = { contents: 'read', checks: 'write', metadata: 'read' };
export const WORKER_TOKEN_PERMISSIONS = { checks: 'write', metadata: 'read' };

export function installationTokenRequest(repository, permissions) {
  const body = { permissions };
  if (typeof repository === 'string' && repository.includes('/')) {
    const name = repository.slice(repository.indexOf('/') + 1);
    if (name) body.repositories = [name];
  }
  return body;
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

// What the sweep should write onto each check run that is still unfinished.
//
// THE ONE HARD RULE. "We measured this and could not tell you" is not "this never
// ran". The sweep exists because silence must not read as a pass — but a gate whose
// verdict is sitting in the engine's log, unposted because a GitHub call failed, has
// a verdict. Marking it "gate never reported" would destroy a measurement we actually
// have and would tell the client their code was never checked when it was.
//
// So the sweep reads the log first. A gate the engine ruled on is re-posted with its
// real verdict; only a gate the engine never ruled on gets the never-ran failure.
// With no log at all, nothing was measured and every unfinished gate is never-ran —
// which is correct, because in that case we genuinely have no evidence it ran.
export function sweepPlan(gatesLogText, unfinishedGates) {
  const measured = gatesLogText ? parseGatesOutput(gatesLogText) : {};
  const plan = {};
  for (const gate of unfinishedGates) {
    const result = measured[gate];
    if (result) {
      plan[gate] = {
        kind: 'measured',
        conclusion: result.conclusion,
        title: result.note.slice(0, 120) || result.conclusion,
        note:
          'Measured, then not delivered on the first attempt: this verdict came from the '
          + 'engine during the run, and the call that should have posted it did not reach '
          + 'GitHub. This is the retry. The measurement is not in doubt; only its delivery was.',
      };
    } else {
      plan[gate] = {
        kind: 'never-ran',
        conclusion: 'failure',
        title: 'gate never reported',
        note:
          'The runner ended without a verdict for this gate — it died or the gate never '
          + 'ran. The runner workflow log has the story. This is not a statement about '
          + 'your code: nothing was measured.',
      };
    }
  }
  return plan;
}

// --- the evidence bundle's digest, recomputed independently -------------------
//
// A JavaScript mirror of the canonicalisation in engine/evidence/evidence_bundle.py.
// It exists so the worker can VERIFY a manifest before storing or serving it, rather
// than taking the `bundleDigest` field's word for it. A content-addressed store that
// trusts the address it is handed is not content-addressed; it is a filing cabinet.
//
// The two implementations must agree byte for byte, so this reproduces Python's
// `json.dumps(payload, sort_keys=True, separators=(",", ":"))` exactly, including its
// ensure_ascii escaping. worker/test/lib.test.mjs proves the agreement against real
// manifests written by the Python side, including ones stuffed with the characters
// most likely to split the two — em dashes, quotes, backslashes, tabs, and emoji.
export const DIGEST_EXCLUDED_TOP_LEVEL_KEYS = ['run', 'bundleDigest'];

// Python escapes anything outside printable ASCII. JS strings are UTF-16, which is the
// same unit Python's \uXXXX escaping emits for astral characters (as surrogate pairs),
// so iterating code units here matches Python's output rather than fighting it.
function canonicalString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // Integers only, and the refusal is deliberate. Python's repr of a float and
    // JavaScript's are not the same string for every value, so a float would make the
    // two digests disagree for reasons no reader could ever diagnose. The manifest
    // contains only integer counts; if that ever changes, this must be solved before
    // the change ships, not after.
    if (!Number.isInteger(value)) {
      throw new Error('canonicalJson: non-integer number — Python and JavaScript do not '
        + 'format floats identically, so the digest could not be reproduced across them');
    }
    return String(value);
  }
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      // Python sorts by code point; JavaScript's default sort is by UTF-16 code unit.
      // They differ above the BMP. Restricting keys to printable ASCII — which every
      // key in this manifest is — makes the two orderings identical by construction
      // instead of by hope.
      if (/[^\x20-\x7e]/.test(k)) {
        throw new Error(`canonicalJson: non-ASCII object key ${JSON.stringify(k)} — key `
          + 'ordering would not match the Python canonicalisation');
      }
    }
    return `{${keys.map((k) => `${canonicalString(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: cannot serialise ${typeof value}`);
}

export async function canonicalDigest(manifest) {
  const payload = {};
  for (const key of Object.keys(manifest)) {
    if (!DIGEST_EXCLUDED_TOP_LEVEL_KEYS.includes(key)) payload[key] = manifest[key];
  }
  const bytes = te.encode(canonicalJson(payload));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}

// Words the evidence summary may not contain.
//
// A surviving mutation is an invariant no test exercises. The moment a check run
// reaches for security language it has made a claim the measurement does not
// support, and it has made it in the most visible place we own — on the client's
// own pull request.
//
// THIS LIST IS A MIRROR. The source of truth is FORBIDDEN_REPORT_TERMS in
// engine/evidence/evidence_bundle.py; engine/test/test_evidence_bundle.py parses
// this file and fails if the two ever disagree, so the copy cannot drift.
export const FORBIDDEN_SUMMARY_TERMS = [
  'vulnerabilit', 'exploit', 'severity', 'critical', 'cvss', 'cve-',
  'high risk', 'attack vector', '0-day', 'zero-day',
];

// A count is an integer or it is absent. Absent renders as its reason, never as 0:
// "0 survivors" and "survivors not measured" are different facts about a contract,
// and the check run is the one place a reviewer will actually read them.
function countOrReason(value, reason) {
  if (typeof value === 'number') return String(value);
  return `not measured (${reason || 'no reason recorded'})`;
}

function field(entry) {
  if (!entry) return 'not recorded';
  return entry.value || `not recorded — ${entry.reason ?? 'no reason recorded'}`;
}

// Render the evidence bundle into a check-run summary.
//
// WHY THIS EXISTS. The bundle is uploaded as a workflow artifact, and a workflow
// artifact is visible only to someone with Actions access and only for as long as
// the retention window. A reviewer on the pull request — the person the evidence is
// FOR — may have neither. Putting the digest and the counts in the check run itself
// makes the evidence readable by anyone who can see the pull request, with no
// download and no extra permission. The full bundle stays the artifact; this is the
// citable surface.
//
// Returns null when there is no manifest, and the caller falls back to the log
// alone. A missing bundle must never cost a client their verdicts.
export function evidenceSummary(manifest, gate) {
  if (!manifest || typeof manifest !== 'object' || !manifest.gates) return null;
  const sha = manifest.subject?.commitSha || '(commit not recorded)';
  const L = [];
  L.push('### ProtocolX Verify — evidence');
  L.push('');
  L.push(`Internal review of the code as committed at ${sha} — measured evidence, not an audit`);
  L.push('');
  L.push(`> ${manifest.independenceClause ?? ''}`);
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| bundle digest | \`${manifest.bundleDigest ?? 'not recorded'}\` |`);
  L.push(`| engine tree | \`${field(manifest.engine?.treeSha)}\` |`);
  L.push(`| sui | \`${field(manifest.toolchain?.sui)}\` |`);
  L.push(`| python3 | \`${field(manifest.toolchain?.python3)}\` |`);
  L.push(`| os | \`${field(manifest.toolchain?.os)}\` |`);
  L.push('');

  const roll = GATES.map((g) => `${g} **${manifest.gates[g]?.status ?? 'not recorded'}**`);
  L.push(`**Gates** — ${roll.join(' · ')}`);
  L.push('');

  const smoke = manifest.gates['mutation-smoke'] ?? {};
  const counts = smoke.counts;
  if (!counts) {
    L.push(`**Mutation smoke** — no counts. ${smoke.countsReason || 'no reason recorded'}`);
    L.push('');
  } else {
    const u = counts.unavailable ?? {};
    L.push('**Mutation smoke** — '
      + `in package ${countOrReason(counts.derivable, u.derivable)}`
      + ` · limit ${countOrReason(counts.limit, u.limit)}`
      + ` · derived ${countOrReason(counts.derived, u.derived)}`
      + ` · executed ${countOrReason(counts.executed, u.executed)}`
      + ` · killed ${countOrReason(counts.killed, u.killed)}`
      + ` · survived ${countOrReason(counts.survived, u.survived)}`
      + ` · did not compile ${countOrReason(counts.invalidDidNotCompile, u.invalidDidNotCompile)}`
      + ` · excluded ${countOrReason(counts.excluded?.total, u.excluded)}`
      + ` · skipped ${countOrReason(counts.skipped?.total, u.skipped)}`);
    L.push('');
    // The reason breakdown goes only on the gate it belongs to. Repeating it on all
    // five rows would bury the one verdict each row exists to deliver.
    if (gate === 'mutation-smoke') {
      const by = counts.excluded?.byReason;
      if (by && Object.keys(by).length > 0) {
        L.push('Excluded from derivation, by the engine\'s own reason:');
        L.push('');
        for (const reason of Object.keys(by).sort()) L.push(`- ${reason}: **${by[reason]}**`);
        L.push('');
      }
      const sby = counts.skipped?.byReason;
      if (sby && Object.keys(sby).length > 0) {
        L.push('Skipped, by the engine\'s own reason:');
        L.push('');
        for (const reason of Object.keys(sby).sort()) L.push(`- ${reason}: **${sby[reason]}**`);
        L.push('');
      }
      if (smoke.survivorMeaning) {
        L.push(smoke.survivorMeaning);
        L.push('');
      }
    }
  }

  L.push(manifest.absenceConvention ?? '');
  L.push('');
  L.push('The digest is sha256 over this run\'s manifest with its volatile fields '
    + '(timestamps, workflow run identifiers, absolute paths) excluded, so re-running '
    + 'the same commit on the same toolchain reproduces it. The full bundle — '
    + '`manifest.json` and `REPORT.md` — is attached to the runner workflow run.');
  return L.join('\n');
}
