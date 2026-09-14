#!/usr/bin/env python3
"""OUTPUT TOKENS PER ACTION — the metric that separates "more work" from "fatter work".

Per native response: billed output tokens, tool_use blocks emitted, thinking
volume (sum of the stripper's estimated_tokens), and text chars.

If tool_use/resp is flat while OUT/resp multiplies, the fleet is not doing more
actions — each action simply costs more. That is the whole question.

    python per_action.py <root> <dir> [dir...]
"""
import json
import os
import re
import sys

U_OUT = re.compile(r'"output_tokens":\s*(\d+)')
TX = re.compile(r'"type":"text_delta","text":"((?:[^"\\]|\\.)*)"')
TOOL = re.compile(r'"type":"tool_use"')


def measure(dirpath, sample=150):
    try:
        files = sorted(f for f in os.listdir(dirpath) if f.endswith(".sse"))[:sample]
    except OSError:
        return None
    n = out = tools = tx_ch = th_est = th_files = 0
    for fn in files:
        try:
            rt = open(os.path.join(dirpath, fn), encoding="utf-8",
                      errors="replace").read()
        except OSError:
            continue
        n += 1
        m = U_OUT.findall(rt)
        out += int(m[-1]) if m else 0
        tools += len(TOOL.findall(rt))
        tx_ch += sum(len(x) for x in TX.findall(rt))
        est = sum(int(v) for v in re.findall(r'"estimated_tokens":(\d+)', rt))
        th_est += est
        if est:
            th_files += 1
    if not n:
        return None
    return {"dir": os.path.basename(dirpath), "n": n, "out": out, "tools": tools,
            "out_resp": out // n, "tools_resp": tools / n,
            "out_tool": out // max(tools, 1), "tx_resp": tx_ch // n,
            "th_resp": th_est // n, "th_pct": 100 * th_est // max(out, 1),
            "th_files": 100 * th_files // n}


def main():
    root = sys.argv[1]
    dirs = sys.argv[2:]
    rows = [r for r in (measure(os.path.join(root, d)) for d in dirs) if r]
    print(f"{'jour':16s} {'n':>4s} {'OUT/resp':>9s} {'tools/resp':>11s} "
          f"{'OUT/tool':>9s} {'textch/r':>9s} {'think/r':>8s} {'%think':>7s}")
    for r in rows:
        print(f"{r['dir']:16s} {r['n']:4d} {r['out_resp']:9,d} {r['tools_resp']:11.2f} "
              f"{r['out_tool']:9,d} {r['tx_resp']:9,d} {r['th_resp']:8,d} {r['th_pct']:6d}%")
    if len(rows) >= 2:
        a, b = rows[0], rows[-1]
        print()
        print(f"delta {a['dir']} -> {b['dir']}:  OUT/resp x{b['out_resp']/max(a['out_resp'],1):.2f}"
              f"   tools/resp x{b['tools_resp']/max(a['tools_resp'],1e-9):.2f}"
              f"   OUT/tool x{b['out_tool']/max(a['out_tool'],1):.2f}"
              f"   textch/resp x{b['tx_resp']/max(a['tx_resp'],1):.2f}")


if __name__ == "__main__":
    main()
