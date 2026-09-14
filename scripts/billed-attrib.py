#!/usr/bin/env python3
"""Attribution de la facture Anthropic (lane native) par SESSION et par LANE.

Le corpus hub porte l'attribution complete :
  - resp-*-native-*.sse  -> usage reel : input_tokens, cache_creation_input_tokens,
                            cache_read_input_tokens, output_tokens (dernier bloc = message_delta)
  - req-*  -> body.metadata.user_id = JSON string {device_id, account_uuid, session_id}
              + `Primary working directory:` (la lane)

Lecture seule. Usage :
  python billed-attrib.py 2026-09-14 [heures_borne_basse]
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta

D = '//192.168.0.50/d$/claudish-captures'

USAGE_RE = re.compile(
    r'"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),'
    r'"cache_read_input_tokens":(\d+)')
OUT_RE = re.compile(r'"output_tokens":(\d+)')
THINK_TOK_RE = re.compile(r'"thinking_tokens":(\d+)')
CC5_RE = re.compile(r'"ephemeral_5m_input_tokens":(\d+)')
CC1H_RE = re.compile(r'"ephemeral_1h_input_tokens":(\d+)')
LANE_RE = re.compile(r'Primary working directory:\s*(.+?)\\n')
SEP_RE = re.compile(r'[\\/]+')
MACH_RE = re.compile(r'"machine"\s*:\s*"([^"]*)"')
UID_RE = re.compile(r'"user_id":"(.*?)"\},"max_tokens"')
THINK_RE = re.compile(r'"thinking":\{"type":"([a-z]+)"(?:,"budget_tokens":(\d+))?')


def p(ts):
    return datetime.strptime(ts.replace('Z', ''), '%Y-%m-%dT%H-%M-%S-%f')


def read_head(path, n):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read(n)


def read_tail(path, n):
    sz = os.path.getsize(path)
    with open(path, encoding='utf-8', errors='replace') as f:
        if sz > n:
            f.seek(sz - n)
        return f.read()


def main():
    days = sys.argv[1].split(',') if len(sys.argv) > 1 else ['2026-09-14']
    AFTER = datetime.strptime(sys.argv[2], '%Y-%m-%dT%H:%M:%S') if len(sys.argv) > 2 else None

    reqs = defaultdict(list)
    resps = []
    with os.scandir(D) as it:
        for e in it:
            n = e.name
            if not any(d in n for d in days):
                continue
            m = re.match(r'^(req|resp)-(\d+)-r?(\d+)-(\d{4}-\d{2}-\d{2}T[\d\-]+Z)', n)
            if not m:
                continue
            kind, pid, cnt, ts = m.group(1), int(m.group(2)), int(m.group(3)), p(m.group(4))
            if kind == 'req':
                reqs[(pid, cnt)].append((ts, n))
            elif 'native' in n:
                resps.append((pid, cnt, ts, n))

    print(f'jours={days} | {len(reqs)} cles req | {len(resps)} resp natives')

    per_sess = defaultdict(lambda: {'n': 0, 'in': 0, 'cc': 0, 'cr': 0, 'out': 0,
                                    'first': None, 'last': None, 'lane': Counter(),
                                    'dev': Counter(), 'mach': Counter(),
                                    'hrs': Counter()})
    per_lane = defaultdict(lambda: {'n': 0, 'cc': 0, 'cr': 0, 'out': 0, 'sess': set()})
    per_hour = defaultdict(lambda: defaultdict(int))
    unp = 0
    for pid, cnt, ts, name in sorted(resps, key=lambda x: x[2]):
        if AFTER and ts < AFTER:
            continue
        best = None
        for rts, rn in reqs.get((pid, cnt), []):
            d = ts - rts
            if timedelta(0) <= d <= timedelta(minutes=30) and (best is None or d < best[0]):
                best = (d, rn)
        if best is None:
            unp += 1
            continue
        rp = os.path.join(D, best[1])
        tail = read_tail(rp, 6000)
        head = read_head(rp, 300000)
        mu = UID_RE.search(tail)
        sess = dev = '?'
        if mu:
            try:
                u = json.loads(json.loads('"%s"' % mu.group(1)))
                sess = u.get('session_id', '?')
                dev = (u.get('device_id') or '?')[:8]
            except Exception:
                pass
        lm = LANE_RE.search(head)
        lane = SEP_RE.split(lm.group(1).strip())[-1] if lm else '(?)'
        mm = MACH_RE.search(head[:400])
        mach = mm.group(1) if mm else '?'

        rp_raw = read_head(os.path.join(D, name), 4000)
        us = USAGE_RE.search(rp_raw)
        rp_all = read_head(os.path.join(D, name), 10 ** 7)
        if not us:
            # usage parfois plus loin dans le flux : le fichier entier est deja lu
            us = USAGE_RE.search(rp_all)
        if not us:
            unp += 1
            continue
        _o = OUT_RE.findall(rp_all)
        _t = THINK_TOK_RE.findall(rp_all)
        _c5 = CC5_RE.findall(rp_all)
        _c1 = CC1H_RE.findall(rp_all)
        outs = [int(_o[-1])] if _o else [0]
        think = int(_t[-1]) if _t else 0
        cc5 = int(_c5[-1]) if _c5 else 0
        cc1h = int(_c1[-1]) if _c1 else 0
        a = per_sess[sess]
        a['n'] += 1
        a['in'] += int(us.group(1))
        a['cc'] += int(us.group(2))
        a['cr'] += int(us.group(3))
        a['out'] += int(outs[-1]) if outs else 0
        a['think'] = a.get('think', 0) + think
        a['hrs'][ts.strftime('%H')] += 1
        h = ts.strftime('%H')
        hb = per_hour[h]
        hb['n'] += 1
        hb['cc'] += int(us.group(2))
        hb['cr'] += int(us.group(3))
        hb['cc5'] += cc5
        hb['cc1h'] += cc1h
        hb['out'] += outs[-1]
        hb['think'] += think
        hb['pfx'] += int(us.group(1)) + int(us.group(2)) + int(us.group(3))
        subs = 'SUBA' if lane.startswith('agent-') else 'parent'
        lb = per_lane[(lane if subs == 'parent' else subs)]
        lb['n'] += 1
        lb['cc'] += int(us.group(2))
        lb['cr'] += int(us.group(3))
        lb['out'] += int(outs[-1]) if outs else 0
        lb['sess'].add(sess)
        a['first'] = ts if a['first'] is None else min(a['first'], ts)
        a['last'] = ts if a['last'] is None else max(a['last'], ts)
        a['lane'][lane] += 1
        a['dev'][dev] += 1
        a['mach'][mach] += 1

    print(f'non appariées/sans usage: {unp}\n')
    print('=== par SESSION (facture Anthropic reelle) ===')
    print(f'{"session":14s} {"dev":9s} {"n":>4s} {"fenetre":13s} '
          f'{"fresh_in":>9s} {"cacheCreate":>11s} {"cacheRead":>11s} {"OUT":>8s} {"billed_inEq":>11s}')
    tot = defaultdict(int)
    for s, a in sorted(per_sess.items(), key=lambda kv: -kv[1]['cc']):
        beq = a['in'] + 1.25 * a['cc'] + 0.1 * a['cr']
        print(f"{s[:12]:14s} {list(a['dev'])[0]:9s} {a['n']:4d} "
              f"{a['first'].strftime('%H:%M')}-{a['last'].strftime('%H:%M')}  "
              f"{a['in']:9d} {a['cc']:11d} {a['cr']:11d} {a['out']:8d} {beq:11.0f}    "
              f"{dict(a['lane'].most_common(2))} {dict(a['mach'].most_common(1))}")
        for k in ('n', 'in', 'cc', 'cr', 'out'):
            tot[k] += a[k]
    beq = tot['in'] + 1.25 * tot['cc'] + 0.1 * tot['cr']
    print(f"\nTOTAL n={tot['n']} fresh_in={tot['in']:,} cacheCreate={tot['cc']:,} "
          f"cacheRead={tot['cr']:,} OUT={tot['out']:,} billed_inEq={beq:,.0f}")
    print(f"  cacheRead / cacheCreate = {tot['cr']/max(1,tot['cc']):.2f}"
          f"  (eleve = prefixe bien cache ; bas = cache casse, chaque requete reecrit le prefixe)")
    print('\n=== par LANE (ou SUBA agrege) ===')
    for lane, b in sorted(per_lane.items(), key=lambda kv: -kv[1]['cc']):
        beq = 1.25 * b['cc'] + 0.1 * b['cr']
        print(f"  {lane:26s} n={b['n']:4d} sessions={len(b['sess']):3d} "
              f"cacheCreate={b['cc']:10,d} cacheRead={b['cr']:11,d} OUT={b['out']:8,d} "
              f"inEq={beq:11,.0f}")
    print('\n=== SERIE HORAIRE (natives Anthropic) ===')
    print(f'{"h":3s} {"n":>4s} {"prefixe/req":>11s} {"cc5m":>10s} {"cc1h":>10s} '
          f'{"cacheRead":>11s} {"OUT":>7s} {"think":>7s} {"OUT/req":>8s} {"inEq/h":>10s}')
    for h, b in sorted(per_hour.items()):
        beq = b['cc'] * 1.25 + b['cr'] * 0.1 + b['out'] * 5
        print(f"{h:3s} {b['n']:4d} {b['pfx']/max(1,b['n']):11,.0f} {b['cc5']:10,d} "
              f"{b['cc1h']:10,d} {b['cr']:11,d} {b['out']:7,d} {b['think']:7,d} "
              f"{b['out']/max(1,b['n']):8,.0f} {beq:10,.0f}")
    hrs = Counter()
    for s, a in per_sess.items():
        hrs.update(a['hrs'])
    print('\n  req natives / heure UTC:', dict(sorted(hrs.items())))
    print(f"  OUT moyen / req = {tot['out']/max(1,tot['n']):,.0f} tok"
          f"  (facture 5x l'input) -> {5*tot['out']:,.0f} inEq")
    print(f"  prefixe moyen / req = {(tot['cc']+tot['cr']+tot['in'])/max(1,tot['n']):,.0f} tok")


if __name__ == '__main__':
    main()
