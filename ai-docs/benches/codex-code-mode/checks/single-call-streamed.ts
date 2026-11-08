// single-call: when Codex DOES stream argument deltas for a function call,
// claudish forwards those deltas and nothing else. The zero-delta fix
// (responses-leg.ts, emitUnforwardedArguments) sends the `.done` arguments
// only when no delta was forwarded, or the missing suffix when the deltas fell
// short. Sending them on top of streamed deltas would hand Claude Code the
// arguments twice (`{…}{…}`), which is not valid JSON.
//
// Reads claudish's debug log (logs/claudish_*.log in the workspace) and finds
// every function_call named `tool` whose final arguments carry every key of
// `args` with exactly that value. Each must be:
//   - alone: its response.completed lists exactly one function_call;
//   - streamed: more than zero response.function_call_arguments.delta events;
//   - complete: the deltas concatenated equal the `.done` arguments, so there
//     was no suffix left for claudish to add.
// And the log must carry no claudish line saying it emitted arguments for a
// streamed call of that tool: no `function_call <tool>: emitted N-byte
// suffix`, no `done arguments diverge … for <tool>`, and no more
// `zero-delta function_call <tool>` lines than there are calls of that tool
// that really streamed zero deltas.
//
// The pure part is `analyse`, exported so it can be run against stored real
// logs (README.md, "How single-call was proven").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Item = { id: string; name: string; deltas: number; streamed: string; done?: string; fnInResponse?: number };

export type Analysis = { pass: boolean; reason: string; evidence: Record<string, unknown> };

const SSE = /^\[[^\]]*\] \[SSE:responses\] (\{.*\})\s*$/;

function parsed(args: string | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  try {
    const v = JSON.parse(args);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Every key of `want` is present in the call's final arguments with exactly that value. */
function matches(args: string | undefined, want: Record<string, unknown>): boolean {
  const got = parsed(args);
  return !!got && Object.entries(want).every(([k, v]) => got[k] === v);
}

export function analyse(log: string, tool: string, want: Record<string, unknown>): Analysis {
  const items = new Map<string, Item>();
  let zeroDeltaLines = 0;
  let suffixLines = 0;
  let divergeLines = 0;
  const t = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const zeroRe = new RegExp(`\\[ResponsesSSE\\] zero-delta function_call ${t}:`);
  const suffixRe = new RegExp(`\\[ResponsesSSE\\] function_call ${t}: emitted \\d+-byte suffix`);
  const divergeRe = new RegExp(`\\[ResponsesSSE\\] done arguments diverge from streamed deltas for ${t}\\b`);

  for (const line of log.split("\n")) {
    if (zeroRe.test(line)) zeroDeltaLines++;
    if (suffixRe.test(line)) suffixLines++;
    if (divergeRe.test(line)) divergeLines++;
    const m = SSE.exec(line);
    if (!m) continue;
    let ev: any;
    try {
      ev = JSON.parse(m[1]);
    } catch {
      continue; // a line cut by the logger carries nothing we can trust
    }
    switch (ev.type) {
      case "response.output_item.added":
        if (ev.item?.type === "function_call" && typeof ev.item.id === "string") {
          items.set(ev.item.id, { id: ev.item.id, name: ev.item.name, deltas: 0, streamed: "" });
        }
        break;
      case "response.function_call_arguments.delta": {
        const it = items.get(ev.item_id);
        if (it) {
          it.deltas++;
          it.streamed += ev.delta ?? "";
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const it = items.get(ev.item_id);
        if (it) it.done = ev.arguments ?? "";
        break;
      }
      case "response.completed": {
        const out: any[] = Array.isArray(ev.response?.output) ? ev.response.output : [];
        const fns = out.filter((o) => o?.type === "function_call");
        for (const f of fns) {
          const it = items.get(f.id);
          if (!it) continue;
          it.fnInResponse = fns.length;
          if (it.done === undefined && typeof f.arguments === "string") it.done = f.arguments;
        }
        break;
      }
    }
  }

  const ofTool = [...items.values()].filter((i) => i.name === tool);
  const targets = ofTool.filter((i) => matches(i.done, want));
  const zeroDeltaCalls = ofTool.filter((i) => i.deltas === 0 && (i.done ?? "") !== "").length;
  const rows = targets.map((x) => ({
    id: x.id,
    deltas: x.deltas,
    alone: x.fnInResponse === 1,
    function_calls_in_response: x.fnInResponse ?? null,
    streamed_equals_done: x.streamed === x.done,
    done_bytes: (x.done ?? "").length,
  }));
  const evidence = {
    tool,
    args: want,
    target_calls: rows,
    calls_of_tool: ofTool.map((i) => ({ id: i.id, deltas: i.deltas, args: parsed(i.done) ?? i.done ?? null })),
    zero_delta_lines: zeroDeltaLines,
    zero_delta_calls: zeroDeltaCalls,
    suffix_lines: suffixLines,
    diverge_lines: divergeLines,
  };

  const problems: string[] = [];
  if (targets.length === 0) {
    problems.push(`no ${tool} function_call with arguments ${JSON.stringify(want)} in the log (${ofTool.length} ${tool} call(s) seen)`);
  }
  for (const r of rows) {
    if (!r.alone) problems.push(`${r.id} shared its response with ${r.function_calls_in_response ?? "an unknown number of"} function_call(s)`);
    if (r.deltas === 0) problems.push(`${r.id} streamed 0 argument deltas (a zero-delta call, not the streamed case)`);
    else if (!r.streamed_equals_done) problems.push(`${r.id}: its ${r.deltas} deltas do not add up to the .done arguments`);
  }
  if (zeroDeltaLines > zeroDeltaCalls) {
    problems.push(
      `${zeroDeltaLines} 'zero-delta function_call ${tool}' line(s) for ${zeroDeltaCalls} zero-delta call(s): claudish emitted .done arguments for a streamed call`,
    );
  }
  if (suffixLines > 0) problems.push(`${suffixLines} 'emitted N-byte suffix' line(s) for ${tool}`);
  if (divergeLines > 0) problems.push(`${divergeLines} 'done arguments diverge' line(s) for ${tool}`);

  if (problems.length > 0) return { pass: false, reason: problems.join("; "), evidence };
  return {
    pass: true,
    reason: `${rows.length} lone ${tool} call(s) with ${JSON.stringify(want)} streamed (${rows.map((r) => `${r.deltas} deltas`).join(", ")}); deltas == .done; no claudish emission from .done`,
    evidence,
  };
}

export default function evaluate(
  _output: string,
  context: { config?: { tool?: string; args?: Record<string, unknown> }; session?: { work_dir?: string } },
) {
  const tool = context.config?.tool ?? "Bash";
  const want = context.config?.args;
  if (!want || Object.keys(want).length === 0) throw new Error("single-call-streamed: config.args is required");
  const wd = context.session?.work_dir;
  if (!wd) return { pass: false, score: 0, reason: "the Session carries no work_dir, so the claudish log cannot be read" };
  let names: string[] = [];
  try {
    names = readdirSync(join(wd, "logs")).filter((n) => /^claudish_.*\.log$/.test(n));
  } catch {
    // no logs directory: claudish never ran in this workspace
  }
  if (names.length === 0) return { pass: false, score: 0, reason: `no logs/claudish_*.log under ${wd}` };
  const log = names.map((n) => readFileSync(join(wd, "logs", n), "utf8")).join("\n");
  const a = analyse(log, tool, want);
  return { pass: a.pass, score: a.pass ? 1 : 0, reason: a.reason, evidence: { ...a.evidence, logs: names } };
}
