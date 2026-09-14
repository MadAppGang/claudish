#!/usr/bin/env python3
"""Distribution de la sortie (output_tokens) des reponses natives, par jour.
Usage: python natdist.py <label> <dir>"""
import os
import re
import sys

LABEL, DIR = sys.argv[1], sys.argv[2]
OUT = re.compile(r'"output_tokens":(\d+)')
THK = re.compile(r'"thinking_tokens":(\d+)')
vals, thks = [], []
for f in os.listdir(DIR):
    if not (f.startswith('resp-') and 'native' in f):
        continue
    try:
        raw = open(os.path.join(DIR, f), encoding='utf-8', errors='replace').read()
    except OSError:
        continue
    o = OUT.findall(raw)
    if not o:
        continue
    vals.append(int(o[-1]))
    t = THK.findall(raw)
    thks.append(int(t[-1]) if t else 0)

if not vals:
    print(f'{LABEL}: aucun fichier')
    sys.exit()
vals.sort(); thks.sort()
n = len(vals)
def q(p):
    return vals[min(n - 1, int(p * n))]
big = sum(1 for v in vals if v > 10000)
zero = sum(1 for v in vals if v < 100)
print(f"{LABEL:10s} n={n:5d} | OUT p50={q(.5):6d} p90={q(.9):7d} p99={q(.99):7d} max={vals[-1]:7d}"
      f" | >10k: {big:4d} ({100*big/n:4.1f}%) | <100: {zero:4d} ({100*zero/n:4.1f}%)"
      f" | think p50={thks[n//2]:5d} p90={thks[int(.9*n)]:6d}"
      f" | sum={sum(vals):12,d}")
