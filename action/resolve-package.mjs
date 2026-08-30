#!/usr/bin/env node
// Built-by: @projectx.sui /|\
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// resolve-package — the Action's front gate for the one value a stranger's repository
// gets to choose. Nothing here executes client code: it reads at most one small JSON
// file and looks for Move.toml files by name.
//
// Resolution order, so that `uses: Northlatch-Labs-LLC/protocolx-verify@v1` with zero
// configuration does the right thing on a Move repo:
//
//   1. The `package` input, when set — explicit wins.
//   2. `.protocolx-verify.json` at the repository root — a committed, reviewable
//      answer, so the resolution does not depend on how the workflow was written.
//   3. A `Move.toml` at the repository root — the commonest open-source layout.
//   4. Exactly one `Move.toml` within three directory levels — the monorepo-with-one-
//      package layout. Two or more is ambiguous and we say so rather than guessing;
//      guessing wrong would verify the wrong contract and call it evidence.
//
// Every resolved value passes the validatePackagePath allowlist, because the value
// ends up as an argument to bash either way.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { appendFileSync } from 'node:fs';
import { validatePackagePath } from '../runner/lib/preflight.mjs';

const MAX_CONFIG_BYTES = 64 * 1024;

const workspace = process.argv[2];
if (!workspace || !existsSync(workspace)) {
  console.error('::error title=ProtocolX Verify::resolve-package needs the workspace directory');
  process.exit(1);
}

function emit(pkg, how) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `package=${pkg}\n`);
  console.log(`package resolved: "${pkg}" (${how})`);
}

function fail(detail) {
  console.error(`::error title=ProtocolX Verify::${detail.replace(/\n/g, ' ')}`);
  process.exit(1);
}

// 1. Explicit input.
const input = (process.env.INPUT_PACKAGE ?? '').trim();
if (input !== '') {
  const pkg = validatePackagePath(input);
  if (!pkg.ok) fail(`the "package" input is not a usable path: ${pkg.reason}`);
  if (!existsSync(join(workspace, pkg.value, 'Move.toml'))) {
    fail(`the "package" input points at "${pkg.value}" but there is no ${pkg.value}/Move.toml. The path is relative to the repository root.`);
  }
  emit(pkg.value, 'from the package input');
  process.exit(0);
}

// 2. The committed config file.
const configPath = join(workspace, '.protocolx-verify.json');
if (existsSync(configPath)) {
  if (statSync(configPath).size > MAX_CONFIG_BYTES) {
    fail(`.protocolx-verify.json is over the ${MAX_CONFIG_BYTES}-byte ceiling. Refusing to parse it.`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (cause) {
    fail(`.protocolx-verify.json is not valid JSON: ${cause.message}`);
  }
  const pkg = validatePackagePath(config?.package);
  if (!pkg.ok) fail(`.protocolx-verify.json: ${pkg.reason}`);
  emit(pkg.value, 'from .protocolx-verify.json');
  process.exit(0);
}

// 3. Root package.
if (existsSync(join(workspace, 'Move.toml'))) {
  emit('.', 'Move.toml at the repository root');
  process.exit(0);
}

// 4. One nested package, found by name, never by guesswork between several.
const SKIP = new Set(['node_modules', 'build', 'target', 'dist']);
function findMoveTomls(dir, depth) {
  if (depth > 3) return [];
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'Move.toml') found.push(dir);
    else if (entry.isDirectory()) found.push(...findMoveTomls(full, depth + 1));
  }
  return found;
}

const candidates = [...new Set(findMoveTomls(workspace, 1))]
  .map((dir) => relative(workspace, dir))
  .filter((rel) => rel !== '');

if (candidates.length === 1) {
  const pkg = validatePackagePath(candidates[0]);
  if (!pkg.ok) fail(`found one Move package at "${candidates[0]}" but the path fails validation: ${pkg.reason}`);
  emit(pkg.value, 'the only Move.toml in the repository');
  process.exit(0);
}

if (candidates.length > 1) {
  fail(`this repository holds ${candidates.length} Move packages (${candidates.sort().join(', ')}) and picking one would be a guess. Set the "package" input, or commit a .protocolx-verify.json with {"package": "<path>"}.`);
}

fail('no Move.toml found at the repository root or within three directory levels. If the package lives deeper, set the "package" input or commit a .protocolx-verify.json with {"package": "<path>"}.');
