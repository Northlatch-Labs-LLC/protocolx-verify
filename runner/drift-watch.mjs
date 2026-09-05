#!/usr/bin/env node
// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// drift-watch — record what a verified package looks like on chain, then fail when the
// chain no longer looks like it.
//
//   node runner/drift-watch.mjs snapshot --package 0x… [--upgrade-cap 0x…] --out drift-watch.json
//   node runner/drift-watch.mjs check    --snapshot drift-watch.json
//
// Exit codes, and they are the point:
//
//   0  match       the chain still holds the recorded state
//   1  drift       it does not; every field that moved is listed
//   2  unmeasured  it could not be read, so nothing is claimed about it
//
// 2 is never folded into 1. `drift` is an accusation about somebody's live deployment and a
// flaky endpoint must not be able to make it — the same rule engine/ci/digest-of-dump.py
// follows, and for the same reason.
//
// All the logic lives in runner/lib/drift-watch.mjs, which takes its transport as an
// argument. This file is the only place a socket is opened.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ENDPOINT, buildSnapshot, compareSnapshots, describeFindings,
  observePackage, observeUpgradeCap, validateSnapshot,
} from './lib/drift-watch.mjs';

const EXIT_MATCH = 0;
const EXIT_DRIFT = 1;
const EXIT_UNMEASURED = 2;

function usage() {
  process.stderr.write(`usage:
  drift-watch snapshot --package <0x…> [--upgrade-cap <0x…>] [--endpoint <url>] [--out <file>]
  drift-watch check    --snapshot <file> [--endpoint <url>]

  --endpoint defaults to ${DEFAULT_ENDPOINT}
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return { ok: false, reason: `--${key} needs a value` };
      out[key] = next;
      i += 1;
    } else {
      out._.push(arg);
    }
  }
  return { ok: true, value: out };
}

// The only I/O in the tool. Everything it returns is handed to the pure parsers, which
// treat it as untrusted.
export function httpRequest(endpoint, timeoutMs = 30000) {
  return async function request(query, variables) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}: ${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${endpoint} answered ${res.status} with ${text.length} bytes that are not JSON`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function observe(request, packageAddress, upgradeCapAddress) {
  const pkg = await observePackage(request, packageAddress);
  if (!pkg.ok) return { ok: false, reason: `package: ${pkg.reason}` };

  let cap = null;
  let capReason = 'not requested — pass --upgrade-cap to watch who may replace this package';
  if (upgradeCapAddress) {
    const read = await observeUpgradeCap(request, upgradeCapAddress);
    if (!read.ok) return { ok: false, reason: `upgrade cap: ${read.reason}` };
    if (read.value.chain !== pkg.value.chain) {
      return { ok: false, reason: 'the package and the UpgradeCap were read from different chains' };
    }
    cap = read.value;
    capReason = null;
  }

  return {
    ok: true,
    value: buildSnapshot({
      chain: pkg.value.chain,
      pkg: pkg.value,
      upgradeCap: cap,
      upgradeCapReason: capReason,
      observedAt: new Date().toISOString(),
      endpoint: request.endpoint ?? null,
    }),
  };
}

export async function cmdSnapshot(args, request) {
  if (!args.package) { usage(); return EXIT_UNMEASURED; }
  const observed = await observe(request, args.package, args['upgrade-cap']);
  if (!observed.ok) {
    process.stderr.write(`drift-watch: UNMEASURED — ${observed.reason}\n`);
    return EXIT_UNMEASURED;
  }
  const json = `${JSON.stringify(observed.value, null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, json);
    process.stdout.write(`drift-watch: recorded ${observed.value.package.moduleCount} module(s) of `
      + `${observed.value.package.address} at version ${observed.value.package.version} → ${args.out}\n`);
    if (observed.value.upgradeCapReason) {
      process.stdout.write(`drift-watch: no UpgradeCap recorded — ${observed.value.upgradeCapReason}\n`);
    }
  } else {
    process.stdout.write(json);
  }
  return EXIT_MATCH;
}

export async function cmdCheck(args, request) {
  if (!args.snapshot) { usage(); return EXIT_UNMEASURED; }

  let recorded;
  try {
    recorded = JSON.parse(readFileSync(args.snapshot, 'utf8'));
  } catch (err) {
    process.stderr.write(`drift-watch: UNMEASURED — could not read ${args.snapshot}: ${err.message}\n`);
    return EXIT_UNMEASURED;
  }
  const valid = validateSnapshot(recorded);
  if (!valid.ok) {
    process.stderr.write(`drift-watch: UNMEASURED — ${args.snapshot}: ${valid.reason}\n`);
    return EXIT_UNMEASURED;
  }

  // The addresses come from the snapshot, never from the command line. A check whose target
  // is an argument can be pointed at a package that still matches while the one that was
  // verified has moved, and a gate that can be aimed is not a gate.
  const observed = await observe(
    request,
    recorded.package.address,
    recorded.upgradeCap && recorded.upgradeCap.address ? recorded.upgradeCap.address : null,
  );
  if (!observed.ok) {
    process.stderr.write(`drift-watch: UNMEASURED — ${observed.reason}\n`);
    process.stderr.write('This is NOT a drift verdict: the chain was not read, so nothing is said of it.\n');
    return EXIT_UNMEASURED;
  }

  const result = compareSnapshots(recorded, observed.value);
  if (result.verdict === 'unmeasured') {
    process.stderr.write(`drift-watch: UNMEASURED — ${result.reason}\n`);
    return EXIT_UNMEASURED;
  }
  if (result.verdict === 'match') {
    process.stdout.write(`drift-watch: MATCH — ${recorded.package.address} is still version `
      + `${recorded.package.version} with the ${recorded.package.moduleCount} module digest(s) `
      + `recorded on ${recorded.observedAt}\n`);
    if (recorded.upgradeCapReason) {
      process.stdout.write(`drift-watch: note — ${recorded.upgradeCapReason}\n`);
    }
    return EXIT_MATCH;
  }

  process.stdout.write(`drift-watch: DRIFT — the chain no longer holds the state recorded on ${recorded.observedAt}\n`);
  for (const line of describeFindings(result.findings)) process.stdout.write(`${line}\n`);
  process.stdout.write('\nWhat this means: the bytecode or the upgrade authority behind this package is not '
    + 'the one that was verified.\nRe-verify the live package against its source with `sui client verify-source`, '
    + 'then re-record this\nsnapshot in the same commit as the review that accepted the change.\n');
  return EXIT_DRIFT;
}

export async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) { process.stderr.write(`drift-watch: ${parsed.reason}\n`); usage(); return EXIT_UNMEASURED; }
  const args = parsed.value;
  const command = args._[0];
  const endpoint = args.endpoint || DEFAULT_ENDPOINT;
  const request = httpRequest(endpoint);
  request.endpoint = endpoint;

  if (command === 'snapshot') return cmdSnapshot(args, request);
  if (command === 'check') return cmdCheck(args, request);
  usage();
  return EXIT_UNMEASURED;
}

// Only when run as a program. Imported by a test, this file opens nothing — compared as
// resolved URLs rather than by filename, because a suffix test on argv[1] would also match
// a sibling whose name merely ends the same way.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
