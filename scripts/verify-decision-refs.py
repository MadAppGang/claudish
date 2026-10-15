#!/usr/bin/env python3
"""verify-decision-refs.py -- #445 option (b): every backticked symbol in a
decision-layer doc must resolve somewhere real.

Why this exists
---------------
The condensation passes (#449 A1+A2, skill slimming) moved detail out of the
always-loaded layer (`CLAUDE.md`, worker `SKILL.md`) into pointer docs. A
pointer layer drifts silently: a renamed function, a removed env flag or a
deleted doc leaves a backticked token that points at nothing. This script is
the mechanical half of the review -- it extracts every backticked token from a
doc, classifies it, and verifies it against two corpora:

  CODE  -- production sources, tests, scripts, package manifests, env template
  DOCS  -- the markdown files the doc itself points at (its "detail layer"),
           plus the doc itself

A token found in neither is reported with its line number. Exit 1 when any
token is unverified, so a caller can gate on it.

It is a detector, not an adjudicator: model ids, route examples and upstream
names can legitimately live only in an issue body. Every hit is read by a
human before a fix.

Positive control
----------------
`--selftest` runs the verifier on an embedded fixture doc that pairs two real
references with three deliberately false ones (`resolveEverythingMagically`,
`CLAUDISH_IMAGINARY_FLAG_XYZ`, `CLAUDISH_CHANNEL_IMAGINARY_XYZ` -- the last one
guards the placeholder skip against swallowing real names). The selftest FAILS (exit 2) unless exactly the
false pair goes red and the real pair passes -- a verifier that cannot go red
certifies nothing (invariant: positive control on every counter).

Usage
-----
  python -I scripts/verify-decision-refs.py CLAUDE.md [.claude/skills/worker/SKILL.md ...]
  python -I scripts/verify-decision-refs.py --selftest
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# --- corpora ---------------------------------------------------------------

CODE_GLOBS = [
    "packages/cli/src/**/*.ts",
    "packages/cli/src/**/*.js",
    "packages/cli/package.json",
    "package.json",
    "scripts/**/*.py",
    "scripts/**/*.ps1",
    ".env.sidecar.example",
]

TOKEN_RE = re.compile(r"`([^`\n]+)`")
LINK_RE = re.compile(r"\]\(([^)\s]+)\)")

# Tokens adjudicated as external BY DESIGN -- runtime artifacts, user-machine
# files, or another repo's vocabulary. They can never resolve inside this repo
# and flagging them every run would only train readers to ignore the output.
EXTERNAL_ALLOWLIST = {
    "web.config",           # IIS config on the fleet's Windows machines
    "drain.log",            # runtime artifact written by claudish-drain.ps1
    ".mcp.json",            # user-home MCP config, never committed
    "GAP",                  # claudish_traffic MCP vocabulary (roo-state-manager repo)
    "scheduled_tasks.lock", # deliberately machine-local (gitignored harness state)
    ".test-strict-baseline.json",  # per-machine gitignored snapshot (#175): the
                                   # failing population is seat-dependent BY
                                   # DESIGN and must never be committed
    "compaction.log",       # runtime artifact of the nightly capture compaction
    "memory/open-questions-ledger.md",  # per-workspace memory file under
                                        # ~/.claude/projects/<hash>/ -- cited by
                                        # the global harness rules, not this repo
    "MEMORY.md",               # index of the same per-workspace memory dir
    "baseRefName",             # GitHub GraphQL schema field (gh pr view)
    "mergeStateStatus",        # GitHub GraphQL schema field (gh pr view)
    "CronList",               # Claude Code built-in tool (session scheduler)
}


def build_code_corpus() -> str:
    self_path = Path(__file__).resolve()
    parts: list[str] = []
    for pattern in CODE_GLOBS:
        for path in sorted(REPO_ROOT.glob(pattern)):
            # The verifier's own source carries the selftest fixtures -- a
            # corpus that contains them would certify its own false tokens.
            if path.is_file() and path.resolve() != self_path:
                try:
                    parts.append(path.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    pass
    return "\n".join(parts)


def build_docs_corpus(doc_paths: list[Path]) -> str:
    """Concatenate the docs the input docs point at (their detail layer).

    The input docs themselves are deliberately NOT part of the corpus: every
    backticked token is by construction a substring of its own doc, so a
    self-inclusive corpus would verify everything and catch nothing.
    """
    parts: list[str] = []
    seen: set[Path] = set()
    for doc in doc_paths:
        text = doc.read_text(encoding="utf-8", errors="replace")
        for target in LINK_RE.findall(text):
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            target = target.split("#")[0]
            if not target:
                continue
            resolved = (doc.parent / target).resolve()
            if resolved.is_file() and resolved not in seen:
                seen.add(resolved)
                parts.append(resolved.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(parts)


# --- token classification ---------------------------------------------------

SKIP_REASON_PATTERNS = [
    (re.compile(r"[\s]"), "prose"),          # `provider@model[:concurrency]`-shaped syntax
    (re.compile(r"^https?://"), "url"),
    (re.compile(r"[*]"), "wildcard"),        # `claude-*`, `..._RESET`-style patterns
    (re.compile(r"^#?\d"), "numeric"),       # `#218`, `40960`, `v7.2+`
    (re.compile(r"^v\d"), "version"),
    (re.compile(r"^.{0,2}$"), "too-short"),  # `g@`, `or`, `x`
    (re.compile(r"[<>|]"), "placeholder"),   # `<model>`, `path → maxBytes`
    # `fix/NN-slug`, `#NN` templates. Anchored: a bare r"NN" also matched
    # CHANNEL / CONNECT / RUNNER, silently skipping real env names.
    (re.compile(r"(?<![A-Z])NN(?![A-Z])"), "placeholder"),
    (re.compile(r"@"), "route-or-handle"),   # `google@gemini-2.0-flash`, emails
]

ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
PATH_RE = re.compile(r"^[A-Za-z0-9_.\-/]+\.(md|ts|tsx|js|py|ps1|json|example|sse|7z|log|env)$")
SYMBOL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.\-/]*$")


def classify(token: str) -> tuple[str, str]:
    """Return (class, note). Classes: skip | env | path | symbol."""
    for pattern, reason in SKIP_REASON_PATTERNS:
        if pattern.search(token):
            return "skip", reason
    if ENV_RE.match(token) and "_" in token:
        return "env", ""
    if PATH_RE.match(token):
        return "path", ""
    if SYMBOL_RE.match(token):
        return "symbol", ""
    return "skip", "unclassifiable"


def verify_doc(doc: Path, code: str, docs: str, repo_files: set[str]):
    """Yield (line_no, token, class, verdict) for every non-skipped token."""
    for line_no, line in enumerate(
        doc.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
    ):
        for match in TOKEN_RE.finditer(line):
            token = match.group(1)
            cls, _note = classify(token)
            if cls == "skip" or token in EXTERNAL_ALLOWLIST:
                continue
            if cls == "path":
                # Decision-layer docs cite files by bare basename (the prefixed
                # path lives in the detail layer) -- resolve against the repo
                # tree by suffix as well as by exact relative path.
                if (
                    token in repo_files
                    or (REPO_ROOT / token).resolve().is_file()
                    or any(p.endswith("/" + token) for p in repo_files)
                ):
                    yield line_no, token, cls, "ok"
                else:
                    yield line_no, token, cls, "UNVERIFIED"
                continue
            # Symbols may live in code OR in the doc's own detail layer; env
            # knobs are READ BY CODE by definition, so an env token verifies
            # against code only -- a knob documented but read nowhere is dead
            # even when its detail doc still describes it.
            # A dotted name (`ComposedHandler.handleStream`) verifies when the
            # whole form OR every segment appears -- method references are not
            # written qualified in the sources. A bare name that matches a repo
            # file or directory segment anywhere in the tree (a skill dir like
            # `worker-issues`) also verifies.
            corpus = code if cls == "env" else code + "\n" + docs
            found = token in corpus or (
                "." in token
                and all(seg in corpus for seg in token.split(".") if seg)
            ) or any(
                seg == token for p in repo_files for seg in p.split("/")
            )
            yield line_no, token, cls, "ok" if found else "UNVERIFIED"


def repo_file_set() -> set[str]:
    """Tracked paths (files, plus every directory prefix), repo-relative posix.

    `git ls-files` is both the fast and the CORRECT corpus: a reference in a
    decision-layer doc points at committed content, and an untracked
    node_modules tree would only slow the walk. Falls back to a filtered
    rglob when git is unavailable (e.g. a bare export).
    """
    import subprocess

    files: set[str] = set()
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files"],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout
        for rel in out.splitlines():
            if rel:
                files.add(rel)
                parts = rel.split("/")
                for i in range(1, len(parts)):
                    files.add("/".join(parts[:i]) + "/")
        if files:
            return files
    except Exception:
        pass
    heavy = {"node_modules", ".git", ".tmp", "dist", "build"}
    for path in REPO_ROOT.rglob("*"):
        if heavy & set(path.parts[len(REPO_ROOT.parts):]):
            continue
        rel = path.relative_to(REPO_ROOT).as_posix()
        files.add(rel)
        if path.is_dir():
            files.add(rel + "/")
    return files


# --- entry points -----------------------------------------------------------

def run(paths: list[str]) -> int:
    docs = [REPO_ROOT / p for p in paths]
    missing = [str(d) for d in docs if not d.is_file()]
    if missing:
        print("missing inputs:", ", ".join(missing), file=sys.stderr)
        return 2
    code = build_code_corpus()
    docs_corpus = build_docs_corpus(docs)
    files = repo_file_set()
    unverified = 0
    checked = 0
    for doc in docs:
        for line_no, token, cls, verdict in verify_doc(doc, code, docs_corpus, files):
            checked += 1
            if verdict != "ok":
                unverified += 1
                print(f"UNVERIFIED {doc.as_posix()}:{line_no} [{cls}] `{token}`")
    print(f"{checked} tokens checked, {unverified} unverified")
    return 1 if unverified else 0


# Embedded fixture: two real references, two deliberately false ones.
FIXTURE = """## Fixture section

- Real flag `CLAUDISH_FIRST_EVENT_TIMEOUT_MS` and real symbol `withFirstUsefulEventWatchdog`.
- False symbol `resolveEverythingMagically` and false flag `CLAUDISH_IMAGINARY_FLAG_XYZ`.
- False flag `CLAUDISH_CHANNEL_IMAGINARY_XYZ` (contains NN: must be checked, not skipped).
"""


def selftest() -> int:
    """Positive control: the verifier MUST flag the false pair and pass the real one."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        fixture = Path(tmp) / "fixture.md"
        fixture.write_text(FIXTURE, encoding="utf-8")
        code = build_code_corpus()
        results = {
            token: verdict
            for _line, token, _cls, verdict in verify_doc(fixture, code, "", set())
        }
    must_pass = ["CLAUDISH_FIRST_EVENT_TIMEOUT_MS", "withFirstUsefulEventWatchdog"]
    must_fail = ["resolveEverythingMagically", "CLAUDISH_IMAGINARY_FLAG_XYZ",
                 "CLAUDISH_CHANNEL_IMAGINARY_XYZ"]
    ok = True
    for token in must_pass:
        if results.get(token) != "ok":
            print(f"SELFTEST FAIL: real reference `{token}` did not pass: {results.get(token)}")
            ok = False
    for token in must_fail:
        if results.get(token) == "ok":
            print(f"SELFTEST FAIL: false reference `{token}` was NOT flagged")
            ok = False
        elif token not in results:
            print(f"SELFTEST FAIL: false reference `{token}` was skipped, not checked")
            ok = False
    print("SELFTEST PASS" if ok else "SELFTEST FAIL")
    return 0 if ok else 2


def main(argv: list[str]) -> int:
    if argv[:1] == ["--selftest"]:
        return selftest()
    if not argv:
        print(__doc__)
        return 2
    return run(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
