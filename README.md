<!-- Built-by: @projectx.sui /|\ -->
<!-- Co-authored-by: Kaela <kaela@projectxprotocol.dev> -->

# ProtocolX Verify

Five verification gates for Sui Move packages, run inside your own CI: **build**,
**deployed-digest guard**, **tests**, **framework pin**, **mutation smoke**. Every run
leaves an evidence bundle with a reproducible digest.

---

## Read this first: a red `mutation-smoke` is the tool working

Our own end-to-end demo **fails**. On every commit to this repository the action runs
against a small Move package we ship as a fixture, and reports:

```
mutation-smoke   FAIL     executed: 4   killed: 0   survived: 4
```

That is not a broken tool. It is the only interesting thing this tool does.

`mutation-smoke` takes assertions that already exist in your package, changes them one
at a time — flips a `>=` to a `>`, moves a boundary by one, deletes a guard — and re-runs
your test suite against each change. A mutation that your suite **kills** is an invariant
your tests genuinely exercise. A mutation that **survives** is an invariant nothing you
have written would notice being broken.

The fixture has four production guards and no test that touches any of them. Four
mutations, four survivors, and a red gate. A green run there would mean the measurement
had been rigged, because the four guards would still be untested either way.

So the two things worth saying plainly, before you read another line:

- **A gate that always passes measures nothing.** If you install this and every gate is
  green on the first run, that is a fact about your suite, not a compliment from us — and
  you should check the counts, because `executed: 0` is also green.
- **A survivor is a gap in your tests, not a vulnerability in your contract.** The report
  says so in those words, in every format it emits, and the wording is enforced by a test
  so no future edit can quietly promote a survivor into a security finding.

The other four gates are conventional and mostly go green. This is the one that tells
you something you did not already know.

---

## Install

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

That is the whole install on most repositories. The action finds your Move package on its
own — `.protocolx-verify.json` first, then a `Move.toml` at the repository root, then a
single nested `Move.toml`. A monorepo with several packages sets `package:` explicitly;
the action refuses to guess between candidates, because verifying the wrong contract and
calling it evidence would be worse than asking.

A copy-ready workflow lives at
[`examples/protocolx-verify.yml`](examples/protocolx-verify.yml).

## The five gates

| gate | what it measures | when it is skipped |
|---|---|---|
| `build` | the package compiles on a machine that has never seen it | never |
| `digest` | source still builds to the digest you recorded as deployed | no `ci-expected-digest` |
| `tests` | `sui move test` is green | never |
| `pin` | the framework dependency has not silently moved | no `scripts/check-framework-pin.sh` |
| `mutation-smoke` | a sample of your assertions, mutated, against your own suite | never |

A gate that does not apply is reported **skipped**, never silently passed. A gate that
**never reported at all** is swept to an explicit failure: silence must not read as a
pass.

## Inputs

| input | default | meaning |
|---|---|---|
| `package` | auto-detected | path of the Move package, relative to the repository root |
| `mutation-limit` | `5` | mutations executed per run — each one costs a full test-suite run |
| `sui-version` | `mainnet-v1.77.2` | pinned Sui CLI; a floating toolchain changes what compiles without a line of your repository changing |
| `python-version` | `3.11` | pinned Python for the mutation engine |
| `upload-evidence` | `true` | attach the evidence bundle as a workflow artifact |

Outputs: `verdicts` (JSON map of gate → `pass` / `fail` / `skipped` / `never-reported`),
`bundle-digest`, and `survived`.

`mutation-limit` caps how many mutations are **executed**, not how many exist. The
evidence bundle records both, so a limit can never masquerade as coverage.

## How your code is kept away from your secrets

The action runs on your runner, inside your job. No token of yours or ours changes hands:
it receives no secrets, mints nothing, and transmits nothing anywhere — there is no
telemetry.

- **Your code runs sandboxed.** Every step that executes client code — `sui move build`
  fetching and compiling your declared dependencies, `sui move test` running your
  bytecode, your own `scripts/check-framework-pin.sh`, which is arbitrary shell — goes
  through [`runner/sandbox.sh`](runner/sandbox.sh): an `env -i` allowlist under a
  dedicated unprivileged uid, in a staged tree carrying nothing of your job's
  environment. `.git` is excluded from that tree, because `actions/checkout` persists
  your job token into `.git/config` by default. `GITHUB_ENV`, `GITHUB_PATH`,
  `GITHUB_OUTPUT`, `GITHUB_STATE` and `GITHUB_STEP_SUMMARY` are excluded by name: those
  are write handles into later steps, not merely information. If the privilege drop
  cannot be made the run fails; it does not fall back.
- **The tripwire.** Every file the action ships is hashed before your code is staged and
  re-hashed after it has run, both readings through the same code path
  ([`runner/tripwire.sh`](runner/tripwire.sh)). If anything changed in between, no
  verdict is posted. The engine is checked against its own recorded hashes as well.
- **The engine self-tests first.** Before touching your code, the mutation engine must
  derive mutations from its own nested-package fixture. If it cannot, the run fails and
  the error says the fault is ours, not yours.
- **The evidence bundle degrades gracefully.** If the bundle cannot be written the gate
  verdicts still stand — they simply carry no digest, and the summary says so. A recorder
  that can veto the thing it records is a recorder nobody should trust.

All of that is readable in this repository. That is the point of it being readable.

## The evidence bundle

`evidence/manifest.json` (machine) and `evidence/REPORT.md` (human) carry the same facts:
repository, commit, package path, the git tree object of `engine/` at run time, the sui /
python3 / OS versions, and every gate's verdict with the mutation counts — derivable,
limit, derived, executed, killed, survived, excluded, skipped and did-not-compile.

Two rules govern it, and both are load-bearing:

- **A count that was not measured is `null` with the reason beside it, never `0`.** "Zero
  survivors" and "survivors not measured" are different facts about a contract, and a
  document that renders them identically is worse than no document.
- **A surviving mutation is an invariant no test exercises** — a gap in the test suite,
  not a defect found in the contract.

`bundleDigest` is sha256 over the canonicalised manifest with the `run` and `bundleDigest`
keys removed. Everything volatile — timestamps, workflow run identifiers, absolute paths —
lives under `run` and is excluded, because a digest that included them could never
reproduce and so could never signal anything. Re-running the same commit on the same
toolchain reproduces the digest; a change to any verdict, count, toolchain version or to
the engine tree changes it.

## What this does not do

Said plainly rather than implied:

- It does not certify that a contract is secure. **Five gates are measured evidence, not
  an audit.**
- It does not filter outbound network traffic from the sandbox, and it does not stop the
  code under test from reading anything the world can read.
- It does not prove *when* a measurement was made. The digest proves what a document says
  and that it is unaltered. An independent timestamp needs an anchor outside anyone's
  control.
- It is not an independent review. When you run it on your own code, it is your own
  measurement of your own code, and the report says so in those words.

## Requirements

A Linux runner with passwordless sudo — GitHub's hosted `ubuntu-latest` has both. The
sandbox's privilege drop is mandatory (`PVS_SANDBOX_REQUIRED=1`); a runner that cannot
provide it gets a refusal, not a degraded run.

## Licence

**Business Source License 1.1.** Full text: [`LICENSE`](LICENSE). The parameters, in
plain words:

- **You may run this action in your own CI, against code your organisation owns or is
  entitled to modify, in production, at no charge and with no agreement to sign.** That
  is the Additional Use Grant, and it is the case almost everybody reading this is in.
- **You may read, audit, copy and modify every line.** That is not a concession, it is
  the point. A sandbox you cannot inspect is a claim, not a control — so go and read
  `runner/sandbox.sh` and `runner/tripwire.sh` before you trust either.
- **You may not offer it to other people as a hosted or resold verification service**,
  and you may not run it against someone else's code as part of a paid engagement,
  without a commercial licence from us. Ask; that conversation is a normal one.
- **On 2030-08-30 the whole thing converts to Apache-2.0** automatically, under the
  licence's own terms.

BUSL is source-available, not OSI open source. If your organisation's policy blocks
non-OSI licences in CI, tell us — that is exactly what alternative licensing is for.

Licensor: Northlatch Labs LLC. Licensing enquiries: kaela@projectxprotocol.dev

## If you would rather we ran it

Nothing below is required to use this action. It exists because some teams want the
measurement without owning the pipeline.

| | |
|---|---|
| **First Report** — one Move package, all five gates, evidence bundle with a reproducible digest, delivered in 24 hours | **$1,000**, once |
| **The App** — the same gates on every pull request, run and hosted by us | **$149 / repository / month** (annual $1,490) |

Contact: kaela@projectxprotocol.dev

---

Built-by: @projectx.sui /|\
Co-authored-by: Kaela <kaela@projectxprotocol.dev>
