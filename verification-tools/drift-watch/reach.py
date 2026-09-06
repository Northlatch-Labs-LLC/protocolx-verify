#!/usr/bin/env python3
"""
reach.py — the reachability probe for Drift Watch.

Answers one commercial question before any detector is built: how many
mainnet Move packages can we ACTUALLY watch? A watch needs BOTH halves --
a real on-chain address the package was published at, and a source tree we
can rebuild. Either half missing and the package is unwatchable, no matter
how much we want the customer.

Reads only. Never network. Never writes to a scanned tree.
Stdlib only, no pip.

Usage: reach.py <dir> [<dir> ...]
"""
import os, re, sys, json

def _sect(text, name):
    """Crude TOML section reader: returns dict of the [name] block."""
    out, inside = {}, False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('['):
            inside = (s.rstrip(']').lstrip('[').strip() == name)
            continue
        if inside and '=' in s and not s.startswith('#'):
            k, _, v = s.partition('=')
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out

def probe(pkg):
    """Classify one Move package directory."""
    r = {'path': pkg, 'name': os.path.basename(pkg), 'published_at': None,
         'original_id': None, 'toolchain': None, 'source': None,
         'srcs': 0, 'watchable': False, 'reason': ''}

    # --- source half ---
    sdir = os.path.join(pkg, 'sources')
    if os.path.isdir(sdir):
        n = sum(1 for _, _, fs in os.walk(sdir) for f in fs if f.endswith('.move'))
        r['srcs'] = n
    if r['srcs'] == 0:
        r['reason'] = 'no Move sources'
        return r

    # --- address half, in order of quality ---
    pub = os.path.join(pkg, 'Published.toml')
    if os.path.isfile(pub):
        d = _sect(open(pub, encoding='utf-8', errors='replace').read(), 'published.mainnet')
        if d.get('published-at'):
            r.update(published_at=d['published-at'], original_id=d.get('original-id'),
                     toolchain=d.get('toolchain-version'), source='Published.toml')

    if not r['published_at']:
        mt = os.path.join(pkg, 'Move.toml')
        if os.path.isfile(mt):
            t = open(mt, encoding='utf-8', errors='replace').read()
            m = re.search(r'^\s*published-at\s*=\s*"(0x[0-9a-fA-F]+)"', t, re.M)
            if m:
                r.update(published_at=m.group(1), source='Move.toml')

    if not r['published_at']:
        ml = os.path.join(pkg, 'Move.lock')
        if os.path.isfile(ml):
            t = open(ml, encoding='utf-8', errors='replace').read()
            m = re.search(r'latest-published-id\s*=\s*"(0x[0-9a-fA-F]+)"', t) or \
                re.search(r'original-published-id\s*=\s*"(0x[0-9a-fA-F]+)"', t)
            if m:
                r.update(published_at=m.group(1), source='Move.lock(legacy)')

    if not r['published_at']:
        r['reason'] = 'no mainnet published-at (not deployed, or address not committed)'
        return r
    if r['published_at'].strip('0x').strip('0') == '':
        r['reason'] = 'published-at is 0x0 — placeholder, not a deployment'
        return r

    r['watchable'] = True
    r['reason'] = 'watchable'
    if not r['toolchain']:
        # Still watchable, but a byte-identical rebuild is not guaranteed.
        r['reason'] = 'watchable (no toolchain recorded — rebuild may not be byte-identical)'
    return r

def find_pkgs(root):
    skip = {'build', 'node_modules', '.git', 'worktrees'}
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in skip]
        if 'Move.toml' in fns:
            yield dp
            dns[:] = []   # a package is a leaf; do not descend into deps

if __name__ == '__main__':
    roots = sys.argv[1:] or ['.']
    rows = [probe(p) for root in roots for p in sorted(find_pkgs(root))]
    rows = [r for r in rows if r['srcs'] > 0]     # vendored/empty shells are not packages
    watch = [r for r in rows if r['watchable']]
    print(f"packages with Move sources : {len(rows)}")
    print(f"WATCHABLE (addr + source)  : {len(watch)}")
    pct = (100.0*len(watch)/len(rows)) if rows else 0.0
    print(f"reachability               : {pct:.0f}%")
    tc = sum(1 for r in watch if r['toolchain'])
    print(f"  of those, toolchain known: {tc}/{len(watch)}"
          f"  (byte-identical rebuild only guaranteed for these)")
    print()
    for r in sorted(rows, key=lambda r: (not r['watchable'], r['name'])):
        mark = 'WATCH' if r['watchable'] else '  --  '
        via = f" via {r['source']}" if r['source'] else ''
        print(f"  [{mark}] {r['name']:<26} {r['srcs']:>3} src  {r['reason']}{via}")
    if '--json' in os.environ.get('REACH_OPTS', ''):
        print(json.dumps(rows, indent=2))
