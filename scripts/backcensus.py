#!/usr/bin/env python3
"""Census des backends qui ont SERVI, par jour — noms de fichiers seuls (aucune lecture).

Le discriminant 'facture Anthropic' est le backend qui a servi, pas le modele demande.
Ce script liste, pour chaque jour, la repartition des tags de backend des resp-*.sse.
Usage: python backcensus.py 2026-09-11 2026-09-12 2026-09-13 2026-09-14
"""
import os
import re
import sys
from collections import Counter, defaultdict

D = '//192.168.0.50/d$/claudish-captures'
DAYS = sys.argv[1:] or ['2026-09-14']

# resp-<pid>-r<counter4>-<ts>-<clientinfo>.<ext>   -> le backend est DANS clientinfo
NAME = re.compile(r'^resp-\d+-r\d+-(\d{4}-\d{2}-\d{2})T[\d\-]+Z-(.+)$')

per_day = defaultdict(Counter)
for e in os.scandir(D):
    m = NAME.match(e.name)
    if not m:
        continue
    day, rest = m.group(1), m.group(2)
    if day not in DAYS:
        continue
    # rest = <backend>[-<model>][.<ext>] ; le backend est le 1er segment
    stem = rest.rsplit('.', 1)[0]
    parts = stem.split('-')
    # backend = 'native' | 'openai' | 'anthropic' | 'direct' ...
    back = parts[0] if parts else '?'
    kind = 'BILLED(anthropic)' if stem.startswith('native-claude') else back
    per_day[day][kind] += 1

for day in DAYS:
    c = per_day[day]
    tot = sum(c.values())
    print(f'--- {day} : {tot:,} resp servies')
    for k, v in c.most_common():
        print(f'      {k:26s} {v:6,d}  {100*v/max(1,tot):5.1f}%')
