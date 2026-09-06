#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# rebuild-check.sh — THE decisive measurement for Drift Watch.
#
# Does a local rebuild reproduce the bytecode the chain actually holds?
# Everything else about this product is a plan until this answers yes.
#
# Compares per-module bytecode: locally built vs deployed on mainnet.
# Reads only. Never writes to the scanned tree beyond Move's own build dir.
#
# Usage: rebuild-check.sh <package-dir> <published-at-address>
set -uo pipefail
PKG="${1:?usage: rebuild-check.sh <package-dir> <published-at>}"
ADDR="${2:?usage: rebuild-check.sh <package-dir> <published-at>}"
NAME="$(basename "$PKG")"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# --- deployed side ---
if ! sui client object "$ADDR" --json > "$TMP/chain.json" 2>"$TMP/chain.err"; then
  echo "$NAME: CHAIN-READ-FAILED  $(head -1 "$TMP/chain.err")"; exit 3
fi
python3 - "$TMP/chain.json" "$TMP/chain_mods.json" <<'PY'
import json,sys,base64
d=json.load(open(sys.argv[1]))
mm=(d.get('content') or {}).get('Package',{}).get('module_map') or {}
out={k: base64.b64encode(bytes(v)).decode() for k,v in mm.items()}
json.dump(out, open(sys.argv[2],'w'))
print(f"  deployed modules: {len(out)}")
PY

# --- local side ---
if ! (cd "$PKG" && sui move build --dump-bytecode-as-base64 >"$TMP/local.json" 2>"$TMP/local.err"); then
  echo "$NAME: BUILD-FAILED  $(grep -m1 -iE 'error|failed' "$TMP/local.err" | cut -c1-90)"; exit 4
fi

python3 - "$TMP/chain_mods.json" "$TMP/local.json" "$NAME" <<'PY'
import json,sys
chain=json.load(open(sys.argv[1])); name=sys.argv[3]
raw=json.load(open(sys.argv[2]))
# `--dump-bytecode-as-base64` shape varies by sui version: a bare list of
# base64 modules, or an object carrying `modules` (+ `digest`).
mods = raw.get('modules') if isinstance(raw,dict) else raw
if mods is None: mods=[]
local=set(mods)
cset=set(chain.values())
matched=len(local & cset)
print(f"  local modules   : {len(local)}")
print(f"  byte-identical  : {matched}/{len(chain)}")
if matched==len(chain) and len(chain)>0:
    print(f"{name}: REPRODUCES")
else:
    missing=[k for k,v in chain.items() if v not in local]
    print(f"{name}: DIFFERS  (modules not reproduced: {', '.join(sorted(missing)[:6])})")
PY
