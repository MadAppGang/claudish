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
# The fleet compaction window sits BELOW Swift's limit (swift-1.5-27b, 262 144
# tokens, onboarded as a haiku lane), with a turn of margin: the previous canon,
# 263000, sat 856 tokens above it, so compaction could never fire before a
# vllm-routed session left the window (user 23/10, Q58: "erreur grossiere, oui
# tu redescends"). ai-01 alone runs higher on purpose (user 20/10).
CANON = {
    "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW": {"*": "250000", "myia-ai-01": "330000"},
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
# Model display labels (user mandate 22/10). The picker row shows
# ANTHROPIC_DEFAULT_<ROLE>_MODEL_NAME; when that variable is missing Claude Code
# falls back to the built-in Anthropic name for the pinned id -- the
# "Sonnet 5.5 (1M)" a seat displayed while actually serving glm. Canon (coordinator
# ACK, 22/10): _NAME "Rôle <Role>" plus a generic _DESCRIPTION naming no concrete
# model, for the 4 roles.
ROLES = ("opus", "sonnet", "haiku", "fable")
# Opus is native-Anthropic in nominal, so its canon description legitimately says
# "Anthropic"; the other roles are cascade-served and must not carry Anthropic
# marketing wording.
NATIVE_NOMINAL_ROLES = ("opus",)
# Custom-option canon (coordinator ACK 23/10, superseding the 22/10 "po-2025 only"
# rule): measurement beat the canon -- 7 of 8 seats declared a Sol (gpt-5.6-sol x4,
# gpt-6-sol x2) and the one qwen3.8-max was po-2027's own stale entry (fixed in
# place the same day). A custom, WHERE declared, must be a Sol id; qwen3.8-max is
# forbidden (user 22/10: too expensive on the Alibaba/Qwen token plan, never used).
# Harmonized upward on 24/10 (user: "gpt-5.6-sol, c'est obsolète, on harmonise par
# le haut"): the canon is the newest Sol id the hub routes; the older spellings still
# route to it, but a seat carrying one is behind and gets its own flag, distinct
# from the forbidden class.
CANON_CUSTOM_OPTIONS = ("gpt-6.1-sol",)
OBSOLETE_SOL_OPTIONS = ("gpt-5.6-sol", "gpt-6-sol")
# A canon description starts with "Rôle " and may still mention "Anthropic natif"
# (fable's canon wording says exactly that, to deny it); a description NOT in the
# canon shape that names Anthropic is the marketing drift ("Anthropic Fable 5.1
# (SOTA)", still live on seats as of 22/10).
CANON_DESCRIPTION_PREFIX = "Rôle "

LABEL_KEYS = tuple(
    key
    for role in ROLES
    for key in (
        "env.ANTHROPIC_DEFAULT_%s_MODEL_NAME" % role.upper(),
        "env.ANTHROPIC_DEFAULT_%s_MODEL_DESCRIPTION" % role.upper(),
    )
) + (
    "env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
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


def label_lines(harmonization):
    """Printable inventory of the display-label keys. None of them is secret.

    A key the snapshot does not carry is shown as the collector blind spot, not
    skipped: until RSM publishes these names, absence must read as "invisible
    to this instrument", never as compliance.
    """
    lines = []
    for key in LABEL_KEYS:
        value = harmonization.get(key)
        if value is None:
            lines.append("  %s: not published (collector blind spot)" % key)
        else:
            lines.append("  %s = %s" % (key, json.dumps(value, ensure_ascii=False)))
    return lines


def label_flags(harmonization, machine, names_visible=True):
    """Canon flags for the display labels. Fires live wherever the snapshot can
    see the key; a role pinned but with no published _NAME is the exact
    "Sonnet 5.5 (1M)" fallback class.

    `names_visible=False` means no snapshot of the run carries any label key:
    the collector does not publish them, so an ABSENT _NAME says nothing about
    the seat and is not flagged here (main() prints one fleet line instead). A
    present-but-empty _NAME is still flagged -- the snapshot did see that one.
    """
    flags = []
    for role in ROLES:
        upper = role.upper()
        name_key = "env.ANTHROPIC_DEFAULT_%s_MODEL_NAME" % upper
        desc_key = "env.ANTHROPIC_DEFAULT_%s_MODEL_DESCRIPTION" % upper
        pinned = harmonization.get("env.ANTHROPIC_DEFAULT_%s_MODEL" % upper)
        if (
            pinned is not None
            and not harmonization.get(name_key)
            and (names_visible or name_key in harmonization)
        ):
            flags.append(
                "role %s: pinned to %s with no published _MODEL_NAME -- a seat without "
                "one shows the built-in Anthropic name (the \"Sonnet 5.5 (1M)\" class)"
                % (role, json.dumps(pinned))
            )
        if role not in NATIVE_NOMINAL_ROLES:
            description = harmonization.get(desc_key)
            if (
                isinstance(description, str)
                and "anthropic" in description.lower()
                and not description.startswith(CANON_DESCRIPTION_PREFIX)
            ):
                flags.append(
                    "role %s: description names Anthropic on a cascade-served role: %s"
                    % (role, json.dumps(description, ensure_ascii=False))
                )
    option = harmonization.get("env.ANTHROPIC_CUSTOM_MODEL_OPTION")
    if option in OBSOLETE_SOL_OPTIONS:
        flags.append(
            "custom option %s is an obsolete Sol id (canon %s)"
            % (json.dumps(option, ensure_ascii=False), str(CANON_CUSTOM_OPTIONS))
        )
    elif option and option not in CANON_CUSTOM_OPTIONS:
        flags.append(
            "custom option %s is not a canon Sol id %s (qwen3.8-max class: forbidden)"
            % (json.dumps(option, ensure_ascii=False), str(CANON_CUSTOM_OPTIONS))
        )
    return flags


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
    snaps = {machine: latest_snapshot(args.shared, machine) for machine in args.machines}
    # Until the collector publishes the label keys, every pinned role reads as
    # name-less on every seat: 4 flags x 8 machines carrying no information,
    # burying the flags that do (measured on the first run, 22/10). One fleet
    # line instead, until any snapshot carries a label key.
    names_visible = any(
        key in snap.get("harmonization", {}) for snap in snaps.values() if snap for key in LABEL_KEYS
    )
    if not names_visible:
        flags.append(
            "label keys published by no snapshot (collector blind spot) -- picker-fallback "
            "check suspended fleet-wide, an absent _MODEL_NAME is unverifiable"
        )
    for machine in args.machines:
        snap = snaps[machine]
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
        for line in label_lines(harmonization):
            print(line)
        flags.extend(
            "%s: %s" % (machine, flag) for flag in label_flags(harmonization, machine, names_visible)
        )
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
