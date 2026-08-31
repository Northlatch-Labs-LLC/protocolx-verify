#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 5cddcbf033925bf3a9729eaa5a535160115dde11
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
"""
operators — the mutation operator classes.

A suite that catches a deleted assertion routinely misses a flipped
comparison, so deletion alone measures less than it appears to. Each class
below produces a distinct, independently identified mutation so a report can
name WHICH operator survived WHERE rather than reporting an undifferentiated
percentage.

Every operator returns edits as absolute (offset, length, replacement) triples
into the raw file text. Replacements never change the file's line count, so
line numbers derived before mutation stay valid after it.

Stable identifiers. An operator's rule id is CLASS or CLASS.VARIANT and is
part of the published manifest: it must not be renamed once a report has
cited it.
"""
import re

import movelex

# Ordered: derivation emits classes in this order for deterministic output.
CLASSES = ["DEL", "CMP", "BND", "NEG", "ARI", "ARG", "RET"]

SETS = {
    "delete": ["DEL"],
    "standard": ["DEL", "CMP", "BND", "NEG"],
    "all": CLASSES,
}

DESCRIPTIONS = {
    "DEL": "Assertion deletion — the guard is removed entirely.",
    "CMP": "Relational operator swap — a comparison is replaced by an adjacent one (>= to >, == to !=).",
    "BND": "Boundary shift — an integer literal in the guard is moved by one, testing off-by-one sensitivity.",
    "NEG": "Condition negation — the guard's condition is inverted.",
    "ARI": "Arithmetic operator swap — an operator inside the guard is replaced (+ to -, * to /).",
    "ARG": "Operand order swap — the two sides of a comparison are exchanged.",
    "RET": "Early-return injection — the guard is replaced by an early return from a unit-returning function.",
}

# --- CMP ------------------------------------------------------------------
# Two-character operators are matched before one-character ones so that `>=`
# is never seen as `>`. `=` alone and `=>` are not comparisons and are absent.
CMP_SWAPS = [
    (">=", ">", "GE_TO_GT"),
    ("<=", "<", "LE_TO_LT"),
    ("==", "!=", "EQ_TO_NE"),
    ("!=", "==", "NE_TO_EQ"),
    (">", ">=", "GT_TO_GE"),
    ("<", "<=", "LT_TO_LE"),
]

SYMMETRIC = {"==", "!="}

ARI_SWAPS = [("+", "-", "ADD_TO_SUB"), ("-", "+", "SUB_TO_ADD"),
             ("*", "/", "MUL_TO_DIV"), ("/", "*", "DIV_TO_MUL")]

INT_LITERAL = re.compile(r"\b(\d[\d_]*)((?:u8|u16|u32|u64|u128|u256)?)\b")


def _is_generic_angle(masked, idx):
    """True when a `<` or `>` at `idx` is a type-parameter bracket rather than
    a comparison.

    Move writes generics as `option::is_some<u64>(&x)` and comparisons as
    `a < b`. The distinguishing signal is spacing: a generic bracket abuts an
    identifier on the left and a non-space on the right. This is a heuristic,
    it is stated as one in the report, and a mutation it gets wrong fails to
    compile and is counted as INVALID rather than silently scored as killed.
    """
    c = masked[idx]
    if c not in "<>":
        return False
    left = masked[idx - 1] if idx > 0 else " "
    right = masked[idx + 1] if idx + 1 < len(masked) else " "
    if c == "<":
        return left in movelex.IDENT and right not in " \t\n="
    return left not in " \t\n=" and (right == "(" or left in movelex.IDENT)


def _scan_ops(text, masked, lo, hi, table):
    """Yield (offset, found, replacement, variant) for operator occurrences in
    the masked half-open range [lo,hi).

    The cursor advances on every path, including the paths that reject a
    candidate. An earlier revision could `break` out of the table loop without
    advancing, which hung the derivation on any package containing a generic
    bracket — caught by the suite before it ever reached a package.
    """
    i = lo
    while i < hi:
        step = 1
        for found, repl, variant in table:
            if not masked.startswith(found, i):
                continue
            if i + len(found) > hi:
                continue
            step = len(found)
            if found in ("<", ">") and _is_generic_angle(masked, i):
                break
            # Do not read the `<` of `<=` as a bare `<`, nor the `=` of `==`.
            if found in ("<", ">", "!", "=") and masked[i + 1:i + 2] == "=":
                break
            if found in ("+", "-", "*", "/", "<", ">") and masked[i - 1:i] == "=":
                break
            yield i, found, repl, variant
            break
        i += step


def _cond_bounds(text, masked, a):
    """Offsets of the assert's first argument (the condition)."""
    parts = movelex.split_top_commas(masked, a["open_paren"] + 1, a["close_paren"])
    lo, hi = parts[0]
    while lo < hi and text[lo] in " \t\n":
        lo += 1
    while hi > lo and text[hi - 1] in " \t\n":
        hi -= 1
    return lo, hi


def _abort_code(text, masked, a):
    parts = movelex.split_top_commas(masked, a["open_paren"] + 1, a["close_paren"])
    if len(parts) < 2:
        return ""
    lo, hi = parts[1]
    return text[lo:hi].strip()


def _blank_span_edit(text, a):
    """DEL's edit: blank every line the assertion occupies, preserving the
    line count. This is byte-for-byte what the first-pass tool did to a
    single-line assert, which is why the published numbers survive."""
    first_start, _ = movelex.line_bounds(text, a["start"])
    _, last_end = movelex.line_bounds(text, a["end"] - 1)
    nlines = text.count("\n", first_start, last_end)
    return first_start, last_end - first_start, "\n" * nlines


def derive_for_assert(text, masked, a, classes, functions):
    """Every mutation for one assertion, in stable CLASSES order."""
    out = []
    clo, chi = _cond_bounds(text, masked, a)
    cond = text[clo:chi]

    def add(cls, variant, off, length, repl, note=""):
        out.append({
            "operator": cls,
            "variant": variant,
            "rule_id": cls if not variant else cls + "." + variant,
            "edit_offset": off,
            "edit_length": length,
            "edit_replacement": repl,
            "note": note,
        })

    for cls in classes:
        if cls == "DEL":
            off, length, repl = _blank_span_edit(text, a)
            add("DEL", "", off, length, repl)

        elif cls == "CMP":
            for off, found, repl, variant in _scan_ops(text, masked, clo, chi, CMP_SWAPS):
                add("CMP", variant, off, len(found), repl)

        elif cls == "ARI":
            for off, found, repl, variant in _scan_ops(text, masked, clo, chi, ARI_SWAPS):
                add("ARI", variant, off, len(found), repl)

        elif cls == "BND":
            for m in INT_LITERAL.finditer(masked, clo, chi):
                lit = text[m.start():m.end()]
                add("BND", "INC", m.start(), len(lit), "(" + lit + " + 1)")
                add("BND", "DEC", m.start(), len(lit), "(" + lit + " - 1)")

        elif cls == "NEG":
            if cond:
                add("NEG", "", clo, chi - clo, "!(" + cond + ")")

        elif cls == "ARG":
            for off, found, repl, variant in _scan_ops(text, masked, clo, chi, CMP_SWAPS):
                if found in ("<", ">") and _is_generic_angle(masked, off):
                    continue
                lhs = text[clo:off].strip()
                rhs = text[off + len(found):chi].strip()
                if not lhs or not rhs:
                    continue
                swapped = rhs + " " + found + " " + lhs
                if "\n" in text[clo:chi]:
                    continue  # operand swap across lines would change line count
                note = ("operand order is semantically irrelevant for a symmetric "
                        "comparison") if found in SYMMETRIC else ""
                add("ARG", found_name(found), clo, chi - clo, swapped, note)

        elif cls == "RET":
            fn = movelex.enclosing_function(functions, a["start"])
            if fn is None or fn["has_return_type"]:
                continue
            off, length, repl = _blank_span_edit(text, a)
            indent_start, _ = movelex.line_bounds(text, a["start"])
            indent = ""
            k = indent_start
            while k < len(text) and text[k] in " \t":
                indent += text[k]
                k += 1
            add("RET", "", off, length, indent + "return" + repl)

    return out


def found_name(op):
    return {">=": "GE", "<=": "LE", "==": "EQ", "!=": "NE", ">": "GT", "<": "LT"}[op]
