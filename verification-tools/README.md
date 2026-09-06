# verification-tools

> **What this repo is, among three that look alike.** This is **the canonical source** of the
> mutation engine and the estate's internal toolchain — `move-mutate`, `drift-watch`, `prover-kit`,
> `sui-stage`, `standard`. It is **not** a duplicate of `protocolx-verify`: that repo's `engine/`
> is built *from here* by `sync-engine.sh`. Change the engine here and nowhere else. See
> `CANONICAL.md`. Archiving this repo would delete the source the shipped product is built from.

The ProtocolX verification toolchain — born 2026-08-27, the night the estate measured three
contracts by mutation, staged a 60,000-entrant lifecycle, and machine-proved its first money
path, then decided the practice is a product.

- `move-mutate/` — systematic mutation testing for any Sui Move package. Working; acceptance
  run: derived the registrar's full 14-mutation set (matching the hand-built harness exactly),
  killed 3/3 in a limited run, restored byte-identical.
- `sui-stage/` — full-lifecycle localnet staging library, extracted from the driver that ran
  the 500- and 60,000-entrant storms. Reference scenario lives in projectx-raffle.
- `prover-kit/` — the Sui Prover spec-writing patterns plus the actual proven registrar spec
  as the worked example.
- `standard/PVS.md` — the ProtocolX Verification Standard v0.1: four evidence layers, required
  artifacts, the mandatory independence clause, and the standing format.

Agent-ready: every tool has a skill in `WORK.CLAUDE/.claude/skills/` (move-mutate, sui-stage,
prover-specs) carrying the invocation contract and the estate's laws — one writer per repo,
one heavy runner per machine, green baselines, byte-verified restores, loopback-only storms.

Public statement: the verification section on projectxprotocol.dev.
