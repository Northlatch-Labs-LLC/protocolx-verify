#!/usr/bin/env node
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
//
// Mints a GitHub App installation token inside the runner workflow: App JWT (signed with
// the private key held as an Actions secret) exchanged for a short-lived token scoped to
// the client's installation. The token is masked before it is written anywhere, so it can
// never appear in a log line.

import { appendFileSync } from 'node:fs';
import { appJwt } from '../worker/src/lib.js';

const appId = process.env.GH_APP_ID;
const privateKeyPem = process.env.GH_APP_PRIVATE_KEY;
const installationId = process.env.INSTALLATION_ID;
const outputFile = process.env.GITHUB_OUTPUT;

for (const [name, value] of [
  ['GH_APP_ID', appId],
  ['GH_APP_PRIVATE_KEY', privateKeyPem],
  ['INSTALLATION_ID', installationId],
  ['GITHUB_OUTPUT', outputFile],
]) {
  if (!value) {
    console.error(`mint-token: missing ${name} — refusing to mint a token from partial configuration`);
    process.exit(2);
  }
}

const jwt = await appJwt(appId, privateKeyPem);
const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
  method: 'POST',
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${jwt}`,
    'user-agent': 'protocolx-verify',
    'x-github-api-version': '2022-11-28',
  },
});
const body = await response.json().catch(() => ({}));
if (!response.ok || !body.token) {
  console.error(`mint-token: GitHub answered ${response.status}: ${body.message ?? 'no message'}`);
  process.exit(1);
}

// Mask FIRST, then write the output — order matters for what the log can ever show.
console.log(`::add-mask::${body.token}`);
appendFileSync(outputFile, `token=${body.token}\n`);
console.log(`mint-token: installation token minted, expires ${body.expires_at}`);
