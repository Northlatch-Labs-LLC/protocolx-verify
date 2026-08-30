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
