#!/usr/bin/env python3
"""Fleet consumption dashboard — Epic #116 P2 seed.

Reads the lane-series organ store (lane-matrix.py, #118) and GitHub merge
history, emits a single self-contained HTML dashboard (inline CSS + SVG, no
JS, no external assets) with written interpretations marked [M]/[I]/[?].

Constraints (Epic #116 §4): regenerable by one command, off-peak window
(05-07Z) only, never blocks anything — this is a read-only consumer of the
store, it never touches the archives or the hub.

Usage:
    python scripts/fleet-dashboard.py \
        [--store D:\\claudish-captures\\lane-series.sqlite] \
        [--repos jsboige/CoursIA jsboige/roo-extensions jsboige/claudish] \
        [--out D:\\claudish-captures\\fleet-dashboard.html]

Merges come from `gh pr list --state merged --search "merged:>=DATE"` —
run under an account with read access, no writes are made.
"""
import argparse
import datetime as dt
import html
import json
import subprocess
import sqlite3
import sys

# Lane groups — classification by model substring, handler checked for native.
# Keep stable: the group palette and interpretation text depend on these keys.
LANE_GROUPS = [
    ("PAYG DeepSeek", lambda h, m: "deepseek-flash" in m, "#c0392b"),
    ("GLM", lambda h, m: "glm-5" in m, "#2980b9"),
    ("MiniMax", lambda h, m: "minimax" in m.lower(), "#27ae60"),
    ("Kimi", lambda h, m: "k3" == m.lower() or "kimi" in m.lower(), "#8e44ad"),
    ("Qwen", lambda h, m: "qwen" in m.lower(), "#16a085"),
    ("Sol/OpenAI", lambda h, m: "sol" in m.lower() or "gpt" in m.lower(), "#d35400"),
    ("Native Anthropic", lambda h, m: h == "native", "#f1c40f"),
    ("Autres", lambda h, m: True, "#7f8c8d"),
]


def group_of(handler: str, model: str) -> str:
    for name, pred, _ in LANE_GROUPS:
        if pred(handler, model):
            return name
    return "Autres"


def load_store(path: str):
    db = sqlite3.connect(path)
    rows = db.execute(
        "SELECT day, handler, model, SUM(n) FROM responses GROUP BY day, handler, model"
    ).fetchall()
    days = [r[0] for r in db.execute("SELECT day FROM days ORDER BY day")]
    db.close()
    series = {}  # day -> {group: count}
    lanes = {}   # day -> {(handler, model): count}
    for day, handler, model, n in rows:
        series.setdefault(day, {})
        g = group_of(handler, model)
        series[day][g] = series[day].get(g, 0) + n
        lanes.setdefault(day, {})[(handler, model)] = n
    return days, series, lanes


def fetch_merges(repo: str, since: str) -> list:
    """Merged PRs per day via the REST pulls API, paginated, early-stopped.

    gh pr list --search caps at 1000 results — CoursIA merges ~124/day, so a
    3-month window overflows the cap and silently truncates. The pulls API
    paginates without a global limit; sort=updated desc lets us stop as soon
    as updated_at < since (updated_at >= merged_at always, so no merged PR
    after `since` can appear past the stop).
    """
    # sort=updated is unusable here: an old PR commented on today sorts above
    # yesterday's 124 merges and trips a naive early-stop (measured: 1472
    # fetched vs 3730 actual July merges). sort=created is a total order; we
    # stop one buffer-window before `since` to catch PRs merged after creation.
    buffer_until = (dt.date.fromisoformat(since) - dt.timedelta(days=14)).isoformat()
    merged = []
    page = 1
    while page < 200:  # 200 pages = 20k PRs = a hard backstop
        cmd = [
            "gh", "api",
            f"repos/{repo}/pulls?state=closed&sort=created&direction=desc&per_page=100&page={page}",
            "--jq", '.[] | [.created_at[:10], (.merged_at // "")[:10]] | @tsv',
        ]
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            print(f"  gh api failed for {repo} p{page}: {out.stderr.strip()[:160]}", file=sys.stderr)
            break
        rows = [l.split("\t") for l in out.stdout.splitlines() if l.strip()]
        if not rows:
            break
        merged += rows
        if min(r[0] for r in rows) < buffer_until:
            break
        page += 1
    return [{"day": m, "repo": repo.split("/")[-1]}
            for _, m in merged if m and m >= since]


def daily_total(series: dict, day: str) -> int:
    return sum(series.get(day, {}).values())


def window_stats(days: list, series: dict, lo: str, hi: str) -> dict:
    """Aggregate a [lo, hi] day window: totals per group + per-day mean."""
    grp, n_days, tot = {}, 0, 0
    for d in days:
        if lo <= d <= hi:
            n_days += 1
            for g, v in series.get(d, {}).items():
                grp[g] = grp.get(g, 0) + v
                tot += v
    return {
        "groups": grp, "total": tot, "n_days": n_days,
        "per_day": tot / n_days if n_days else 0,
    }


def svg_stacked_bars(days, series, width=1060, height=300, max_bars=110):
    days = days[-max_bars:]
    total_max = max((daily_total(series, d) for d in days), default=1)
    left, right, top, bottom = 46, 10, 14, 34
    plot_w, plot_h = width - left - right, height - top - bottom
    bw = plot_w / len(days)
    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="reponses par jour et par groupe">'
    ]
    for gi in range(0, 5):
        y = top + plot_h - plot_h * gi / 4
        v = total_max * gi / 4
        parts.append(f'<line x1="{left}" y1="{y:.0f}" x2="{width-right}" y2="{y:.0f}" stroke="#e0e0e0"/>')
        parts.append(f'<text x="{left-6}" y="{y+4:.0f}" text-anchor="end" font-size="10" fill="#666">{v/1000:.0f}k</text>')
    for i, d in enumerate(days):
        x = left + i * bw
        y = top + plot_h
        for name, _, color in LANE_GROUPS:
            v = series.get(d, {}).get(name, 0)
            if not v:
                continue
            h = plot_h * v / total_max
            y -= h
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw*0.92:.1f}" height="{h:.1f}" fill="{color}"/>')
        if i % max(1, len(days) // 10) == 0:
            parts.append(f'<text x="{x+bw/2:.0f}" y="{height-8}" text-anchor="middle" font-size="9" fill="#666">{d[5:]}</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_dual_series(days, a, b, label_a, label_b, color_a, color_b, width=1060, height=220):
    """Two normalized series on one plot, independent scales, shared x."""
    days = days[-110:]
    ma, mb = max(a(d) for d in days) or 1, max(b(d) for d in days) or 1
    left, right, top, bottom = 46, 46, 14, 30
    plot_w, plot_h = width - left - right, height - top - bottom
    def xy(i, v, m):
        x = left + plot_w * i / max(1, len(days) - 1)
        y = top + plot_h - plot_h * v / m
        return x, y
    parts = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{label_a} vs {label_b}">']
    for gi in range(3):
        y = top + plot_h - plot_h * gi / 2
        parts.append(f'<line x1="{left}" y1="{y:.0f}" x2="{width-right}" y2="{y:.0f}" stroke="#eee"/>')
        parts.append(f'<text x="{left-6}" y="{y+4:.0f}" text-anchor="end" font-size="10" fill="{color_a}">{ma*gi/2:.0f}</text>')
        parts.append(f'<text x="{width-right+6}" y="{y+4:.0f}" font-size="10" fill="{color_b}">{mb*gi/2:.1f}</text>')
    for mk, getter, color, m in ((a, a, color_a, ma), (b, b, color_b, mb)):
        pts = []
        for i, d in enumerate(days):
            x, y = xy(i, getter(d), m)
            pts.append(f"{x:.1f},{y:.1f}")
        parts.append(f'<polyline fill="none" stroke="{color}" stroke-width="1.6" points="{" ".join(pts)}"/>')
    parts.append(f'<text x="{left}" y="12" font-size="11" fill="{color_a}">{label_a} (max {ma:.0f})</text>')
    parts.append(f'<text x="{width-right}" y="12" text-anchor="end" font-size="11" fill="{color_b}">{label_b} (max {mb:.1f})</text>')
    for i, d in enumerate(days):
        if i % max(1, len(days) // 10) == 0:
            x, _ = xy(i, 0, 1)
            parts.append(f'<text x="{x:.0f}" y="{height-6}" text-anchor="middle" font-size="9" fill="#666">{d[5:]}</text>')
    parts.append("</svg>")
    return "".join(parts)


def pct(x, digits=1):
    return f"{100*x:.{digits}f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--store", default=r"D:\claudish-captures\lane-series.sqlite")
    ap.add_argument("--repos", nargs="+",
                    default=["jsboige/CoursIA", "jsboige/roo-extensions", "jsboige/claudish"])
    ap.add_argument("--out", default=r"D:\claudish-captures\fleet-dashboard.html")
    args = ap.parse_args()

    days, series, lanes = load_store(args.store)
    if not days:
        sys.exit("store empty — run lane-matrix.py first")
    since = days[0]

    print(f"store: {len(days)} days {days[0]}..{days[-1]}")
    merges = []
    for repo in args.repos:
        prs = fetch_merges(repo, since)
        print(f"  {repo}: {len(prs)} merged PRs since {since}")
        merges += prs
    merges_by_day = {}
    for pr in merges:
        merges_by_day[pr["day"]] = merges_by_day.get(pr["day"], 0) + 1

    # Reference windows: July peak regime vs the last 14 complete days.
    july = window_stats(days, series, "2026-07-01", "2026-07-31")
    last_end = days[-1]
    lo_recent = (dt.date.fromisoformat(last_end) - dt.timedelta(days=14)).isoformat()
    recent = window_stats(days, series, lo_recent, last_end)
    merges_july = sum(v for d, v in merges_by_day.items() if "2026-07-01" <= d <= "2026-07-31")
    merges_recent = sum(v for d, v in merges_by_day.items() if d >= lo_recent)
    mj_pd = merges_july / 31 if merges_july else 0
    mr_pd = merges_recent / 14 if merges_recent else 0

    def payg_day(d):
        return series.get(d, {}).get("PAYG DeepSeek", 0)

    def merges_day(d):
        return merges_by_day.get(d, 0)

    def native_share_day(d):
        t = daily_total(series, d)
        return 100 * series.get(d, {}).get("Native Anthropic", 0) / t if t else 0

    legend = "".join(
        f'<span class="lg"><i style="background:{color}"></i>{html.escape(name)}</span>'
        for name, _, color in LANE_GROUPS
    )
    kpi_pr_resp_july = july["per_day"] / mj_pd if mj_pd else 0
    kpi_pr_resp_recent = recent["per_day"] / mr_pd if mr_pd else 0

    doc = f"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard consommation flotte — claudish #116</title>
<style>
 body{{margin:0;font:14px/1.5 system-ui,sans-serif;color:#222;background:#fafafa}}
 main{{max-width:1100px;margin:0 auto;padding:20px 16px 48px}}
 h1{{font-size:20px;margin:.2em 0 .1em}} h2{{font-size:15px;margin:1.6em 0 .4em;color:#333}}
 .sub{{color:#777;font-size:12px;margin-bottom:14px}}
 .cards{{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}}
 .card{{flex:1 1 150px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:10px 12px}}
 .card b{{display:block;font-size:19px;margin-top:2px}}
 .card small{{color:#888}}
 .lg{{display:inline-flex;align-items:center;gap:5px;margin:0 10px 4px 0;font-size:12px;color:#555}}
 .lg i{{width:10px;height:10px;border-radius:2px;display:inline-block}}
 figure{{margin:0 0 8px;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:10px}}
 figcaption{{font-size:12px;color:#555;margin-bottom:6px}}
 table{{border-collapse:collapse;font-size:13px;width:100%;background:#fff}}
 th,td{{border:1px solid #e8e8e8;padding:4px 8px;text-align:right}}
 th:first-child,td:first-child{{text-align:left}}
 .int{{background:#fff;border-left:3px solid #2980b9;padding:8px 14px;margin:8px 0;font-size:13px}}
 .int .mk{{font-weight:700;margin-right:6px}}
 footer{{color:#999;font-size:11px;margin-top:28px}}
 @media (prefers-color-scheme: dark){{
  body{{background:#141516;color:#ddd}} .card,figure,table{{background:#1d1e20;border-color:#333}}
  th,td{{border-color:#333}} .int{{background:#1d1e20}} .sub,.card small,figcaption,footer{{color:#999}}
  h2{{color:#bbb}}}}
</style></head><body><main>
<h1>Dashboard consommation flotte</h1>
<div class="sub">Epic #116 · P2 seed · généré le {dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
· store {html.escape(args.store)} ({len(days)} jours, {days[0]} → {days[-1]})
· merges : {len(merges)} PRs mergées sur {len(args.repos)} repos depuis {since}</div>

<div class="cards">
 <div class="card">Réponses/jour (juillet)<b>{july["per_day"]:,.0f}</b><small>{july["total"]:,} sur 31 j</small></div>
 <div class="card">Réponses/jour (14 derniers j)<b>{recent["per_day"]:,.0f}</b><small>×{(recent["per_day"]/july["per_day"] if july["per_day"] else 0):.2f} vs juillet</small></div>
 <div class="card">Merges/jour (juillet)<b>{mj_pd:.1f}</b><small>{merges_july} PRs</small></div>
 <div class="card">Merges/jour (14 derniers j)<b>{mr_pd:.1f}</b><small>{merges_recent} PRs</small></div>
 <div class="card">PRs / M-réponses (juillet)<b>{(1000/kpi_pr_resp_july if kpi_pr_resp_july else 0):.1f}</b><small>proxy [I] — voir KPI exact tokens §interprétations</small></div>
 <div class="card">PRs / M-réponses (14 j)<b>{(1000/kpi_pr_resp_recent if kpi_pr_resp_recent else 0):.1f}</b><small>×{(kpi_pr_resp_recent/kpi_pr_resp_july if kpi_pr_resp_july else 0):.2f} la productivité unitaire vs juillet</small></div>
</div>

<h2>1 · Réponses/jour par groupe de lane</h2>
<div>{legend}</div>
<figure>{svg_stacked_bars(days, series)}<figcaption>Réponses servies par jour (110 derniers jours).
La lane native Anthropic (jaune) n'est plus qu'une fraction du volume ; le PAYG DeepSeek (rouge) devient une lane de premier plan — voir §4bis.3 et le commentaire §5.1 de l'issue #116.</figcaption></figure>

<h2>2 · Trop-plein PAYG (mécanique de débordement) vs merges</h2>
<figure>{svg_dual_series(days, payg_day, merges_day, "réponses PAYG/jour", "merges/jour", "#c0392b", "#2c3e50")}<figcaption>⚠ Le PAYG est notre TROP-PLEIN, pas notre dépense : les abonnements (OpenAI, Kimi, Qwen, Mistral, GLM, MiniMax…) paient l'essentiel du volume et invalident toute extrapolation PAYG→dépense (#116 §5.3). Ce graphique lit la MÉCANIQUE du débordement : [M] le PAYG suit les murs GLM (r = +0,697 horaire ; 98,5 % du trafic PAYG tombe pendant les heures de mur — #116, commentaire 15/09), pas le volume de production.</figcaption></figure>

<h2>3 · Part de la lane native Anthropic</h2>
<figure>{svg_dual_series(days, native_share_day, lambda d: merges_day(d), "native % du total", "merges/jour", "#b7950b", "#2c3e50")}<figcaption>La part native (échelle gauche, %) glisse de ~13-15 % début juillet vers ~4 % — les organes natif-centrés ne voient plus que la queue de la distribution (#116 §5.4).</figcaption></figure>

<h2>4 · Groupes de lanes : juillet vs 14 derniers jours</h2>
<table><tr><th>groupe</th><th>juillet (resp/j)</th><th>14 derniers j (resp/j)</th><th>ratio</th></tr>
{''.join(f'<tr><td>{html.escape(g)}</td><td>{july["groups"].get(g,0)/31:,.0f}</td><td>{recent["groups"].get(g,0)/max(1,recent["n_days"]):,.0f}</td><td>×{(recent["groups"].get(g,0)/recent["n_days"])/(july["groups"].get(g,1)/31) if july["groups"].get(g) else 0:.2f}</td></tr>' for g,_,_ in LANE_GROUPS)}
</table>

<h2>5 · Interprétations (versionnées, datées — #116 §4bis.4)</h2>
<div class="int"><span class="mk">[M]</span><b>La production est tenue (127 → 129 merges/j), toute la dérive est en tokens.</b> Juillet complet (native-trend, 31/31 jours) : 101,8 M OUT natif sur le mois (3,28 M/j en moyenne ; pics 02/07 9,65 M et 16/07 9,52 M) à $ marginal nul → **~39 PRs/M-OUT en moyenne, ~20 les jours de pic mi-juillet**. 13/09 : OUT/req ×3,21 (1 872 → 6 307), compactions ×2,93 (16 % → 26 % du flux) ; 67 % du delta = réponses plus grasses (rampe ~12/09), 33 % = compactions. À noter : l'inflation du coût unitaire de compaction a démarré DANS juillet (moyComp 9,0-9,9k le 1-16/07 → 14,3k le 30/07 ≈ niveau du 13/09) — l'événement spécifique à septembre est l'explosion d'OUT/req.</div>
<div class="int"><span class="mk">[M]</span><b>Le PAYG n'est pas un appoint, c'est un débordement de mur.</b> 98,5 % du trafic deepseek-flash arrive pendant les heures de mur GLM (429 code 1308 ; r = +0,697, n = 191 h). Le levier n'est pas la lane DeepSeek : c'est la forme de la consommation GLM dans sa fenêtre de 5 h (lissage des crons lourds, ordre de cascade avant PAYG).</div>
<div class="int"><span class="mk">[I]</span><b>Le KPI PRs/M-réponses de ce dashboard est un proxy</b> tant que la série OUT multi-lanes n'est pas branchée. Le KPI exact est en <b>tokens générés</b> : OUT total (toutes lanes) par PR — extrait par lane-out-trend.py. Toute conversion en $ exige les bornes des abonnements (P0 : les murs comme mesures de capacité), <b>jamais</b> une extrapolation depuis le PAYG : le PAYG est le trop-plein, pas la dépense, et les abonnements (OpenAI, Kimi, Qwen, Mistral…) rendent toute extrapolation de ce type invalide.</div>
<div class="int"><span class="mk">[?]</span><b>La série Sol démarre au 14/09 21:42Z</b> (fix capture #90) et reste aveugle au cache (#115/#117) : tout zéro de cache sur cette lane est un artefact d'instrument, pas une mesure.</div>

<footer>Généré par scripts/fleet-dashboard.py (Epic #116 P2 seed) — fenêtre de régénération 05-07Z uniquement.
Sources : store lane-matrix (#118, listings d'archives hub) · GitHub API (merges) · native-trend.py (§5, mesures du 16/09).
Aucune valeur de secret n'apparaît dans cet artefact.</footer>
</main></body></html>"""

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"written: {args.out}")


if __name__ == "__main__":
    main()
