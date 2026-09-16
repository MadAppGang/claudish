#!/usr/bin/env python3
r"""Lane x day response series from capture archives -> sqlite store.

Epic claudish #116, phase P1. Builds the multi-lane time series that the
consumption dashboard (P2) reads, from the daily `captures-YYYY-MM-DD.7z`
GDrive archives plus the current loose day — WITHOUT decompressing anything:
the response timestamp, handler and model are all in the capture filename.

Filename contract (measured 2026-09-16):
    resp-<instance>-r<reqN>-<YYYY-MM-DD>T<HH-MM-SS-mmm>Z-<handler>-<model>.sse
The machine id is NOT in the filename — it lives in the paired `req-*` envelope
(native-consumption.py already attributes machines that way for the native
lane). This organ counts lanes only.

Regex trap (bit us once, keep): the timestamp carries a millisecond field
(`T06-18-15-927Z`), so the seconds part must be `[\d-]+`, never `\d{2}-\d{2}`.
A stricter pattern silently yields zero counts on every file.

Series semantics follow the `claudish_traffic` MCP tool contract
(roo-extensions, mcps/internal/servers/roo-state-manager/src/tools/claudish-traffic.ts):
day/hour buckets over all lanes, a quiet-but-present day is a zero row (not an
absent row), and "no archive for that day" is recorded as such in `days`.

Store schema:
    responses(day, hour, handler, model, n)   -- PRIMARY KEY (day,hour,handler,model)
    days(day, source, files, resp_files, ingested_at)
Every archive file present in --archives-dir gets a `days` row even with zero
resp-* members, so "archive present + zero responses" (lane outage) stays
distinguishable from "archive missing" (collection gap).

Usage:
    python scripts/lane-matrix.py                       # ingest all new archive days
    python scripts/lane-matrix.py --loose-date 2026-09-16   # + current loose day
    python scripts/lane-matrix.py --refresh --days 2026-09-13
    python scripts/lane-matrix.py --csv matrix.csv       # full export, all lanes
"""

import argparse
import csv
import glob
import os
import re
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone

SEVENZ_CANDIDATES = [
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe",
]

NAME_RX = re.compile(
    r"resp-\S+?-(\d{4}-\d{2}-\d{2})T(\d{2})[\d-]+Z-(\w+)-(.+)\.sse$"
)


def find_7z():
    for cand in SEVENZ_CANDIDATES:
        if os.path.exists(cand):
            return cand
    sys.exit("7z.exe not found in: " + " | ".join(SEVENZ_CANDIDATES))


def archive_days(archives_dir):
    out = {}
    for path in glob.glob(os.path.join(archives_dir, "captures-*.7z")):
        m = re.search(r"captures-(\d{4}-\d{2}-\d{2})\.7z$", path)
        if m:
            out[m.group(1)] = path
    return out


def list_archive_members(sevenz, path):
    proc = subprocess.run([sevenz, "l", "-ba", path], capture_output=True, text=True)
    return proc.stdout.splitlines()


def parse_listing(lines):
    """(day, hour, handler, model) -> count, plus total resp-* file count."""
    counts = defaultdict(int)
    resp_files = 0
    for line in lines:
        if "resp-" not in line:
            continue
        m = NAME_RX.search(line)
        if not m:
            continue
        day, hour, handler, model = m.groups()
        counts[(day, int(hour), handler, model)] += 1
        resp_files += 1
    return counts, resp_files


def parse_loose(loose_dir, loose_date):
    counts = defaultdict(int)
    resp_files = 0
    for path in glob.glob(os.path.join(loose_dir, "resp-*.sse")):
        m = NAME_RX.search(os.path.basename(path))
        if not m:
            continue
        day, hour, handler, model = m.groups()
        if day != loose_date:
            continue
        counts[(day, int(hour), handler, model)] += 1
        resp_files += 1
    return counts, resp_files


def init_store(store_path):
    conn = sqlite3.connect(store_path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS responses (
            day TEXT NOT NULL,
            hour INTEGER NOT NULL,
            handler TEXT NOT NULL,
            model TEXT NOT NULL,
            n INTEGER NOT NULL,
            PRIMARY KEY (day, hour, handler, model)
        );
        CREATE TABLE IF NOT EXISTS days (
            day TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            files INTEGER NOT NULL,
            resp_files INTEGER NOT NULL,
            ingested_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    return conn


def ingest_day(conn, day, source, files, counts, resp_files):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with conn:
        conn.execute("DELETE FROM responses WHERE day = ?", (day,))
        conn.execute(
            "INSERT OR REPLACE INTO days VALUES (?,?,?,?,?)",
            (day, source, files, resp_files, now),
        )
        conn.executemany(
            "INSERT INTO responses VALUES (?,?,?,?,?)",
            [(d, h, hd, mo, n) for (d, h, hd, mo), n in counts.items()],
        )


def known_days(conn):
    return {row[0]: row[1] for row in conn.execute("SELECT day, source FROM days")}


def print_matrix(conn, top):
    rows = conn.execute(
        "SELECT day, handler, model, SUM(n) FROM responses GROUP BY day, handler, model"
    ).fetchall()
    lane_totals = defaultdict(int)
    by_day = defaultdict(dict)
    day_total = defaultdict(int)
    for day, handler, model, n in rows:
        lane = f"{handler}|{model}"
        lane_totals[lane] += n
        by_day[lane][day] = by_day[lane].get(day, 0) + n
        day_total[day] += n
    days = sorted(day_total)
    if not days:
        print("(store vide)")
        return
    lanes = sorted(lane_totals, key=lane_totals.get, reverse=True)[:top]

    w = max(len(d) for d in days) + 1
    header = "lane".ljust(max(28, w)) + "".join(d[5:].rjust(8) for d in days)
    print(header)
    print("-" * len(header))
    for lane in lanes:
        cells = "".join(str(by_day[lane].get(d, 0)).rjust(8) for d in days)
        print(lane[: 28 - 1].ljust(max(28, w)) + cells)
    print("-" * len(header))
    print("TOTAL".ljust(max(28, w)) + "".join(str(day_total[d]).rjust(8) for d in days))

    n_days = conn.execute("SELECT COUNT(*) FROM days").fetchone()[0]
    gaps = conn.execute(
        "SELECT COUNT(*) FROM days WHERE resp_files = 0"
    ).fetchone()[0]
    print(
        f"\n{len(days)} jours avec réponses · {n_days} jours ingérés · "
        f"{gaps} jour(s) archive-présente-zéro-réponse · "
        f"{len(lane_totals)} lanes distinctes (top {top} affichées)"
    )


def export_csv(conn, path):
    rows = conn.execute(
        "SELECT day, handler, model, SUM(n) FROM responses "
        "GROUP BY day, handler, model ORDER BY day, 4 DESC"
    ).fetchall()
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["day", "handler", "model", "responses"])
        w.writerows(rows)
    print(f"CSV écrit: {path} ({len(rows)} lignes)")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--archives-dir", default=r"G:\Mon Drive\Backups-Cloud\claudish")
    ap.add_argument("--store", default=r"D:\claudish-captures\lane-series.sqlite")
    ap.add_argument("--loose-dir", default=r"D:\claudish-captures")
    ap.add_argument(
        "--loose-date",
        help="ingest loose resp-* files whose date matches YYYY-MM-DD "
        "(the not-yet-archived current day); replaces any previous rows "
        "for that day, so re-running as the day grows is safe",
    )
    ap.add_argument(
        "--days",
        nargs="+",
        metavar="YYYY-MM-DD",
        help="restrict archive ingestion to these days (list, NOT a range)",
    )
    ap.add_argument("--refresh", action="store_true", help="re-ingest known days")
    ap.add_argument("--top", type=int, default=12, help="lanes shown in matrix")
    ap.add_argument("--csv", help="export full day x lane matrix to CSV")
    args = ap.parse_args()

    sevenz = find_7z()
    conn = init_store(args.store)
    known = known_days(conn)
    t0 = time.time()

    if args.days:
        wanted = set(args.days)
    else:
        wanted = None

    ingested, skipped = 0, 0
    for day, path in sorted(archive_days(args.archives_dir).items()):
        if wanted is not None and day not in wanted:
            continue
        if day in known and not args.refresh:
            skipped += 1
            continue
        lines = list_archive_members(sevenz, path)
        n_members = sum(1 for ln in lines if ln.strip())
        counts, resp_files = parse_listing(lines)
        ingest_day(conn, day, f"archive:{os.path.basename(path)}", n_members, counts, resp_files)
        ingested += 1

    if args.loose_date:
        counts, resp_files = parse_loose(args.loose_dir, args.loose_date)
        n_loose = len(glob.glob(os.path.join(args.loose_dir, "resp-*.sse")))
        ingest_day(conn, args.loose_date, f"loose:{args.loose_dir}", n_loose, counts, resp_files)
        ingested += 1

    conn.commit()
    print(
        f"ingérés: {ingested} · déjà connus (skipped): {skipped} · "
        f"{time.time() - t0:.1f}s · store: {args.store}"
    )
    print()
    print_matrix(conn, args.top)
    if args.csv:
        export_csv(conn, args.csv)
    conn.close()


if __name__ == "__main__":
    main()
