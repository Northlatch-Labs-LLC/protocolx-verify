#!/usr/bin/env python3
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
"""
deps — find the smallest directory tree that contains a package AND every
local dependency it needs to build.

Move packages routinely declare `local = "../libs/math"` dependencies that live
OUTSIDE the package directory. A parallel worker given a copy of only the
package cannot resolve them, so every build fails. Left undetected that
presents as "every mutant is invalid", which is indistinguishable at a glance
from a genuinely broken suite — and on one real package it produced a run that
reported 84 of 84 invalid and still exited 0.

Regex rather than tomllib: tomllib is stdlib only from 3.11, and the tool
states a 3.8 floor.
"""
import os
import re
import sys

LOCAL_DEP = re.compile(r'^\s*local\s*=\s*"([^"]+)"', re.M)
INLINE_LOCAL = re.compile(r'local\s*=\s*"([^"]+)"')


def local_deps(pkg_dir):
    """Absolute paths of every local dependency declared by this package."""
    toml = os.path.join(pkg_dir, "Move.toml")
    if not os.path.isfile(toml):
        return []
    try:
        with open(toml, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return []
    # Strip comments so a commented-out example dependency is not followed.
    text = "\n".join(line.split("#", 1)[0] for line in text.split("\n"))
    paths = set(LOCAL_DEP.findall(text)) | set(INLINE_LOCAL.findall(text))
    return [os.path.normpath(os.path.join(pkg_dir, p)) for p in sorted(paths)]


def closure(pkg_dir, _seen=None):
    """The package plus every local dependency, transitively."""
    if _seen is None:
        _seen = set()
    pkg_dir = os.path.abspath(pkg_dir)
    if pkg_dir in _seen:
        return _seen
    _seen.add(pkg_dir)
    for dep in local_deps(pkg_dir):
        if os.path.isdir(dep):
            closure(dep, _seen)
    return _seen


def copy_root(pkg_dir):
    """The shallowest directory that contains the whole closure.

    Returns the package directory itself when nothing escapes it, so the
    common case stays cheap.
    """
    dirs = closure(pkg_dir)
    root = os.path.commonpath(sorted(dirs)) if len(dirs) > 1 else os.path.abspath(pkg_dir)
    # commonpath can land above a package on a sibling layout; that is intended.
    return root


if __name__ == "__main__":
    print(copy_root(sys.argv[1]))
