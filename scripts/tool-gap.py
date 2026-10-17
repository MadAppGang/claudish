#!/usr/bin/env python3
"""tool-gap.py -- approval-wait detector: the gap between a tool_use and its tool_result.

Why this exists
---------------
Mandate 2026-10-15 (ai-01:CoursIA, dashboard workspace-roo-extensions): an agent
instance spent ~1 h waiting for a permission prompt DESPITE bypass mode. The
roo-extensions volet reads client transcripts; THIS volet reads hub proxy
traffic, the only place where a wait is attributable to a machine, an entrypoint
and the command itself.

The measurement
---------------
Claude Code resends the WHOLE conversation on every request, so capture B holds
both the assistant `tool_use` (issued in turn A) and the user `tool_result`
answering it -- one file yields the command. Only the timeline needs two:

    ts(A) --[ generation ]--> resp_end(A) --[ approval + execution ]--> ts(B)

`resp-1-r<N>` is written at response CLOSE: its filename timestamp equals the
file mtime within ~50 ms (measured 2026-10-15 on 6 consecutive responses, spread
4-15 s), so it marks the end of generation. Hence, per session:

    delta = ts(B) - ts(A)            generation + wait + execution
    wait  = ts(B) - resp_end(A)      wait + execution        <-- the number that matters

A multi-minute `wait` around a command that is fast by nature cannot be
execution. `wait` is the mandate's "ecart long entre tool_use et tool_result"
with the model's own latency subtracted.

Reading rules
-------------
* A session that sits at an approval prompt emits NO capture until the user
  answers: the wait is only visible retrospectively, from the NEXT request.
* `resp_end(A)` is absent when the response was a relay passthrough or was
  never captured: those turns are reported with `wait = None`, never guessed.
* Denial markers are searched in a window around each `tool_result` marker --
  never over the message tail, which also carries the system prompt where the
  words "refus"/"rejected" occur for unrelated reasons (false positive measured
  on the first run: 6/6 flagged).
* `machine`, `entrypoint`, `session_id` are absent on pre-#98 captures: empty
  strings, never invented (trap measured on captures-2026-07-05).

Usage
-----
  python scripts/tool-gap.py --hours 24 --min-wait 120
  python scripts/tool-gap.py --hours 24 --min-wait 300 --json D:/tmp/gaps.json
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import statistics
import sys
import tempfile
import time

TAIL_BYTES = 320 * 1024
HEAD_BYTES = 4 * 1024

STAMP = r"(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z"
# Strict grammar: a loose pattern splits the timestamp itself and manufactures
# one "lane" per turn (trap measured 2026-10-09).
REQ_RE = re.compile(r"^req-1-(\d+)-" + STAMP + r"-")
RESP_RE = re.compile(r"^resp-1-r(\d+)-" + STAMP + r"-")

# Key order is NOT stable across clients: Claude Code writes
# {"type":"tool_result","tool_use_id":…}, others write
# {"tool_use_id":…,"type":"tool_result"}. Anchor on the marker, then read the
# id from a small window -- a fixed two-key sequence matched 2/1500 captures.
RESULT_MARK = re.compile(r'"type":"tool_result"')
USE_ID_ANY = re.compile(r'"tool_use_id":"([A-Za-z0-9_-]{6,64})"')
NAME_NEAR = re.compile(r'"name":"([^"]+)"')
# `session_id` rides inside `metadata.user_id`, itself a JSON *string*, so the
# quotes arrive escaped: match both spellings.
SESSION_ID = re.compile(r'session_id\\?":\\?"([0-9a-fA-F-]{8,64})')

# The friction shapes the mandate names -- composite commands, recursive delete,
# elevation, a shell launched outside the sandbox. A HYPOTHESIS column: these
# are what a human approves by hand, it is not a verdict.
RISK_PATTERNS = [
    ("rm-rf", re.compile(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\bRemove-Item\b[^\n]*-Recurse", re.I)),
    ("elevation", re.compile(r"-Verb\s+RunAs|\bsudo\b", re.I)),
    ("wsl-shell", re.compile(r"\bwsl(\.exe)?\b", re.I)),
    ("composite-cd", re.compile(r"\bcd\s+[^\n]*(&&|;)")),
    ("dotdot-path", re.compile(r"\.\./|\.\.\\\\")),
]

DENIAL = re.compile(
    r"doesn't want to proceed|user rejected|tool use was rejected|"
    r"Request interrupted by user|permission denied by user|"
    r"user doesn't want to take this action",
    re.I,
)

# Commands that are fast by nature: a multi-minute wait around one of these
# cannot be execution time.
FAST_HEADS = {
    "cd", "echo", "ls", "dir", "pwd", "cat", "head", "tail", "type", "which",
    "where", "set", "export", "true", "date", "whoami",
}


def stamp_to_dt(groups: tuple) -> dt.datetime:
    y, mo, d, hh, mm, ss, ms = (int(x) for x in groups)
    return dt.datetime(y, mo, d, hh, mm, ss, ms * 1000, tzinfo=dt.timezone.utc)


def read_slice(path: str) -> tuple[str, str]:
    """(head, tail) as text; decoding is lenient on both edges.

    Under TAIL_BYTES the whole file IS the tail: a `tail = head` shortcut here
    used to keep only the first HEAD_BYTES of every capture between 4 KiB and
    320 KiB, hiding the last tool_result and the metadata (re-review #474
    witness: a 435 B capture yielded its one line, the same capture padded to
    6 434 B yielded none and fell back to device: attribution).
    """
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        if size > TAIL_BYTES:
            head = fh.read(HEAD_BYTES).decode("utf-8", "replace")
            fh.seek(size - TAIL_BYTES)
            tail = fh.read().decode("utf-8", "replace")
        else:
            data = fh.read().decode("utf-8", "replace")
            head, tail = data, data
    return head, tail


def brace_scan(text: str, start: int, limit: int = 4096) -> str:
    """The balanced {...} at `start` (string/escape aware, bounded)."""
    if start < 0 or start >= len(text) or text[start] != "{":
        return ""
    depth = 0
    in_str = False
    esc = False
    for i in range(start, min(len(text), start + limit)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return ""


def envelope(head: str) -> dict:
    out = {}
    for key in ("src", "machine", "model", "entrypoint", "device_id8"):
        m = re.search(r'"%s":"([^"]*)"' % key, head)
        out[key] = m.group(1) if m else ""
    m = re.search(r'"pid":(\d+)', head)
    out["pid"] = int(m.group(1)) if m else 0
    return out


def trailing_calls(tail: str) -> tuple[list[dict], bool]:
    """Tool calls completed by the LAST user message, with their raw input."""
    last_user = tail.rfind('"role":"user"')
    if last_user < 0:
        return [], False
    scope = tail[last_user:]
    ids, denied = [], False
    for m in RESULT_MARK.finditer(scope):
        w = USE_ID_ANY.search(scope, max(0, m.start() - 200),
                              min(len(scope), m.start() + 200))
        if not w:
            continue
        ids.append(w.group(1))
        if DENIAL.search(scope[m.start():m.start() + 3000]):
            denied = True
    if not ids:
        return [], False
    calls = []
    for tid in ids:
        idx = tail.rfind('"id":"%s"' % tid)
        if idx < 0:
            calls.append({"id": tid, "name": "?", "input": ""})
            continue
        nm = None
        for m in NAME_NEAR.finditer(tail, max(0, idx - 400), idx + 400):
            nm = m.group(1)
        inp = tail.find('"input":', idx)
        raw = ""
        if 0 <= inp < idx + 400:
            brace = tail.find("{", inp)
            raw = brace_scan(tail, brace) if brace >= 0 else ""
        calls.append({"id": tid, "name": nm or "?", "input": raw})
    return calls, denied


# --- Redaction ---------------------------------------------------------------
#
# The command text is meant to be pasted on dashboards (the PR's own comment
# does it): a key passed on a fleet session's command line would end up
# published. Review #474 CHANGES_REQUESTED demonstrated exactly that with a
# synthetic `curl -H "x-api-key: sk-…"`. Every path out of this tool -- the
# top table AND --json -- goes through cmd_of(), so redacting there covers
# both. Over-masking is accepted by design (a 40-hex commit SHA is
# indistinguishable from a key and gets masked too); under-masking is not.
REDACTED = "<redacted>"

REDACT_RULES = [
    # URL userinfo: scheme://user:password@ -> scheme://<redacted>@
    # The scheme is BOUNDED ({0,31}): an unbounded `[a-z0-9+.-]*://` backtrack
    # made this rule quadratic -- redact("a"*50000) measured 12.7 s (3rd CR
    # #474), 55 s through cmd_of on 100 KB. Real schemes are <= 32 chars.
    (re.compile(r"([a-z][a-z0-9+.-]{0,31}://)([^/@\s:]{1,64}):([^/@\s]{1,128})@", re.I),
     r"\1" + REDACTED + r"@"),
    # Bearer/Basic <token> -- MUST run before the header rule: the header rule
    # masks a single token after the colon, which would eat the word "Bearer"
    # alone and leave the token exposed (caught by the selftest's JWT vector).
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"),
     r"\1 " + REDACTED),
    # named keys/headers carrying a value, in every quoting dialect a command
    # line or an embedded JSON blob produces: bare (token=v, token: v),
    # shell-quoted (token='v', token="v"), JSON ("token": "v", quoted name
    # included) and JSON embedded-then-escaped (\"token\": \"v\" -- the \" is
    # a literal two-char sequence inside an outer shell string, seen in --json
    # dumps). The quote groups each take an optional backslash before the
    # quote. camelCase twins (apiKey, accessToken...) join the snake/kebab
    # spellings; password/passwd/key/credential are part of the named family
    # (3rd CR #474: bare `password=` / `PASSWORD=` / `export PASSWORD=` leaked
    # -- the ENV rule needs >=1 prefix char before the keyword, and the named
    # rule did not carry these words).
    (re.compile(r"(?i)(\\?['\"]?)\b(x-api-key|x-proxy-key|api[_-]key|apiKey"
                r"|proxy[_-]key|api[_-]token|apiToken|access[_-]token|accessToken"
                r"|refresh[_-]token|refreshToken|id[_-]token|idToken"
                r"|authorization|token|secret|client[_-]secret|clientSecret"
                r"|access[_-]key|accessKey|password|passwd|key|credential)"
                r"\\?(['\"]?)(\s*[:=]\s*)(\\?['\"]?)[^\s'\",;)}\]]+"),
     r"\1\2\3\4\5" + REDACTED),
    # dashed flags carrying a keyword in their name: --xxx-secret[= :]value
    # (the = form overlaps the rule above only when the name is bare; space-
    # separated values need this one -- opaque-run rules miss values <40 chars)
    (re.compile(r"(?i)(--?[a-z0-9-]*(?:key|token|secret|passwd|password"
                r"|credential)[a-z0-9-]*)(\s*[=:]?\s*)(?:['\"]?)([^\s\"',;)]+)"),
     r"\1\2" + REDACTED),
    # KEY=/TOKEN=/SECRET=/... assignments (env style, quoted or bare)
    (re.compile(r"(?i)\b([A-Z][A-Z0-9_]{0,30}(?:KEY|TOKEN|SECRET|PASSWD|PASSWORD"
                r"|CREDENTIAL)[A-Z0-9_]{0,10})(=)(?:['\"]?)[^\s\"'&;)]+"),
     r"\1\2" + REDACTED),
    # provider key shapes
    (re.compile(r"\b(sk|rk)-[A-Za-z0-9_-]{8,}\b"), REDACTED),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b"), REDACTED),
    # opaque runs: any hex >= 32 (digests, most API keys), any run >= 40
    (re.compile(r"(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])"), REDACTED),
    (re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])"), REDACTED),
]


def redact(text: str) -> str:
    for rx, repl in REDACT_RULES:
        text = rx.sub(repl, text)
    return text


def cmd_of(call: dict) -> str:
    raw = call.get("input") or ""
    if not raw:
        return ""
    try:
        obj = json.loads(raw)
    except Exception:
        return redact(raw)[:400]
    if isinstance(obj, dict):
        for key in ("command", "file_path", "path", "pattern", "query", "url"):
            if key in obj:
                return redact(str(obj[key]))[:400]
        return redact(json.dumps(obj, ensure_ascii=False))[:400]
    return redact(str(obj))[:400]


def classify(call: dict, cmd: str) -> str:
    if call.get("name") != "Bash":
        return "tool:" + str(call.get("name") or "?")
    hits = [n for n, rx in RISK_PATTERNS if rx.search(cmd)]
    if hits:
        return "risk:" + "+".join(hits)
    head = (cmd.strip().split() or [""])[0].lower()
    if head in FAST_HEADS and len(cmd) < 120:
        return "fast"
    return "plain"


# Synthetic vectors: (text, secret substring that MUST NOT survive redaction).
# The second element doubles as the mutation guard -- the review asked for a
# "red mutation": if someone strips the redact() call, these tests must fail,
# and they only can if the unredacted text actually contains the secret.
SELFTEST_VECTORS = [
    ('curl -s https://api.example.com/v1 -H "x-api-key: sk-ant-api03-FAKE0123456789abcdef"',
     "sk-ant-api03-FAKE0123456789abcdef"),
    ('curl -H "Authorization: Bearer eyJhbGciOiJ9.fakepayload.sig55" https://host/x',
     "eyJhbGciOiJ9.fakepayload.sig55"),
    ('DEEPSEEK_API_KEY="sb-abcdef0123456789abcdef0123456789" python client.py',
     "sb-abcdef0123456789abcdef0123456789"),
    ('export GH_TOKEN=$(gh auth token -u lane) && gh api /user',
     "GH_TOKEN=$(gh"),
    ('curl https://user:hunter2secretpw@example.com/feed?q=1',
     "user:hunter2secretpw@example.com"),
    ('echo ghp_16CharsOfTokenExample0000 | docker login -p-stdin',
     "ghp_16CharsOfTokenExample0000"),
    # cross-review vectors: bare/lowercase names (value under every threshold,
    # so ONLY the named rule can catch it) and dashed flag with space-separated
    # value (non-hex, 39 chars -- under the opaque-run threshold on purpose)
    ('python cfg.py --config \'{"note":"token=AbCdEf123456789012345678"}\'',
     "AbCdEf123456789012345678"),
    ('app --client-secret Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9i start',
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9i"),
    # re-review vectors: quoted values and JSON separators (the named rule
    # used to EXCLUDE quote chars from the value, so a quote blocked the match
    # instead of delimiting it) -- 37-char non-hex values, under every
    # opaque-run threshold on purpose, only the named family can catch them.
    ("export token='Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9' && ./run.sh",
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9"),
    ('cfg = {"token": "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9", "n": 1}',
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9"),
    ('cfg = {"api_key": "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9", "n": 1}',
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9"),
    # 3rd-review vectors: bare password spellings (the ENV rule needs a prefix
    # char before the keyword, so `password=` alone is the named rule's job),
    # camelCase names, and the escaped-JSON form a --json dump carries.
    ("PASSWORD=Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9 ./deploy.sh",
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9"),
    ("password=Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9 curl https://x/y",
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9"),
    ('cfg = {"apiKey": "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9", "n": 1}',
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9"),
    ('run --config \'{\\"apiKey\\": \\"Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9\\"}\'',
     "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9"),
]


def selftest() -> int:
    failures = []
    for text, secret in SELFTEST_VECTORS:
        # teeth: the raw vector DOES carry the secret (else it pins nothing)
        if secret not in text:
            failures.append(f"vector broken, secret absent from raw text: {secret[:12]}…")
            continue
        masked = redact(text)
        if secret in masked:
            failures.append(f"LEAK: {secret[:12]}… survived redaction")
        if len(masked) < len(text) // 4:
            failures.append(f"over-masked to noise: {masked[:60]}")
    # pipeline: cmd_of is the single choke point for stdout AND --json
    call = {"id": "call_x", "name": "Bash",
            "input": '{"command":"curl -H \'x-api-key: sk-ant-api03-FAKE0123456789abcdef\' https://x"}'}
    out = cmd_of(call)
    if "sk-ant-api03-FAKE0123456789abcdef" in out:
        failures.append("LEAK: cmd_of pipeline emitted the key")
    if "curl" not in out:
        failures.append(f"pipeline lost the command shape: {out[:60]}")
    # E2E re-review vector: a JSON input with NO command/path key takes the
    # dict-fallback dump -- the --json path the re-review reached.
    call2 = {"id": "call_y", "name": "Bash",
             "input": '{"api_key": "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9", "note": "x"}'}
    out2 = cmd_of(call2)
    if "Zq7vKx2mNp4rTb8wYs3hJd5fGc6aLu1eRo9" in out2:
        failures.append("LEAK: dict-fallback dump emitted the api_key")
    if "api_key" not in out2:
        failures.append(f"fallback lost the shape: {out2[:60]}")
    # perf pin: the URL-userinfo rule used to backtrack quadratically on a
    # long scheme-shaped run -- redact("a"*50000) measured 12.7 s, 55 s
    # through cmd_of on 100 KB (3rd review #474). The scheme bound must keep
    # a 50 KiB pass under 1 s even on a busy machine.
    t0 = time.perf_counter()
    redact("a" * 50000)
    elapsed = time.perf_counter() - t0
    if elapsed >= 1.0:
        failures.append(f"redact 50 KiB took {elapsed:.2f}s (quadratic rule? bound the scheme)")
    # read_slice pin: an intermediate capture (4 KiB < size <= 320 KiB) with
    # its tool_result + metadata past the first 4 KiB must still yield its
    # call and session. Mutation guard: reverting the else-branch to
    # `tail = head` fails this (re-review witness: 6 434 B -> zero lines).
    with tempfile.TemporaryDirectory() as tmp:
        pad = '{"pad":"' + "x" * 4400 + '"},'
        body = ('{"machine":"myia-po-2025","model":"glm-5.3","entrypoint":"proxy",'
                '"device_id8":"abcd1234","pid":42,"messages":[' + pad
                + '{"role":"assistant","content":[{"id":"toolu_01PINNED","name":"Bash",'
                  '"input":{"command":"echo pinned"}}]},'
                + '{"role":"user","content":[{"type":"tool_result",'
                  '"tool_use_id":"toolu_01PINNED","content":"ok"}]}],'
                + '"metadata":{"user_id":"...\\"session_id\\":\\"a1b2c3d4e5f6a7b8\\""}}')
        path = os.path.join(tmp, "req-1-999-2026-10-16T00-00-00-000Z-openai-glm-5.3.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
        head, tail = read_slice(path)
        if len(body) <= HEAD_BYTES or not tail.endswith('a7b8\\""}}'):
            failures.append(f"slice pin broken: body shape/size changed ({len(body)} B)")
        else:
            calls, _denied = trailing_calls(tail)
            if not calls or calls[0]["id"] != "toolu_01PINNED" \
                    or calls[0]["name"] != "Bash" or "echo pinned" not in calls[0]["input"]:
                failures.append("read_slice lost markers past 4 KiB (tail = head regression?)")
            hits = list(SESSION_ID.finditer(tail))
            if not hits or hits[-1].group(1) != "a1b2c3d4e5f6a7b8":
                failures.append("read_slice lost the metadata session_id past 4 KiB")
    if failures:
        for f in failures:
            print(f"selftest FAIL: {f}")
        return 1
    print(f"selftest OK: {len(SELFTEST_VECTORS)} vectors redacted, pipeline clean, "
          f"slice pin held")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=r"D:\claudish-captures")
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--min-wait", type=float, default=120.0, help="seconds")
    ap.add_argument("--max-gen", type=float, default=7200.0,
                    help="plausible ceiling on generation time, seconds")
    ap.add_argument("--limit", type=int, default=0, help="cap files (0 = all)")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--selftest", action="store_true",
                    help="pin the redaction on synthetic inputs, then exit")
    ap.add_argument("--session", default="", help="session_id prefix (follow one instance)")
    ap.add_argument("--machine", default="", help="exact machine name, e.g. myia-ai-01")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    now = dt.datetime.now(dt.timezone.utc)
    floor = now - dt.timedelta(hours=args.hours)

    # resp_end: request number -> EVERY response end carrying that number, sorted.
    #
    # The request number is NOT unique across the corpus: it is a per-process
    # counter, so a hub recreate restarts it (measured 2026-10-15: req 36324 at
    # 01:02Z, req 7213 at 08:57Z). Keying by number alone therefore pairs a
    # request with the response of an OLDER epoch -- which manufactured a block
    # of impossible "wait ~12 000 s with delta 8 s" rows on this tool's first
    # full run. The response must be the first one at or after its own request.
    resp_end: dict[int, list[dt.datetime]] = collections.defaultdict(list)
    for p in glob.glob(os.path.join(args.root, "resp-1-r*.sse")):
        m = RESP_RE.match(os.path.basename(p))
        if m:
            try:
                resp_end[int(m.group(1))].append(stamp_to_dt(m.groups()[1:]))
            except ValueError:
                pass
    for v in resp_end.values():
        v.sort()

    work = []
    for p in glob.glob(os.path.join(args.root, "req-*.json")):
        m = REQ_RE.match(os.path.basename(p))
        if not m:
            continue
        try:
            when = stamp_to_dt(m.groups()[1:])
        except ValueError:
            continue
        if when >= floor:
            work.append((when, int(m.group(1)), os.path.basename(p)))
    work.sort()
    if args.limit:
        work = work[-args.limit:]

    print(f"corpus: {len(work)} captures in the last {args.hours}h "
          f"(resp_end index: {len(resp_end)} responses)", file=sys.stderr)

    per_session: dict[str, list] = collections.defaultdict(list)
    records: dict[str, dict] = {}
    no_session = 0
    for when, num, name in work:
        try:
            head, tail = read_slice(os.path.join(args.root, name))
        except OSError:
            continue
        env = envelope(head)
        if args.machine and env.get("machine") != args.machine:
            continue
        # LAST match, never the first: a session_id can be CITED inside a
        # message body (a traffic-analysis session quotes ids constantly), and
        # the head of the tail slice is mid-conversation. `metadata` sits at the
        # very end of the body, so the last match is the real one -- the trap
        # that mis-attributed 14 captures on 2026-10-09 (see memory T6-bis).
        hits = list(SESSION_ID.finditer(tail))
        sid = hits[-1].group(1) if hits else ""
        if not sid:
            no_session += 1
            sid = "device:" + (env.get("device_id8") or "?")
        if args.session and not sid.startswith(args.session):
            continue
        per_session[sid].append((when, num, name))
        calls, denied = trailing_calls(tail)
        if calls:
            records[name] = {"env": env, "calls": calls, "denied": denied}

    gaps = []
    no_resp = 0
    for sid, items in per_session.items():
        items.sort()
        # A session's own rhythm separates the two populations that a raw wait
        # cannot: a session that was WORKING and stalled (approval) versus a
        # session that was IDLE for hours and merely resumed (a cron wake-up,
        # a user coming back). Measured on the first full run: the 15 401 s and
        # 13 785 s rows were both resumptions -- the sessions' surrounding
        # deltas were of the same order.
        deltas = [(items[i][0] - items[i - 1][0]).total_seconds()
                  for i in range(1, len(items))]
        rhythm = statistics.median(deltas) if deltas else 0.0
        for i in range(1, len(items)):
            prev, cur = items[i - 1], items[i]
            rec = records.get(cur[2])
            if not rec:
                continue
            end = next((t for t in resp_end.get(prev[1], ()) if t >= prev[0]), None)
            if end is not None and (end - prev[0]).total_seconds() > args.max_gen:
                end = None  # implausible generation: not this request's response
            wait = (cur[0] - end).total_seconds() if end else None
            if wait is None:
                no_resp += 1
                continue
            if wait < args.min_wait:
                continue
            for call in rec["calls"]:
                cmd = cmd_of(call)
                gaps.append({
                    "ts": cur[0].isoformat(),
                    "wait_s": round(wait, 1),
                    "delta_s": round(deltas[i - 1], 1),
                    "rhythm_s": round(rhythm, 1),
                    "ratio": round(wait / rhythm, 1) if rhythm else None,
                    "machine": rec["env"]["machine"],
                    "entrypoint": rec["env"]["entrypoint"],
                    "session": sid[:8],
                    "tool": call["name"],
                    "class": classify(call, cmd),
                    "cmd": cmd,
                    "denied": rec["denied"],
                })

    gaps.sort(key=lambda g: -g["wait_s"])
    print(f"captures with a trailing tool_result: {len(records)}")
    print(f"captures without session_id (device_id8 fallback): {no_session}")
    print(f"boundaries skipped for want of a resp_end: {no_resp}")
    print(f"\n=== waits >= {args.min_wait:.0f}s : {len(gaps)} ===")
    print("by class:", dict(collections.Counter(g["class"].split(":")[0] for g in gaps)))
    print("by machine:", dict(collections.Counter(g["machine"] or "(empty)" for g in gaps)))
    print(f"explicit denials among them: {sum(1 for g in gaps if g['denied'])}")
    # The population the mandate is after: a session that was ALREADY in rhythm
    # and then stalled. A resumption after hours of idleness is not a wait.
    stalled = [g for g in gaps if g["ratio"] and g["ratio"] >= 5]
    print(f"waits on a session in rhythm (wait / own median >= 5): {len(stalled)}")
    print("  by class:", dict(collections.Counter(g["class"].split(":")[0] for g in stalled)))
    print("  by machine:", dict(collections.Counter(g["machine"] or "(empty)" for g in stalled)))

    print(f"\n=== top {args.top} ===")
    for g in gaps[:args.top]:
        flag = " DENIED" if g["denied"] else ""
        print(f"[{g['ts'][11:19]}] wait {g['wait_s']:>7.0f}s (delta {g['delta_s']:>7.0f}s, "
              f"rythme {g['rhythm_s']:>6.0f}s, x{g['ratio'] if g['ratio'] else 0:>5.1f})  "
              f"{g['machine']:<14} {g['entrypoint']:<14} {g['session']}  "
              f"{g['tool']:<8} {g['class']:<22}{flag}")
        if g["cmd"]:
            print(f"            {g['cmd'][:180]}")

    if args.json:
        out_dir = os.path.dirname(args.json)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"generated": now.isoformat(), "min_wait_s": args.min_wait,
                       "hours": args.hours, "count": len(gaps), "gaps": gaps},
                      fh, ensure_ascii=False, indent=1)
        print(f"\njson -> {args.json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
