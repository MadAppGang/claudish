#!/usr/bin/env python3
"""Pins for traffic-consumption.py usage selection (#600, the #328 G10 defect).

usage_of() must read a capture's INPUT counters as ONE coherent triple —
never per-field maxima. Since #444/#518 message_start carries a seed
(input_tokens = the session's prior turn) and the terminal message_delta
carries the coherent (in, cr, cc) triple with the cache split applied:
per-field maxima mix two snapshots never emitted together and double the
prompt (measured 22/10: 11/42 local captures inflated > 5 %, aggregate x1.14,
worst glm-5.3 turn x3.1).

The selection rule is lane-out-trend.py's (ai-01 review #414), imported —
not a second copy: the LAST usage block with a non-empty input statement
(in+cr+cc > 0) wins WHOLE; message_start's own triple stands in if the
stream died before one; output_tokens keeps the terminal value.

Mutation proof expected: restoring a per-field max makes the first two pins
fail while these pass.

Run: python scripts/tests/test_traffic_consumption_usage.py
"""

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "traffic_consumption", os.path.join(_HERE, "..", "traffic-consumption.py"))
tc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(tc)

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
    '"cache_creation_input_tokens":{"ephemeral_5m_input_tokens":0,'
    '"ephemeral_1h_input_tokens":0},"output_tokens":1}}}')
DELTA_TERMINAL = (
    '{"type":"message_delta","usage":{"input_tokens":67,'
    '"cache_read_input_tokens":244800,'
    '"cache_creation_input_tokens":0,"output_tokens":123}}')

print("usage_of — seeded message_start + terminal delta: the coherent"
      " terminal triple wins (NOT per-field maxima)")
u = tc.usage_of(sse(MSG_START_SEED, DELTA_TERMINAL))
# per-field maxima would read (244812, 244800) = 489612;
# the coherent terminal triple is 67 + 244800 = 244867 (#414 measure)
check("terminal triple, not 489612", u == (67, 123, 244800, 0), f"(got {u!r})")
check("prompt sums to 244867",
      u[0] + u[2] + u[3] == 244867, f"(got {u[0] + u[2] + u[3]})")

print("usage_of — the #600 worst case (glm-5.3, seed 250 494, terminal 117 316)")
start = MSG_START_SEED.replace("244812", "250494")
delta = DELTA_TERMINAL.replace("244800", "117249")
u = tc.usage_of(sse(start, delta))
# per-field maxima read 250494 + 117249 = 367743 (x3.13); coherent = 117316
check("terminal triple 117316, not 367743",
      u[0] + u[2] + u[3] == 117316, f"(got {u[0] + u[2] + u[3]})")

print("usage_of — GLM zero-then-real (piege 2): the zero block is never chosen")
zero = ('{"usage":{"input_tokens":0,"cache_read_input_tokens":0,'
        '"cache_creation_input_tokens":0,"output_tokens":0}}')
real = ('{"usage":{"input_tokens":1200,"cache_read_input_tokens":3400,'
        '"cache_creation_input_tokens":0,"output_tokens":88}}')
u = tc.usage_of(sse(zero, real))
check("real block wins", u == (1200, 88, 3400, 0), f"(got {u!r})")

print("usage_of — stream died before the terminal: message_start stands in,"
      " whole")
u = tc.usage_of(sse(MSG_START_SEED))
check("seed triple stands in", u == (244812, 1, 0, 0), f"(got {u!r})")

print("usage_of — output_tokens is TERMINAL (cumulative monotone)")
early = ('{"usage":{"input_tokens":10,"output_tokens":10}}')
late = ('{"usage":{"input_tokens":10,"output_tokens":250}}')
u = tc.usage_of(sse(early, late))
check("terminal output wins", u == (10, 250, 0, 0), f"(got {u!r})")

print("usage_of — absent statements")
u = tc.usage_of(sse('{"type":"content_block_start","index":0}'))
check("no usage block -> None", u is None, f"(got {u!r})")
u = tc.usage_of(sse(zero))
check("all-zero-seeded -> zeros, not None", u == (0, 0, 0, 0), f"(got {u!r})")

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all usage-selection pins green")
