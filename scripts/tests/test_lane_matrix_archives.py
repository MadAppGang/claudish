#!/usr/bin/env python3
r"""Reader-side archive enumeration for lane-matrix.py (claudish #203).

What these pin is a SILENT UNDER-COUNT, not a formatting preference. Since #201
a machine writes `captures-<day>-<tag>.7z` off-site so two producers cannot
overwrite each other's day. The reader kept matching `captures-<day>.7z$` only,
so every tagged archive was invisible to it — and an invisible archive does not
look like a defect, it looks like a quiet day. Measured on the live corpus
before the fix (2026-09-22):

    G:\Mon Drive\Backups-Cloud\claudish  141 files on disk, 105 visible
                                         34 of 105 days under-counted
    D:\claudish-captures\archive          14 files on disk,   0 visible
                                         (every day tagged since #201)

Every assertion here carries a positive control: a reader that silently matched
NOTHING would pass an "it did not crash" check, so each case also pins a count
that must be non-zero and a shape that must be refused.

Run standalone (no pytest needed):   python scripts/tests/test_lane_matrix_archives.py
Or under pytest:                     pytest scripts/tests/test_lane_matrix_archives.py
"""

import importlib.util
import os
import sqlite3
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(os.path.dirname(_HERE), "lane-matrix.py")

_spec = importlib.util.spec_from_file_location("lane_matrix", _TARGET)
lm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lm)


def _dir_with(names):
    """A temp directory holding empty files with the given names."""
    d = tempfile.mkdtemp(prefix="lane-matrix-test-")
    for n in names:
        with open(os.path.join(d, n), "w", encoding="utf-8") as fh:
            fh.write("x")
    return d


def _resp(day, hour, handler, model):
    """One 7z listing line, in the real `7z l -ba` shape."""
    name = "resp-i-r1-%sT%02d-00-00-000Z-%s-%s.sse" % (day, hour, handler, model)
    return "2026-09-20 00:00:00 ....A         1200          800  %s" % name


# --------------------------------------------------------------------------
# archive_days — which files are enumerated
# --------------------------------------------------------------------------

def test_both_spellings_of_one_day_are_returned():
    """THE acceptance criterion of #203."""
    d = _dir_with(["captures-2026-09-20.7z", "captures-2026-09-20-ai-01.7z"])
    days = lm.archive_days(d)
    assert list(days) == ["2026-09-20"]
    got = sorted(os.path.basename(p) for p in days["2026-09-20"])
    assert got == ["captures-2026-09-20-ai-01.7z", "captures-2026-09-20.7z"], got
    # Positive control: two producers, two paths — not one silently picked.
    assert len(days["2026-09-20"]) == 2


def test_a_tagged_only_day_is_not_invisible():
    """The local archive dir of a post-#201 machine is 100% tagged.

    Before the fix this returned zero days against 14 real archives, which is
    indistinguishable from an empty directory.
    """
    d = _dir_with(["captures-2026-09-18-ai-01.7z", "captures-2026-09-19-po-2025.7z"])
    days = lm.archive_days(d)
    assert sorted(days) == ["2026-09-18", "2026-09-19"]
    assert sum(len(v) for v in days.values()) == 2


def test_drive_duplicate_name_is_still_enumerated():
    """Regression on the fix's own first draft.

    Anchoring the date pattern so it also carried the tag looked equivalent and
    was not: measured against the live off-site directory it dropped
    `captures-<day> (1).7z`, a Drive-duplicate name holding a real producer's
    day. Which files are ENUMERATED must never depend on parsing the suffix.
    """
    d = _dir_with(["captures-2026-09-05.7z", "captures-2026-09-05 (1).7z"])
    days = lm.archive_days(d)
    got = sorted(os.path.basename(p) for p in days["2026-09-05"])
    assert got == ["captures-2026-09-05 (1).7z", "captures-2026-09-05.7z"], got


def test_foreign_files_are_refused():
    """Negative control: permissive on the suffix is not permissive on everything.

    Without this, a matcher broken wide open would pass every test above.
    """
    d = _dir_with([
        "captures-2026-09-20.7z",     # the only one that is ours
        "lane-series.sqlite",
        "captures-latest.7z",         # no date
        "notes.txt",
    ])
    days = lm.archive_days(d)
    assert list(days) == ["2026-09-20"]
    assert len(days["2026-09-20"]) == 1


def test_paths_are_sorted_so_the_label_is_stable():
    d = _dir_with([
        "captures-2026-09-20-zz.7z",
        "captures-2026-09-20-aa.7z",
        "captures-2026-09-20.7z",
    ])
    paths = lm.archive_days(d)["2026-09-20"]
    assert paths == sorted(paths)


# --------------------------------------------------------------------------
# archive_source_label — the staleness key
# --------------------------------------------------------------------------

def test_label_of_a_lone_untagged_archive_is_byte_identical_to_the_legacy_one():
    """An existing store must not re-ingest its whole history on upgrade."""
    label = lm.archive_source_label([r"G:\share\captures-2026-08-10.7z"])
    assert label == "archive:captures-2026-08-10.7z"


def test_label_changes_when_a_producer_is_added():
    """The recovery case: a tagged archive lands NEXT to one already ingested.

    The old skip was "have I seen this day at all", so the day stayed pinned to
    its partial counts forever. The label is what makes the addition visible.
    """
    before = lm.archive_source_label(["/x/captures-2026-08-10.7z"])
    after = lm.archive_source_label(
        ["/x/captures-2026-08-10.7z", "/x/captures-2026-08-10-ai-01.7z"]
    )
    assert before != after
    assert "ai-01" in after
    # Positive control: same set, same label — an unchanged day is left alone.
    assert after == lm.archive_source_label(
        ["/x/captures-2026-08-10-ai-01.7z", "/x/captures-2026-08-10.7z"]
    )


# --------------------------------------------------------------------------
# merge_archive_day — two producers are two PARTS of a day
# --------------------------------------------------------------------------

def test_counts_of_two_producers_are_summed_not_overwritten():
    listings = {
        "a.7z": [_resp("2026-09-20", 6, "direct", "glm-5.3")] * 3,
        "b.7z": [_resp("2026-09-20", 6, "direct", "glm-5.3")] * 2
               + [_resp("2026-09-20", 7, "openai", "qwen3")],
    }
    merged, members, resp_files = lm.merge_archive_day(
        ["a.7z", "b.7z"], lambda p: listings[p]
    )
    assert merged[("2026-09-20", 6, "direct", "glm-5.3")] == 5
    assert merged[("2026-09-20", 7, "openai", "qwen3")] == 1
    assert resp_files == 6
    assert members == 6
    # Positive control: the single-producer path still works and is non-zero.
    solo, _, solo_resp = lm.merge_archive_day(["a.7z"], lambda p: listings[p])
    assert solo[("2026-09-20", 6, "direct", "glm-5.3")] == 3
    assert solo_resp == 3


def test_ingest_stores_the_merged_total_for_a_shared_day():
    """End to end through the real store, because ingest_day DELETEs first.

    Ingesting producer A then producer B would leave B's counts alone. This is
    the assertion that would fail if the merge were ever moved back into the
    ingestion loop.
    """
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE responses (day TEXT, hour INTEGER, handler TEXT, model TEXT,
                                n INTEGER, PRIMARY KEY (day,hour,handler,model));
        CREATE TABLE days (day TEXT PRIMARY KEY, source TEXT, files INTEGER,
                           resp_files INTEGER, ingested_at TEXT);
        """
    )
    listings = {
        "a.7z": [_resp("2026-09-20", 6, "direct", "glm-5.3")] * 3,
        "b.7z": [_resp("2026-09-20", 6, "direct", "glm-5.3")] * 2,
    }
    paths = ["a.7z", "b.7z"]
    merged, members, resp_files = lm.merge_archive_day(paths, lambda p: listings[p])
    lm.ingest_day(conn, "2026-09-20", lm.archive_source_label(paths),
                  members, merged, resp_files)

    total = conn.execute(
        "SELECT SUM(n) FROM responses WHERE day='2026-09-20'"
    ).fetchone()[0]
    assert total == 5, "a shared day must report BOTH producers, got %r" % total
    source = conn.execute("SELECT source FROM days").fetchone()[0]
    assert "a.7z" in source and "b.7z" in source
    conn.close()


def _main():
    tests = [(n, o) for n, o in sorted(globals().items())
             if n.startswith("test_") and callable(o)]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print("  PASS  %s" % name)
        except AssertionError as exc:
            failed.append((name, exc))
            print("  FAIL  %s -- %s" % (name, exc))
    print("\n%d/%d passed" % (len(tests) - len(failed), len(tests)))
    # A suite that collected nothing must never read as green.
    if not tests:
        print("NO TESTS COLLECTED")
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
