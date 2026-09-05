<!-- Built-by: @projectx.sui -->
<!-- Co-authored-by: Kaela <kaela@projectxprotocol.dev> -->

# drift-watch

**A verification is a photograph. This is the thing that notices the subject has moved.**

## The problem, stated exactly

`sui client verify-source` already answers the question everybody asks first: does this
source tree build to the package that is live on chain? It is first-party, free, and it
does the hard part properly — it rebuilds with the toolchain version the package was
published with and compares bytecode *and linkage*. We do not reimplement it and we do not
compete with it. Where it is the right tool, this document tells you to run it.

What it cannot do is notice that it needs running again.

Somebody runs it once. It says the source matches. That sentence goes into an audit, a
README, a report to a customer — and it starts decaying immediately, because an `UpgradeCap`
holder can publish new bytecode under the same package without touching the repository
anybody verified, without a pull request, and without telling the people relying on the
report. The verification is still on the page. It is just no longer about the code that is
running.

There is a second version of the same hole with no bytecode in it at all. The package can be
byte-for-byte the one that was audited while the **capability to replace it** has moved to an
address nobody has ever looked at. Nothing about the code changed. Everything about who
controls it did.

drift-watch measures both, on every CI run, against a state somebody actually verified.

## What it does

```
node runner/drift-watch.mjs snapshot --package <0x…> [--upgrade-cap <0x…>] --out drift-watch.json
node runner/drift-watch.mjs check    --snapshot drift-watch.json
```

`snapshot` records what the chain holds right now: the package address and version, the
object digest, a sha256 per published module's bytecode, the full linkage table, and — when
you name it — the UpgradeCap's package pointer, version, policy and current owner.

`check` reads the chain again and compares. **It takes its addresses from the snapshot, never
from the command line**, because a gate you can aim at a different package is not a gate.

### Exit codes, and why the third one matters most

| code | verdict | meaning |
|---|---|---|
| 0 | `match` | the chain still holds the recorded state |
| 1 | `drift` | it does not, and every field that moved is listed |
| 2 | `unmeasured` | it could not be read, so nothing is claimed about it |

**2 is never folded into 1.** `drift` is an accusation about somebody's live deployment. A
timed-out endpoint, a truncated module page, a snapshot from a different network, or an
UpgradeCap caught mid-upgrade must never be able to make that accusation. This is the same
rule `engine/ci/digest-of-dump.py` follows, for the same reason, and most of the test suite
exists to hold the line: a gate that goes red for reasons the reader cannot act on teaches
them to press the button again and watch it go green, which is the exact habit this product
exists to break.

## What it reports

**The package**

- `package-upgraded` — the version moved. The deployed bytecode is not the bytecode that was
  verified, and no repository changed to say so. This is the headline case.
- `module-changed` / `module-added` / `module-removed` — per module, by bytecode digest.
- `package-object-digest-changed` — the object digest moved at an unchanged version.
- `linkage-added-or-moved` / `linkage-removed-or-moved` — the package's own bytecode is
  untouched but it now executes against a different version of a dependency. A check that
  only hashed modules would call that a match.

**The authority**

- `upgrade-cap-owner-changed` — who may replace this package has changed.
- `upgrade-cap-policy-tightened` / `upgrade-cap-policy-loosened` — deliberately two different
  findings. `sui::package` can only ever raise a policy (`compatible` 0 → `additive` 128 →
  `dep-only` 192); there is no published call that lowers one. A policy observed going *down*
  therefore did not happen through that interface, and the finding says so in those words
  instead of shrugging and reporting "policy changed".
- `upgrade-cap-version-advanced` — an upgrade was committed.
- `upgrade-cap-gone` — the cap no longer exists. `make_immutable` deletes it, so this most
  often means the package was deliberately frozen and can never be upgraded again. It is
  reported because it is a change, not because it is bad, and the wording says so.

## How to use it, start to finish

1. **Establish the baseline honestly.** Verify the live package against its source:
   `sui client verify-source` in the package directory. drift-watch does not do this and does
   not pretend to — a snapshot records `sourceVerification: null` with the reason beside it,
   rather than a field that reads like a result nobody produced.
2. **Record the state you just verified.** `drift-watch snapshot --package … --upgrade-cap …
   --out drift-watch.json`, and commit that file next to the package.
3. **Check it on every run.** `drift-watch check --snapshot drift-watch.json` in CI. Green
   means the thing that was verified is still the thing that is deployed.
4. **When it goes red, it is a review, not a rebase.** Re-run `sui client verify-source`
   against the new version, have somebody read what changed, and re-record the snapshot *in
   the same commit as the review that accepted it*. Updating the snapshot to make CI green is
   the one use of this tool that destroys its value — the same rule `engine/ci/digest-guard.sh`
   states about `ci-expected-digest`, and it applies here word for word.

## The endpoint

Default: `https://graphql.mainnet.sui.io/graphql`, overridable with `--endpoint`.

GraphQL and not JSON-RPC, by necessity rather than taste. As of 2026-09-05 a `sui_getObject`
call against `https://fullnode.mainnet.sui.io:443` answers:

```
Method not found. JSON-RPC on public fullnodes has been deprecated.
Please migrate to gRPC or GraphQL endpoints.
```

Nothing here needs a key or an account. The endpoint is read-only and public.

Module lists are paginated. The fetcher follows the cursor, refuses a cursor that repeats or
a promised page with no cursor to reach it, and the parser **refuses a page set that still
says `hasNextPage`** — a silently truncated module list would let a package with 51 modules
report `match` on the strength of its first 50.

## Tests

`runner/test/drift-watch.test.mjs`, wired into CI (`Self-gates`) and
`scripts/run-self-gates.sh` as step 23. It runs offline. Every fixture under
`runner/test/fixtures/drift-watch/` is a real response captured from Sui mainnet on
2026-09-05 — a real published package with its real bytecode, a real
`0x2::package::UpgradeCap` with its real owner and policy, the real 22-module MoveStdlib
package read once whole and again in three pages so that the cursor-following can be
cross-checked against the whole read, a real GraphQL error envelope, and the real answer for
an address that holds nothing. Drifted states are made by taking one of those readings and
moving a named field, which is the only way to write a before-and-after when the "after" has
not happened yet.

No test opens a socket. Mainnet is a live third party and a self-gate somebody else's
endpoint can redden is not a self-gate.

## What this does not do

Said plainly rather than implied.

- **It does not verify source.** It records and watches. `sui client verify-source` is the
  tool that compares a source tree to on-chain bytecode, and step 1 above is not optional —
  a snapshot of an unverified package is a faithful record of something nobody checked.
- **It does not prove *when* a snapshot was taken.** `observedAt` is a timestamp this tool
  wrote about itself. An independent one needs an anchor outside anyone's control.
- **It does not read MVR audit-report metadata.** The recommendation this was built from asks
  for it. Move Registry's on-chain metadata schema was not read as part of this work and
  nothing here should be taken as covering it — see the note in `UPDATE.md`.
- **It does not watch continuously on its own.** It is a command with an exit code. Running
  it every hour is a scheduler's job, and none is configured here.
- **A `match` is not a statement that a contract is safe.** It says the deployment has not
  moved since somebody looked at it. What they concluded when they looked is their document,
  not this one.
