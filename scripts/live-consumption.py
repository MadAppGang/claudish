#!/usr/bin/env python3
r"""live-consumption.py — consumption snapshot by machine:workspace:session (Epic #41 v0).

Consolidates the 2026-10-02 bricks (decompose_minimax.py, multiday_7z.py) into
the ONE dimension the committed organs did not already cover. The consolidation
was done the way this repo defines it — each brick function analysed, then
matched against what already ships, so that only the real gap is written here:

  brick function                         already shipped as
  -------------------------------------  ---------------------------------------
  req index by (pid, counter)            traffic-consumption.py load_requests()
                                         + traffic-mxws.py pass 1
  usage triple (coherent terminal, #600)  traffic-consumption.py usage_of()
  usage MAX per field (pre-#600 copy)     traffic-mxws.py pass 2, compaction-trend.py
  nearest-ts req<->resp join             traffic-consumption.py pick_request()
  machine x workspace x model rollup      traffic-mxws.py aggregate (incl. 7z days)
  session attribution                     billed-attrib.py — NATIVE lane only
  ---------------------------------------------------------------- gap, written here
  machine:workspace:SESSION, ALL LANES
  subagent / cron ventilation             billing-header parse, semantics reused
                                         from native-consumption.py (see trap 1)

Three traps encoded, all measured in this repo:

1. The subagent flag lives in the x-anthropic-billing-header SYSTEM block, NOT
   in `metadata.user_id`. Measured by ai-01's review of this script (#334 B1)
   on the 60 most recent req-* captures: `user_id` parses to exactly
   `(account_uuid, device_id, session_id)` and NEVER carries `is_subagent` —
   the first version of this script read it there, every line reported 0/0,
   and its synthetic fixtures had fabricated the shape they believed. The
   flag has THREE states, parsed from the billing-header segment only:
   `cc_is_subagent=true` -> subagent; header present without the flag ->
   main; header absent -> unknown (never guessed from anywhere else).
   The cc_workload=cron ventilation rides the same segment. Per-request
   stamp caveat (native-consumption.py trap 8): cron is stamped on the
   requests a cron fired, NOT on the whole session — "not cron here" is
   "this request was not stamped", never "a human is driving".
2. `system` is serialized AFTER `messages`: on a big capture the billing
   header sits in the dropped middle, past the 512K head and unreachable to
   the 128K tail through `tools[]` (~134K measured for #99). The header is
   therefore looked up in the capped read FIRST, then, on a miss, by a
   CHUNKED whole-file scan (`bytes.find` per block — no full load, no regex
   over the file). The found-rate is published in the digest so a silent
   depth regression is visible.
3. (pid, reqN) is not unique — the counter restarts with the container — so
   the key maps to a DATED LIST and the join picks the latest candidate that
   precedes its response. `metadata.user_id` still yields the SESSION id (the
   one thing it really carries); a user_id that does not parse is counted as
   `unattributed`, never guessed at.

The marker line can be ECHOED in conversation prose (a quoted capture inside
messages); the real system block is serialized after messages, so the LAST
occurrence in the file wins — same ordering argument as trap 2.

`Primary working directory` echoes are guarded the other way: only an
absolute path counts (Windows drive or POSIX root — containerized lanes send
POSIX paths, accepted since #334).

Read-only. Emits a JSON snapshot and a markdown digest; the markdown is what an
hourly task is meant to drop where a human will see it.

Usage:
  python scripts/live-consumption.py [capture_dir] [--hours 3] [--json out.json] [--md out.md]
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

REQ_NAME = re.compile(r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})")
RESP_NAME = re.compile(r"^resp-(\d+)-r?(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})")
MACHINE_RE = re.compile(r'"machine"\s*:\s*"([^"]*)"')
WORKLOAD_RE = re.compile(r'"workload"\s*:\s*"([^"]*)"')
WORKDIR_RE = re.compile(r"Primary working directory:\s*(.+?)\\n")
SEP_RE = re.compile(r"[\\/]+")
USAGE_RX = re.compile(r'"usage"\s*:\s*\{([^}]*)\}')
FIELD_RX = re.compile(
    r'"(input_tokens|cache_read_input_tokens|cache_creation_input_tokens|output_tokens)"\s*:\s*(\d+)')
# The billing-header marker, its k=v; run, and the flags that ride it. The
# segment regex stops at the closing quote of the system text block, so a
# match is the header's OWN fields, never what follows in the file.
BILLING_MARKER = b"x-anthropic-billing-header:"
BILLING_SEG_RE = re.compile(r'x-anthropic-billing-header:\s*([^"\\]*)')
BILLING_KV_RE = re.compile(r"(\w+)=([^;]*)")
# Chunked fallback (trap 2): 1 MB blocks with a 64 B overlap so a marker
# straddling two blocks is found; the k=v run is short, a 2 KB window from the
# match reads it whole.
SCAN_BLOCK = 1024 * 1024
SCAN_OVERLAP = 64
SCAN_WINDOW = 2048
# Attribution markers at three depths, measured on 254 sampled captures over
# a 2 h hub window: the ENVELOPE (`machine`, `workload`) opens the file; the
# workspace marker (`Primary working directory`, first occurrence inside
# messages) sits in the MIDDLE at p50 267 KB / p95 351 KB; and
# `body.metadata.user_id` closes the body, near the end. A head-only read
# measured 4 559 captures as `unattributed`; a 256 KB head then left a large
# share of attributed captures with workspace `-`. Hence a DEEP head that
# must reach the workdir marker, plus a short tail that only has to reach the
# trailing metadata. The billing header rides this capped read when it can
# and the chunked scan when it cannot (trap 2).
HEAD_BYTES = 512 * 1024
TAIL_BYTES = 128 * 1024


def ts_of(m):
    """`2026-10-04T21-09-18` -> aware datetime (UTC). The capture name spells the
    ISO timestamp with dashes in the time part."""
    return datetime.strptime(m.group(3) + "Z", "%Y-%m-%dT%H-%M-%SZ").replace(tzinfo=timezone.utc)


def extract_usage(text):
    """MAX per counter across every usage block. GLM (openai wire) emits a ZERO
    block before the real one, so first-wins under-reports by the whole turn."""
    best = {"input_tokens": 0, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0, "output_tokens": 0}
    for blk in USAGE_RX.findall(text):
        for k, v in FIELD_RX.findall(blk):
            v = int(v)
            if v > best[k]:
                best[k] = v
    return best


def user_id_session(uid):
    """Parse `body.metadata.user_id` — a JSON STRING — for its SESSION id.

    The session id is the one attribution field this string really carries
    (trap 1): a regex fallback would re-open the echo trap the docstring
    describes, so anything that does not parse as JSON yields None."""
    if not uid:
        return None
    try:
        d = json.loads(uid)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    sess = d.get("session_id")
    return sess[:12] if isinstance(sess, str) else None


def billing_fields_of(raw):
    """Subagent + workload verdicts from the x-anthropic-billing-header segment
    present in `raw` (None if the marker is absent from this text).

    Semantics REUSED from native-consumption.py (#334 B1): three states —
    cc_is_subagent=true -> True; header without the flag -> False (main);
    no header anywhere -> None (unknown). The LAST occurrence wins: the real
    system block is serialized after messages, so an echo quoted inside the
    conversation comes earlier in the file."""
    fields = None
    for seg in BILLING_SEG_RE.finditer(raw):
        pairs = dict(BILLING_KV_RE.findall(seg.group(1)))
        if pairs:
            fields = pairs
    if fields is None:
        return None
    sub = True if fields.get("cc_is_subagent", "").strip() == "true" else False
    return {"sub": sub, "workload": fields.get("cc_workload", "").strip() or None}


def scan_billing_file(path):
    """Whole-file chunked search for the billing header (trap 2): on a big
    capture `system` lands past the head and behind `tools[]`, out of reach of
    both capped windows. `bytes.find` per block with an overlap — the file is
    never loaded whole and no regex runs over it. LAST hit wins, same as the
    capped parse."""
    fields = None
    with open(path, "rb") as f:
        prev = b""
        while True:
            block = f.read(SCAN_BLOCK)
            if not block:
                break
            buf = prev + block
            start = 0
            while True:
                at = buf.find(BILLING_MARKER, start)
                if at < 0:
                    break
                window = buf[at:at + SCAN_WINDOW]
                m = BILLING_SEG_RE.search(window.decode("utf-8", errors="replace"))
                if m:
                    pairs = dict(BILLING_KV_RE.findall(m.group(1)))
                    if pairs:
                        fields = pairs
                start = at + 1
            prev = buf[-SCAN_OVERLAP:]
    if fields is None:
        return None
    sub = True if fields.get("cc_is_subagent", "").strip() == "true" else False
    return {"sub": sub, "workload": fields.get("cc_workload", "").strip() or None}


# The marker string is ECHOED in conversation prose — quoted rule text, harness
# summaries — and an echo captures a sentence fragment, not the path (measured
# live: workspace values like `CoursIA)` or a whole clause, splitting one
# session across two rows). Only an absolute path is accepted — a Windows
# drive OR a POSIX root (containerized lanes send POSIX paths, #334); echoes
# are skipped and the scan continues to the next occurrence.
PATHISH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|/)[^()<>|?*{}'\"]*$")


def workspace_of(raw):
    for m in WORKDIR_RE.finditer(raw):
        val = m.group(1).strip()
        if not PATHISH_RE.match(val):
            continue
        seg = SEP_RE.split(val)[-1]
        if seg:
            return seg
    return None


def pick_request(candidates, resp_ts):
    """The request PRECEDES its response: latest candidate whose ts <= resp_ts,
    else the earliest one (a clock skew must not silently drop the pair)."""
    if not candidates:
        return None
    prior = [c for c in candidates if c[0] <= resp_ts]
    if prior:
        return max(prior, key=lambda c: c[0])[1]
    return min(candidates, key=lambda c: c[0])[1]


def read_capped(path, head=HEAD_BYTES, tail=TAIL_BYTES):
    """Head + tail. See HEAD_BYTES for why one end is not enough. A file shorter
    than the sum is returned whole, so small fixtures behave as before."""
    size = os.path.getsize(path)
    # Binary mode: text mode refuses a nonzero end-relative seek, and the tail is
    # the whole point of this function.
    with open(path, "rb") as f:
        if size <= head + tail:
            blob = f.read()
        else:
            first = f.read(head)
            f.seek(-tail, os.SEEK_END)
            blob = first + f.read()
    return blob.decode("utf-8", errors="replace")


def collect(capture_dir, hours, head=HEAD_BYTES, tail=TAIL_BYTES):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    reqs = defaultdict(list)
    resps = []
    unattributed = 0
    billing_total = 0
    billing_found = 0
    # Name and window are filtered BEFORE any stat: on an SMB share os.path
    # .isfile is the dominant cost (measured >400 s elsewhere), and most
    # entries in a capture dir are neither req- nor resp-shaped (#334 nit).
    for name in os.listdir(capture_dir):
        rm = REQ_NAME.match(name) if name.endswith(".json") else None
        sm = RESP_NAME.match(name) if (rm is None and name.endswith(".sse")) else None
        if rm is None and sm is None:
            continue
        path = os.path.join(capture_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            ts = ts_of(rm or sm)
        except ValueError:
            continue
        if ts < cutoff:
            continue
        if rm is not None:
            raw = read_capped(path, head, tail)
            mm = MACHINE_RE.search(raw)
            env = mm.group(1) if mm else None
            wl_m = WORKLOAD_RE.search(raw)
            wl_env = wl_m.group(1) if wl_m else None
            uid = None
            uid_m = re.search(r'"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
            if uid_m:
                try:
                    uid = json.loads('"' + uid_m.group(1) + '"')
                except json.JSONDecodeError:
                    uid = None
            sess = user_id_session(uid)
            if sess is None:
                unattributed += 1
            billing_total += 1
            billing = billing_fields_of(raw)
            if billing is None:
                billing = scan_billing_file(path)
            if billing is not None:
                billing_found += 1
                # Envelope workload is exact when present (post-#98); the
                # header's own cc_workload covers pre-#98 captures — same
                # priority as native-consumption.py.
                cron = (wl_env == "cron") if wl_env else (billing["workload"] == "cron")
            else:
                cron = (wl_env == "cron")
            reqs[(int(rm.group(1)), int(rm.group(2)))].append(
                (ts, {"machine": env or "(direct)", "ws": workspace_of(raw) or "-",
                      "session": sess or "unattributed",
                      "sub": billing["sub"] if billing else None,
                      "cron": cron}))
            continue
        resps.append((ts, int(sm.group(1)), int(sm.group(2)),
                      extract_usage(read_capped(path, head, tail))))

    rows = []
    for ts, pid, reqn, usage in resps:
        info = pick_request(reqs.get((pid, reqn)), ts)
        if info is None:
            continue
        rows.append((info, usage))
    stats = {"billing_total": billing_total, "billing_found": billing_found}
    return rows, unattributed, stats


def rollup(rows):
    per = defaultdict(lambda: {"n": 0, "in": 0, "out": 0, "cread": 0, "ccre": 0,
                               "main": 0, "subagent": 0, "unknown": 0, "cron": 0})
    for info, u in rows:
        key = f"{info['machine']}:{info['ws']}:{info['session']}"
        r = per[key]
        r["n"] += 1
        r["in"] += u["input_tokens"]
        r["out"] += u["output_tokens"]
        r["cread"] += u["cache_read_input_tokens"]
        r["ccre"] += u["cache_creation_input_tokens"]
        r["main" if info["sub"] is False else
          "subagent" if info["sub"] is True else "unknown"] += 1
        if info["cron"]:
            r["cron"] += 1
    return per


def to_markdown(per, hours, unattributed, stats):
    tot_out = sum(r["out"] for r in per.values())
    tot_n = sum(r["n"] for r in per.values())
    bt, bf = stats.get("billing_total", 0), stats.get("billing_found", 0)
    rate = f"{100.0 * bf / bt:.1f}%" if bt else "n/a"
    lines = [f"# Live consumption — {hours}h window",
             "",
             f"- sessions/rows: **{len(per)}**  ·  responses: **{tot_n}**  ·  OUT tokens: **{tot_out:,}**",
             f"- captures with an unparseable `user_id` (counted `unattributed`, never guessed): **{unattributed}**",
             f"- billing header found on **{bf}/{bt}** request captures (**{rate}**) — "
             f"below ~100% means the header fell outside both capped windows and "
             f"needed the chunked scan (or was not found at all)",
             "",
             "| machine:workspace:session | resp | in | out | cache_read | cache_cre | cron | main/sub/unk |",
             "|---|---:|---:|---:|---:|---:|---:|---|"]
    for key in sorted(per, key=lambda k: -per[k]["out"])[:40]:
        r = per[key]
        lines.append(f"| {key} | {r['n']} | {r['in']:,} | {r['out']:,} | "
                     f"{r['cread']:,} | {r['ccre']:,} | {r['cron']} | "
                     f"{r['main']}/{r['subagent']}/{r['unknown']} |")
    if len(per) > 40:
        lines.append(f"\n_top 40 of {len(per)} sessions shown, ordered by OUT tokens._")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("capture_dir", nargs="?", default=r"D:\claudish-captures")
    ap.add_argument("--hours", type=float, default=3.0)
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--md", dest="md_out")
    args = ap.parse_args(argv)
    rows, unattributed, stats = collect(args.capture_dir, args.hours)
    per = rollup(rows)
    md = to_markdown(per, args.hours, unattributed, stats)
    print(md)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"hours": args.hours, "unattributed": unattributed,
                       "billing_total": stats["billing_total"],
                       "billing_found": stats["billing_found"],
                       "sessions": per}, f, indent=2, sort_keys=True)
    if args.md_out:
        with open(args.md_out, "w", encoding="utf-8") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
