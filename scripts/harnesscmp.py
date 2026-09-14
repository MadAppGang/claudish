#!/usr/bin/env python3
"""Le harnais de la cohorte verbose (née 12/09 21:54Z) differe-t-il de celui des frugales ?

Compare, par session et par phase (premiere/derniere requete) :
  - system : longueur + hash STRUCTUREL (chiffres normalises -> dates/heures neutralisees)
  - tools  : nombre + hash exact des noms + volume des schemas
Usage: python harnesscmp.py 2026-09-12 [2026-09-13 ...]
"""
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta

SP = os.path.dirname(os.path.abspath(__file__))
UID = re.compile(r'"user_id":"(.*?)"\},"max_tokens"')
NAME = re.compile(r'^(req|resp)-(\d+)-r?(\d+)-(\d{4}-\d{2}-\d{2}T[\d\-]+Z)')


def p(ts):
    return datetime.strptime(ts.replace('Z', ''), '%Y-%m-%dT%H-%M-%S-%f')


def read(path, n=None):
    sz = os.path.getsize(path)
    with open(path, encoding='utf-8', errors='replace') as f:
        if n and sz > n:
            f.seek(sz - n)
        return f.read()


def sys_text(body):
    s = body.get('system')
    if isinstance(s, str):
        return s
    if isinstance(s, list):
        return '\n'.join(b.get('text', '') for b in s if isinstance(b, dict))
    return ''


def struct_hash(txt):
    norm = re.sub(r'\d+', '#', txt)
    return hashlib.sha1(norm.encode('utf-8', 'replace')).hexdigest()[:10]


for day in sys.argv[1:]:
    W = os.path.join(SP, f'w-{day}')
    if not os.path.isdir(W):
        print(f'{day}: absent')
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
    nats.sort(key=lambda x: x[2])

    samples = defaultdict(list)  # sess -> [(ts, reqname)]
    for pid, cnt, ts, fn in nats:
        best = None
        for rts, rn in reqs.get((pid, cnt), []):
            d = ts - rts
            if timedelta(0) <= d <= timedelta(minutes=30) and (best is None or d < best[0]):
                best = (d, rn)
        if not best:
            continue
        tail = read(os.path.join(W, best[1]), 6000)
        mu = UID.search(tail)
        sess = '?'
        if mu:
            try:
                u = json.loads(json.loads('"%s"' % mu.group(1)))
                sess = (u.get('session_id') or '?')[:8]
            except Exception:
                pass
        samples[sess].append((ts, best[1]))

    print(f'=== {day} ===')
    print(f'{"session":10s} {"phase":5s} {"heure":6s} {"sys ch":>7s} {"sys-hash":11s} '
          f'{"outils":>6s} {"tools-hash":11s} {"tools ch":>9s}')
    for sess in sorted(samples, key=lambda s: samples[s][0][0]):
        lst = samples[sess]
        picks = [lst[0], lst[len(lst) // 2], lst[-1]] if len(lst) > 2 else lst
        seen = set()
        for ts, rn in picks:
            if rn in seen:
                continue
            seen.add(rn)
            try:
                obj = json.loads(read(os.path.join(W, rn)))
            except Exception as e:
                print(f'{sess}  ERREUR parse {rn}: {e}')
                continue
            body = obj.get('body') if isinstance(obj, dict) and isinstance(obj.get('body'), dict) else obj
            st = sys_text(body)
            tools = body.get('tools') or []
            names = sorted(t.get('name', '?') for t in tools)
            th = hashlib.sha1('|'.join(names).encode()).hexdigest()[:10]
            tl = sum(len(json.dumps(t.get('input_schema', {}))) for t in tools)
            print(f'{sess:10s} {"PREM" if rn == lst[0][1] else ("DER" if rn == lst[-1][1] else "MIL"):5s} '
                  f'{ts.strftime("%d/%H:%M"):6s} {len(st):7,d} {struct_hash(st):11s} '
                  f'{len(tools):6d} {th:11s} {tl:9,d}')
    print()
