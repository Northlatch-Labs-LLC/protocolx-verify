#!/usr/bin/env bash
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# tripwire — hash every file this action ships, before the client's code exists on
# the machine and again after it has run, and refuse to report a verdict if the two
# do not match.
#
# WHY IT IS A SCRIPT AND NOT TWO INLINE `find` CALLS. It used to be three copies of
# one command line inside action.yml, and the copies named a fixed directory list:
#
#     find runner worker engine action -type f ...
#
# `find` exits non-zero when a named directory does not exist. Under `set -euo
# pipefail` that ends the step — so in any tree that ships without one of those
# directories the tripwire ERRORED instead of TRIPPING, and an errored tripwire is
# an absent one. The arming step failing loudly is the merciful case; the shape to
# fear is a tree where the fingerprint is never taken and nothing later notices.
#
# So: hash the directories that are present, refuse outright if none are, and take
# the before and after readings through the same code path — because a tripwire
# whose two halves can drift apart is a tripwire that reports on itself.
#
# __pycache__ is excluded: our own engine self-test writes .pyc files between the
# two readings, and a tripwire that cries wolf gets disabled by the next engineer.
#
# Usage:
#   tripwire.sh arm    <action-path> <out-file>
#   tripwire.sh verify <action-path> <before-file> <after-file>
#
# `verify` exits 1 with a `::error title=PVS sandbox breach::` annotation when the
# readings differ. Nothing downstream should run after that.
set -euo pipefail

# Every directory whose contents are ours to ship. A tree that omits one — the
# published action carries no Cloudflare worker — must still arm.
TRIPWIRE_DIRS="runner worker engine action"

# `xargs` cannot call a shell function, so the hashing tool is resolved by name.
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

_fingerprint() {
  local root="$1" out="$2"
  # Resolved before the cd, so a relative out-file still lands where the caller
  # meant it to.
  case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
  cd "$root"
  # A plain string, not an array: an empty array under `set -u` is its own
  # portability trap, and these names are fixed literals with no whitespace, so
  # the unquoted expansion below is deliberate and safe.
  local present=""
  local d
  for d in $TRIPWIRE_DIRS; do
    if [ -d "$d" ]; then present="$present $d"; fi
  done
  if [ -z "$present" ]; then
    echo "::error title=PVS tripwire unarmed::None of $TRIPWIRE_DIRS exist under $root, so the shipped tooling cannot be fingerprinted. Refusing to run: an unarmed tripwire is worse than a failed one, because nothing later would notice." >&2
    return 1
  fi
  # shellcheck disable=SC2086
  find $present -type f -not -path '*/__pycache__/*' -print0 \
    | sort -z | xargs -0 $SHA > "$out"
  echo "$present"
}

case "${1:-}" in
  arm)
    root="${2:?tripwire.sh arm <action-path> <out-file>}"
    out="${3:?tripwire.sh arm <action-path> <out-file>}"
    dirs="$(_fingerprint "$root" "$out")"
    echo "tooling fingerprinted: $(wc -l < "$out" | tr -d ' ') files across$dirs"
    ;;
  verify)
    root="${2:?tripwire.sh verify <action-path> <before-file> <after-file>}"
    before="${3:?tripwire.sh verify <action-path> <before-file> <after-file>}"
    after="${4:?tripwire.sh verify <action-path> <before-file> <after-file>}"
    _fingerprint "$root" "$after" >/dev/null
    if ! diff -u "$before" "$after"; then
      echo "::error title=PVS sandbox breach::A file under $TRIPWIRE_DIRS changed while the client's code was running. No verdict will be posted from this tree."
      exit 1
    fi
    echo "tooling unchanged across the client's run"
    ;;
  *)
    echo "usage: tripwire.sh arm <action-path> <out-file>" >&2
    echo "       tripwire.sh verify <action-path> <before-file> <after-file>" >&2
    exit 2
    ;;
esac
