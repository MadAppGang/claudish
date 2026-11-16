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
// the saving a policy really made is its arm's cost against the baseline arm.
//
// Per arm (run_name): mean, range and pass count.
//
// Prices are USD per 1M tokens (Anthropic list prices). Cache writes: 1.25x
// input for the 5-minute TTL, 2x for the 1-hour TTL. Haiku 5.5 is $0.10 / $0.50
// up to 100K input tokens and $0.50 / $2.50 beyond.

export {};

// w5m and w1h are the cache-write multipliers of the input price.
type Price = { input: number; output: number; read: number; w5m: number; w1h: number };
const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, read: 0.2, w5m: 1.25, w1h: 2 },
  "claude-opus-5-5": { input: 4, output: 20, read: 0.2, w5m: 1.25, w1h: 2 },
  "claude-sonnet-5-5": { input: 2, output: 10, read: 0.1, w5m: 1.25, w1h: 2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, read: 0.01, w5m: 1.25, w1h: 2 },
  // GLM-4.7 on Z.ai's own API (the glm@ route). The cloud models catalog
  // publishes no price for that connection ("unavailable"); these are the
  // rates aggregator sites quote for Z.ai, which charges no cache write.
  "glm-4.7": { input: 0.6, output: 2.2, read: 0.11, w5m: 1, w1h: 1 },
};
const M = 1_000_000;

function priceOf(model: string): Price | undefined {
  return PRICES[model] ?? PRICES[model.replace(/\[.*\]$/, "")];
}

function haikuCost(inTok: number, outTok: number): number {
  return inTok > 100_000 ? (inTok * 0.5 + outTok * 2.5) / M : (inTok * 0.1 + outTok * 0.5) / M;
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

function parseLog(text: string) {
  const reqs: Req[] = [];
  const haiku: Haiku[] = [];
  const decisions: Decision[] = [];
  const swaps: Swap[] = [];
  const hops: Record<string, number> = {};
  const fallbacks: string[] = [];
  let ts = "";
  for (const line of text.split("\n")) {
    const t = line.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]/);
    if (t) ts = t[1];
    const meta = line.match(/\[RequestMeta\] model=(\S+)/);
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
    const call = line.includes("[compaction]") ? null : line.match(/\] Calling API: https?:\/\/([^/\s]+)/);
    if (call) {
      hops[call[1]] = (hops[call[1]] ?? 0) + 1;
      const prev = reqs[reqs.length - 1];
      if (prev && prev.host === undefined && prev.input === undefined) prev.host = call[1];
      else reqs.push({ ts, model: prev?.model ?? "unknown", host: call[1] });
      continue;
    }
    if (line.includes("[Fallback]")) fallbacks.push(line.slice(0, 300));
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
    if (!line.includes("[compaction]")) continue;
    const count = line.match(/history count (\d+) of/);
    if (count && last) last.count = Number(count[1]);
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
  return { reqs, haiku, decisions, swaps, hops, fallbacks };
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

function reqCost(r: Req): number {
  const p = priceOf(r.model);
  if (!p || r.input === undefined) return 0;
  const creation = r.creation ?? 0;
  const w1h = r.w1h ?? 0;
  const w5m = r.w5m ?? creation - w1h;
  return (
    (r.input * p.input + w5m * p.input * p.w5m + w1h * p.input * p.w1h + (r.read ?? 0) * p.read + (r.output ?? 0) * p.output) / M
  );
}

const fmt = (n: number) => `$${n.toFixed(4)}`;
const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));

type ArmRow = { arm: string; pass: boolean; cost: number; recomputed: number };
const arms: ArmRow[] = [];

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
  const { reqs, haiku, decisions, swaps, hops, fallbacks } = parseLog(await Bun.file(logPath).text());
  const compactions = compactionsOf(r);
  const unpriced = [...new Set(reqs.filter((q) => !priceOf(q.model)).map((q) => q.model))];
  const noUsage = reqs.filter((q) => q.input === undefined).length;
  const mainCost = reqs.reduce((s, q) => s + reqCost(q), 0);
  const haikuTotal = haiku.reduce((s, h) => s + haikuCost(h.in, h.out), 0);
  const madbench = r.metrics?.cost?.value ?? NaN;
  const scores = Object.entries(r.named_scores ?? {})
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  const arm = r.run_name ?? "-";
  console.log(`== ${reportPath.split("/").pop()} ${arm} ${r.scenario_id} status=${r.status} scores=${scores}`);
  console.log(
    `cost madbench=${fmt(madbench)} recomputed=${fmt(mainCost + haikuTotal)} (requests ${fmt(mainCost)} + haiku ${fmt(haikuTotal)}) ` +
      `requests=${reqs.length} without_usage=${noUsage}${unpriced.length ? ` UNPRICED=${unpriced.join("/")}` : ""}`,
  );
  console.log(
    `cc_compactions=${compactions.length} ${compactions.map((c) => `[${c.ts} pre=${c.pre} post=${c.post}]`).join(" ")}`,
  );
  console.log(
    `swaps=${swaps.length} decisions=${decisions.length} (swap ${decisions.filter((d) => d.action === "swap").length}, hold ${decisions.filter((d) => d.action === "hold").length}) ` +
      `haiku_calls=${haiku.length} ${haiku.reduce((s, h) => s + h.in, 0)} in / ${haiku.reduce((s, h) => s + h.out, 0)} out`,
  );
  if (Object.keys(hops).length || fallbacks.length) {
    const oa = reqs.filter((q) => q.host !== undefined && q.input !== undefined);
    const cached = oa.filter((q) => q.cachedReported).length;
    console.log(
      `hops ${Object.entries(hops).map(([h, c]) => `${h}=${c}`).join(" ")} fallback_lines=${fallbacks.length} ` +
        `usage_with_cached_tokens=${cached}/${oa.length} cached_total=${oa.reduce((s, q) => s + (q.read ?? 0), 0)} ` +
        `uncached_input=${oa.reduce((s, q) => s + (q.input ?? 0), 0)} output=${oa.reduce((s, q) => s + (q.output ?? 0), 0)}`,
    );
    for (const f of fallbacks) console.log(`  FALLBACK ${f}`);
  }
  arms.push({ arm, pass: r.status === "pass", cost: madbench, recomputed: mainCost + haikuTotal });

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
    const read = p.read / M;
    const write = (p.input * ((swReq.w1h ?? 0) > 0 ? p.w1h : p.w5m)) / M;
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

const byArm = new Map<string, ArmRow[]>();
for (const a of arms) byArm.set(a.arm, [...(byArm.get(a.arm) ?? []), a]);
if (byArm.size) console.log("== arms");
for (const [arm, rows] of byArm) {
  const stat = (k: "cost" | "recomputed") => {
    const v = rows.map((x) => x[k]);
    return `${fmt(v.reduce((s, x) => s + x, 0) / v.length)} [${fmt(Math.min(...v))} .. ${fmt(Math.max(...v))}]`;
  };
  console.log(`${arm}: n=${rows.length} pass=${rows.filter((x) => x.pass).length}/${rows.length} madbench=${stat("cost")} recomputed=${stat("recomputed")}`);
}
