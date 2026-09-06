# OPEN QUESTION — where does Drift Watch live? (raised 2026-08-30)

**Unsettled. Flagged deliberately rather than decided quietly. Must be
resolved BEFORE this branch is ever pushed.**

## The tension

On 2026-08-30 this repository was declared **canonical for the ENGINE** —
`CANONICAL.md`, merged as PR #4. That declaration exists so there is exactly
one answer to "where does the mutation engine come from", and so the App's
copy can be a downstream artifact of it.

`drift-watch/` is not the engine. It is a **product line** that happens to
have been built by the same desk on the same day. Putting it in this tree
muddies what "canonical" points at: a reader arriving at `CANONICAL.md`
learns this repo is the source of truth for the engine, then finds a second
unrelated thing beside it and has to work out which claim covers what.

## Options, not yet chosen

1. **Its own repository.** Cleanest separation; `verification-tools` stays
   exactly what its own CANONICAL.md says it is. Cost: another tree to keep
   green, and Drift Watch shares no code with the engine today but plausibly
   will (both read `Published.toml`, both compare digests).
2. **Stay here, and narrow the canonical claim.** Amend `CANONICAL.md` to say
   it is canonical for `move-mutate/` specifically rather than for "the
   engine" ambiently. Cheapest, and honest, but leaves two purposes in one
   tree.
3. **Stay here as an explicitly separate product directory**, with its own
   README stating it is NOT covered by the engine's canonical/sync
   machinery. Weakest of the three: it relies on a reader noticing a
   disclaimer.

## Standing instruction

The engineering desk's ruling, 2026-08-30: *"Not a reason to revert a local
commit. It IS a reason to decide drift-watch's home before it is ever
pushed. Flag it in the branch, do not move it, and we settle it when there
is something to push."*

So: **do not move these files.** Decide the home when a push is on the table,
and delete this file in the same change that settles it.
