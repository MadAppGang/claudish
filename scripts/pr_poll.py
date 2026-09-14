#!/usr/bin/env python3
"""PR POLLING, server-side — corroborates CoursIA/ai-01's client-side 9.2 views/PR.

Counts PR numbers appearing in gh commands (reconstructed from tool_use
input_json_delta in resp captures): distinct PRs touched, total references,
refs per PR, and the top-polled ones. Server-side view of "polling vs work".

    python pr_poll.py <root> <dir> [dir...]
"""
import collections
import json
import os
import re
import sys

DELTA = re.compile(
    r'"type":"content_block_delta","index":(\d+),"delta":\{"type":"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"\}')
PRREF = re.compile(r'\b#?(\d{4,5})\b')
GH_CMD = re.compile(r"\bgh\s+(pr|issue|api|run)", re.I)
# command text carries "repos/jsboige/CoursIA/pulls/15917" and "#15917" forms
PR_IN_URL = re.compile(r'/(?:pulls|pull|issues)/(\d{4,5})')


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


def main():
    root = sys.argv[1]
    for d in sys.argv[2:]:
        p = os.path.join(root, d)
        try:
            files = sorted(f for f in os.listdir(p) if f.endswith(".sse"))[:200]
        except OSError:
            continue
        refs = collections.Counter()
        ncmd = nresp = 0
        for fn in files:
            nresp += 1
            for c in cmds_of(os.path.join(p, fn)):
                if not GH_CMD.search(c):
                    continue
                ncmd += 1
                nums = set(PR_IN_URL.findall(c))
                if not nums:
                    # plain #NNNN / bare NNNN args of gh pr
                    nums = set(PRREF.findall(c))
                for x in nums:
                    x = int(x)
                    if 2020 <= x <= 2035:   # annees dans les dates ISO des commandes
                        continue
                    refs[x] += 1
        tot = sum(refs.values())
        dist = len(refs)
        print(f"=== {d} — {nresp} reponses, {ncmd} cmd gh, "
              f"{tot} refs PR sur {dist} PR distinctes "
              f"({tot/max(dist,1):.1f} refs/PR) ===")
        print("  top polling :")
        for pr, c in refs.most_common(8):
            print(f"    #{pr:<7d} {c:3d} refs")


if __name__ == "__main__":
    main()
