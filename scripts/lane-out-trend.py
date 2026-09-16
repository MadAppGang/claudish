#!/usr/bin/env python3
"""All-lane OUT-token trend — "how many tokens do we GENERATE, per lane, per day?"

Generalizes native-trend.py beyond the native lane: the user's productivity
metric is tokens generated per merged PR, fleet-wide — not $ extrapolated from
the PAYG overflow (subscriptions OpenAI/Kimi/Qwen/Mistral invalidate any such
extrapolation; the PAYG is the overflow, not the spend).

    python scripts/lane-out-trend.py --days 2026-07-09 2026-07-16 2026-09-12
        [--archives-dir "G:\\Mon Drive\\Backups-Cloud\\claudish"]
        [--7z "C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\7z.exe"]

Every resp-*.sse capture is Anthropic-wire regardless of upstream provider
(captures sit downstream of translation), so one set of usage regexes covers
all lanes. Files with no usage block are counted separately, never dropped
silently (the Sol lane had partial usage until #117).

Lane groups are imported from fleet-dashboard.py — one shared definition, no
drift between the two scripts.

Heavier than native-trend (~30k resp/day vs ~2-5k native): run off-peak.
"""
import argparse
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict

NAME_RX = re.compile(
    r"resp-\S+?-(\d{4}-\d{2}-\d{2})T\d{2}[\d-]+Z-(\w+)-(.+)\.sse$"
)
U_OUT = re.compile(r'"output_tokens":\s*(\d+)')
U_IN = re.compile(r'"input_tokens":\s*(\d+)')
U_CR = re.compile(r'"cache_read_input_tokens":\s*(\d+)')


def load_groups():
    """Import LANE_GROUPS/group_of from fleet-dashboard.py (dashed filename:
    not importable as a module name — spec_from_file_location it)."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "fleet_dashboard", os.path.join(here, "fleet-dashboard.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.LANE_GROUPS, mod.group_of


def day_dir(day, a, root):
    d = os.path.join(root, "all-" + day)
    archive = os.path.join(a.archives_dir, "captures-%s.7z" % day)
    if not os.path.isfile(archive):
        print("archive absente: %s" % archive, file=sys.stderr)
        return None
    os.makedirs(d, exist_ok=True)
    subprocess.run([a.seven_z, "x", archive, "-o" + d, "resp-*.sse", "-y"],
                   check=True, stdout=subprocess.DEVNULL)
    return d


def stats(dirpath):
    per = defaultdict(lambda: {"n": 0, "out": 0, "in": 0, "cr": 0, "no_usage": 0})
    for e in os.scandir(dirpath):
        n = e.name
        if not n.endswith(".sse"):
            continue
        m = NAME_RX.search(n)
        if not m:
            continue
        _, handler, model = m.groups()
        g = group_of(handler, model)
        row = per[g]
        row["n"] += 1
        try:
            rt = open(e.path, encoding="utf-8", errors="replace").read()
        except OSError:
            row["no_usage"] += 1
            continue
        mo = U_OUT.findall(rt)
        if not mo:
            row["no_usage"] += 1
            continue
        row["out"] += int(mo[-1])
        mi = U_IN.findall(rt)
        row["in"] += int(mi[0]) if mi else 0
        mr = U_CR.findall(rt)
        row["cr"] += int(mr[0]) if mr else 0
    return per


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", nargs="+", required=True)
    ap.add_argument("--archives-dir", default=r"G:\Mon Drive\Backups-Cloud\claudish")
    ap.add_argument("--7z", dest="seven_z",
                    default=r"C:\Program Files\NVIDIA Corporation\NVIDIA App\7z.exe")
    ap.add_argument("--keep", action="store_true")
    return ap.parse_args()


def main():
    global LANE_GROUPS, group_of
    a = parse_args()
    LANE_GROUPS, group_of = load_groups()
    root = os.getcwd() if a.keep else tempfile.mkdtemp(prefix="lane-out-")
    results = []
    for day in a.days:
        d = day_dir(day, a, root)
        if not d:
            continue
        per = stats(d)
        if not per:
            print(f"{day}: aucune capture resp-*", file=sys.stderr)
            continue
        results.append((day, per))
        print(f"  {day}: {sum(v['n'] for v in per.values()):,} resp lues", file=sys.stderr)
    if not results:
        return 1

    groups = [name for name, _, _ in LANE_GROUPS]
    print(f"{'jour':12s} {'OUT total':>11s} {'resp':>7s} {'OUT/resp':>9s}  "
          + " ".join(f"{g[:9]:>10s}" for g in groups) + f" {'sansUsage':>9s}")
    for day, per in results:
        tot_out = sum(v["out"] for v in per.values())
        tot_n = sum(v["n"] for v in per.values())
        no_u = sum(v["no_usage"] for v in per.values())
        cells = " ".join(
            f"{per[g]['out']:>10,d}" if per[g]["n"] else f"{'':>10s}"
            for g in groups)
        print(f"{day:12s} {tot_out:>11,d} {tot_n:>7,d} {tot_out // max(tot_n,1):>9,d}  "
              f"{cells} {no_u:>9,d}")
    if len(results) >= 2:
        (d0, p0), (d1, p1) = results[0], results[-1]
        o0 = sum(v["out"] for v in p0.values())
        o1 = sum(v["out"] for v in p1.values())
        print()
        print(f"delta {d0} -> {d1}: OUT total x{o1 / max(o0, 1):.2f}")
        for g in groups:
            if p0[g]["out"] and p1[g]["out"]:
                print(f"  {g:16s} OUT {p0[g]['out']:>10,d} -> {p1[g]['out']:>10,d}  "
                      f"(x{p1[g]['out'] / p0[g]['out']:.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
