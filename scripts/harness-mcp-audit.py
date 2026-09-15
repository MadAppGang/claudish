#!/usr/bin/env python3
"""harness-mcp-audit.py — MCP servers DECLARED per machine vs tools actually CALLED.

Two modes, both read-only:

  local     scan ~/.claude/projects/*/*.jsonl for `tool_use` blocks and aggregate
            calls per project directory (one lane = one project dir).
  declared  sample req-*.json captures and count MCP tool DEFINITIONS per server
            per machine (the envelope's `machine` field is authoritative).

Why both: a server declared on a lane but never called is pure prefix cost. Tool
search would avoid loading definitions eagerly, but it is DISABLED when
ANTHROPIC_BASE_URL is custom (official docs, code.claude.com/docs/en/mcp) — so
behind a proxy every declared definition is paid inline on every request. The
only lever is the per-lane declaration (`disabledMcpServers` per project in
~/.claude.json; a `disabled:true` flag in a repo `.mcp.json` is NOT a cross-layer
veto).

Measured 2026-09-13 (myia-ai-01): 2 610 MCP calls / 2 days, 94 % roo-state-manager;
jupyter-papermill, searxng, sk-agent, google-workspace, win-cli, nanoclaw,
quantconnect = 0 calls on most lanes — while ai-01 declares 6 servers (median
103 tools/request). Cuts are per machine, never fleet-wide: jupyter-papermill is
0 calls on ai-01/po-2023 but ~718 on po-2025.

Traps this script avoids:
  - Counting lines is not counting requests: sub-agent files replay the same
    message ids. Here we count `tool_use` blocks, which are per-call, not ids.
  - Grouping captures by proxy `pid` groups by process lifetime, not by client
    session (the req counter restarts per session, so `req-1-0001` recurs).
    Attribution must come from the envelope's `machine` field.
  - Sampling declarations over-weights long sessions; quote the sample stride.
  - **`machine` alone conflates distinct surfaces on one host.** A machine can
    run both the interactive Claude Code lanes and a scheduled seat (a cron
    agent) with different MCP declarations; a per-machine table then attributes
    one surface's servers to the other, and the reader cuts the wrong
    declaration. Measured 2026-09-13: po-2026 read as "declares win-cli 30/31
    req" when win-cli belongs to the host lanes only — the Hermes cron seat
    declares roo-state-manager/searxng/sk-agent and had 0 win-cli calls in 14
    days. The discriminator is the working directory in the system prompt, so
    every row below is keyed by (machine, lane).

Usage:
  python harness-mcp-audit.py local [days]
  python harness-mcp-audit.py declared [capture_dir] [day,day,...] [stride]
"""
import glob
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

TOOLUSE_RE = re.compile(r'"type":\s*"tool_use"[^}]*?"name":\s*"([^"]+)"')
MCP_DEF_RE = re.compile(r'"mcp__([a-zA-Z0-9\-]+)__')
# The lane is the last path segment of the CC environment block, read from the
# RAW capture text (the marker lives inside a JSON-escaped system-reminder, so a
# regex over the file is both simpler and cheaper than re-serializing the body).
LANE_RE = re.compile(r'Primary working directory:\s*(.+?)\\n')
SEP_RE = re.compile(r'[\\/]+')


def mode_local(days: int) -> None:
    root = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    cutoff = time.time() - days * 86400
    per_proj = defaultdict(lambda: {"mcp": Counter(), "native": Counter(),
                                    "sessions": set(), "bytes": 0})
    for d in sorted(os.listdir(root)):
        pd = os.path.join(root, d)
        if not os.path.isdir(pd):
            continue
        agg = per_proj[d]
        for fn in os.listdir(pd):
            if not fn.endswith(".jsonl"):
                continue
            p = os.path.join(pd, fn)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_mtime < cutoff:
                continue
            agg["sessions"].add(fn[:8])
            agg["bytes"] += st.st_size
            with open(p, encoding="utf-8", errors="replace") as f:
                for line in f:
                    for nm in TOOLUSE_RE.findall(line):
                        if nm.startswith("mcp__"):
                            parts = nm.split("__")
                            agg["mcp"]["::".join(parts[1:])] += 1
                        else:
                            agg["native"][nm] += 1

    print(f"# CALLED tools per lane, last {days} day(s)")
    for d, agg in sorted(per_proj.items(), key=lambda kv: -kv[1]["bytes"]):
        if not agg["sessions"]:
            continue
        tot_mcp = sum(agg["mcp"].values())
        tot_nat = sum(agg["native"].values())
        print(f"\n=== {d} — {len(agg['sessions'])} sessions, "
              f"{agg['bytes']/1e6:.1f} MB ===")
        print(f"  native: {tot_nat} calls | " +
              ", ".join(f"{k}x{v}" for k, v in agg["native"].most_common(6)))
        print(f"  MCP   : {tot_mcp} calls" +
              (" | " + ", ".join(f"{k}x{v}" for k, v in agg["mcp"].most_common(12))
               if tot_mcp else " — NONE"))


def mode_declared(capture_dir: str, days: list, stride: int) -> None:
    names = []
    with os.scandir(capture_dir) as it:
        for e in it:
            n = e.name
            if n.startswith("req-") and n.endswith(".json") and \
                    any(d in n for d in days):
                names.append(n)
    names.sort()
    sample = names[::stride]
    per_lane = defaultdict(lambda: {"files": 0, "srv_defs": Counter(),
                                    "tools": [], "models": Counter()})
    no_lane = 0
    for n in sample:
        try:
            with open(os.path.join(capture_dir, n), encoding="utf-8",
                      errors="replace") as f:
                raw = f.read()
        except OSError:
            continue
        try:
            env = json.loads(raw)
        except json.JSONDecodeError:
            continue
        lm = LANE_RE.search(raw)
        if not lm:
            no_lane += 1
            continue
        lane = SEP_RE.split(lm.group(1).strip())[-1]
        m = per_lane[(env.get("machine") or "(unattributed)", lane)]
        body = env.get("body", {})
        m["files"] += 1
        m["models"][body.get("model", "?")] += 1
        tools = body.get("tools") or []
        m["tools"].append(len(tools))
        for t in tools:
            nm = t.get("name", "")
            if nm.startswith("mcp__"):
                parts = nm.split("__")
                if len(parts) > 2:
                    m["srv_defs"][parts[1]] += 1

    print(f"# DECLARED MCP servers per (machine, lane) — {len(names)} req, "
          f"1/{stride} sampled ({len(sample)}), {no_lane} without lane marker")
    for (mach, lane), m in sorted(per_lane.items(),
                                  key=lambda kv: (kv[0][0], -kv[1]["files"])):
        med = sorted(m["tools"])[len(m["tools"]) // 2] if m["tools"] else 0
        top = ", ".join(f"{k}:{v}" for k, v in m["models"].most_common(2))
        print(f"\n=== {mach} / {lane} — {m['files']} req ===")
        print(f"  models: {top} | median tools/req: {med}")
        for s, c in m["srv_defs"].most_common():
            print(f"    {s:22s} {c:5d} defs")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "local"
    if mode == "local":
        mode_local(int(sys.argv[2]) if len(sys.argv) > 2 else 2)
    elif mode == "declared":
        cap = sys.argv[2] if len(sys.argv) > 2 else r"\\192.168.0.50\d$\claudish-captures"
        days = sys.argv[3].split(",") if len(sys.argv) > 3 else [time.strftime("%Y-%m-%d")]
        stride = int(sys.argv[4]) if len(sys.argv) > 4 else 100
        mode_declared(cap, days, stride)
    else:
        print(__doc__)
        sys.exit(2)
