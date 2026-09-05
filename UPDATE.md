# PROTOCOLX VERIFY — UPDATE

**READ THIS FILE FROM THE TOP. Newest first.** The entry below the title is the current state;
everything under it is history, in reverse. Stop reading when you know enough.

**This is the governing document.** Where it disagrees with a plan, an audit, a code comment or
anything a desk told you, **this wins** — and the newer entry wins over the older one. An older
entry that contradicts a newer one is not a conflict to resolve; it was already superseded.

Never edit an old entry to agree with a new one. Never delete one. Add, and say what you
superseded.

---

## 2026-09-05 · The `/|\` glyph removed from every file header; main is `b86ca2f`, pushed

On the owner's ruling of 2026-09-05 the three-character glyph after `@projectx.sui` in every `Built-by` header line is gone; the attribution stays. Scraped copies of these files rendered it as runs of escaped backslashes. One sed over every tracked text file, only header lines changed, `git grep` for the glyph returns nothing tracked. Landed on main by fast-forward from `chore/drop-the-mark` and pushed to GitHub; no deploy, because no rendered byte changed. The commit trailer is now `Built-by: @projectx.sui` then `Co-authored-by: Kaela <kaela@projectxprotocol.dev>`.

## 2026-09-03 · Gate run on this laptop, recorded in the estate ledger; main at `2ade54f`, clean

**Who:** engineering agent on the chief technology officer's dispatch · **Where:** `main` at `2ade54f`, 0 dirty files, `main...origin/main` per the local ref (not fetched) · **Ref:** `work/state/gate-runs.json` id `protocolx-verify`; report `work/reports/2026-09-03-engineering-gates-for-every-solution.md`

The 22 steps of `.github/workflows/ci.yml` (job `Self-gates`) were run here in the same order, 19 seconds in all, every step exit 0: the worker's lib, ledger and evidence-store tests; preflight; `secret-distance: 9 passed, 0 failed`; the mutation engine's `Ran 50 tests … OK`; gates-output mirror; `TRIPWIRE OK — 7 checks. It trips in a worker-less tree`; runner wiring; evidence bundle; `CLASSIFIER OK`; engine-drift; digest-reader OK; `digest-compare: all checks passed`; toolchain-note; app-path `12/12 checks passed`; every shell, JS and Python entrypoint parses; `deploy.sh uploads index.js / lib.js / ledger.js: OK`; `sha256sum -c engine/CHECKSUMS` all OK; manifest valid JSON, workflows readable.

**Result: pass.** This is the repository's own gate on itself; no client package was measured.

---

## 2026-08-31 · Currency note: main has advanced past the entry below (PR #17 merged)

**Who:** desk audit (read-only verification) · **Where:** main at `67014a3` · **Ref:** PR #17

Recording main's advance so the newest entry matches HEAD: the shipped engine is marked as generated with a refreshed checksum manifest, the README states at the top which of the three verify repos this is, and engine banners are generated (PR #17, `engine-generated-banners`). No findings — purely a currency note from the 2026-08-31 estate audit.

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

- **Open:** that work is staged and not yet landed.
- **Note:** this repository is on a publication path. **This file will be read by clients.** Keep
  it to what a client may see — no prospect names, no unpublished prices, no internal
  deliberation. Internal notes on this product are kept outside this repository.
