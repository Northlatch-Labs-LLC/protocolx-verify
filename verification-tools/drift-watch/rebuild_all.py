#!/usr/bin/env python3
"""
rebuild_all.py — does a local rebuild reproduce the bytecode the chain holds?

THE decisive measurement. Everything else about Drift Watch is a plan until
this answers yes on real packages.

ONE STATED NORMALIZATION, and it is not a fudge:
`sui move build` emits the package's own self-address as 32 zero bytes -- the
address is only fixed at publish time. The deployed module carries the
package's original-id there instead. We therefore substitute 32-zero-byte
runs in the LOCAL bytes with the original-id before comparing. A 32-byte zero
run is not otherwise expected in Move bytecode, but this IS a normalization
and it is declared: a comparison is reported as reproducing only if it is
byte-identical AFTER exactly this substitution and no other.

Reads only. Stdlib only.
"""
import json, os, re, subprocess, sys, base64

def sect(text, name):
    out, inside = {}, False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('['):
            inside = (s.rstrip(']').lstrip('[').strip() == name); continue
        if inside and '=' in s and not s.startswith('#'):
            k, _, v = s.partition('=')
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out

def installed_toolchain():
    r = run(['sui', '--version'])
    return r.stdout.strip().split()[-1] if r.returncode == 0 else '?'

def addrs(pkg):
    """mainnet published-at + original-id + recorded toolchain."""
    p = os.path.join(pkg, 'Published.toml')
    if os.path.isfile(p):
        d = sect(open(p, encoding='utf-8', errors='replace').read(), 'published.mainnet')
        if d.get('published-at'):
            return (d['published-at'], d.get('original-id') or d['published-at'],
                    d.get('toolchain-version'))
    mt = os.path.join(pkg, 'Move.toml')
    if os.path.isfile(mt):
        m = re.search(r'^\s*published-at\s*=\s*"(0x[0-9a-fA-F]+)"',
                      open(mt, encoding='utf-8', errors='replace').read(), re.M)
        if m: return m.group(1), m.group(1), None
    return None, None, None

def run(cmd, cwd=None, timeout=600):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)

def chain_modules(addr):
    r = run(['sui', 'client', 'object', addr, '--json'])
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).strip()
        if 'not found' in msg.lower() or 'not exist' in msg.lower():
            return None, f"NOT LIVE — recorded address does not resolve on mainnet"
        return None, f"chain read failed: {msg[:80]}"
    try:
        d = json.loads(r.stdout)
        mm = (d.get('content') or {}).get('Package', {}).get('module_map') or {}
        if not mm: return None, "object is not a package / no module_map"
        return {k: bytes(v) for k, v in mm.items()}, None
    except Exception as e:
        return None, f"parse failed: {e}"

def local_modules(pkg):
    r = run(['sui', 'move', 'build', '--dump-bytecode-as-base64'], cwd=pkg)
    if r.returncode != 0:
        err = next((l for l in r.stderr.splitlines() if 'rror' in l), r.stderr.strip()[:80])
        return None, f"build failed: {err[:90]}"
    try:
        raw = json.loads(r.stdout)
        mods = raw.get('modules') if isinstance(raw, dict) else raw
        return [base64.b64decode(m) for m in (mods or [])], None
    except Exception as e:
        return None, f"dump parse failed: {e}"

def compare(pkg):
    name = os.path.basename(pkg.rstrip('/'))
    label = f"{name} ({os.path.basename(os.path.dirname(pkg.rstrip('/')))})"
    pub, orig, rec_tc = addrs(pkg)
    inst = installed_toolchain()
    tcnote = ''
    if rec_tc:
        tcnote = (f" [toolchain recorded {rec_tc} == installed]" if rec_tc in inst
                  else f" [TOOLCHAIN MISMATCH: recorded {rec_tc}, installed {inst}]")
    else:
        tcnote = f" [no toolchain recorded; installed {inst}]"
    if not pub: return label, 'SKIP', 'no mainnet published-at'
    cm, err = chain_modules(pub)
    if err: return label, 'ERROR', err
    lm, err = local_modules(pkg)
    if err: return label, 'ERROR', err

    oid = bytes.fromhex(orig[2:].rjust(64, '0'))
    norm = [m.replace(b'\x00' * 32, oid) for m in lm]
    lset = set(norm)

    matched = sum(1 for v in cm.values() if v in lset)
    total = len(cm)
    if matched == total and total > 0:
        return label, 'REPRODUCES', f"{total}/{total} modules byte-identical{tcnote}"

    # characterise the failure honestly
    details = []
    for mname, cb in sorted(cm.items()):
        if cb in lset: continue
        best = min(norm, key=lambda b: abs(len(b) - len(cb)), default=None)
        if best is None:
            details.append(f"{mname}: no local module"); continue
        if len(best) != len(cb):
            details.append(f"{mname}: length differs (local {len(best)} vs chain {len(cb)})")
        else:
            d = sum(1 for a, b in zip(best, cb) if a != b)
            details.append(f"{mname}: same length, {d} bytes differ")
    return label, 'DIFFERS', f"{matched}/{total} identical{tcnote}; " + "; ".join(details[:4])

if __name__ == '__main__':
    pkgs = sys.argv[1:]
    rows = [compare(p) for p in pkgs]
    rep = sum(1 for _, s, _ in rows if s == 'REPRODUCES')
    att = sum(1 for _, s, _ in rows if s in ('REPRODUCES', 'DIFFERS'))
    print()
    for label, status, detail in rows:
        print(f"[{status:>10}] {label}")
        print(f"             {detail}")
    print(f"\n=== REPRODUCED {rep} of {att} attempted "
          f"({len(rows)-att} skipped/errored) ===")
