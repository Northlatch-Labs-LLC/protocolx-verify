#!/usr/bin/env python3
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
"""
apply — write one mutation into one file.

Edits are absolute (offset, length, replacement) triples computed against the
PRISTINE source at derivation time, so this always reads the pristine copy and
writes the mutant. Applying a mutation to an already-mutated file would shift
every later offset; reading from the backup makes that impossible rather than
merely unlikely.

Replacements never change the file's line count. The driver's byte-hash
before/after check remains the authority on whether an edit landed.
"""
import json
import sys


def apply_one(pristine_text, mutation):
    off = mutation["edit_offset"]
    length = mutation["edit_length"]
    repl = mutation["edit_replacement"]
    if off < 0 or off + length > len(pristine_text):
        raise ValueError("edit out of range for %s" % mutation.get("id"))
    return pristine_text[:off] + repl + pristine_text[off + length:]


def main(argv):
    import argparse
    p = argparse.ArgumentParser(prog="apply.py")
    p.add_argument("--set", required=True, help="mutation-set JSON")
    p.add_argument("--id", required=True, help="mutation id to apply")
    p.add_argument("--src", required=True, help="pristine source file")
    p.add_argument("--dst", required=True, help="file to write the mutant to")
    a = p.parse_args(argv)

    with open(a.set, encoding="utf-8") as fh:
        data = json.load(fh)
    m = next((x for x in data["mutations"] if x["id"] == a.id), None)
    if m is None:
        sys.stderr.write("no such mutation: %s\n" % a.id)
        return 2
    with open(a.src, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    out = apply_one(text, m)
    if out == text:
        sys.stderr.write("mutation %s changed nothing\n" % a.id)
        return 3
    with open(a.dst, "w", encoding="utf-8") as fh:
        fh.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
