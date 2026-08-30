#!/usr/bin/env node
// Built-by: @projectx.sui /|\
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// Turns the engine's output into GitHub check-run verdicts on the client's commit.
//
// THE MEASUREMENT IS THE PRODUCT; REPORTING IS HOW WE HAND IT OVER. Nothing in this
// file may be able to stop a measurement, and nothing in this file may erase one.
// Two rules follow, and both are load-bearing:
//
//   1. `start` is decoration. Flipping five rows from queued to in_progress tells the
//      client we are alive. It is not evidence of anything, and a GitHub outage during
//      it must not cost the client their gates. It therefore never throws and always
//      exits 0; the workflow additionally runs it `continue-on-error`.
//   2. `sweep` must not conflate "measured, could not deliver" with "never ran". A
//      gate whose verdict is in the engine's log HAS a verdict. Overwriting it with
//      "gate never reported" would destroy a real measurement and tell the client
//      their code was never checked when it was. sweepPlan() in worker/src/lib.js
//      makes that distinction and is unit-tested on both branches.
//
// Modes:
//   start                  — flip every check run to in_progress (best effort, never
//                            fatal: this is a liveness signal, not a measurement)
//   report <gates.log> [manifest.json]
//                          — parse the engine's log; complete each gate that reported.
//                            When the evidence manifest is given, its digest and counts
//                            ride in the check-run summary: a workflow artifact needs
//                            Actions access and expires, but a check run is readable by
//                            anyone who can see the pull request, forever.
//                            Every gate is attempted even after one fails, so a single
//                            bad call cannot cost the client the other four verdicts.
//                            Exits non-zero if any post failed — "measured, could not
//                            report" is a loud failure of our service, and the evidence
//                            bundle is still written and uploaded regardless.
//   setup-needed           — client repo has no config; complete all gates neutral with
//                            the setup instructions (a fresh install must not fail red)
//   refuse <notes-file>    — the dependency policy refused this repository; complete all
//                            gates as failure carrying the reason. A refusal the client
//                            cannot read is indistinguishable from us being broken.
//   sweep [gates.log]      — complete anything still unfinished: with the measured
//                            verdict where one exists, and only otherwise as the
//                            never-ran failure. Runs in an always() step and exits 0.
//   revoke                 — hand the installation token back. GitHub mints these with a
//                            one-hour life and gives us no way to ask for less, so the
//                            only lever on "how long is a stolen copy useful" is to end
//                            it ourselves the moment the job is done with it.
//
// Env: CLIENT_TOKEN (installation token), CLIENT_REPOSITORY (owner/repo),
//      CHECK_RUNS (JSON map gate → check-run id).

import { appendFileSync, readFileSync } from 'node:fs';
import { parseGatesOutput, evidenceSummary, sweepPlan, GATES } from '../worker/src/lib.js';

const token = process.env.CLIENT_TOKEN;
const repository = process.env.CLIENT_REPOSITORY;
const checkRunsJson = process.env.CHECK_RUNS;
const mode = process.argv[2];

if (!mode || !['start', 'report', 'setup-needed', 'sweep', 'refuse', 'revoke'].includes(mode)) {
  console.error(
    'usage: report-gates.mjs start|report <gates.log> [manifest.json]'
    + '|setup-needed|refuse <notes>|sweep [gates.log]|revoke',
  );
  process.exit(2);
}
for (const [name, value] of [
  ['CLIENT_TOKEN', token],
  ['CLIENT_REPOSITORY', repository],
  ['CHECK_RUNS', checkRunsJson],
]) {
  if (!value) {
    console.error(`report-gates: missing ${name}`);
    // sweep and revoke run in always() steps: when the token was never minted there is
    // nothing to sweep or revoke WITH — exit clean so the workflow's real failure stays
    // the visible one.
    process.exit(mode === 'sweep' || mode === 'revoke' ? 0 : 2);
  }
}
const checkRuns = JSON.parse(checkRunsJson);

async function ghCheckRun(id, method, body) {
  const response = await fetch(`https://api.github.com/repos/${repository}/check-runs/${id}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'protocolx-verify',
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`check-run ${id} ${method} → ${response.status}: ${parsed.message ?? ''}`);
  return parsed;
}

const SETUP_TEXT = [
  'ProtocolX Verify is installed, but this repository has no configuration yet.',
  '',
  'Add a `.protocolx-verify.json` at the repository root:',
  '',
  '```json',
  '{ "package": "sui-contracts" }',
  '```',
  '',
  'where `package` is the directory containing your Move.toml. The next push runs the gates.',
].join('\n');

// "Measured, could not report" — the phrase the workflow log and the job summary must
// both carry, because it is the one state a reader could otherwise mistake for "not
// measured". Written to $GITHUB_STEP_SUMMARY when Actions gives us one.
function noteUndelivered(lines) {
  const body = ['### PVS — measured, could not report', '', ...lines, ''].join('\n');
  console.error(body);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `${body}\n`);
    } catch (cause) {
      console.error(`report-gates: could not write the job summary — ${cause.message}`);
    }
  }
}

if (mode === 'start') {
  // Best effort by design. A failure here is logged and swallowed: the client's
  // measurement must not depend on our ability to colour five rows yellow.
  const failed = [];
  for (const gate of GATES) {
    try {
      await ghCheckRun(checkRuns[gate], 'PATCH', { status: 'in_progress' });
    } catch (cause) {
      failed.push(`${gate}: ${cause.message}`);
    }
  }
  if (failed.length === 0) {
    console.log('report-gates: all gates marked in_progress');
  } else {
    console.error(
      `report-gates: ${failed.length} of ${GATES.length} gates could not be marked in_progress. `
      + 'This is a liveness signal only — the gates still run and the verdicts are still '
      + 'posted at the end.\n  ' + failed.join('\n  '),
    );
  }
} else if (mode === 'setup-needed') {
  for (const gate of GATES) {
    await ghCheckRun(checkRuns[gate], 'PATCH', {
      status: 'completed',
      conclusion: 'neutral',
      output: { title: 'setup needed', summary: SETUP_TEXT },
    });
  }
  console.log('report-gates: setup instructions posted on all gates');
} else if (mode === 'revoke') {
  const response = await fetch('https://api.github.com/installation/token', {
    method: 'DELETE',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'protocolx-verify',
      'x-github-api-version': '2022-11-28',
    },
  });
  // 204 is success. Anything else is worth saying out loud — an un-revoked token is a
  // live credential for up to an hour — but it must not fail the run, because failing
  // here would be a red check run on a client whose gates were fine.
  if (response.status === 204) {
    console.log('report-gates: installation token revoked');
  } else {
    console.log(`report-gates: token revocation answered ${response.status} — it will expire on GitHub's own clock instead`);
  }
} else if (mode === 'refuse') {
  const notesPath = process.argv[3];
  if (!notesPath) {
    console.error('refuse mode needs the notes file path');
    process.exit(2);
  }
  const notes = readFileSync(notesPath, 'utf8');
  const summary = [
    'ProtocolX Verify did not run the gates on this commit. Its dependency policy refused',
    'the package before anything was fetched, compiled or executed.',
    '',
    notes,
  ].join('\n');
  for (const gate of GATES) {
    await ghCheckRun(checkRuns[gate], 'PATCH', {
      status: 'completed',
      conclusion: 'failure',
      output: { title: 'dependency policy refused this package', summary: summary.slice(0, 65000) },
    });
  }
  console.log('report-gates: dependency refusal posted on all gates');
} else if (mode === 'report') {
  const logPath = process.argv[3];
  if (!logPath) {
    console.error('report mode needs the gates log path');
    process.exit(2);
  }
  const log = readFileSync(logPath, 'utf8');
  const results = parseGatesOutput(log);

  // The evidence manifest is optional on purpose. A bundle that failed to build must
  // never cost the client their verdicts — the gates are the product, the summary is
  // the record of them.
  const manifestPath = process.argv[4];
  let manifest = null;
  if (manifestPath) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (cause) {
      console.error(`report-gates: no evidence summary — ${cause.message}`);
    }
  }

  // The whole log rides in each gate's `text` (tail-limited): the client reads WHY a
  // gate failed without ever needing access to our runner. The evidence goes in
  // `summary`, above it, because that is the half GitHub renders first and the half a
  // reviewer without Actions access has no other way to reach.
  const tail = log.length > 6000 ? `…\n${log.slice(-6000)}` : log;
  // Every gate is attempted even after one fails. Throwing on the first bad call would
  // let a single 422 on one check run cost the client the other four verdicts, which
  // are already measured and sitting in the log.
  const undelivered = [];
  for (const gate of GATES) {
    const result = results[gate];
    if (!result) continue; // silence is handled by sweep, which distinguishes it
    const evidence = evidenceSummary(manifest, gate);
    try {
      await ghCheckRun(checkRuns[gate], 'PATCH', {
        status: 'completed',
        conclusion: result.conclusion,
        output: {
          title: result.note.slice(0, 120) || result.conclusion,
          summary: evidence ?? `\`\`\`\n${tail}\n\`\`\``,
          ...(evidence ? { text: `\`\`\`\n${tail}\n\`\`\`` } : {}),
        },
      });
      console.log(`report-gates: ${gate} → ${result.conclusion}${evidence ? ' (with evidence)' : ''}`);
    } catch (cause) {
      undelivered.push(`\`${gate}\` measured **${result.conclusion}** — ${cause.message}`);
    }
  }
  if (undelivered.length > 0) {
    noteUndelivered([
      'These gates ran and produced a verdict. The call that should have posted it to '
      + 'GitHub failed. The verdicts below are real measurements, and the evidence bundle '
      + 'attached to this run contains them in full:',
      '',
      ...undelivered.map((line) => `- ${line}`),
      '',
      'The sweep step will retry them with their measured verdicts.',
    ]);
    // Loud: this is a failure of our delivery, not of the client's code. The evidence
    // bundle is still written and still uploaded — those steps are always().
    process.exitCode = 1;
  }
} else if (mode === 'sweep') {
  // The sweep reads the engine's log before it writes anything, so that a gate we
  // MEASURED but failed to deliver is retried with its real verdict instead of being
  // overwritten with "never ran". Destroying a measurement to tidy up a yellow row
  // would be the worst thing this file could do.
  const logPath = process.argv[3];
  let log = '';
  if (logPath) {
    try {
      log = readFileSync(logPath, 'utf8');
    } catch {
      // No log means nothing was measured, and every unfinished gate is genuinely
      // never-ran. That is the honest reading, so it needs no special case.
    }
  }

  const unfinished = [];
  for (const gate of GATES) {
    try {
      const current = await ghCheckRun(checkRuns[gate], 'GET');
      if (current.status !== 'completed') unfinished.push(gate);
    } catch (cause) {
      console.error(`report-gates: could not read ${gate}'s check run — ${cause.message}`);
    }
  }

  const plan = sweepPlan(log, unfinished);
  const stillUndelivered = [];
  for (const gate of unfinished) {
    const step = plan[gate];
    try {
      await ghCheckRun(checkRuns[gate], 'PATCH', {
        status: 'completed',
        conclusion: step.conclusion,
        output: { title: step.title, summary: step.note },
      });
      console.log(`report-gates: ${gate} swept → ${step.conclusion} (${step.kind})`);
    } catch (cause) {
      if (step.kind === 'measured') {
        stillUndelivered.push(`\`${gate}\` measured **${step.conclusion}** — ${cause.message}`);
      } else {
        console.error(`report-gates: ${gate} could not be swept — ${cause.message}`);
      }
    }
  }
  if (stillUndelivered.length > 0) {
    noteUndelivered([
      'These gates ran and produced a verdict, and GitHub would not accept it on either '
      + 'attempt. The check runs on the commit do not show these results. The evidence '
      + 'bundle attached to this run does:',
      '',
      ...stillUndelivered.map((line) => `- ${line}`),
    ]);
  }
  // Always 0. The sweep is the safety net that runs in an always() step; making it red
  // would bury whatever actually went wrong underneath it.
}
