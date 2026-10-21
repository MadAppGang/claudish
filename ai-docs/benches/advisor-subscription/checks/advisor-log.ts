// Grades what claudish's debug log says about the advisor, one section per Check.
//
// claudish-under-test passes --debug-claudish, so claudish writes
// logs/claudish_*.log into the workspace. Three kinds of line matter
// (ai-docs/architecture/advisor.md):
//
//   [advisor-origin] {json}   one record per panel model (`advisor_call`), per
//                             collector run (`advisor_collector_call`) and per
//                             call (`advisor_rewrite`): origin, stubPath,
//                             requestedModel, upstreamStatus, servedBy
//                             (provider, displayName, the signing
//                             credential, billing), ...
//   [advisor-notice] <line>   the startup notice, one line each
//   ... Calling API: <url>    every upstream request; `[advisor] Calling API:`
//                             is the Claude member/collector boundary line
//
// `config.section` picks what this Check grades:
//
//   records  every `members[]` (and `collector`) entry has at least one record,
//            and EVERY record of that model matches the expected fields. A
//            single metered record for a subscription member fails it.
//   notice   each `lines[]` entry is matched by some notice line that starts
//            (trimmed) with its `startsWith`, when given, and carries all of
//            its `contains`; no notice line carries a `forbid` string; for
//            each model in `servedByMatches`, the notice's first hop
//            (`<model> -> <displayName> (`) equals every upstream record's
//            servedBy.displayName (L4: the notice promised what ran).
//   hosts    every `Calling API:` URL matches one of `allow`; each `require`
//            pattern matches some line; no line matches a `forbid` pattern.
//   secrets  the log carries advisor records (so it is the right log), and no
//            line of any kept file matches a `forbid` pattern.
//   observe  no expectation beyond "a record exists per member": the evidence
//            records the hops tried, statuses, servedBy, stub reason, the
//            `[advisor]` warnings and the `Calling API:` sequence.
//
// Every section fails when no log exists, so the mock harness fails them all.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Expect = {
  model: string;
  origin?: string;
  provider?: string;
  /** Compared with the record's servedBy signing field (claudish names it SIGNING_KEY). */
  signedBy?: string;
  billing?: string;
  credentialSource?: string;
  stubPath?: string[];
  status?: number;
};
type Config = {
  section: "records" | "notice" | "hosts" | "secrets" | "observe";
  members?: Expect[];
  collector?: Expect;
  lines?: { startsWith?: string; contains: string[] }[];
  forbid?: string[];
  servedByMatches?: string[];
  allow?: string[];
  require?: string[];
};
type Rec = Record<string, any>;

/** claudish's own field name for the credential that signed (`oauth` = the subscription). */
const SIGNING_KEY = "arm";

const fail = (reason: string, evidence: Record<string, unknown> = {}) => ({ pass: false, score: 0, reason, evidence });

function readLogs(wd: string): { names: string[]; text: string } {
  const dir = join(wd, "logs");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^claudish_.*\.log$/.test(n)).sort();
  } catch {
    return { names: [], text: "" };
  }
  return { names, text: names.map((n) => readFileSync(join(dir, n), "utf8")).join("\n") };
}

function records(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf("[advisor-origin] ");
    if (i < 0) continue;
    try {
      out.push(JSON.parse(line.slice(i + "[advisor-origin] ".length)));
    } catch {
      // a truncated line is not a record
    }
  }
  return out;
}

function noticeLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf("[advisor-notice] ");
    if (i >= 0) out.push(line.slice(i + "[advisor-notice] ".length));
  }
  return out;
}

/** The short form of a record that an evidence reader needs. */
function brief(r: Rec) {
  return {
    kind: r.kind,
    requestedModel: r.requestedModel,
    origin: r.origin,
    stubPath: r.stubPath,
    upstreamStatus: r.upstreamStatus,
    servedBy: r.servedBy,
    credentialSource: r.credentialSource,
    loginSkipped: r.loginSkipped,
    systemHead: r.systemHead,
    shapeRefusal: r.shapeRefusal,
    hopsTried: r.hopsTried,
    reason: typeof r.reason === "string" ? r.reason.slice(0, 400) : r.reason,
  };
}

function mismatches(r: Rec, e: Expect): string[] {
  const bad: string[] = [];
  if (e.origin && r.origin !== e.origin) bad.push(`origin=${r.origin}`);
  if (e.provider && r.servedBy?.provider !== e.provider) bad.push(`servedBy.provider=${r.servedBy?.provider}`);
  if (e.signedBy && r.servedBy?.[SIGNING_KEY] !== e.signedBy) {
    bad.push(`servedBy.${SIGNING_KEY}=${r.servedBy?.[SIGNING_KEY]}`);
  }
  if (e.billing && r.servedBy?.billing !== e.billing) bad.push(`servedBy.billing=${r.servedBy?.billing}`);
  if (e.credentialSource && r.credentialSource !== e.credentialSource) bad.push(`credentialSource=${r.credentialSource}`);
  if (e.stubPath && !e.stubPath.includes(r.stubPath)) bad.push(`stubPath=${r.stubPath}`);
  if (e.status !== undefined) {
    const text = `${r.upstreamStatus ?? ""} ${r.reason ?? ""}`;
    if (r.upstreamStatus !== e.status && !text.includes(String(e.status))) bad.push(`upstreamStatus=${r.upstreamStatus}`);
  }
  return bad;
}

function gradeRecords(recs: Rec[], cfg: Config) {
  const problems: string[] = [];
  const perModel: Record<string, unknown> = {};
  const check = (kind: string, e: Expect) => {
    const mine = recs.filter((r) => r.kind === kind && r.requestedModel === e.model);
    perModel[`${kind}:${e.model}`] = mine.map(brief);
    if (mine.length === 0) {
      problems.push(`${e.model}: no ${kind} record`);
      return;
    }
    mine.forEach((r, i) => {
      const bad = mismatches(r, e);
      if (bad.length) problems.push(`${e.model} ${kind} #${i + 1}: ${bad.join(", ")}`);
    });
  };
  for (const e of cfg.members ?? []) check("advisor_call", e);
  if (cfg.collector) check("advisor_collector_call", cfg.collector);
  const counts = Object.fromEntries(Object.entries(perModel).map(([k, v]) => [k, (v as unknown[]).length]));
  return { problems, evidence: { counts, records: perModel } };
}

function gradeNotice(text: string, recs: Rec[], cfg: Config) {
  const lines = noticeLines(text);
  const problems: string[] = [];
  if (lines.length === 0) problems.push("no [advisor-notice] line in the log");
  for (const want of cfg.lines ?? []) {
    const ok = lines.some(
      (l) => (!want.startsWith || l.trim().startsWith(want.startsWith)) && want.contains.every((c) => l.includes(c)),
    );
    if (!ok) {
      problems.push(
        `no notice line ${want.startsWith ? `starting ${JSON.stringify(want.startsWith)} and ` : ""}carrying all of ${JSON.stringify(want.contains)}`,
      );
    }
  }
  for (const f of cfg.forbid ?? []) {
    const hit = lines.find((l) => l.includes(f));
    if (hit) problems.push(`notice carries forbidden text ${JSON.stringify(f)}: ${hit.trim()}`);
  }
  const served: Record<string, unknown> = {};
  for (const model of cfg.servedByMatches ?? []) {
    // A displayName may itself carry parentheses ("Grok Build (subscription)"),
    // so the notice's first hop is compared as a prefix, never cut by regex.
    const line = lines.find((l) => l.trim().startsWith(`${model} -> `))?.trim();
    const ran = recs.filter((r) => r.kind === "advisor_call" && r.requestedModel === model && r.origin === "upstream");
    const names = [...new Set(ran.map((r) => r.servedBy?.displayName))];
    served[model] = { notice: line ?? null, servedBy: names };
    if (!line) problems.push(`${model}: no notice line '${model} -> <provider> (' found`);
    else if (ran.length === 0) problems.push(`${model}: no upstream record to compare the notice with`);
    else {
      const unlike = names.filter((n) => !line.startsWith(`${model} -> ${n} (`) && line !== `${model} -> ${n}`);
      if (unlike.length) problems.push(`${model}: notice said "${line}", served by ${unlike.join(", ")}`);
    }
  }
  return { problems, evidence: { notice: lines, servedBy_vs_notice: served } };
}

function gradeHosts(text: string, cfg: Config) {
  const calls = text.split("\n").filter((l) => l.includes("Calling API:")).map((l) => l.replace(/^\[[^\]]*\] /, ""));
  const problems: string[] = [];
  if (calls.length === 0) problems.push("no 'Calling API:' line in the log");
  const allow = (cfg.allow ?? []).map((p) => new RegExp(p));
  for (const c of calls) {
    const url = c.slice(c.indexOf("Calling API:") + "Calling API:".length).trim();
    if (!allow.some((re) => re.test(url))) problems.push(`not allowed: ${c}`);
  }
  for (const p of cfg.require ?? []) {
    if (!calls.some((c) => new RegExp(p).test(c))) problems.push(`no 'Calling API:' line matches /${p}/`);
  }
  for (const p of cfg.forbid ?? []) {
    const hit = calls.find((c) => new RegExp(p).test(c));
    if (hit) problems.push(`forbidden /${p}/: ${hit}`);
  }
  const tally: Record<string, number> = {};
  for (const c of calls) tally[c] = (tally[c] ?? 0) + 1;
  return { problems: [...new Set(problems)], evidence: { calling_api: tally } };
}

/**
 * observe: records what happened for `members[]` without judging it. Passes
 * when every member has at least one record (so a readout built on it still
 * fails under the mock); the evidence is the point: each record's hopsTried,
 * upstreamStatus, servedBy and stub reason, every `[advisor]` warning line,
 * every routing/fallback line, and the `Calling API:` sequence in order.
 */
function observe(text: string, recs: Rec[], cfg: Config) {
  const problems: string[] = [];
  const perModel: Record<string, unknown> = {};
  for (const e of cfg.members ?? []) {
    const mine = recs.filter((r) => r.kind === "advisor_call" && r.requestedModel === e.model);
    if (mine.length === 0) problems.push(`${e.model}: no advisor_call record`);
    perModel[e.model] = mine.map((r) => ({ ...brief(r), route: r.route, routedModel: r.routedModel, billing: r.billing, upstreamStatusSource: r.upstreamStatusSource, latencyMs: r.latencyMs }));
  }
  const strip = (l: string) => l.replace(/^\[[^\]]*\] /, "");
  const all = text.split("\n");
  const warnings = all.filter((l) => /\[advisor\]/.test(l) && !/Calling API:/.test(l)).map(strip).slice(0, 40);
  const routing = all
    .filter((l) => /\[Fallback|terminal credential|\[advisor-route|\[Routing\]/.test(l))
    .map((l) => strip(l).slice(0, 400))
    .slice(0, 40);
  const callingApi = all.filter((l) => l.includes("Calling API:")).map(strip);
  return { problems, evidence: { records: perModel, advisor_warnings: warnings, routing_lines: routing, calling_api_in_order: callingApi } };
}

function gradeSecrets(wd: string, text: string, recs: Rec[], cfg: Config) {
  const problems: string[] = [];
  if (recs.length === 0) problems.push("no [advisor-origin] record, so this is not an advisor log");
  const hits: Record<string, number> = {};
  for (const p of cfg.forbid ?? []) {
    const n = text.split("\n").filter((l) => new RegExp(p).test(l)).length;
    hits[p] = n;
    if (n > 0) problems.push(`${n} log line(s) match /${p}/`);
  }
  let redacted = 0;
  for (const l of text.split("\n")) if (l.includes("[redacted]")) redacted++;
  return { problems, evidence: { forbidden_hits: hits, redacted_markers: redacted, records: recs.length, work_dir: wd } };
}

export default function evaluate(_output: string, context: { config?: Config; session?: { work_dir?: string } }) {
  const cfg = context.config;
  if (!cfg?.section) throw new Error("advisor-log: config.section is required");
  const wd = context.session?.work_dir;
  if (!wd) return fail("the Session carries no work_dir, so the claudish log cannot be read");
  const { names, text } = readLogs(wd);
  if (names.length === 0) return fail("no logs/claudish_*.log in the workspace (claudish never ran with --debug-claudish)");
  const recs = records(text);
  const r =
    cfg.section === "records"
      ? gradeRecords(recs, cfg)
      : cfg.section === "notice"
        ? gradeNotice(text, recs, cfg)
        : cfg.section === "hosts"
          ? gradeHosts(text, cfg)
          : cfg.section === "observe"
            ? observe(text, recs, cfg)
            : gradeSecrets(wd, text, recs, cfg);
  const pass = r.problems.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `${cfg.section}: every expectation held (${names.join(", ")})` : `${cfg.section}: ${r.problems.join("; ")}`,
    evidence: { logs: names, ...r.evidence },
  };
}
