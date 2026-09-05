#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT. Downstream artifact of verification-tools.
# Edit the canonical copy there, then run sync-engine.sh. Edits here are lost
# on the next sync and cause the engine to differ from the tree it claims.
# source_commit: 095fd383d981aee15ad3a49ab9d2683c511eb366
# ─────────────────────────────────────────────────────────────────────────────
# Built-by: @projectx.sui
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# Read a package digest out of `sui move build --dump-bytecode-as-base64` output.
#
# Its own file rather than a `python3 -c` inside a pipeline, and the reason is the defect it was
# extracted from: in a pipeline, a parse failure exits non-zero and the caller cannot tell that
# apart from a digest that did not match. Here the two answers have different exit codes and the
# reason is printed.
#
#   exit 0  the digest, on stdout
#   exit 2  it could not be read, and why, on stderr. NEVER exit 1 — the runner maps a gate's
#           failure to "drift", which is an accusation about somebody's source. Not being able to
#           measure is a different statement and must not be published as the same one.
import json
import sys

if len(sys.argv) != 2:
    sys.stderr.write('usage: digest-of-dump.py <dump-file>\n')
    sys.exit(2)

raw = open(sys.argv[1], 'rb').read()

if len(raw) == 0:
    # The observed failure: an empty dump with exit code 0 from the build. Named explicitly,
    # because "empty" and "malformed" have different causes and a reader deserves to know which.
    sys.stderr.write('digest-of-dump: the build produced an EMPTY dump (0 bytes).\n')
    sys.exit(2)

# The runner's dump is not always clean JSON the way a local one is: parse from the first '{' so
# leading terminal noise cannot break the read.
start = raw.find(b'{')
if start < 0:
    sys.stderr.write(
        'digest-of-dump: no JSON object in %d bytes of output. First 300: %r\n' % (len(raw), raw[:300])
    )
    sys.exit(2)

try:
    dump = json.loads(raw[start:])
except Exception as exc:
    sys.stderr.write('digest-of-dump: not parseable as JSON (%s). First 300: %r\n' % (exc, raw[:300]))
    sys.exit(2)

digest = dump.get('digest')
if not isinstance(digest, list) or len(digest) == 0:
    sys.stderr.write('digest-of-dump: the dump carries no usable `digest` field.\n')
    sys.exit(2)

print(bytes(digest).hex())
