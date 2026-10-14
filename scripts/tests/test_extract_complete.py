#!/usr/bin/env python3
"""Pins for extract_complete() -- the extraction-completeness guard.

Measured incident (2026-07-05, hub po-2025): a 7z run killed by a vanishing
archive device (G: DriveFS unmount) left comp-2026-07-05/ holding every
req-*.json and zero resp-*.sse. The old guard `os.path.isdir(d) and
os.listdir(d)` accepted that dir as a finished extraction, and the #445 B1
census printed an EMPTY table for a day whose archive holds 10,498
responses -- a silent undercount on a measurement instrument.

The first guard generation (77a96b10) fell back to both member patterns for
unmarked dirs; the review showed that fallback re-opens the hole at the most
likely kill point: 7z writes the .json members before the .sse ones, which
carry most of the bytes, so a killed extraction more often holds ALL req and
SOME resp (bloquant 1). Unmarked now means RE-EXTRACT; the fallback survives
only behind --trust-unmarked, one stderr line per dir accepted. For the
targeted-extraction carrier (minimax-chain-measure), the marker names its
spec {since, until, model} and a marker for another target is a miss
(bloquant 2).

Pinned here, for BOTH carriers (compaction-trend.day_dir path and
minimax-chain-measure.extract_archives path -- the predicate must not drift
between the two copies):

  1. THE INCIDENT SHAPE -- req-only partial dir: False (the pin the old
     guard fails).
  2. THE OTHER KILL SHAPE -- all req + SOME resp, no marker: False (the pin
     77a96b10's both-patterns fallback failed).
  3. both member patterns, no marker, strict default: False (re-extract).
  4. empty dir: False;  missing dir: False.
  5. marker only (a clean extraction whose target set was empty): True --
     the marker is the strong signal, written only after a clean exit.
  6. both patterns + trust_unmarked: True; req-only + trust_unmarked: False
     (no resp at all is never plausible). A partial mid-resp kill IS accepted
     under trust_unmarked -- that best-effort limit is the documented price
     of the flag, made visible by its stderr line per accepted dir.
  7. minimax carrier only -- marker of ANOTHER spec: False; marker of the
     SAME spec: True; spec asked over an (old) empty marker: False.

Mutation proofs (run before pushing): restore `isdir and listdir` in either
carrier -> pins 1/2 red; restore the unconditional both-patterns fallback ->
pin 3 red.

Run standalone (no pytest needed):
  python scripts/tests/test_extract_complete.py
Or under pytest:
  pytest scripts/tests/test_extract_complete.py
"""

import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CARRIERS = [
    ("compaction-trend", load("_ct", os.path.join(SCRIPTS, "compaction-trend.py"))),
    ("minimax-chain-measure",
     load("_mcm", os.path.join(SCRIPTS, "minimax-chain-measure.py"))),
]

REQ = "req-1-1-2026-07-05T10-00-00-000Z-direct.json"
RESP = "resp-1-r1-2026-07-05T10-00-01-000Z-openai-x.sse"
RESP2 = "resp-1-r2-2026-07-05T10-00-02-000Z-openai-x.sse"

SPEC_A = {"since": "2026-10-01T00:00:00+00:00",
          "until": "2026-10-02T00:00:00+00:00", "model": "MiniMax"}
SPEC_B = {"since": "2026-10-03T00:00:00+00:00",
          "until": "2026-10-04T00:00:00+00:00", "model": "MiniMax"}


def mk(root, name, files):
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    for f in files:
        open(os.path.join(d, f), "w").close()
    return d


def mk_spec(root, name, spec):
    d = mk(root, name, [])
    with open(os.path.join(d, ".extract-complete"), "w", encoding="utf-8") as f:
        if spec is not None:
            json.dump(spec, f)
    return d


def main():
    root = tempfile.mkdtemp(prefix="extract-complete-")
    reqonly = mk(root, "reqonly", [REQ])
    someresp = mk(root, "someresp", [REQ, RESP])       # all req, SOME resp
    both = mk(root, "both", [REQ, RESP, RESP2])
    empty = mk(root, "empty", [])
    absent = os.path.join(root, "absent")
    marked = mk_spec(root, "marked", None)             # empty marker (legacy)
    marked_a = mk_spec(root, "marked-a", SPEC_A)
    marked_b = mk_spec(root, "marked-b", SPEC_B)

    fails = 0

    def check(label, verdicts, want):
        nonlocal fails
        ok = all(v == want for v in verdicts.values())
        fails += 0 if ok else 1
        shown = (list(verdicts.values())[0]
                 if len(set(verdicts.values())) == 1 else verdicts)
        print("  %-48s %s %s" % (label, shown,
                                 "OK" if ok else "FAIL (want %s)" % want))

    # strict default, both carriers
    strict_cases = [
        ("req-only partial (2026-07-05 incident)", reqonly, False),
        ("all req + SOME resp, no marker (mid-resp kill)", someresp, False),
        ("both patterns, no marker, strict default", both, False),
        ("empty", empty, False),
        ("missing", absent, False),
        ("marker only (clean exit, empty target set)", marked, True),
    ]
    print("strict default:")
    for label, path, want in strict_cases:
        verdicts = {n: m.extract_complete(path) for n, m in CARRIERS}
        check(label, verdicts, want)

    # --trust-unmarked fallback, both carriers
    print("trust-unmarked:")
    trust_cases = [
        ("both patterns, --trust-unmarked", both, True),
        ("req-only, --trust-unmarked", reqonly, False),
        ("all req + SOME resp, --trust-unmarked", someresp, True),
    ]
    for label, path, want in trust_cases:
        verdicts = {n: m.extract_complete(path, trust_unmarked=True)
                    for n, m in CARRIERS}
        check(label, verdicts, want)

    # spec-carrying markers, minimax carrier only (targeted extraction)
    print("spec markers (minimax-chain-measure):")
    mcm = dict(CARRIERS)["minimax-chain-measure"]
    spec_cases = [
        ("marker of the SAME spec", marked_a,
         lambda d: mcm.extract_complete(d, spec=SPEC_A), True),
        ("marker of ANOTHER spec", marked_b,
         lambda d: mcm.extract_complete(d, spec=SPEC_A), False),
        ("empty marker, spec asked (legacy dir)", marked,
         lambda d: mcm.extract_complete(d, spec=SPEC_A), False),
        ("no marker, spec asked, strict", someresp,
         lambda d: mcm.extract_complete(d, spec=SPEC_A), False),
    ]
    for label, path, fn, want in spec_cases:
        v = fn(path)
        fails += 0 if v == want else 1
        print("  %-48s %s %s" % (label, v,
                                 "OK" if v == want else "FAIL (want %s)" % want))

    if fails:
        print("FAILED: %d case(s)" % fails)
        return 1
    print("OK: all cases x carriers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
