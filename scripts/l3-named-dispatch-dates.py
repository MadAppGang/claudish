#!/usr/bin/env python3
"""L3 (#328) — day-by-day dating of the fall of NAMED dispatches, CoursIA.

Instrument (reproducible, read-only):
  * source = the CoursIA workspace dashboard CONDENSATION archives
    (`<shared>/dashboards/archive/workspace-CoursIA-YYYY-MM-DDThh-mm-ss.md`).
    Each archive holds a disjoint slice of the intercom; together they hold the
    whole history once (a condensation archives the OLDEST messages).
  * a message block = `### [<iso>] <author>|<workspace>` + body until the next
    header.
  * a "named dispatch" = a message whose author is the coordinator lane
    (`myia-ai-01` / `ai-01`) and whose body cites at least one `#<number>`
    (an issue or a PR) AND carries a dispatch verb. Both looser series are
    printed too, so the reader can see whether a fall is in VOLUME or in
    NAMING.

Output: CSV (one row per day) on stdout as a summary table + full CSV path.
Read-only on the archive: nothing is written there.
"""
import glob
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta

ARCHIVE_DIR = r"G:\Mon Drive\Synchronisation\RooSync\.shared-state\dashboards\archive"
PATTERN = os.path.join(ARCHIVE_DIR, "workspace-CoursIA-2026-[01][0-9]-*.md")

HDR = re.compile(r"^### \[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] (\S+)\|(\S*)\s*$")
NUMBER = re.compile(r"#\d{2,}")
DISPATCH = re.compile(
    r"\b(dispatch|dispatch[cé]|prends|prendre|à toi|a toi|lane|worker|grain|grains|assigne|drive|file d'attente|deep[- ]queue)\b",
    re.IGNORECASE,
)
COORD_AUTHORS = {"myia-ai-01", "ai-01"}


def parse(path):
    """Yield (timestamp, author, body) for each message block in one archive."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.read().split("\n")
    cur = None
    buf = []
    for line in lines:
        m = HDR.match(line)
        if m:
            if cur:
                yield cur[0], cur[1], "\n".join(buf)
            iso = m.group(1)
            try:
                ts = datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
            except ValueError:
                ts = None
            cur = (ts, m.group(2))
            buf = []
        elif cur is not None:
            buf.append(line)
    if cur:
        yield cur[0], cur[1], "\n".join(buf)


def main():
    files = sorted(glob.glob(PATTERN))
    if not files:
        print(f"NO ARCHIVE FILES MATCHED {PATTERN}", file=sys.stderr)
        return 1

    per_day = defaultdict(lambda: {"all": 0, "coord": 0, "coord_named": 0, "coord_named_dispatch": 0})
    seen = set()  # (ts, author, first 120 chars) — condensation can repeat a body
    dup = 0

    for path in files:
        for ts, author, body in parse(path):
            if ts is None:
                continue
            key = (ts, author, body.strip()[:120])
            if key in seen:
                dup += 1
                continue
            seen.add(key)
            d = ts.date()
            row = per_day[d]
            row["all"] += 1
            if author in COORD_AUTHORS:
                row["coord"] += 1
                named = bool(NUMBER.search(body))
                if named:
                    row["coord_named"] += 1
                    if DISPATCH.search(body):
                        row["coord_named_dispatch"] += 1

    start, end = date(2026, 7, 6), date(2026, 10, 24)
    out_csv = os.path.join(os.path.dirname(os.path.abspath(__file__)), "l3-dispatch-days.csv")
    with open(out_csv, "w", encoding="utf-8", newline="") as fh:
        fh.write("date,msgs_all,coord_msgs,coord_named,coord_named_dispatch\n")
        d = start
        while d <= end:
            r = per_day.get(d)
            if r:
                fh.write(f"{d.isoformat()},{r['all']},{r['coord']},{r['coord_named']},{r['coord_named_dispatch']}\n")
            else:
                fh.write(f"{d.isoformat()},,,,, \n".replace(", \n", "\n"))
            d += timedelta(days=1)

    print(f"files={len(files)} distinct_messages={len(seen)} duplicates_skipped={dup}")
    print(f"csv={out_csv}")
    print("\nL3 window 13/07 -> 15/08 — day by day")
    print("date        msgs  coord  named  named+dispatch")
    d = date(2026, 7, 13)
    while d <= date(2026, 8, 15):
        r = per_day.get(d, {"all": 0, "coord": 0, "coord_named": 0, "coord_named_dispatch": 0})
        print(f"{d.isoformat()}  {r['all']:5d}  {r['coord']:5d}  {r['coord_named']:5d}  {r['coord_named_dispatch']:5d}")
        d += timedelta(days=1)

    # weekly rollup for the trend
    print("\nweekly rollup (Mon-Sun)")
    d = date(2026, 7, 6)
    while d <= date(2026, 10, 21):
        tot = [0, 0, 0, 0]
        for k in range(7):
            r = per_day.get(d + timedelta(days=k))
            if r:
                for i, f in enumerate(("all", "coord", "coord_named", "coord_named_dispatch")):
                    tot[i] += r[f]
        print(f"{d.isoformat()}  msgs={tot[0]:5d} coord={tot[1]:4d} named={tot[2]:4d} named+disp={tot[3]:4d}")
        d += timedelta(days=7)

    print("\nmonthly rollup")
    for ym in ((2026, 7), (2026, 8), (2026, 9), (2026, 10)):
        tot = [0, 0, 0, 0]
        days = 0
        d = date(ym[0], ym[1], 1)
        while d.month == ym[1]:
            r = per_day.get(d)
            if r:
                days += 1
                for i, f in enumerate(("all", "coord", "coord_named", "coord_named_dispatch")):
                    tot[i] += r[f]
            d += timedelta(days=1)
        per = lambda v: f"{v/days:5.1f}" if days else "  n/a"
        print(f"{ym[0]}-{ym[1]:02d}  days_with_traffic={days:2d}  msgs/day={per(tot[0])}  coord/day={per(tot[1])}  named/day={per(tot[2])}  named+disp/day={per(tot[3])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
