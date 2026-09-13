#!/usr/bin/env python3
"""Native (Anthropic-billed) consumption diagnosis from claudish captures.

Answers, in one run, the recurring fleet question: WHO burns the
Anthropic-native budget, how much, on cron or interactive traffic, and at
what hourly cadence.

    python scripts/native-consumption.py [--since 2026-09-13T00] [--top 10]
        [--captures-dir D:\\claudish-captures]

Reads only loose req-*.json / resp-*.sse captures (archives are packed
nightly by compress-captures.ps1 at 02:47 — run before packing, or pull the
day's archive first).

Per-response attribution needs req<->resp pairing; each trap below produced
a wrong-but-plausible number during development:

  1. req captures are ENVELOPES: {ts, src, machine, model, pid, body}. The
     Anthropic payload (system/messages/metadata) lives under .body.
  2. req filenames end in EITHER -direct.json (LAN) or
     -<ip>__<ip>_<port>.json (WAN via ARR). The native lane is WAN-shaped:
     an index built on -direct alone silently drops every native request.
  3. Pairing key is (pid, reqN-from-resp-HEADER), never the resp filename
     rank rNNNN: the response counter is a different sequence, and BOTH
     counters reset at every container restart — always add a time window
     (req within 35 min before its resp, same day).
  4. Timestamps: parse as datetimes. String-slicing minutes across two
     different filename shapes is how you pair 06:49 with 06:09.
  5. Usage tokens: input/cache fields come from message_start (FIRST
     occurrence), output_tokens from message_delta (LAST occurrence,
     cumulative). Mixing them double-counts or zeroes arbitrarily.
  6. Workspace attribution is by MOST-CITED known path root in the decoded
     body (these clients carry no Working-directory env block; identity
     lives in the paths of the conversation). A session about CoursIA
     mentioning claudish 8 times still attributes to CoursIA. Label the
     numbers heuristic, not exact.
  7. cc_workload=cron / cc_entrypoint live in system[0] (the
     x-anthropic-billing-header block), device_id in metadata.user_id.
  8. cc_workload=cron is a PER-REQUEST stamp. A cron-fired turn in a REPL
     session carries it on the turn's requests only — tool-loop continuations
     and later turns of the same session do NOT. "Unmarked" therefore means
     "not stamped on this request", NEVER "a human is driving". To tell what
     a request actually is, classify the LAST user message: a compaction
     call ("CRITICAL: Respond with TEXT ONLY"), a continuation summary
     ("This session is being continued") or a slash command each identify
     the turn's nature with no workload marker at all.
"""

import argparse
import collections
import json
import os
import re
import sys
from datetime import datetime, timedelta

RESP_RE = re.compile(
    r"^resp-(\d+)-r\d+-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-(.+)\.sse$")
REQ_RE = re.compile(
    r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-.+\.json$")
HDR_RE = re.compile(r"^# parser=\S+ model=(\S+) reqN=(\d+) pid=(\d+)", re.M)
U_IN = re.compile(r'"input_tokens":\s*(\d+)')
U_OUT = re.compile(r'"output_tokens":\s*(\d+)')
U_CR = re.compile(r'"cache_read_input_tokens":\s*(\d+)')
U_CC = re.compile(r'"cache_creation_input_tokens":\s*(\d+)')
DEV_RE = re.compile(r'"device_id":"([0-9a-f]{8})')

KNOWN_ROOTS = [
    "coursia", "epita", "argumentum", "roo-extensions", "claudish",
    "models-index", "maintenance", "myia",
]


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--captures-dir", default=r"D:\claudish-captures")
    ap.add_argument("--since", default="", help="YYYY-MM-DDTHH (UTC), inclusive")
    ap.add_argument("--until", default="", help="YYYY-MM-DDTHH (UTC), exclusive")
    ap.add_argument("--top", type=int, default=12)
    return ap.parse_args()


def fname_dt(date_h, minutes):
    return datetime.strptime(date_h + minutes, "%Y-%m-%dT%H%M")


def workspace_of(body_text):
    counts = {r: body_text.count(r) for r in KNOWN_ROOTS}
    best = max(counts, key=lambda r: counts[r])
    return best if counts[best] >= 3 else "(inconnu)"


def main():
    a = parse_args()
    since = fname_dt(a.since, "00") if a.since else None
    until = fname_dt(a.until, "00") if a.until else None

    req_index = collections.defaultdict(list)
    resps = []
    with os.scandir(a.captures_dir) as it:
        for e in it:
            n = e.name
            if n.startswith("req-") and n.endswith(".json"):
                m = REQ_RE.match(n)
                if m:
                    dt = fname_dt(m.group(3), m.group(4))
                    if since and dt < since:
                        continue
                    if until and dt >= until:
                        continue
                    req_index[(m.group(1), m.group(2))].append((dt, e.path))
            elif n.startswith("resp-") and "-native-" in n and n.endswith(".sse"):
                m = RESP_RE.match(n)
                if not m:
                    continue
                dt = fname_dt(m.group(2), m.group(3))
                if since and dt < since:
                    continue
                if until and dt >= until:
                    continue
                resps.append((dt, m.group(1), e.path))
    if not resps:
        print("Aucune capture native dans la fenetre.", file=sys.stderr)
        return 1
    resps.sort()

    ws = collections.defaultdict(lambda: {
        "n": 0, "out": 0, "in": 0, "cr": 0, "cc": 0,
        "cron": 0, "int": 0, "sub": 0, "compact": 0, "cont": 0})
    dev = collections.defaultdict(lambda: {"n": 0, "out": 0})
    hours = collections.Counter()
    top_out = []
    tot = {"n": 0, "out": 0, "in": 0, "cr": 0, "cc": 0, "unp": 0}
    models = collections.Counter()

    for ts, pid, path in resps:
        try:
            head = open(path, encoding="utf-8", errors="replace").read(400)
            h = HDR_RE.search(head)
            if not h:
                continue
            rt = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        model, reqN, hdr_pid = h.group(1), h.group(2), h.group(3)
        models[model] += 1
        ins, outs = U_IN.findall(rt), U_OUT.findall(rt)
        crs, ccs = U_CR.findall(rt), U_CC.findall(rt)
        i = int(ins[0]) if ins else 0
        o = int(outs[-1]) if outs else 0
        cr = int(crs[0]) if crs else 0
        cc = int(ccs[0]) if ccs else 0
        tot["n"] += 1
        tot["out"] += o
        tot["in"] += i
        tot["cr"] += cr
        tot["cc"] += cc
        hours[ts.strftime("%d %Hh")] += 1
        top_out.append((o, ts))
        cands = sorted(
            (c for c in req_index.get((hdr_pid, reqN), [])
             if c[0] <= ts and ts - c[0] <= timedelta(minutes=35)))
        if not cands:
            tot["unp"] += 1
            continue
        try:
            env = json.loads(
                open(cands[-1][1], encoding="utf-8", errors="replace").read())
        except (OSError, ValueError):
            continue
        body = env.get("body", env)
        s = body.get("system")
        stext = " ".join(
            x.get("text", "") for x in s if isinstance(x, dict)
        ) if isinstance(s, list) else (s or "")
        raw = json.dumps(body)
        w = workspace_of((stext + " " + raw).lower())
        cron = "cc_workload=cron" in stext
        md = str(body.get("metadata", {}).get("user_id", ""))
        dv = DEV_RE.search(md)
        d = ws[w]
        d["n"] += 1
        d["out"] += o
        d["in"] += i
        d["cr"] += cr
        d["cc"] += cc
        d["cron" if cron else "int"] += 1
        last_user = ""
        for m in reversed(body.get("messages", [])):
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, str):
                last_user = c
                break
            if isinstance(c, list):
                texts = [x.get("text", "") for x in c
                         if isinstance(x, dict) and x.get("type") == "text"]
                if texts:
                    last_user = texts[0]
                    break
        lu = last_user.strip()
        if lu.startswith("CRITICAL: Respond with TEXT"):
            d["compact"] += 1
        elif lu.startswith("This session is being continued"):
            d["cont"] += 1
        if "cc_is_subagent" in raw:
            d["sub"] += 1
        k = (dv.group(1) if dv else "?", w, "cron" if cron else "interactif")
        dev[k]["n"] += 1
        dev[k]["out"] += o

    print(f"Reponses natives: {tot['n']}  (non appariees: {tot['unp']})")
    print(f"Modeles: {dict(models.most_common())}")
    print(f"Tokens:  OUT={tot['out']:,}  in_frais={tot['in']:,}  "
          f"cache_read={tot['cr']:,}  cache_creation={tot['cc']:,}")
    print(f"Moyenne par requete: OUT={tot['out'] // max(tot['n'], 1):,}  "
          f"cache_read={tot['cr'] // max(tot['n'], 1):,}")
    print()
    print("Par heure:")
    for h in sorted(hours):
        print(f"  {h}  {'#' * (hours[h] // 2 or 1)} {hours[h]}")
    print()
    print(f"Workspace ({'heuristic — racine la plus citee'}), trie par OUT:")
    print(f"  {'workspace':22s} {'n':>5s} {'marqC':>5s} {'nonM':>5s} "
          f"{'OUT tok':>11s} {'in frais':>10s} {'cache_read':>12s} "
          f"{'compact':>7s} {'continu':>7s}")
    print("  (marqC = marque cc_workload=cron SUR CETTE requete — voir piege 8)")
    for w, d in sorted(ws.items(), key=lambda kv: -kv[1]["out"])[:a.top]:
        print(f"  {w:22s} {d['n']:5d} {d['cron']:5d} {d['int']:5d} "
              f"{d['out']:11,d} {d['in']:10,d} {d['cr']:12,d} "
              f"{d['compact']:7d} {d['cont']:7d}")
    print()
    print("Par device + workload (top):")
    for (dv, w, wl), c in sorted(dev.items(), key=lambda kv: -kv[1]["out"])[:a.top]:
        print(f"  {dv}  {w:22s} {wl:11s} n={c['n']:4d}  OUT={c['out']:10,d}")
    print()
    top_out.sort(reverse=True)
    print("Top responses par OUT:")
    for o, ts in top_out[:5]:
        print(f"  {ts:%d %H:%M}  OUT={o:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
