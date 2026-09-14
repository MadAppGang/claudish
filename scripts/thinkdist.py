#!/usr/bin/env python3
"""Distribution des thinking_tokens PAR REPONSE native — cherche un amas au plafond.

Si les tours s'accumulent juste sous budget_tokens (31999), le modele pense a son
budget maximal : c'est un comportement, pas une profondeur de contexte.
Usage: python thinkdist.py <jours...>
"""
import os
import re
import sys

SP = os.path.dirname(os.path.abspath(__file__))
THK = re.compile(r'"thinking_tokens":(\d+)')
BRK = [0, 1, 100, 500, 1000, 2000, 4000, 8000, 16000, 24000, 28000, 32000]
NOM = ['0', '<100', '100-500', '500-1k', '1-2k', '2-4k', '4-8k', '8-16k',
       '16-24k', '24-28k', '28-32k', '>=32k']

for day in sys.argv[1:]:
    W = os.path.join(SP, f'w-{day}')
    if not os.path.isdir(W):
        print(f'{day}: dir absent')
        continue
    vals = []
    for f in os.listdir(W):
        if not (f.startswith('resp-') and 'native' in f):
            continue
        try:
            raw = open(os.path.join(W, f), encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        t = THK.findall(raw)
        if t:
            vals.append(int(t[-1]))
    if not vals:
        print(f'{day}: aucun thinking_tokens')
        continue
    vals.sort()
    n = len(vals)
    hist = [0] * (len(BRK))
    for v in vals:
        for i in range(len(BRK) - 1, -1, -1):
            if v >= BRK[i]:
                hist[i] += 1
                break
    print(f'=== {day} : n={n} avec thinking | somme={sum(vals):,} | '
          f'moy={sum(vals)/n:,.0f} | p50={vals[n//2]:,} p90={vals[int(.9*n)]:,} max={vals[-1]:,}')
    for lbl, c in zip(NOM, hist):
        if c:
            print(f'    {lbl:>8s} : {c:5,d}  {100*c/n:5.1f}%  {"#"*min(50, int(60*c/n))}')
    print()
