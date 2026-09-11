#!/usr/bin/env python3
"""traffic-mxws.py — traffic & token consumption by machine x workspace x model.

Pairs req-*.json (machine header, workspace from system prompt) with resp-*.sse
(tokens from usage blocks) by (day, reqN) and aggregates. For archived days,
extract captures-YYYY-MM-DD.7z first (scripts/compress-captures.ps1 layout)
and point -arg1 at the extraction dir, -arg2 at the comma-separated day list.

Usage:
  python traffic-mxws.py [capture_dir] [day,day,...]
  python traffic-mxws.py D:\\claudish-captures 2026-08-26
"""
import glob, re, json, os, sys
from collections import defaultdict
from datetime import date

CAP = sys.argv[1] if len(sys.argv) > 1 else r"D:\claudish-captures"
DAYS = sys.argv[2].split(",") if len(sys.argv) > 2 else [date.today().isoformat()]
WS_RE = re.compile(r"Primary working directory:\s*(.+?)[\r\n]")
FN_REQ = re.compile(r"^req-\d+-r?(\d+)-(\d{4}-\d{2}-\d{2})T[\d\-]+Z.*\.json$")
FN_RESP = re.compile(r"^resp-\d+-r(\d+)-(\d{4}-\d{2}-\d{2})T([\d\-]+)-\d+Z-(\w+)-([a-z0-9.\-]+)\.sse$")

def machine_short(m):
    return (m or "?").replace("myia-", "")

# ---- pass 1: requests (machine, workspace, model, reqN) ----
req_by_key = {}   # (day, reqN) -> list of dicts (collision = multiple)
req_count = 0
req_errors = 0
day_req_total = defaultdict(int)

for f in glob.glob(os.path.join(CAP, "req-*.json")):
    base = os.path.basename(f)
    m = FN_REQ.match(base)
    if not m:
        continue
    reqN, day = m.groups()
    if day not in DAYS:
        continue
    req_count += 1
    day_req_total[day] += 1
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            j = json.load(fh)
    except Exception:
        req_errors += 1
        continue
    body = j.get("body") or {}
    ws = "(no workspace)"
    sysv = body.get("system")
    blocks = sysv if isinstance(sysv, list) else ([{"text": sysv}] if isinstance(sysv, str) and sysv else [])
    for block in blocks:
        t = (block.get("text") if isinstance(block, dict) else str(block)) or ""
        mm = WS_RE.search(t)
        if mm:
            ws = mm.group(1).strip()
            break
    # Claude Code puts "Primary working directory" in the position-0 harness block
    # of the FIRST USER MESSAGE, not in `system` -- search it as a fallback.
    if ws == "(no workspace)":
        for m in (body.get("messages") or [])[:2]:
            c = m.get("content")
            texts = [c] if isinstance(c, str) else ([b.get("text") or "" for b in c if isinstance(b, dict)] if isinstance(c, list) else [])
            for t in texts[:3]:
                mm = WS_RE.search(t or "")
                if mm:
                    ws = mm.group(1).strip()
                    break
            if ws != "(no workspace)":
                break
    rec = {
        "machine": machine_short(j.get("machine")),
        "ws": ws.split("\\")[-1] if "\\" in ws else ws.split("/")[-1],
        "model": j.get("model") or "(none)",
    }
    req_by_key.setdefault((day, reqN), []).append(rec)

collisions = sum(1 for v in req_by_key.values() if len(v) > 1)

# ---- pass 2: responses (tokens) ----
resp_tokens = {}   # (day, reqN) -> dict
resp_count = 0
day_model_tokens = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))  # day -> model -> [n, in, out]

for f in glob.glob(os.path.join(CAP, "resp-*.sse")):
    base = os.path.basename(f)
    m = FN_RESP.match(base)
    if not m:
        continue
    reqN, day, _t, wire, model = m.groups()
    if day not in DAYS:
        continue
    resp_count += 1
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            s = fh.read()
    except Exception:
        continue
    ins = [int(x) for x in re.findall(r'"input_tokens":(\d+)', s)]
    outs = [int(x) for x in re.findall(r'"output_tokens":(\d+)', s)]
    inp = max(ins) if ins else 0
    out = max(outs) if outs else 0
    resp_tokens[(day, reqN)] = (model, inp, out)
    dmt = day_model_tokens[day][model]
    dmt[0] += 1
    dmt[1] += inp
    dmt[2] += out

# ---- aggregate: machine x workspace x model (paired only) ----
agg = defaultdict(lambda: [0, 0, 0])   # (day, machine, ws, model) -> [n, in, out]
unpaired = 0
for (day, reqN), (model, inp, out) in resp_tokens.items():
    cands = req_by_key.get((day, reqN))
    if not cands:
        unpaired += 1
        continue
    rec = cands[0]  # collision: first (rare; count reported)
    key = (day, rec["machine"], rec["ws"], model)
    a = agg[key]
    a[0] += 1
    a[1] += inp
    a[2] += out

print(f"files: req={req_count} (err={req_errors}) resp={resp_count}")
print(f"reqN keys={len(req_by_key)} collisions={collisions} unpaired-resp={unpaired}")
print()
print("=== DAY x MODEL (resp captures: n / input / output) ===")
for day in DAYS:
    tot = day_req_total[day]
    print(f"\n-- {day} (req files {tot}) --")
    models = day_model_tokens.get(day, {})
    for model, (n, i, o) in sorted(models.items(), key=lambda kv: -kv[1][1]):
        print(f"  {model:38s} n={n:5d} in={i/1e6:8.2f}M out={o/1e6:6.2f}M")

print()
print(f"=== MACHINE x WORKSPACE ({DAYS[-1]}, all models) ===")
mw = defaultdict(lambda: [0, 0, 0])
glm_mw = defaultdict(lambda: [0, 0, 0])
for (day, mach, ws, model), (n, i, o) in agg.items():
    if day != DAYS[-1]:
        continue
    a = mw[(mach, ws)]
    a[0] += n; a[1] += i; a[2] += o
    if model.startswith("glm"):
        g = glm_mw[(mach, ws)]
        g[0] += n; g[1] += i; g[2] += o

print(f"{'machine':10s} {'workspace':28s} {'n':>6s} {'in M':>9s} {'out M':>7s}")
for (mach, ws), (n, i, o) in sorted(mw.items(), key=lambda kv: -kv[1][1])[:18]:
    print(f"{mach:10s} {ws[:28]:28s} {n:6d} {i/1e6:9.2f} {o/1e6:7.2f}")

print()
print("=== GLM ONLY (glm-5.2 + glm-5.3), per day: top machine x workspace by input ===")
for day in DAYS:
    g = defaultdict(lambda: [0, 0, 0])
    for (d, mach, ws, model), (n, i, o) in agg.items():
        if d == day and model.startswith("glm"):
            a = g[(mach, ws)]
            a[0] += n; a[1] += i; a[2] += o
    if not g:
        continue
    gt = [sum(x[k] for x in g.values()) for k in range(3)]
    print(f"\n-- {day} : GLM total n={gt[0]} in={gt[1]/1e6:.1f}M out={gt[2]/1e6:.2f}M --")
    for (mach, ws), (n, i, o) in sorted(g.items(), key=lambda kv: -kv[1][1])[:10]:
        print(f"  {mach:10s} {ws[:30]:30s} n={n:5d} in={i/1e6:7.2f}M out={o/1e6:5.2f}M")
