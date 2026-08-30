# PROTOCOLX VERIFY — UPDATE

**READ THIS FILE FROM THE TOP. Newest first.** The entry below the title is the current state;
everything under it is history, in reverse. Stop reading when you know enough.

**This is the governing document.** Where it disagrees with a plan, an audit, a code comment or
anything a desk told you, **this wins** — and the newer entry wins over the older one. An older
entry that contradicts a newer one is not a conflict to resolve; it was already superseded.

Never edit an old entry to agree with a new one. Never delete one. Add, and say what you
superseded. Append with `operations/watcher/note-update.sh verify "<summary>"`.
Law: `operations/company/UPDATE-FILE-LAW.md`.

---

## 2026-08-30 · Publishable tree, BUSL-1.1, and a drift gate between the shipped and internal engines

**Who:** engineering desk · **Where:** repository root, `engine/`, `.github/workflows/ci.yml` · **Ref:** PR #10 merged, main at `f94710f`

The tree is publishable: **zero third-party source files** remain in it (1,056 lines across two
trees were withdrawn), and the tripwire test that proves a worker-less tree refuses to run is
present and passing.

**Licence: BUSL-1.1, Change Date 2029-09-01**, Apache-2.0 as the change licence.

**A drift defect was found in our own product and is being closed.** The engine we ship was not
identical to the engine we run in house — the shipped loader did not load `shadow.py` at all.
Measurement was unaffected (identical derived counts and identical mutation-set digests before
and after the sync), so the shipped engine was **under-equipped, not wrong** — but a verification
product with undeclared drift between its copies is not production grade, and we will not sell
drift defence while shipping drift.

The fix names `verification-tools` canonical, makes the shipped copy a build artifact of it, and
adds a CI gate that fails when the two diverge. The gate was proven by deleting the module,
reproducing the defect, catching it three ways, and restoring it — with true exit codes checked
without a pipe: 1 on drift, 0 on clean.

- **Open:** that work sits on branches, uncommitted, awaiting the Master's word.
- **Note:** this repository is on a publication path. **This file will be read by clients.** Keep
  it to what a client may see — no prospect names, no unpublished prices, no internal
  deliberation. The estate's private record of this product is in `operations/UPDATE.md`.
