#!/usr/bin/env python3
"""Dump the TEXT an agent writes per response, plus verification-marker counts.

    python dump_text.py <dir> [n_examples]
"""
import json
import os
import re
import sys

TX = re.compile(r'"type":"text_delta","text":"((?:[^"\\]|\\.)*)"')
BLOCKSTART = re.compile(r'"type":"content_block_start","index":(\d+),"content_block":\{"type":"text"')

MARKERS = {
    "titre ##": r"\\n#",
    "PR ref #N": r"#1[0-9]{4}",
    "verdict mots": r"(?i)verdict|VERDICT",
    "banner #####": r"#{6,}",
    "etoiles/score": r"[★☆]|\\\\u2605",
    "table |": r"\|[^|\n]{1,40}\|",
    "case OK/FAIL": r"\bOK\b|\bFAIL\b",
    "emoji": r"\\\\u26|\\\\u27|\\\\u2b",
}


def text_of(path):
    out = []
    try:
        rt = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""
    for m in TX.findall(rt):
        try:
            out.append(json.loads('"%s"' % m))
        except Exception:
            out.append(m)
    return "".join(out)


def main():
    d = sys.argv[1]
    nex = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    files = sorted(f for f in os.listdir(d) if f.endswith(".sse"))
    sample = files[:200]
    tot_ch = 0
    hits = {k: 0 for k in MARKERS}
    best = []
    for fn in sample:
        t = text_of(os.path.join(d, fn))
        tot_ch += len(t)
        for k, pat in MARKERS.items():
            hits[k] += len(re.findall(pat, t))
        best.append((len(t), fn, t))
    best.sort(reverse=True)
    n = max(len(sample), 1)
    print(f"=== {d} — {n} reponses, {tot_ch} chars de texte "
          f"({tot_ch // n} ch/rep) ===")
    print("Marqueurs de redaction (occurrences totales sur l'echantillon) :")
    for k in MARKERS:
        print(f"  {k:16s} {hits[k]:6d}   ({hits[k]/n:.2f}/reponse)")
    print()
    for L, fn, t in best[:nex]:
        print(f"--- {fn}  ({L} ch) ---")
        print(t[:900].replace("\\n", "\n"))
        print()


if __name__ == "__main__":
    main()
