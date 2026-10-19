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
  python -I scripts/verify-decision-refs.py --audit-allowlist   # stale scoped entries (exit 0)
"""

from __future__ import annotations

import fnmatch
import json
import re
import shutil
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
    "scripts/**/*.psm1",   # claudish-engine.psm1 holds the drain/watchdog pure
                           # logic -- a doc citing Get-FailoverLineFingerprint
                           # must verify against the module itself
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
    "migration-hub-to-po-2025.md",  # project memory of the claudish-migration-watch
                                    # cycle (per-workspace, same class as the two
                                    # above) -- kept live by the skill, never a repo file
    ".claude/skills/claudish-usage/SKILL.md",  # --init INSTALL target (per-project,
                                            # source lives at packages/cli/skills/) -- a
                                            # runtime install path, never committed here
    "baseRefName",             # GitHub GraphQL schema field (gh pr view)
    "mergeStateStatus",        # GitHub GraphQL schema field (gh pr view)
    "CronList",               # Claude Code built-in tool (session scheduler)
}

# Scoped external allowlist: per-doc-path adjudications for tokens that can
# never resolve inside this repo. The GLOBAL set above applies everywhere and
# is reserved for cross-doc vocabulary; a token that is external only in a
# specific doc family (e.g. docs/reference/*.md narrating fleet operations)
# is adjudicated in scripts/decision-refs-external.json so the blast radius
# of each entry is the smallest doc set that justifies it. A token listed
# there is masked ONLY for matching docs -- everywhere else it still goes
# red -- and the run summary reports the masked count so the mask itself
# stays visible (an allowlist nobody can see is a hole, not a filter).
SCOPED_ALLOWLIST_PATH = Path(__file__).resolve().parent / "decision-refs-external.json"


def load_scoped_allowlist() -> list[tuple[str, set[str]]]:
    """Return [(path_pattern, tokens)] from the sidecar JSON; [] when absent."""
    if not SCOPED_ALLOWLIST_PATH.is_file():
        return []
    try:
        data = json.loads(SCOPED_ALLOWLIST_PATH.read_text(encoding="utf-8"))
        return [
            (scope["match"], set(scope.get("tokens", {})))
            for scope in data.get("scopes", [])
        ]
    except (OSError, ValueError, KeyError, TypeError):
        # A malformed allowlist must degrade to NO allowlisting (stay loud),
        # never to silently masking everything.
        return []


def scoped_allowlist_for(
    doc: Path, entries: list[tuple[str, set[str]]] | None = None
) -> set[str]:
    """Union of token sets whose pattern matches this doc's repo-relative path.

    `entries` defaults to the sidecar JSON -- the selftest injects its own
    list so the fnmatch gate itself is what gets pinned (a pin that only
    feeds a hand-built set to verify_doc would never see this function).
    """
    if entries is None:
        entries = load_scoped_allowlist()
    try:
        rel = doc.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return set()
    tokens: set[str] = set()
    for pattern, scoped in entries:
        if fnmatch.fnmatch(rel, pattern):
            tokens |= scoped
    return tokens


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


def _masked(token: str, allow: set[str] | None) -> str:
    """Verdict for a token that did not resolve: external if listed, else red."""
    return "external" if allow and token in allow else "UNVERIFIED"


def verify_doc(doc: Path, code: str, docs: str, repo_files: set[str], allow: set[str] | None = None):
    """Yield (line_no, token, class, verdict) for every non-skipped token.

    Verdicts: ok | UNVERIFIED | external (masked by the doc's scoped
    allowlist -- reported, never silent). The allowlist masks a token only
    once it has FAILED to resolve: a listed token that resolves stays "ok",
    which is what lets --audit-allowlist see a stale entry.
    """
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
                    or (REPO_ROOT / token).resolve().exists()
                    or any(p.endswith("/" + token) for p in repo_files)
                ):
                    yield line_no, token, cls, "ok"
                else:
                    yield line_no, token, cls, _masked(token, allow)
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
            ) or (
                # A slash-bearing "symbol" that resolves to an existing
                # directory is a dir citation (e.g. `packages/cli/scripts/
                # smoke/`) — is_file-only path checks flagged these dead.
                "/" in token and (REPO_ROOT / token).resolve().is_dir()
            )
            yield line_no, token, cls, "ok" if found else _masked(token, allow)


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


def audit_allowlist() -> int:
    """Report scoped-allowlist tokens that no matching doc ever needs masked.

    A stale entry (the token no longer appears backticked in any doc covered
    by its scope, or now resolves in code) costs nothing per run but rots the
    allowlist's meaning: the next reader has no way to tell a live
    adjudication from a leftover. Informational only -- exit 0 regardless, so
    it can run in any cycle without gating anything.
    """
    stale_total = 0
    code = build_code_corpus()
    files = repo_file_set()
    for pattern, tokens in load_scoped_allowlist():
        masked: set[str] = set()
        # Walk the pattern's literal prefix as the directory root, then
        # confirm each candidate against the full fnmatch pattern.
        root = REPO_ROOT
        for part in pattern.split("/"):
            if any(ch in part for ch in "*?["):
                break
            root = root / part
        candidates = root.rglob("*.md") if root.is_dir() else []
        for doc in candidates:
            rel = doc.resolve().relative_to(REPO_ROOT).as_posix()
            if not fnmatch.fnmatch(rel, pattern):
                continue
            allow = scoped_allowlist_for(doc)
            docs_corpus = build_docs_corpus([doc])
            for _line, token, _cls, verdict in verify_doc(doc, code, docs_corpus, files, allow):
                if verdict == "external":
                    masked.add(token)
        stale = sorted(tokens - masked)
        if stale:
            stale_total += len(stale)
            print(f"STALE in scope `{pattern}`: {', '.join(stale)}")
    if not stale_total:
        print("allowlist audit: no stale tokens")
    return 0


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
    external = 0
    for doc in docs:
        allow = scoped_allowlist_for(doc)
        for line_no, token, cls, verdict in verify_doc(doc, code, docs_corpus, files, allow):
            checked += 1
            if verdict == "external":
                external += 1
                continue
            if verdict != "ok":
                unverified += 1
                print(f"UNVERIFIED {doc.as_posix()}:{line_no} [{cls}] `{token}`")
    print(f"{checked} tokens checked, {unverified} unverified, {external} external-allowlisted")
    return 1 if unverified else 0


# Embedded fixture: two real references, two deliberately false ones.
FIXTURE = """## Fixture section

- Real flag `CLAUDISH_FIRST_EVENT_TIMEOUT_MS` and real symbol `withFirstUsefulEventWatchdog`.
- Real .psm1-only symbol `Get-FailoverLineFingerprint` (defined in scripts/lib/claudish-engine.psm1, cited by NO .ps1 — verifies only through the psm1 corpus glob).
- False symbol `resolveEverythingMagically` and false flag `CLAUDISH_IMAGINARY_FLAG_XYZ`.
- False flag `CLAUDISH_CHANNEL_IMAGINARY_XYZ` (contains NN: must be checked, not skipped).
- False .psm1 symbol `Get-ImaginaryPsm1Symbol` (must be flagged, not waved through by the new glob).
- Real directory reference `packages/cli/scripts/smoke/` (trailing slash — a slash-bearing symbol that resolves to an existing dir is a citation, not a dead pointer).
- Dead directory citation `packages/cli/scripts/zz-no-such-dir/` and dead file `docs/reference/zz-no-such-file.md` (the acceptance pair of the dir/path clauses — a clause that never fires red certifies nothing).
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
        # Scoped-allowlist pin: a LISTED token is masked ("external"), an
        # unlisted near-twin stays red. An allowlist that swallowed a class
        # (prefix match, over-broad pattern) would pass the twin too, and
        # this pin catches it.
        pin_doc = Path(tmp) / "pin.md"
        pin_doc.write_text(
            "Listed `ExternalTokenA` and unlisted twin `ExternalTokenB`.\n",
            encoding="utf-8",
        )
        pin = {
            token: verdict
            for _line, token, _cls, verdict in verify_doc(
                pin_doc, code, "", set(), {"ExternalTokenA"}
            )
        }
        # Stale-entry pin: a LISTED token that resolves must stay "ok".
        # Masking before resolving hides a stale entry from --audit-allowlist
        # forever -- listing `CLAUDE.md` turned 28 real references on
        # docs/reference/ "external" (64 -> 92) with the audit reporting none.
        stale_doc = Path(tmp) / "stale.md"
        stale_doc.write_text("Listed but resolving `CLAUDE.md`.\n", encoding="utf-8")
        stale_pin = {
            token: verdict
            for _line, token, _cls, verdict in verify_doc(
                stale_doc, code, "", set(), {"CLAUDE.md"}
            )
        }
    # Scope pin: the SAME listed token must be masked ("external") in a doc
    # whose repo-relative path matches the pattern, and stay UNVERIFIED in a
    # doc that does not. This pins the fnmatch gate in scoped_allowlist_for
    # itself -- the allowlisted/unlisted pin above feeds verify_doc by hand
    # and would keep passing if the gate degraded to `if True:` (mask
    # applied to EVERY doc, silently unflagging out-of-scope hits).
    # The fixtures must live under REPO_ROOT (scoped_allowlist_for resolves
    # repo-relative paths), so they go to the gitignored .tmp/ and are
    # removed again right after -- the repo tree is never touched.
    scope_root = REPO_ROOT / ".tmp" / "selftest-scope"
    shutil.rmtree(scope_root, ignore_errors=True)
    in_scope = scope_root / "docs" / "reference" / "pin.md"
    out_scope = scope_root / "other" / "pin.md"
    in_scope.parent.mkdir(parents=True, exist_ok=True)
    out_scope.parent.mkdir(parents=True, exist_ok=True)
    in_scope.write_text("Listed `ExternalTokenA` in-scope.\n", encoding="utf-8")
    out_scope.write_text("Listed `ExternalTokenA` out-of-scope.\n", encoding="utf-8")
    entries = [(".tmp/selftest-scope/docs/reference/*", {"ExternalTokenA"})]
    scope_pin = {}
    for doc in (in_scope, out_scope):
        allow = scoped_allowlist_for(doc, entries)
        for _line, token, _cls, verdict in verify_doc(doc, "", "", set(), allow):
            if token == "ExternalTokenA":
                scope_pin[str(doc)] = verdict
    shutil.rmtree(scope_root, ignore_errors=True)
    must_pass = ["CLAUDISH_FIRST_EVENT_TIMEOUT_MS", "withFirstUsefulEventWatchdog",
                 "Get-FailoverLineFingerprint", "packages/cli/scripts/smoke/"]
    must_fail = ["resolveEverythingMagically", "CLAUDISH_IMAGINARY_FLAG_XYZ",
                 "CLAUDISH_CHANNEL_IMAGINARY_XYZ", "Get-ImaginaryPsm1Symbol",
                 "packages/cli/scripts/zz-no-such-dir/",   # dead dir: dir clause must NOT wave it
                 "docs/reference/zz-no-such-file.md"]      # dead file: path branch must flag it
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
    if pin.get("ExternalTokenA") != "external":
        print(f"SELFTEST FAIL: allowlisted token was not masked: {pin.get('ExternalTokenA')}")
        ok = False
    if pin.get("ExternalTokenB") != "UNVERIFIED":
        print(f"SELFTEST FAIL: unlisted twin was not flagged: {pin.get('ExternalTokenB')}")
        ok = False
    if scope_pin.get(str(in_scope)) != "external":
        print(f"SELFTEST FAIL: in-scope doc was not masked: {scope_pin.get(str(in_scope))}")
        ok = False
    if scope_pin.get(str(out_scope)) != "UNVERIFIED":
        print(
            "SELFTEST FAIL: out-of-scope doc was masked by the scoped allowlist "
            f"(fnmatch gate leak): {scope_pin.get(str(out_scope))}"
        )
        ok = False
    if stale_pin.get("CLAUDE.md") != "ok":
        print(f"SELFTEST FAIL: listed token that resolves was masked: {stale_pin.get('CLAUDE.md')}")
        ok = False
    print("SELFTEST PASS" if ok else "SELFTEST FAIL")
    return 0 if ok else 2


def main(argv: list[str]) -> int:
    if argv[:1] == ["--selftest"]:
        return selftest()
    if argv[:1] == ["--audit-allowlist"]:
        return audit_allowlist()
    if not argv:
        print(__doc__)
        return 2
    return run(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
