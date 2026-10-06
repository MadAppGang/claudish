// packages/cli/src/test-helpers/contract-records.ts
/**
 * Shared helpers for the *.contract.test.ts files (session records, design §3.2-§3.5).
 *
 * Written blind from the specification and the public contract. Nothing here knows how
 * claudish implements the records; every rule below is quoted from the design so a failing
 * assertion names the rule it broke.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** §3.5: tool-use ids, env ids and host-record ids. */
export const CLAUDE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** §3.3 rule 2. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** §3.3: a team record id is "team-" + 8 hex. */
export const TEAM_RECORD_ID_PATTERN = /^team-[0-9a-f]{8}$/;
/** Terminal session states (spec "Facts"; design §5.6). */
export const SESSION_TERMINAL_STATES = ["completed", "failed", "timeout", "cancelled"] as const;

export interface TempLayout {
  root: string;
  sessionsDir: string;
  home: string;
  configDir: string;
  cwd: string;
  cleanup(): void;
}

/** One isolated tree per test. realpath so macOS /var vs /private/var never decides a comparison. */
export function makeTempLayout(label: string): TempLayout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `claudish-contract-${label}-`)));
  const layout = {
    root,
    sessionsDir: join(root, "sessions"),
    home: join(root, "home"),
    configDir: join(root, "claude-config"),
    cwd: join(root, "cwd"),
  };
  for (const dir of [layout.sessionsDir, layout.home, layout.configDir, layout.cwd]) {
    mkdirSync(dir, { recursive: true });
  }
  return { ...layout, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Poll until `probe` yields a value that is not undefined/null/false. Never a guessed sleep. */
export async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  opts: { what: string; timeoutMs?: number; intervalMs?: number }
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value as T;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${opts.what}`);
    await Bun.sleep(opts.intervalMs ?? 25);
  }
}

/** Parse a JSON file; undefined when missing or not (yet) whole. A session meta.json is not atomic (§3.1). */
export function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface WaitLine {
  wait: "open" | "closed";
  since: string;
  turns?: number;
  at?: string;
  to?: string;
}

/**
 * Read `<dir>/waits.jsonl` (§3.3). Returns undefined when the file does not exist.
 * Only newline-terminated lines are returned; a complete line that does not parse is a defect,
 * so it throws instead of being skipped.
 */
export function readWaitLines(sessionDir: string): WaitLine[] | undefined {
  const path = join(sessionDir, "waits.jsonl");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as WaitLine;
      } catch {
        throw new Error(`waits.jsonl holds a complete line that is not JSON: ${line}`);
      }
    });
}

/**
 * §3.3: every open line is followed by exactly one closed line repeating its `since`;
 * lines alternate open/closed, starting with open. Returns the violations, [] when sound.
 * `allowTrailingOpen` admits a final open line (a wait still in progress).
 */
export function waitPairingViolations(lines: WaitLine[], allowTrailingOpen: boolean): string[] {
  const violations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const expected = i % 2 === 0 ? "open" : "closed";
    if (line.wait !== expected)
      violations.push(`line ${i + 1} is "${line.wait}", expected "${expected}"`);
    if (typeof line.since !== "string" || Number.isNaN(Date.parse(line.since))) {
      violations.push(`line ${i + 1} has no ISO "since"`);
    }
    if (line.wait === "open" && !(Number.isInteger(line.turns) && (line.turns as number) >= 0)) {
      violations.push(`open line ${i + 1} has no integer "turns"`);
    }
    if (line.wait === "closed") {
      const open = lines[i - 1];
      if (open && open.since !== line.since)
        violations.push(`closed line ${i + 1} does not repeat its open line's "since"`);
      if (typeof line.at !== "string" || Number.isNaN(Date.parse(line.at)))
        violations.push(`closed line ${i + 1} has no ISO "at"`);
      else if (Date.parse(line.at) < Date.parse(line.since))
        violations.push(`closed line ${i + 1} closes before it opened`);
      if (typeof line.to !== "string" || line.to === "waiting_for_input")
        violations.push(`closed line ${i + 1} has a bad "to"`);
    }
    if (Buffer.byteLength(JSON.stringify(line)) >= 200)
      violations.push(`line ${i + 1} is not < 200 bytes`);
  }
  if (!allowTrailingOpen && lines.length % 2 === 1) violations.push("the last wait is still open");
  return violations;
}

const isPositiveInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x > 0;

/**
 * §3.3 `spawn.json` schema rules 1-4, plus "sessionId equals the record's directory name",
 * the kind-specific key sets, and the on-disk format `JSON.stringify(record, null, 2)`.
 * Returns the violated rules; [] means the record is valid.
 */
export function spawnRecordViolations(text: string, dirName: string): string[] {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return ["spawn.json is not valid JSON"];
  }
  const v: string[] = [];
  if (text.trimEnd() !== JSON.stringify(rec, null, 2))
    v.push("format: not JSON.stringify(record, null, 2), one key per line");
  // Rule 1
  if (rec.schema !== 1) v.push(`rule 1: schema is ${JSON.stringify(rec.schema)}, not 1`);
  if (rec.kind !== "session" && rec.kind !== "team")
    v.push(`rule 1: kind is ${JSON.stringify(rec.kind)}`);
  // Rule 2
  if (typeof rec.sessionId !== "string" || !SESSION_ID_PATTERN.test(rec.sessionId))
    v.push("rule 2: sessionId pattern");
  if (rec.sessionId !== dirName)
    v.push(`sessionId ${JSON.stringify(rec.sessionId)} is not the directory name ${dirName}`);
  if (typeof rec.startedAt !== "string" || Number.isNaN(Date.parse(rec.startedAt)))
    v.push("rule 2: startedAt is not a date");
  if (!isPositiveInt(rec.hostPid)) v.push("rule 2: hostPid is not a positive integer");
  if (!isPositiveInt(rec.mcpPid)) v.push("rule 2: mcpPid is not a positive integer");
  if ("launcherPid" in rec) {
    if (!isPositiveInt(rec.launcherPid))
      v.push("rule 2: launcherPid present but not a positive integer");
    if (rec.launcherPid === rec.hostPid || rec.launcherPid === rec.mcpPid)
      v.push("rule 2: launcherPid equals hostPid or mcpPid");
  }
  // Rule 3
  if ("parentClaudeSessionId" in rec) {
    const p = rec.parentClaudeSessionId;
    if (typeof p !== "string" || !CLAUDE_ID_PATTERN.test(p))
      v.push('rule 3: parentClaudeSessionId present but invalid (never null, never "")');
  }
  // Rule 4
  if (rec.kind === "session") {
    const t = rec.timeoutSeconds;
    if (!(typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= 3600))
      v.push(`rule 4: timeoutSeconds ${JSON.stringify(t)} not an integer in 1..3600`);
    if ("model" in rec && typeof rec.model !== "string") v.push("rule 4: model is not a string");
    if ("claudeSessionId" in rec && typeof rec.claudeSessionId !== "string")
      v.push("rule 4: claudeSessionId is not a string");
    for (const k of ["teamPath", "slots"])
      if (k in rec) v.push(`kind session carries team-only key ${k}`);
  }
  if (rec.kind === "team") {
    if (typeof rec.teamPath !== "string" || !isAbsolute(rec.teamPath))
      v.push("rule 4: teamPath is not an absolute path string");
    if (!isPositiveInt(rec.slots)) v.push("rule 4: slots is not a positive integer");
    for (const k of ["model", "timeoutSeconds", "claudeSessionId"])
      if (k in rec) v.push(`kind team carries session-only key ${k}`);
  }
  return v;
}

/** Names in a directory, sorted; [] when it does not exist. */
export function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Record directories named team-* under a sessions dir. */
export function teamRecordDirs(sessionsDir: string): string[] {
  return entries(sessionsDir).filter((name) => name.startsWith("team-"));
}

/** Liveness by signal 0; EPERM still means the pid exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The parent pid of `pid` from the process table, or undefined. */
export function ppidOf(pid: number): number | undefined {
  const out = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
  const n = Number.parseInt(out.stdout.toString().trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Claude Code's project directory name for a cwd: every char outside [A-Za-z0-9] replaced by "-". */
export function sanitisedProjectName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** One transcript line in which the tool-use id appears quoted, the way a tool_use block carries it. */
export function transcriptLineWithToolUse(toolUseId: string): string {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolUseId, name: "mcp__claudish__create_session", input: {} },
      ],
    },
  })}\n`;
}

/** A transcript line that mentions nothing interesting, for padding. */
export function fillerLine(n: number): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: `filler ${n} ${"x".repeat(200)}` } })}\n`;
}

/** A fresh valid Claude-style id with a readable prefix. */
export function claudeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
