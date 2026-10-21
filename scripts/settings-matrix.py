#!/usr/bin/env python3
"""Fleet ~/.claude/settings.json matrix, read from the RooSync `claude-settings` snapshots.

The coordinator must know what every roster machine's settings.json holds
(user mandate, 20/10). Each machine publishes a masked snapshot with
`roosync_config(action:"publish", targets:["claude-settings"])`; this script
reads the latest one per machine, with the same lookup order as RSM's
findLatestClaudeSettingsSnapshot (standalone -> latest.json -> versioned
packages by collectedAt), and flags what needs a look.

Never prints a secret marker: a sensitive env key is shown as its NAME plus
set/empty/unset. The snapshot's `<set:len=N:sha256=x>` digest is dropped,
since a length or digest is secret-derived metadata.

Blind spot (as of 20/10): an env key that is neither allow-listed nor
"sensitive" leaves no trace in the snapshot (12/25 names on ai-01, among them
CLAUDE_CODE_SUBAGENT_MODEL). The per-lane shape line in the coordinator
reference (Phase 2) covers it until RSM publishes the names.

Usage: settings-matrix.py [--shared DIR] [--stale-hours 48] [machine ...]
"""
import argparse
import datetime as dt
import json
import os

DEFAULT_MACHINES = [
    "myia-ai-01", "myia-po-2023", "myia-po-2024", "myia-po-2025",
    "myia-po-2027", "myia-po-2028", "myia-web1", "myia-web2",
]
# A present, non-empty value here makes the client send a credential of its own
# choosing instead of its Anthropic login: the #296 shape-B class (po-2028, 20/10).
CREDENTIAL_KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
# Values with a decided canon: a machine off it is flagged, whatever the others hold.
# The fleet compaction window sits 856 tokens ABOVE Swift's limit (swift-1.5-27b,
# 262 144 tokens, onboarded as a haiku lane) -- an open arbitration (coordinator
# registry Q58), not a settled fit. ai-01 alone runs higher on purpose (user 20/10).
CANON = {
    "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW": {"*": "263000", "myia-ai-01": "330000"},
}
# Values compared across the fleet; any divergence is listed.
COMPARED = (
    "env.ANTHROPIC_CUSTOM_MODEL_OPTION",
    "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
    "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
    "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "env.ANTHROPIC_DEFAULT_FABLE_MODEL",
    "model",
    "outputStyle",
)


def read_snapshot(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            snap = json.load(f)
    except (OSError, ValueError):
        return None
    if isinstance(snap, dict) and snap.get("format") == 1 and "harmonization" in snap:
        return snap
    return None


def latest_snapshot(shared, machine):
    cdir = os.path.join(shared, "configs", machine)
    if not os.path.isdir(cdir):
        return None
    standalone = read_snapshot(os.path.join(cdir, "claude-settings", "claude-settings.json"))
    if standalone:
        return standalone
    try:
        with open(os.path.join(cdir, "latest.json"), encoding="utf-8-sig") as f:
            pointer = json.load(f).get("path")
        if pointer:
            snap = read_snapshot(os.path.join(pointer, "claude-settings", "claude-settings.json"))
            if snap:
                return snap
    except (OSError, ValueError, AttributeError):
        pass
    best = None
    for entry in os.listdir(cdir):
        if not entry.startswith("v"):
            continue
        snap = read_snapshot(os.path.join(cdir, entry, "claude-settings", "claude-settings.json"))
        # ISO-8601 strings compare in date order; RSM parses dates and tie-breaks
        # lexically -- same winner unless two versions share a collectedAt.
        if snap and (best is None or snap.get("collectedAt", "") > best.get("collectedAt", "")):
            best = snap
    return best


def presence(marker):
    if marker in (None, "<unset>"):
        return "unset"
    return "empty" if marker == "<empty>" else "set"


def age_hours(iso, now):
    try:
        then = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return (now - then).total_seconds() / 3600


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--shared", default=os.environ.get("ROOSYNC_SHARED_PATH", ""))
    ap.add_argument("--stale-hours", type=float, default=48.0)
    ap.add_argument("machines", nargs="*", default=DEFAULT_MACHINES)
    args = ap.parse_args()
    if not args.shared:
        ap.error("--shared or ROOSYNC_SHARED_PATH is required")

    now = dt.datetime.now(dt.timezone.utc)
    flags, seen = [], {key: {} for key in COMPARED}
    for machine in args.machines:
        snap = latest_snapshot(args.shared, machine)
        print(f"=== {machine}")
        if not snap:
            print("  NOT COVERED: no claude-settings snapshot published")
            flags.append(f"{machine}: NOT COVERED")
            continue
        hours = age_hours(snap.get("collectedAt"), now)
        print(f"  collectedAt={snap.get('collectedAt')} state={snap.get('state')}")
        if hours is None or hours > args.stale_hours:
            flags.append(f"{machine}: snapshot stale ({snap.get('collectedAt')})")
        if snap.get("state") != "ok":
            flags.append(f"{machine}: settings state={snap.get('state')}")
        harmonization = snap.get("harmonization", {})
        for key, value in sorted(harmonization.items()):
            print(f"  {key} = {json.dumps(value, ensure_ascii=False)}")
        for key in COMPARED:
            if key in harmonization:
                seen[key].setdefault(json.dumps(harmonization[key], ensure_ascii=False), []).append(machine)
        for key, canon in CANON.items():
            expected = canon.get(machine, canon["*"])
            actual = harmonization.get(key)
            if actual != expected:
                flags.append(f"{machine}: {key} = {json.dumps(actual)} off canon (expected {json.dumps(expected)})")
        masked = snap.get("maskedEnvKeys", {})
        for key, marker in sorted(masked.items()):
            state = presence(marker)
            print(f"  env.{key}: {state} (sensitive, value never shown)")
            if key in CREDENTIAL_KEYS and state == "set":
                flags.append(f"{machine}: env.{key} is set (client sends its own credential, #296 shape B)")
        print(f"  otherTopLevelKeys = {snap.get('otherTopLevelKeys')}")

    for key, values in seen.items():
        if len(values) > 1:
            spread = "; ".join(f"{v} x{len(ms)} ({', '.join(ms)})" for v, ms in values.items())
            flags.append(f"divergent {key}: {spread}")
    print("=== flags")
    for flag in flags or ["none"]:
        print(f"  - {flag}")


# Exit status is always 0, flags included: this is a per-cycle reading instrument,
# not a gate. A CI consumer that wants a failing mode must add one explicitly.
if __name__ == "__main__":
    main()
