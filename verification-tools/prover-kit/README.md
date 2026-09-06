# prover-kit

The craft of writing Sui Prover specs, learned by proving a deployed mainnet contract's money
path and written down because almost nobody else has yet. The worked example
(`worked-example-registrar.move`) is the actual spec that proved the ProtocolX registrar —
six of six checks — copied verbatim.

## Setup

- `brew install asymptotic-code/sui-prover/sui-prover` (heavy: pulls Z3, Boogie, .NET, Rust).
- Spec package sits beside the implementation: `<package>/specs/` with its own `Move.toml`
  depending on `{ local = ".." }` and the Prover library
  (`git = "https://github.com/asymptotic-code/sui-prover.git", subdir = "packages/prover"`).
- Run `sui-prover` from the specs directory. Never publish a spec package.

## The patterns that make specs prove

1. **`requires` states the honest domain.** Mirror the target's own `assert!` gates line for
   line — the function aborts outside them *by design*, and `SpecNoAbortCheck` demands you say
   so. Then add the u64-headroom bounds for every counter and balance the function grows.
2. **Order requires so bounds precede arithmetic.** A `requires` expression is itself checked
   for aborts: state `fee <= MAX` *before* the band expression that multiplies by `fee`, or
   the prover finds the overflow in your spec instead of the contract.
3. **Spec arithmetic is u128.** `ensures(a + b == c + d)` over u64 values can overflow in
   spec-space even when the contract never can. Cast every sum: `(a as u128) + (b as u128)`.
4. **Private state needs test-only accessors.** `#[test_only] public fun` readers/setters are
   visible to the prover build and are stripped from published bytecode — verify that claim
   per edit by comparing `sui move build --dump-bytecode-as-base64` digests before and after.
5. **Private constants get mirrored, with a tripwire.** A contract's `VERSION` has no public
   reader; the spec mirrors it as a constant with a comment naming the coupling. Pair it with
   a drift test where possible.
6. **`clone!` captures pre-state.** `let old = clone!(obj);` before the call; compare accessor
   reads on `old` vs the mutated object in `ensures`.

## Known limits (August 2026)

- The prover ships its own framework generation (Asymptotic's fork, rev `next`), which
  predates newer framework aliases — notably `df::exists`. A package calling those cannot be
  proven until the fork catches up. State the blockage; don't rewrite deployed source to chase
  the tool. Property sweeps (deterministic LCG over thousands of inputs plus pinned corners)
  are the honest fallback, labeled measured-not-proven.
- Loops need invariants and are genuinely hard; pure functions and straight-line money paths
  are the high-value first targets.

## Reading a run

- `*_Check` green = the `ensures` hold for all inputs in the domain. The proof.
- `*_SpecNoAbortCheck` green = no abort is reachable inside the declared domain.
- A ❌ prints a concrete counterexample model — read the variable assignments; they tell you
  whether the gap is in the contract or in your spec's arithmetic (it is usually the spec).
