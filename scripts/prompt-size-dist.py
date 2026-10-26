#!/usr/bin/env python3
r"""Prompt-size distribution per role and machine, from the hub's capture files.

Claudish #116 (allocation map) / #565 (context admission): the question "how big
are the requests this role actually sends" has to be answered from the REQUEST,
not from anything the proxy logged. Every capture under `--captures` is a JSON
envelope whose `body` is the prompt as the client sent it:

    {ts, src, machine, model, pid, device_id8, entrypoint, workload, hops,
     body: {model, messages, system, tools, metadata, max_tokens, ...}}

Prompt size = serialized `body` bytes = what the engine admits. Token estimate =
bytes / --bpt, with 3.75 the measured p50 bytes-per-token on the local engine
(1111-response sample, 2026-10; range 3.75-4.5 across providers — quote the band,
never a single token figure, when the number drives a decision).

WHY THIS INSTRUMENT EXISTS AS A SEPARATE, CAPTURE-ONLY TOOL
-----------------------------------------------------------
It is deliberately free of any `[Request]` -> `reqN` ordinal join. `reqN` is a
PER-PROCESS counter in the proxy: it restarts at 1 with the container process, so
an ordinal join spanning a container restart silently shifts every index and
returns pure noise — measured 2026-10-25, where a 24 h join across
`State.StartedAt = 2026-10-25T00:58:53Z` produced a false "33 % of haiku requests
have no `[ttft]`" (real figure on one process: 0.3 %) and a false served-model
split. Sizes come from the captures, which are per-request files: no ordinal, no
restart sensitivity. If you need SERVED attribution, anchor the log window at the
container start and assert `max(reqN) == count([Request])` before publishing.

Usage:
    python scripts/prompt-size-dist.py                          # all roles, all time
    python scripts/prompt-size-dist.py --role haiku             # one role family
    python scripts/prompt-size-dist.py --role haiku \
        --since 2026-10-26T09:00 --until 2026-10-26T11:00        # the vllm window
    python scripts/prompt-size-dist.py --role haiku --per-machine
    python scripts/prompt-size-dist.py --bpt 4.0 --captures /captures

Windows are compared on the capture `ts` string's first 16 chars, so both
`2026-10-26T09:00` and `2026-10-26T09:00:00Z` work; `--until` is exclusive.

WINDOW FILTERING HAPPENS ON THE FILENAME
---------------------------------------
The request timestamp is IN the filename, so a windowed run never opens an
out-of-window file — the difference between ~1 s and several minutes on a
directory holding tens of thousands of loose captures:

    req-<pid>-<reqN>-<YYYY-MM-DD>T<HH-MM-SS-mmm>Z-<src>.json

Regex trap (same one lane-matrix.py hit, keep it): the time segment carries a
MILLISECOND field, so its seconds part is `[\\d-]+`, never `\\d{2}-\\d{2}`. A
stricter pattern silently matches nothing and every window comes back empty.

THE ENVELOPE `ts` IS NOT ISO-8601
---------------------------------
`doc["ts"]` is written in the SAME dash form as the filename —
`2026-10-25T18-00-00-204Z`, not `18:00:00.204Z`. Comparing its first 16 chars
against a `YYYY-MM-DDTHH:MM` window therefore compares `18-00` to `18:00`, and
since `-` (0x2D) sorts before `:` (0x3A) every file falls BELOW `--since`: a
windowed run reports "all captures out of window" and zero requests, silently.
Measured 2026-10-25, and only because a fixture written in colon form passed while
the real corpus returned nothing. `norm_ts()` accepts both forms for that reason.
The filename stays the pre-filter; the envelope stays authoritative.
"""

import argparse
import collections
import json
import os
import re
import sys

DEFAULT_CAPTURES = os.environ.get("CLAUDISH_CAPTURE_HOST_DIR") or r"D:\claudish-captures"
DEFAULT_BPT = 3.75

BANDS = [
    (0, 50_000, "<50k"),
    (50_000, 100_000, "50-100k"),
    (100_000, 200_000, "100-200k"),
    (200_000, 330_000, "200-330k"),
    (330_000, 1_000_000_000, ">330k"),
]

# `req-<pid>-<reqN>-<YYYY-MM-DD>T<HH-MM-SS-mmm>Z-<src>.json` — milliseconds in the
# time segment, hence `[\d-]+` for seconds (see module docstring).
TS_IN_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})")

# Accepts BOTH the dash form the captures actually use (`2026-10-25T18-00-00-204Z`)
# and ISO colons (`2026-10-25T18:00:00.204Z`), on the filename and on the CLI alike.
TS_KEY = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2})[-:](\d{2})")


def norm_ts(value):
    """Normalize any timestamp spelling to the 16-char `YYYY-MM-DDTHH:MM` key."""
    if not value:
        return None
    m = TS_KEY.match(value.strip())
    return f"{m.group(1)}T{m.group(2)}:{m.group(3)}" if m else None


def name_ts(name):
    """Window key read from the filename, or None when the name carries no stamp."""
    m = TS_IN_NAME.search(name)
    return f"{m.group(1)}T{m.group(2)}:{m.group(3)}" if m else None


def pct(vals, p):
    vals = sorted(vals)
    if not vals:
        return 0
    k = max(0, min(len(vals) - 1, int(round(p / 100 * (len(vals) - 1)))))
    return vals[k]


def report(title, vals, bpt):
    n = len(vals)
    if not n:
        print(f"\n== {title}: n=0 ==")
        return
    toks = [v / bpt for v in vals]
    print(f"\n== {title}: n={n} ==")
    print(
        f"  bytes  p50={pct(vals, 50) / 1024:8.0f}K  p90={pct(vals, 90) / 1024:8.0f}K"
        f"  p99={pct(vals, 99) / 1024:8.0f}K  max={max(vals) / 1024:8.0f}K"
    )
    print(
        f"  ~tok   p50={pct(toks, 50) / 1000:8.1f}k  p90={pct(toks, 90) / 1000:8.1f}k"
        f"  p99={pct(toks, 99) / 1000:8.1f}k  max={max(toks) / 1000:8.1f}k"
    )
    cells = []
    for lo, hi, lab in BANDS:
        c = sum(1 for t in toks if lo <= t < hi)
        cells.append(f"{lab}: {c} ({100 * c // n}%)")
    print("  bands ~tok: " + " · ".join(cells))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--captures", default=DEFAULT_CAPTURES,
                    help=f"capture directory (default: {DEFAULT_CAPTURES})")
    ap.add_argument("--role", default=None,
                    help="substring match on the requested model (role alias or family), e.g. haiku")
    ap.add_argument("--since", default=None, help="inclusive lower bound, e.g. 2026-10-26T09:00")
    ap.add_argument("--until", default=None, help="exclusive upper bound")
    ap.add_argument("--bpt", type=float, default=DEFAULT_BPT,
                    help=f"bytes per token (default {DEFAULT_BPT})")
    ap.add_argument("--per-machine", action="store_true",
                    help="per-machine distributions and cron/interactive split")
    ap.add_argument("--top", type=int, default=12, help="max machines listed (default 12)")
    args = ap.parse_args(argv)

    since, until = norm_ts(args.since), norm_ts(args.until)
    if not os.path.isdir(args.captures):
        print(f"capture directory not found: {args.captures}", file=sys.stderr)
        return 2

    samples = []          # (machine, workload, requested model, body bytes)
    n_files = n_unreadable = n_no_ts = n_out_of_window = n_ts_mismatch = 0
    spellings = collections.Counter()

    with os.scandir(args.captures) as it:     # scandir: 33k+ loose files, no shell glob
        for entry in it:
            name = entry.name
            if not (name.startswith("req-") and name.endswith(".json")):
                continue
            n_files += 1
            # Pre-filter on the filename so a windowed run opens almost nothing.
            nkey = name_ts(name)
            if since or until:
                if nkey is None:
                    n_no_ts += 1          # fall through: the envelope decides
                elif (since and nkey < since) or (until and nkey >= until):
                    n_out_of_window += 1
                    continue
            try:
                with open(entry.path, "r", encoding="utf-8", errors="replace") as f:
                    doc = json.load(f)
            except Exception:
                n_unreadable += 1
                continue
            key = norm_ts(doc.get("ts"))
            if not key:
                n_no_ts += 1
                continue
            if (since and key < since) or (until and key >= until):
                n_out_of_window += 1
                continue
            if nkey and nkey != key:
                n_ts_mismatch += 1
            model = doc.get("model") or (doc.get("body") or {}).get("model") or ""
            if args.role and args.role.lower() not in model.lower():
                continue
            body = doc.get("body") or {}
            size = len(json.dumps(body, ensure_ascii=False).encode("utf-8", "replace"))
            samples.append((doc.get("machine") or "?", doc.get("workload") or "?",
                            model, size))
            spellings[model] += 1

    window = f"{since or '-'} .. {until or '(now]'}"
    role = args.role or "(all roles)"
    print(f"captures scanned: {n_files}  (out of window {n_out_of_window},"
          f" unreadable {n_unreadable}, no ts {n_no_ts})")
    if n_ts_mismatch:
        print(f"  WARN filename/envelope timestamp disagreements: {n_ts_mismatch}"
              f" (envelope used)")
    print(f"role: {role}   window: {window}   bpt: {args.bpt}")
    print(f"requests selected: {len(samples)}")

    if not samples:
        return 0

    by_machine = collections.Counter((m, w) for m, w, _, _ in samples)
    print("\n-- volume machine x workload --")
    for (m, w), c in sorted(by_machine.items(), key=lambda kv: -kv[1])[:args.top]:
        print(f"  {m:16s} {w:12s} {c:6d}")

    if args.per_machine:
        print("\n-- per-machine distribution --")
        machines = [m for m, _ in collections.Counter(m for m, _, _, _ in samples).most_common(args.top)]
        for m in machines:
            vals = [s for mm, _, _, s in samples if mm == m]
            report(m, vals, args.bpt)
            cron = [s for mm, w, _, s in samples if mm == m and w == "cron"]
            inter = [s for mm, w, _, s in samples if mm == m and w != "cron"]
            for lab, sub in (("cron", cron), ("intr", inter)):
                if sub:
                    toks = [v / args.bpt for v in sub]
                    print(f"    {lab} n={len(sub):5d} ~tok p50={pct(toks, 50) / 1000:6.1f}k"
                          f" p90={pct(toks, 90) / 1000:6.1f}k max={max(toks) / 1000:6.1f}k")

    report(f"FLEET {role}", [s for _, _, _, s in samples], args.bpt)

    print("\n-- requested model spellings --")
    for mo, c in spellings.most_common(10):
        print(f"  {mo:30s} {c:6d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
