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
  test/lib.test.mjs    node --test
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

**Storage: Workers KV, and here is why.** Checked on the account on 2026-08-30: R2 is
not enabled (`10042 — Please enable R2 through the Cloudflare Dashboard`) and there are
zero KV namespaces. So the estate holds *neither* today. KV wins because it can be
provisioned entirely by API with the Workers token the estate already has — no console
trip, no terms to accept, no new vendor — and the workload suits it: manifests are 4–8 KB,
immutable, write-once-read-many, and far under KV's value-size limit. Eventual
consistency is harmless for content-addressed immutable blobs, where a read-after-write
miss is a brief 404 on a key whose content can never change.

The honest counterpoint: KV's free tier caps daily writes far lower than R2's monthly
operation allowance, so at high run volume R2 becomes the better home — and enabling R2
needs a one-time dashboard action. The store is reached through two calls (`get`/`put`)
for exactly that reason: moving to R2 later is a binding swap, not a rewrite. **Confirm
both tiers' current limits before enabling; they are quoted here from documentation, not
from a reading taken in this session.**

Wiring the runner to publish each bundle is deliberately *not* in this change. That step
is what turns it on, and turning it on for real client evidence is the Owner's call.

Build one locally from a finished gate run:

```
bash engine/ci/gates.sh <pkg> --mutation-limit 5 2>&1 | tee gates.log
bash engine/move-mutate/move-mutate.sh <pkg> --list > derive.log 2>&1
python3 engine/evidence/evidence_bundle.py --out evidence \
  --repository owner/name --commit <sha> --package-path <pkg> \
  --gates-log gates.log --mutation-report <pkg>/mutation-report.json \
  --derive-log derive.log --mutation-limit 5
```

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

**Deliberately not built yet (road 2 — after the first service dollar):**
billing/metering, multi-tenancy beyond this org, key-distance hardening for
hostile client repos, and a client-facing dashboard. Until then the app serves
the estate and demonstrates the sprints (see projectxprotocol.dev/verification).
