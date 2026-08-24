#!/usr/bin/env python3
"""traffic-consumption.py — tableau de consommation flotte par lane (Epic #41, Phase 1).

Source : les captures du hub (req-*.json + resp-*.sse). Sortie : rollup par
lane provider x bucket (cron / interactive / agent-sdk / other), avec tokens
in/out, cache read/creation, hit-rate et debit/h sur la fenetre.

Usage:
  python scripts/traffic-consumption.py --hours 3
  python scripts/traffic-consumption.py --hours 24 --machines
  python scripts/traffic-consumption.py --hours 24 --json      # pour le join Phase 3

PIEGES encodes (mesures Epic #41 + harness-injection-measure.py) :
1) (pid, reqN) n'est PAS unique — le compteur repart a 0 a chaque redemarrage
   du container. On indexe par CLE -> LISTE horodatee et on tranche par le
   temps : la requete PRECEDE sa reponse (derniere candidate <= resp_ts).
2) GLM (wire openai) emet un bloc usage ZERO avant le vrai : on prend le MAX
   de chaque compteur sur toutes les occurrences, jamais la premiere.
3) Les lanes wire-openai (GLM, DeepSeek, Qwen-api) ne rapportent PAS de cache
   : hit% = n/a (pas 0%) — c'est une absence de donnee, pas un echec de cache.
4) Le bucket vient du bloc system `x-anthropic-billing-header:` de la REQUETE
   (cc_workload=cron en flag ~33%, cc_entrypoint ~100%). Couverture partielle
   de cc_workload = semantique de flag : absent signifie "pas cron".
   Reconciliation : le bucket "other" inclut les probes/ingress non-CC ; si
   cc_entrypoint manque sur une requete CC, on surclasse "other" — mesure
   24/08 : 0 cas sur l'echantillon.
5) Les fichiers geants (1 Mo+) ont leur dernier message_delta AU-DELA de la
   tete lue : on lit tete 200 Ko + queue 100 Ko, jamais seulement la tete.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from collections import defaultdict

REQ_FN = re.compile(r"^req-(\d+)-(\d+)-(.+)\.json$")
RESP_FN = re.compile(r"^resp-\d+-r\d+-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-(.+)\.sse$")
HDR = re.compile(r"^#\s*parser=(\S+)\s+model=(\S+)\s+reqN=(\d+)\s+pid=(\d+)", re.M)
RESP_TS = re.compile(r"resp-\d+-r\d+-(\d{4}-\d{2}-\d{2}T[\d-]+Z)-")

MACHINE_FIELD = re.compile(r'"machine"\s*:\s*"([^"]*)"')
BILLING_EP = re.compile(r"cc_entrypoint=([^;\s]+)")
BILLING_WL = re.compile(r"cc_workload=([^;\s]+)")

HEAD_BYTES = 200_000
TAIL_BYTES = 100_000
REQ_HEAD_BYTES = 150_000

# Lane provider par nom de modele servit (l'en-tete resp porte le modele FINAL).
LANES = [
    (re.compile(r"^glm-"), "gc@ GLM Coding"),
    (re.compile(r"^MiniMax", re.I), "mmc@ MiniMax"),
    (re.compile(r"^qwen", re.I), "qwen-token-plan"),
    (re.compile(r"^deepseek", re.I), "ds@ PAYG"),
    (re.compile(r"^gpt-5\.6-sol|^codex", re.I), "cx@ Sol (OpenAI Pro)"),
    (re.compile(r"^claude-"), "native-anthropic"),
]
# Les lanes wire-openai ne rapportent aucun champ de cache (piege 3).
NO_CACHE_LANES = {"gc@ GLM Coding", "ds@ PAYG"}


def lane_for(model):
    for rx, lane in LANES:
        if rx.match(model):
            return lane
    return model


def capture_dt(ts):
    """`2026-08-20T19-10-11-203Z` -> datetime UTC (tIRETS, pas de deux-points)."""
    try:
        return datetime.strptime(ts[:19], "%Y-%m-%dT%H-%M-%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def balanced_object(s, start):
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(s[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def usage_max(text):
    """MAX de chaque compteur sur toutes les occurrences `usage` du texte.

    Piege 2 : GLM emet un usage zero PUIS le vrai — max, jamais premier/dernier
    par defaut. En wire anthropic les compteurs de message_delta sont cumulatifs
    (monotones) : le max reste correct.
    """
    inp = cread = ccre = out = 0
    seen = False
    for m in re.finditer(r'"usage"\s*:\s*', text):
        brace = text.find("{", m.end())
        if brace < 0:
            continue
        u = balanced_object(text, brace)
        if not isinstance(u, dict):
            continue
        seen = True
        inp = max(inp, u.get("input_tokens") or 0)
        cread = max(cread, u.get("cache_read_input_tokens") or 0)
        ccre = max(ccre, u.get("cache_creation_input_tokens") or 0)
        out = max(out, u.get("output_tokens") or 0)
    return (inp, out, cread, ccre) if seen else None


def read_head_tail(path, head=HEAD_BYTES, tail=TAIL_BYTES):
    with open(path, "rb") as fh:
        head_txt = fh.read(head).decode("utf-8", errors="replace")
        size = fh.seek(0, 2)
        if size <= head:
            return head_txt
        if size <= head + tail:
            fh.seek(head)
            return head_txt + fh.read().decode("utf-8", errors="replace")
        fh.seek(size - tail)
        return head_txt + fh.read(tail).decode("utf-8", errors="replace")


def bucket_of(info):
    """4 buckets : cron / interactive / agent-sdk / other."""
    if info["wl"] == "cron":
        return "cron"
    ep = info["ep"]
    if ep and ep.startswith("sdk"):
        return "agent-sdk"
    if ep:
        return "interactive"
    return "other"


def load_requests(cdir, cutoff_dt):
    """(pid, reqN) -> liste horodatee de dicts {ts, machine, ep, wl}.

    On ne lit que la TETE du fichier : machine + bloc billing system sont
    toujours en debut de corps (system precede messages/tools sur le wire
    anthropique). Le JSON complet (jusqu'a 1 Mo) ne sert a rien ici.
    """
    reqs = defaultdict(list)
    for fn in os.listdir(cdir):
        m = REQ_FN.match(fn)
        if not m:
            continue
        dt = capture_dt(m.group(3))
        if dt is None or dt < cutoff_dt:
            continue
        try:
            with open(os.path.join(cdir, fn), "rb") as fh:
                head = fh.read(REQ_HEAD_BYTES).decode("utf-8", errors="replace")
        except OSError:
            continue
        mm = MACHINE_FIELD.search(head)
        em = BILLING_EP.search(head)
        wm = BILLING_WL.search(head)
        reqs[(int(m.group(1)), int(m.group(2)))].append({
            "ts": m.group(3),
            "machine": mm.group(1) if mm else "",
            "ep": em.group(1) if em else "",
            "wl": wm.group(1) if wm else "",
        })
    for v in reqs.values():
        v.sort(key=lambda d: d["ts"])
    return reqs


def pick_request(candidates, resp_ts):
    if not candidates:
        return None
    if resp_ts is None:
        return candidates[-1] if len(candidates) == 1 else None
    avant = [d for d in candidates if d["ts"] <= resp_ts]
    return avant[-1] if avant else None


def fmt_int(n):
    return f"{n:,}".replace(",", " ")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--dir", default=os.environ.get("CLAUDISH_CAPTURE_DIR", r"D:\claudish-captures"))
    ap.add_argument("--json", action="store_true", help="sortie JSON machine-lisible (Phase 3)")
    ap.add_argument("--machines", action="store_true", help="rollup supplementaire par lane x machine")
    args = ap.parse_args()

    cutoff = datetime.now(timezone.utc).timestamp() - args.hours * 3600
    cutoff_dt = datetime.fromtimestamp(cutoff, tz=timezone.utc)

    reqs = load_requests(args.dir, cutoff_dt)

    lanes = defaultdict(lambda: defaultdict(lambda: dict(n=0, inp=0, out=0, cread=0, ccre=0)))
    machines = defaultdict(lambda: defaultdict(lambda: dict(n=0, inp=0, out=0, cread=0, ccre=0)))
    n_resp = n_paired = n_unpaired = n_nousage = 0
    first_dt = last_dt = None

    for fn in os.listdir(args.dir):
        if not (fn.startswith("resp-") and fn.endswith(".sse")):
            continue
        rm = RESP_FN.match(fn)
        if not rm:
            continue
        dt = capture_dt(rm.group(1))
        if dt is None or dt < cutoff_dt:
            continue
        n_resp += 1
        if first_dt is None or dt < first_dt:
            first_dt = dt
        if last_dt is None or dt > last_dt:
            last_dt = dt
        path = os.path.join(args.dir, fn)
        try:
            txt = read_head_tail(path)
        except OSError:
            continue
        h = HDR.search(txt)
        if not h:
            continue
        model, reqn, pid = h.group(2), int(h.group(3)), int(h.group(4))
        tsm = RESP_TS.search(fn)
        req = pick_request(reqs.get((pid, reqn)) or [], tsm.group(1) if tsm else None)
        if req is None:
            n_unpaired += 1
            info = {"machine": "(unpaired)", "ep": "", "wl": ""}
            bucket = "other"
        else:
            n_paired += 1
            bucket = bucket_of(req)
            info = req
        u = usage_max(txt)
        if not u:
            n_nousage += 1
            inp = out = cread = ccre = 0
        else:
            inp, out, cread, ccre = u
        lane = lane_for(model)
        for table, key in ((lanes, lane), (machines, f"{lane} | {info['machine'] or 'direct'}")):
            r = table[key][bucket]
            r["n"] += 1
            r["inp"] += inp
            r["out"] += out
            r["cread"] += cread
            r["ccre"] += ccre

    span_h = ((last_dt - first_dt).total_seconds() / 3600) if (first_dt and last_dt and last_dt > first_dt) else args.hours

    if args.json:
        print(json.dumps({
            "window_hours": args.hours,
            "covered_from": first_dt.isoformat() if first_dt else None,
            "covered_to": last_dt.isoformat() if last_dt else None,
            "covered_span_hours": round(span_h, 3),
            "files": {"resp": n_resp, "paired": n_paired, "unpaired": n_unpaired, "no_usage": n_nousage},
            "lanes": {k: v for k, v in lanes.items()},
            "machines": {k: v for k, v in machines.items()} if args.machines else None,
        }, indent=2))
        return

    total_out = sum(r["out"] for b in lanes.values() for r in b.values())
    print(f"fenetre: {args.hours}h demandees | couverture {first_dt:%H:%M} -> {last_dt:%H:%M}Z ({span_h:.2f} h)")
    print(f"resp: {n_resp} | appariees: {n_paired} | non appariees: {n_unpaired} | sans usage: {n_nousage}")
    print()
    hdr = f"{'lane':24} {'bucket':12} {'req':>6} {'in_tok':>13} {'out_tok':>12} {'cache_rd':>13} {'cache_wr':>12} {'hit%':>5} {'in/h':>13} {'out/h':>12}"
    print(hdr)
    print("-" * len(hdr))
    for lane in sorted(lanes):
        lane_n = lane_out = lane_inp = 0
        for bucket in ("cron", "interactive", "agent-sdk", "other"):
            r = lanes[lane].get(bucket)
            if not r:
                continue
            lane_n += r["n"]
            lane_out += r["out"]
            lane_inp += r["inp"]
            if r["cread"] or r["ccre"]:
                denom = r["cread"] + r["ccre"] + r["inp"]
                hit = f"{100.0 * r['cread'] / denom:4.0f}%" if denom else " n/a"
            else:
                hit = " n/a" if lane in NO_CACHE_LANES else "  0%"
            print(f"{lane:24} {bucket:12} {r['n']:>6} {fmt_int(r['inp']):>13} {fmt_int(r['out']):>12} "
                  f"{fmt_int(r['cread']):>13} {fmt_int(r['ccre']):>12} {hit:>5} "
                  f"{fmt_int(int(r['inp'] / span_h)):>13} {fmt_int(int(r['out'] / span_h)):>12}")
        r_all = {"inp": lane_inp, "out": lane_out}
        print(f"{lane:24} {'TOTAL':12} {lane_n:>6} {fmt_int(r_all['inp']):>13} {fmt_int(r_all['out']):>12} "
              f"{'':>13} {'':>12} {'':>5} {fmt_int(int(r_all['inp'] / span_h)):>13} {fmt_int(int(r_all['out'] / span_h)):>12}")
        print()

    if args.machines:
        print("== par lane x machine ==")
        for key in sorted(machines):
            tot = {k: sum(r[k] for r in machines[key].values()) for k in ("n", "inp", "out")}
            print(f"  {key:46} req {tot['n']:>6}  in {fmt_int(tot['inp']):>13}  out {fmt_int(tot['out']):>12}")

    print(f"\ntotal out_tok fenetre: {fmt_int(total_out)} | debit moyen out: {fmt_int(int(total_out / span_h))}/h")


if __name__ == "__main__":
    main()
