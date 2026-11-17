// Reads out history-compaction trials: one madbench report and the claudish
// debug log of the same trial per argument.
//
//   bun history-readout.ts <report.json>=<claudish log> ...
//
// Per trial: madbench's cost and the cost recomputed from every request's
// usage at the list price of the model the request named, Claude Code
// compactions, claudish swaps, Haiku calls.
//
// Per swap: L, S, R and nStar from the "[compaction] history decision" line
// that decided it; n, the requests sent after the swap request and before the
// next Claude Code compaction started (or the next swap, or the end); and the
// saving the break-even model predicts at that n, twice:
//   logged:   read * R * n - (write - read) * (L + S) - haiku
//   measured: read * Rm * n - (write - read) * Cm - haiku
// where read and write are the per-token prices of the model (write at the
// TTL the swap request was written with), haiku is the cost of the summary
// calls since the previous swap, Rm is claudish's history count on the swap
// request minus the tokens that request actually sent, and Cm is the cache
// creation of the swap request. Both are model replays, not a counterfactual:
// the saving a policy really made is its variant's cost against the baseline variant.
//
// Per variant (run_name): mean, range and pass count.
//
// Prices and the per-request band rule (Haiku 5.5's 100K edge) are in
// pricing.ts. Per trial the readout also prints the requests above a model's
// band edge and what they cost.

import { bandOf, priceOf, requestCost, type Usage } from "./pricing";

const M = 1_000_000;

/** A compaction-model call: uncached input and output, at its own band. */
function haikuCost(inTok: number, outTok: number): number {
  return requestCost(priceOf("claude-haiku-5-5")!, { input: inTok, output: outTok });
}

interface Req {
  ts: string;
  model: string;
  input?: number;
  creation?: number;
  read?: number;
  w5m?: number;
  w1h?: number;
  output?: number;
  count?: number;
  host?: string;
  cachedReported?: boolean;
}
interface Haiku {
  ts: string;
  purpose: string;
  in: number;
  out: number;
}
interface Decision {
  ts: string;
  policy: string;
  action: string;
  kv: Record<string, string>;
}
interface Swap {
  ts: string;
  req: number;
  text: string;
}
interface Compaction {
  ts: string;
  start: number;
  pre: number;
  post: number;
}
/** One history summary: messages 0..last, when it started and became ready. */
interface Summary {
  last: number;
  started: string;
  ready?: string;
  used: boolean;
}
/** claudish's count for one request: "history count|none|replayed|swapped ... X of W tokens". */
interface CountAt {
  ts: string;
  count: number;
  window: number;
}

/**
 * The count at which a policy swaps, as a share of the window (history.ts
 * at 640a3aec: threshold 0.6/0.75, early 0.5/0.7). The cost policy swaps
 * on its projection, not at a count, so it has none.
 */
const SWAP_AT: Record<string, number> = { threshold: 0.75, early: 0.7 };

/**
 * A summary was ready after the request that needed it when claudish sent a
 * request at or above the policy's swap point between the summary's start
 * and its ready time (or after its start, if it never became ready).
 */
function lateSummaries(summaries: Summary[], counts: CountAt[], swapAt: number): number {
  return summaries.filter((s) =>
    counts.some((c) => c.ts >= s.started && (s.ready === undefined || c.ts < s.ready) && c.count >= swapAt * c.window),
  ).length;
}

function parseLog(text: string) {
  const reqs: Req[] = [];
  const haiku: Haiku[] = [];
  const decisions: Decision[] = [];
  const swaps: Swap[] = [];
  const hops: Record<string, number> = {};
  const fallbacks: string[] = [];
  const summaries: Summary[] = [];
  const counts: CountAt[] = [];
  // Rate limits on an OpenAI-format route: Z.ai's code 1302 bodies, claudish's
  // own retries ("429 rate limited, retry n/m in Xs"), and the final 429
  // statuses, which on an explicit route (no next hop) reach Claude Code.
  // waitMs adds, per final 429, the time from its "Calling API" line to the
  // 429, and the time until the next "Calling API" (Claude Code's own retry).
  const rate = { code1302: 0, retries: 0, retryWaitS: 0, reachedClient: 0, toNextHop: 0, waitMs: 0, firstTs: "", lastTs: "" };
  let callTs = "";
  let pending429 = "";
  let ts = "";
  for (const line of text.split("\n")) {
    const t = line.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/);
    if (t) {
      ts = t[1];
      rate.firstTs ||= ts;
      rate.lastTs = ts;
    }
    if (line.includes('"code":"1302"')) rate.code1302++;
    // A tag counts only on claudish's own line ("[<ISO time>] " then the tag,
    // matched as t above). A request or response body line (an SSE "data:"
    // line) carries the model's text, which can name any tag: an answer that
    // quoted "[Fallback]" was once counted as a hop.
    const retry = t ? line.match(/429 rate limited, retry \d+\/\d+ in ([\d.]+)s/) : null;
    if (retry) {
      rate.retries++;
      rate.retryWaitS += Number(retry[1]);
    }
    if (t && /\] Response status: 429/.test(line) && !line.includes("[compaction]")) {
      rate.reachedClient++;
      if (callTs) rate.waitMs += Date.parse(ts) - Date.parse(callTs);
      pending429 = ts;
    }
    if (t && line.includes("[Fallback]") && line.includes("trying next provider") && pending429) {
      rate.reachedClient--;
      rate.toNextHop++;
      pending429 = "";
    }
    if (t && /\] Calling API: /.test(line) && !line.includes("[compaction]")) {
      if (pending429) rate.waitMs += Date.parse(ts) - Date.parse(pending429);
      pending429 = "";
      callTs = ts;
    }
    const meta = t ? line.match(/\[RequestMeta\] model=(\S+)/) : null;
    if (meta) {
      reqs.push({ ts, model: meta[1] });
      continue;
    }
    // Every message_start is one billed answer. Most follow their own
    // RequestMeta line; one that follows a request that already has usage
    // (a retry inside the same request) becomes a request of its own.
    if (line.startsWith('data: {"type":"message_start"')) {
      try {
        const msg = JSON.parse(line.slice(6)).message;
        const u = msg.usage;
        let target = reqs[reqs.length - 1];
        if (!target || target.input !== undefined) {
          target = { ts, model: msg.model ?? target?.model ?? "unknown" };
          reqs.push(target);
        }
        if (msg.model) target.model = msg.model;
        target.input = u.input_tokens ?? 0;
        target.creation = u.cache_creation_input_tokens ?? 0;
        target.read = u.cache_read_input_tokens ?? 0;
        target.w5m = u.cache_creation?.ephemeral_5m_input_tokens;
        target.w1h = u.cache_creation?.ephemeral_1h_input_tokens;
      } catch {}
      continue;
    }
    // An OpenAI-format route (glm@): each upstream call writes "Calling API:
    // <url>", and RequestMeta is not written for every call, so the call is the
    // request. Its usage is the [SSE:openai] chunk with prompt_tokens, which
    // INCLUDES the cached tokens; no cache write is billed.
    // claudish's own Haiku calls write "[compaction] Calling API:" too; they
    // are counted from their HTTP 200 lines below, not as requests or hops.
    const call = !t || line.includes("[compaction]") ? null : line.match(/\] Calling API: https?:\/\/([^/\s]+)/);
    if (call) {
      hops[call[1]] = (hops[call[1]] ?? 0) + 1;
      const prev = reqs[reqs.length - 1];
      if (prev && prev.host === undefined && prev.input === undefined) prev.host = call[1];
      else reqs.push({ ts, model: prev?.model ?? "unknown", host: call[1] });
      continue;
    }
    if (t && line.includes("[Fallback]")) fallbacks.push(line.slice(0, 300));
    if (line.includes("[SSE:openai]") && line.includes('"prompt_tokens"')) {
      try {
        const u = JSON.parse(line.slice(line.indexOf("{"))).usage;
        const target = reqs[reqs.length - 1];
        if (u && target && target.input === undefined) {
          const cached = u.prompt_tokens_details?.cached_tokens;
          target.cachedReported = typeof cached === "number";
          target.read = cached ?? 0;
          target.input = u.prompt_tokens - (cached ?? 0);
          target.creation = 0;
          target.output = u.completion_tokens ?? 0;
        }
      } catch {}
      continue;
    }
    const last = reqs[reqs.length - 1];
    if (line.startsWith('data: {"type":"message_delta"') && last) {
      try {
        const u = JSON.parse(line.slice(6)).usage;
        if (typeof u?.output_tokens === "number") last.output = u.output_tokens;
      } catch {}
      continue;
    }
    if (!t || !line.includes("[compaction]")) continue;
    const count = line.match(/history count (\d+) of/);
    if (count && last) last.count = Number(count[1]);
    const anyCount = line.match(/history (?:count|none,|replayed at \d+,|swapped at \d+,) (\d+) of (\d+) tokens/);
    if (anyCount) counts.push({ ts, count: Number(anyCount[1]), window: Number(anyCount[2]) });
    const sum = line.match(/history summary (started|ready)\b.*?messages 0\.\.(\d+)/);
    if (sum && sum[1] === "started") summaries.push({ last: Number(sum[2]), started: ts, used: false });
    if (sum && sum[1] === "ready") {
      const s = summaries.find((x) => x.last === Number(sum[2]) && x.ready === undefined);
      if (s) s.ready = ts;
    }
    const replaced = line.match(/history swap in session .*messages 0\.\.(\d+) replaced/);
    if (replaced) {
      const s = [...summaries].reverse().find((x) => x.last === Number(replaced[1]));
      if (s) s.used = true;
    }
    const h = line.match(/\[compaction\] (history summary of \d+ messages|tool output [^:]*): HTTP 200, (\d+) in \/ (\d+) out tokens/);
    if (h) haiku.push({ ts, purpose: h[1], in: Number(h[2]), out: Number(h[3]) });
    const d = line.match(/\[compaction\] history decision (\S+): (swap|hold)\b(.*)$/);
    if (d) {
      const kv: Record<string, string> = {};
      for (const m of d[3].matchAll(/(\w+)=("[^"]*"|[^,\s]+)/g)) kv[m[1]] = m[2].replace(/^"|"$/g, "");
      decisions.push({ ts, policy: d[1], action: d[2], kv });
    }
    if (line.includes("history swap in session")) {
      swaps.push({ ts, req: reqs.length - 1, text: line.replace(/^.*\[compaction\] /, "").slice(0, 160) });
    }
  }
  return { reqs, haiku, decisions, swaps, hops, fallbacks, rate, summaries, counts };
}

function compactionsOf(report: unknown): Compaction[] {
  const seen = new Map<string, Compaction>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    const cm = o.compactMetadata as Record<string, number> | undefined;
    if (cm && typeof o.timestamp === "string" && !seen.has(o.timestamp)) {
      const end = Date.parse(o.timestamp);
      seen.set(o.timestamp, {
        ts: o.timestamp,
        start: end - (cm.durationMs ?? 0),
        pre: cm.preTokens,
        post: cm.postTokens,
      });
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(report);
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

/** A request's usage in pricing.ts's terms, or undefined with no usage. */
function usageOf(r: Req): Usage | undefined {
  if (r.input === undefined) return undefined;
  const w1h = r.w1h ?? 0;
  return { input: r.input, w5m: r.w5m ?? (r.creation ?? 0) - w1h, w1h, read: r.read, output: r.output };
}

function reqCost(r: Req): number {
  const p = priceOf(r.model);
  const u = usageOf(r);
  return p && u ? requestCost(p, u) : 0;
}

/** Whether a request was priced at its model's upper band. */
function isUpper(r: Req): boolean {
  const p = priceOf(r.model);
  const u = usageOf(r);
  return !!(p?.above && u && bandOf(p, u).upper);
}

const fmt = (n: number) => `$${n.toFixed(4)}`;
const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));

type VariantRow = { variant: string; pass: boolean; cost: number; recomputed: number };
const variants: VariantRow[] = [];

for (const arg of process.argv.slice(2)) {
  const [reportPath, logPath] = arg.split("=");
  if (!reportPath || !logPath) {
    console.error(`argument "${arg}" is not <report.json>=<claudish log>`);
    process.exit(2);
  }
  const report = await Bun.file(reportPath).json();
  const r = report.results?.[0];
  if (!r) {
    console.log(`${reportPath}: no result`);
    continue;
  }
  const { reqs, haiku, decisions, swaps, hops, fallbacks, rate, summaries, counts } = parseLog(await Bun.file(logPath).text());
  const compactions = compactionsOf(r);
  const unpriced = [...new Set(reqs.filter((q) => !priceOf(q.model)).map((q) => q.model))];
  const noUsage = reqs.filter((q) => q.input === undefined).length;
  const mainCost = reqs.reduce((s, q) => s + reqCost(q), 0);
  const haikuTotal = haiku.reduce((s, h) => s + haikuCost(h.in, h.out), 0);
  const madbench = r.metrics?.cost?.value ?? NaN;
  const scores = Object.entries(r.named_scores ?? {})
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  const variant = r.run_name ?? "-";
  console.log(`== ${reportPath.split("/").pop()} ${variant} ${r.scenario_id} status=${r.status} scores=${scores}`);
  console.log(
    `cost madbench=${fmt(madbench)} recomputed=${fmt(mainCost + haikuTotal)} (requests ${fmt(mainCost)} + haiku ${fmt(haikuTotal)}) ` +
      `requests=${reqs.length} without_usage=${noUsage}${unpriced.length ? ` UNPRICED=${unpriced.join("/")}` : ""}`,
  );
  const banded = reqs.filter((q) => priceOf(q.model)?.above && usageOf(q));
  if (banded.length > 0) {
    const upper = banded.filter(isUpper);
    const edge = priceOf(banded[0]!.model)!.above!.edge;
    console.log(
      `above_edge(${edge}) requests=${upper.length}/${banded.length} (${((100 * upper.length) / banded.length).toFixed(1)}%) ` +
        `cost=${fmt(upper.reduce((s, q) => s + reqCost(q), 0))} of ${fmt(banded.reduce((s, q) => s + reqCost(q), 0))}`,
    );
  }
  console.log(
    `cc_compactions=${compactions.length} ${compactions.map((c) => `[${c.ts} pre=${c.pre} post=${c.post}]`).join(" ")}`,
  );
  console.log(
    `swaps=${swaps.length} decisions=${decisions.length} (swap ${decisions.filter((d) => d.action === "swap").length}, hold ${decisions.filter((d) => d.action === "hold").length}) ` +
      `haiku_calls=${haiku.length} ${haiku.reduce((s, h) => s + h.in, 0)} in / ${haiku.reduce((s, h) => s + h.out, 0)} out`,
  );
  if (summaries.length > 0) {
    const policy = decisions[0]?.policy ?? variant.replace(/^history-/, "");
    const swapAt = SWAP_AT[policy];
    const late =
      swapAt === undefined
        ? `n/a (${policy}: no fixed swap point)`
        : `${lateSummaries(summaries, counts, swapAt)} of ${summaries.length} (swap point ${swapAt})`;
    console.log(
      `summaries=${summaries.length} used=${summaries.filter((s) => s.used).length} never_ready=${summaries.filter((s) => !s.ready).length} ` +
        `ready_after_the_request_that_needed_them=${late}`,
    );
  }
  // The launch log sits two folders above the claudish log (<launch>/debug/x.log).
  const launchLog = logPath.split("/").slice(0, -2).concat("launch.log").join("/");
  const launchText = (await Bun.file(launchLog).exists()) ? await Bun.file(launchLog).text() : "";
  const ccVersion = launchText.match(/launch: claude version (.*)/)?.[1] ?? "not recorded";
  const hookLine = launchText.match(/agent-env: hook .*/)?.[0] ?? "no hook line";
  console.log(`claude_code=${ccVersion} | ${hookLine}`);
  if (Object.keys(hops).length || fallbacks.length) {
    const oa = reqs.filter((q) => q.host !== undefined && q.input !== undefined);
    const cached = oa.filter((q) => q.cachedReported).length;
    console.log(
      `hops ${Object.entries(hops).map(([h, c]) => `${h}=${c}`).join(" ")} fallback_lines=${fallbacks.length} ` +
        `usage_with_cached_tokens=${cached}/${oa.length} cached_total=${oa.reduce((s, q) => s + (q.read ?? 0), 0)} ` +
        `uncached_input=${oa.reduce((s, q) => s + (q.input ?? 0), 0)} output=${oa.reduce((s, q) => s + (q.output ?? 0), 0)}`,
    );
    for (const f of fallbacks) console.log(`  FALLBACK ${f}`);
    const spanS = (Date.parse(rate.lastTs) - Date.parse(rate.firstTs)) / 1000;
    const waitS = rate.waitMs / 1000;
    console.log(
      `rate_limits code_1302=${rate.code1302} claudish_retries=${rate.retries} (stated waits ${rate.retryWaitS.toFixed(1)} s) ` +
        `429_to_claude_code=${rate.reachedClient} 429_to_next_hop=${rate.toNextHop} ` +
        `429_time=${waitS.toFixed(1)} s of log span ${spanS.toFixed(0)} s (${spanS > 0 ? ((100 * waitS) / spanS).toFixed(1) : "0"}%)` +
        (spanS > 0 && waitS > spanS / 2 ? " RATE-LIMIT-DOMINATED" : ""),
    );
  }
  variants.push({ variant, pass: r.status === "pass", cost: madbench, recomputed: mainCost + haikuTotal });

  let prevSwapTs = "";
  swaps.forEach((sw, i) => {
    const swReq = reqs[sw.req];
    const p = swReq ? priceOf(swReq.model) : undefined;
    const swTime = Date.parse(sw.ts);
    const decision = [...decisions].reverse().find((d) => d.action === "swap" && Date.parse(d.ts) <= swTime + 5);
    const nextSwap = swaps[i + 1] ? Date.parse(swaps[i + 1].ts) : Infinity;
    const nextCc = compactions.find((c) => c.start > swTime)?.start ?? Infinity;
    const until = Math.min(nextSwap, nextCc);
    const n = reqs.filter((q, k) => k > sw.req && Date.parse(q.ts) < until).length;
    const ended = until === Infinity ? "end" : until === nextCc ? "cc_compaction" : "next_swap";
    const usedHaiku = haiku
      .filter((h) => h.purpose.startsWith("history") && h.ts > prevSwapTs && h.ts <= sw.ts)
      .reduce((s, h) => s + haikuCost(h.in, h.out), 0);
    prevSwapTs = sw.ts;
    console.log(`  swap ${i + 1} ${sw.ts} ${sw.text}`);
    if (!p || !swReq || swReq.input === undefined) {
      console.log("    no priced usage on the swap request");
      return;
    }
    // The band the swap request itself was priced at (Haiku's upper band
    // above 100K); a model with one price has one band.
    const { band } = bandOf(p, usageOf(swReq)!);
    const read = band.read / M;
    const write = (band.input * ((swReq.w1h ?? 0) > 0 ? p.w1h : p.w5m)) / M;
    const L = num(decision?.kv.L);
    const S = num(decision?.kv.S);
    const R = num(decision?.kv.R);
    const nStar = num(decision?.kv.nStar);
    const sent = (swReq.input ?? 0) + (swReq.creation ?? 0) + (swReq.read ?? 0);
    const Rm = (swReq.count ?? NaN) - sent;
    const Cm = swReq.creation ?? 0;
    const logged = read * R * n - (write - read) * (L + S) - usedHaiku;
    const measured = read * Rm * n - (write - read) * Cm - usedHaiku;
    console.log(
      `    decision: ${decision ? `${decision.policy} ${decision.ts} L=${decision.kv.L} S=${decision.kv.S} R=${decision.kv.R} nStar=${decision.kv.nStar} projected=${decision.kv.projected ?? "-"} reason=${decision.kv.reason ?? "-"}` : "none logged"}`,
    );
    console.log(
      `    n=${n} (until ${ended}) haiku=${fmt(usedHaiku)} write_ttl=${(swReq.w1h ?? 0) > 0 ? "1h" : "5m"} ` +
        `predicted_logged=${Number.isNaN(logged) ? "-" : fmt(logged)} Rm=${Number.isNaN(Rm) ? "-" : Rm} Cm=${Cm} predicted_measured=${Number.isNaN(measured) ? "-" : fmt(measured)} ` +
        `n_vs_nStar=${Number.isNaN(nStar) ? "-" : `${n}/${nStar}`}`,
    );
  });
}

const byVariant = new Map<string, VariantRow[]>();
for (const a of variants) byVariant.set(a.variant, [...(byVariant.get(a.variant) ?? []), a]);
if (byVariant.size) console.log("== variants");
for (const [variant, rows] of byVariant) {
  const stat = (k: "cost" | "recomputed") => {
    const v = rows.map((x) => x[k]);
    return `${fmt(v.reduce((s, x) => s + x, 0) / v.length)} [${fmt(Math.min(...v))} .. ${fmt(Math.max(...v))}]`;
  };
  console.log(`${variant}: n=${rows.length} pass=${rows.filter((x) => x.pass).length}/${rows.length} madbench=${stat("cost")} recomputed=${stat("recomputed")}`);
}
