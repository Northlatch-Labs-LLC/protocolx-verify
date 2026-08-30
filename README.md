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

Most projects publish adjectives; this app publishes numbers. Ordered by the Owner
2026-08-27 (brief §4.5), built 2026-08-28.

Every run also emits an **evidence bundle** — the file an auditor asks for, since a
check run is five coloured rows that live only as long as GitHub keeps the page.

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
scripts/           deploy.sh (API deploy, no wrangler) · set-worker-secret.sh
app/               REGISTRATION.md (the Owner's card) · app-manifest.json
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
   installs the pinned Sui CLI, runs `gates.sh`, and maps its output to per-gate
   verdicts. A sweep step turns any gate that never reported into an explicit failure:
   "never ran" must not read as "passed".
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
customer *and* tells the desk they are idle when they are not. The reason names the
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
- Installation tokens are short-lived, masked before first use in the runner, and
  scoped to the repositories the client actually granted.
- Every configuration value is a named secret; a missing one is a loud, named 503 —
  no defaults that widen anything.
- The runner has `contents: read` only; the client repo is fetched read-only at one
  exact commit.

## Status ledger (updated 2026-08-29, post go-live) — claims, separated

**Verified live, in production:** the full loop ran end to end on 2026-08-29 —
GitHub delivery → signature verification at the deployed worker
(protocolx-verify.primo9537.workers.dev) → five check runs on the client commit →
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

**Unit-verified:** 7 tests under `node --test` (webhook HMAC accept/reject/tamper,
RS256 JWT checked against an independent implementation, PKCS#1 trap, routing,
engine-output parsing); engine copies SHA-256-pinned via `engine/CHECKSUMS`,
enforced by CI on every PR. 31 tests under `python3 engine/test/test_evidence_bundle.py`
for the evidence bundle: its counts checked against the shipped engine's live `--list`
output and against a verbatim recorded gate run on the nested fixture, the digest proven
stable across runs and proven to move when a result moves, and an unrun gate proven to
serialise as null-with-reason rather than as zero.

25 further tests under `node --test` for the usage ledger, written against a real
`installation/created` delivery captured from our own App: an install creates a
record, an uninstall ends it without destroying history, a repository-selection
change is captured, twenty-five concurrent batches on one repository all survive,
a GitHub redelivery counts once, an unrecorded count reads as null-with-a-reason
and never as 0, a failed write reads as a floor rather than a total, a repository
whose every write failed reads as a known measurement failure rather than an idle
account, the stored records carry no trace of what the client's code contains, and
`/usage` serves nobody when its secret is unset.

**Built but inert:** the usage ledger. The code is here and tested; no KV
namespace exists and no binding is declared, so nothing is being recorded yet.
Provisioning it is two commands in `worker/wrangler.toml`.

**Deliberately not built (road 2 — after the first service dollar):** billing
itself — payment processing, cards, subscriptions, any third-party billing vendor.
The estate invoices in USDC on Sui by hand and will for its first customers; the
ledger exists so it can. Also outstanding: multi-tenancy beyond this org,
key-distance hardening for hostile client repos, and a client-facing dashboard.
Until then the app serves the estate and demonstrates the sprints (see
projectxprotocol.dev/verification).
