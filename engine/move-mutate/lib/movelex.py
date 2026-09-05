#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 095fd383d981aee15ad3a49ab9d2683c511eb366
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui · Co-authored-by: Claude
"""
movelex — the minimum lexical understanding of Move source that mutation
derivation needs, and not one feature more.

The tool's only product is numbers an auditor is meant to trust, so the two
things this module must never do are (a) mistake a comment or a string literal
for code and (b) mis-identify where an expression ends. Everything here exists
to make those two failures impossible; nothing here attempts to be a Move
parser.
"""

IDENT = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


def mask(text):
    """Return a string the same length as `text` with every byte that is not
    live code replaced by a space (newlines preserved so offsets and line
    numbers stay aligned).

    Handles: // line comments, /* */ block comments (nested, as Move allows),
    "..." string literals with backslash escapes, x"..." hex literals, and
    b"..." byte-string literals.
    """
    out = []
    i = 0
    n = len(text)
    depth = 0          # block-comment nesting depth
    while i < n:
        c = text[i]
        if depth > 0:
            if text.startswith("/*", i):
                depth += 1
                out.append("  ")
                i += 2
                continue
            if text.startswith("*/", i):
                depth -= 1
                out.append("  ")
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if text.startswith("/*", i):
            depth = 1
            out.append("  ")
            i += 2
            continue
        if text.startswith("//", i):
            while i < n and text[i] != "\n":
                out.append(" ")
                i += 1
            continue
        if c == '"':
            out.append(" ")
            i += 1
            while i < n:
                if text[i] == "\\" and i + 1 < n:
                    out.append("  ")
                    i += 2
                    continue
                if text[i] == '"':
                    out.append(" ")
                    i += 1
                    break
                out.append("\n" if text[i] == "\n" else " ")
                i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def match_paren(masked, open_idx):
    """Given the index of an opening delimiter, return the index of its match.

    Returns -1 if unbalanced. Operates on masked text, so delimiters inside
    strings and comments cannot confuse it.
    """
    pairs = {"(": ")", "[": "]", "{": "}"}
    close = pairs[masked[open_idx]]
    opener = masked[open_idx]
    depth = 0
    for i in range(open_idx, len(masked)):
        if masked[i] == opener:
            depth += 1
        elif masked[i] == close:
            depth -= 1
            if depth == 0:
                return i
    return -1


def split_top_commas(masked, start, end):
    """Split the half-open masked range [start,end) on commas at nesting
    depth zero. Returns a list of (lo, hi) offset pairs."""
    parts = []
    depth = 0
    lo = start
    for i in range(start, end):
        c = masked[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append((lo, i))
            lo = i + 1
    parts.append((lo, end))
    return parts


def line_of(text, offset):
    """1-based line number containing `offset`."""
    return text.count("\n", 0, offset) + 1


def line_bounds(text, offset):
    """(start, end) offsets of the line containing `offset`; end excludes \\n."""
    start = text.rfind("\n", 0, offset) + 1
    end = text.find("\n", offset)
    if end == -1:
        end = len(text)
    return start, end


def find_asserts(text):
    """Every `assert!` macro call in live code, with its full span.

    Returns a list of dicts: start (offset of the `a` in assert!), open_paren,
    close_paren, semi (offset of the terminating `;`, or close_paren if the
    call is not followed by one), and end (offset one past the span).
    """
    m = mask(text)
    found = []
    i = 0
    while True:
        i = m.find("assert!", i)
        if i == -1:
            break
        # Must be a whole token: `xassert!` and `_assert!` are not ours.
        if i > 0 and m[i - 1] in IDENT:
            i += 7
            continue
        j = i + 7
        while j < len(m) and m[j] in " \t\n":
            j += 1
        if j >= len(m) or m[j] != "(":
            i += 7
            continue
        close = match_paren(m, j)
        if close == -1:
            i += 7
            continue
        semi = close
        k = close + 1
        while k < len(m) and m[k] in " \t\n":
            k += 1
        if k < len(m) and m[k] == ";":
            semi = k
        found.append({
            "start": i,
            "open_paren": j,
            "close_paren": close,
            "semi": semi,
            "end": semi + 1,
        })
        i = close + 1
    return found


def find_functions(text):
    """Every `fun` definition with its brace span and whether it declares a
    return type. Used to decide where early-return injection is even legal."""
    m = mask(text)
    out = []
    i = 0
    while True:
        i = m.find("fun", i)
        if i == -1:
            break
        before_ok = i == 0 or m[i - 1] not in IDENT
        after = i + 3
        if not before_ok or after >= len(m) or m[after] in IDENT:
            i += 3
            continue
        j = after
        while j < len(m) and m[j] in " \t\n":
            j += 1
        name_start = j
        while j < len(m) and m[j] in IDENT:
            j += 1
        name = text[name_start:j]
        if not name:
            i += 3
            continue
        # Skip an optional generic parameter list, then the parameter list.
        while j < len(m) and m[j] in " \t\n":
            j += 1
        if j < len(m) and m[j] == "<":
            depth = 0
            while j < len(m):
                if m[j] == "<":
                    depth += 1
                elif m[j] == ">":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
        while j < len(m) and m[j] in " \t\n":
            j += 1
        if j >= len(m) or m[j] != "(":
            i += 3
            continue
        params_close = match_paren(m, j)
        if params_close == -1:
            i += 3
            continue
        body_open = m.find("{", params_close)
        if body_open == -1:
            i += 3
            continue
        between = m[params_close + 1:body_open]
        has_return_type = ":" in between
        body_close = match_paren(m, body_open)
        if body_close == -1:
            i += 3
            continue
        out.append({
            "name": name,
            "start": i,
            "body_open": body_open,
            "end": body_close,
            "has_return_type": has_return_type,
        })
        i = body_close + 1
    return out


def enclosing_function(functions, offset):
    """Innermost function span containing `offset`, or None."""
    best = None
    for f in functions:
        if f["start"] <= offset <= f["end"]:
            if best is None or f["start"] > best["start"]:
                best = f
    return best


# --- test-internal detection ---------------------------------------------
# Move permits `#[test]` and `#[test_only]` functions declared INLINE inside a
# production module. Their bodies contain assertions. Deleting an assertion
# inside a test body cannot fail that test — weakening a test never breaks it —
# so such a mutation ALWAYS survives and is always a phantom. Phantoms inflate
# the survivor count and deflate the kill rate, i.e. they move the headline
# number in the direction that flatters us. Directory-based exclusion
# (`*/tests/*`) does not see them at all.

TEST_ATTRS = {"test", "test_only"}
_DECL_MODIFIERS = {"public", "entry", "native", "friend", "package"}


def _attr_names(inner):
    """Attribute names in a `#[...]` list, ignoring their arguments.

    `#[test, expected_failure]` -> ['test', 'expected_failure']
    `#[allow(lint(missing_key))]` -> ['allow']
    """
    names = []
    depth = 0
    tok = []
    for ch in inner:
        if ch in "([{":
            depth += 1
            if depth == 1:
                continue
        elif ch in ")]}":
            depth -= 1
            continue
        if depth > 0:
            continue
        if ch == ",":
            names.append("".join(tok).strip())
            tok = []
        else:
            tok.append(ch)
    names.append("".join(tok).strip())
    return [n for n in names if n]


def _skip_ws(m, j):
    while j < len(m) and m[j] in " \t\n\r":
        j += 1
    return j


def find_test_regions(text):
    """Half-open (start, end) offset ranges covering everything a `#[test]` or
    `#[test_only]` annotation governs.

    Handles the annotation, any further attributes stacked after it, the
    `public` / `entry` / `native` / `public(package)` modifiers that may follow
    on the same or a later line, and then brace-matches the declaration body.
    Module-level `#[test_only] module` is handled in both the braced form and
    the Move 2024 `module x;` label form, which governs the rest of the file.
    """
    m = mask(text)
    n = len(m)
    regions = []
    i = 0
    while True:
        i = m.find("#[", i)
        if i == -1:
            break
        close = match_paren(m, i + 1)
        if close == -1:
            i += 2
            continue
        names = _attr_names(text[i + 2:close])
        if not any(a in TEST_ATTRS for a in names):
            i = close + 1
            continue

        j = _skip_ws(m, close + 1)
        # Further stacked attributes, e.g. #[test] #[expected_failure]
        while j < n and m.startswith("#[", j):
            nxt = match_paren(m, j + 1)
            if nxt == -1:
                break
            j = _skip_ws(m, nxt + 1)

        # Declaration modifiers, including public(package) / public(friend).
        keyword = ""
        while j < n:
            k = j
            while k < n and m[k] in IDENT:
                k += 1
            word = text[j:k]
            if not word:
                break
            j = _skip_ws(m, k)
            if j < n and m[j] == "(" and word in _DECL_MODIFIERS:
                pc = match_paren(m, j)
                if pc == -1:
                    break
                j = _skip_ws(m, pc + 1)
            if word in _DECL_MODIFIERS:
                continue
            keyword = word
            break

        brace = m.find("{", j)
        semi = m.find(";", j)
        end = None
        if keyword == "module":
            if semi != -1 and (brace == -1 or semi < brace):
                end = n              # `module x;` governs the rest of the file
            elif brace != -1:
                bc = match_paren(m, brace)
                end = bc + 1 if bc != -1 else n
        elif keyword in ("fun", "struct", "enum"):
            if brace != -1 and (semi == -1 or brace < semi):
                bc = match_paren(m, brace)
                end = bc + 1 if bc != -1 else n
            elif semi != -1:
                end = semi + 1       # `native fun f();` — no body
        elif keyword:
            if semi != -1:
                end = semi + 1       # use / const / friend declarations
        if end is None:
            end = close + 1
        regions.append((i, end))
        i = max(end, close + 1)
    return regions


def in_regions(regions, offset):
    for lo, hi in regions:
        if lo <= offset < hi:
            return True
    return False
