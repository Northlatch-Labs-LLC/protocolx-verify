#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 095fd383d981aee15ad3a49ab9d2683c511eb366
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui · Co-authored-by: Claude
"""
shadow — survivor TRIAGE, never a verdict.

WHAT THIS ANSWERS, AND WHAT IT DOES NOT
---------------------------------------
When a guard-deletion mutant survives, there are two very different reasons,
and a mutation score cannot tell them apart:

  (a) NO TEST EXERCISES THE GUARD AT ALL. Nothing ever calls the function with
      an input that violates the condition. The guard is simply untested.

  (b) A TEST DOES EXERCISE IT, BUT THE ORACLE CANNOT SEE THE DIFFERENCE.
      Deleting the guard hands the abort to something ELSE on the same path —
      a native division, an integer cast, `table::add` on a duplicate key —
      so a bare `#[expected_failure]` still sees "an abort" and still passes.

This module measures a STATIC PROPERTY OF THE CODE that bears on (b): can
anything after the guard, inside the same function, abort on its own?

**It does not, and cannot, tell you which of (a) or (b) caused a given mutant
to survive.** That requires reading the tests. The label describes the SHAPE OF
THE CODE, not the cause of the survival. Every string this module emits is
worded to keep that distinction visible, because the failure mode that matters
is a label that lets a team conclude a guard is fine when it is not.

THE ONE RULE
------------
A shadow label NEVER means the guard is tested, never means the survivor is
acceptable, and never suppresses a survivor. Survivors are reported in full
regardless of label. An untested guard is an untested guard.

CONSERVATISM DIRECTION
----------------------
`no-fallback-abort` is the only SOUND label here: it is emitted only when the
tail is provably abort-free under every input. The presence of an abortable
construct proves only that an abort is POSSIBLE, never that it fires — that
depends on runtime values — so those labels are named "…-present" and
"…-correlated" rather than anything that sounds like a conclusion. Anything
unmodelled is `unknown`. We would rather say nothing than say something a
team could mistake for reassurance.
"""

import os
import re

import movelex

# --- labels ---------------------------------------------------------------

NO_FALLBACK = "no-fallback-abort"
CORRELATED = "fallback-abort-correlated"
PRESENT = "fallback-abort-present"
UNKNOWN = "unknown"
NOT_APPLICABLE = "not-applicable"

LABELS = (NO_FALLBACK, CORRELATED, PRESENT, UNKNOWN, NOT_APPLICABLE)

# Never let this module be read as a verdict, wherever a label surfaces.
LABEL_MEANING = (
    "Shadow labels describe the SHAPE OF THE CODE AFTER A GUARD, not why a "
    "mutant survived and not whether the guard is safe. A survivor is a "
    "survivor at every label: an untested guard is an untested guard. "
    "Distinguishing 'no test exercises this guard' from 'a test does, but its "
    "oracle cannot see the difference' requires reading the tests."
)

# --- what can abort on its own -------------------------------------------
# Framework operations that abort on a precondition of their own. These are the
# constructs that most often mask a deleted guard, because the guard is usually
# checking exactly the precondition the operation is about to check natively.

ABORTING_CALLS = (
    "table::add", "table::borrow", "table::borrow_mut", "table::remove",
    "table_vec::borrow", "table_vec::borrow_mut", "table_vec::pop_back",
    "object_table::add", "object_table::borrow", "object_table::borrow_mut",
    "object_table::remove",
    "dynamic_field::add", "dynamic_field::borrow", "dynamic_field::borrow_mut",
    "dynamic_field::remove",
    "dynamic_object_field::add", "dynamic_object_field::borrow",
    "dynamic_object_field::borrow_mut", "dynamic_object_field::remove",
    "bag::add", "bag::borrow", "bag::borrow_mut", "bag::remove",
    "object_bag::add", "object_bag::borrow", "object_bag::remove",
    "vec_map::get", "vec_map::get_mut", "vec_map::insert", "vec_map::remove",
    "vec_set::insert", "vec_set::remove",
    "vector::borrow", "vector::borrow_mut", "vector::pop_back",
    "vector::remove", "vector::swap_remove", "vector::swap",
    "option::destroy_some", "option::extract", "option::borrow",
    "option::borrow_mut", "option::fill",
    "balance::split", "balance::withdraw_all", "coin::split",
    "coin::from_balance", "coin::take",
)

_CAST = re.compile(r"\bas\s+u(?:8|16|32|64|128|256)\b")
_INDEX = re.compile(r"[A-Za-z0-9_\)\]]\s*\[")
_IDENT_CALL = re.compile(r"([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*\(")
_SYMBOL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# `if (x)` is not a call. Neither is `while (…)`. Excluding these is what lets
# a pure-construction tail be recognised as provably abort-free.
_KEYWORDS = {
    "if", "while", "loop", "return", "abort", "else", "let", "match",
    "copy", "move", "as", "and", "or", "not", "break", "continue", "spec",
}

# Arithmetic that can abort: division and modulo (by zero), and the operators
# that can overflow. Presence proves possibility, never certainty.
_DIVMOD = ("/", "%")
_OVERFLOWABLE = ("+", "-", "*", "<<")


def _symbols(s):
    return {m.group(0) for m in _SYMBOL.finditer(s)} - _KEYWORDS


def _scan_tail(text, masked, lo, hi):
    """Everything abort-capable in text[lo:hi]. Returns (reasons, calls, symbols).

    Scans the MASKED text for constructs so a `/` inside a comment or a string
    can never be mistaken for a division.
    """
    seg_m = masked[lo:hi]
    seg_t = text[lo:hi]
    reasons = []
    hits = []

    for name in ABORTING_CALLS:
        idx = seg_m.find(name)
        if idx != -1:
            reasons.append("`%s` aborts on its own precondition" % name)
            hits.append((name, lo + idx))

    if "assert!" in seg_m:
        reasons.append("a later `assert!` on the same path can abort")
        hits.append(("assert!", lo + seg_m.find("assert!")))
    if re.search(r"\babort\b", seg_m):
        reasons.append("an explicit `abort` on the same path")
        hits.append(("abort", lo + re.search(r"\babort\b", seg_m).start()))

    mcast = _CAST.search(seg_m)
    if mcast:
        reasons.append("an integer cast (`%s`) aborts on truncation"
                       % seg_t[mcast.start():mcast.end()].strip())
        hits.append((seg_t[mcast.start():mcast.end()].strip(), lo + mcast.start()))

    for op in _DIVMOD:
        idx = seg_m.find(op)
        if idx != -1:
            reasons.append("`%s` aborts on a zero divisor" % op)
            hits.append((op, lo + idx))

    for op in _OVERFLOWABLE:
        idx = seg_m.find(op)
        if idx != -1:
            reasons.append("`%s` can abort on overflow" % op)
            hits.append((op, lo + idx))

    midx = _INDEX.search(seg_m)
    if midx:
        reasons.append("an index expression aborts when out of bounds")
        hits.append(("[]", lo + midx.start()))

    # Any call at all: a user function may abort internally and we do not
    # follow it. This never yields a "shadowed" claim — it only blocks the
    # sound `no-fallback-abort` label.
    calls = []
    for m in _IDENT_CALL.finditer(seg_m):
        name = m.group(1)
        if name.split("::")[-1] in _KEYWORDS or name in _KEYWORDS:
            continue
        calls.append((name, lo + m.start()))

    return reasons, hits, calls


def _tail_symbols(text, masked, lo, hi, hits):
    """Symbols appearing near the abort-capable constructs, for correlation."""
    out = set()
    for _name, off in hits:
        a = max(lo, off - 120)
        b = min(hi, off + 160)
        out |= _symbols(text[a:b])
    return out


def analyze_one(text, masked, functions, assert_span, condition):
    """Classify one guard deletion. Returns a dict; never raises."""
    fn = movelex.enclosing_function(functions, assert_span["start"])
    if fn is None:
        return {
            "label": UNKNOWN,
            "evidence": "could not determine the enclosing function, so the code "
                        "after the guard was not analysed",
        }
    lo = assert_span["end"]
    hi = fn["end"]
    if lo >= hi:
        return {
            "label": NO_FALLBACK,
            "evidence": "the guard is the last statement in `%s`; no code follows "
                        "it that could abort instead" % fn["name"],
        }

    reasons, hits, calls = _scan_tail(text, masked, lo, hi)

    if not reasons and not calls:
        return {
            "label": NO_FALLBACK,
            "evidence": "nothing after this guard in `%s` can abort under any input "
                        "(no calls, no arithmetic, no casts, no indexing), so removing "
                        "the guard makes the call return normally instead of aborting"
                        % fn["name"],
        }

    if not reasons and calls:
        names = sorted({c[0] for c in calls})[:4]
        return {
            "label": UNKNOWN,
            "evidence": "no abort-capable construct was recognised after this guard, "
                        "but %d call(s) follow it (%s) and this analysis does not "
                        "follow calls, so whether anything else can abort is unknown"
                        % (len(calls), ", ".join("`%s`" % n for n in names)),
        }

    cond_syms = _symbols(condition or "")
    near = _tail_symbols(text, masked, lo, hi, hits)
    shared = sorted(cond_syms & near)
    uniq = []
    for r in reasons:
        if r not in uniq:
            uniq.append(r)
    detail = "; ".join(uniq[:3])

    if shared:
        return {
            "label": CORRELATED,
            "evidence": "after this guard, %s — and it involves %s, also named in the "
                        "guard's own condition. If a test does exercise this guard, a "
                        "bare `#[expected_failure]` could pass on that abort instead; "
                        "testing it needs `abort_code = …`"
                        % (detail, ", ".join("`%s`" % s for s in shared[:3])),
            "shared_symbols": shared[:6],
        }

    return {
        "label": PRESENT,
        "evidence": "after this guard, %s. Not tied to the guard's own condition, so "
                    "whether it could mask this guard is unproven" % detail,
    }


def annotate(pkg, muts):
    """Attach `shadow` to every mutation. Additive only — nothing is removed,
    reordered, or suppressed, and no field feeding the mutation-set hash is
    touched, so annotated runs stay byte-reproducible against earlier ones."""
    by_file = {}
    for m in muts:
        by_file.setdefault(m["file"], []).append(m)

    for rel, group in by_file.items():
        path = os.path.join(pkg, rel)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            for m in group:
                m["shadow"] = {"label": UNKNOWN,
                               "evidence": "source file could not be read"}
            continue
        masked = movelex.mask(text)
        functions = movelex.find_functions(text)
        spans = {}
        for a in movelex.find_asserts(text):
            spans.setdefault(movelex.line_of(text, a["start"]), a)

        for m in group:
            if m.get("operator") != "DEL":
                m["shadow"] = {
                    "label": NOT_APPLICABLE,
                    "evidence": "shadow analysis applies to guard DELETION; this "
                                "mutation leaves the guard in place",
                }
                continue
            a = spans.get(m["line"])
            if a is None:
                m["shadow"] = {
                    "label": UNKNOWN,
                    "evidence": "the guard's span could not be located in the source",
                }
                continue
            cond = m.get("condition") or ""
            if not cond:
                clo, chi = movelex.split_top_commas(
                    masked, a["open_paren"] + 1, a["close_paren"])[0]
                cond = " ".join(text[clo:chi].split())
            try:
                m["shadow"] = analyze_one(text, masked, functions, a, cond)
            except Exception as exc:  # never let triage break a measurement
                m["shadow"] = {"label": UNKNOWN,
                               "evidence": "analysis error: %s" % type(exc).__name__}
    return muts


def summarize(results):
    """Counts by label over whatever list is passed (normally survivors)."""
    out = {k: 0 for k in LABELS}
    for r in results:
        lab = (r.get("shadow") or {}).get("label", UNKNOWN)
        out[lab] = out.get(lab, 0) + 1
    return out
