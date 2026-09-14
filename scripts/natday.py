#!/usr/bin/env python3
"""Totaux journaliers de la facture Anthropic, a partir des resp-*-native-*.sse.
Usage: python natday.py <label> <dir>"""
import os
import re
import sys

LABEL, DIR = sys.argv[1], sys.argv[2]
US = re.compile(r'"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),'
                r'"cache_read_input_tokens":(\d+)')
OUT = re.compile(r'"output_tokens":(\d+)')
THK = re.compile(r'"thinking_tokens":(\d+)')
C5 = re.compile(r'"ephemeral_5m_input_tokens":(\d+)')
C1 = re.compile(r'"ephemeral_1h_input_tokens":(\d+)')

n = fin = cc = cr = out = thk = c5 = c1h = 0
files = [f for f in os.listdir(DIR) if 'native' in f and f.startswith('resp-')]
for f in files:
    try:
        with open(os.path.join(DIR, f), encoding='utf-8', errors='replace') as fh:
            raw = fh.read()
    except OSError:
        continue
    u = US.search(raw)
    if not u:
        continue
    n += 1
    fin += int(u.group(1)); cc += int(u.group(2)); cr += int(u.group(3))
    o = OUT.findall(raw); t = THK.findall(raw)
    out += int(o[-1]) if o else 0
    thk += int(t[-1]) if t else 0
    a = C5.findall(raw); b = C1.findall(raw)
    c5 += int(a[-1]) if a else 0
    c1h += int(b[-1]) if b else 0

beq = fin + 1.25 * cc + 0.1 * cr
tot = beq + 5 * out
print(f"{LABEL:10s} n={n:5d} | pfx/req={(fin+cc+cr)/max(1,n):9,.0f} "
      f"| cc/req={cc/max(1,n):7,.0f} (5m {c5/max(1,n):6,.0f} / 1h {c1h/max(1,n):6,.0f}) "
      f"| cr/req={cr/max(1,n):8,.0f} | OUT/req={out/max(1,n):7,.0f} (think {thk/max(1,n):6,.0f}) "
      f"| OUT%={100*5*out/max(1,tot):4.1f} | inEq/j={tot:12,.0f}")
