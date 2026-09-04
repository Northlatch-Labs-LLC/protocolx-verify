# PROTOCOLX VERIFY — UPDATE

**READ THIS FILE FROM THE TOP. Newest first.** The entry below the title is the current state;
everything under it is history, in reverse. Stop reading when you know enough.

**This is the governing document.** Where it disagrees with a plan, an audit, a code comment or
anything a desk told you, **this wins** — and the newer entry wins over the older one. An older
entry that contradicts a newer one is not a conflict to resolve; it was already superseded.

Never edit an old entry to agree with a new one. Never delete one. Add, and say what you
superseded.

---

## 2026-09-04 · Security sweep: this file's convention corrected going forward

Every entry above and below this one stands as written; law here is never edited, only
superseded by a newer entry, and this is that entry. The estate's security desk swept every
repository this company holds for material meant to stay on the local machine and found, among
entries in this file, a decision quoted word for word and the paths of internal documents named
directly. Neither belongs in a file whose only job is telling the next reader what changed, why,
and what was verified.

GOING FORWARD: an entry may state that a decision was made and by whom in role terms, never quote
the decision's exact wording, and never name the path of an internal report, state file or desk
tool. Where the fact of a decision matters to the next reader, it is stated as a fact, not as a
quotation or a path. Findings sit on this repository's own `security/eyes-only` branch; the estate
sweep's own report is a desk document and is not named here on purpose.

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
