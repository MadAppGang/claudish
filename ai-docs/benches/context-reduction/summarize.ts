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
  usage?: Usage;
  request?: { model?: string };
};
type Check = {
  spec?: { metric?: string };
  result?: { pass?: boolean; score?: number; evidence?: Record<string, unknown> };
};
type Result = {
  run_name: string;
  scenario_id: string;
  status: string;
  duration: number;
  checks?: Check[];
  session?: {
    end_reason?: string;
    events?: SessionEvent[];
    subagents?: unknown[];
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

function trialRow(file: string, r: Result) {
  const events = r.session?.events ?? [];
  const { main, sub, unanswered, models, byModel } = sumCalls(events);
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
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const files = args.filter((_, i) => jsonAt < 0 || (i !== jsonAt && i !== jsonAt + 1));
if (files.length === 0) {
  console.error("usage: bun summarize.ts <report.json>... [--json <out.json>]");
  process.exit(2);
}

const rows: Row[] = [];
for (const file of files) {
  // One trial: `results` at the top. Several trials: one `results` per trial.
  const report = JSON.parse(await Bun.file(file).text()) as {
    results?: Result[];
    trials?: { results?: Result[] }[];
  };
  const results = report.results ?? report.trials?.flatMap((t) => t.results ?? []) ?? [];
  for (const r of results) rows.push(trialRow(file, r));
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

const cut = rows.filter((r) => r.unanswered > 0);
if (cut.length > 0) {
  console.log("\n## Calls with no response\n");
  for (const r of cut) console.log(`- ${r.variant} (${r.file}): ${r.unanswered}`);
}

if (jsonOut) {
  await Bun.write(jsonOut, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`\nrows written to ${jsonOut}`);
}
