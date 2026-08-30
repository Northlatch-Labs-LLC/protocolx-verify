# LICENCE — NOT CHOSEN. Both candidates are staged; neither is in force.

There is no `LICENSE` file at the repository root, and this branch does not create one.
The choice has not been ruled on, and it is not a choice a build step gets to make: it
decides whether a competitor can fork the engine and sell it.

Publishing requires exactly one action here, and it is a one-liner once the ruling is in:

```bash
cp licence-candidates/BUSL-1.1.txt LICENSE      # or Apache-2.0.txt
git rm -r licence-candidates
```

`README.md` already links `LICENSE`. Until that copy is made the link is dead, which is
deliberate — it is the last thing standing between this tree and publication, and it
should be visible.

**Do not publish without a licence file.** Enterprises will not run unlicensed code in
CI, so "no licence" is worse for adoption than either choice below, and it also leaves
our own position unstated.

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

## The desk's reading, offered and not acted on

BUSL-1.1 with the use grant. The trust argument this product rests on **requires** that a
buyer can read `runner/sandbox.sh` and `runner/tripwire.sh` and satisfy themselves the
sandbox holds — BUSL gives that away entirely and gives nothing else away. Apache-2.0
gives away the engine, and the engine is the business.

This is a recommendation. It has been put and not answered, and no part of this branch
assumes it.

---

Built-by: @projectx.sui /|\
Co-authored-by: Kaela <kaela@projectxprotocol.dev>
