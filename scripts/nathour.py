#!/usr/bin/env python3
"""OUT/req des resp natives PAR HEURE UTC — cherche une MARCHE datee plutot qu'une derive.

Si OUT/req saute a une heure precise et reste, c'est un changement de config/modele.
S'il monte progressivement avec la profondeur de contexte, c'est un effet de contexte.
Usage: python nathour.py <jours...>   (lit les dirs w-<jour> deja extraits)
"""
import os
import re
import sys
from collections import defaultdict

SP = os.path.dirname(os.path.abspath(__file__))
US = re.compile(r'"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),'
                r'"cache_read_input_tokens":(\d+)')
OUT = re.compile(r'"output_tokens":(\d+)')
THK = re.compile(r'"thinking_tokens":(\d+)')
TS = re.compile(r'-(\d{4}-\d{2}-\d{2})T(\d{2})-')


def pct(v, p):
    return v[min(len(v) - 1, int(p * len(v)))] if v else 0


for day in sys.argv[1:]:
    W = os.path.join(SP, f'w-{day}')
    if not os.path.isdir(W):
        print(f'{day}: dir absent ({W})')
        continue
    per = defaultdict(lambda: {'n': 0, 'out': [], 'thk': [], 'pfx': []})
    for f in os.listdir(W):
        if not (f.startswith('resp-') and 'native' in f):
            continue
        m = TS.search(f)
        if not m:
            continue
        h = m.group(2)
        try:
            raw = open(os.path.join(W, f), encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        u = US.search(raw)
        if not u:
            continue
        o = OUT.findall(raw)
        if not o:
            continue
        b = per[h]
        b['n'] += 1
        b['out'].append(int(o[-1]))
        t = THK.findall(raw)
        b['thk'].append(int(t[-1]) if t else 0)
        b['pfx'].append(int(u.group(1)) + int(u.group(2)) + int(u.group(3)))
    print(f'=== {day} (UTC) ===')
    print(f'{"h":>3s} {"n":>4s} {"OUT/req":>8s} {"OUT p50":>8s} {"p90":>7s} '
          f'{"think p50":>9s} {"pfx/req":>9s} {"sum OUT":>10s}')
    tn = tsum = 0
    for h in sorted(per):
        b = per[h]
        b['out'].sort()
        b['thk'].sort()
        tn += b['n']
        tsum += sum(b['out'])
        print(f"{h:>3s} {b['n']:4d} {sum(b['out'])/b['n']:8,.0f} "
              f"{pct(b['out'], .5):8,d} {pct(b['out'], .9):7,d} "
              f"{pct(b['thk'], .5):9,d} {sum(b['pfx'])/b['n']:9,.0f} {sum(b['out']):10,d}")
    print(f"  TOTAL n={tn}  OUT/req={tsum/max(1,tn):,.0f}\n")
