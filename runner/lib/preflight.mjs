// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// preflight — everything we decide about a stranger's repository BEFORE any of its code
// runs, expressed as pure functions so it can be tested without a runner.
//
// Two jobs:
//
//   1. VALIDATE EVERY VALUE THAT REACHES A SHELL. The runner interpolates a client's
//      `package` path, and the dispatch inputs, into command lines. Every one of those
//      is checked against an allowlist here first. An allowlist, not an escape: escaping
//      is a claim about a parser you did not write, and the parser here is bash.
//
//   2. DECIDE THE DEPENDENCY POLICY. A client's Move.toml can point `sui move build` at
//      any git URL. That is not a theoretical reach — git's `ext::` transport runs a
//      shell command as the transport, so `git = "ext::sh -c ..."` in a Move.toml is
//      remote code execution in our runner with no exploit required. The URL scheme is
//      therefore an allowlist of exactly one entry: https.
//
//      What we DO NOT claim: that a pinned https dependency is safe. It is third-party
//      source we neither wrote, mirror, nor review, fetched over a network we do not
//      control, and compiled by us. The honest posture is that we resolve it inside a
//      sandbox with no credentials, and we say so — see README.md, "Dependency reach".

// --- values that reach a shell -----------------------------------------------------

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export function validateRepository(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'repository is empty' };
  if (value.length > 140) return { ok: false, reason: 'repository is implausibly long' };
  if (!REPO_RE.test(value)) return { ok: false, reason: `repository "${value}" is not owner/name` };
  return { ok: true, value };
}

export function validateSha(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'head sha is not a string' };
  if (!SHA_RE.test(value)) return { ok: false, reason: `head sha "${value}" is not a 40-character lowercase hex commit id` };
  return { ok: true, value };
}

// The package path is the single most dangerous value in the system: it comes from a
// file in the stranger's repository and ends up as an argument to bash. It must be a
// plain relative path inside the checkout — nothing else is a package directory.
export function validatePackagePath(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'config has no "package" string' };
  // Exactly "." — the package IS the repository root, the commonest open-source Move
  // layout. Allowed as a whole value only: "." as a path SEGMENT stays rejected below,
  // because "a/./b" is a path trying to be clever and a root package is not.
  if (value === '.') return { ok: true, value: '.' };
  if (value.length > 200) return { ok: false, reason: 'package path is implausibly long' };
  if (value.startsWith('/')) return { ok: false, reason: 'package path must be relative to the repository root' };
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value)) {
    return { ok: false, reason: 'package path may contain only letters, digits, dot, underscore, dash and forward slash' };
  }
  const segments = value.split('/');
  if (segments.some((s) => s === '' )) return { ok: false, reason: 'package path has an empty path segment' };
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'package path may not walk upwards' };
  if (segments.some((s) => s === '.')) return { ok: false, reason: 'package path may not contain "." segments' };
  return { ok: true, value };
}

// --- Move.toml dependency parsing ---------------------------------------------------
//
// Regex rather than a TOML parser for the same reason the mutation engine's deps.py
// uses one: no new runtime dependencies, and this reads the two shapes Move packages
// actually use. It errs toward seeing MORE dependency-shaped things, not fewer — a
// parser that misses an entry here is a parser that waves an attacker through.

const stripComments = (text) => text
  .split('\n')
  .map((line) => {
    let out = '';
    let inString = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"') inString = !inString;
      if (c === '#' && !inString) break;
      out += c;
    }
    return out;
  })
  .join('\n');

const field = (text, key) => {
  const m = text.match(new RegExp(`(?:^|[,{\\s])${key}\\s*=\\s*"([^"\\n]*)"`));
  return m ? m[1] : null;
};

export function parseMoveDependencies(tomlText) {
  const text = stripComments(String(tomlText ?? ''));
  const deps = [];

  // Shape A: inline tables under a [dependencies] / [dev-dependencies] header.
  const lines = text.split('\n');
  let inDeps = false;
  let sectionDep = null;
  let sectionBuf = [];
  const flushSection = () => {
    if (sectionDep) deps.push(makeDep(sectionDep, sectionBuf.join('\n')));
    sectionDep = null;
    sectionBuf = [];
  };

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      flushSection();
      const path = header[1].trim();
      // Shape B: [dependencies.Name] / [dev-dependencies.Name]
      const m = path.match(/^(?:dev-)?dependencies\.(.+)$/);
      if (m) {
        inDeps = false;
        sectionDep = m[1].replace(/^"|"$/g, '').trim();
      } else {
        inDeps = /^(?:dev-)?dependencies$/.test(path);
      }
      continue;
    }
    if (sectionDep) { sectionBuf.push(line); continue; }
    if (!inDeps) continue;
    const entry = line.match(/^\s*("?)([A-Za-z0-9_.-]+)\1\s*=\s*(\{.*)$/);
    if (entry) deps.push(makeDep(entry[2], entry[3]));
  }
  flushSection();
  return deps;
}

function makeDep(name, body) {
  const git = field(body, 'git');
  const local = field(body, 'local');
  const rev = field(body, 'rev');
  const subdir = field(body, 'subdir');
  let kind = 'other';
  if (git !== null) kind = 'git';
  else if (local !== null) kind = 'local';
  return { name, kind, git, local, rev, subdir, raw: body.trim() };
}

// --- the policy ----------------------------------------------------------------------

const SAFE_HTTPS_URL = /^https:\/\/[A-Za-z0-9._~-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._~\-/%]*$/;
const SAFE_REV = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PINNED_REV = /^[0-9a-f]{40}$/;

// Where a `local = "..."` dependency is allowed to point. `pkgPath` and the result are
// both repo-relative, with "" meaning the repository root.
export function resolveLocalDep(pkgPath, localPath) {
  const segments = [...pkgPath.split('/').filter(Boolean), ...String(localPath).split('/')];
  const out = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length === 0) return null; // escaped the repository root
      out.pop();
      continue;
    }
    out.push(s);
  }
  return out.join('/');
}

/**
 * Classify every dependency. `refusals` stop the run before a single client byte is
 * compiled; `notes` are recorded and reported but do not stop anything, because a
 * warning that fails the build is a gate, and we do not add gates by stealth.
 */
export function dependencyPolicy(deps, pkgPath = '') {
  const refusals = [];
  const notes = [];

  for (const dep of deps) {
    if (dep.kind === 'git') {
      const url = dep.git ?? '';
      if (!SAFE_HTTPS_URL.test(url)) {
        refusals.push(
          `dependency "${dep.name}": git source ${JSON.stringify(url)} is not a plain https:// URL. `
          + 'ProtocolX Verify resolves https git dependencies only. Other git transports — ext::, '
          + 'file:, git:, ssh: and scp-style host:path — either execute a command as the transport '
          + 'or read the runner\'s filesystem, so they are refused before anything is fetched.',
        );
        continue;
      }
      if (dep.rev === null) {
        notes.push(`dependency "${dep.name}": no rev — resolved to whatever the default branch points at today, so this run is not reproducible.`);
      } else if (!SAFE_REV.test(dep.rev)) {
        refusals.push(
          `dependency "${dep.name}": rev ${JSON.stringify(dep.rev)} contains characters that are not valid in a git ref. `
          + 'A rev reaches git as an argument; one that can start with "-" or carry a shell metacharacter is refused.',
        );
      } else if (!PINNED_REV.test(dep.rev)) {
        notes.push(
          `dependency "${dep.name}": rev "${dep.rev}" is a branch or tag, not a commit id. `
          + 'It can move under you between runs; a green result today is not a claim about tomorrow.',
        );
      }
      continue;
    }
    if (dep.kind === 'local') {
      const local = dep.local ?? '';
      if (local.startsWith('/')) {
        refusals.push(`dependency "${dep.name}": local path ${JSON.stringify(local)} is absolute. Local dependencies must live inside the repository.`);
        continue;
      }
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(local)) {
        refusals.push(`dependency "${dep.name}": local path ${JSON.stringify(local)} contains characters that are not allowed in a package path.`);
        continue;
      }
      if (resolveLocalDep(pkgPath, local) === null) {
        refusals.push(
          `dependency "${dep.name}": local path ${JSON.stringify(local)} resolves outside the repository. `
          + 'The mutation engine copies a package plus its local dependency closure, so a path that '
          + 'escapes the checkout is a request to copy our runner, not your package.',
        );
      }
      continue;
    }
    notes.push(`dependency "${dep.name}": neither a git nor a local source — left to the Move toolchain to resolve or reject.`);
  }

  return { refusals, notes };
}
