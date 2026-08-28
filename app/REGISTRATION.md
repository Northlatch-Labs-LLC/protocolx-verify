# Registering ProtocolX Verify — the Owner's card

Seven stations, in order. Stations 1, 3 and 5 need your hands (tokens, the app, a key);
everything else is one command. Each step says what it is before what to press.

## 1 — A Cloudflare token that can deploy workers (~2 min)

The desk's existing Cloudflare token manages DNS only — tested against the API, it
cannot touch Workers. Deploying needs its own token:

1. Open https://dash.cloudflare.com → My Profile → **API Tokens** → **Create Token**.
2. Pick the **Edit Cloudflare Workers** template → keep the defaults → Create.
3. Copy the token, then in a terminal:

```bash
cat > ~/.config/protocolx/cloudflare-workers.token
```

Paste the token, press Enter, then **Ctrl+D** (that closes the file). Then:

```bash
chmod 600 ~/.config/protocolx/cloudflare-workers.token
```

(`chmod 600` = only your user can read it.)

## 2 — Deploy the worker (one command)

```bash
CF_ACCOUNT_ID=e5f84b4c42f43ef40f16b8c4b8c26dff bash /Users/admin/WORK.CLAUDE/protocolx-verify/scripts/deploy.sh
```

That account id is yours (read live from the API). The script prints three URLs —
**save the webhook URL**; station 3 needs it. The worker answers immediately;
`/healthz` will honestly say which secrets are still missing.

## 3 — Create the GitHub App on the org (~5 min, your hands)

Open: https://github.com/organizations/Northlatch-Labs-LLC/settings/apps/new

Fill exactly:

- **GitHub App name:** `ProtocolX Verify`
- **Homepage URL:** `https://projectxprotocol.dev`
- **Webhook → Active:** checked. **Webhook URL:** the `/webhook` URL from station 2.
- **Webhook secret:** generate one first with `openssl rand -hex 32` — paste it here
  AND keep it; station 6 sets the same value on the worker.
- **Repository permissions:** Checks — Read and write · Contents — Read-only ·
  Metadata — Read-only · Pull requests — Read-only. Nothing else.
- **Subscribe to events:** Pull request, Check suite.
- **Where can this app be installed:** Only on this account.

Press **Create GitHub App**. On the app's page:

- Note the **App ID** (a number, near the top).
- Press **Generate a private key** — a `.pem` downloads. That file is a bearer key:
  it IS the app. It gets the multisig-card treatment — never committed, never pasted
  into chat, stored like the recovery cards.

GitHub's key is in an older format; convert it once (Web Crypto reads only the newer):

```bash
openssl pkcs8 -topk8 -nocrypt -in ~/Downloads/*.private-key.pem -out ~/Downloads/app-pkcs8.pem
```

## 4 — Push this repo to the org and arm the runner

The runner is this repo's own workflow; it needs to live on GitHub to be dispatchable:

```bash
gh repo create Northlatch-Labs-LLC/protocolx-verify --private --source /Users/admin/WORK.CLAUDE/protocolx-verify --push
```

Then add two Actions secrets (Settings → Secrets and variables → Actions):

- `GH_APP_ID` — the App ID number from station 3.
- `GH_APP_PRIVATE_KEY` — the full contents of `app-pkcs8.pem`.

## 5 — A dispatch token for the worker (~2 min, your hands)

The worker starts runner jobs with a fine-grained personal access token:

1. https://github.com/settings/personal-access-tokens/new
2. Resource owner: **Northlatch-Labs-LLC** · Only select repositories: **protocolx-verify**
3. Repository permissions: **Actions — Read and write**. Nothing else. Generate and copy.

## 6 — Set the worker's secrets (one command each; values via stdin, never in history)

```bash
CF_ACCOUNT_ID=e5f84b4c42f43ef40f16b8c4b8c26dff bash /Users/admin/WORK.CLAUDE/protocolx-verify/scripts/set-worker-secret.sh GH_APP_ID
```

Type the App ID, Enter, Ctrl+D. Repeat the same command shape for:

- `GH_WEBHOOK_SECRET` — the value from `openssl rand -hex 32` in station 3
- `RUNNER_REPO` — type exactly: `Northlatch-Labs-LLC/protocolx-verify`
- `RUNNER_TOKEN` — the fine-grained token from station 5
- `GH_APP_PRIVATE_KEY` — feed the file instead of typing:

```bash
CF_ACCOUNT_ID=e5f84b4c42f43ef40f16b8c4b8c26dff bash /Users/admin/WORK.CLAUDE/protocolx-verify/scripts/set-worker-secret.sh GH_APP_PRIVATE_KEY < ~/Downloads/app-pkcs8.pem
```

Check the door: open the `/healthz` URL — it should say `"ok": true, "missing": []`.

## 7 — First client: our own estate

On the app's page press **Install App** → choose the `weir` repository. Add to the weir
repo root a file `.protocolx-verify.json`:

```json
{ "package": "sui-contracts" }
```

Open any pull request. Five checks appear on it — **PVS · build, digest, tests, pin,
mutation-smoke** — run by our own engine, reported by our own app. That screenshot is
the product's first proof, on our own code, exactly as the brief ordered: prove them
in public, on ourselves first.
