# The ProtocolX Verification Standard (PVS) — v0.1 draft

The project's own security spec. It defines what
"verified" means when ProtocolX says it — four evidence layers, each with a required artifact.
A contract's standing under PVS is the list of layers it has passed, never an adjective.

## Layer 1 — Mutation-measured suite

Every load-bearing guard is deleted in turn and the suite must notice.
- Tool: `move-mutate` (systematic, derived from source) and/or a curated harness for
  multi-line and semantic mutations.
- Required artifact: the mutation report — derived count, executed, killed, and **every
  survivor named with its reason** (real gap, structurally untestable, defensive no-op).
- Required discipline: green baseline before mutating; byte-verified restore; skipped
  mutations counted, never silently dropped.

## Layer 2 — Staged lifecycle at production scale

The whole life of the contract runs against a real (local) network with real transactions,
real wallets, and real gas, at the scale production claims to support.
- Tool: `sui-stage` scenarios.
- Required artifact: the phase/gas table, first-vs-last transaction gas, and a conservation
  verdict read from chain state — not from the driver's own bookkeeping.

## Layer 3 — Machine-checked proof of the money paths

Functions that move value are proven with the Sui Prover for all inputs in a published domain.
- Tool: `prover-kit` patterns.
- Required artifact: the spec file (the domain is part of the claim) and the prover transcript.
- Where the prover cannot reach (framework lag, loops), the fallback is a deterministic
  property sweep — thousands of adversarial inputs plus pinned corners — labeled
  **measured, not proven**. The label is mandatory.

## Layer 4 — Drift defense

Every mirrored value — constants copied into clients, SDKs, or specs — has a test that reads
the source of truth and fails when it moves; deployed bytecode is matched to source with
`verify-source`, re-checked after any source-adjacent edit via build-digest comparison.
- Required artifact: the drift tests themselves and the latest verify-source result.

## The independence clause (mandatory, verbatim on every report)

> This is an internal review by the party that wrote the code. It is evidence, not an audit:
> no claim of independence is made, and none should be inferred.

## Standing format

A contract's PVS standing is stated as, e.g.:
`PVS: L1 22/23 (1 survivor, structurally untestable) · L2 60k-entrant run, conservation exact ·
L3 money path proven (collect_fee, withdraw) · L4 green` — numbers, dates, and artifacts
linked. Nothing else counts as a claim.
