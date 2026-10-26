#!/usr/bin/env python3
"""Filename-only census of claudish response captures, per parser label and model.

Answers "which model was served on which wire, how many times" without opening a
single capture body. This is the instrument for backend/routing questions over
archived corpora (`captures-YYYY-MM-DD*.7z`), and the cheap half of an
attestation such as #81 ("is direct `zai@` traffic actually being served?").

Why the filename is enough
--------------------------
`handlers/shared/response-capture.ts` writes:

    resp-<pid>-r<NNNN>-<ts>-<label>-<safeModel>.sse

`label` is the literal parser id passed to `createResponseCapture()`, and
`safeModel` is the model that actually served the stream. The closed label set
is anchored below on purpose: splitting greedily on `-` would read
`openai-glm-5.3.sse` as label="openai-glm", model="5.3".

What it CANNOT see
------------------
Response captures exist only for streams that were served. A request refused at
admission (401/404/quota/context) leaves no `resp-*.sse`; the request side is
`req-<pid>-<NNNN>-<ts>-<safeSrc>.json` (`fork/middleware/request-logger.ts`),
whose filename carries the SOURCE, never the model. Counting attempts therefore
needs a body pass, which is a different (and much heavier) instrument.

Usage
-----
    # straight from archives (shells out to 7z / 7z.exe)
    python capture-census.py captures-2026-10-24.7z captures-2026-10-23.7z

    # or from listings captured earlier (no 7z needed at census time)
    7z l captures-2026-10-24.7z > list-1024.txt
    python capture-census.py list-1024.txt

    # per-day roll-up instead of by-label totals
    python capture-census.py --days captures-*.7z

Reading rules that decide the verdict
-------------------------------------
A NOMINAL sidecar relays to the hub and writes no capture of its own, so the
hub corpus covers every relayed request. A sidecar in AUTONOMOUS mode captures
locally and its traffic is absent from the hub corpus — measure its own
machine-tagged archive (`captures-<day>-<machine>.7z`).
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

# The closed set of parser ids passed to createResponseCapture(). Keep in sync
# with the call sites; a new parser must be added here or its captures will be
# silently uncounted.
LABELS = ("anthropic", "gemini", "ollama", "responses", "openai", "native")

RESP_RX = re.compile(
    r"resp-(?P<pid>\d+)-r(?P<req>\d+)-(?P<ts>\d{4}-\d{2}-\d{2}T[\d-]+Z)-"
    rf"(?P<label>{'|'.join(LABELS)})-(?P<model>.+)\.sse$"
)
REQ_RX = re.compile(r"req-\d+-\d{4}-")

# GLM family as it appears on either wire: `glm-5.3`, `z-ai/glm-4.5-air`
# (safeModel rewrites `/` to `_`, hence `z-ai_glm-4.5-air`).
GLM_RX = re.compile(r"^(glm|z-ai|zai)", re.IGNORECASE)


def listing_lines(source: Path) -> list[str]:
    """Return `7z l` output lines for an archive, or the file's own lines."""
    if source.suffix.lower() == ".7z":
        for exe in ("7z", "7za", r"C:\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe"):
            try:
                out = subprocess.run(
                    [exe, "l", str(source)],
                    capture_output=True,
                    text=True,
                    errors="replace",
                    check=True,
                )
            except (FileNotFoundError, subprocess.CalledProcessError):
                continue
            return out.stdout.splitlines()
        raise SystemExit(f"no usable 7z executable found to list {source}")
    return source.read_text(encoding="utf-8", errors="replace").splitlines()


def scan(lines: list[str]) -> dict[str, int]:
    counts: Counter = Counter()
    for raw in lines:
        line = raw.strip()
        if REQ_RX.search(line):
            counts["req"] += 1
        m = RESP_RX.search(line)
        if not m:
            continue
        counts["resp"] += 1
        label, model = m.group("label"), m.group("model")
        counts[label] += 1
        if GLM_RX.match(model):
            counts["glm_anthropic" if label == "anthropic" else "glm_other"] += 1
    return counts


def print_by_label(total: Counter) -> None:
    print(f"resp_captures={total['resp']} req_captures={total['req']}")
    print("\n== by parser label ==")
    for label in LABELS:
        n = total[label]
        print(f"{n:8d}  {label}" + ("   (ABSENT)" if n == 0 else ""))
    print(f"\nglm_on_anthropic_wire={total['glm_anthropic']}")
    print(f"glm_on_other_wires   ={total['glm_other']}")


def print_days(rows: list[tuple[str, Counter]]) -> None:
    head = f"{'source':<34}{'resp':>9}{'anthropic':>11}{'glm|anth':>10}{'glm|other':>11}{'req':>8}"
    print(head)
    grand: Counter = Counter()
    for name, c in rows:
        grand.update(c)
        print(
            f"{name:<34}{c['resp']:>9}{c['anthropic']:>11}"
            f"{c['glm_anthropic']:>10}{c['glm_other']:>11}{c['req']:>8}"
        )
    print(
        f"{'TOTAL':<34}{grand['resp']:>9}{grand['anthropic']:>11}"
        f"{grand['glm_anthropic']:>10}{grand['glm_other']:>11}{grand['req']:>8}"
    )


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="+", help=".7z archives or `7z l` listing files")
    ap.add_argument("--days", action="store_true", help="per-source roll-up instead of merged totals")
    args = ap.parse_args(argv)

    rows = []
    total: Counter = Counter()
    for src in (Path(s) for s in args.sources):
        counts = scan(listing_lines(src))
        total.update(counts)
        rows.append((src.stem, counts))

    if args.days:
        print_days(rows)
    else:
        print_by_label(total)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
