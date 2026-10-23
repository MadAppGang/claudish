/**
 * Layer B — the plumbing. For every (model, effort) the agent passed, follow it
 * through the debug logs claudish wrote into the workspace. It grades whatever
 * effort the agent passed, right or wrong, so Layer B is independent of Layer A.
 *
 * config:
 *   tool:  team | create_session | run_prompt
 *   stage: flag | wire
 *
 * stage flag (team, create_session): the child claudish received
 *   `--effort-override <level>`, proven by its own debug line
 *   `[ComposedHandler] --effort <level> pinned for <model>`.
 * stage wire (all three tools): the level went out on the request, proven by the
 *   provider, not by claudish: a Responses `response.created` event echoing
 *   `"reasoning":{"effort":"<sent>"…}`, where <sent> is the level, or the level
 *   step 5w mapped it to, which claudish names in a `[Wire] … effort A → B` note.
 *   For team/create_session the echo must be in the same log file as the pin line
 *   (one file per process), so it is the child's own request.
 *
 * Score: the fraction of traced pairs proven. Pass: every pair proven.
 */
import { canonicalOf, clip, debugLogs, type LogFile, requested, startedCall, type Tool, wireLinesFor } from "./effort-lib.ts";

type Ctx = {
  config?: Record<string, unknown>;
  assertion?: { args?: Record<string, unknown> };
  session?: { work_dir?: string; calls?: { name: string; args: Record<string, unknown> }[] };
};

function related(a: string, b: string): boolean {
  const x = canonicalOf(a);
  const y = canonicalOf(b);
  return x === y || x.endsWith(y) || y.endsWith(x);
}

function pinLines(log: LogFile, model: string, level: string): string[] {
  return log.lines.filter((l) => {
    const m = l.match(/\[ComposedHandler\] --effort (\S+) pinned for (\S+)/);
    return m !== null && m[1] === level && related(m[2], model);
  });
}

/** The level step 5w sent: the clamp note's target, else the level itself. */
function sentLevel(log: LogFile, level: string): { sent: string; note?: string } {
  const note = log.lines.find((l) => l.includes("[Wire]") && l.includes(`effort ${level} → `));
  if (!note) return { sent: level };
  const m = note.match(new RegExp(`effort ${level} → (\\S+)`));
  return { sent: m ? m[1] : level, note: clip(note) };
}

function echoes(log: LogFile): { efforts: string[]; sample?: string } {
  const efforts: string[] = [];
  let sample: string | undefined;
  for (const l of log.lines) {
    if (!l.includes("[SSE:responses]") || !l.includes('"response.created"')) continue;
    const m = l.match(/"reasoning":\{"effort":"([a-z]+)"[^}]*\}/);
    if (!m) continue;
    efforts.push(m[1]);
    sample ??= `${l.slice(0, 26)} [SSE:responses] response.created … ${m[0]}`;
  }
  return { efforts, sample };
}

export default function evaluate(_output: string, context: Ctx) {
  const cfg = { ...(context.assertion?.args ?? {}), ...((context.assertion?.args?.config as object) ?? {}), ...(context.config ?? {}) } as {
    tool: Tool;
    stage: "flag" | "wire";
  };
  const session = context.session ?? {};
  const { call: started } = startedCall(session, cfg.tool);
  if (!started) return { pass: false, score: 0, reason: `no ${cfg.tool} start call in the Session` };
  const calls = [started];
  const req = requested(calls[0], cfg.tool);
  const pairs = Object.entries(req.efforts).filter(([, e]) => typeof e === "string") as [string, string][];
  if (pairs.length === 0) {
    return { pass: false, score: 0, reason: `the ${cfg.tool} call passed no effort, so there is nothing to follow`, evidence: { args: calls[0].args } };
  }
  const logs = debugLogs(session.work_dir);
  if (logs.length === 0) {
    return { pass: false, score: 0, reason: `no claudish debug log in ${session.work_dir ?? "(no work dir)"}/logs`, evidence: { pairs } };
  }
  const usesChild = cfg.tool !== "run_prompt";
  const results: Record<string, Record<string, unknown>> = {};
  let proven = 0;
  for (const [model, level] of pairs) {
    const r: Record<string, unknown> = { level };
    // The process that served this model: the child that pinned the level, or (run_prompt)
    // the MCP server's own proxy, whose [Wire] line names the model.
    const files = usesChild
      ? logs.filter((f) => pinLines(f, model, level).length > 0)
      : logs.filter((f) => wireLinesFor(f, model).length > 0);
    r.logFiles = files.map((f) => f.path);
    if (usesChild) r.pinLine = files.length > 0 ? clip(pinLines(files[0], model, level)[0]) : null;
    let ok: boolean;
    if (cfg.stage === "flag") {
      ok = files.length > 0;
    } else {
      ok = false;
      for (const f of files) {
        const { sent, note } = sentLevel(f, level);
        const e = echoes(f);
        r.wireLines = wireLinesFor(f, model).map((l) => clip(l));
        r.clampNote = note ?? null;
        r.sent = sent;
        r.echoedEfforts = e.efforts;
        r.echoSample = e.sample ?? null;
        if (e.efforts.includes(sent)) {
          ok = true;
          break;
        }
      }
    }
    r.proven = ok;
    if (ok) proven++;
    results[model] = r;
  }
  const score = proven / pairs.length;
  const pass = proven === pairs.length;
  const what = cfg.stage === "flag" ? "child pinned --effort-override" : "provider echoed the sent effort";
  const missing = Object.entries(results)
    .filter(([, r]) => !r.proven)
    .map(([m, r]) => `${m} (${r.level}): ${cfg.stage === "flag" ? "no pin line" : `sent ${r.sent ?? "?"}, echoed [${(r.echoedEfforts as string[] | undefined)?.join(",") ?? ""}]`}`);
  return {
    pass,
    score,
    reason: pass ? `${proven}/${pairs.length}: ${what}` : `${proven}/${pairs.length}: ${what}; missing ${missing.join("; ")}`,
    evidence: { stage: cfg.stage, logFiles: logs.map((l) => l.path), perModel: results },
  };
}
