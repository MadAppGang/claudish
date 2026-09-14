#!/usr/bin/env python3
"""Attribution par SESSION et par HEURE des resp natives — cherche QUI a rampé et QUAND.

Repond a deux questions ouvertes :
  1. origine de la rampe (12/09 ~18:00Z) : quelle session a commence a s'allonger ?
  2. 'deux coordinateurs armes ?' : deux metronomes entrelaces se voient par session/heure.
Usage: python rampattrib.py <jours...>   (req et resp natives deja extraits dans w-<jour>)
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

SP = os.path.dirname(os.path.abspath(__file__))

US = re.compile(r'"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),'
                r'"cache_read_input_tokens":(\d+)')
OUT = re.compile(r'"output_tokens":(\d+)')
THKTOK = re.compile(r'"thinking_tokens":(\d+)')
UID = re.compile(r'"user_id":"(.*?)"\},"max_tokens"')
THINKCFG = re.compile(r'"thinking":\{"type":"([a-z]+)"(?:,"budget_tokens":(\d+))?')
STREAMF = re.compile(r'"stream":\s*false')
NAME = re.compile(r'^(req|resp)-(\d+)-r?(\d+)-(\d{4}-\d{2}-\d{2}T[\d\-]+Z)')


def p(ts):
    return datetime.strptime(ts.replace('Z', ''), '%Y-%m-%dT%H-%M-%S-%f')


def read_tail(path, n):
    sz = os.path.getsize(path)
    with open(path, encoding='utf-8', errors='replace') as f:
        if sz > n:
            f.seek(sz - n)
        return f.read()


for day in sys.argv[1:]:
    W = os.path.join(SP, f'w-{day}')
    if not os.path.isdir(W):
        print(f'{day}: dir absent')
        continue
    reqs = defaultdict(list)
    nats = []
    for f in os.listdir(W):
        m = NAME.match(f)
        if not m:
            continue
        kind, pid, cnt, ts = m.group(1), m.group(2), m.group(3), p(m.group(4))
        if kind == 'req':
            reqs[(pid, cnt)].append((ts, f))
        elif 'native' in f:
            nats.append((pid, cnt, ts, f))

    per_sess = defaultdict(lambda: {'n': 0, 'out': 0, 'thk': 0, 'comp': 0, 'first': None,
                                    'last': None, 'modes': Counter(),
                                    'hours': defaultdict(lambda: [0, 0])})
    unp = 0
    for pid, cnt, ts, fn in sorted(nats, key=lambda x: x[2]):
        best = None
        for rts, rn in reqs.get((pid, cnt), []):
            d = ts - rts
            if timedelta(0) <= d <= timedelta(minutes=30) and (best is None or d < best[0]):
                best = (d, rn)
        if best is None:
            unp += 1
            continue
        tail = read_tail(os.path.join(W, best[1]), 6000)
        sess = '?'
        mu = UID.search(tail)
        if mu:
            try:
                u = json.loads(json.loads('"%s"' % mu.group(1)))
                sess = (u.get('session_id') or '?')[:8]
            except Exception:
                pass
        tc = THINKCFG.search(tail)
        mode = f"{tc.group(1)}" + (f":{tc.group(2)}" if tc and tc.group(2) else '') if tc else '(absent)'
        raw = read_tail(os.path.join(W, fn), 5 * 10 ** 6)
        us = US.search(raw)
        o = OUT.findall(raw)
        t = THKTOK.findall(raw)
        if not us or not o:
            unp += 1
            continue
        a = per_sess[sess]
        a['n'] += 1
        if STREAMF.search(tail):
            a['comp'] += 1
        a['out'] += int(o[-1])
        a['thk'] += int(t[-1]) if t else 0
        a['modes'][mode] += 1
        a['first'] = ts if a['first'] is None else min(a['first'], ts)
        a['last'] = ts if a['last'] is None else max(a['last'], ts)
        hb = a['hours'][ts.strftime('%H')]
        hb[0] += 1
        hb[1] += int(o[-1])

    print(f'=== {day} : {len(nats)} natives, {len(reqs)} cles req, non apparies {unp} ===\n')
    print(f'{"session":10s} {"n":>5s} {"fenetre":13s} {"OUT/req":>8s} {"thk/req":>8s} '
          f'{"compact":>7s} {"sum OUT":>10s}  modes thinking')
    ranked = sorted(per_sess.items(), key=lambda kv: -kv[1]['out'])
    for s, a in ranked[:12]:
        w = f"{a['first'].strftime('%d/%H:%M')}-{a['last'].strftime('%d/%H:%M')}"
        print(f"{s:10s} {a['n']:5d} {w:13s} {a['out']/a['n']:8,.0f} {a['thk']/a['n']:8,.0f} "
              f"{a['comp']:7d} {a['out']:10,d}  {dict(a['modes'].most_common(3))}")
    print()
    # serie horaire des 3 plus gros bruleurs : qui a rampé en premier ?
    for s, a in ranked[:3]:
        print(f'--- {s} (n={a["n"]}) serie horaire ---')
        for h in sorted(a['hours']):
            n, out = a['hours'][h]
            print(f'    {h}h  n={n:4d}  OUT/req={out/max(1,n):7,.0f}')
    print()
