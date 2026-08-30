// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// ProtocolX Verify — the webhook receiver, deployed as a Cloudflare Worker.
//
// A client installs the GitHub App on a repository; GitHub delivers pull-request events
// here; this worker verifies the delivery really came from GitHub, opens one check run
// per verification gate on the client's commit, and dispatches the runner workflow that
// does the actual work. The worker itself never builds anything — it is the front door,
// and the runner is the muscle.
//
// Configuration is secrets-only and every default restricts: a missing variable answers
// 503 naming what is missing, never a guess. Nothing about an org, repo, or account is
// hardcoded.

import {
  verifyWebhookSignature, appJwt, routeEvent, GATES, checkName, timingSafeEqual,
  canonicalDigest, installationTokenRequest, WORKER_TOKEN_PERMISSIONS,
} from './lib.js';
import {
  LEDGER_EVENTS, usageLedger, recordInstallationEvent, recordRunBatch, usageSnapshot,
} from './ledger.js';

const REQUIRED = ['GH_APP_ID', 'GH_WEBHOOK_SECRET', 'GH_APP_PRIVATE_KEY', 'RUNNER_REPO', 'RUNNER_TOKEN'];
const missingConfig = (env) => REQUIRED.filter((name) => !env[name]);

// --- the usage read endpoint ---------------------------------------------------
//
// GET /usage — the picture a human reads on the first of the month to write invoices.
// It is authenticated and it FAILS CLOSED: with LEDGER_READ_TOKEN unset the endpoint
// serves nobody, not even the operator, because a metering document names every
// account and repository we have ever run for and an unauthenticated one is a customer
// list on the open internet.
//
// Optional ?from= and ?to= bound the window (ISO instants). Both are stated back in the
// response, so nobody has to work out which month they are holding.
async function serveUsage(request, env, url) {
  if (!env.LEDGER_READ_TOKEN) {
    return Response.json({ error: 'unconfigured', missing: ['LEDGER_READ_TOKEN'] }, { status: 503 });
  }
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const enc = new TextEncoder();
  if (!timingSafeEqual(enc.encode(presented), enc.encode(env.LEDGER_READ_TOKEN))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await usageSnapshot(env, {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  });
  if (!result.ok) {
    // Named absence, never an empty picture. An unbound ledger answering "0 billable
    // repositories" would be the single most expensive lie this service could tell.
    return Response.json(
      {
        error: 'unconfigured',
        missing: result.missing,
        detail: 'The usage ledger is not bound, so nothing has been recorded and nothing '
          + 'can be reported. This is not a reading of zero usage.',
      },
      { status: 503 },
    );
  }
  return Response.json(result.snapshot, {
    status: 200,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

const API = 'https://api.github.com';

async function gh(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'protocolx-verify',
      'x-github-api-version': '2022-11-28',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!response.ok) {
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${response.status}: ${body.message ?? body.raw ?? 'no body'}`);
  }
  return body;
}

// --- the evidence permalink ---------------------------------------------------
//
// A published, content-addressed home for an evidence bundle: the URL IS the digest.
// A workflow artifact needs Actions access and expires; this does not. Anyone handed
// the link can re-derive sha256 over the canonical manifest and confirm the document
// matches the address, using nothing of ours — see the README for the one-liner. That
// makes the DOCUMENT self-verifying: we cannot silently substitute a different
// manifest at the same URL, because a different manifest is a different URL.
//
// What it still does not buy, stated here so nobody has to infer it: the digest proves
// WHAT the document says and that it has not been edited. It does not prove the
// measurement is true, and it does not prove WHEN it was made — this URL is served by
// us, on our clock, for as long as we choose to serve it.
//
// INERT BY DEFAULT, AND BY CONSTRUCTION. Turning this on for real client evidence is a
// product decision the Owner makes, not one a deploy makes. Three separate things must
// all be true before a single byte is stored or served:
//   1. EVIDENCE_STORE_ENABLED is exactly "on" — a deliberate switch, not a truthy value.
//   2. EVIDENCE_STORE is bound — a KV namespace that does not exist yet.
//   3. EVIDENCE_WRITE_TOKEN is set, for writes only.
// scripts/deploy.sh uploads the worker with no bindings and no vars at all, so on the
// deploy path we actually use, this feature cannot be on. That is not an oversight; it
// is the safety.
const EVIDENCE_PREFIX = '/evidence/';
const MAX_MANIFEST_BYTES = 256 * 1024;

const disabled = () => Response.json(
  {
    error: 'evidence store disabled',
    detail: 'This deployment does not publish evidence bundles. Nothing is stored and '
      + 'nothing is served. Enabling it is a deliberate configuration change.',
  },
  { status: 503 },
);

function evidenceStore(env) {
  if (env.EVIDENCE_STORE_ENABLED !== 'on') return { ok: false, response: disabled() };
  if (!env.EVIDENCE_STORE || typeof env.EVIDENCE_STORE.get !== 'function') {
    // Named absence, never a guess — the same posture as the webhook's 503.
    return {
      ok: false,
      response: Response.json(
        { error: 'unconfigured', missing: ['EVIDENCE_STORE'] },
        { status: 503 },
      ),
    };
  }
  return { ok: true, kv: env.EVIDENCE_STORE };
}

async function serveEvidence(env, digestHex) {
  const store = evidenceStore(env);
  if (!store.ok) return store.response;
  if (!/^[0-9a-f]{64}$/.test(digestHex)) {
    return Response.json({ error: 'not a sha256 hex digest' }, { status: 400 });
  }
  const body = await store.kv.get(digestHex);
  if (body === null || body === undefined) {
    return Response.json({ error: 'no evidence bundle at this digest' }, { status: 404 });
  }
  // Re-verify on the way out. The store is ours, so a mismatch here means our own
  // storage corrupted or was tampered with — and serving it anyway would break the one
  // promise this endpoint makes. Refusing loudly is the only honest answer.
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    return Response.json({ error: 'stored bundle is not JSON', digest: digestHex }, { status: 500 });
  }
  const recomputed = await canonicalDigest(manifest);
  if (recomputed !== `sha256:${digestHex}`) {
    return Response.json(
      {
        error: 'stored bundle does not match its address',
        detail: 'The document at this address does not hash to this address. It is not '
          + 'being served. This is a fault in our store, not in the bundle you asked for.',
        expected: `sha256:${digestHex}`,
        recomputed,
      },
      { status: 500 },
    );
  }
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Immutable by construction: the address is the content's hash, so this document
      // can never change without becoming a different document at a different URL.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-bundle-digest': `sha256:${digestHex}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

async function storeEvidence(request, env, expectedHex) {
  const store = evidenceStore(env);
  if (!store.ok) return store.response;
  if (!env.EVIDENCE_WRITE_TOKEN) {
    return Response.json({ error: 'unconfigured', missing: ['EVIDENCE_WRITE_TOKEN'] }, { status: 503 });
  }

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const enc = new TextEncoder();
  if (!timingSafeEqual(enc.encode(presented), enc.encode(env.EVIDENCE_WRITE_TOKEN))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const raw = await request.text();
  if (raw.length > MAX_MANIFEST_BYTES) {
    return Response.json(
      { error: 'bundle too large', limit_bytes: MAX_MANIFEST_BYTES },
      { status: 413 },
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'body is not JSON' }, { status: 400 });
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return Response.json({ error: 'body is not an evidence manifest' }, { status: 400 });
  }

  // The address is derived from the content, never accepted from the caller. And the
  // manifest's own bundleDigest must agree with it: a document whose stated digest is
  // not its actual digest is exactly the thing this store exists to make impossible.
  let recomputed;
  try {
    recomputed = await canonicalDigest(manifest);
  } catch (cause) {
    return Response.json({ error: `cannot canonicalise: ${cause.message}` }, { status: 400 });
  }
  if (manifest.bundleDigest !== recomputed) {
    return Response.json(
      {
        error: 'bundleDigest does not match the document',
        claimed: manifest.bundleDigest ?? null,
        recomputed,
      },
      { status: 422 },
    );
  }

  const key = recomputed.slice('sha256:'.length);
  if (expectedHex && expectedHex !== key) {
    return Response.json(
      { error: 'the address you asked for is not this document\'s address', asked: expectedHex, recomputed },
      { status: 422 },
    );
  }
  // Write-once. The same digest is the same bytes by definition, so a second write is
  // either a no-op or an attempt to put different content at a settled address.
  const existing = await store.kv.get(key);
  if (existing !== null && existing !== undefined) {
    return Response.json({ ok: true, digest: recomputed, stored: 'already', url: `${EVIDENCE_PREFIX}${key}` }, { status: 200 });
  }
  await store.kv.put(key, JSON.stringify(manifest));
  return Response.json({ ok: true, digest: recomputed, stored: 'new', url: `${EVIDENCE_PREFIX}${key}` }, { status: 201 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz' && request.method === 'GET') {
      const missing = missingConfig(env);
      return Response.json({
        service: 'protocolx-verify',
        ok: missing.length === 0,
        missing,
        // Reported so an operator can see at a glance whether usage is being metered,
        // rather than discovering on the first of the month that it was not.
        usage_ledger: usageLedger(env).ok ? 'recording' : 'not bound',
        // And the same for the permalink, so its state is readable without probing an
        // endpoint to find out. The two are independent: either can be live while the
        // other is dark, and this line and the one above say which is which.
        evidence_store: env.EVIDENCE_STORE_ENABLED === 'on'
          && env.EVIDENCE_STORE && typeof env.EVIDENCE_STORE.get === 'function'
          ? 'enabled' : 'disabled',
      });
    }

    if (url.pathname === '/usage' && request.method === 'GET') return serveUsage(request, env, url);

    // `/usage` above is an exact match and this is a prefix, so the two cannot shadow
    // each other whichever order they are read in. They are also independently gated:
    // `/usage` fails closed on LEDGER_READ_TOKEN, this fails closed on
    // EVIDENCE_STORE_ENABLED and its binding, and neither switch reaches the other.
    if (url.pathname.startsWith(EVIDENCE_PREFIX)) {
      const digestHex = url.pathname.slice(EVIDENCE_PREFIX.length);
      if (request.method === 'GET') return serveEvidence(env, digestHex);
      // PUT accepts either `/evidence/` (let the content name itself) or
      // `/evidence/<digest>` (state the address you expect, and be told if you are
      // wrong). The key is always derived from the content either way.
      if (request.method === 'PUT') return storeEvidence(request, env, digestHex);
      return Response.json({ error: 'method not allowed' }, { status: 405 });
    }

    if (url.pathname !== '/webhook' || request.method !== 'POST') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    const missing = missingConfig(env);
    if (missing.length > 0) {
      // Unconfigured is a deliberate, calm absence — named, not guessed around.
      return Response.json({ error: 'unconfigured', missing }, { status: 503 });
    }

    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const genuine = await verifyWebhookSignature(
      env.GH_WEBHOOK_SECRET,
      bodyBytes,
      request.headers.get('x-hub-signature-256'),
    );
    if (!genuine) return Response.json({ error: 'signature verification failed' }, { status: 401 });

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return Response.json({ error: 'body is not JSON' }, { status: 400 });
    }

    const ghEvent = request.headers.get('x-github-event');
    // GitHub's own delivery guid. It is the run counter's uniqueness key: opaque, tells
    // us nothing about the client's code, and identical across GitHub's redeliveries of
    // the same event, so a retry cannot inflate an invoice.
    const deliveryId = request.headers.get('x-github-delivery');

    // The App-lifecycle events. GitHub delivers these to a GitHub App's webhook whether
    // or not the App subscribes to them — our own delivery log proves it: the App's
    // event list does not contain "installation" and the installation/created delivery
    // arrived anyway. They start no verification; they only feed the ledger.
    if (LEDGER_EVENTS.includes(ghEvent)) {
      const ledger = await recordInstallationEvent(env, ghEvent, payload, { deliveryId });
      if (!ledger.recorded) console.error(`usage-ledger: ${ghEvent}/${payload?.action}: ${ledger.reason}`);
      return Response.json({ ok: true, event: ghEvent, action: payload?.action ?? null, ledger }, { status: 202 });
    }

    const route = routeEvent(ghEvent, payload);
    if (route.kind === 'pong') return Response.json({ ok: true, pong: true });
    if (route.kind === 'ignore') return Response.json({ ok: true, ignored: route.reason }, { status: 202 });
    if (!route.installationId || !route.repository || !route.headSha) {
      return Response.json({ error: 'event carries no installation, repository, or head sha' }, { status: 400 });
    }

    // Authenticate as the App, then as this specific installation — and narrow the
    // token on both axes before it exists. An empty request body would mint a key to
    // every repository in the installation with every permission the App holds; this
    // worker only ever opens check runs on ONE repository, so that is all it asks for.
    const jwt = await appJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY);
    const { token } = await gh(`/app/installations/${route.installationId}/access_tokens`, jwt, {
      method: 'POST',
      body: JSON.stringify(installationTokenRequest(route.repository, WORKER_TOKEN_PERMISSIONS)),
    });

    const checkRuns = {};
    for (const gate of GATES) {
      const run = await gh(`/repos/${route.repository}/check-runs`, token, {
        method: 'POST',
        body: JSON.stringify({ name: checkName(gate), head_sha: route.headSha, status: 'queued' }),
      });
      checkRuns[gate] = run.id;
    }

    try {
      const workflow = env.RUNNER_WORKFLOW || 'verify-run.yml';
      await gh(`/repos/${env.RUNNER_REPO}/actions/workflows/${workflow}/dispatches`, env.RUNNER_TOKEN, {
        method: 'POST',
        body: JSON.stringify({
          ref: env.RUNNER_REF || 'main',
          inputs: {
            installation_id: String(route.installationId),
            repository: route.repository,
            head_sha: route.headSha,
            check_runs: JSON.stringify(checkRuns),
          },
        }),
      });
    } catch (cause) {
      // No zombie "queued" rows: if the runner cannot start, every check run says so
      // instead of hanging yellow forever.
      const note = cause instanceof Error ? cause.message : String(cause);
      for (const gate of GATES) {
        await gh(`/repos/${route.repository}/check-runs/${checkRuns[gate]}`, token, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'completed',
            conclusion: 'failure',
            output: { title: 'runner did not start', summary: `The verification runner could not be dispatched: ${note}` },
          }),
        }).catch(() => {});
      }
      return Response.json({ error: `runner dispatch failed: ${note}` }, { status: 502 });
    }

    // The batch is delivered: five check runs are open on the client's commit and the
    // runner that fills them is dispatched. THAT is the billable unit, and it is counted
    // here and nowhere earlier — a batch whose runner never started returned 502 above
    // and is work we did not deliver, so it is work we do not bill.
    //
    // The ledger never blocks the client. If the count cannot be written the run still
    // stands; the failure is returned and logged so it is visible rather than silent.
    const ledger = await recordRunBatch(env, {
      installationId: route.installationId,
      repository: route.repository,
      deliveryId,
    });
    if (!ledger.recorded) {
      console.error(`usage-ledger: batch for ${route.repository} NOT counted: ${ledger.reason}`
        + ` (fault marker written: ${ledger.faultRecorded === true})`);
    }

    return Response.json(
      {
        ok: true,
        repository: route.repository,
        head_sha: route.headSha,
        check_runs: checkRuns,
        ledger,
      },
      { status: 202 },
    );
  },
};
