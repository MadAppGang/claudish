#!/usr/bin/env python3
"""Pins for harness-injection-measure.py's native-served filter (#555).

The instrument measures harness-context cost on NATIVE responses only (their
usage is counted by Anthropic's tokenizer). The filter keyed on the `claude`
prefix went blind the moment the fleet's settings name bare roles: an
unpinned native response serves `opus`/`sonnet`/... verbatim and was skipped
— count too low, line absent. Same rationale as traffic-consumption.py's
bare-role native lane (#556).

Run: python scripts/tests/test_harness_injection_native.py
"""

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "harness_injection_measure", os.path.join(_HERE, "..", "harness-injection-measure.py"))
him = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(him)

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS.append(f"{name}  {detail}")


# Pinned native spellings stay native...
for m in ("claude-opus-5-5", "claude-sonnet-4-6", "Claude-Haiku-4-5", "claude-fable-5"):
    check(f"native: {m}", him.is_native_served(m))
# ...and bare roles too (unpinned native, both cases in one vocabulary)
for m in ("opus", "sonnet", "haiku", "fable", "OPUS", "Fable"):
    check(f"native (bare role): {m}", him.is_native_served(m))
# Budget ids never are — a role keyword inside a longer id must not match
for m in ("glm-5.3", "deepseek-v4.1-flash-1017", "MiniMax-M3.1-Flash",
          "gpt-6.1-sol", "codex-mini-1", "sonnet-x-custom", "haiku-alias"):
    check(f"not native: {m}", not him.is_native_served(m))
# A bare role WITH the [1m] window marker is not a served id either (the
# marker is stripped before the wire; if one ever leaks through it is a
# different id and must surface, not silently count as native)
check("not native: sonnet[1m]", not him.is_native_served("sonnet[1m]"))

if FAILS:
    print(f"\n{len(FAILS)} FAIL(S):")
    for f in FAILS:
        print(f"  - {f}")
    sys.exit(1)
print("\nAll harness-injection native-filter pins green.")
