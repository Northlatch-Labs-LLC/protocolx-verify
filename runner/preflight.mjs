#!/usr/bin/env node
// Built-by: @projectx.sui /|\
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// preflight — the runner's front gate. Everything here happens BEFORE any client code
// is executed, and nothing here executes client code: it reads two text files and makes
// decisions about them.
//
// Modes:
//   inputs                     — validate the dispatch inputs before they reach a shell
//   config <client-dir>        — read .protocolx-verify.json; validate the package path
//   deps <client-dir> <pkg> <notes-out>
//                              — apply the dependency policy to the package's Move.toml
//
// Every mode writes its findings to $GITHUB_OUTPUT. `inputs` and `config` exit non-zero
// on a violation — there is nothing to verify. `deps` exits 0 and sets refused=1, so the
// runner can tell the client WHY on their own pull request instead of dying silently.

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateRepository, validateSha, validatePackagePath,
  parseMoveDependencies, dependencyPolicy,
} from './lib/preflight.mjs';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TOML_BYTES = 512 * 1024;

const mode = process.argv[2];
const out = process.env.GITHUB_OUTPUT;

function emit(key, value) {
  if (!out) return;
  // Multi-line values need the delimiter form; single-line ones must not use it.
  if (String(value).includes('\n')) {
    const eof = `PVS_${Math.random().toString(36).slice(2)}`;
    appendFileSync(out, `${key}<<${eof}\n${value}\n${eof}\n`);
  } else {
    appendFileSync(out, `${key}=${value}\n`);
  }
}

function fail(title, detail) {
  console.error(`::error title=${title}::${detail.replace(/\n/g, ' ')}`);
  process.exit(1);
}

function readCapped(path, limit, what) {
  const size = statSync(path).size;
  if (size > limit) fail('PVS preflight', `${what} is ${size} bytes, over the ${limit}-byte ceiling. Refusing to parse it.`);
  return readFileSync(path, 'utf8');
}

if (mode === 'inputs') {
  const repository = validateRepository(process.env.CLIENT_REPOSITORY);
  if (!repository.ok) fail('PVS runner input rejected', repository.reason);
  const sha = validateSha(process.env.HEAD_SHA);
  if (!sha.ok) fail('PVS runner input rejected', sha.reason);
  // check_runs must be a flat object of gate name → integer id. Anything else is not
  // something our own worker sent.
  let checkRuns;
  try {
    checkRuns = JSON.parse(process.env.CHECK_RUNS ?? '');
  } catch {
    fail('PVS runner input rejected', 'check_runs is not JSON');
  }
  if (!checkRuns || typeof checkRuns !== 'object' || Array.isArray(checkRuns)) {
    fail('PVS runner input rejected', 'check_runs is not an object');
  }
  for (const [gate, id] of Object.entries(checkRuns)) {
    if (!Number.isInteger(id) || id <= 0) fail('PVS runner input rejected', `check_runs["${gate}"] is not a positive integer id`);
  }
  console.log(`preflight: inputs accepted — ${repository.value} @ ${sha.value}, ${Object.keys(checkRuns).length} check runs`);
} else if (mode === 'config') {
  const clientDir = process.argv[3];
  if (!clientDir) fail('PVS preflight', 'config mode needs the client directory');
  const configPath = join(clientDir, '.protocolx-verify.json');
  if (!existsSync(configPath)) {
    emit('found', '0');
    console.log('preflight: no .protocolx-verify.json in the client repository — will post setup instructions.');
    process.exit(0);
  }
  let config;
  try {
    config = JSON.parse(readCapped(configPath, MAX_CONFIG_BYTES, '.protocolx-verify.json'));
  } catch (cause) {
    fail('PVS configuration invalid', `.protocolx-verify.json is not valid JSON: ${cause.message}`);
  }
  const pkg = validatePackagePath(config?.package);
  if (!pkg.ok) fail('PVS configuration invalid', `.protocolx-verify.json: ${pkg.reason}`);
  // A missing Move.toml is NOT a preflight failure. It is the build gate's finding, and
  // the client should read it on their pull request rather than in a runner log they
  // cannot see.
  emit('found', '1');
  emit('package', pkg.value);
  console.log(`preflight: package "${pkg.value}" accepted`);
} else if (mode === 'deps') {
  const [, , , clientDir, pkgPath, notesOut] = process.argv;
  if (!clientDir || !pkgPath || !notesOut) fail('PVS preflight', 'deps mode needs <client-dir> <package> <notes-out>');
  const pkg = validatePackagePath(pkgPath);
  if (!pkg.ok) fail('PVS configuration invalid', pkg.reason);

  const tomlPath = join(clientDir, pkg.value, 'Move.toml');
  if (!existsSync(tomlPath)) {
    // Not our refusal to make: the build gate will say "no Move.toml" on the client's
    // own pull request, which is where they can act on it.
    writeFileSync(notesOut, `No \`${pkg.value}/Move.toml\` — no dependencies to police.\n`);
    emit('refused', '0');
    emit('count', '0');
    console.log(`preflight: no Move.toml at ${pkg.value} — leaving that finding to the build gate`);
    process.exit(0);
  }
  const toml = readCapped(tomlPath, MAX_TOML_BYTES, 'Move.toml');
  const deps = parseMoveDependencies(toml);
  const { refusals, notes } = dependencyPolicy(deps, pkg.value);

  const lines = [];
  lines.push('### Dependency policy');
  lines.push('');
  lines.push(`${deps.length} declared ${deps.length === 1 ? 'dependency' : 'dependencies'} in \`${pkg.value}/Move.toml\`.`);
  lines.push('');
  if (refusals.length > 0) {
    lines.push('**Refused — nothing was fetched, built or run:**');
    lines.push('');
    for (const r of refusals) lines.push(`- ${r}`);
    lines.push('');
  }
  if (notes.length > 0) {
    lines.push('**Recorded, not blocking:**');
    lines.push('');
    for (const n of notes) lines.push(`- ${n}`);
    lines.push('');
  }
  if (refusals.length === 0 && notes.length === 0) {
    lines.push('Every declared dependency is an https git source pinned to a commit id, or a local path inside the repository.');
    lines.push('');
  }
  lines.push('ProtocolX Verify resolves https git dependencies only, inside a sandbox that holds none of our credentials. '
    + 'We do not review, mirror or vouch for third-party dependency source.');
  const body = lines.join('\n');
  writeFileSync(notesOut, `${body}\n`);

  emit('refused', refusals.length > 0 ? '1' : '0');
  emit('count', String(deps.length));
  console.log(body);
} else {
  console.error('usage: preflight.mjs inputs | config <client-dir> | deps <client-dir> <package> <notes-out>');
  process.exit(2);
}
