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

import { verifyWebhookSignature, appJwt, routeEvent, GATES, checkName, timingSafeEqual } from './lib.js';
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
      });
    }

    if (url.pathname === '/usage' && request.method === 'GET') return serveUsage(request, env, url);

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

    // Authenticate as the App, then as this specific installation — the installation
    // token is scoped to exactly the repositories the client granted, nothing wider.
    const jwt = await appJwt(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY);
    const { token } = await gh(`/app/installations/${route.installationId}/access_tokens`, jwt, { method: 'POST' });

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
