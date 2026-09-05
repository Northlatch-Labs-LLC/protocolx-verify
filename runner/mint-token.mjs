#!/usr/bin/env node
// Built-by: @projectx.sui
// Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// Mints a GitHub App installation token inside the runner workflow: App JWT (signed with
// the private key held as an Actions secret) exchanged for a short-lived token scoped to
// the client's installation. The token is masked before it is written anywhere, so it can
// never appear in a log line.

import { appendFileSync } from 'node:fs';
import { appJwt, installationTokenRequest, RUNNER_TOKEN_PERMISSIONS } from '../worker/src/lib.js';

const appId = process.env.GH_APP_ID;
const privateKeyPem = process.env.GH_APP_PRIVATE_KEY;
const installationId = process.env.INSTALLATION_ID;
const repository = process.env.CLIENT_REPOSITORY;
const outputFile = process.env.GITHUB_OUTPUT;

for (const [name, value] of [
  ['GH_APP_ID', appId],
  ['GH_APP_PRIVATE_KEY', privateKeyPem],
  ['INSTALLATION_ID', installationId],
  ['CLIENT_REPOSITORY', repository],
  ['GITHUB_OUTPUT', outputFile],
]) {
  if (!value) {
    console.error(`mint-token: missing ${name} — refusing to mint a token from partial configuration`);
    process.exit(2);
  }
}

const jwt = await appJwt(appId, privateKeyPem);
// Narrowed on both axes at the moment of minting. An empty body would mint a token
// carrying every permission the App holds on every repository in the installation; this
// job fetches ONE repository and writes check runs on it, so that is all it asks for.
// GitHub enforces the narrowing, so a token stolen out of this job cannot be widened.
const scope = installationTokenRequest(repository, RUNNER_TOKEN_PERMISSIONS);
const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
  method: 'POST',
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${jwt}`,
    'user-agent': 'protocolx-verify',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  },
  body: JSON.stringify(scope),
});
const body = await response.json().catch(() => ({}));
if (!response.ok || !body.token) {
  console.error(`mint-token: GitHub answered ${response.status}: ${body.message ?? 'no message'}`);
  process.exit(1);
}

// Mask FIRST, then write the output — order matters for what the log can ever show.
console.log(`::add-mask::${body.token}`);
appendFileSync(outputFile, `token=${body.token}\n`);
console.log(
  `mint-token: installation token minted, expires ${body.expires_at}`
  + ` — scope: ${(scope.repositories ?? ['<all granted>']).join(',')}`
  + ` · ${Object.entries(scope.permissions).map(([k, v]) => `${k}:${v}`).join(' ')}`,
);
