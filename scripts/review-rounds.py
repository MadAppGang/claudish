#!/usr/bin/env python3
r"""Review-rounds instrument (claudish #445 axis B, replacement metric).

The coordinator's B3 measurement (c.6233290794, 17/10) retired the
"one comment per pushed head" target (0 same-author restatements found)
and replaced it with a turns metric: **CR rounds per merged PR**, plus
the share of CRs whose blocker was a non-discriminating pin. This script
measures the first half automatically, per calendar month:

    python scripts/review-rounds.py [--months 2] [--max-prs 250]
        [--repo jsboige/claudish] [--selftest]

Read-only, REST only (GraphQL is chronically exhausted on jsboige —
memory github-graphql-rest-first), bounded by construction:

  - one listing pass (`state=closed&sort=updated&direction=desc`),
    page-capped (`--max-pages`, default 10 = 1000 PRs), stopped when a
    page's oldest item was last updated before the window (updated_at
    >= merged_at, so nothing past it can be merged in-window);
  - ONE reviews call per in-window merged PR (`--max-prs` cap per month,
    default 250), single page (100 reviews — more is a review storm this
    metric does not need; if a PR returns exactly 100 its counts are
    marked truncated);
  - no bodies fetched — neither PR bodies nor review bodies. Only
    numbers, states, timestamps and logins leave the API.

Reading rules that change verdicts:
  - a month bucket is keyed by `merged_at` (UTC) — a PR reviewed in
    September but merged 01/10 00:30Z is an October PR;
  - reviews by the PR AUTHOR are excluded from every count (self-
    comments are not review rounds);
  - a first review submitted AFTER the merge counts as a review but is
    excluded from the first-review→merge age (post-merge tidy-up);
  - CHANGES_REQUESTED dismissed then re-requested by the same reviewer
    counts twice — that IS a second round on the wire.

The "non-discriminating pin" share of axis B stays MANUAL labeling
(pins are named in review bodies, which this script does not read) —
do not automate it by keyword, that was B3's original sin.
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone

PAGE = 100
REVIEW_STATES_FORMAL = {"APPROVED", "CHANGES_REQUESTED"}


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default="jsboige/claudish")
    ap.add_argument("--months", type=int, default=2,
                    help="calendar months back from now (UTC), merged_at-keyed")
    ap.add_argument("--max-prs", type=int, default=250,
                    help="cap of merged PRs measured per month (0 = all in window)")
    ap.add_argument("--max-pages", type=int, default=10,
                    help="hard cap on listing pages (bounded-pass rule)")
    ap.add_argument("--selftest", action="store_true",
                    help="run the aggregation checks on synthetic data, no network")
    return ap.parse_args()


def gh_rest(path, timeout=30):
    """One bounded gh api REST call. Raises on failure — a partial read
    here would silently bias every ratio below."""
    out = subprocess.run(
        ["gh", "api", path], capture_output=True, text=True,
        encoding="utf-8", timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError("gh api %s: %s" % (path, out.stderr[:200]))
    return json.loads(out.stdout)


def month_key(iso):
    return iso[:7]  # 2026-10-17T... -> 2026-10


def walk_closed_pages(pages, window_start):
    """Pager core: yield in-window merged PRs from a sequence of pages
    (newest-updated first, as the API sorts them). Stops when a page's
    OLDEST item was last updated before window_start — updated_at >=
    merged_at, so nothing past that point can be merged in-window; that
    is the exact bound. A page full of PRs updated in-window but NOT
    merged in-window (bulk closes of stale PRs, audit comments on old
    merges) must NOT stop the walk — the old "first page with no
    in-window merge" rule did exactly that, silently dropping every
    in-window merge on later pages."""
    for items in pages:
        if not items:
            return
        for pr in items:
            if pr.get("merged_at") and pr["merged_at"] >= window_start:
                yield pr
        if items[-1].get("updated_at", "") < window_start:
            return  # oldest item of the page predates the window


def list_merged_prs(repo, window_start, max_pages):
    """Yield closed PRs merged at/after window_start, newest-updated
    first, one gh_rest page at a time through walk_closed_pages."""
    def pager():
        for page in range(1, max_pages + 1):
            yield gh_rest("repos/%s/pulls?state=closed&sort=updated"
                          "&direction=desc&per_page=%d&page=%d"
                          % (repo, PAGE, page))
    yield from walk_closed_pages(pager(), window_start)


def fetch_reviews(repo, number):
    """One page of reviews for a PR (author exclusion happens in
    aggregate — one enforcement site)."""
    rvs = gh_rest("repos/%s/pulls/%d/reviews?per_page=%d"
                  % (repo, number, PAGE))
    truncated = len(rvs) == PAGE
    return rvs, truncated


def aggregate(prs_with_reviews):
    """Pure aggregation — everything the selftest exercises.

    prs_with_reviews: [(pr_dict, [review_dict, ...], truncated_bool)]
    Returns {month: {...}} with the rendered metric set.
    """
    months = {}
    for pr, reviews, truncated in prs_with_reviews:
        mk = month_key(pr["merged_at"])
        m = months.setdefault(mk, {
            "merged": 0, "formal": 0, "cr": 0, "pr_with_cr": 0,
            "no_review": 0, "ages_h": [], "truncated": 0})
        m["merged"] += 1
        if truncated:
            m["truncated"] += 1
        # author's own reviews are not review rounds — enforced HERE, not
        # at fetch, so the invariant holds for every caller (selftest feeds
        # raw lists with the author's review still in)
        author = (pr.get("user") or {}).get("login")
        reviews = [r for r in reviews
                   if (r.get("user") or {}).get("login") != author]
        formal = [r for r in reviews if r.get("state") in REVIEW_STATES_FORMAL]
        crs = [r for r in formal if r.get("state") == "CHANGES_REQUESTED"]
        m["formal"] += len(formal)
        m["cr"] += len(crs)
        if crs:
            m["pr_with_cr"] += 1
        if not reviews:
            m["no_review"] += 1
            continue
        first = min(r["submitted_at"] for r in reviews if r.get("submitted_at"))
        merged = pr["merged_at"]
        if first <= merged:  # post-merge reviews excluded from the age
            m["ages_h"].append(iso_delta_h(first, merged))
    return months


def iso_delta_h(a, b):
    pa = datetime.fromisoformat(a.replace("Z", "+00:00"))
    pb = datetime.fromisoformat(b.replace("Z", "+00:00"))
    return (pb - pa).total_seconds() / 3600.0


def median(xs):
    s = sorted(xs)
    n = len(s)
    if not n:
        return float("nan")
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def report(months):
    print("| month | merged | formal rev/PR | CR rounds/PR | PRs ≥1 CR | "
          "no review | 1st-rev→merge h (med/mean) | trunc |")
    print("|---|---|---|---|---|---|---|---|")
    for mk in sorted(months):
        m = months[mk]
        n = m["merged"] or 1
        ages = m["ages_h"]
        mean = sum(ages) / len(ages) if ages else float("nan")
        print("| %s | %d | %.2f | %.2f | %d (%.0f%%) | %d | %s / %s | %d |" % (
            mk, m["merged"], m["formal"] / n, m["cr"] / n,
            m["pr_with_cr"], 100.0 * m["pr_with_cr"] / n, m["no_review"],
            _fmt_h(median(ages)), _fmt_h(mean), m["truncated"]))


def _fmt_h(x):
    return "—" if x != x else "%.1f" % x


def selftest():
    """Synthetic corpus, exact expected numbers. Red if any aggregation
    branch (month keying, author exclusion, post-merge age exclusion,
    CR share) drifts."""
    def pr(n, merged, author="alice"):
        return {"number": n, "merged_at": merged, "user": {"login": author}}

    def rv(state, at, author="bob"):
        return {"state": state, "submitted_at": at, "user": {"login": author}}

    corpus = [
        # Sep PR, 2 formal rounds (1 CR), first review 10h before merge
        (pr(1, "2026-09-30T20:00:00Z"),
         [rv("CHANGES_REQUESTED", "2026-09-30T05:00:00Z"),
          rv("APPROVED", "2026-09-30T19:00:00Z")], False),
        # Oct PR, author's own comment must NOT count as review; 1 CR
        (pr(2, "2026-10-01T00:30:00Z"),
         [rv("COMMENTED", "2026-09-30T22:00:00Z", author="alice"),
          rv("CHANGES_REQUESTED", "2026-09-30T23:00:00Z")], False),
        # Oct PR, no review at all
        (pr(3, "2026-10-02T10:00:00Z"), [], False),
        # Oct PR, first review AFTER merge -> counts, age excluded
        (pr(4, "2026-10-03T09:00:00Z"),
         [rv("APPROVED", "2026-10-03T11:00:00Z")], False),
        # Oct PR, same reviewer CRs twice = 2 rounds
        (pr(5, "2026-10-04T00:00:00Z"),
         [rv("CHANGES_REQUESTED", "2026-10-03T01:00:00Z"),
          rv("CHANGES_REQUESTED", "2026-10-03T20:00:00Z")], False),
    ]
    months = aggregate(corpus)
    sep, oct_ = months["2026-09"], months["2026-10"]
    # pager form: page 1 holds ONLY in-window-updated, not-in-window-
    # merged PRs (bulk close / audit comments on old merges) — the old
    # "first page with no in-window merge" rule stopped there and lost
    # page 2. Red on that rule, green on the updated_at bound.
    def pgrp(n, merged, updated):
        return {"number": n, "merged_at": merged, "updated_at": updated,
                "user": {"login": "alice"}}
    pager_pages = [
        [pgrp(900, "2026-09-01T00:00:00Z", "2026-10-05T00:00:00Z"),  # old merge, fresh comment
         pgrp(901, None, "2026-10-04T00:00:00Z")],                    # bulk-closed, never merged
        [pgrp(902, "2026-10-03T00:00:00Z", "2026-10-06T00:00:00Z"),  # in-window merge
         pgrp(903, "2026-10-02T00:00:00Z", "2026-09-20T00:00:00Z")], # in-window merge, oldest < window -> stop
        [pgrp(904, "2026-10-01T12:00:00Z", "2026-10-07T00:00:00Z")], # never reached
    ]
    walked = [p["number"] for p in
              walk_closed_pages(iter(pager_pages), "2026-10-01T00:00:00Z")]
    checks = [
        ("sep merged", sep["merged"], 1),
        ("sep formal", sep["formal"], 2),
        ("sep cr", sep["cr"], 1),
        ("sep ages", sep["ages_h"], [15.0]),
        ("oct merged", oct_["merged"], 4),
        ("oct formal", oct_["formal"], 4),  # 1 CR + 0 + 1 APPROVED + 2 CR
        ("oct cr", oct_["cr"], 3),
        ("oct pr_with_cr", oct_["pr_with_cr"], 2),
        ("oct no_review", oct_["no_review"], 1),
        # PR2: CR 23:00 -> merge 00:30 = 1.5h ; PR4 excluded (post-merge) ;
        # PR5: CR Oct3 01:00 -> merge Oct4 00:00 = 23h
        ("oct ages", oct_["ages_h"], [1.5, 23.0]),
        # pager: page 1 (no in-window merge) must NOT stop the walk;
        # page 2's oldest updated_at < window must; page 3 never fetched
        ("pager survives page-1 noise", walked, [902, 903]),
    ]
    fails = [(l, got, want) for l, got, want in checks if got != want]
    for l, got, want in checks:
        v = "PASS" if (l, got, want) not in fails else "FAIL"
        print("  %s %s: %r (want %r)" % (v, l, got, want))
    if fails:
        sys.exit("selftest FAILED: %s" % [f[0] for f in fails])
    print("selftest: all forms green")


def main():
    args = parse_args()
    if args.selftest:
        selftest()
        return
    now = datetime.now(timezone.utc)
    # window_start = first day of the month `--months` months back
    y, mo = now.year, now.month - (args.months - 1)
    while mo <= 0:
        mo += 12
        y -= 1
    window_start = "%04d-%02d-01T00:00:00Z" % (y, mo)
    print("run (UTC): %s | window: >= %s | repo: %s"
          % (now.strftime("%Y-%m-%dT%H:%M:%SZ"), window_start, args.repo))
    prs = list(list_merged_prs(args.repo, window_start, args.max_pages))
    by_month = {}
    for pr in prs:
        by_month.setdefault(month_key(pr["merged_at"]), []).append(pr)
    corpus = []
    for mk in sorted(by_month):
        batch = by_month[mk]
        if args.max_prs:
            batch = batch[:args.max_prs]
            if len(by_month[mk]) > len(batch):
                print("  (month %s capped at %d merged PRs of %d)"
                      % (mk, len(batch), len(by_month[mk])))
        for pr in batch:
            reviews, truncated = fetch_reviews(args.repo, pr["number"])
            corpus.append((pr, reviews, truncated))
        print("  month %s: %d merged PRs read" % (mk, len(batch)))
    report(aggregate(corpus))


if __name__ == "__main__":
    main()
