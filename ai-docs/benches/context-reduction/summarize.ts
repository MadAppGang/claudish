// TEMPORARY — stands in for MadAppGang/madbench#212 (metric sources for subagent tokens and cost). Delete when madbench ships it.
//
// Turns madbench report JSON files into per-trial and per-variant numbers.
//
//   bun summarize.ts <report.json>... [--json <out.json>]
//
// madbench's own token and cost metrics count the main thread only. This
// script sums the usage of every `llm_call` Event, so a subagent's tokens are
// counted too, and reports the two threads apart.

export {};

type Usage = {
  input_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
};
type SessionEvent = {
  type: string;
  raw_type?: string;
  agent_id?: string;
  seq?: number;
  time?: string;
  tool_call_id?: string;
  usage?: Usage;
  request?: { model?: string };
  raw?: { sessionId?: string };
};
type Check = {
  spec?: { metric?: string };
  result?: { pass?: boolean; score?: number; evidence?: Record<string, unknown> };
};
type Result = {
  run_name: string;
  // Set when the trial errored before it could be graded.
  error?: string;
  scenario_id: string;
  status: string;
  duration: number;
  checks?: Check[];
  session?: {
    end_reason?: string;
    events?: SessionEvent[];
    subagents?: { name?: string }[];
    metrics?: { cost?: number; turns?: number; model_requests?: number };
  };
};

type Tokens = {
  requests: number;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
};

const emptyTokens = (): Tokens => ({
  requests: 0,
  input: 0,
  cacheCreation: 0,
  cacheRead: 0,
  output: 0,
});

function addUsage(into: Tokens, usage: Usage): void {
  into.requests += 1;
  into.input += usage.input_tokens ?? 0;
  into.cacheCreation += usage.cache_creation_tokens ?? 0;
  into.cacheRead += usage.cache_read_tokens ?? 0;
  into.output += usage.output_tokens ?? 0;
}

// Everything the model was sent: fresh input, plus what was written to and
// read from the prompt cache.
const promptOf = (t: Tokens): number => t.input + t.cacheCreation + t.cacheRead;

// Sums the model calls of one Session, the main thread apart from subagents.
function sumCalls(events: SessionEvent[]) {
  const main = emptyTokens();
  const sub = emptyTokens();
  let unanswered = 0;
  const models = new Set<string>();
  // Per model, because a token of a smaller model costs less.
  const byModel: Record<string, Tokens> = {};
  for (const e of events) {
    if (e.type !== "llm_call") continue;
    const model = e.request?.model ?? "unknown";
    models.add(model);
    // A call with no usage got no response: the Session ended first.
    if (!e.usage) {
      unanswered += 1;
      continue;
    }
    addUsage(e.agent_id ? sub : main, e.usage);
    byModel[model] ??= emptyTokens();
    addUsage(byModel[model], e.usage);
  }
  return { main, sub, unanswered, models, byModel };
}

// A cache break: a request whose cache_read is smaller than the previous
// request's cache_read + cache_creation in the same thread. The previous
// prompt was cached up to that point, so a smaller read means the prefix was
// not reused. A thread is one agent_id: the main thread has none, each
// subagent has its own. Requests are ordered by the Event's seq. The first
// request of a thread has no previous request and is never a break.
type CacheBreak = {
  thread: string;
  // 1-based position of the request in its thread.
  index: number;
  seq: number;
  // Tokens of the previous prompt's cached prefix that this request did not read.
  lost: number;
  cacheCreation: number;
  // Seconds since the thread's previous request: a long gap can be cache expiry.
  gapS: number;
  // The last tool result in the thread before this request, if any.
  lastToolUseId: string;
};

function cacheBreaks(events: SessionEvent[]) {
  const byThread = new Map<string, SessionEvent[]>();
  const lastTool = new Map<string, { seq: number; id: string }[]>();
  for (const e of events) {
    const thread = e.agent_id ?? "main";
    if (e.type === "llm_call" && e.usage) {
      if (!byThread.has(thread)) byThread.set(thread, []);
      byThread.get(thread)?.push(e);
    } else if (e.type === "tool_result" && e.tool_call_id) {
      if (!lastTool.has(thread)) lastTool.set(thread, []);
      lastTool.get(thread)?.push({ seq: e.seq ?? 0, id: e.tool_call_id });
    }
  }
  const breaks: CacheBreak[] = [];
  // Per thread: the requests in order and which of them broke the cache.
  const threads: { thread: string; requests: { seq: number; broke: boolean }[] }[] = [];
  for (const [thread, calls] of byThread) {
    calls.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const requests: { seq: number; broke: boolean }[] = [];
    for (let i = 0; i < calls.length; i++) {
      const cur = calls[i] as SessionEvent;
      const prev = i > 0 ? calls[i - 1] : undefined;
      let broke = false;
      if (prev?.usage && cur.usage) {
        const cached = (prev.usage.cache_read_tokens ?? 0) + (prev.usage.cache_creation_tokens ?? 0);
        const read = cur.usage.cache_read_tokens ?? 0;
        if (read < cached) {
          broke = true;
          const tools = (lastTool.get(thread) ?? []).filter((t) => t.seq < (cur.seq ?? 0));
          breaks.push({
            thread,
            index: i + 1,
            seq: cur.seq ?? 0,
            lost: cached - read,
            cacheCreation: cur.usage.cache_creation_tokens ?? 0,
            gapS: (Date.parse(cur.time ?? "") - Date.parse(prev.time ?? "")) / 1000,
            lastToolUseId: tools.length ? (tools[tools.length - 1]?.id ?? "") : "",
          });
        }
      }
      requests.push({ seq: cur.seq ?? 0, broke });
    }
    threads.push({ thread, requests });
  }
  return { breaks, threads };
}

function trialRow(file: string, r: Result) {
  const events = r.session?.events ?? [];
  const { main, sub, unanswered, models, byModel } = sumCalls(events);
  const cache = cacheBreaks(events);
  const sessionIds = [
    ...new Set(events.map((e) => e.raw?.sessionId).filter((s): s is string => !!s)),
  ];
  // Where each tool result sits: its thread and seq, to tie a compaction log
  // line (named by tool_use id) to the requests that sent it.
  const toolResults: Record<string, { thread: string; seq: number }> = {};
  for (const e of events) {
    if (e.type === "tool_result" && e.tool_call_id) {
      toolResults[e.tool_call_id] = { thread: e.agent_id ?? "main", seq: e.seq ?? 0 };
    }
  }
  const check = (metric: string) => r.checks?.find((c) => c.spec?.metric === metric)?.result;
  const hidden = check("HiddenTests");
  const evidence = check("ToolEvidence")?.evidence?.output;
  return {
    file,
    variant: r.run_name,
    status: r.status,
    endReason: r.session?.end_reason ?? "",
    hiddenPass: hidden?.pass === true,
    hiddenScore: hidden?.score ?? 0,
    hiddenPassed: Number(hidden?.evidence?.passed ?? 0),
    hiddenFailed: Number(hidden?.evidence?.failed ?? 0),
    delegated: check("Delegated")?.pass === true,
    inBounds: check("StayedInBounds")?.pass === true,
    durationS: r.duration / 1e9,
    // madbench's figure. It covers the main thread only.
    costMainUsd: r.session?.metrics?.cost ?? 0,
    turns: r.session?.metrics?.turns ?? 0,
    subagents: r.session?.subagents?.length ?? 0,
    // How often each kind of subagent was started, e.g. a variant's own agent.
    subagentNames: (r.session?.subagents ?? []).reduce<Record<string, number>>((acc, s) => {
      const name = s.name ?? "unnamed";
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {}),
    compactions: events.filter((e) => /compact/i.test(`${e.type} ${e.raw_type ?? ""}`)).length,
    main,
    sub,
    promptAll: promptOf(main) + promptOf(sub),
    outputAll: main.output + sub.output,
    cacheReadAll: main.cacheRead + sub.cacheRead,
    cacheCreationAll: main.cacheCreation + sub.cacheCreation,
    requestsAll: main.requests + sub.requests,
    unanswered,
    models: [...models].sort(),
    byModel,
    evidence: typeof evidence === "string" ? evidence : "",
    sessionIds,
    breaks: cache.breaks,
    threads: cache.threads,
    toolResults,
  };
}

type Row = ReturnType<typeof trialRow>;

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const span = (xs: number[], fmt: (n: number) => string): string =>
  xs.length ? `${fmt(mean(xs))} (${fmt(Math.min(...xs))} to ${fmt(Math.max(...xs))})` : "n/a";
const table = (head: string[], rows: string[][]): string =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

const args = process.argv.slice(2);
let jsonOut: string | undefined;
// claudish debug logs of compaction trials, matched to a trial by session id.
const compactionLogs: string[] = [];
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === "--json") jsonOut = args[++i];
  else if (a === "--compaction-log") compactionLogs.push(args[++i] as string);
  else files.push(a);
}
if (files.length === 0) {
  console.error(
    "usage: bun summarize.ts <report.json>... [--json <out.json>] [--compaction-log <claudish debug log>]..."
  );
  process.exit(2);
}

const rows: Row[] = [];
// A trial that errored has no graded Session: it would add zeros to every
// mean. It is listed on its own and counted nowhere else.
const errored: { file: string; variant: string; error: string }[] = [];
for (const file of files) {
  // One trial: `results` at the top. Several trials: one `results` per trial.
  const report = JSON.parse(await Bun.file(file).text()) as {
    results?: Result[];
    trials?: { results?: Result[] }[];
  };
  const results = report.results ?? report.trials?.flatMap((t) => t.results ?? []) ?? [];
  for (const r of results) {
    if (r.status === "error") {
      errored.push({ file, variant: r.run_name, error: String(r.error ?? "").split("\n")[0] });
    } else {
      rows.push(trialRow(file, r));
    }
  }
}

if (errored.length > 0) {
  console.log("## Errored trials: not counted in any table below\n");
  console.log(
    table(
      ["variant", "report", "error"],
      errored.map((e) => [e.variant, e.file.split("/").pop() ?? e.file, e.error])
    )
  );
  console.log("");
}

const variants = [...new Set(rows.map((r) => r.variant))];
const usd = (n: number): string => `$${n.toFixed(2)}`;
const mins = (n: number): string => `${(n / 60).toFixed(1)} min`;

console.log("## Per trial\n");
console.log(
  table(
    [
      "variant",
      "status",
      "hidden tests",
      "end",
      "duration",
      "main cost",
      "turns",
      "requests main/sub",
      "prompt main",
      "prompt sub",
      "output main",
      "output sub",
      "subagents",
      "compactions",
    ],
    rows.map((r) => [
      r.variant,
      r.status,
      `${r.hiddenPassed} pass, ${r.hiddenFailed} fail`,
      r.endReason,
      mins(r.durationS),
      usd(r.costMainUsd),
      String(r.turns),
      `${r.main.requests}/${r.sub.requests}`,
      int(promptOf(r.main)),
      int(promptOf(r.sub)),
      int(r.main.output),
      int(r.sub.output),
      String(r.subagents),
      String(r.compactions),
    ])
  )
);

console.log("\n## Per variant: mean (least to most)\n");
console.log(
  table(
    [
      "variant",
      "trials",
      "hidden tests passed",
      "all Checks passed",
      "prompt tokens, all threads",
      "output tokens, all threads",
      "cache read",
      "cache creation",
      "main-thread cost",
      "requests",
      "subagents",
      "compactions",
      "duration",
    ],
    variants.map((v) => {
      const t = rows.filter((r) => r.variant === v);
      const of = (f: (r: Row) => number) => t.map(f);
      return [
        v,
        String(t.length),
        `${t.filter((r) => r.hiddenPass).length}/${t.length}`,
        `${t.filter((r) => r.status === "pass").length}/${t.length}`,
        span(
          of((r) => r.promptAll),
          int
        ),
        span(
          of((r) => r.outputAll),
          int
        ),
        span(
          of((r) => r.cacheReadAll),
          int
        ),
        span(
          of((r) => r.cacheCreationAll),
          int
        ),
        span(
          of((r) => r.costMainUsd),
          usd
        ),
        span(
          of((r) => r.requestsAll),
          int
        ),
        span(
          of((r) => r.subagents),
          int
        ),
        span(
          of((r) => r.compactions),
          int
        ),
        span(
          of((r) => r.durationS),
          mins
        ),
      ];
    })
  )
);

console.log("\n## Subagents by name, per trial\n");
console.log(
  table(
    ["variant", "trial", "subagents started"],
    variants.flatMap((v) =>
      rows
        .filter((r) => r.variant === v)
        .map((r, i) => [
          v,
          String(i + 1),
          Object.entries(r.subagentNames)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, n]) => `${name} ${n}`)
            .join(", ") || "none",
        ])
    )
  )
);

console.log("\n## Per variant and model: mean over trials, all threads\n");
console.log(
  table(
    ["variant", "model", "requests", "prompt tokens", "output tokens"],
    variants.flatMap((v) => {
      const t = rows.filter((r) => r.variant === v);
      const names = [...new Set(t.flatMap((r) => Object.keys(r.byModel)))].sort();
      return names.map((m) => {
        const of = (f: (x: Tokens) => number) =>
          mean(t.map((r) => (r.byModel[m] ? f(r.byModel[m]) : 0)));
        return [v, m, int(of((x) => x.requests)), int(of(promptOf)), int(of((x) => x.output))];
      });
    })
  )
);

// List multipliers on the base input price, not measured: a cache read costs
// 0.1 times, a 5-minute cache write 1.25 times.
const READ_X = 0.1;
const WRITE_X = 1.25;
const hitRate = (t: { input: number; cacheCreation: number; cacheRead: number }): number => {
  const all = t.input + t.cacheCreation + t.cacheRead;
  return all > 0 ? t.cacheRead / all : 0;
};
const billedInput = (t: { input: number; cacheCreation: number; cacheRead: number }): number =>
  t.input + WRITE_X * t.cacheCreation + READ_X * t.cacheRead;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const allOf = (r: Row) => ({
  input: r.main.input + r.sub.input,
  cacheCreation: r.main.cacheCreation + r.sub.cacheCreation,
  cacheRead: r.main.cacheRead + r.sub.cacheRead,
});

console.log("\n## Cache reuse: mean over graded trials\n");
console.log(
  `Hit rate = cache read / (cache read + cache creation + uncached input). Billed-equivalent input = uncached + ${WRITE_X} x creation + ${READ_X} x read (list multipliers, 5-minute writes; not measured). A break: a request that read less from the cache than the previous request of its thread had cached.\n`
);
console.log(
  table(
    [
      "variant",
      "trials",
      "hit rate main",
      "hit rate sub",
      "hit rate all",
      "cache read",
      "cache creation",
      "uncached input",
      "billed-equivalent input",
      "breaks main/sub per trial",
      "tokens lost at breaks",
    ],
    variants.map((v) => {
      const t = rows.filter((r) => r.variant === v);
      const m = (f: (r: Row) => number) => mean(t.map(f));
      return [
        v,
        String(t.length),
        pct(m((r) => hitRate(r.main))),
        pct(m((r) => hitRate(r.sub))),
        pct(m((r) => hitRate(allOf(r)))),
        int(m((r) => allOf(r).cacheRead)),
        int(m((r) => allOf(r).cacheCreation)),
        int(m((r) => allOf(r).input)),
        int(m((r) => billedInput(allOf(r)))),
        `${m((r) => r.breaks.filter((b) => b.thread === "main").length).toFixed(1)}/${m((r) => r.breaks.filter((b) => b.thread !== "main").length).toFixed(1)}`,
        int(m((r) => r.breaks.reduce((s, b) => s + b.lost, 0))),
      ];
    })
  )
);

console.log("\n## Cache breaks per trial\n");
console.log(
  table(
    ["variant", "trial", "requests", "breaks", "tokens lost", "breaks after a gap over 300 s"],
    variants.flatMap((v) =>
      rows
        .filter((r) => r.variant === v)
        .map((r, i) => [
          v,
          String(i + 1),
          String(r.requestsAll),
          String(r.breaks.length),
          int(r.breaks.reduce((s, b) => s + b.lost, 0)),
          String(r.breaks.filter((b) => b.gapS > 300).length),
        ])
    )
  )
);

// Where the breaks fall, for the first trial of each variant that rewrites
// the prompt: a gateway or compaction.
for (const v of variants.filter((x) => /gateway|compaction/.test(x))) {
  const r = rows.find((x) => x.variant === v);
  if (!r || r.breaks.length === 0) continue;
  console.log(`\n## Cache breaks, ${v}, trial 1\n`);
  console.log(
    table(
      ["thread", "request", "seq", "tokens lost", "cache creation", "gap s", "last tool_use before it"],
      r.breaks.map((b) => [
        b.thread,
        String(b.index),
        String(b.seq),
        int(b.lost),
        int(b.cacheCreation),
        b.gapS.toFixed(0),
        b.lastToolUseId || "none",
      ])
    )
  );
}

// compaction: each tool output the debug log says was sent compressed,
// tied to the requests of its thread that came after it.
if (compactionLogs.length > 0) {
  const sendLine =
    /\[compaction\] session ([^:]+): tool_result (\S+) key=\S+ sent=(\S+) sha256=([0-9a-f]+) chars=(\d+)/;
  const out: string[][] = [];
  for (const log of compactionLogs) {
    const sends = new Map<string, { session: string; forms: Set<string>; sha: Set<string>; n: number }>();
    for (const line of (await Bun.file(log).text()).split("\n")) {
      const m = sendLine.exec(line);
      if (!m) continue;
      const [, session, id, form, sha] = m as unknown as string[];
      const s = sends.get(id as string) ?? { session: session as string, forms: new Set(), sha: new Set(), n: 0 };
      s.forms.add(form as string);
      s.sha.add(sha as string);
      s.n += 1;
      sends.set(id as string, s);
    }
    for (const [id, s] of sends) {
      if (!s.forms.has("compressed")) continue;
      const r = rows.find((x) => x.sessionIds.includes(s.session) || !!x.toolResults[id]);
      const at = r?.toolResults[id];
      const thread = at ? r?.threads.find((t) => t.thread === at.thread) : undefined;
      const after = thread ? thread.requests.filter((q) => q.seq > (at?.seq ?? 0)) : [];
      out.push([
        log.split("/").pop() ?? log,
        id,
        at?.thread ?? "not found",
        String(s.n),
        [...s.sha].length === 1 ? "one sha256" : `${[...s.sha].length} different sha256`,
        String(after.length),
        String(after.filter((q) => q.broke).length),
        after[0] ? (after[0].broke ? "yes" : "no") : "none",
      ]);
    }
  }
  console.log("\n## Compressed tool outputs and the cache\n");
  console.log(
    "Each row is a tool output the debug log shows sent compressed. The requests after it in its thread resend it; a break there would mean the stored text did not replay byte for byte.\n"
  );
  console.log(
    table(
      [
        "log",
        "tool_use id",
        "thread",
        "sends logged",
        "sent text",
        "later requests in thread",
        "breaks among them",
        "first request after it broke",
      ],
      out
    )
  );
}

const cut = rows.filter((r) => r.unanswered > 0);
if (cut.length > 0) {
  console.log("\n## Calls with no response\n");
  for (const r of cut) console.log(`- ${r.variant} (${r.file}): ${r.unanswered}`);
}

if (jsonOut) {
  await Bun.write(jsonOut, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`\nrows written to ${jsonOut}`);
}
