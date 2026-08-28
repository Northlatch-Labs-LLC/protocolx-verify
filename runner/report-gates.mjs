#!/usr/bin/env node
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// Turns the engine's output into GitHub check-run verdicts on the client's commit.
//
// Modes:
//   start                  — flip every check run to in_progress (the runner is alive)
//   report <gates.log>     — parse the engine's log; complete each gate that reported
//   setup-needed           — client repo has no config; complete all gates neutral with
//                            the setup instructions (a fresh install must not fail red)
//   sweep                  — complete anything still unfinished as failure ("never ran
//                            must not read as passed"); runs in an always() step
//
// Env: CLIENT_TOKEN (installation token), CLIENT_REPOSITORY (owner/repo),
//      CHECK_RUNS (JSON map gate → check-run id).

import { readFileSync } from 'node:fs';
import { parseGatesOutput, GATES } from '../worker/src/lib.js';

const token = process.env.CLIENT_TOKEN;
const repository = process.env.CLIENT_REPOSITORY;
const checkRunsJson = process.env.CHECK_RUNS;
const mode = process.argv[2];

if (!mode || !['start', 'report', 'setup-needed', 'sweep'].includes(mode)) {
  console.error('usage: report-gates.mjs start|report <gates.log>|setup-needed|sweep');
  process.exit(2);
}
for (const [name, value] of [
  ['CLIENT_TOKEN', token],
  ['CLIENT_REPOSITORY', repository],
  ['CHECK_RUNS', checkRunsJson],
]) {
  if (!value) {
    console.error(`report-gates: missing ${name}`);
    // sweep runs in an always() step: when the token was never minted there is nothing
    // to sweep WITH — exit clean so the workflow's real failure stays the visible one.
    process.exit(mode === 'sweep' ? 0 : 2);
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

if (mode === 'start') {
  for (const gate of GATES) {
    await ghCheckRun(checkRuns[gate], 'PATCH', { status: 'in_progress' });
  }
  console.log('report-gates: all gates marked in_progress');
} else if (mode === 'setup-needed') {
  for (const gate of GATES) {
    await ghCheckRun(checkRuns[gate], 'PATCH', {
      status: 'completed',
      conclusion: 'neutral',
      output: { title: 'setup needed', summary: SETUP_TEXT },
    });
  }
  console.log('report-gates: setup instructions posted on all gates');
} else if (mode === 'report') {
  const logPath = process.argv[3];
  if (!logPath) {
    console.error('report mode needs the gates log path');
    process.exit(2);
  }
  const log = readFileSync(logPath, 'utf8');
  const results = parseGatesOutput(log);
  // The whole log rides in each gate's summary (tail-limited): the client reads WHY a
  // gate failed without ever needing access to our runner.
  const tail = log.length > 6000 ? `…\n${log.slice(-6000)}` : log;
  for (const gate of GATES) {
    const result = results[gate];
    if (!result) continue; // silence is handled by sweep, loudly
    await ghCheckRun(checkRuns[gate], 'PATCH', {
      status: 'completed',
      conclusion: result.conclusion,
      output: { title: result.note.slice(0, 120) || result.conclusion, summary: `\`\`\`\n${tail}\n\`\`\`` },
    });
    console.log(`report-gates: ${gate} → ${result.conclusion}`);
  }
} else if (mode === 'sweep') {
  for (const gate of GATES) {
    const current = await ghCheckRun(checkRuns[gate], 'GET');
    if (current.status !== 'completed') {
      await ghCheckRun(checkRuns[gate], 'PATCH', {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'gate never reported',
          summary: 'The runner ended without a verdict for this gate — it died or the gate never ran. The runner workflow log has the story.',
        },
      });
      console.log(`report-gates: ${gate} swept → failure`);
    }
  }
}
