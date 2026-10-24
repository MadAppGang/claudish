#!/usr/bin/env python3
"""Pins for the three usage readers that used to select fields their own way
(#607, the #600 follow-up; the #328 G10 defect).

A usage block is ONE snapshot. Since #444/#518 `message_start` carries a seed
whose `input_tokens` is the session's PRIOR turn, while the terminal
`message_delta` carries the coherent `(in, cr, cc)` triple with the cache
split applied. Per-field maxima — or "keep the block with the largest input
total" — mix two snapshots never emitted together and double the prompt
(measured 2026-10-22: 11/42 local captures inflated > 5 %, aggregate x1.14,
worst `glm-5.3` turn x3.1: seed 250 494 vs terminal 117 316).

Pinned here, per site:

  * `scripts/lib/usage_reader.py` — the shared delegation surface (value pins;
    it also has to agree with `traffic-consumption.py`'s `usage_of`, which is
    the same rule reached by another loader — no second copy may drift).
  * `scripts/harness-injection-measure.py :: usage_from_sse` — real call pin
    (module importable: the scan lives behind `if __name__ == "__main__"`).
  * `scripts/compaction-trend.py :: usage_from_text` — real call pin (same).
  * `scripts/traffic-mxws.py` — the scan runs at import time (no `__main__`
    guard), so this site is pinned by a SOURCE guard: it must call the shared
    reader and must not carry the per-field maxima back.

Mutation proof expected: restoring a per-field max (or "largest input total")
in any site turns the corresponding pin red.

Run: python scripts/tests/test_usage_readers_coherence.py
"""

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.join(_HERE, "..")


def _load(module_name, *rel_parts):
    spec = importlib.util.spec_from_file_location(
        module_name, os.path.join(_SCRIPTS, *rel_parts))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ur = _load("usage_reader", "lib", "usage_reader.py")
him = _load("harness_injection_measure", "harness-injection-measure.py")
ct = _load("compaction_trend", "compaction-trend.py")
tc = _load("traffic_consumption", "traffic-consumption.py")

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def sse(*events):
    return "\n".join("data: " + e for e in events) + "\n"


MSG_START_SEED = (
    '{"type":"message_start","message":{"usage":{'
    '"input_tokens":244812,"cache_read_input_tokens":0,'
    '"cache_creation_input_tokens":0,"output_tokens":1}}}')
DELTA_TERMINAL = (
    '{"type":"message_delta","usage":{"input_tokens":67,'
    '"cache_read_input_tokens":244800,'
    '"cache_creation_input_tokens":0,"output_tokens":123}}')

# The #600 worst case: seed 250 494, terminal prompt 117 316 (glm-5.3, 22/10).
SEED_WORST = MSG_START_SEED.replace("244812", "250494")
DELTA_WORST = DELTA_TERMINAL.replace("244800", "117249")
WORST = sse(SEED_WORST, DELTA_WORST)   # coherent prompt = 67 + 117249 = 117316
WORST_PER_FIELD = (250494, 123, 117249, 0)  # what the old readers produced

print("usage_reader — the shared surface reads the coherent terminal triple")
u = ur.usage_triplet(WORST)
check("triplet is the terminal block, whole", u == (67, 123, 117249, 0), f"(got {u!r})")
check("prompt_of = 117316, not 367743", ur.prompt_of(u) == 117316, f"(got {ur.prompt_of(u)})")
check("per-field max would have differed", u != WORST_PER_FIELD, f"(got {u!r})")

print("usage_reader — no usage block at all is None, a zero seed is a statement")
check("empty text -> None", ur.usage_triplet("") is None, f"(got {ur.usage_triplet('')!r})")
zero = ('{"usage":{"input_tokens":0,"cache_read_input_tokens":0,'
        '"cache_creation_input_tokens":0,"output_tokens":0}}')
check("zero-seeded -> zeros, not None", ur.usage_triplet(sse(zero)) == (0, 0, 0, 0))

print("usage_reader — agrees with traffic-consumption.py's usage_of (one rule)")
for label, text in (("seeded+terminal", sse(MSG_START_SEED, DELTA_TERMINAL)),
                    ("worst case", WORST),
                    ("died before terminal", sse(MSG_START_SEED)),
                    ("no usage", "data: {\"type\":\"content_block_start\"}\n")):
    a = ur.usage_triplet(text)
    b = tc.usage_of(text)
    check(f"{label}: same reading", a == b, f"(reader {a!r} vs usage_of {b!r})")

print("harness-injection-measure.usage_from_sse — the seed never wins")
h = him.usage_from_sse(WORST)
check("(total, in, cr) = (117316, 67, 117249)", h == (117316, 67, 117249), f"(got {h!r})")
check("old 'largest input total' would have read the seed",
      h != (250494, 250494, 0), f"(got {h!r})")
check("no input statement -> None (historical contract)",
      him.usage_from_sse(sse(zero)) is None,
      f"(got {him.usage_from_sse(sse(zero))!r})")

print("compaction-trend.usage_from_text — the re-paid prompt is the coherent one")
c = ct.usage_from_text(WORST)
check("(in, out, cr, cc) coherent", c == (67, 123, 117249, 0), f"(got {c!r})")
check("old per-field max would have differed", c != WORST_PER_FIELD, f"(got {c!r})")
check("no usage block -> None", ct.usage_from_text("") is None,
      f"(got {ct.usage_from_text('')!r})")

print("traffic-mxws.py — source guard (scan runs at import, so no call pin)")
with open(os.path.join(_SCRIPTS, "traffic-mxws.py"), encoding="utf-8") as fh:
    mxws_src = fh.read()
check("delegates to the shared reader", "_UR.usage_triplet(s)" in mxws_src,
      "(call to usage_triplet(s) missing)")
check("sums the coherent prompt", "_UR.prompt_of(u)" in mxws_src,
      "(prompt_of missing)")
check("per-field maxima are gone",
      "max(ins)" not in mxws_src and "max(outs)" not in mxws_src,
      "(restoring max(ins)/max(outs) re-introduces the G10 defect)")

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all usage-reader coherence pins green")
