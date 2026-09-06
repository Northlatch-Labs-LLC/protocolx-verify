> **Since 6 September 2026 this tree lives inside `protocolx-verify` at `verification-tools/`.**
> The separate `verification-tools` repository is retired. The rule below is unchanged: the engine
> is edited here and shipped to `engine/` with `verification-tools/sync-engine.sh .`, never by hand.

# This repository is CANONICAL for the engine

`verification-tools/move-mutate/` is the **single source of truth** for the
mutation engine. Nothing else is. Since 2026-09-01 the same is true of `verification-tools/ci/`
(the digest guard, the gates runner, the toolchain note, the digest reader, the digest comparison)
and `verification-tools/test/` (their tests): `protocolx-verify/engine/ci/` and `engine/test/` are
downstream artifacts of this tree, shipped by the same `sync-engine.sh`. They were found diverged by
seventy-nine lines on 2026-09-01 — the newer copy lived downstream — which is the failure this file
exists to forbid.

The copy at `protocolx-verify/engine/move-mutate/` — the one the GitHub App
ships as the `PVS · mutation-smoke` check — is a **downstream artifact of
this tree**. It is not a sibling, it is not independently maintained, and it
must never be hand-edited.

## Why this file exists

On 2026-08-30 the two copies were found to have diverged within hours of
being synced: the shipped engine was missing `lib/shadow.py` entirely, and
its loader did not reference it. The App therefore ran a measurably
different engine from the one maintained here, and neither copy was
declared authoritative.

That is the exact failure our own product exists to detect — the thing that
runs is not the thing in the repository. We cannot sell drift defence while
shipping drift.

## The rule

1. Change the engine HERE. Never in `protocolx-verify`.
2. Propagate with `./sync-engine.sh <path-to-protocolx-verify>`. It copies
   the whole engine, discovers `lib/*.py` by glob rather than a hardcoded
   list (the hardcoded list is how `shadow.py` went missing), and writes
   `engine/ENGINE_PROVENANCE` recording this repo's commit and a hash of
   every shipped file.
3. CI in `protocolx-verify` fails the build when the shipped tree does not
   match its own provenance record, or when the engine's module loader
   disagrees with the files actually present.

## Honest status of the mechanism

`sync-engine.sh` is a SCRIPT, run by a human. It is not yet a build step,
and nothing currently forces it to run before a release. That is a known
gap, stated here rather than implied away. The drift GATE is automated even
though the sync is not — so an un-synced or hand-edited engine fails loudly
instead of shipping quietly, which is the property that actually matters.
