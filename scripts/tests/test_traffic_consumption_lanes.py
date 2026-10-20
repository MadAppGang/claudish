#!/usr/bin/env python3
"""Pins for traffic-consumption.py lane classification (#555).

Since #555 the fleet's Claude Code settings name bare roles (`opus`, `sonnet`).
The resp-* capture header carries the SERVED model: on every lane but the native
one that is the resolved target id (`glm-5.3`, `MiniMax-M3.1-Flash`, ...); on the
native lane the #218 pin rewrites a bare role to `claude-*`, but an unpinned
native request serves the bare role verbatim. Both spellings must classify as
native-anthropic, and a role keyword inside a budget id must not.

Run: python scripts/tests/test_traffic_consumption_lanes.py
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


print("lane_for — native lane, both spellings")
for served in ("claude-opus-5-5", "claude-sonnet-5-5", "opus", "sonnet", "fable", "haiku", "Opus"):
    got = tc.lane_for(served)
    check(f"{served} -> native-anthropic", got == "native-anthropic", f"(got {got!r})")

print("lane_for — budget lanes untouched")
for served, lane in (
    ("glm-5.3", "gc@ GLM Coding"),
    ("MiniMax-M3.1-Flash", "mmc@ MiniMax"),
    ("deepseek-v4.1-flash-1017", "ds@ PAYG"),
    ("qwen3.8-max", "qwen-token-plan"),
):
    got = tc.lane_for(served)
    check(f"{served} -> {lane}", got == lane, f"(got {got!r})")

print("lane_for — a role keyword INSIDE another id is not native")
for served in ("my-sonnet-finetune", "opus-local", "gpt-6.1-sol"):
    got = tc.lane_for(served)
    check(f"{served} -> not native", got != "native-anthropic", f"(got {got!r})")

print()
if FAILS:
    print(f"FAILED: {len(FAILS)} -> {FAILS}")
    sys.exit(1)
print("all pins green")
