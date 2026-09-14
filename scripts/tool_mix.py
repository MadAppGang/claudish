#!/usr/bin/env python3
"""WHICH tools grew — the answer to "more actions per turn".

Tool names are in the RESPONSE (assistant output), so this works on the
nat-* dirs (resp only) with no req pairing needed.

    python tool_mix.py <root> <dir> [dir...]
"""
import collections
import os
import re
import sys

# resp SSE: {"type":"content_block_start","index":N,"content_block":{"type":"tool_use","id":"..","name":"Bash",...}}
T_START = re.compile(
    r'"content_block"\s*:\s*\{\s*"type"\s*:\s*"tool_use"\s*,\s*"id"\s*:\s*"[^"]*"\s*,\s*"name"\s*:\s*"([^"]+)"')
# streaming variant: content_block_delta carries only input_json_delta, so start is
# the only place the name appears; keep a fallback for a plain JSON tool_use block.
T_PLAIN = re.compile(r'"type"\s*:\s*"tool_use"[^}]{0,200}?"name"\s*:\s*"([^"]+)"')
U_OUT = re.compile(r'"output_tokens":\s*(\d+)')

GROUPS = {
    "Read": "lecture", "Grep": "lecture", "Glob": "lecture",
    "Bash": "shell", "PowerShell": "shell",
    "Edit": "ecriture", "Write": "ecriture", "NotebookEdit": "ecriture",
    "Agent": "sous-agent", "Task": "sous-agent",
    "TodoWrite": "todo",
    "WebSearch": "web", "WebFetch": "web",
    "mcp__roo-state-manager__roosync_dashboard": "coordination",
    "mcp__roo-state-manager__roosync_messages": "coordination",
}
ROLE = {"lecture": "lecture", "shell": "shell", "ecriture": "ecriture",
        "sous-agent": "SOUS-AGENT", "todo": "todo", "web": "web",
        "coordination": "coordination"}


def run(root, d, sample=200):
    p = os.path.join(root, d)
    try:
        files = sorted(f for f in os.listdir(p) if f.endswith(".sse"))[:sample]
    except OSError:
        return None
    names = collections.Counter()
    roles = collections.Counter()
    grp = collections.Counter()
    n = out = tot_tools = 0
    for fn in files:
        try:
            rt = open(os.path.join(p, fn), encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        n += 1
        m = U_OUT.findall(rt)
        out += int(m[-1]) if m else 0
        found = T_START.findall(rt) or T_PLAIN.findall(rt)
        tot_tools += len(found)
        for nm in found:
            names[nm] += 1
            g = GROUPS.get(nm, "autre")
            grp[g] += 1
            roles[g] += 1
    if not n:
        return None
    return {"d": d, "n": n, "out": out, "tools": tot_tools,
            "t_resp": tot_tools / n, "names": names, "grp": grp}


def main():
    root = sys.argv[1]
    dirs = sys.argv[2:]
    rows = [r for r in (run(root, d) for d in dirs) if r]
    allnames = collections.Counter()
    for r in rows:
        allnames.update(r["names"])
    top = [k for k, _ in allnames.most_common(14)]
    print(f"{'jour':14s} {'tools/resp':>10s}  " + "  ".join(f"{k:>9s}" for k in top))
    for r in rows:
        cells = "  ".join(f"{r['names'][k]/r['n']:9.2f}" for k in top)
        print(f"{r['d']:14s} {r['t_resp']:10.2f}  {cells}")
    print()
    print("Par ROLE (appels par reponse) :")
    roles = ["lecture", "shell", "ecriture", "SOUS-AGENT", "todo", "web",
             "coordination", "autre"]
    print(f"{'jour':14s} " + "  ".join(f"{k:>11s}" for k in roles))
    for r in rows:
        cells = "  ".join(f"{r['grp'][k]/r['n']:11.2f}" for k in roles)
        print(f"{r['d']:14s} {cells}")
    print()
    print("SOUS-AGENT — detail (c'est la cible de la demande user) :")
    for r in rows:
        a = r["names"]["Agent"] + r["names"]["Task"]
        print(f"  {r['d']:14s} {a:5d} appels Agent sur {r['n']} reponses "
              f"({a/r['n']:.3f}/resp)")
    print()
    print("Top 20 outils sur l'ensemble de l'echantillon :")
    for k, c in allnames.most_common(20):
        print(f"  {k:28s} {c}")


if __name__ == "__main__":
    main()
