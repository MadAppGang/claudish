#!/usr/bin/env python3
"""One call surface for the coherent-triple usage rule (#600 / #603 / #607).

The rule itself lives in `scripts/lane-out-trend.py` (ai-01 review #414): a
usage block is ONE snapshot — the LAST block stating inputs (`in+cr+cc > 0`)
wins WHOLE; `message_start`'s own statement stands in when the stream died
before the terminal `message_delta`; `output_tokens` keeps the terminal
(cumulative) value. Never a per-field selection.

Why it must not be re-implemented per instrument: since #444/#518
`message_start` carries a seed whose `input_tokens` is the session's PRIOR
turn, while the terminal delta carries the coherent `(in, cr, cc)` triple
with the cache split applied. Per-field maxima (or "keep the block with the
largest input total") mix two snapshots that were never emitted together and
double the prompt — measured 2026-10-22: 11/42 local captures inflated
> 5 %, aggregate x1.14, worst `glm-5.3` turn x3.1 (seed 250 494 vs terminal
117 316).

This module is the DELEGATION surface, never a second copy of the rule: it
loads `lane-out-trend.py` by path (the dashed filename is not importable as
a module) and forwards. Importable with no side effects, so the pins load it
directly.
"""

import importlib.util
from pathlib import Path


def _load_lane_out_trend():
    p = Path(__file__).resolve().parent.parent / "lane-out-trend.py"
    spec = importlib.util.spec_from_file_location("lane_out_trend", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


LOT = _load_lane_out_trend()


def usage_triplet(text):
    """`(in, out, cr, cc)` read from ONE coherent usage block.

    `None` means the text carries no usage block at all (a different
    counter). A zero-seeded block is an explicit statement and reads as
    `(0, out, 0, 0)` — the same contract as `traffic-consumption.py`'s
    `usage_of()`.
    """
    blocks, _line_fail = LOT.scan_usage(text)
    if not blocks:
        return None
    chosen, out = LOT.select_usage(blocks)
    if chosen is None:
        return (0, out or 0, 0, 0)
    return (chosen["in"], out or 0, chosen["cr"], chosen["cc"])


def prompt_of(triplet):
    """Prompt total of a triplet: `in + cr + cc` — the three counters were
    emitted together (#179), so they are summed only from the same block."""
    return triplet[0] + triplet[2] + triplet[3]
