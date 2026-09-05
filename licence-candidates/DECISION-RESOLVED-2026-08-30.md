# LICENCE — RESOLVED 2026-08-30. BUSL-1.1 IS IN FORCE.

> **Decided 2026-08-30: BUSL-1.1.**
>
> `LICENSE` now exists at the repository root and carries the Business Source
> License 1.1 with the Additional Use Grant. **Apache-2.0 was considered and was not
> chosen.** This file is the record of the question and is kept, not deleted — the
> estate keeps what it decided against.
>
> *(Archived from `DECISION-PENDING.md` on 2026-08-30. Everything below the rule is
> the decision pack exactly as it was put to him, unedited, so the reasoning he ruled
> on is still legible. Where it says "not chosen" or "not answered", read it as the
> state before the ruling above.)*

## What the ruling installed, and what it did not settle

Installed at `LICENSE`, in the same house form as the estate's three other BUSL
packages (`projectx_raffle`, `comp_probe`, `projectx_social`):

| Parameter | Value as installed |
|---|---|
| Licensor | Northlatch Labs LLC |
| Licensed Work | ProtocolX Verify — the Action, engine and runner in this repository |
| Change Date | **2030-08-30** — see the flag below |
| Change License | Apache License, Version 2.0 |
| Additional Use Grant | production use on your own code, including your own CI; no hosted resale |

**Four things remain open. None of them blocks the tree; all of them
are cheaper to change now than after a public tag.**

1. **The Change Date, `2030-08-30`, is out of step with the rest of the estate.**
   `projectx_raffle`, `comp_probe` and `projectx_social` all convert on **`2029-09-01`**.
   This one converts eleven months later. Four years is the effective maximum BUSL-1.1
   allows — the Terms convert on the Change Date *or* the fourth anniversary of first
   publication, whichever is sooner — so `2030-08-30` is the longest hold available and
   it was drafted, not ruled. One word aligns it to `2029-09-01` or confirms the outlier.
2. **The grant deliberately excludes contractors.** Running ProtocolX Verify against
   *someone else's* code as part of a paid engagement is outside the grant and needs a
   commercial licence. That is the honest reading of "their own CI against their own
   code", and it is written down plainly rather than left ambiguous — but it closes the
   door on audit boutiques adopting the engine as a tool of their trade, which is a
   commercial call and not a drafting one.
3. **`kaela@projectxprotocol.dev` is the alternative-licensing contact in a public
   licence file.** The estate's other three BUSL files say "contact the Licensor" and
   name no address. A real address is better for a product whose whole point is that
   alternative licensing is the business — but this makes that inbox a front door.
4. **No version number in `Licensed Work`.** BUSL applies separately per version and the
   Change Date may vary per version, so the licence file as it stands at each tag governs
   that tag. That is workable. If `v2` should ever convert on a different date, the
   parameter block has to be edited at that tag, deliberately.

**`LICENSE` carries no `Built-by:` / `Co-authored-by:` trailers, on purpose.** BUSL-1.1
Covenant 4 is *"Not to modify this License in any other way."* Stamping the estate's
trailers into the licence text would be a modification of it. Every other public file
carries them; this one must not.

**`BUSL-1.1.txt` in this directory is the draft as staged.** `LICENSE` at the root
supersedes it and differs in three ways: the canonical `Notice` block was missing from the
draft and has been restored, the parameter heading matches the estate's house form, and
the Additional Use Grant was rewritten to say affirmatively what a buyer may do before it
says what they may not.

---

## Candidate A — BUSL-1.1 with a use grant  (`BUSL-1.1.txt`)

Anyone may read the source and run it against software they own or are authorised to
modify, including in their own CI. Nobody may host it as a service or resell it. On the
Change Date the whole thing converts to Apache-2.0 automatically.

| | |
|---|---|
| reading the sandbox | permitted — which the trust argument *requires* |
| running it on your own code | permitted, in production, at no cost under the grant |
| reselling it or hosting it for others | not permitted until the Change Date |
| OSI "open source" | **no** — BUSL is source-available, not open source |
| `uses: Northlatch-Labs-LLC/protocolx-verify@v1` resolves | yes, once the repo is public |

**Parameters staged in the file, all of which need confirming:**

- **Licensor** — `Northlatch Labs LLC`.
- **Change Date** — `2030-08-30`. Four years from today, which is the maximum BUSL 1.1
  allows; the licence converts on that date or on the fourth anniversary of first
  publication, whichever is sooner.
- **Change License** — Apache-2.0.
- **Additional Use Grant** — drafted to permit production use on your own code and to
  forbid hosted-service resale. That wording is the whole commercial position and is the
  part most worth a second reading.

**Costs.** Some organisations have a blanket policy against non-OSI licences in CI, and
that policy is usually enforced by a scanner rather than a person, so it will exclude us
without a conversation. Packaging in Linux distributions and inclusion in some
foundation-run pipelines is also off the table.

## Candidate B — Apache-2.0  (`Apache-2.0.txt`)

The permissive, OSI-approved default. Maximum adoption, maximum scanner-friendliness, an
explicit patent grant, and a competitor may take the engine, rename it, and sell it the
same afternoon.

| | |
|---|---|
| reading the sandbox | permitted |
| running it on your own code | permitted |
| reselling it or hosting it for others | **permitted** |
| OSI "open source" | yes |

## The reasoning behind the choice

BUSL-1.1 with the use grant. The trust argument this product rests on **requires** that a
buyer can read `runner/sandbox.sh` and `runner/tripwire.sh` and satisfy themselves the
sandbox holds — BUSL gives that away entirely and gives nothing else away. Apache-2.0
gives away the engine, and the engine is the business.

This is a recommendation. It has been put and not answered, and no part of this branch
assumes it.

---

Built-by: @projectx.sui
Co-authored-by: Kaela <kaela@projectxprotocol.dev>
