#!/usr/bin/env python3
r"""Tests for the display-label canon of settings-matrix.py (user mandate 22/10).

Every case pins a confusion observed live on the fleet: the picker showing
"Sonnet 5.5 (1M)" while the seat serves glm because _MODEL_NAME is missing,
fable's stale "Anthropic Fable 5.1 (SOTA)" marketing wording on a
cascade-served role, opus's legitimate native wording, and a custom option
that exists on a machine whose lanes never use it.

Run standalone:  python scripts/tests/test_settings_matrix_labels.py
"""

import importlib.util
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "settings-matrix.py")

_spec = importlib.util.spec_from_file_location("smx", _TARGET)
smx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smx)


def _joined(flags):
    return "\n".join(flags)


# --------------------------------------------------------------------------
# The live po-2027 shape, measured 22/10 (positive control of the mandate)
# --------------------------------------------------------------------------

def test_fable_marketing_description_flagged():
    """po-2027's live labels: sonnet/haiku/opus truthful, fable still carrying
    the Anthropic marketing string -- exactly one description flag, on fable."""
    harmonization = {
        "env.ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5[1m]",
        "env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Opus",
        "env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION":
            "Rôle Opus — modèle décidé par claudish (Anthropic natif, bascule en cascade si plan épuisé)",
        "env.ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5[1m]",
        "env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Sonnet",
        "env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION":
            "Rôle Sonnet — modèle décidé par claudish (bascule budget selon les quotas)",
        "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001[1m]",
        "env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "Haiku",
        "env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION":
            "Rôle Haiku — modèle décidé par claudish (bascule budget selon les quotas)",
        "env.ANTHROPIC_DEFAULT_FABLE_MODEL": "claude-fable-5-1[1m]",
        "env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "Fable 5.1",
        "env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION": "Anthropic Fable 5.1 (SOTA)",
        "env.ANTHROPIC_CUSTOM_MODEL_OPTION": "qwen3.8-max",
    }
    flags = _joined(smx.label_flags(harmonization, "myia-po-2027"))
    assert "role fable: description names Anthropic" in flags, flags
    assert "Anthropic Fable 5.1 (SOTA)" in flags, flags
    # The truthful roles stay silent.
    assert "role sonnet" not in flags, flags
    assert "role haiku" not in flags, flags
    assert "role opus" not in flags, flags


# --------------------------------------------------------------------------
# Canon shape (coordinator ACK 22/10): no flags at all
# --------------------------------------------------------------------------

def test_canon_shape_not_flagged():
    """All four roles in canon shape, fable's canon explicitly denying native
    Anthropic by naming it -- naming alone is not the offense."""
    harmonization = {}
    for role in smx.ROLES:
        harmonization["env.ANTHROPIC_DEFAULT_%s_MODEL" % role.upper()] = "pinned-%s" % role
        harmonization["env.ANTHROPIC_DEFAULT_%s_MODEL_NAME" % role.upper()] = "Rôle %s" % role.capitalize()
    harmonization["env.ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION"] = \
        "Rôle Fable — modèle décidé par claudish (pas Anthropic natif)"
    harmonization["env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION"] = \
        "Rôle Opus — modèle décidé par claudish (Anthropic natif en nominal, cascade si plan épuisé)"
    flags = smx.label_flags(harmonization, "myia-po-2027")
    assert flags == [], _joined(flags)


def test_opus_native_wording_is_exempt_even_off_template():
    """Opus is native-Anthropic in nominal: marketing wording there is not the
    cascade-role lie, so the Anthropic check never applies to it."""
    harmonization = {
        "env.ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5[1m]",
        "env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Opus",
        "env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION": "Anthropic Claude Opus (SOTA)",
    }
    flags = _joined(smx.label_flags(harmonization, "myia-ai-01"))
    assert "role opus" not in flags, flags


# --------------------------------------------------------------------------
# The "Sonnet 5.5 (1M)" fallback class
# --------------------------------------------------------------------------

def test_pinned_role_without_name_is_the_picker_fallback_class():
    """A role pinned but with no _MODEL_NAME: the picker falls back to the
    built-in Anthropic name -- the exact class the user saw."""
    harmonization = {
        "env.ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5[1m]",
    }
    flags = _joined(smx.label_flags(harmonization, "myia-po-2023"))
    assert "role sonnet" in flags and "Sonnet 5.5 (1M)" in flags, flags


def test_empty_name_string_is_the_same_fallback():
    """A present-but-empty _NAME must not read as a display name."""
    harmonization = {
        "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5[1m]",
        "env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "",
    }
    flags = _joined(smx.label_flags(harmonization, "myia-po-2023"))
    assert "role haiku" in flags, flags


def test_absent_name_is_not_flagged_while_the_collector_is_blind():
    """No snapshot carries a label key: an absent _NAME is unverifiable, not a
    violation (the first live run printed 32 such flags, 4 roles x 8 seats)."""
    harmonization = {"env.ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5[1m]"}
    assert smx.label_flags(harmonization, "myia-po-2023", names_visible=False) == []


def test_empty_name_is_flagged_even_while_the_collector_is_blind():
    """A present-but-empty _NAME was seen by the snapshot: still flagged."""
    harmonization = {
        "env.ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5[1m]",
        "env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "",
    }
    flags = _joined(smx.label_flags(harmonization, "myia-po-2023", names_visible=False))
    assert "role haiku" in flags, flags


def test_unpinned_role_without_name_stays_silent():
    """No pinned model id, no name: nothing displayed for that role, no flag."""
    flags = smx.label_flags({}, "myia-po-2023")
    assert flags == [], _joined(flags)


# --------------------------------------------------------------------------
# Custom option canon: a Sol id wherever declared (coordinator ACK 23/10,
# superseding the 22/10 "po-2025 only" rule that measurement falsified)
# --------------------------------------------------------------------------

def test_custom_option_forbidden_id_is_flagged_on_any_machine():
    """qwen3.8-max: flagged on every seat alike (never used, too expensive,
    user 22/10) -- the canon is on the OPTION VALUE, not on the machine."""
    harmonization = {"env.ANTHROPIC_CUSTOM_MODEL_OPTION": "qwen3.8-max"}
    flags = _joined(smx.label_flags(harmonization, "myia-po-2027"))
    assert "custom option" in flags and "qwen3.8-max" in flags, flags
    # the same forbidden id on the seat that once defined the canon machines
    flags_on_2025 = _joined(smx.label_flags(harmonization, "myia-po-2025"))
    assert "custom option" in flags_on_2025 and "qwen3.8-max" in flags_on_2025, flags_on_2025


def test_canon_sol_id_and_absent_are_fine_on_every_machine():
    """The newest Sol id passes on any seat; absent is the default."""
    for machine in ("myia-po-2025", "myia-po-2027", "myia-web1"):
        assert smx.label_flags({"env.ANTHROPIC_CUSTOM_MODEL_OPTION": "gpt-6.1-sol"}, machine) == []
    assert smx.label_flags({}, "myia-po-2028") == []


def test_older_sol_ids_are_flagged_obsolete_not_forbidden():
    """Harmonized upward (user 24/10): an older Sol spelling is behind, so it is
    flagged -- with its own wording, never the forbidden-class one."""
    for option in ("gpt-5.6-sol", "gpt-6-sol"):
        flags = _joined(smx.label_flags({"env.ANTHROPIC_CUSTOM_MODEL_OPTION": option}, "myia-web1"))
        assert "obsolete Sol id" in flags and option in flags and "gpt-6.1-sol" in flags, flags
        assert "forbidden" not in flags, flags


# --------------------------------------------------------------------------
# Blind spot: absence reads as invisible, never as compliance
# --------------------------------------------------------------------------

def test_label_lines_show_blind_spot_not_silence():
    """An empty harmonization prints every label key as not-published: until
    RSM ships the collector keys, the fleet's labels are invisible to this
    instrument, and the output must say so."""
    lines = _joined(smx.label_lines({}))
    assert "not published (collector blind spot)" in lines, lines
    assert lines.count("not published") == len(smx.LABEL_KEYS), lines


def test_label_lines_print_values():
    lines = _joined(smx.label_lines({
        "env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Rôle Sonnet",
    }))
    assert 'env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = "Rôle Sonnet"' in lines, lines
    assert "not published" in lines  # the other keys stay visible as blind spots


if __name__ == "__main__":
    _passed = failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                _passed += 1
                print("PASS %s" % name)
            except AssertionError as e:
                failures += 1
                print("FAIL %s: %s" % (name, e))
            except Exception as e:
                failures += 1
                print("ERROR %s: %r" % (name, e))
    print("--- %d passed, %d failed" % (_passed, failures))
    sys.exit(1 if failures else 0)
