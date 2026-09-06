# Drift Watch — reachability measurement (2026-08-30)

The question asked before any detector is built: **how many mainnet
Move packages can we actually watch?** Measured, not estimated. Tool:
`reach.py` (reads only, no network, stdlib only).

## Headline

| Sample | Packages w/ sources | Watchable | Reachability | Toolchain recorded |
|---|---|---|---|---|
| Our own estate | 14 | 7 | **50%** | **7 / 7** |
| Third-party (t2000, Scallop, Volo, Praxis) | 20 | 11 | **55%** | **2 / 11** |
| Combined | 34 | 18 | **53%** | 9 / 18 |

## The number that actually decides the product

Reachability is ~53% and that is the *encouraging* half. The decisive figure
is the last column.

**Only 2 of 11 watchable third-party packages record the toolchain version
they were built with.**

A drift watch compares a rebuild against deployed bytecode. The Move compiler
version changes the bytecode it emits — which is exactly why PVS already
carries a `pin` gate, whose stated purpose is that "a toolchain that drifts
changes what compiles, and what your digest means." Without the recorded
toolchain we cannot distinguish:

- the deployed code genuinely diverging from source (**a real finding**), from
- our rebuild using a different compiler than they did (**a false positive**).

Under our own disclosure law a false drift report is worse than silence: it
burns the relationship and our credibility in one move. So a package without
a recorded toolchain is **watchable but not safely reportable** without first
recovering which compiler produced the deployed bytecode.

**Honest reachability for a product that must never be wrong: 2 of 20
third-party packages (10%), not 55%.**

## What separates the two samples

Our 7/7 versus their 2/11 is not virtue, it is vintage. Both of our
well-recorded packages and both of theirs use `Published.toml`, the modern
Sui convention that records `published-at`, `original-id`, `version`,
`toolchain-version`, `build-config` and `upgrade-capability` together.
Everything scoring poorly predates it and carries only a bare `published-at`
in `Move.toml`, or a legacy `Move.lock` id.

So the recorded-toolchain share is a **function of when a package was last
published**, and it rises on its own as teams re-publish with current
tooling. The addressable market grows without us doing anything — but it is
small today.

## The commercially awkward finding

**Volo — the strongest drift prospect on our list — is NOT watchable from
its public repository.** `liquid_staking` has 6 source modules and no
committed mainnet `published-at`. Their last push also predates their April
incident. We cannot measure them from public artifacts alone, and any pitch
implying otherwise would be false.

This is the shape of the market: the teams most likely to *need* a drift
watch are the ones whose publishing hygiene is weakest, which is the same
weakness that makes them hard to watch. That is not a reason to abandon the
product. It is the reason the first deliverable is a **census**, not an
alarm: telling a team which of their packages are unwatchable, and why, is
itself the finding — and the fix is theirs to make, which is a conversation
rather than an accusation.

## What this says about product shape

- **Not a platform today.** 10% safely-reportable third-party coverage does
  not support "point it at an ecosystem and bill monthly."
- **A concierge census is real now.** Per-protocol, human-reviewed, with the
  unwatchable packages named as the primary output.
- **The recurring product is credible but must be sold on the census**, not
  on drift alerts we frequently cannot make safely.
- Recording `Published.toml` properly is something we could help a client do
  in an afternoon — and it makes them watchable, i.e. it creates the
  precondition for the recurring product. That is a legitimate paid first
  step, and it is honest work.

## Limits of this measurement — stated, not buried

- **Sample is 34 packages from 7 repositories** we happened to hold locally.
  It is not a random sample of the Sui ecosystem and must not be quoted as
  an ecosystem-wide statistic.
- Reads committed files only. A team may know its published-at without
  committing it; those count as unwatchable here, correctly, because *we*
  cannot reach it — but they are not necessarily disorganised.
- No chain reads yet. Every figure is about what the **source side** offers.
  Whether each recorded address still resolves to a live package on mainnet
  is unverified and is the next measurement.
- No rebuild was attempted. Whether a recorded toolchain actually reproduces
  the deployed digest is the measurement after that, and it is the one that
  turns this from a plan into a product.

## Files
`reach.py` — the probe. `DISCLOSURE.md` — the law it operates under, written
before the detector on purpose.

---

# ⚠️ REVISION 2026-08-30 (later) — THE 10% FIGURE WAS TOO PESSIMISTIC

The headline above rests on a premise I asserted and had not tested: that a
package with no recorded toolchain is **watchable but not safely reportable**,
because a compiler difference would produce false positives.

**Measured, and the premise does not hold across the versions tested.**

| Package | Recorded toolchain | Installed | Result |
|---|---|---|---|
| t2000 `a2a_escrow` (4 modules, 3,423 LoC) | **1.77.3** | 1.77.2 | ✅ 4/4 byte-identical |
| t2000 `agent_id` (1 module) | **1.76.0** | 1.77.2 | ✅ 1/1 byte-identical |

Both reproduced **exactly**, with a mismatched compiler in both cases — and
`agent_id` across a full minor version (1.76 → 1.77). Both addresses were
confirmed LIVE on mainnet before comparing, at the recorded versions (13 and
3).

**So Move bytecode output was stable across 1.76.0 → 1.77.3 for these
packages.** A recorded toolchain is evidence of good hygiene; on this
evidence it is not a precondition for a trustworthy comparison.

## What this does and does not change

**Changes:** the safely-reportable population is not 2 of 11. On this
evidence it is plausibly most of the 11 watchable third-party packages, which
moves the product back toward platform shape rather than concierge-only.
**The honest reachability number returns to ~55% pending wider testing**, and
my 10% was wrong in the conservative direction.

**Does not change:** two packages is a tiny sample across a narrow version
band. It does NOT show that toolchain never matters — a larger version gap
(1.7x → 1.8x), a framework-dependency bump, or a different `build-config`
flavour could all still diverge. The `pin` gate's reasoning stands; what is
now measured is that its effect is smaller than I assumed within one minor
series.

**The correct posture:** treat a toolchain mismatch as a reason to
double-check a divergence before reporting it — NOT as a reason to refuse to
watch a package. That is a materially larger addressable market than the
revision above described, and it was my error to state 10% as settled when it
rested on an untested premise.

## Method note added this run
`published-at` is now confirmed to resolve to a LIVE mainnet package before
any comparison. A recorded address is not a live package: `probe` and
`comp-probe` in `projectx-raffle` both record mainnet addresses that do not
resolve, and a census trusting `Published.toml` alone would report two
phantom deployments.
