#!/usr/bin/env python3
"""Harness mobilization measure (#23 "charge vs mobilise", mobilise side).

Scans hub capture req-*.json files for one machine and one day, then reports
which harness-injected files the agents ever CONSULT in-flight. The charge
side (injected chars per request) is harness-injection-measure.py's job; this
script answers the complementary question — after injection, does anyone ever
re-open the source file?

A "mobilization" is now detected in every form a file is actually re-opened
(#486 CR):
  - Read/Grep/Glob/LS with a path input (file_path/path/notebook_path);
  - a Grep/Glob/LS scoped to a PARENT directory of the cited file (the
    containing direction — `Grep(path=~/.claude/rules)` reads every rule);
  - a Bash command whose text contains the cited path (cat/sed/head/grep);
  - path-form variants normalized: backslash, case, `~`, Git-Bash `/c/`
    drive form, and `~`-stripped home-relative tails.

Known remaining blind spots (documented, not hidden): a Glob whose only
scoping is `pattern` with no `path` (cwd-relative) is not matched; a Bash
command referencing a cited file by bare basename only (no directory part)
is not matched — both are loose enough to be false-positive factories.

HUB-HOST LOAD RULE (15/10 flap lesson): this script reads the hub's capture
disk over SMB. The default pass is bounded — a pacing sleep every N files
(`--pace-every`, `--pace-sleep`), on both passes — and `--limit` caps the
kept-request count. Every run prints its UTC start and end; report them so a
run can be correlated with hub incidents (hypothesis to record, not blame).

Usage:
    python -I scripts/harness-mobilization-measure.py --selftest
    python -I scripts/harness-mobilization-measure.py \
        --share //192.168.0.50/d$/claudish-captures \
        --day 2026-10-15 --machine myia-po-2024
    # when the day's raw captures are already compacted into the archive:
    python -I scripts/harness-mobilization-measure.py \
        --archive //192.168.0.50/d$/claudish-captures/archive/captures-2026-10-15.7z \
        --machine myia-po-2024 --sevenz "C:/path/to/7zr.exe"
    (--archive streams `7zr e -so` and splits the concatenated JSON stream
    with raw_decode — no disk extraction, one sequential archive read.)

Traps baked into the design (all hit during the first run, 16/10):
  - UNC paths from python: FORWARD SLASHES ONLY ("//host/d$/dir"). Backslash
    forms die as WinError 3 because every shell/heredoc layer between here
    and python eats one doubling; // survives everywhere (SMB and Win32 both
    normalize it).
  - Lane attribution is the project "Contents of <path>" marker path, NEVER a
    raw "WorkspaceName in messages" string gate: the string also matches other
    lanes whose memory prose mentions the workspace (measured: a raw gate let
    the roo-extensions lane in through its MEMORY.md).
  - model in the capture envelope is the CLIENT-REQUESTED id, pre-remap. An
    opus-requesting lane on a machine with no Anthropic credential is cascade
    input, not an Anthropic-billed serve.
  - A request's history carries only PAST turns: per-request mobilization
    undercounts the first turn of each conversation (same bias every lane).
  - Filename sort is lexicographic: req-1-10000-* sorts BEFORE req-1-9999-*.
    Parse timestamps from the name; never trust sorted()[-1] as "latest".
  - Cited paths may contain spaces ("G:\\Mon Drive\\…"): the marker regex
    captures up to the " (" separator, never to the first whitespace.
"""

import argparse
import collections
import datetime
import json
import os
import re
import subprocess
import sys
import time

TOOL_NAMES = {"Read", "Grep", "Glob", "LS"}
CONTENTS_RE = re.compile(r"Contents of (.+?)\s*\(")  # up to " (" — spaces survive
MACHINE_RE = re.compile(r'"machine":"([^"]*)"')
TS_RE = re.compile(r'"ts":"([^"]*)"')
MODEL_RE = re.compile(r'"model":"([^"]*)"')
NAME_TS_RE = re.compile(r"-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})")


def norm(p):
    """One canonical form per spelling: forward slashes, lowercased, `~` and
    Git-Bash drive prefixes expanded away where derivable without a home."""
    s = str(p).replace("\\", "/").strip().lower()
    if s.startswith("~/"):
        s = s[2:]
    elif s == "~":
        s = ""
    m = re.match(r"^/([a-z])/(.*)$", s)
    if m:  # /c/users/... -> c:/users/...
        s = m.group(1) + ":/" + m.group(2)
    return s.rstrip("/")


def variants(p):
    """All normalized spellings of a path: canonical, Git-Bash drive form,
    and the home-relative tail (everything after users/<name>/) so a `~` form
    or relative input still matches a cited absolute path."""
    s = norm(p)
    out = {s} if s else set()
    m = re.match(r"^([a-z]):/(.*)$", s)
    if m:
        out.add("/" + m.group(1) + "/" + m.group(2))
        m2 = re.match(r"users/([^/]+)/(.+)", m.group(2))
        if m2:
            out.add(m2.group(2))
    return out


def tool_matches(tool_v, cited_v):
    if tool_v == cited_v:
        return True
    # containing direction: the tool path is a parent dir of the cited file
    if cited_v.startswith(tool_v + "/"):
        return True
    # relative/~ form: tool path is a component-boundary tail of the cited
    # path (>= 2 components, so a bare basename never matches on its own)
    if len(tool_v.split("/")) >= 2 and cited_v.endswith("/" + tool_v):
        return True
    return False


def path_mobilizes(tool_path, cited):
    # norm() alone covers every TOOL-input spelling (~ strip, /c/ drive,
    # case, backslash); variants() on the CITED side adds the Git-Bash and
    # home-relative spellings a tool input or Bash text can carry.
    tv = norm(tool_path)
    if not tv:
        return None
    for c in cited:
        for cv in variants(c):
            if tool_matches(tv, cv):
                return c
    return None


def bash_mobilizes(command, cited):
    cmd = command.replace("\\", "/").lower()
    for c in cited:
        for cv in variants(c):
            if cv in cmd:
                return c
    return None


def extract(doc):
    """One capture doc -> (cited path set, [(form, tool, cited)])."""
    body = doc.get("body") or {}
    msgs = body.get("messages")
    if not isinstance(msgs, list):
        return set(), []
    cited = set()
    sources = []
    if isinstance(body.get("system"), list):
        sources += body["system"]
    for msg in msgs:
        if isinstance(msg, dict) and isinstance(msg.get("content"), list):
            sources += msg["content"]
    for blk in sources:
        if isinstance(blk, dict) and isinstance(blk.get("text"), str) and "Contents of " in blk["text"]:
            for c in CONTENTS_RE.finditer(blk["text"]):
                cited.add(c.group(1).strip())
    mobil = []
    for msg in msgs:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for blk in content:
            if not isinstance(blk, dict) or blk.get("type") != "tool_use":
                continue
            name = blk.get("name")
            inp = blk.get("input") or {}
            if name == "Bash":
                cmd = inp.get("command")
                if isinstance(cmd, str):
                    c = bash_mobilizes(cmd, cited)
                    if c:
                        mobil.append(("bash", name, c))
            elif name in TOOL_NAMES:
                for key in ("file_path", "path", "notebook_path"):
                    v = inp.get(key)
                    if isinstance(v, str):
                        c = path_mobilizes(v, cited)
                        if c:
                            mobil.append(("path", name, c))
                        break
    return cited, mobil


def selftest():
    """One positive per re-opening form + one negative. Each positive turns
    red if its detection branch (Bash counting, dir containment, path-variant
    normalization, space-safe marker regex) is removed."""
    RULE = r"C:\Users\u\.claude\rules\a.md"
    SPACE = r"G:\Mon Drive\projets\w.md"

    def doc(cited_paths, tool_name, tool_input):
        marker = "\n".join(f"Contents of {p} (12 lines)" for p in cited_paths)
        return {
            "body": {
                "system": [{"type": "text", "text": marker}],
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": marker}]},
                    {"role": "assistant", "content": [
                        {"type": "tool_use", "name": tool_name, "input": tool_input}
                    ]},
                ],
            }
        }

    cases = [
        # (label, doc, expected cited file or None)
        ("read_exact", doc([RULE], "Read", {"file_path": RULE}), RULE),
        ("read_backslash_variant", doc([RULE], "Read", {"file_path": RULE.replace("\\", "/")}), RULE),
        ("bash_cat", doc([RULE], "Bash", {"command": f"cat '{RULE}'"}), RULE),
        ("bash_gitbash_form", doc([RULE], "Bash", {"command": "head -5 /c/Users/u/.claude/rules/a.md"}), RULE),
        ("grep_parent_dir", doc([RULE], "Grep", {"path": "~/.claude/rules", "pattern": "x"}), RULE),
        ("tilde_read", doc([RULE], "Read", {"file_path": "~/.claude/rules/a.md"}), RULE),
        ("space_path_read", doc([SPACE], "Read", {"file_path": SPACE}), SPACE),
        ("space_path_bash", doc([SPACE], "Bash", {"command": f"grep x '{SPACE}'"}), SPACE),
        ("negative_unrelated", doc([RULE], "Read", {"file_path": r"D:\unrelated\other.md"}), None),
        ("negative_bare_basename", doc([RULE], "Bash", {"command": "cat a.md"}), None),
    ]
    failures = []
    for label, d, want in cases:
        cited, mobil = extract(d)
        got = mobil[0][2] if mobil else None
        ok = got == want and (want is None or len(mobil) >= 1)
        print(f"  {'PASS' if ok else 'FAIL'} {label}: mobilized={got!r} (want {want!r})")
        if not ok:
            failures.append(label)
    # marker regex must keep the space inside the cited path
    cited, _ = extract(doc([SPACE], "Read", {"file_path": SPACE}))
    if cited != {SPACE}:
        print(f"  FAIL marker_regex_space: cited={cited!r}")
        failures.append("marker_regex_space")
    else:
        print("  PASS marker_regex_space")
    # stream split pins (#486 review): a chunk boundary must never replay
    # docs already yielded — exact count, no duplicates, on both split
    # forms. Red against the pre-last_end `tail = text` exhaustion branch.
    docs4 = [json.dumps({"ts": i, "v": i}).encode() for i in range(4)]
    splits = {
        # boundary falls exactly at the end of doc 1
        "stream_split_at_doc_end": (docs4[0] + docs4[1], docs4[2] + docs4[3]),
        # boundary cuts doc 2's '{"ts":' signature in half
        "stream_split_mid_signature": (
            docs4[0] + docs4[1] + docs4[2][:5],
            docs4[2][5:] + docs4[3],
        ),
    }
    for label, (c1, c2) in splits.items():
        got = [d["ts"] for d in iter_docs_from_chunks([c1, c2])]
        ok = got == [0, 1, 2, 3]
        print(f"  {'PASS' if ok else 'FAIL'} {label}: ts={got} (want [0, 1, 2, 3])")
        if not ok:
            failures.append(label)
    if failures:
        sys.exit(f"selftest FAILED: {failures}")
    print("selftest: all forms green")


def iter_docs_from_chunks(chunks):
    """Yield parsed JSON docs from an iterable of byte chunks (the pure
    parsing half of iter_archive_docs, split out so the selftest can drive
    chunk boundaries without a real archive). The stream is concatenated
    req-*.json captures; JSON is self-delimiting — raw_decode splits it."""
    import codecs
    dec = json.JSONDecoder()
    inc = codecs.getincrementaldecoder("utf-8")(errors="replace")
    tail = ""
    SIG = '{"ts":'  # every capture envelope starts with this — doc boundary anchor
    for chunk in chunks:
        text = tail + inc.decode(chunk)
        idx = text.find(SIG)
        n = len(text)
        last_end = 0  # end of the last COMPLETE doc this buffer — the tail
                      # starts here on signature exhaustion, never at 0: a
                      # whole-buffer tail replays every doc already yielded
                      # (one per chunk boundary, #486 review)
        while idx != -1:
            try:
                obj, end = dec.raw_decode(text, idx)
            except json.JSONDecodeError:
                # Truncated doc (more bytes coming) or corrupt one. With
                # >1 MB buffered past the failure it is corrupt: resync
                # on the NEXT document signature (a plain char-skip would
                # land inside the corrupt doc and yield nested fragments
                # — measured: doc #2025 was a "messages":[ array). If no
                # signature follows in this buffer, break WITH idx at the
                # corrupt doc so the tail never rewinds over docs already
                # yielded (a whole-buffer tail would double-count them).
                if n - idx > (1 << 20):
                    nxt = text.find(SIG, idx + 1)
                    if nxt == -1:
                        break
                    idx = nxt
                    continue
                break
            if isinstance(obj, dict):
                yield obj
            last_end = end
            idx = text.find(SIG, end)
        # idx != -1: corrupt-doc break — keep the buffer from that doc.
        # idx == -1: every doc in this buffer was yielded — keep only what
        # follows the last complete doc (may be a partial next doc).
        tail = text[idx:] if idx != -1 else text[last_end:]


def iter_archive_docs(sevenz, archive):
    """Yield parsed JSON docs from `7zr e -so <archive>`, never touching the
    disk: the archive is a day's concatenated req-*.json captures. Parsing
    lives in iter_docs_from_chunks. The stream order is the ARCHIVE order
    (never trust `7z l` listing order — the listing is name-sorted, memory
    7z-listing-sort-order-trap)."""
    proc = subprocess.Popen(
        [sevenz, "e", "-so", archive],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    try:
        yield from iter_docs_from_chunks(
            iter(lambda: proc.stdout.read(1 << 20), b"")
        )
    finally:
        proc.stdout.close()
        proc.wait()


def lane_of(cited):
    """Lane label from the cited-path set: the project CLAUDE.md parent dir,
    else the component before '.claude', else the memory-project hash."""
    for c in cited:
        low = c.replace("\\", "/").lower()
        if low.endswith("claude.md"):
            ws = low[: -len("claude.md")].rstrip("/").split("/")[-1]
            if ws != ".claude":  # bare ~/.claude/CLAUDE.md is machine-level, not a lane
                return ws
    for c in cited:
        low = c.replace("\\", "/").lower()
        if "/.claude/" in low:
            return low.split("/.claude/")[0].split("/")[-1]
    for c in cited:
        low = c.replace("\\", "/").lower()
        if "/projects/" in low and "/memory/" in low:
            return low.split("/projects/")[1].split("/")[0]
    return "(machine-level only)"


def aggregate(agg, cited, mobil, model_id):
    """Fold one request's extraction into the lane aggregate."""
    lane = lane_of(sorted(cited)) if cited else "(no citation)"
    a = agg[lane]
    a["req"] += 1
    a["models"][model_id] += 1
    for c in cited:
        a["cfiles"][c.split("\\")[-1]] += 1
    if mobil:
        a["mob"] += 1
        for form, tool, c in mobil:
            a["mfiles"][c.split("\\")[-1] + " <- " + tool + "/" + form] += 1


def report(agg, started):
    total = sum(a["req"] for a in agg.values())
    print(f"\n=== mobilization by lane ({total} requests) ===")
    for lane, a in sorted(agg.items(), key=lambda kv: -kv[1]["req"]):
        rate = 100 * a["mob"] / a["req"] if a["req"] else 0
        print(f"{lane}: {a['req']} req, mobilized {a['mob']} ({rate:.1f}%), models={dict(a['models'].most_common(3))}")
        top = dict(a["mfiles"].most_common(4))
        print(f"   mobilized files: {top if top else 'NONE'}")
        never = [f for f in a["cfiles"] if not any(f + " <-" in k for k in a["mfiles"])]
        if never:
            print(f"   NEVER mobilized ({len(never)} cited files): {', '.join(sorted(never)[:12])}{' ...' if len(never) > 12 else ''}")
    ended = datetime.datetime.now(datetime.timezone.utc)
    print(f"run end (UTC): {ended.isoformat()} (elapsed {(ended - started).total_seconds():.0f}s)", flush=True)


def run_archive(args):
    """Stream mode: one sequential archive read over SMB, docs parsed from
    the concatenated stream, machine filter applied on the parsed envelope.
    Bounded by construction — the hub host serves a single file read."""
    started = datetime.datetime.now(datetime.timezone.utc)
    print(f"run start (UTC): {started.isoformat()}", flush=True)
    print(f"archive: {args.archive} (streamed, no disk extraction)", flush=True)
    agg = collections.defaultdict(lambda: {"req": 0, "mob": 0, "models": collections.Counter(),
                                           "mfiles": collections.Counter(), "cfiles": collections.Counter()})
    seen = kept = 0
    for doc in iter_archive_docs(args.sevenz, args.archive):
        seen += 1
        if doc.get("machine") != args.machine:
            continue
        kept += 1
        model_id = doc.get("model") or "?"
        cited, mobil = extract(doc)
        aggregate(agg, cited, mobil, model_id)
        if (kept) % 1000 == 0:
            print(f"  stream {kept} kept / {seen} docs", flush=True)
        if args.pace_every and kept % args.pace_every == 0:
            time.sleep(args.pace_sleep)
        if args.limit and kept >= args.limit:
            break
    print(f"stream: {kept} {args.machine} docs kept of {seen} parsed", flush=True)
    report(agg, started)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--share", help="capture dir, forward slashes: //host/d$/claudish-captures")
    ap.add_argument("--archive", help="day archive to STREAM (7zr e -so), e.g. //host/d$/claudish-captures/archive/captures-2026-10-15.7z — no disk extraction")
    ap.add_argument("--sevenz", default="7zr", help="path to 7zr executable")
    ap.add_argument("--day", help="capture day as it appears in filenames: 2026-10-15")
    ap.add_argument("--machine", help="x-claudish-machine value to keep")
    ap.add_argument("--limit", type=int, default=0, help="stop after N kept machine requests (0 = all)")
    ap.add_argument("--pace-every", type=int, default=10, help="pace the SMB pass: sleep every N files (0 = off)")
    ap.add_argument("--pace-sleep", type=float, default=0.05, help="pacing sleep in seconds")
    ap.add_argument("--selftest", action="store_true", help="run the synthetic form-coverage selftest, no SMB")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    if args.archive:
        if not args.machine:
            sys.exit("--archive requires --machine")
        run_archive(args)
        return
    if not (args.share and args.day and args.machine):
        sys.exit("--share, --day and --machine are required (or --selftest / --archive)")

    started = datetime.datetime.now(datetime.timezone.utc)
    print(f"run start (UTC): {started.isoformat()}", flush=True)

    names = []
    latest = ("", "")
    for n in os.listdir(args.share):
        if not n.startswith("req-") or f"-{args.day}T" not in n:
            continue
        names.append(n)
        m = NAME_TS_RE.search(n)
        if m:
            key = m.group(1) + "T" + m.group(2) + ":" + m.group(3) + ":" + m.group(4)
            latest = max(latest, (key, n))
    if not names:
        sys.exit(f"no req-* captures for {args.day} in {args.share}")
    print(f"corpus: {len(names)} req files for {args.day} (latest {latest[0]}Z)", flush=True)

    def pace(i):
        if args.pace_every and (i + 1) % args.pace_every == 0:
            time.sleep(args.pace_sleep)

    # Pass 1: head-read for machine attribution (envelope lives in the first bytes).
    kept = []
    for i, n in enumerate(sorted(names)):
        try:
            with open(os.path.join(args.share, n), encoding="utf-8", errors="replace") as f:
                head = f.read(512)
        except OSError as e:
            print(f"  headerr {n}: {e}", file=sys.stderr)
            continue
        m = MACHINE_RE.search(head)
        if m and m.group(1) == args.machine:
            kept.append((n, TS_RE.search(head), MODEL_RE.search(head)))
        if (i + 1) % 5000 == 0:
            print(f"  pass1 {i + 1}/{len(names)} kept={len(kept)}", flush=True)
        if args.limit and len(kept) >= args.limit:
            break
        pace(i)
    print(f"pass1: {len(kept)} {args.machine} requests", flush=True)

    # Pass 2: full read, extract citations + mobilization.
    agg = collections.defaultdict(lambda: {"req": 0, "mob": 0, "models": collections.Counter(),
                                           "mfiles": collections.Counter(), "cfiles": collections.Counter()})
    for i, (n, ts, mo) in enumerate(kept):
        try:
            with open(os.path.join(args.share, n), encoding="utf-8", errors="replace") as f:
                doc = json.load(f)
        except Exception as e:
            print(f"  jsonerr {n}: {e}", file=sys.stderr)
            continue
        cited, mobil = extract(doc)
        aggregate(agg, cited, mobil, mo.group(1) if mo else "?")
        if (i + 1) % 1000 == 0:
            print(f"  pass2 {i + 1}/{len(kept)}", flush=True)
        pace(i)

    report(agg, started)


if __name__ == "__main__":
    main()
