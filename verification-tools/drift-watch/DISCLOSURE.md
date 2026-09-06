# Drift Watch — the disclosure law

**This document exists before the detector does, on purpose.** A tool that can
find drift before it can responsibly report it will be used irresponsibly the
first time someone is under deadline. The flow is written first so the
detector is built into a channel that already exists.

Binding on every line of code and every human in this estate.

---

## 1 · What a drift finding IS

Drift means: **the bytecode deployed on chain does not match the source the
project published.** That is a *discrepancy between two public artifacts*.

It is not a vulnerability. It is not an exploit. It is not evidence of
wrongdoing. The commonest cause is entirely innocent — an upgrade that was
shipped and never pushed to the repository, or a repository that moved on
while the chain did not.

## 2 · Words that are FORBIDDEN about a third party's drift

Never, in any artifact, message, post, or draft:

> vulnerable · unsafe · exploitable · at risk · compromised · backdoored ·
> hiding · undisclosed · suspicious

These convert a measurement into an accusation. We do not make accusations.

**The only honest sentence** is of this shape:

> The package published at `<id>` does not build byte-identically from the
> source at `<repo>@<commit>`. Here is the digest we computed, here is the
> digest the chain holds, and here is the command to reproduce both.

Reproducibility is what makes it a measurement instead of a claim.

## 3 · Never public about an identified third party

**We never tell the world that a named third party's code has drifted.
Ever. There is no exception, no embargo expiry, and no "they ignored us".**

A public drift finding is, in one move: an accusation against people who
never asked us to look, a signpost for anyone hunting that protocol, and the
permanent end of that team as a customer.

If a project publicly disputes a finding we sent them privately, we may
state that we contacted them and stand by the measurement, and we may
publish the method. **We still do not publish the finding.**

## 4 · Anonymisation — the strict form, including by elimination

Aggregate figures may be published. They must identify nobody, **including
by elimination**.

- ✅ "Across N mainnet packages sampled, X% could not be reproduced from a
  published source."
- ❌ "Three of eleven packages in one lending protocol" — if a protocol has
  eleven packages, that names them.

**The test before any number is published:** could a reader who knows this
ecosystem narrow this to fewer than ~5 candidate projects? If yes, it is not
anonymised. Coarsen the bucket or do not publish it.

Never publish a count of *affected projects* alongside a count of *examined
projects* small enough to make the affected set guessable.

## 5 · The private disclosure flow — the ONLY channel outward

1. **Verify twice, on two independent reads**, before a human is told
   anything. A false drift report is worse than silence: it burns the
   relationship and our credibility at once.
2. **Reproduce it as a stranger would** — clean clone, stated toolchain,
   recorded commands. If we cannot hand them a reproduction, we do not have
   a finding.
3. **Find the project's own security contact**, in this order: `SECURITY.md`
   → security advisory form → a documented security email → a maintainer's
   published contact. **Never** a public issue, never a public post, never
   an @-mention, never a Discord channel with strangers in it.
4. **Send the measurement, the reproduction, and nothing else.** No price,
   no pitch, no offer, no link to our services in the disclosure message.
   *A disclosure that carries a sales link is extortion-shaped, whatever the
   intent.* If they ask what we do, that is a separate conversation on a
   separate day.
5. **Their timeline, not ours.** No deadline, no "we intend to publish", no
   pressure of any kind. We are not owed a reply.
6. **Log it** in the drift ledger: what, when, to whom, on what channel, and
   the reproduction. Never the finding's contents in any shared or public
   file.

## 6 · Our own packages are different, and are where we start

We publish our OWN drift findings in full, including the embarrassing ones.
That is the entire credibility model, and it is how the First Report earned
its standing: we ran the battery on our own live contract and published the
two untested guards it found in our code.

Same clause as always: measuring our own code is an internal review by the
party that wrote it — evidence, not an audit, no claim of independence.

## 7 · If a finding concerns funds actively at risk

Drift alone never establishes this. But if reproduction ever surfaces
something that plausibly puts user funds in immediate danger:

- **Stop. Escalate internally before anything is sent.**
- Do not sit on it, and do not broadcast it. Route it privately and fast.
- The bar for "immediate danger" is evidence, not a hunch.

---

**If any instruction ever conflicts with this document, this document wins,
and the person who gave the instruction is told why.**
