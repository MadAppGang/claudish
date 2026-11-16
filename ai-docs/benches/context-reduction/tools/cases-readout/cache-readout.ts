// Prints the cache figures of madbench report files, one line per trial.
//
//   bun cache-readout.ts <report.json>...
//
// hit_rate comes from the run's token totals (main thread and subagents):
// cache_read / (cache_read + prompt_tokens), where prompt_tokens is every
// input token that was not a cache read. billed_eq is the input billed as
// plain input tokens: uncached + 1.25 x creation + 0.1 x read.
//
// breaks counts the main thread's requests that read less from the cache than
// the previous request read plus wrote: the cached prefix stopped matching.
// The report keeps per-request usage for the main thread only, so subagent
// requests are not in that count.

export {};

type Usage = { cache_creation_tokens?: number; cache_read_tokens?: number; input_tokens?: number };
type Metric = { value?: number };
type Result = {
  status: string;
  run_name?: string;
  scenario_id?: string;
  duration?: number;
  metrics?: Record<string, Metric>;
  session?: { events?: { type?: string; usage?: Usage }[] };
};
type Report = { results?: Result[]; trials?: { results?: Result[] }[] };

for (const file of process.argv.slice(2)) {
  const report = (await Bun.file(file).json()) as Report;
  const results = report.results ?? (report.trials ?? []).flatMap((t) => t.results ?? []);
  for (const r of results) {
    if (r.status === "error") {
      console.log(`${file}: status=error`);
      continue;
    }
    const m = (k: string) => r.metrics?.[k]?.value ?? 0;
    const read = m("cache_read");
    const prompt = m("prompt_tokens");
    const creation = m("cache_creation");
    const uncached = Math.max(prompt - creation, 0);
    const hit = read + prompt > 0 ? read / (read + prompt) : 0;
    const billed = uncached + 1.25 * creation + 0.1 * read;

    const calls = (r.session?.events ?? []).filter((e) => e.type === "llm_call" && e.usage);
    let breaks = 0;
    let prev: Usage | undefined;
    for (const e of calls) {
      const u = e.usage as Usage;
      if (prev) {
        const expected = (prev.cache_read_tokens ?? 0) + (prev.cache_creation_tokens ?? 0);
        if ((u.cache_read_tokens ?? 0) < expected) breaks++;
      }
      prev = u;
    }
    const secs = Math.round((r.duration ?? 0) / 1e9);
    console.log(
      `${file.split("/").pop()}: ${r.run_name ?? "-"} ${r.scenario_id} status=${r.status} secs=${secs} cost=$${m("cost").toFixed(4)} ` +
        `hit_rate=${(hit * 100).toFixed(1)}% read=${read} creation=${creation} uncached=${uncached} ` +
        `billed_eq=${Math.round(billed)} main_requests=${calls.length} breaks=${breaks}`
    );
  }
}
