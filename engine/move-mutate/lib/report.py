#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 5cddcbf033925bf3a9729eaa5a535160115dde11
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
"""
report — emit the run in Markdown, JSON and SARIF from one manifest.

SARIF SEVERITY IS CAPPED IN CODE, DELIBERATELY. SARIF consumed by GitHub code
scanning renders as SECURITY ALERTS. A surviving mutant is an untested
invariant; it is NOT a vulnerability. Shipping SARIF that lights a client's
security dashboard red for untested asserts would be exactly the overclaim
this standard exists to refuse. `_safe_level` is the mechanism: nothing can
reach `level: "error"` by any code path, including a future caller that asks
for it. The unit suite asserts on that.
"""
import datetime
import json
import os
import sys

import operators
import shadow as shadowlib

TOOL_VERSION = "0.2.0"
# The URL GitHub renders in a client's code-scanning tab, from SARIF
# `tool.driver.informationUri`. It must point at the PUBLIC action repository:
# this string reaches every client's security tab, and a link to a private
# repository shows them a 404 while advertising that the private repository
# exists.
TOOL_URI = "https://github.com/Northlatch-Labs-LLC/protocolx-verify"

INDEPENDENCE_CLAUSE = (
    "This is an internal review by the party that wrote the code. It is evidence, "
    "not an audit: no claim of independence is made, and none should be inferred."
)

SURVIVOR_MEANING = (
    "A surviving mutant names an invariant that no test exercises. It is not, by "
    "itself, an exploit or a finding of vulnerability."
)

# Printed wherever a clean-looking number could be mistaken for proof of a sound
# suite. A static score cannot see an oracle pinned to the WRONG constant.
STATIC_SCORE_CAVEAT = (
    "A suite that scores well on any static measure is not thereby sound. An "
    "`#[expected_failure(abort_code = …)]` pinned to the WRONG constant looks "
    "precise to every grep and still fails to test what it names; only running "
    "the mutation can tell. Treat static counts as triage, never as assurance."
)

# The only levels this tool will ever emit. "error" is absent on purpose.
_ALLOWED_LEVELS = ("note", "warning")


def _safe_level(requested="note"):
    """Clamp any requested SARIF level into the permitted set.

    Called on every path that can set a level. A caller asking for "error"
    gets "warning"; there is no argument that produces "error".
    """
    return requested if requested in _ALLOWED_LEVELS else "warning"


def score(results):
    """The mutation score, with its denominator stated rather than implied.

    Equivalents and mutants that failed to compile are excluded from the
    denominator: scoring a mutant that could never be killed as a miss
    understates the suite, and scoring it as a kill flatters it. Both are
    wrong; excluding it and saying so is right.
    """
    executed = sum(1 for r in results if r["outcome"] in ("killed", "survived", "invalid"))
    killed = sum(1 for r in results if r["outcome"] == "killed")
    survived = sum(1 for r in results if r["outcome"] == "survived")
    invalid = sum(1 for r in results if r["outcome"] == "invalid")
    equivalent = sum(1 for r in results if r.get("confirmed_equivalent"))
    denom = executed - invalid - equivalent
    pct = (100.0 * killed / denom) if denom > 0 else None
    return {
        "executed": executed,
        "killed": killed,
        "survived": survived,
        "invalid_did_not_compile": invalid,
        "confirmed_equivalent": equivalent,
        "denominator": denom,
        "formula": "mutation score = killed / (executed - did-not-compile - confirmed-equivalent)",
        "mutation_score_pct": None if pct is None else round(pct, 1),
    }


def build_json(manifest, results):
    s = score(results)
    return {
        "tool": {"name": "move-mutate", "version": TOOL_VERSION},
        "independence_clause": INDEPENDENCE_CLAUSE,
        "survivor_meaning": SURVIVOR_MEANING,
        "manifest": manifest,
        "score": s,
        "results": results,
    }


def build_sarif(manifest, results):
    used = sorted({r["rule_id"].split(".")[0] for r in results}) or ["DEL"]
    rules = []
    for cls in used:
        rules.append({
            "id": cls,
            "name": cls,
            "shortDescription": {"text": operators.DESCRIPTIONS.get(cls, cls)},
            "fullDescription": {"text": operators.DESCRIPTIONS.get(cls, cls) + " " +
                                SURVIVOR_MEANING + " " + INDEPENDENCE_CLAUSE},
            "defaultConfiguration": {"level": _safe_level("note")},
            "properties": {"tags": ["mutation-testing", "test-quality", "not-a-vulnerability"]},
        })

    sarif_results = []
    for r in results:
        if r["outcome"] != "survived":
            continue
        proposals = r.get("proposals") or []
        extra = ""
        if proposals:
            extra = " Proposed classification (requires human confirmation): " + "; ".join(
                "%s — %s" % (p["classification"], p["evidence"]) for p in proposals)
        sarif_results.append({
            "ruleId": r["rule_id"].split(".")[0],
            "level": _safe_level("note"),
            "message": {"text": "Surviving mutant [%s]: the suite did not notice this change to "
                                "`%s`. %s%s" % (r["rule_id"], r.get("original", "").strip(),
                                                SURVIVOR_MEANING, extra)},
            "locations": [{
                "physicalLocation": {
                    "artifactLocation": {"uri": r["file"]},
                    "region": {"startLine": r["line"]},
                }
            }],
            "partialFingerprints": {"mutationId": r["id"]},
            "properties": {"operator": r["rule_id"], "outcome": "survived",
                           "proposals": proposals},
        })

    return {
        "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {
                "name": "move-mutate",
                "version": TOOL_VERSION,
                "informationUri": TOOL_URI,
                "rules": rules,
            }},
            "properties": {
                "independenceClause": INDEPENDENCE_CLAUSE,
                "survivorMeaning": SURVIVOR_MEANING,
                "manifest": manifest,
                "score": score(results),
            },
            "results": sarif_results,
        }],
    }


def build_markdown(manifest, results, skipped, excluded):
    s = score(results)
    survivors = [r for r in results if r["outcome"] == "survived"]
    invalid = [r for r in results if r["outcome"] == "invalid"]
    L = []
    a = L.append
    a("# Mutation report — %s" % os.path.basename(manifest["package"]))
    a("")
    a("> " + INDEPENDENCE_CLAUSE)
    a("")
    a("## Run identity")
    a("")
    a("| field | value |")
    a("|---|---|")
    for k in ("package", "repo_url", "commit_sha", "toolchain", "tool_version",
              "derivation_mode", "operator_classes", "mutation_set_sha256",
              "jobs", "test_filtering", "started_utc", "finished_utc"):
        if manifest.get(k) not in (None, ""):
            v = manifest[k]
            a("| %s | `%s` |" % (k, ", ".join(v) if isinstance(v, list) else v))
    a("")
    a("## Counts")
    a("")
    a("- derived: **%d**" % manifest["derived"])
    a("- executed: **%d** · killed: **%d** · survived: **%d**" %
      (s["executed"], s["killed"], s["survived"]))
    a("- did not compile (excluded from score): **%d**" % s["invalid_did_not_compile"])
    a("- multi-line asserts skipped: **%d**" % len(skipped))
    a("- asserts excluded as test-internal: **%d**" % len(excluded))
    a("- in-sources test files excluded: **%d**" % manifest.get("excluded_test_files", 0))
    a("")
    a("## Score")
    a("")
    a("`%s`" % s["formula"])
    a("")
    if s["mutation_score_pct"] is None:
        a("Score not defined: the denominator is zero.")
    else:
        a("**%d / %d = %.1f%%**" % (s["killed"], s["denominator"], s["mutation_score_pct"]))
    a("")
    if survivors:
        a("## Survivors — invariants nothing tests")
        a("")
        a(SURVIVOR_MEANING)
        a("")
        a("Each survivor requires a human classification (real gap / structurally "
          "untestable / defensive no-op). Proposals below are evidence for that "
          "decision, not the decision.")
        a("")
        counts = shadowlib.summarize(survivors)
        if any(counts.get(k) for k in (shadowlib.NO_FALLBACK, shadowlib.CORRELATED,
                                       shadowlib.PRESENT, shadowlib.UNKNOWN)):
            a("### Shadow triage")
            a("")
            a(shadowlib.LABEL_MEANING)
            a("")
            a("| behind the guard | survivors | what it means for testing this guard |")
            a("|---|---|---|")
            a("| `%s` | %d | nothing after the guard can abort, so deleting it makes "
              "the call return normally — any test that reaches this path at all "
              "would notice. Cheapest gaps to close. |"
              % (shadowlib.NO_FALLBACK, counts.get(shadowlib.NO_FALLBACK, 0)))
            a("| `%s` | %d | something after the guard can abort AND involves the "
              "same values the guard tests — a bare `#[expected_failure]` here can "
              "pass without testing anything; it needs `abort_code = …`. |"
              % (shadowlib.CORRELATED, counts.get(shadowlib.CORRELATED, 0)))
            a("| `%s` | %d | something after the guard can abort, but is not tied to "
              "the guard's condition. Unproven either way. |"
              % (shadowlib.PRESENT, counts.get(shadowlib.PRESENT, 0)))
            a("| `%s` | %d | not determined — calls this analysis does not follow. |"
              % (shadowlib.UNKNOWN, counts.get(shadowlib.UNKNOWN, 0)))
            a("")
            a("*%s*" % STATIC_SCORE_CAVEAT)
            a("")
        for r in survivors:
            a("- `%s:%d` [%s] `%s`" % (r["file"], r["line"], r["rule_id"],
                                       r.get("original", "").strip()))
            sh = r.get("shadow") or {}
            if sh.get("label") and sh["label"] != shadowlib.NOT_APPLICABLE:
                a("    - *behind the guard:* `%s` — %s" %
                  (sh["label"], sh.get("evidence", "")))
            for p in r.get("proposals") or []:
                a("    - *proposed:* %s (%s confidence) — %s" %
                  (p["classification"], p["confidence"], p["evidence"]))
        a("")
    if invalid:
        a("## Did not compile — excluded from the score")
        a("")
        a("These mutations produced source that does not build, so the suite could "
          "never have killed them. Counting them as kills would flatter the score.")
        a("")
        for r in invalid:
            a("- `%s:%d` [%s]" % (r["file"], r["line"], r["rule_id"]))
        a("")
    if excluded:
        a("## Excluded as test-internal")
        a("")
        a("Assertions inside `#[test]` / `#[test_only]` declarations. They are not "
          "production code and never reach deployed bytecode, so mutating them "
          "measures nothing about the contract.")
        a("")
        for e in excluded:
            a("- `%s:%d` `%s`" % (e["file"], e["line"], e["text"]))
        a("")
    if skipped:
        a("## Skipped — multi-line asserts (mutate by hand, or rerun with `--multiline`)")
        a("")
        for e in skipped:
            a("- `%s:%d` `%s`" % (e["file"], e["line"], e["text"]))
        a("")
    return "\n".join(L) + "\n"


def build_delta_markdown(base, wide):
    """The two-pass delta: what the wider operator set caught that deletion missed.

    This is the instrument measuring its own progression on the same code. It
    is deliberately a first-class output rather than something a human
    assembles by diffing two reports.
    """
    bkill = {r["id"] for r in base["results"] if r["outcome"] == "killed"}
    bfile = {(r["file"], r["line"]) for r in base["results"]}
    bsurv = {(r["file"], r["line"]) for r in base["results"] if r["outcome"] == "survived"}
    candidates = [r for r in wide["results"]
                  if r["outcome"] == "survived" and r["rule_id"].split(".")[0] != "DEL"
                  and (r["file"], r["line"]) not in bsurv
                  and (r["file"], r["line"]) in bfile]

    # A mutant that is equivalent BY CONSTRUCTION survives necessarily and is not a
    # finding. Swapping the operands of `a == b` cannot change behaviour, so listing
    # it as an invariant the suite failed to pin down would manufacture a finding out
    # of arithmetic. These are partitioned out of the headline and stated separately.
    def equivalent_by_construction(r):
        return any(p.get("confidence") == "high"
                   and p.get("classification") == "structurally untestable"
                   for p in (r.get("proposals") or []))

    newly = [r for r in candidates if not equivalent_by_construction(r)]
    equiv = [r for r in candidates if equivalent_by_construction(r)]

    L = []
    a = L.append
    a("# Two-pass delta — %s" % os.path.basename(wide["manifest"]["package"]))
    a("")
    a("> " + INDEPENDENCE_CLAUSE)
    a("")
    a("Pass A (deletion only): %d executed, %d killed, %d survived." %
      (base["score"]["executed"], base["score"]["killed"], base["score"]["survived"]))
    a("Pass B (%s): %d executed, %d killed, %d survived." %
      (", ".join(wide["manifest"]["operator_classes"]), wide["score"]["executed"],
       wide["score"]["killed"], wide["score"]["survived"]))
    a("")
    a("## Guards that pass A scored as covered and pass B did not")
    a("")
    a("Each line below is an assertion whose DELETION the suite caught, but whose "
      "meaning the suite does not actually pin down: a different mutation of the "
      "same guard survived. These are the invariants a deletion-only pass reports "
      "as covered when they are not.")
    a("")
    if not newly:
        a("None — the wider operator set found no guard that deletion scored as covered "
          "and a stronger mutation did not.")
    for r in newly:
        killed_by_del = any(b for b in base["results"]
                            if (b["file"], b["line"]) == (r["file"], r["line"])
                            and b["outcome"] == "killed")
        a("- `%s:%d` [%s] `%s`%s" % (r["file"], r["line"], r["rule_id"],
                                     r.get("original", "").strip(),
                                     "  — deletion of this guard WAS killed" if killed_by_del else ""))
    a("")
    if equiv:
        a("## Survived, but equivalent by construction — not findings")
        a("")
        a("These mutants cannot change behaviour, so their survival says nothing about "
          "the suite. They are listed for completeness and excluded from the count above.")
        a("")
        for r in equiv:
            ev = "; ".join(p["evidence"] for p in (r.get("proposals") or []))
            a("- `%s:%d` [%s] — %s" % (r["file"], r["line"], r["rule_id"], ev))
        a("")
    return "\n".join(L) + "\n"


def main(argv):
    import argparse
    p = argparse.ArgumentParser(prog="report.py")
    p.add_argument("--manifest", required=True)
    p.add_argument("--outdir", required=True)
    p.add_argument("--delta-base", default="")
    a = p.parse_args(argv)
    with open(a.manifest, encoding="utf-8") as fh:
        data = json.load(fh)
    manifest = data["manifest"]
    results = data["results"]
    skipped = data.get("skipped", [])
    excluded = data.get("excluded_test_internal", [])

    os.makedirs(a.outdir, exist_ok=True)
    doc = build_json(manifest, results)
    doc["skipped"] = skipped
    doc["excluded_test_internal"] = excluded
    with open(os.path.join(a.outdir, "MUTATION-REPORT.md"), "w", encoding="utf-8") as fh:
        fh.write(build_markdown(manifest, results, skipped, excluded))
    with open(os.path.join(a.outdir, "mutation-report.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
    with open(os.path.join(a.outdir, "mutation-report.sarif"), "w", encoding="utf-8") as fh:
        json.dump(build_sarif(manifest, results), fh, indent=2)
    if a.delta_base:
        with open(a.delta_base, encoding="utf-8") as fh:
            base = json.load(fh)
        with open(os.path.join(a.outdir, "MUTATION-DELTA.md"), "w", encoding="utf-8") as fh:
            fh.write(build_delta_markdown(base, doc))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
