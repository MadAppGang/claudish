#!/usr/bin/env python3
"""Compaction telemetry across lanes — "what does re-reading context cost us?"

EPIC #116 / issue #89: instrument the /compact events on the BUDGET lanes
(the native lane is already covered by native-trend.py). Every compaction
re-pays the full session context (harness block included, #23) to produce
a summary; this makes that cost visible per Machine:Workspace:Harness.

    python scripts/compaction-trend.py --days 2026-09-13 2026-09-16
        [--archives-dir "G:\\Mon Drive\\Backups-Cloud\\claudish"]
        [--loose-dir D:\\claudish-captures] [--loose-date 2026-09-17]
        [--7z "C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\7z.exe"]
        [--top 15]

Traps, each of which yields a wrong-but-plausible number:

  1. Detection is STRUCTURAL, never UA-based (#89): the /compact call's
     LAST user message starts with "CRITICAL: Respond with TEXT".
     MEASURED 2026-09-16 (budget lanes, 32,875 reqs): the 235 real
     compactions ALL carried stream:True — the stream:false hypothesis in
     the issue describes the buffering path (which exists as a guard), not
     the wire shape, so the flag is NOT a discriminator and must not gate
     detection. The signature must anchor the LAST user message: a plain
     grep of the string matches 5,164 files that day (the instruction is
     echoed back in every later request's history) — 22x overcount.
     The continuation message ("This session is being continued") is the
     NEXT turn's first request — counting it double-counts compactions:
     the instruction counts, not the marker.
  2. Usage comes from the RESPONSE, via (pid, reqN) pairing: the resp SSE
     header carries reqN, the req filename carries the same counter.
     MEASURED on the hub: the proxy is the container entrypoint, so pid is
     ALWAYS 1 and every container restart resets reqN under the SAME pid —
     the (pid, reqN) key collides across restarts and must NEVER aggregate
     requests (count per FILE, pair per file's own timestamp). The
     35-minute pairing window is the disambiguator, not pid uniqueness
     (native-consumption.py traps #3/#9, container edition).
  3. wire-openai translated streams may emit a ZERO usage block before the
     real one (#89): take MAX across occurrences per field, not FIRST.
  4. Re-paid volume is the WHOLE context being re-read: input_tokens +
     cache_read_input_tokens + cache_creation_input_tokens. The output
     side (the summary) is reported separately — it is the compaction's
     product, not its cost.
  5. Archives hold every lane — that is the point here (budget lanes), but
     extract BOTH req-*.json and resp-*.sse: usage lives in resps, identity
     (machine/workspace/cc_version) lives in req envelopes and bodies.
  6. Workspace attribution is heuristic (most-cited known path root,
     users/<name> segments scrubbed) — label it as such.
  7. The ratio denominator counts ALL requests of the key in the window
     (envelope-only, no resp needed), so a quiet workspace cannot fake a
     high compaction rate from a small sample — and compactions on a
     window with zero other requests still show (ratio capped at 1.0).
"""

import argparse
import collections
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta

REQ_RE = re.compile(
    r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-(.+)\.json$")
RESP_RE = re.compile(
    r"^resp-(\d+)-r\d+-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-(.+)\.sse$")
HDR_RE = re.compile(r"^# parser=\S+ model=(\S+) reqN=(\d+) pid=(\d+)", re.M)
U_IN = re.compile(r'"input_tokens":\s*(\d+)')
U_OUT = re.compile(r'"output_tokens":\s*(\d+)')
U_CR = re.compile(r'"cache_read_input_tokens":\s*(\d+)')
U_CC = re.compile(r'"cache_creation_input_tokens":\s*(\d+)')
CC_VER = re.compile(r"cc_version=([^;\s]+)")
COMPACT_SIG = "CRITICAL: Respond with TEXT"
CONT_SIG = "This session is being continued"

USER_PATH_RE = re.compile(r"[\\/]+users[\\/]+[a-z_0-9-]+")
KNOWN_ROOTS = [
    "coursia", "epita", "argumentum", "roo-extensions", "claudish",
    "models-index", "maintenance", "myia",
]


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", nargs="+", default=[],
                    help="archive dates YYYY-MM-DD, in order")
    ap.add_argument("--archives-dir", default=r"G:\Mon Drive\Backups-Cloud\claudish")
    ap.add_argument("--loose-dir", default="",
                    help="dir holding the live (partial) day's captures")
    ap.add_argument("--loose-date", default="",
                    help="date prefix of the loose day (marks it partial)")
    # dest= is mandatory: "7z" is not a valid Python identifier
    # (native-trend.py shipped with this bug live).
    ap.add_argument("--7z", dest="seven_z",
                    default=r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe")
    ap.add_argument("--keep", action="store_true",
                    help="keep extracted day dirs (default: temp, deleted)")
    ap.add_argument("--top", type=int, default=15)
    return ap.parse_args()


def fname_dt(date_h, minutes):
    return datetime.strptime(date_h + minutes, "%Y-%m-%dT%H%M")


def day_dir(day, a, root):
    d = os.path.join(root, "comp-" + day)
    if os.path.isdir(d) and os.listdir(d):
        return d
    archive = os.path.join(a.archives_dir, "captures-%s.7z" % day)
    if not os.path.isfile(archive):
        print("archive absente: %s" % archive, file=sys.stderr)
        return None
    os.makedirs(d, exist_ok=True)
    subprocess.run([a.seven_z, "x", archive, "-o" + d,
                    "req-*.json", "resp-*.sse", "-y"],
                   check=True, stdout=subprocess.DEVNULL)
    return d


def workspace_of(body_text):
    scrubbed = USER_PATH_RE.sub(" /users/x/", body_text)
    counts = {r: scrubbed.count(r) for r in KNOWN_ROOTS}
    best = max(counts, key=lambda r: counts[r])
    return best if counts[best] >= 3 else "(inconnu)"


def last_user_text(body):
    for m in reversed(body.get("messages", [])):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            texts = [x.get("text", "") for x in c
                     if isinstance(x, dict) and x.get("type") == "text"]
            if texts:
                return texts[0]
    return ""


def req_identity(env):
    """(machine, workspace, cc_version) from an envelope, or None."""
    body = env.get("body", env)
    s = body.get("system")
    stext = " ".join(
        x.get("text", "") for x in s if isinstance(x, dict)
    ) if isinstance(s, list) else (s or "")
    vm = CC_VER.search(stext)
    # Attribution text: system + every message's text blocks. Cheaper than
    # json.dumps(body) by far — on a full budget day that dumps ~67k bodies
    # and the memory churn killed the run (exit 4, silent, no traceback).
    parts = [stext]
    for m in body.get("messages", []):
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            parts.extend(x.get("text", "") for x in c
                         if isinstance(x, dict) and x.get("type") == "text")
    return (env.get("machine") or "?",
            workspace_of(" ".join(parts).lower()),
            vm.group(1) if vm else "?")


def stats_day(dirpath, day, prefixes, partial):
    """One day's table. prefixes = ['YYYY-MM-DDT00'..'T23'] filename filter."""
    # Pass 1: index every req envelope (window-filtered on filenames only).
    req_index = collections.defaultdict(list)  # (pid, n) -> [(dt, path)]
    totals = collections.Counter()             # key -> all requests
    compacts = {}                              # (pid, n) -> compact record
    n_req = 0
    with os.scandir(dirpath) as it:
        for e in it:
            n = e.name
            if not (n.startswith("req-") and n.endswith(".json")):
                continue
            m = REQ_RE.match(n)
            if not m or m.group(3) not in prefixes:
                continue
            dt = fname_dt(m.group(3), m.group(4))
            key = (m.group(1), m.group(2))
            req_index[key].append((dt, e.path))
            n_req += 1
    for key, cands in req_index.items():
        cands.sort()
        for dt, path in cands:
            try:
                env = json.loads(
                    open(path, encoding="utf-8", errors="replace").read())
            except (OSError, ValueError):
                continue
            ident = req_identity(env)
            if ident is None:
                continue
            totals[ident] += 1
            body = env.get("body", env)
            if last_user_text(body).strip().startswith(COMPACT_SIG):
                compacts[(key, dt, path)] = {"ident": ident, "ts": dt}

    by_pair = collections.defaultdict(list)
    for (key, dt, path), rec in compacts.items():
        by_pair[key].append(rec)

    # Pass 2: usage from paired responses (MAX per field, trap #3).
    unp = 0
    with os.scandir(dirpath) as it:
        for e in it:
            n = e.name
            if not (n.startswith("resp-") and n.endswith(".sse")):
                continue
            m = RESP_RE.match(n)
            if not m or m.group(2) not in prefixes:
                continue
            head = open(e.path, encoding="utf-8", errors="replace").read(400)
            h = HDR_RE.search(head)
            if not h:
                continue
            key = (h.group(3), h.group(2))
            recs = by_pair.get(key)
            if not recs:
                continue
            dt = fname_dt(m.group(2), m.group(3))
            rec = next((r for r in recs
                        if r["ts"] <= dt <= r["ts"] + timedelta(minutes=35)
                        and r.get("usage") is None), None)
            if rec is None:
                continue
            rt = open(e.path, encoding="utf-8", errors="replace").read()
            fields = {
                "in": [int(x) for x in U_IN.findall(rt)],
                "out": [int(x) for x in U_OUT.findall(rt)],
                "cr": [int(x) for x in U_CR.findall(rt)],
                "cc": [int(x) for x in U_CC.findall(rt)],
            }
            if not any(fields.values()):
                continue  # zero/absent usage: not the pairing we want
            rec["usage"] = {
                k: max(v) if v else 0 for k, v in fields.items()}

    rows = collections.defaultdict(lambda: {
        "reqs": 0, "comp": 0, "paired": 0, "repaid": 0, "sumout": 0})
    for key, rec in compacts.items():
        d = rows[rec["ident"]]
        d["comp"] += 1
        if "usage" not in rec:
            unp += 1
            continue
        d["paired"] += 1
        u = rec["usage"]
        d["repaid"] += u["in"] + u["cr"] + u["cc"]
        d["sumout"] += u["out"]
    for ident, n in totals.items():
        rows[ident]["reqs"] += n

    return {
        "label": day + (" (partiel)" if partial else ""),
        "n_req": n_req, "unp": unp,
        "rows": dict(rows),
    }


def main():
    a = parse_args()
    if not a.days and not (a.loose_dir and a.loose_date):
        print("--days ou --loose-dir/--loose-date requis", file=sys.stderr)
        return 1
    root = os.getcwd() if a.keep else tempfile.mkdtemp(prefix="comp-trend-")
    results = []
    for day in a.days:
        d = day_dir(day, a, root)
        if d:
            s = stats_day(d, day, [day + "T%02d" % h for h in range(24)], False)
            if s:
                results.append(s)
    if a.loose_dir and a.loose_date:
        day = a.loose_date
        s = stats_day(a.loose_dir, day,
                      [day + "T%02d" % h for h in range(24)], True)
        if s:
            results.append(s)
    if not results:
        print("aucun jour exploitable", file=sys.stderr)
        return 1

    grand = {"reqs": 0, "comp": 0, "paired": 0,
             "repaid": 0, "sumout": 0, "unp": 0}
    for s in results:
        for d in s["rows"].values():
            for k in grand:
                grand[k] += d.get(k, 0)
        grand["unp"] += s["unp"]

    print(f"{'jour':18s} {'reqs':>7s} {'compact':>8s} "
          f"{'re-payes':>12s} {'moy/compact':>12s} {'OUT resumes':>12s} {'non appar.':>10s}")
    print("  (compact compte TOUTES les compactions ; re-payes et moyennes couvrent")
    print("   les compactions appariees seulement — non appar. = usage manquant)")
    for s in results:
        tot = {"reqs": 0, "comp": 0, "paired": 0, "repaid": 0, "sumout": 0}
        for d in s["rows"].values():
            for k in tot:
                tot[k] += d[k]
        print(f"{s['label']:18s} {tot['reqs']:7,d} {tot['comp']:8,d} "
              f"{tot['repaid']:12,d} "
              f"{tot['repaid'] // max(tot['paired'], 1):12,d} "
              f"{tot['sumout']:12,d} {s['unp']:10,d}")
    print()
    print("Par Machine:Workspace:Harness (re-payes triés) — workspace heuristique:")
    agg = collections.defaultdict(lambda: {
        "reqs": 0, "comp": 0, "paired": 0, "repaid": 0, "sumout": 0})
    for s in results:
        for ident, d in s["rows"].items():
            for k in agg[ident]:
                agg[ident][k] += d[k]
    print(f"  {'machine:workspace:harness':52s} {'reqs':>7s} {'compact':>7s} "
          f"{'ratio':>6s} {'re-payes':>12s} {'moy/comp':>9s} {'OUT resumes':>12s}")
    for ident, d in sorted(agg.items(), key=lambda kv: -kv[1]["repaid"])[:a.top]:
        ratio = min(d["comp"] / max(d["reqs"], 1), 1.0)
        print(f"  {':'.join(ident):52s} {d['reqs']:7,d} {d['comp']:7,d} "
              f"{ratio:6.1%} {d['repaid']:12,d} "
              f"{d['repaid'] // max(d['paired'], 1):9,d} {d['sumout']:12,d}")
    print()
    days_n = len(results)
    if grand["comp"]:
        print(f"Totaux: {grand['comp']:,} compactions "
              f"({grand['comp'] / days_n:.1f}/jour sur {days_n} jour(s)), "
              f"{grand['repaid']:,} tokens re-payes "
              f"(~{grand['repaid'] / days_n / 1e6:.1f} M/jour), "
              f"resumes {grand['sumout']:,} OUT.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
