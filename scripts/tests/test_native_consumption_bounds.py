#!/usr/bin/env python3
r"""Pins for native-consumption.py --since/--until bound parsing.

Origin (queue 2026-10-16, grain 5): `--since 2026-10-15T23:00:00Z` — the
shape a human naturally types after reading a dashboard timestamp — died in
a strptime traceback ("unconverted data remains: :00:00Z00"). The canonical
capture-stamp shape YYYY-MM-DDTHH must keep working unchanged, full ISO
shapes are accepted and truncated to the hour (bounds are hour-granular by
design), and anything else exits with a clean one-line message instead of a
traceback.

Each rejected shape carries the reason it was plausible: "+02:00" is a
timezone offset (bounds are UTC-only, an offset silently read as garbage),
"T2" a single-digit hour, "hier" prose. Positive controls: the accepted
shapes must all land on the SAME datetime, and --until's minute extension
("59") must survive the truncation (until is exclusive at hour granularity
so the last minute of the hour is in-bounds).

Run standalone:  python scripts/tests/test_native_consumption_bounds.py
Or under pytest: pytest scripts/tests/test_native_consumption_bounds.py
"""

import importlib.util
import os
from datetime import datetime

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "native_consumption", os.path.join(_HERE, "..", "native-consumption.py"))
nc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(nc)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def main():
    canonical = datetime(2026, 10, 15, 23, 0)
    for shape in ("2026-10-15T23",            # canonical capture-stamp shape
                  "2026-10-15T23:00",         # ISO minutes
                  "2026-10-15T23:00:00",      # ISO seconds
                  "2026-10-15T23:00:00Z",     # ISO seconds, UTC marker
                  "2026-10-15T23:00:00z"):    # lowercase z (dashboards vary)
        got = nc.fname_dt(shape, "00")
        check(f"accept {shape!r} -> {canonical}", got == canonical,
              f"got {got}")

    check("date-only defaults to hour 00",
          nc.fname_dt("2026-10-15", "00") == datetime(2026, 10, 15, 0, 0))
    check("until keeps minute extension under truncation",
          nc.fname_dt("2026-10-15T23:59:59Z", "59")
          == datetime(2026, 10, 15, 23, 59))
    check("canonical --until unchanged (regression)",
          nc.fname_dt("2026-10-15T23", "59")
          == datetime(2026, 10, 15, 23, 59))

    for bad, why in (("2026-10-15T23:00:00+02:00", "tz offset"),
                     ("2026-10-15T2", "single-digit hour"),
                     ("hier", "prose"),
                     ("2026-13-45T99", "out-of-range digits")):
        try:
            nc.fname_dt(bad, "00")
        except SystemExit as e:
            check(f"reject {bad!r} ({why}) cleanly",
                  "unparseable" in str(e) and "Traceback" not in str(e))
        except ValueError:
            check(f"reject {bad!r} ({why}) cleanly", False,
                  "leaked ValueError traceback shape")
        else:
            check(f"reject {bad!r} ({why}) cleanly", False, "accepted")

    print()
    if FAILS:
        print(f"FAIL: {len(FAILS)} check(s) failed: {', '.join(FAILS)}")
        raise SystemExit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
