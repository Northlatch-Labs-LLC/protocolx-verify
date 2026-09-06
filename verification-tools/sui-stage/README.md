# sui-stage

Full-lifecycle staging for Sui contracts against a throwaway localnet: publish, fund a fleet
of real wallets, storm the contract with real transactions, and verify invariants from chain
state — with real gas recorded per phase. The measurement no unit suite can make.

Extracted from the driver that staged the ProtocolX raffle at 500 and 60,000 entrants
(`projectx-raffle/sui-contracts/scripts/localnet-stress/`), which remains the reference
scenario. Runs of record: 60,000 buys at 187 tx/s average with 96 workers, first-buy and
last-buy gas identical at full tree depth, escrow zero after both claims.

## Shape

- `lib.mjs` — the generic core: loopback-enforced client, whale funding in 400-transfer PTBs,
  the N-worker storm executor (fast path, effects-checked), the checkpoint-lag visibility gate,
  phase/gas recording, report writer.
- A **scenario** is a small `.mjs` file that imports the lib and describes one contract's
  lifecycle: publish, setup, storm, settle, verify. The raffle driver shows the full pattern.

## Hard-won rules the library enforces or encodes

1. **Loopback only.** The lib throws on any non-127.0.0.1 endpoint. No scenario can storm a
   public network by accident.
2. **Chain clocks are real.** Localnet's Clock cannot be advanced: schedule your contract's
   time windows to fit the run, respect its minimum-window floors, and add slack — the on-chain
   clock lags wall time by a few seconds.
3. **The fast path outruns the fullnode's view.** Skipping the indexing wait triples
   throughput, but any dry-run or aggregate read afterwards sees stale state. Always
   `waitVisible` before the next lifecycle step.
4. **Fund from a whale, not the faucet.** One faucet-fed whale cutting 400 wallets per PTB
   funds 60,000 wallets in ~11 minutes; per-wallet faucet calls would take hours.
5. **Measure first and last.** The storm returns the first and last transactions' effects so
   gas growth with data-structure depth is a number, not a guess.

## Requirements

`sui` CLI (localnet via `sui start --force-regenesis --with-faucet`), Node 18+, and
`@mysten/sui` resolvable (a symlink to an existing app's `node_modules` works).
