#!/usr/bin/env python3
"""OUT-per-turn census by (lane, workspace, machine) over extracted day dirs.

Answers "who spends the output tokens, per lane and workspace" (#445 B1): one
row per (lane, workspace, machine) with non-compaction turns and their OUT,
plus compaction turns/OUT counted separately (COMPACT_SIG on the last user
text). Copied from compaction-trend.py @ 77a96b10 (regexes, workspace_of,
req_identity, (pid, reqN) + 35-min pairing) -- copied, NOT imported, so
re-diff against the source when either side drifts. On the containerized hub pid is
always 1 and reqN resets per restart, so counting is per FILE, never per
(pid, reqN) aggregate.

Usage is the TERMINAL message_delta object, read whole line-by-line as JSON
(#414 -- never brace-regex, nested objects break it) from an 8 KiB tail read.
A resp whose tail carries "usage" but no parseable object is counted in a
PARSE_FAIL row, never silently 0.

Input: dirs already extracted with req-*.json + resp-*.sse --
`compaction-trend.py --keep` produces comp-<day>/, or extract manually:
  7z x captures-<day>.7z -o<dir> "req-*.json" "resp-*.sse" -y

Usage: python ws-out-census.py --dirs comp-2026-07-05 comp-2026-07-06
"""
import argparse
import collections
import json
import os
import re
import sys
from datetime import datetime, timedelta

REQ_RE = re.compile(
    r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-(.+)\.json$")
RESP_RE = re.compile(
    r"^resp-(\d+)-r\d+-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-\d{2}-\d+Z-(.+)\.sse$")
HDR_RE = re.compile(r"^# parser=\S+ model=(\S+) reqN=(\d+) pid=(\d+)", re.M)
CC_VER = re.compile(r"cc_version=([^;\s]+)")
COMPACT_SIG = "CRITICAL: Respond with TEXT"
USER_PATH_RE = re.compile(r"[\\/]+users[\\/]+[a-z_0-9-]+")
KNOWN_ROOTS = [
    "coursia", "epita", "argumentum", "roo-extensions", "claudish",
    "models-index", "maintenance", "myia",
]
TAIL_BYTES = 8192


def fname_dt(date_h, minutes):
    return datetime.strptime(date_h + minutes, "%Y-%m-%dT%H%M")


def workspace_of(body_text):
    scrubbed = USER_PATH_RE.sub(" /users/x/", body_text)
    counts = {r: scrubbed.count(r) for r in KNOWN_ROOTS}
    best = max(counts, key=lambda r: counts[r])
    return best if counts[best] >= 3 else "(inconnu)"


def req_identity(env):
    body = env.get("body", env)
    s = body.get("system")
    stext = " ".join(
        x.get("text", "") for x in s if isinstance(x, dict)
    ) if isinstance(s, list) else (s or "")
    vm = CC_VER.search(stext)
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


def terminal_usage(path):
    """Last coherent usage object from the resp tail (8 KiB), line-by-line
    JSON. Returns dict, None (no usage statement), or "PARSE_FAIL"."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            chunk = f.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    usage = None
    saw_usage_word = '"usage"' in chunk
    for line in chunk.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        u = obj.get("usage")
        if isinstance(u, dict) and "output_tokens" in u:
            usage = u  # keep the LAST one = terminal message_delta
    if usage is None and saw_usage_word:
        return "PARSE_FAIL"
    return usage


def census_day(dirpath, day):
    # Pass 1: index every req envelope by (pid, reqN) with identity.
    req_index = collections.defaultdict(list)
    n_req = 0
    n_req_bad = 0
    with os.scandir(dirpath) as it:
        for e in it:
            n = e.name
            if not (n.startswith("req-") and n.endswith(".json")):
                continue
            m = REQ_RE.match(n)
            if not m or not m.group(3).startswith(day):
                continue
            dt = fname_dt(m.group(3), m.group(4))
            req_index[(m.group(1), m.group(2))].append((dt, e.path))
            n_req += 1
    ident_cache = {}      # req path -> (ident, is_compact) or None on failure
    agg = collections.defaultdict(lambda: {
        "turns": 0, "out": 0, "c_turns": 0, "c_out": 0, "parse_fail": 0})
    unp = 0
    no_usage = 0
    with os.scandir(dirpath) as it:
        for e in it:
            n = e.name
            if not (n.startswith("resp-") and n.endswith(".sse")):
                continue
            m = RESP_RE.match(n)
            if not m or not m.group(2).startswith(day):
                continue
            head = open(e.path, encoding="utf-8", errors="replace").read(400)
            h = HDR_RE.search(head)
            if not h:
                continue
            key = (h.group(3), h.group(2))
            recs = req_index.get(key)
            if not recs:
                unp += 1
                continue
            dt = fname_dt(m.group(2), m.group(3))
            req = next((r for r in recs
                        if r[0] <= dt <= r[0] + timedelta(minutes=35)), None)
            if req is None:
                unp += 1
                continue
            lane = m.group(4).split("-", 1)[0]
            u = terminal_usage(e.path)
            if u == "PARSE_FAIL":
                agg[(lane, "?", "?")]["parse_fail"] += 1
                continue
            if u is None:
                no_usage += 1  # no usage statement (lane-out-trend sansUsage class)
                continue
            rp = req[1]
            if rp not in ident_cache:
                try:
                    env = json.loads(
                        open(rp, encoding="utf-8", errors="replace").read())
                    body = env.get("body", env)
                    ident_cache[rp] = (
                        req_identity(env),
                        last_user_text(body).strip().startswith(COMPACT_SIG))
                except (OSError, ValueError):
                    ident_cache[rp] = None
            got = ident_cache[rp]
            if got is None or got[0] is None:
                n_req_bad += 1
                continue
            ident, is_compact = got
            cell = agg[(lane, ident[1], ident[0])]
            out = u.get("output_tokens") or 0
            if is_compact:
                cell["c_turns"] += 1
                cell["c_out"] += out
            else:
                cell["turns"] += 1
                cell["out"] += out
    return n_req, unp, n_req_bad, no_usage, agg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dirs", nargs="+", required=True,
                    help="extracted day dirs (comp-YYYY-MM-DD), cwd-relative")
    a = ap.parse_args()
    for d in a.dirs:
        day = os.path.basename(d).replace("comp-", "")
        n_req, unp, bad, nousage, agg = census_day(d, day)
        print("== %s  reqs=%d unpaired_resp=%d ident_fail=%d no_usage=%d" %
              (day, n_req, unp, bad, nousage))
        print("  %-14s %-14s %-10s %7s %12s %9s %7s %10s" % (
            "lane", "workspace", "machine", "turns", "OUT", "OUT/t", "c_turns", "c_OUT"))
        for (lane, ws, mach), v in sorted(
                agg.items(), key=lambda x: -x[1]["out"]):
            ot = v["out"] / v["turns"] if v["turns"] else 0
            print("  %-14s %-14s %-10s %7d %12d %9.0f %7d %10d" % (
                lane, ws, mach, v["turns"], v["out"], ot,
                v["c_turns"], v["c_out"]))
            if v["parse_fail"]:
                print("  %-14s %-14s %-10s PARSE_FAIL=%d" % (
                    lane, "?", "?", v["parse_fail"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())