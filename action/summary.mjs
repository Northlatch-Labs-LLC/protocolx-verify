#!/usr/bin/env node
// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// summary — the Action's verdict step. Reads the gate battery's own output (the same
// lines parseGatesOutput was written for), writes the step summary a developer
// actually reads, publishes the outputs, and carries the verdict in its exit code.
//
// THE ONE HARD RULE, inherited from the runner's sweep: silence must not read as a
// pass. A gate the engine never ruled on is reported "never-reported" and fails the
// run — but a gate the engine DID rule on keeps its real verdict whatever else
// happened, because destroying a measurement to tidy up a report is the worst thing
// this tool could do.
//
// Degrades gracefully by design: with no manifest (the bundle could not be written)
// the verdicts still stand and the summary says they carry no digest; with no gates
// log at all, nothing was measured and every gate is never-reported, which is
// correct — in that case we genuinely have no evidence anything ran.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { parseGatesOutput, GATES } from './gates-output.mjs';

const [gatesLogPath, manifestPath] = process.argv.slice(2);

function readIfThere(path) {
  try {
    return path && existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

const gatesLog = readIfThere(gatesLogPath);
let manifest = null;
const manifestRaw = readIfThere(manifestPath);
if (manifestRaw) {
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    manifest = null;
  }
}

// --- verdicts, from the engine's own lines -----------------------------------------
const measured = gatesLog ? parseGatesOutput(gatesLog) : {};
const verdicts = {};
for (const gate of GATES) {
  const r = measured[gate];
  if (!r) verdicts[gate] = 'never-reported';
  else if (r.conclusion === 'success') verdicts[gate] = 'pass';
  else if (r.conclusion === 'failure') verdicts[gate] = 'fail';
  else verdicts[gate] = 'skipped';
}
const failedGates = GATES.filter((g) => verdicts[g] === 'fail' || verdicts[g] === 'never-reported');

// --- the mutation line ---------------------------------------------------------------
// executed / killed / survived / invalid, from the bundle's counts when it exists —
// the bundle's discipline is that an unmeasured count serialises as null with a
// reason, never as zero, and this line keeps that: unmeasured prints as "?".
const counts = manifest?.gates?.['mutation-smoke']?.counts ?? null;
const n = (v) => (v === null || v === undefined ? '?' : String(v));
const mutationLine = counts
  ? `executed ${n(counts.executed)} · killed ${n(counts.killed)} · survived ${n(counts.survived)} · invalid (did not compile) ${n(counts.invalidDidNotCompile)}`
  : 'counts unmeasured — no evidence manifest for this run';

// --- the step summary ----------------------------------------------------------------
const icon = { pass: '✅', fail: '❌', skipped: '⏭️', 'never-reported': '❌' };
const note = {};
for (const gate of GATES) {
  const r = measured[gate];
  if (!r) note[gate] = 'the engine never ruled on this gate — reported as a failure, because "never ran" must not read as "passed"';
  else if (r.conclusion === 'neutral') note[gate] = r.note || 'skipped';
  else note[gate] = r.note || '';
}

const L = [];
L.push('## ProtocolX Verify');
L.push('');
L.push(failedGates.length === 0
  ? 'All five gates ruled, none failed. Measured evidence, not an audit.'
  : `**${failedGates.length} gate${failedGates.length === 1 ? '' : 's'} did not pass.** Measured evidence, not an audit.`);
L.push('');
L.push('| gate | verdict | |');
L.push('|---|---|---|');
for (const gate of GATES) {
  L.push(`| ${gate} | ${icon[verdicts[gate]]} ${verdicts[gate]} | ${note[gate]} |`);
}
L.push('');
L.push(`**Mutation smoke** — ${mutationLine}`);
if (counts) {
  L.push('');
  L.push(`In the package: ${n(counts.derivable)} derivable mutation${counts.derivable === 1 ? '' : 's'}; this run executed up to the configured limit of ${n(counts.limit)}. A survivor is a production guard no test exercises.`);
}
L.push('');
if (manifest?.bundleDigest) {
  L.push(`**Evidence bundle** — digest \`${manifest.bundleDigest}\`. The digest is sha256 over this run's manifest with its volatile fields excluded, so re-running the same commit on the same toolchain reproduces it. The bundle (\`manifest.json\`, \`REPORT.md\`) is attached to this workflow run as an artifact.`);
} else {
  L.push('**Evidence bundle** — not written for this run. The gate verdicts above are unaffected; they simply carry no digest.');
}
L.push('');

// The licence, stated where the person who adopted the action actually reads. This runs
// entirely inside the client's CI and phones nowhere, so there is nothing here to meter
// and nothing here to enforce; the terms travel with the output instead. Keep it to one
// line.
L.push('> **Licence** — Business Source License 1.1, in full at `LICENSE` in the action\'s repository. Running ProtocolX Verify in your own CI against code you own is granted at no charge, including in production, and you are meant to read the source: the sandbox is only credible if you can check it. Offering it to others as a hosted or resold verification service needs a commercial licence. On 2030-08-30 it converts to Apache-2.0. This run metered nothing and transmitted nothing. Contact: kaela@projectxprotocol.dev.');
L.push('');

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${L.join('\n')}\n`);
}
console.log(L.join('\n'));

// --- outputs and the exit code -------------------------------------------------------
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `verdicts=${JSON.stringify(verdicts)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `bundle_digest=${manifest?.bundleDigest ?? ''}\n`);
  const survived = counts?.survived;
  appendFileSync(process.env.GITHUB_OUTPUT, `survived=${survived === null || survived === undefined ? '' : survived}\n`);
}

if (failedGates.length > 0) {
  console.error(`::error title=ProtocolX Verify::${failedGates.length} gate${failedGates.length === 1 ? '' : 's'} did not pass: ${failedGates.join(', ')}`);
  process.exit(1);
}
console.log('ALL GATES PASS');
