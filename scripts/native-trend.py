#!/usr/bin/env python3
"""Native-consumption TREND across days — "did the cost per turn drift?"

Companion to native-consumption.py (the snapshot). Compares whole days on
the native (Anthropic-billed) lane and decomposes billed output into
normal responses vs compaction summaries, so a credit spike is attributed
to volume (more requests), weight (fatter responses), or churn (more
compactions) instead of guessed at.

    python scripts/native-trend.py --days 2026-08-16 2026-09-06 2026-09-12
        [--archives-dir "G:\\Mon Drive\\Backups-Cloud\\claudish"]
        [--loose-dir D:\\claudish-captures] [--loose-date 2026-09-13]
        [--7z "C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\7z.exe"]

Traps, each of which yields a wrong-but-plausible trend line:

  1. Archives hold EVERY lane. Extract only "resp-*-native-*.sse" —
     counting all resps mixes the budget lane in and halves every
     per-request figure.
  2. The loose capture dir also holds every lane AND several days:
     filter on "-native-" in the name AND the date prefix.
  3. A loose day is PARTIAL (today is still happening) and archives are
     full days — never put them in the same column without a marker.
  4. Compaction summaries are the expensive tail: detect them by the
     response's concatenated text starting with "<analysis>". A single
     summary is ~10-15k output tokens; 50->110/day is a x2 credit drift
     by itself.
  5. Text arrives as MANY small streaming deltas. Aggregate per response
     BEFORE any per-block filter — no single delta exceeds a few hundred
     chars, so "no block > 800 chars" measures nothing.
  6. output_tokens comes from message_delta LAST occurrence (cumulative);
     input/cache fields from message_start FIRST occurrence.
  7. Normal-response medians move when compactions are included: split
     first, then compute p50/p90 on the normal set only.
  8. Context size (in_frais + cache_read + cache_creation) and the cache
     hit ratio are the control columns: if they are flat while OUT/req
     doubles, the drift is in what the model WRITES, not what it reads.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile

U_OUT = re.compile(r'"output_tokens":\s*(\d+)')
U_IN = re.compile(r'"input_tokens":\s*(\d+)')
U_CR = re.compile(r'"cache_read_input_tokens":\s*(\d+)')
U_CC = re.compile(r'"cache_creation_input_tokens":\s*(\d+)')
TX_D = re.compile(r'"text":\s*"((?:[^"\\]|\\.)*)"')


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", nargs="+", required=True,
                    help="archive dates YYYY-MM-DD, in order")
    ap.add_argument("--archives-dir", default=r"G:\Mon Drive\Backups-Cloud\claudish")
    ap.add_argument("--loose-dir", default="")
    ap.add_argument("--loose-date", default="",
                    help="add the (partial) loose day from --loose-dir")
    # dest= is mandatory: argparse derives the attribute from the leading
    # option name, and "7z" is not a valid Python identifier — without the
    # explicit dest, day_dir()'s `a.seven_z` raised AttributeError the first
    # time it actually had to extract (it never fired while the nat-* dirs
    # pre-existed).
    ap.add_argument("--7z", dest="seven_z",
                    default=r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe")
    ap.add_argument("--keep", action="store_true",
                    help="keep extracted day dirs (default: temp, deleted)")
    return ap.parse_args()


def day_dir(day, a, root):
    d = os.path.join(root, "nat-" + day)
    if os.path.isdir(d) and any(f.endswith(".sse") for f in os.listdir(d)):
        return d
    archive = os.path.join(a.archives_dir, "captures-%s.7z" % day)
    if not os.path.isfile(archive):
        print("archive absente: %s" % archive, file=sys.stderr)
        return None
    os.makedirs(d, exist_ok=True)
    subprocess.run([a.seven_z, "x", archive, "-o" + d,
                    "resp-*-native-*.sse", "-y"],
                   check=True, stdout=subprocess.DEVNULL)
    return d


def stats(dirpath, day, prefixes, partial):
    rows = []
    for e in os.scandir(dirpath):
        n = e.name
        if not n.endswith(".sse") or "-native-" not in n:
            continue
        if not any(p in n for p in prefixes):
            continue
        rt = open(e.path, encoding="utf-8", errors="replace").read()
        m = U_OUT.findall(rt)
        if not m:
            continue
        txt = "".join(TX_D.findall(rt))
        i = U_IN.findall(rt)
        cr = U_CR.findall(rt)
        cc = U_CC.findall(rt)
        rows.append({
            "out": int(m[-1]),
            "txt": txt,
            "in": int(i[0]) if i else 0,
            "cr": int(cr[0]) if cr else 0,
            "cc": int(cc[0]) if cc else 0,
        })
    if not rows:
        return None
    comp = [r for r in rows if r["txt"].lstrip().startswith("<analysis>")]
    norm = [r for r in rows if not r["txt"].lstrip().startswith("<analysis>")]
    norm_out = sorted(r["out"] for r in norm)
    nn = len(norm_out)
    tot_out = sum(r["out"] for r in rows)
    ctx = sum(r["in"] + r["cr"] + r["cc"] for r in rows)
    return {
        "label": day + (" (partiel)" if partial else ""),
        "partial": partial,
        "n": len(rows), "out": tot_out,
        "ctx": ctx // len(rows), "cr_pct": 100 * sum(r["cr"] for r in rows) // max(ctx, 1),
        "out_req": tot_out // len(rows),
        "p50": norm_out[nn // 2] if nn else 0,
        "p90": norm_out[int(nn * 0.9)] if nn else 0,
        "norm_avg": (tot_out - sum(r["out"] for r in comp)) // max(nn, 1),
        "n_comp": len(comp),
        "comp_out": sum(r["out"] for r in comp),
        "comp_avg": (sum(r["out"] for r in comp) // len(comp)) if comp else 0,
    }


def main():
    a = parse_args()
    root = os.getcwd() if a.keep else tempfile.mkdtemp(prefix="nat-trend-")
    prefixes = [(d, [d + "T%02d" % h for h in range(24)], False) for d in a.days]
    if a.loose_dir and a.loose_date:
        prefixes.append((a.loose_date, [a.loose_date + "T%02d" % h for h in range(24)], True))
    results = []
    for day, pfx, partial in prefixes:
        if partial:
            d = a.loose_dir
        else:
            d = day_dir(day, a, root)
        if not d:
            continue
        s = stats(d, day, pfx, partial)
        if s:
            results.append(s)
    if len(results) < 2:
        print("moins de deux jours exploitables — rien à comparer", file=sys.stderr)
        return 1
    print(f"{'jour':16s} {'n':>5s} {'OUT/jour':>10s} {'OUT/req':>8s} {'p50':>6s} "
          f"{'p90':>6s} {'moyNorm':>8s} {'compact':>8s} {'OUTcomp':>9s} {'moyComp':>8s} "
          f"{'ctx/req':>8s} {'%cr':>4s}")
    base = results[0]
    for s in results:
        print(f"{s['label']:16s} {s['n']:5d} {s['out']:10,d} {s['out_req']:8,d} "
              f"{s['p50']:6,d} {s['p90']:6,d} {s['norm_avg']:8,d} "
              f"{s['n_comp']:4d} ({100*s['comp_out']//max(s['out'],1):2d}%) "
              f"{s['comp_out']:9,d} {s['comp_avg']:8,d} {s['ctx']:8,d} {s['cr_pct']:3d}%")
    fulls = [s for s in results if not s["partial"]]
    last = fulls[-1] if fulls else results[-1]
    print()
    print(f"delta {base['label']} -> {last['label']}: "
          f"n x{last['n']/max(base['n'],1):.2f}  OUT/jour x{last['out']/max(base['out'],1):.2f}  "
          f"OUT/req x{last['out_req']/max(base['out_req'],1):.2f}  "
          f"compactions x{last['n_comp']/max(base['n_comp'],1):.2f}")
    d_out = last["out"] - base["out"]
    d_comp = last["comp_out"] - base["comp_out"]
    print(f"  dont compactions: {d_comp:+,d} OUT ({100*d_comp//max(abs(d_out),1):d}% du delta) ; "
          f"réponses normales: {d_out-d_comp:+,d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
