<!-- Built-by: @projectx.sui -->
<!-- Co-authored-by: Kaela <kaela@projectxprotocol.dev> -->

# LICENCE ARCHIVE — closed 2026-08-30

**The licence is ruled. `LICENSE` at the repository root is the only licence in force.**
Nothing in this directory grants anything to anyone. It is the record of a decision,
kept so the estate can show what it weighed and what it rejected.

| File | What it is |
|---|---|
| `DECISION-RESOLVED-2026-08-30.md` | The licence decision and its reasoning. |
| `BUSL-1.1.txt` | The **chosen** licence, as drafted. Superseded by `LICENSE` at the root, which corrects three things — see the resolved decision doc. |
| `Apache-2.0.txt` | **Considered and not chosen.** Kept deliberately. |

## Why Apache-2.0 was not chosen

It was a live candidate, not a straw man: OSI-approved, scanner-friendly, an explicit
patent grant, and the widest possible adoption. It was rejected on one point, and the
point is the business. Under Apache-2.0 a competitor may take the engine, rename it, and
sell verification with it the same afternoon. The engine is the product.

BUSL-1.1 gives away the one thing the product actually needs to give away — a buyer can
read `runner/sandbox.sh` and `runner/tripwire.sh` and satisfy themselves the sandbox holds
— and gives away nothing else. On the Change Date it becomes Apache-2.0 anyway.

**The cost we accepted, written down so nobody rediscovers it as a surprise:** BUSL is
source-available, not open source. Some organisations block non-OSI licences in CI by
scanner rather than by conversation, and we will be excluded from those without ever
speaking to a human. Distribution packaging and some foundation-run pipelines are also
off the table until 2030-08-30.

This directory is private. It is not part of the publishable runtime closure and must not
be copied into a public tree.

Built-by: @projectx.sui
Co-authored-by: Kaela <kaela@projectxprotocol.dev>
