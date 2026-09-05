#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 095fd383d981aee15ad3a49ab9d2683c511eb366
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui · Co-authored-by: Claude
"""
derive — build the mutation set for a package, deterministically.

Two derivation modes, and the difference between them is load-bearing:

  legacy-line  The first-pass predicate, reproduced exactly: a mutation is a
               line whose trimmed text starts with `assert!` and contains
               `);`. Multi-line asserts are SKIPPED and counted. This is the
               DEFAULT, and it is the default for one reason — a published
               client report cites numbers produced by it, and a measurement
               instrument that cannot reproduce its own published numbers from
               its own defaults is not an instrument.

  parse        Real lexical analysis (see movelex): every `assert!` is found
               regardless of layout, multi-line included. Selected by
               --multiline, or implied by any operator class beyond DEL.

Ordering is deterministic — sorted by (file, offset, class order, variant) —
so the same inputs give the same mutation set in the same order on any
machine. The first-pass tool inherited filesystem order from `find`, which is
not reproducible across machines and is exactly what a third party attempting
to reproduce a run would trip over.
"""
import hashlib
import json
import os
import sys

import movelex
import operators
import shadow


def iter_sources(pkg, filter_sub=""):
    """Package sources, excluding in-sources test directories, sorted.

    Sorted, not filesystem order: reproducibility depends on it.
    """
    root = os.path.join(pkg, "sources")
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, pkg)
        parts = rel_dir.split(os.sep)
        if "test" in parts or "tests" in parts:
            continue
        for fn in sorted(filenames):
            if not fn.endswith(".move"):
                continue
            rel = os.path.join(rel_dir, fn)
            if filter_sub and filter_sub not in rel:
                continue
            hits.append(rel)
    hits.sort()
    return hits


def count_excluded_tests(pkg):
    """In-sources test files, counted so they can be PRINTED. A number stated
    is a capability boundary; a number dropped is a lie of omission."""
    root = os.path.join(pkg, "sources")
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        parts = os.path.relpath(dirpath, pkg).split(os.sep)
        if "test" not in parts and "tests" not in parts:
            continue
        n += sum(1 for f in filenames if f.endswith(".move"))
    return n


def derive_legacy(pkg, files):
    """The first-pass predicate, reproduced exactly — plus the test-internal
    exclusion, which is a correctness fix rather than a change of predicate:
    an assertion inside a `#[test]` body can never be killed, so every
    mutation derived from one was a guaranteed phantom survivor."""
    muts, skipped, excluded = [], [], []
    for rel in files:
        path = os.path.join(pkg, rel)
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        lines = text.split("\n")
        regions = movelex.find_test_regions(text)
        line_starts = []
        acc = 0
        for l in lines:
            line_starts.append(acc)
            acc += len(l) + 1
        for idx, raw in enumerate(lines):
            if "assert!" not in raw:
                continue
            trimmed = raw.lstrip()
            if trimmed.startswith("//"):
                continue
            if not trimmed.startswith("assert!"):
                continue
            lineno = idx + 1
            if movelex.in_regions(regions, line_starts[idx] + raw.index("assert!")):
                excluded.append({"file": rel, "line": lineno, "text": trimmed,
                                 "reason": "test-internal (enclosing #[test]/#[test_only])"})
                continue
            if ");" in trimmed:
                line_start = line_starts[idx]
                muts.append({
                    "file": rel,
                    "line": lineno,
                    "end_line": lineno,
                    "operator": "DEL",
                    "variant": "",
                    "rule_id": "DEL",
                    "original": trimmed,
                    "edit_offset": line_start,
                    "edit_length": len(raw),
                    "edit_replacement": "",
                    "multiline": False,
                    "condition": "",
                    "abort_code": "",
                    "function": "",
                    "note": "",
                    "occurrence": 0,
                })
            else:
                skipped.append({"file": rel, "line": lineno, "text": trimmed,
                                "reason": "multi-line assert (legacy-line derivation)"})
    return muts, skipped, excluded


def derive_parsed(pkg, files, classes):
    """Full lexical derivation across every operator class requested."""
    muts, skipped, excluded = [], [], []
    for rel in files:
        path = os.path.join(pkg, rel)
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        masked = movelex.mask(text)
        functions = movelex.find_functions(text)
        regions = movelex.find_test_regions(text)
        for a in movelex.find_asserts(text):
            start_line = movelex.line_of(text, a["start"])
            if movelex.in_regions(regions, a["start"]):
                ls_, le_ = movelex.line_bounds(text, a["start"])
                excluded.append({"file": rel, "line": start_line,
                                 "text": text[ls_:le_].strip(),
                                 "reason": "test-internal (enclosing #[test]/#[test_only])"})
                continue
            end_line = movelex.line_of(text, a["end"] - 1)
            ls, le = movelex.line_bounds(text, a["start"])
            original = text[a["start"]:a["end"]].replace("\n", " ")
            original = " ".join(original.split())
            fn = movelex.enclosing_function(functions, a["start"])
            clo, chi = operators._cond_bounds(text, masked, a)
            for m in operators.derive_for_assert(text, masked, a, classes, functions):
                m.update({
                    "file": rel,
                    "line": start_line,
                    "end_line": end_line,
                    "original": original,
                    "multiline": end_line > start_line,
                    "condition": " ".join(text[clo:chi].split()),
                    "abort_code": operators._abort_code(text, masked, a),
                    "function": fn["name"] if fn else "",
                })
                muts.append(m)
    return muts, skipped, excluded


def preclassify(muts, pkg):
    """Attach an evidence-backed PROPOSAL to each mutation.

    This never dismisses anything. A survivor is a survivor until a human says
    otherwise; the tool's job is to hand that human the evidence, not the
    verdict. PVS Layer 1 requires every survivor named with its reason, and a
    reason a machine invented is not a reason.
    """
    seen = {}
    test_text = ""
    for d in ("tests", "sources"):
        root = os.path.join(pkg, d)
        for dirpath, _dn, filenames in os.walk(root):
            parts = os.path.relpath(dirpath, pkg).split(os.sep)
            if d == "sources" and "test" not in parts and "tests" not in parts:
                continue
            for fn in sorted(filenames):
                if fn.endswith(".move"):
                    try:
                        with open(os.path.join(dirpath, fn), encoding="utf-8",
                                  errors="replace") as fh:
                            test_text += fh.read()
                    except OSError:
                        pass

    for m in muts:
        proposals = []
        if m["operator"] == "ARG" and m.get("note"):
            proposals.append({
                "classification": "structurally untestable",
                "confidence": "high",
                "evidence": "operand order is semantically irrelevant for a symmetric "
                            "comparison; this mutant is equivalent by construction",
            })
        key = (m["file"], m.get("function", ""), m.get("condition", ""))
        if m.get("condition"):
            prior = seen.get(key)
            if prior is not None and prior < m["line"]:
                proposals.append({
                    "classification": "defensive no-op",
                    "confidence": "medium",
                    "evidence": "an identical condition is asserted earlier in the same "
                                "function at line %d; this guard may be dominated" % prior,
                })
            elif prior is None:
                seen[key] = m["line"]
        fname = m.get("function", "")
        if fname and test_text and fname not in test_text:
            proposals.append({
                "classification": "real gap",
                "confidence": "medium",
                "evidence": "no test source names the enclosing function `%s`" % fname,
            })
        m["proposals"] = proposals
    return muts


def finalize(muts):
    """Stable ordering and stable identifiers."""
    order = {c: i for i, c in enumerate(operators.CLASSES)}
    muts.sort(key=lambda m: (m["file"], m["line"], m.get("edit_offset", 0),
                             order.get(m["operator"], 99), m.get("variant", "")))
    counter = {}
    for m in muts:
        k = (m["file"], m["line"], m["rule_id"])
        n = counter.get(k, 0)
        counter[k] = n + 1
        m["occurrence"] = n
        m["id"] = "%s:%d:%s#%d" % (m["file"], m["line"], m["rule_id"], n)
    return muts


def set_hash(muts):
    """SHA-256 over the canonical mutation set — the identity of the run.

    Two runs quoting the same hash mutated exactly the same things in exactly
    the same way. That is what makes a third-party reproduction checkable
    rather than merely plausible.
    """
    canon = [
        {"id": m["id"], "file": m["file"], "line": m["line"], "rule": m["rule_id"],
         "off": m.get("edit_offset"), "len": m.get("edit_length"),
         "repl": m.get("edit_replacement")}
        for m in muts
    ]
    blob = json.dumps(canon, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def main(argv):
    import argparse
    p = argparse.ArgumentParser(prog="derive.py", add_help=True)
    p.add_argument("package")
    p.add_argument("--operators", default="delete")
    p.add_argument("--multiline", action="store_true")
    p.add_argument("--filter", default="")
    p.add_argument("--limit", type=int, default=0)
    args = p.parse_args(argv)

    pkg = args.package
    if args.operators not in operators.SETS:
        named = [c.strip().upper() for c in args.operators.split(",") if c.strip()]
        unknown = [c for c in named if c not in operators.CLASSES]
        if unknown:
            sys.stderr.write("unknown operator class(es): %s\nknown: %s\nsets: %s\n"
                             % (", ".join(unknown), ", ".join(operators.CLASSES),
                                ", ".join(operators.SETS)))
            return 2
        classes = [c for c in operators.CLASSES if c in named]
    else:
        classes = operators.SETS[args.operators]

    files = iter_sources(pkg, args.filter)
    mode = "legacy-line"
    if args.multiline or classes != ["DEL"]:
        mode = "parse"

    if mode == "legacy-line":
        muts, skipped, excluded = derive_legacy(pkg, files)
    else:
        muts, skipped, excluded = derive_parsed(pkg, files, classes)

    # Shadow triage is attached AFTER the set is fixed and BEFORE the hash is
    # taken, which is safe precisely because set_hash() reads only the edit
    # identity fields — annotating cannot move a published number.
    muts = finalize(shadow.annotate(pkg, preclassify(muts, pkg)))
    truncated = 0
    if args.limit > 0 and len(muts) > args.limit:
        truncated = len(muts) - args.limit
        muts = muts[:args.limit]

    out = {
        "package": os.path.abspath(pkg),
        "derivation_mode": mode,
        "operator_classes": classes,
        "operator_set_arg": args.operators,
        "multiline_enabled": mode == "parse",
        "filter": args.filter,
        "derived": len(muts),
        "skipped": skipped,
        "skipped_count": len(skipped),
        "excluded_test_internal": excluded,
        "excluded_test_internal_count": len(excluded),
        "excluded_test_files": count_excluded_tests(pkg),
        "source_files": files,
        "limit_truncated": truncated,
        "mutation_set_sha256": set_hash(muts),
        "mutations": muts,
    }
    json.dump(out, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
