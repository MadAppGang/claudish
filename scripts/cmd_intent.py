#!/usr/bin/env python3
"""MERGE vs AUDIT — what the shell actually does, per response.

A composite command starts with `cd`/`echo`/`set`, so a first-word classifier
lies. Instead: does the command CONTAIN the intent?

    python cmd_intent.py <root> <dir> [dir...]
"""
import collections
import json
import os
import re
import sys

DELTA = re.compile(
    r'"type":"content_block_delta","index":(\d+),"delta":\{"type":"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"\}')

INTENTS = [
    ("MERGE",        r"gh\s+pr\s+merge"),
    ("AUDIT-read",   r"gh\s+pr\s+(view|diff|checks|list)|gh\s+api\s+\"?(repos|search)"),
    ("ISSUE-write",  r"gh\s+issue\s+(comment|create|close|edit)"),
    ("BANNER",       r"echo\s+\"[#=]{3,}"),
    ("gh-auth",      r"gh\s+auth\s+(token|switch|status)"),
    ("worktree",     r"\.worktrees/"),
    ("git-write",    r"git\s+(commit|push|checkout|add|merge|rebase)"),
    ("docker",       r"\bdocker\b"),
    ("file-read",    r"\b(cat|head|tail|less)\b"),
    ("python-inline", r"python[0-9]?\s+(-|<<)"),
    ("test/CI",      r"\b(bun\s+test|vitest|jest|npx\s+vitest)\b"),
]


def cmds_of(path):
    rt = open(path, encoding="utf-8", errors="replace").read()
    acc = collections.defaultdict(str)
    for idx, frag in DELTA.findall(rt):
        try:
            acc[idx] += json.loads('"%s"' % frag)
        except Exception:
            acc[idx] += frag
    out = []
    for blob in acc.values():
        try:
            o = json.loads(blob)
        except Exception:
            continue
        if isinstance(o, dict) and o.get("command"):
            out.append(str(o["command"]))
    return out


def run(root, d, sample=200):
    p = os.path.join(root, d)
    try:
        files = sorted(f for f in os.listdir(p) if f.endswith(".sse"))[:sample]
    except OSError:
        return None
    n = ncmd = 0
    hits = collections.Counter()
    for fn in files:
        n += 1
        for c in cmds_of(os.path.join(p, fn)):
            ncmd += 1
            for name, pat in INTENTS:
                if re.search(pat, c, re.I):
                    hits[name] += 1
    return {"d": d, "n": n, "cmd": ncmd, "hits": hits}


def main():
    root = sys.argv[1]
    rows = [r for r in (run(root, d) for d in sys.argv[2:]) if r]
    names = [k for k, _ in INTENTS]
    print(f"{'jour':14s} {'cmd':>5s} {'cmd/resp':>9s}  "
          + "  ".join(f"{k:>12s}" for k in names))
    for r in rows:
        print(f"{r['d']:14s} {r['cmd']:5d} {r['cmd']/r['n']:9.2f}  "
              + "  ".join(f"{r['hits'][k]/r['n']:12.2f}" for k in names))
    print()
    print("Ratio AUDIT-read / MERGE (le basculement qui compte) :")
    for r in rows:
        m = r["hits"]["MERGE"]
        a = r["hits"]["AUDIT-read"]
        print(f"  {r['d']:14s} audit={a:4d}  merge={m:4d}   "
              f"ratio={'inf' if m == 0 else f'{a/m:.1f}'}")


if __name__ == "__main__":
    main()
