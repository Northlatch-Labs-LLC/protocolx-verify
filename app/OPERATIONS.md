# ProtocolX Verify

The estate's verification gates as an installable GitHub App — our own product in the
Dependabot/CodeRabbit category. A client installs the app on a repository; every pull
request gets five check runs from the ProtocolX Verification Standard's gate battery,
run by our engine, reported on their commit:

- **PVS · build** — the package compiles, on a machine that has never seen it
- **PVS · digest** — deployed-drift tripwire: source must build to the recorded digest
- **PVS · tests** — the Move suite is green
- **PVS · pin** — the framework dependency has not silently moved
- **PVS · mutation-smoke** — a slice of mutation testing per PR (the full run stays a
  scheduled job — it costs one suite run per assert)

Most projects publish adjectives; this app publishes numbers. Ordered
2026-08-27 (brief §4.5), built 2026-08-28.

Every run also emits an **evidence bundle** — the file an auditor asks for, since a
check run is five coloured rows that live only as long as GitHub keeps the page.

## The GitHub Action — the same gates, in your own CI

The App is the convenience path; the composite Action at this repository's root is
the **zero-trust path**. It runs on your runner, inside your job: no GitHub App to
install, no permission grant, no token of yours or ours changes hands, and nothing is
transmitted anywhere — there is no telemetry. If you read permission scopes for a
living, this is the door built for you.

```yaml
# .github/workflows/protocolx-verify.yml
name: ProtocolX Verify
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Northlatch-Labs-LLC/protocolx-verify@v1
```

That is the whole install on most repositories. The action finds your Move package on
its own — `.protocolx-verify.json` first (the same file the App reads), then a
`Move.toml` at the repository root, then a single nested `Move.toml`. A monorepo with
several packages sets the `package` input explicitly; the action refuses to guess
between candidates, because verifying the wrong contract and calling it evidence
would be worse than asking.

A copy-ready workflow lives at [`examples/protocolx-verify.yml`](examples/protocolx-verify.yml).

### Inputs

| input | default | meaning |
|---|---|---|
| `package` | auto-detected | path of the Move package, relative to the repository root |
| `mutation-limit` | `5` | mutations executed per run — each one costs a full test-suite run |
| `sui-version` | `mainnet-v1.77.2` | pinned Sui CLI; a floating toolchain changes what compiles without a line of your repository changing |
| `python-version` | `3.11` | pinned Python for the mutation engine |
| `upload-evidence` | `true` | attach the evidence bundle (`manifest.json`, `REPORT.md`) as a workflow artifact |

Outputs: `verdicts` (JSON map of gate → `pass` / `fail` / `skipped` / `never-reported`),
`bundle-digest`, and `survived`.

### What a run gives you

The five gates run through the same engine the App ships — not a port, the same
files — and the job's step summary carries the five verdicts, the mutation line
(`executed · killed · survived · invalid`), and the evidence bundle's reproducible
digest. The action fails the job if any gate fails **or never reported**: silence
must not read as a pass. A gate that does not apply to your repository — no
`ci-expected-digest`, no `scripts/check-framework-pin.sh` — is reported *skipped*,
never silently passed.

The same discipline the App enforces holds here, because it is the same code:

- **Your code runs sandboxed on your own runner.** Client-executing steps go through
  `runner/sandbox.sh` — an `env -i` allowlist under a dedicated unprivileged uid, in
  a staged tree that carries none of your job's environment. Your workflow's secrets
  are invisible to the code under test, including your own checkout token
  (`.git` is excluded from the staged tree). If the privilege drop cannot be made,
  the run fails; it does not fall back.
- **The tripwire.** Every file the action ships is hashed before your code is staged
  and re-hashed after it has run. If anything under `runner/`, `worker/`, `engine/`
  or `action/` changed in between, no verdict is posted.
- **The engine self-test runs first.** Before touching your code, the mutation engine
  must derive mutations from its own nested-package fixture. If it cannot, the run
  fails and the error says the fault is ours, not yours.
- **The evidence bundle degrades gracefully.** If the bundle cannot be written, the
  gate verdicts still stand — they simply carry no digest, and the summary says so.

What the action does **not** do, said plainly: it does not filter outbound network
traffic from the sandbox, and five gates are **measured evidence, not an audit** —
nothing here certifies a contract secure.

### Requirements

A Linux runner with passwordless sudo — GitHub's hosted `ubuntu-latest` has both. The
sandbox's privilege drop is mandatory (`PVS_SANDBOX_REQUIRED=1`); a runner that
cannot provide it gets a refusal, not a degraded run.

### Pricing

**Corrected 2026-08-30 by the licence ruling ("Move to BUSL"). The old wording — "free
forever on one public repository per organisation, $149/repository/month beyond that" —
applied that price to the Action, and BUSL-1.1's Additional Use Grant contradicts it: a
client may run the Action in their own CI against their own code, public or private,
in production, at no charge. Do not quote the per-repository price for the Action.**

- **The Action** — free under BUSL-1.1 for the client's own code in the client's own CI.
  Not metered, not enforced, nothing transmitted. Reselling it or hosting it for others
  needs a commercial licence.
- **The App** (this document's subject) — **$149/repository/month, annual $1,490.** This
  is a service the estate runs; the licence grant does not cover it because the client
  is not the one running it.
- **The First Report** — **$1,000**, one package, once. Ruled 2026-08-30.

Contact: kaela@projectxprotocol.dev.

### App or Action?

| | GitHub App | GitHub Action |
|---|---|---|
| install | grant the App on the repo | copy one workflow file |
| where it runs | our runner | your runner, your CI minutes |
| token flow | short-lived installation token, held by our credentialed steps only | none — no token of yours or ours changes hands |
| verdicts land as | five check runs on the commit | job status + step summary |
| evidence bundle | artifact on our runner's workflow run | artifact on your own workflow run |
| best for | teams that want zero CI wiring | teams that read permission scopes before granting them |

## Shape

```
engine/            the gate battery — byte-identical copies from verification-tools
  ci/gates.sh          ordered gates, runnable locally or in CI
  ci/digest-guard.sh   deployed-drift tripwire
  move-mutate/         systematic mutation testing
  evidence/            the evidence bundle writer (originates here, not a copy)
worker/            the front door — a Cloudflare Worker
  src/index.js         webhook receiver: verify signature → open check runs → dispatch
  src/lib.js           pure logic (crypto, routing, gate-output parsing) — unit tested
  src/ledger.js        the usage ledger: what to invoice, and what we do not know
  test/lib.test.mjs    node --test
  test/ledger.test.mjs metering, absence, privacy, and the closed door
.github/workflows/verify-run.yml   the muscle — fetches the client commit with a
                   short-lived installation token, runs the engine, reports verdicts
runner/            mint-token.mjs (App JWT → installation token) · report-gates.mjs
  sandbox.sh           runs client code with no credential in reach — see Key distance
  preflight.mjs        validates every client value before it reaches a shell or git
  lib/preflight.mjs    the pure half of that, unit tested
  test/                preflight.test.mjs · secret-distance.sh · workflow-audit.py
scripts/           deploy.sh (API deploy, no wrangler) · set-worker-secret.sh
app/               REGISTRATION.md · app-manifest.json
action.yml         the composite GitHub Action — same engine, run in the client's CI
action/            resolve-package.mjs (zero-config package discovery) · summary.mjs
                   (step summary, outputs, and the verdict exit code)
examples/          protocolx-verify.yml — the workflow a client copies
```

## How a run flows

1. GitHub delivers `pull_request` to the worker; the HMAC signature is verified
   timing-safe before anything else happens.
2. The worker mints an App JWT, exchanges it for an installation token scoped to the
   client's grant, opens five queued check runs on the head commit, and dispatches the
   runner workflow. If the runner cannot start, every check run says so — no zombie
   yellow rows.
3. The runner fetches exactly that commit, reads `.protocolx-verify.json` (no config →
   all five checks complete neutral with setup instructions, never a hostile red),
   validates the package path and the package's declared dependencies, installs the
   pinned Sui CLI, and runs `gates.sh` **inside a sandbox that holds no credential**,
   then maps its output to per-gate verdicts. A sweep step turns any gate that never
   reported into an explicit failure: "never ran" must not read as "passed". The
   installation token is handed back to GitHub as the last act of the job.
4. The run writes an evidence bundle and uploads it as a workflow artifact. It is
   written in an `always()` step, so a run that died half way through still leaves a
   record naming the gates that never reported.

## The evidence bundle

`evidence/manifest.json` (machine) and `evidence/REPORT.md` (human) carry the same
facts: repository, commit, package path, the git tree object of `engine/` at run time,
the sui / python3 / OS versions, and every gate's verdict with the mutation counts —
derivable, limit, derived, executed, killed, survived, excluded (broken down by the
engine's own reason strings), skipped, and did-not-compile.

Two rules govern it, and both are load-bearing:

- **A count that was not measured is `null` with the reason beside it, never `0`.**
  "Zero survivors" and "survivors not measured" are different facts about a contract,
  and a document that renders them identically is worse than no document.
- **A surviving mutation is an invariant no test exercises.** It is a gap in the test
  suite, not a defect found in the contract. The report is checked by the test suite
  against a list of words it may not contain, so no future edit can quietly promote a
  survivor into a security finding.

`bundleDigest` is sha256 over the canonicalised manifest with the `run` and
`bundleDigest` keys removed. Everything volatile — the generation timestamp, the
engine's start and finish times, workflow run identifiers, this repository's own HEAD,
and absolute filesystem paths — lives under `run` and is excluded, because a digest
that included them could never reproduce and so could never signal anything. Everything
else is included: re-running the same commit on the same toolchain reproduces the
digest, and a change to any verdict, count, toolchain version or to the engine tree
changes it.

### Where the evidence is visible

The digest, the toolchain, the gate roll-up and the headline counts are written into
**every check run's summary**, so a reviewer sees them on the pull request with no
Actions permission and nothing to download. The full bundle stays attached to the
runner workflow run as the artifact `evidence-<sha>`. The gate battery's log moves to
the check run's `text`, below the evidence.

The check-run summary is rendered in JavaScript (`evidenceSummary` in
`worker/src/lib.js`) and the report in Python, so the list of words neither may say
exists twice. `engine/test/test_evidence_bundle.py` reads the JavaScript mirror and
fails if the two ever disagree.

### The evidence permalink — built, not enabled

`GET /evidence/<sha256-hex>` on the worker serves a bundle's manifest, and **the URL is
the digest**. `PUT /evidence/` stores one, authenticated with `EVIDENCE_WRITE_TOKEN`.
The worker derives the address from the content and refuses any document whose stated
`bundleDigest` is not its real digest — a content-addressed store that trusts the
address it is handed is a filing cabinet, not a store. It re-verifies on the way out
too, so it will not serve a document that does not hash to the address it was asked
for, even if our own storage were corrupted.

**A third party can check it with nothing of ours.** Python standard library, no
network beyond the fetch, no code we wrote:

```
curl -s https://<worker>/evidence/<digest> | python3 -c \
'import sys,json,hashlib; m=json.load(sys.stdin); \
p={k:v for k,v in m.items() if k not in ("run","bundleDigest")}; \
print("sha256:"+hashlib.sha256(json.dumps(p,sort_keys=True,separators=(",",":")).encode()).hexdigest())'
```

If that prints the digest in the URL, the document has not been edited since we wrote
it. That is what "self-verifying" means here, and it is worth being exact about what it
does **not** mean: the digest proves *what* the document says and that it is unaltered.
It does not prove the measurement is true, and it does not prove *when* it was made —
this URL is served by us, on our clock, for as long as we choose to serve it. An
independent timestamp needs an anchor outside our control.

**It is inert.** Three things must all be true before a byte is stored or served:
`EVIDENCE_STORE_ENABLED` is exactly `"on"` (not `"true"`, not `"1"`), a KV namespace is
bound as `EVIDENCE_STORE`, and `EVIDENCE_WRITE_TOKEN` is set for writes. None is, and
the namespace does not exist. `scripts/deploy.sh` uploads the worker with no bindings
and no vars, so on the deploy path we actually use, the feature **cannot** be on. That
is the safety, not an oversight. `/healthz` reports `evidence_store: disabled`.

**Storage: Workers KV**, on the account measurement recorded once under *The usage
ledger* below — R2 not enabled, D1 unreachable with the token that runs our deploys, KV
reachable today. That table is the single record of those facts deliberately: two copies
of an account measurement in one README is two copies that will disagree by next month.

What is specific to this store rather than to that choice: manifests are 4–8 KB,
immutable, and write-once-read-many, well under KV's value-size limit, and eventual
consistency is harmless for content-addressed blobs — a read-after-write miss is a brief
404 on a key whose content can never change. Note that KV's *lack of atomic increment*,
the flaw that shaped the ledger's append-only counter, costs this store nothing: it
never increments anything.

It wants its **own namespace**, not a shared one with prefixed keys. The ledger holds a
customer list that must never be public; this holds documents whose entire purpose is to
be fetched by strangers. One namespace would mean one binding, one blast radius, and one
mistake away from serving the metering data at a public URL.

The honest counterpoint: KV's free tier caps daily writes far lower than R2's monthly
operation allowance, so at high run volume R2 becomes the better home — and enabling R2
needs that one-time console trip. The store is reached through two calls (`get`/`put`)
for exactly that reason: moving to R2 later is a binding swap, not a rewrite. **Confirm
both tiers' current limits before enabling; they are quoted from documentation, not from
a reading taken against the account.**

Wiring the runner to publish each bundle is deliberately *not* in this change. That step
is what turns it on. Turning it on for real client evidence is a deliberate decision, not a default.

Build one locally from a finished gate run:

```
bash engine/ci/gates.sh <pkg> --mutation-limit 5 2>&1 | tee gates.log
bash engine/move-mutate/move-mutate.sh <pkg> --list > derive.log 2>&1
python3 engine/evidence/evidence_bundle.py --out evidence \
  --repository owner/name --commit <sha> --package-path <pkg> \
  --gates-log gates.log --mutation-report <pkg>/mutation-report.json \
  --derive-log derive.log --mutation-limit 5
```

## The usage ledger — what to invoice

The App is priced at **$149 per repository per month**. A price with no measurement
behind it is fiction, so the worker keeps a ledger. **This is not a billing system** —
no payments, no cards, no subscriptions, no vendor. The estate invoices in USDC on Sui,
by hand, and this is the document a human reads on the first of the month to do it.

**What it records.** Per installation: the account (login, numeric id, User or
Organization), when GitHub says it was installed, whether the selection is `all` or
`selected`, which repositories are in it, when each was added or removed, when the
installation was suspended or uninstalled, and an append-only history of every
lifecycle event. Per repository: how many check-run **batches** we actually delivered
and when the most recent one was. A batch is counted only after the runner is
dispatched — a run whose runner never started is work we did not deliver, so it is work
we do not bill.

**What it deliberately does not record.** Nothing about what the client's code
contains: no findings, no survivors, no gate verdicts, no counts from the engine, no
commit shas, no file paths. Not even the head sha — the run counter's uniqueness key is
GitHub's own `X-GitHub-Delivery` guid, which is opaque, says nothing about their
repository, and de-duplicates GitHub's retries for free. A usage ledger that leaks what
we measured is a breach of the thing we sell.

**Absence is not zero, here as everywhere.** A repository with no recorded batch reads
as `{"value": null, "reason": "…"}` — never `0`, and its `billable` flag is `null`,
never `false`. The two facts are not the same: a silent zero under-bills a paying
customer *and* reports them idle when they are not. The reason names the
date the ledger began observing that installation and says plainly that a failed write
looks identical to a run that never happened. This is the convention
`engine/evidence/evidence_bundle.py` already holds the estate to, applied to money.

Three more absences are reported rather than smoothed over:

- **Degraded counts.** If a count write fails, the worker tries to leave a fault
  marker. When one exists the count is returned with `confidence: "degraded"` and the
  words *"is a floor, not a total"*. A write that failed *and* whose fault marker also
  failed is invisible in the ledger; the worker's response body and log are the only
  record, and the endpoint's `integrity.residualGap` says so out loud.
- **Unattributed batches.** Runs recorded against a repository no installation record
  claims are listed separately. That is billable work we would otherwise never invoice.
- **Truncated scans.** If the read hits its key ceiling, every count becomes
  null-with-a-reason rather than a smaller number. A partial scan under-counts, and an
  under-count is an under-invoice.

**Concurrency, and why the counter is append-only.** Workers KV has no atomic increment.
`get → n+1 → put` loses a count every time two pull requests land on one repository at
once — precisely the silent under-bill this file exists to prevent. So every delivered
batch writes its own key and the count is the number of distinct delivery guids under a
prefix. Nothing races.

**The read endpoint.** `GET /usage`, `Authorization: Bearer $LEDGER_READ_TOKEN`,
optional `?from=&to=` ISO bounds (both echoed back, so nobody has to work out which
month they are holding). It **fails closed**: with `LEDGER_READ_TOKEN` unset it serves
nobody — a metering document names every account and repository we have ever run for,
and an unauthenticated one is a customer list on the open internet. With the ledger
unbound it answers a named 503, never an empty picture, because "0 billable
repositories" is the most expensive lie this service could tell. The payload opens with
one sentence a human can act on:

> For 2026-09-01T00:00:00.000Z to 2026-10-01T00:00:00.000Z, 12 repositories across 4
> installations have at least one recorded check-run batch and are billable at the
> per-repository rate; 3 further selected repositories have no recorded batch, which is
> unmeasured usage and not zero usage, and 1 repository has recorded batches no
> installation record claims — read those two lists before you send anything.

**Event shapes are measured, not guessed.** Every field read here came out of a real
delivery our own App received, pulled from `GET /app/hook/deliveries` with an App JWT on
2026-08-30 and committed verbatim as
`worker/test/fixtures/installation-created.delivery.json`. That capture is where
`installation.created_at` being an ISO 8601 string with an offset comes from, rather than
the epoch integer older references show (both are accepted). It is also the evidence for
a fact the ledger depends on: our App's own event list does **not** contain
`installation`, and the `installation/created` delivery arrived anyway — GitHub sends
the App-lifecycle events to a GitHub App's webhook whether or not it subscribes, so the
ledger can be fed without touching the App's registration.

**Storage: Workers KV, and here is the measurement.** Taken 2026-08-30 against the
estate's own account with the estate's own Workers token:

| | result |
|---|---|
| R2 | `403 · 10042 — Please enable R2 through the Cloudflare Dashboard`. Not enabled; enabling it is a console trip. |
| D1 | `10000 Authentication error` with the estate's Workers token. The product is on the account, but the token that runs our deploys cannot provision or bind it. |
| KV | Lists clean — zero namespaces, and the estate's token reaches it today. |

So KV: it is the only one of the three the estate can provision by API with the token it
already holds, no console, no second credential, no new vendor. The honest counterpoint
is the one that chose the append-only counter — KV has no atomic increment and is
eventually consistent — and D1's SQL would be the better home the day the estate is
willing to custody a second token. The store is reached through three calls
(`get`/`put`/`list`) for exactly that reason: moving is a binding swap, not a rewrite.

**It is inert.** No KV namespace exists, no binding is declared, and `scripts/deploy.sh`
uploads the worker with no bindings at all, so today nothing is recorded and `/healthz`
reports `usage_ledger: not bound`. `worker/wrangler.toml` carries the two commands that
turn it on.

## Security posture

- Webhook: HMAC-SHA256, constant-time comparison, unsigned deliveries answered 401.
- The App private key is a bearer capability: held only as a Cloudflare secret and a
  GitHub Actions secret, custodied like the estate's multisig cards, never in git —
  `.gitignore` refuses `*.pem` and `*.token`.
- Installation tokens are minted narrow, masked before first use in the runner, and
  handed back to GitHub when the job ends.
- Every configuration value is a named secret; a missing one is a loud, named 503 —
  no defaults that widen anything.
- The runner workflow has `contents: read` only, and `actions/checkout` runs with
  `persist-credentials: false`; the client repo is fetched read-only at one exact commit.

## Key distance — running a stranger's code

This is the section that decides whether the App can be installed by people we have never
met. Everything above is about our front door. This is about the fact that **the product
is executing code written by someone who may want our secrets.**

State the threat plainly. A stranger installs the App on a repository they control. Our
runner fetches their commit and runs `sui move build`, `sui move test`, the mutation
engine, and — because `gates.sh` honours `<package>/scripts/check-framework-pin.sh` — a
shell script they wrote. In the same GitHub Actions job we hold a GitHub App installation
token, and in one step the App private key itself. If any of that client code can read
the environment, reach our files, or persist into a later step, the App is a
credential-harvesting machine pointed at ourselves.

**The rule: the steps that hold credentials and the steps that execute client code are
disjoint sets.** Six mechanisms enforce it.

1. **An empty environment, not a filtered one.** `runner/sandbox.sh` starts the client's
   command from `env -i` plus a short allowlist — `PATH`, `HOME`, `TMPDIR`, `LANG`,
   `MOVE_HOME` — and nothing else. A secret added to the workflow tomorrow is excluded by
   default rather than included by default, which is the only direction that stays correct
   as a workflow grows. The wrapper also refuses to start if a forbidden name or a
   bearer-shaped value ever reaches its allowlist.

2. **No write handle into a later step.** `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`,
   `GITHUB_STATE` and `GITHUB_STEP_SUMMARY` are not merely information — they are files
   that mutate the steps that come after. A client test that appends one line to
   `$GITHUB_PATH` puts a binary of its choosing ahead of `node` in the step that reports
   verdicts with the token. Unsetting the variable removes the address, so the write has
   nowhere to land.

3. **A different uid.** The gate battery runs as `pvs-sandbox`, a system account created
   for the job, inside `/srv/pvs` which it owns at mode 0700. `/home/runner` — the
   workspace, the Actions temp directory, the toolchain caches — has its world bits
   removed before the client's code starts, so the sandbox uid cannot traverse it. If the
   drop cannot be made, the run **fails**; `PVS_SANDBOX_REQUIRED` defaults to `1` and a
   sandbox that silently degrades is not a sandbox.

4. **The token never lands on disk.** It reaches `git` through a credential helper, not
   through a remote URL — a URL-embedded token is written verbatim into `.git/config` and
   sits there for the rest of the job, inside the very tree we are about to compile. And
   the client checkout stops being a git repository before it is staged: `.git` is a
   credential store, a hook directory and a config file we did not write.

5. **Nothing client-controlled is spliced into a shell.** GitHub substitutes `${{ }}` into
   a `run:` block as *text*, before bash parses it, so a client value there is command
   injection with no exploit needed. The package path from `.protocolx-verify.json` is
   validated against a character allowlist first and then passed as an argv element. No
   `run:` block in the runner workflow contains a `${{ }}` expression at all, and CI fails
   if one appears.

6. **A tripwire, checked rather than assumed.** Every file under `runner/`, `worker/` and
   `engine/` is hashed before the client's repository exists on the machine and re-hashed
   after its code has run. A single changed byte fails the run with a named error, before
   any credentialed step executes — a verdict posted by a script a stranger just edited is
   worse than no verdict. Credentialed steps also run from a copy staged outside the
   workspace, so the tampering would have to reach two places to matter.

**This is proved, not asserted.** `runner/test/secret-distance.sh` runs on every pull
request and has two halves. The runtime half poisons a shell with every secret the runner
really holds — App private key, installation token, dispatch PAT, webhook secret, the
Actions runtime token, the `GITHUB_*` file handles — sends a command through the real
wrapper, and reads back the environment the child actually received; it fails if any
secret-shaped *name* or any secret *value* survives, and it also fails if an innocuous
unlisted variable gets through, because that would mean the wrapper filters instead of
allowlisting. The static half (`runner/test/workflow-audit.py`) reads `verify-run.yml` and
proves the workflow *uses* the wrapper: no step is both credentialed and client-executing,
every gate-battery invocation goes through `sandbox.sh`, no `run:` block interpolates an
expression, no credential appears in a URL, and every credentialed step runs the staged
tooling copy. The first half proves the wrapper works; the second proves it is used, and
the second is the one a future edit breaks.

### Key distance and the evidence bundle

These two are orthogonal and both survive, which is worth spelling out because the
mechanisms touch the same steps.

The measurement now happens inside `/srv/pvs`, owned by a uid the workspace does not
share, so the mutation report is written where the bundle writer cannot read it. Exactly
one file is copied back out — `mutation-report.json`, refused if it is a symlink — and
the bundle writer runs outside the sandbox, over logs, as it always did. The sandbox
never gets a way to write into the workspace, and the writer never runs inside the
sandbox. `Extract the measurement from the sandbox` is an `always()` step for the same
reason the bundle build is: a run that died half way through still measured whatever it
measured, and losing that file would turn a partial measurement into a silent one.

Delivery is never a precondition of measurement. Marking check runs in progress is
`continue-on-error`, so a GitHub API hiccup costs a colour and never a gate. The bundle
is built and uploaded in `always()` steps.

**There is exactly one case where a verdict is deliberately withheld, and it is not a
delivery failure.** If the tamper tripwire fires — a file under `runner/`, `worker/` or
`engine/` changed while the client's code was running — then there is no measurement we
can vouch for, because the thing that computed it may not be the thing we shipped. The
run fails loudly, the verdict is not posted, and the bundle upload still runs so the
wreckage is on the record. Protecting a measurement from a broken API call and refusing
to publish a measurement we cannot stand behind are different rules, and neither is an
exception to the other.

### Dependency reach

A client's `Move.toml` points `sui move build` at whatever it likes, and this is where the
sharpest edge was. **Git's `ext::` transport runs a shell command as the transport**, so
`git = "ext::sh -c '…'"` in a Move.toml is remote code execution in our runner with no
exploit required. `file:` reads our filesystem. A `rev` beginning with `-` is git option
injection. A `local = "../../.."` walks out of the checkout, and the mutation engine
copies a package plus its local dependency closure — so that path is a request to copy our
runner rather than the client's package.

The policy, applied by `runner/preflight.mjs` before anything is fetched or compiled:

| Declaration | Verdict |
|---|---|
| `git = "https://…"` with `rev` = 40-hex commit | accepted, clean |
| `git = "https://…"` with `rev` = branch or tag | accepted, **recorded** as not reproducible |
| `git = "https://…"` with no `rev` | accepted, **recorded** as not reproducible |
| `git =` any other transport (`ext::`, `file:`, `git:`, `ssh:`, `user@host:path`, `http:`) | **refused** |
| `rev` containing anything outside `[A-Za-z0-9._/-]`, or leading `-` | **refused** |
| `local =` path inside the repository | accepted, clean |
| `local =` absolute path, or one that escapes the repository | **refused** |

A refusal completes all five check runs as failures carrying the reason, on the client's
own pull request. A recorded note does not fail anything — the Sui framework's own
published guidance pins to `framework/mainnet`, a *branch*, so refusing unpinned revs
would break every honest Move package on earth for no security gain. Reproducibility and
safety are different claims and we report them separately.

**The documented limitation, stated rather than implied: we do resolve arbitrary
third-party dependencies, and we cannot make that safe.** We do not mirror them, we do not
review them, and we do not vouch for them. `sui move build` needs them to compile a
package at all, so refusing to resolve them would mean refusing to run the build gate. The
damage is bounded by *where* they are resolved — a uid with no credentials, in a tree that
holds nothing of ours, on a machine that is destroyed afterwards — not by trusting the
dependency. If you need "the dependency graph was reviewed" as a claim, this product does
not make it today.

### Blast radius of the runner's token

Recorded factually, before and after, because the "before" is what the estate was running:

**Before this change.** `POST /app/installations/:id/access_tokens` was called with an
empty body. GitHub reads that as *every permission the App holds, on every repository in
the installation* — `checks:write`, `contents:read`, `metadata:read`, `pull_requests:read`
across the whole grant. A client who installs the App org-wide was handing our runner, and
therefore anyone who stole from it, a key to every repository in that org for the token's
full one-hour life. The worker's token was minted the same way, for a job that only ever
opens check runs.

**After.** The request body names one repository and the smallest permission set the job
needs: the runner asks for `contents:read` + `checks:write` + `metadata:read` on the
single repository being verified; the worker asks for `checks:write` + `metadata:read` on
the same one. GitHub enforces the narrowing server-side, so a stolen token cannot be
widened by whoever stole it. Lifetime is a fixed one hour and GitHub offers no way to ask
for less — so the job now `DELETE`s `/installation/token` as its last act, which ends the
token immediately instead of leaving a live credential in the wild for up to an hour.

The workflow's own `GITHUB_TOKEN` is `contents: read`, and `actions/checkout` no longer
persists it into `.git/config`.

### Network and persistence

Honest, and short.

**Outbound: unrestricted.** GitHub-hosted runners have unfiltered egress and we do not
filter it. The Move VM itself has no I/O, so a `sui move test` cannot open a socket — but
`sui move build` performs git fetches over the network by design, and
`scripts/check-framework-pin.sh` is arbitrary shell with a full network stack. A hostile
client can therefore make our runner talk to a host of their choosing. What that is worth
to them is the question the section above answers: at the moment they can do it, the
process holds no credential, cannot read one, and cannot reach one.

**Persistence between jobs: none on the runner.** `runs-on: ubuntu-latest` is a fresh
ephemeral VM per job, destroyed when the job ends; the runner workflow uses no
`actions/cache`, so nothing is carried forward deliberately either. The Move package cache
lives under the sandbox tree and is removed at teardown as well as dying with the VM.
Nothing a client's code writes survives to the next client's run.

**Persistence within a job** is the part that needed work, and is what mechanisms 2, 3 and
6 above are for.

## Status ledger (updated 2026-08-29, post go-live) — claims, separated

**Verified live, in production:** the full loop ran end to end on 2026-08-29 —
GitHub delivery → signature verification at the deployed worker
(protocolx-verify.$CF_WORKERS_SUBDOMAIN.workers.dev) → five check runs on the client commit →
runner dispatch → client repo fetched at the exact sha with a short-lived
installation token → gate battery → per-gate verdicts posted back. First client:
`weir` (our own mainnet SocialFi contract). First complete run surfaced two
assertions no test exercised — an ownership guard among them; both were killed by
tests the same night and the five-mutation smoke that found them now reports five
kills (weir commit: "Kill the two survivors the app found on its first run").
Registration (all seven stations of app/REGISTRATION.md) is COMPLETE. The worker
is watched by `.github/workflows/healthz.yml` every six hours — a red run is the
alert. Two first-contact defects were found and fixed live, loudly: a trailing
byte added by the secret loader (401s, caught in the app's own delivery log) and
a sed-dialect break in the mutation tool (caught by its own applied-mutation
guard, which refused to fake a kill).

**Unit-verified:** 21 tests under `node --test worker/test/lib.test.mjs` (webhook
HMAC accept/reject/tamper, RS256 JWT checked against an independent implementation,
PKCS#1 trap, routing, engine-output parsing, the evidence summary rendered on a check
run, and the installation token's scope). 11 tests under
`node --test runner/test/preflight.test.mjs` — the values a stranger's repository gets
to choose, including the `ext::` transport and the escaping `local` path. 9 assertions
under `bash runner/test/secret-distance.sh` — the runtime environment the sandboxed
child actually receives, plus a static audit of `verify-run.yml` that guards BOTH
properties: credentialed and client-executing steps disjoint, and delivery never a
precondition of measurement. 5 tests under `node --test runner/test/wiring.test.mjs`
holding the same second property from the other side: the gates cannot be skipped by a
failure to colour a check run in. 32 tests under
`python3 engine/test/test_evidence_bundle.py` for the evidence bundle: its counts
checked against the shipped engine's live `--list` output and against a verbatim
recorded gate run on the nested fixture, the digest proven stable across runs and
proven to move when a result moves, and an unrun gate proven to serialise as
null-with-reason rather than as zero. Engine copies SHA-256-pinned via
`engine/CHECKSUMS`, enforced by CI on every PR.

**Key distance: built 2026-08-29, not yet exercised against a live hostile repo.**
The mechanisms above are unit-proved and statically proved; what has NOT happened
is a full runner job on GitHub's infrastructure with the new sandbox in place. The
privilege drop (`useradd`, `sudo -u`, `chmod o-rwx /home/runner`) cannot be
exercised on a laptop, so its first real run is its first real test. Until a green
run exists on the estate's own repository, treat that specific mechanism as
designed-and-reviewed rather than as observed.

**Residual, and known:** `GH_APP_PRIVATE_KEY` is an Actions secret in this
repository, so anyone who can merge a workflow here can mint tokens for every
installation. That is a property of putting the key in Actions at all, not of this
change, and closing it means moving the mint to the worker or behind a protected
environment with required reviewers — an architectural change, deliberately not
half-done here. Outbound network egress from the sandbox is unfiltered.

25 further tests under `node --test` for the usage ledger, written against a real
`installation/created` delivery captured from our own App: an install creates a
record, an uninstall ends it without destroying history, a repository-selection
change is captured, twenty-five concurrent batches on one repository all survive,
a GitHub redelivery counts once, an unrecorded count reads as null-with-a-reason
and never as 0, a failed write reads as a floor rather than a total, a repository
whose every write failed reads as a known measurement failure rather than an idle
account, the stored records carry no trace of what the client's code contains, and
`/usage` serves nobody when its secret is unset.

21 further tests under `node --test` for the evidence permalink: the digest computed in
JavaScript is checked against manifests the Python writer actually produced — including
one carrying an em dash, an emoji, a quote, a backslash and a tab — the store is proven
silent under every value of its switch other than `"on"`, an edited document is proven
unable to keep the original digest, and a corrupted store is proven to refuse to serve
rather than break its own promise.

**Built but inert:** the usage ledger and the evidence permalink. Both are here and
tested; no KV namespace exists for either, no binding is declared, and
`scripts/deploy.sh` uploads no bindings at all, so nothing is recorded and nothing is
published. They are independent — each has its own namespace, secret and switch, and
turning one on does not touch the other. Provisioning either is two commands in
`worker/wrangler.toml`.

**Deliberately not built (road 2 — after the first service dollar):** billing
itself — payment processing, cards, subscriptions, any third-party billing vendor.
The estate invoices in USDC on Sui by hand and will for its first customers; the
ledger exists so it can. Also outstanding: multi-tenancy beyond this org and a
client-facing dashboard. Key-distance hardening for hostile client repos is no
longer on this list — see "Key distance" above for what it closed and what it did
not.
Until then the app serves the estate and demonstrates the sprints (see
projectxprotocol.dev/verification).
