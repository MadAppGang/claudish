#!/usr/bin/env python
"""#295 post-deploy measurement: does the MiniMax thinking CHAIN restart?

Counts, over a bounded window of hub captures, on the MiniMax lane:

  (a) the share of resp-* SSE responses carrying a thinking block
      (pre-#324 baseline: 1/30, measured 2026-10-02);
  (b) the share of tool-continuation req-* bodies whose PRECEDING assistant
      turn carries a thinking block -- hypothesis 1 of #295 ("CC does not
      echo the blocks") measured directly;
  (c) is NOT measurable here: the [ComposedHandler] Preserved lines live in
      the hub's docker logs, not in the captures -- one-liner for the hub
      owner instead: docker logs <hub> 2>&1 | grep -c "Preserved .* own thinking".

The window is bounded by the post-#324 recreate's StartedAt (verified live
2026-10-05: 09:46:24Z, uptimeSec read from /health). Run once on the last
pre-#324 day to validate the instrument against the known 1/30 baseline
(negative control), then on the window archives once they land.

Traps (each inherited from a sibling script or measured here):
  1. Solid 7z archives make per-FILE selective reads brutal -- but ONE
     targeted extraction is cheap: list first (py7zr.getnames()), compute the
     targets from the NAMES (the model rides the resp filename; reqN and ts
     ride both), then extract(targets=...) once -- the solid blocks are
     decompressed once and only the ~1 GB useful set is written (measured
     2026-10-04: 75 726 files / 26.4 GB in the archive, 1 383 MiniMax resps
     (7.3 MB) + ~0.9 GB of pairable reqs). A full extractall costs 26 GB of
     scratch per day of archive and a kill leaves it behind (the finally
     never runs). --scratch picks the disk.
  2. On the containerized hub pid is ALWAYS 1 and every restart resets reqN
     under the same pid: pair per FILE, never by (pid, reqN) alone. See
     trap 8 for the window.
  3. The served model rides the resp FILENAME (...-anthropic-MiniMax-M3.sse)
     and the resp header line (# parser=... model=... reqN=N pid=P); req
     filenames carry no model -- lane attribution is by pairing only.
  4. A req whose resp never captured cannot be lane-attributed: excluded
     from (b)'s denominator, counted separately (never silently dropped).
  5. Bodies are JSON but must never crash the scan: a file that fails to
     parse counts as unparsed, and string-level fallbacks keep the counters
     honest for oversized or truncated captures.
  6. req-* captures are ENVELOPES, not raw request bodies (request-logger.ts
     writes {ts, src, machine, model, pid, ...attribution, body}) -- read
     `messages` from env["body"], never from the top level. First baseline run
     measured this the hard way: (b) printed 0/0 with every file silently
     skipped. Every skip path is now counted (gate counters below).
  7. The req filename tail (safeSrc) holds dotted WAN IPs for external
     callers, not just word-char labels -- 4887 of 38247 reqs on 2026-10-04.
  8. Pairing must be DIRECTIONAL (resp ts >= req ts, within the 600s client
     timeout + margin): the hub's reqN resets per restart while pid stays 1,
     so symmetric windows mis-pair a foreign-lane continuation onto a MiniMax
     resp and pollute (b) with thinking the client DID receive elsewhere.
     And the pairing is TWO-PASS and resp-anchored (#295 review 06/10): EACH
     RESP goes to the request of MINIMAL dt inside its same-reqN [0, +11 min]
     window. The first cut walked the reqs in os.listdir order and let each
     claim its closest FOLLOWING resp -- a FAR req sorting first stole the
     resp of a NEAR one, and the loser left the denominator as `ambiguous`.
     One-for-one per resp by construction; deterministic (ties break on the
     name sort), independent of directory enumeration order. A req that wins
     >=1 resp enters (b) exactly once; a req that had a candidate window but
     never won counts `ambiguous_pair`; a req with no candidate at all counts
     `unpaired`. Measured on the 04/10 listing: 1 353 resps with exactly 1
     candidate, 30 with 2, 0 with 0 (the reqN counter reset 5x that day).
     Also: 1 352/1 383 = 97.8% of MiniMax resps pair to a tool-continuation
     -- the shape of an agentic role; do NOT read that share against the
     all-lane continuation rate.
  9. Targeted extraction changes what the req-side gate counters MEAN: only
     reqs that COULD pair a selected resp are extracted, so
     `req_out_of_window` / `req_continuation_unpaired` count within the
     extracted (pre-filtered) set, not the archive's full req population.
     `--dir` on a full extraction restores the population-wide counts.

Usage:
  python scripts/minimax-chain-measure.py --archive "G:\\...\\captures-2026-10-04.7z" \
      [--since 2026-10-05T09:46:24Z] [--until ...] [--model-substr MiniMax] [--json out.json] \
      [--scratch D:\\big-disk-temp]
  # or point straight at an extracted/loose capture dir:
  python scripts/minimax-chain-measure.py --dir D:\\claudish-captures --since ...
"""

import argparse
import bisect
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

# safeSrc is \w+ for internal labels (direct/openai) but holds dotted WAN IPs
# for external callers (req-1-0002-...-90.65.170.144__90.65.170.144_47131.json
# -- 4887 of 38247 reqs on captures-2026-10-04), so the tail class must accept
# dots and underscores.
REQ_RE = re.compile(r"^req-(\d+)-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-\d+Z-([A-Za-z0-9_.]+)\.json$")
RESP_RE = re.compile(r"^resp-(\d+)-r(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-\d+Z-(\w+)-(.+)\.sse$")
TS_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})")
RESP_HDR_REQN = re.compile(r"reqN=(\d+)")
# resp ts = stream close: a resp can only follow its req, and the client's
# 600s timeout caps the stream -- 11 min covers the cap with margin.
PAIR_FORWARD = timedelta(minutes=11)


def parse_ts(s):
    m = TS_RE.search(s)
    if not m:
        return None
    y, mo, d, h, mi, se = (int(x) for x in m.groups())
    return datetime(y, mo, d, h, mi, se, tzinfo=timezone.utc)


def parse_iso(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def extract_spec(since, until, model_substr):
    """The marker payload: what this dir was extracted FOR. A targeted
    extraction is complete only for its own (window, lane) -- a marker that
    does not name its target asserts a completeness it does not carry
    (review of 77a96b10, bloquant 2)."""
    return {
        "since": since.isoformat() if since else None,
        "until": until.isoformat() if until else None,
        "model": model_substr,
    }


def extract_complete(d, spec=None, trust_unmarked=False):
    """True only for a dir whose TARGETED extraction FINISHED, for THIS spec.

    The marker carries the extraction target as one JSON line (extract_spec);
    a marker for another window/lane means the dir was extracted for a
    different question and must be re-extracted, not reused. Same guard shape
    as compaction-trend.extract_complete otherwise -- `isdir and listdir`
    accepted a partial extraction left by a killed run as complete (incident
    detail in compaction-trend.py), and a dir without a marker now means
    RE-EXTRACT, the both-member-patterns fallback surviving only behind
    --trust-unmarked with one stderr line per dir accepted that way."""
    mp = os.path.join(d, ".extract-complete")
    if os.path.isfile(mp):
        if spec is None:
            return True
        try:
            with open(mp, encoding="utf-8") as f:
                marked = json.loads(f.read().strip() or "null")
        except (OSError, ValueError):
            return False
        return marked == spec
    if not trust_unmarked:
        return False
    try:
        names = os.listdir(d)
    except OSError:
        return False
    ok = (any(n.startswith("req-") and n.endswith(".json") for n in names)
          and any(n.startswith("resp-") and n.endswith(".sse") for n in names))
    if ok:
        print("trust-unmarked: accepting %s without .extract-complete" % d,
              file=sys.stderr)
    return ok


def extract_archives(archives, scratch_root, since, until, model_substr,
                     trust_unmarked=False):
    """Targeted extraction: LIST first, compute the targets from the NAMES
    (the model rides the resp filename; reqN + ts ride both), then one
    extract(targets=...) per archive -- the solid blocks decompress once and
    only the useful set is written (measured 2026-10-04: 26.4 GB packed vs
    ~1 GB useful). A req name is a target iff it COULD pair a selected resp:
    same reqN, ts in [resp_ts - PAIR_FORWARD, resp_ts] (11 min backwards --
    the lane map is built from the listing, so pairing is pre-computed from
    names alone)."""
    try:
        import py7zr
    except ImportError:
        sys.exit("py7zr is required for --archive (pip install --user py7zr)")
    spec = extract_spec(since, until, model_substr)
    dirs = []
    for a in archives:
        dest = os.path.join(scratch_root, os.path.splitext(os.path.basename(a))[0])
        if extract_complete(dest, spec=spec, trust_unmarked=trust_unmarked):
            dirs.append(dest)
            continue
        os.makedirs(dest, exist_ok=True)
        with py7zr.SevenZipFile(a, mode="r") as z:
            names = z.getnames()
            # selected resps: lane filter + window, from names alone
            resp_sel = []  # (reqn, ts)
            for n in names:
                base = os.path.basename(n)
                m = RESP_RE.match(base)
                if not m or model_substr.lower() not in base.lower():
                    continue
                ts = parse_ts(m.group(3))
                if ts is None or (since and ts < since) or (until and ts > until):
                    continue
                resp_sel.append(((m.group(2) or "0").lstrip("0") or "0", ts))
            targets = set()
            for n in names:
                base = os.path.basename(n)
                rm = RESP_RE.match(base)
                if rm and model_substr.lower() in base.lower():
                    ts = parse_ts(rm.group(3))
                    if ts and (not since or ts >= since) and (not until or ts <= until):
                        targets.add(n)
                    continue
                qm = REQ_RE.match(base)
                if not qm:
                    continue
                qts = parse_ts(qm.group(3))
                if qts is None or (since and qts < since) or (until and qts > until):
                    continue
                reqn = (qm.group(2) or "0").lstrip("0") or "0"
                for rreqn, rts in resp_sel:
                    if rreqn == reqn and 0 <= (rts - qts).total_seconds() <= PAIR_FORWARD.total_seconds():
                        targets.add(n)
                        break
            print("extracting %d target files of %d ..." % (len(targets), len(names)))
            z.extract(path=dest, targets=sorted(targets))
        with open(os.path.join(dest, ".extract-complete"), "w",
                  encoding="utf-8") as f:
            json.dump(spec, f)
        dirs.append(dest)
    return dirs


def scan(dirs, since, until, model_substr):
    total_resp = carriers = 0
    unparsed_resp = 0
    # lane map: reqN -> [resp ts] (model already filtered by filename)
    lane_reqn_ts = {}
    for d in dirs:
        for name in os.listdir(d):
            m = RESP_RE.match(name)
            if not m or model_substr.lower() not in name.lower():
                continue
            ts = parse_ts(m.group(3))
            if ts is None or (since and ts < since) or (until and ts > until):
                continue
            total_resp += 1
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8", errors="replace") as f:
                    body = f.read()
            except OSError:
                unparsed_resp += 1
                continue
            # a thinking block on the wire: a thinking_delta event, or a
            # content_block_start whose block type is thinking (the unfiltered
            # #324 shape emits both; the filtered pre-#324 shape emits neither)
            if '"thinking_delta"' in body or '"type":"thinking"' in body or '"type": "thinking"' in body:
                carriers += 1
            reqn = m.group(2)
            hdr = RESP_HDR_REQN.search(body[:400])
            if hdr:
                reqn = hdr.group(1).lstrip("0") or "0"
            lane_reqn_ts.setdefault(reqn.lstrip("0") or "0", []).append(ts)

    total_cont = cont_with_thinking = unpaired_cont = unparsed_req = 0
    cont_sig64 = cont_sig_unsigned = cont_sig_foreign = 0
    ambiguous_pair = 0
    # gate counters: every skip path is COUNTED, never silent -- a 0/0 (b) that
    # is really "the parser never saw a continuation" must be loud (the exact
    # defect this field set catches: the first baseline run printed (b) 0/0 with
    # all skips silent because the envelope was read as the body).
    req_name_mismatch = req_out_of_window = req_no_toolresult = req_shape_skip = 0
    # TWO-PASS pairing (#295 review 06/10). The first cut walked the reqs in
    # os.listdir order and let each claim its closest FOLLOWING resp: a FAR req
    # sorting first stole the resp of a NEAR one (dt-minimal), and the loser
    # left the denominator as `ambiguous`. The rule is resp-anchored: EACH RESP
    # goes to the request of MINIMAL dt inside its same-reqN [0, +11 min]
    # window -- deterministic (ties break on the name sort), independent of
    # directory enumeration order, one-for-one per resp by construction. A req
    # that wins >=1 resp enters (b) exactly once; a req that had a candidate
    # window but never won counts `ambiguous_pair`; a req with no candidate at
    # all counts `unpaired`.
    conts = []  # (reqn, ts, name, msgs) -- valid continuations, unpaired yet
    for d in dirs:
        for name in os.listdir(d):
            if name.startswith("req-") and not REQ_RE.match(name):
                req_name_mismatch += 1
            m = REQ_RE.match(name)
            if not m:
                continue
            ts = parse_ts(m.group(3))
            if ts is None or (since and ts < since) or (until and ts > until):
                req_out_of_window += 1
                continue
            # cheap prefilter on the raw text: a tool_result block must exist
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8", errors="replace") as f:
                    raw = f.read()
            except OSError:
                unparsed_req += 1
                continue
            if '"tool_result"' not in raw:
                req_no_toolresult += 1
                continue
            try:
                env = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                unparsed_req += 1
                continue
            # req-* captures are ENVELOPES (request-logger.ts: {ts, src,
            # machine, model, pid, ...attribution, body}) -- the request itself
            # lives under `body`. Reading `messages` at the top level returned
            # None for every file and skipped them all silently.
            body = env.get("body") if isinstance(env, dict) and isinstance(env.get("body"), dict) else env
            msgs = body.get("messages") if isinstance(body, dict) else None
            if not isinstance(msgs, list) or not msgs:
                req_shape_skip += 1
                continue
            last = msgs[-1]
            if not isinstance(last, dict) or last.get("role") != "user":
                req_shape_skip += 1
                continue
            content = last.get("content")
            blocks = content if isinstance(content, list) else []
            if not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
                req_shape_skip += 1
                continue
            # tool-continuation shape confirmed -- pass 2 pairs it.
            reqn = (m.group(2) or "0").lstrip("0") or "0"
            conts.append((reqn, ts, name, msgs))

    # pass 2 (assignment): group the continuations per reqN, sorted by
    # (ts, name) -- a resp's candidate window is a contiguous slice of that
    # sorted list, and its winner is the LAST entry of the slice (latest ts =
    # minimal dt; the name sort breaks dt ties deterministically).
    order = sorted(range(len(conts)), key=lambda i: (conts[i][1], conts[i][2]))
    by_reqn = {}
    for i in order:
        by_reqn.setdefault(conts[i][0], []).append(i)
    won = set()
    had_candidate = set()
    for reqn, rlist in lane_reqn_ts.items():
        idxs = by_reqn.get(reqn)
        if not idxs:
            continue
        tss = [conts[i][1] for i in idxs]
        for rts in rlist:
            lo = bisect.bisect_left(tss, rts - PAIR_FORWARD)
            hi = bisect.bisect_right(tss, rts)
            if hi <= lo:
                continue
            had_candidate.update(idxs[lo:hi])
            won.add(idxs[hi - 1])

    for i in order:
        if i not in had_candidate:
            unpaired_cont += 1
            continue
        if i not in won:
            ambiguous_pair += 1
            continue
        total_cont += 1
        msgs = conts[i][3]
        # the preceding assistant turn: last assistant message before the
        # final user turn
        prev_asst = next((x for x in reversed(msgs[:-1]) if isinstance(x, dict) and x.get("role") == "assistant"), None)
        if prev_asst is None:
            continue
        pc = prev_asst.get("content")
        pblocks = pc if isinstance(pc, list) else ([{"type": "text", "text": str(pc)}] if isinstance(pc, str) else [])
        # signature split, THREE-way (the two-way "MiniMax-shaped" split was
        # measured wrong on the sample): 64-lowercase-hex = decisively
        # MiniMax (M3's implicit e3b0c442..., M2.5's varying digests);
        # base64 blob = decisively foreign (Anthropic-shaped); UNSIGNED =
        # ambiguous -- the OpenAI->Anthropic converter synthesizes unsigned
        # thinking blocks for GLM/Qwen/DeepSeek too, and a GLM-nominal
        # sonnet session that fell to MiniMax carries them legitimately.
        # (b)'s MiniMax-chain signal is the 64-hex count; unsigned is
        # reported, never claimed.
        MINIMAX_SIG = re.compile(r"^[0-9a-f]{64}$")
        for b in pblocks:
            if not (isinstance(b, dict) and b.get("type") == "thinking"):
                continue
            sig = b.get("signature")
            if isinstance(sig, str) and sig:
                if MINIMAX_SIG.match(sig):
                    cont_sig64 += 1
                else:
                    cont_sig_foreign += 1
            else:
                cont_sig_unsigned += 1
            break
        if any(isinstance(b, dict) and b.get("type") == "thinking" for b in pblocks):
            cont_with_thinking += 1

    return {
        "resp_total": total_resp,
        "resp_thinking_carriers": carriers,
        "resp_unparsed": unparsed_resp,
        "req_tool_continuation_paired": total_cont,
        "req_continuation_ambiguous_pair": ambiguous_pair,
        "req_continuation_prev_asst_thinking": cont_with_thinking,
        "req_continuation_unpaired": unpaired_cont,
        "req_continuation_prev_asst_thinking_sig64_minimax": cont_sig64,
        "req_continuation_prev_asst_thinking_sig_unsigned_ambiguous": cont_sig_unsigned,
        "req_continuation_prev_asst_thinking_sig_foreign_base64": cont_sig_foreign,
        "req_unparsed": unparsed_req,
        "req_name_mismatch": req_name_mismatch,
        "req_out_of_window": req_out_of_window,
        "req_no_toolresult": req_no_toolresult,
        "req_shape_skip": req_shape_skip,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--archive", action="append", default=[], help="7z archive path (repeatable)")
    ap.add_argument("--dir", action="append", default=[], help="loose/extracted capture dir (repeatable)")
    ap.add_argument("--since", help="ISO 8601 lower bound (window start, e.g. the recreate StartedAt)")
    ap.add_argument("--until", help="ISO 8601 upper bound")
    ap.add_argument("--model-substr", default="MiniMax", help="lane filter on the resp filename (default MiniMax)")
    ap.add_argument("--json", help="write the result JSON here")
    ap.add_argument("--scratch", help="scratch disk/dir for the extraction (default: system temp)")
    ap.add_argument("--keep", action="store_true", help="keep the extraction scratch dir (default: removed)")
    ap.add_argument("--trust-unmarked", action="store_true",
                    help="accept a pre-marker extraction dir on both member "
                         "patterns (one stderr line per dir accepted); default "
                         "re-extracts any unmarked or wrong-spec dir")
    args = ap.parse_args()

    if not args.archive and not args.dir:
        ap.error("need at least one --archive or --dir")

    since, until = parse_iso(args.since), parse_iso(args.until)
    scratch = None
    dirs = list(args.dir)
    try:
        if args.archive:
            scratch = tempfile.mkdtemp(prefix="mm-chain-", dir=args.scratch)
            dirs.extend(extract_archives(args.archive, scratch, since, until,
                                         args.model_substr,
                                         trust_unmarked=args.trust_unmarked))
        res = scan(dirs, since, until, args.model_substr)
    finally:
        if scratch and not args.keep:
            shutil.rmtree(scratch, ignore_errors=True)

    rt, rc = res["resp_total"], res["resp_thinking_carriers"]
    ct, cc = res["req_tool_continuation_paired"], res["req_continuation_prev_asst_thinking"]
    print("MiniMax lane (%s), window %s -> %s" % (
        args.model_substr,
        since.isoformat() if since else "(start of data)",
        until.isoformat() if until else "(end of data)",
    ))
    print("(a) responses carrying a thinking block : %d/%d = %.1f%%  (pre-#324 baseline: 1/30 = 3.3%%)" % (
        rc, rt, (100.0 * rc / rt) if rt else 0.0))
    print("(b) tool-continuations whose PREVIOUS assistant turn carries thinking : %d/%d = %.1f%%" % (
        cc, ct, (100.0 * cc / ct) if ct else 0.0))
    print("    signature split of those: sig64(MiniMax-own) = %d ; unsigned(AMBIGUOUS: GLM/Qwen synth too) = %d ; base64(foreign) = %d" % (
        res["req_continuation_prev_asst_thinking_sig64_minimax"],
        res["req_continuation_prev_asst_thinking_sig_unsigned_ambiguous"],
        res["req_continuation_prev_asst_thinking_sig_foreign_base64"]))
    print("    unpaired continuations (no MiniMax resp to attribute the lane): %d ; lost-to-closer (had a candidate resp, a nearer req won it): %d ; unparsed req/resp: %d/%d" % (
        res["req_continuation_unpaired"], res["req_continuation_ambiguous_pair"], res["req_unparsed"], res["resp_unparsed"]))
    print("    req gate skips: name_mismatch=%d out_of_window=%d no_toolresult=%d shape=%d (all paths counted, none silent)" % (
        res["req_name_mismatch"], res["req_out_of_window"], res["req_no_toolresult"], res["req_shape_skip"]))
    print("(c) [ComposedHandler] Preserved lines: docker logs only -- not in captures (hub owner greps)")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2)
        print("json -> %s" % args.json)


if __name__ == "__main__":
    main()
