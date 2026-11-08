// Did the Bash output reach the model? `wc -c notes.txt` prints
// "       5 notes.txt"; the model can only state that number if claudish
// relayed the Bash tool_result back into the exec script and on to Codex.
// Pass when some Bash call's result printed "<n> notes.txt" AND the final
// answer contains that same <n> as a whole number.
//
// Reads every Bash call's output wherever the Session carries it: a call's
// `result` / `result_tag`, and the matching tool_result Event's `tool_out`.
// An Event keeps tool output in `tool_out`, not `text`, so a text-only read
// sees no Bash output at all (measured on the first real run).
type Call = { name?: string; tool_call_id?: string; result?: unknown; result_tag?: unknown };
type Event = { type?: string; tool_call_id?: string; tool_out?: unknown };

export default function evaluate(
  output: string,
  context: { session?: { calls?: Call[]; events?: Event[] } },
) {
  const calls = (context.session?.calls ?? []).filter((c) => c.name === "Bash");
  const bashIds = new Set(calls.map((c) => c.tool_call_id).filter(Boolean));
  const outputs: unknown[] = calls.flatMap((c) => [c.result, c.result_tag]);
  for (const e of context.session?.events ?? []) {
    if (e.type === "tool_result" && e.tool_call_id && bashIds.has(e.tool_call_id)) outputs.push(e.tool_out);
  }
  const counts: string[] = [];
  for (const o of outputs) {
    if (typeof o !== "string") continue;
    const m = /(?:^|\s)(\d+)\s+notes\.txt\b/.exec(o);
    if (m && !counts.includes(m[1])) counts.push(m[1]);
  }
  if (counts.length === 0) {
    return { pass: false, score: 0, reason: "no Bash result printed '<n> notes.txt' (wc -c never ran or its output was not captured)" };
  }
  const reported = counts.find((n) => new RegExp(`\\b${n}\\b`).test(output));
  const pass = reported !== undefined;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `wc printed ${reported} and the answer states ${reported}`
      : `wc printed ${counts.join(", ")}; the answer states none of them`,
    evidence: { wc_counts: counts, final_output: output.slice(0, 300) },
  };
}
