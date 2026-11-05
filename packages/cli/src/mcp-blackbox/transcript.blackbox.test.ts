/**
 * MTL-373: public transcript verbs over a REAL MCP stdio server.
 * Authored from the supplied spec/contracts only. No parser/handler imports or mocks.
 * See qa/test-plan.md for REQ ids, limitations and the later negative control.
 *
 * This file is copied from tests/mcp-blackbox/ into packages/cli/src/mcp-blackbox/.
 * Session cases seed documented records. Team cases obtain records through the public
 * fake-child team API because a complete status.json schema was not supplied.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  type ContractError,
  MAX_TRANSCRIPT_LINES,
  TRANSCRIPT_ANSWER_MAX_BYTES,
  TRANSCRIPT_KINDS,
  TRANSCRIPT_LINE_MAX_CHARS,
  TRANSCRIPT_LINE_MAX_JSON_BYTES,
  type TranscriptLine,
} from "../pane/contract.js";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  type ToolResult,
  createSession,
  paneOrphans,
  sendInput,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import {
  type TempLayout,
  makeTempLayout,
  sanitisedProjectName,
  waitFor,
} from "../test-helpers/contract-records.js";

useBlackboxEnv();

type Json = Record<string, unknown>;
type Surface = "session" | "team";
type Page = {
  cursor: string;
  lines: TranscriptLine[];
  more: boolean;
  final: boolean;
};
type Target = {
  tool: "transcript_session" | "team";
  args: Json;
  identity: Json;
  transcript: string;
  recordDir: string;
  conversationId: string;
  /** Single-slot team's public run.finished_at, when read from status.json after restart. */
  finishedAt?: number;
};
const T_TEST = 120_000;
const DATA = join(import.meta.dir, "..", "pane", "test-fixtures", "transcripts");
const EXPECTED_CAPABILITIES: Array<(typeof CAPABILITIES)[number]> = [
  "list",
  "status",
  "cancel",
  "capture",
  "capture_since_seq",
  "capture_spans",
  "resize",
  "allowance",
  "scroll",
  "transcript",
  "replay",
];
let layout: TempLayout;
let server: McpServer | undefined;
let exitedPid: number;
const observers: McpServer[] = [];

beforeEach(async () => {
  layout = makeTempLayout("bbtranscript");
  // An observed exited process, not a guessed unused PID or someone else's process.
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", ""], {
    cwd: layout.cwd,
    env: { HOME: layout.home, PATH: process.env.PATH ?? "" },
  });
  expect(child.exitCode).toBe(0);
  exitedPid = child.pid;
  expect(() => process.kill(exitedPid, 0)).toThrow();
  server = await startServer();
});

afterEach(async () => {
  try {
    for (const observer of observers.splice(0)) await observer.close();
    await server?.close();
  } finally {
    try {
      expect(await paneOrphans(layout, 15_000)).toEqual({ processes: [], files: [] });
    } finally {
      layout.cleanup();
      server = undefined;
    }
  }
});

function startServer(extra: Record<string, string | undefined> = {}): Promise<McpServer> {
  return McpServer.start({
    env: serverEnv(layout, { CONTRACT_FAKE_MAX_MS: "180000", ...extra }),
    cwd: layout.cwd,
  });
}
async function restart(extra: Record<string, string | undefined> = {}): Promise<void> {
  await server?.close();
  server = await startServer(extra);
}
function currentServer(): McpServer {
  if (!server) throw new Error("MCP server was not started");
  return server;
}
function call(tool: string, args: Json): Promise<ToolResult> {
  return currentServer().callTool(tool, args);
}
function ok(result: ToolResult): Json {
  expect(result.isError, "Expected a successful tool answer: " + result.text).toBe(false);
  expect(result.json, "Expected JSON tool answer: " + result.text).toBeDefined();
  if (!result.json) throw new Error("Expected JSON tool answer: " + result.text);
  return result.json;
}
function contractError(
  result: ToolResult,
  code: ContractError["error"]["code"],
  context = "Contract error"
): void {
  const diagnostic = context + ": " + result.text;
  expect(result.isError, diagnostic).toBe(true);
  expect(result.json, diagnostic).toEqual({ error: { code, message: expect.any(String) } });
  const body = result.json as unknown as ContractError;
  expect(body.error.message.length, diagnostic).toBeGreaterThan(0);
}
function jsonl(records: Json[]): string {
  return records.map((r) => JSON.stringify(r) + "\n").join("");
}
function user(content: unknown, extra: Json = {}): Json {
  return { type: "user", uuid: randomUUID(), message: { role: "user", content }, ...extra };
}
function assistant(content: unknown, extra: Json = {}): Json {
  return {
    type: "assistant",
    uuid: randomUUID(),
    message: { role: "assistant", id: randomUUID(), content },
    ...extra,
  };
}
function reply(text: string, extra: Json = {}): Json {
  return assistant([{ type: "text", text }], extra);
}
function toolUse(name: string, input: Json, id: string = randomUUID()): Json {
  return { type: "tool_use", name, input, id };
}
function notice(subtype: string, content: string, extra: Json = {}): Json {
  return { type: "system", subtype, content, ...extra };
}
function recorded(name: string): Json[] {
  return readFileSync(join(DATA, name + ".jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
}
function messageContent(record: Json): unknown {
  return (record.message as { content?: unknown } | undefined)?.content;
}
function age(path: string): void {
  const old = new Date(Date.now() - 120_000);
  utimesSync(path, old, old);
}
function putTranscript(path: string, records: Json[], quiet = true): void {
  mkdirSync(dirname(path), { recursive: true });
  const id = basename(path, ".jsonl");
  writeFileSync(
    path,
    jsonl(
      records.map((r) => ({
        ...r,
        sessionId: id,
        session_id: id,
        cwd: layout.cwd,
      }))
    )
  );
  if (quiet) age(path);
}
function writeJson(path: string, value: Json): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function seedSession(
  records: Json[],
  opts: {
    terminal?: boolean;
    owner?: number | null;
    quiet?: boolean;
    missingTranscript?: boolean;
    missingConversationId?: boolean;
  } = {}
): Target {
  const sessionId = randomUUID().slice(0, 8);
  const conversationId = randomUUID();
  const recordDir = join(layout.sessionsDir, sessionId);
  mkdirSync(recordDir, { recursive: true });
  const transcript = join(
    layout.configDir,
    "projects",
    sanitisedProjectName(layout.cwd),
    conversationId + ".jsonl"
  );
  const terminal = opts.terminal ?? true;
  const startedAt = new Date(Date.now() - 240_000).toISOString();
  const completedAt = new Date(Date.now() - 120_000).toISOString();
  const owner = opts.owner === undefined ? exitedPid : opts.owner;
  writeJson(join(recordDir, "spawn.json"), {
    schema: 1,
    kind: "session",
    sessionId,
    hostPid: process.pid,
    ...(owner === null ? {} : { mcpPid: owner }),
    startedAt,
    model: "contract-fake-model",
    timeoutSeconds: 600,
    ...(opts.missingConversationId ? {} : { claudeSessionId: conversationId }),
  });
  if (terminal) {
    writeJson(join(recordDir, "meta.json"), {
      sessionId,
      model: "contract-fake-model",
      status: "completed",
      state: "COMPLETED",
      terminalReason: null,
      detail: null,
      startedAt,
      completedAt,
      elapsedSeconds: 120,
      turnsCompleted: 1,
      toolCallCount: 0,
      costUsd: null,
      exitCode: 0,
      tokensIn: null,
      tokensOut: null,
      lastActivityAt: completedAt,
      provider: null,
      pane: null,
      captureSource: "transcript",
      turnSource: "transcript",
      timeoutSeconds: 600,
      cwd: layout.cwd,
      ...(opts.missingConversationId
        ? {}
        : { claudeSessionId: conversationId, transcriptPath: transcript }),
    });
  }
  if (!opts.missingTranscript && !opts.missingConversationId) {
    putTranscript(transcript, records, opts.quiet ?? true);
  }
  return {
    tool: "transcript_session",
    args: { session_id: sessionId },
    identity: { session_id: sessionId },
    transcript,
    recordDir,
    conversationId,
  };
}

function mainTranscripts(): string[] {
  const projects = join(layout.configDir, "projects");
  if (!existsSync(projects)) return [];
  const found: string[] = [];
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const file of readdirSync(join(projects, project.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) {
        found.push(join(projects, project.name, file.name));
      }
    }
  }
  return found.sort();
}
async function startTeam(path: string, input: string, models = ["fake-answer"]): Promise<Json> {
  return ok(await call("team", { mode: "run", path, models, input }));
}
async function settled(path: string, runId: string): Promise<void> {
  await waitFor(
    async () => {
      const status = ok(await call("team", { mode: "status", path, run_id: runId }));
      return (status.run as Json).state === "SETTLED";
    },
    { what: "team terminal state", timeoutMs: 60_000, intervalMs: 100 }
  );
}
async function paneExited(path: string, slot: string, runId: string): Promise<void> {
  await waitFor(
    async () => {
      const screen = ok(await call("team", { mode: "capture", path, slot, run_id: runId }));
      return screen.final === true;
    },
    { what: "team pane to exit", timeoutMs: 45_000, intervalMs: 100 }
  );
}
async function prepare(surface: Surface, records: Json[], mayAppend = false): Promise<Target> {
  if (surface === "session") {
    return seedSession(
      records,
      mayAppend ? { terminal: false, owner: process.pid, quiet: false } : {}
    );
  }
  const before = new Set(mainTranscripts());
  const path = join(layout.cwd, "team-" + randomUUID().slice(0, 8));
  const started = await startTeam(path, "Reply with exactly PEAR");
  const runId = started.run_id as string;
  const slot = (started.slots as Record<string, string>)["fake-answer"]!;
  expect(typeof runId).toBe("string");
  expect(slot).toBe("01");
  await settled(path, runId);
  const status = ok(await call("team", { mode: "status", path, run_id: runId }));
  // This run has one slot, so run.finished_at is also the slot's finish time.
  const finishedAt = Date.parse(String((status.run as Json).finished_at));
  expect(Number.isFinite(finishedAt)).toBe(true);
  await paneExited(path, slot, runId);
  if (mayAppend) {
    // Retain the original server, but its fake pane is stopped and cannot race our test data.
    // The restarted reader uses the slot's finish/quiet times, not the owner's liveness.
    observers.push(currentServer());
  } else {
    await currentServer().close();
  }
  const created = mainTranscripts().filter((p) => !before.has(p));
  expect(created).toHaveLength(1);
  const transcript = created[0]!;
  // Only our stopped fake's data is replaced. status.json is produced by the public API.
  putTranscript(transcript, records);
  server = await startServer();
  return {
    tool: "team",
    args: { mode: "transcript", path, slot, run_id: runId },
    identity: { run_id: runId, path, slot },
    transcript,
    recordDir: path,
    conversationId: basename(transcript, ".jsonl"),
    finishedAt,
  };
}
async function page(target: Target, since?: string, reader = currentServer()): Promise<Page> {
  const result = await reader.callTool(target.tool, {
    ...target.args,
    ...(since === undefined ? {} : { since }),
  });
  const body = ok(result);
  // Bun 1.4.0 mutates fields matched with expect.any; keep the wire answer intact.
  expect(structuredClone(body)).toMatchObject({
    ...target.identity,
    cursor: expect.any(String),
    lines: expect.any(Array),
    more: expect.any(Boolean),
    final: expect.any(Boolean),
  });
  expect((body.cursor as string).length).toBeGreaterThan(0);
  // Check the ACTUAL MCP content, not a re-serialised estimate that ignores whitespace.
  expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(32_000);
  const answer = body as unknown as Page;
  expect(answer.lines.length).toBeLessThanOrEqual(200);
  for (const line of answer.lines) {
    expect(TRANSCRIPT_KINDS).toContain(line.kind);
    expect(typeof line.text).toBe("string");
    expect(line.text.length).toBeGreaterThan(0);
    expect(line.text.length).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(JSON.stringify(line.text), "utf8")).toBeLessThanOrEqual(16_000);
    expect(line.cont === undefined || line.cont === true).toBe(true);
  }
  if (answer.more) expect(answer.final).toBe(false);
  return answer;
}
async function drain(
  target: Target,
  since?: string
): Promise<{ lines: TranscriptLine[]; pages: Page[] }> {
  const lines: TranscriptLine[] = [];
  const pages: Page[] = [];
  let cursor = since;
  for (let i = 0; i < 100; i++) {
    const answer = await page(target, cursor);
    pages.push(answer);
    lines.push(...answer.lines);
    if (!answer.more) return { lines, pages };
    expect(answer.cursor).not.toBe(cursor);
    cursor = answer.cursor;
  }
  throw new Error("Transcript did not reach the end within 100 pages");
}
// REQ-13: reaching EOF is not evidence of finality for a recently finished on-disk slot.
// Used only after exhausting test data whose writer has stopped; no late lines are expected.
async function waitForExhaustedFinal(target: Target, initial: Page): Promise<Page> {
  const finishedAt = target.finishedAt;
  if (finishedAt === undefined) throw new Error("Team finish time was not recorded");
  const notBefore = finishedAt + 30_000;
  function assertNotEarly(answer: Page): void {
    if (Date.now() < notBefore) {
      expect(answer.final, "An on-disk team slot is not final before 30 s since finish").toBe(
        false
      );
    }
  }
  assertNotEarly(initial);
  if (initial.final) return initial;

  let cursor = initial.cursor;
  return waitFor(
    async () => {
      const next = await page(target, cursor);
      assertNotEarly(next);
      expect(next).toMatchObject({ cursor, lines: [], more: false });
      cursor = next.cursor;
      return next.final ? next : undefined;
    },
    { what: "exhausted team's final transcript", timeoutMs: 60_000, intervalMs: 100 }
  );
}
function joined(lines: TranscriptLine[]): Array<{ kind: TranscriptLine["kind"]; text: string }> {
  const groups: Array<{ kind: TranscriptLine["kind"]; text: string }> = [];
  for (const line of lines) {
    if (line.cont) {
      expect(groups.length).toBeGreaterThan(0);
      const previous = groups[groups.length - 1]!;
      expect(line.kind).toBe(previous.kind);
      previous.text += line.text;
    } else {
      groups.push({ kind: line.kind, text: line.text });
    }
  }
  return groups;
}
function fileSnapshot(root: string): Record<string, { bytes: string; mtimeMs: number }> {
  const result: Record<string, { bytes: string; mtimeMs: number }> = {};
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        result[relative(root, path)] = {
          bytes: readFileSync(path).toString("base64"),
          mtimeMs: statSync(path).mtimeMs,
        };
      }
    }
  }
  visit(root);
  return result;
}

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

for (const surface of ["session", "team"] as const) {
  describe.skipIf(surface === "team" && !MAGMUX_AVAILABLE)(
    surface + " transcript content/paging",
    () => {
      test(
        "TEST-1 REQ-1 REQ-3 REQ-6 REQ-20: replays recorded prompt and PEAR reply exactly",
        async () => {
          const target = await prepare(surface, recorded("pear-hookless"));

          const result = await page(target);

          expect(result.lines).toEqual([
            { kind: "user", text: "Reply with exactly PEAR and nothing else." },
            { kind: "assistant", text: "PEAR" },
          ]);
          expect(result.more).toBe(false);
          const final = surface === "team" ? await waitForExhaustedFinal(target, result) : result;
          expect(final.final).toBe(true);
          expect(await page(target, final.cursor)).toMatchObject({
            cursor: final.cursor,
            lines: [],
            more: false,
            final: true,
          });
        },
        T_TEST
      );

      test(
        "TEST-2 REQ-3: preserves text blocks and newlines and renders slash commands",
        async () => {
          const target = await prepare(surface, [
            user("typed\nsecond line"),
            reply("reply\nsecond line"),
            user([
              { type: "text", text: "block prompt" },
              { type: "image", source: { type: "base64", data: "AA==" } },
              { type: "text", text: "between attachments" },
              {
                type: "document",
                source: { type: "text", media_type: "text/plain", data: "document body" },
              },
              { type: "text", text: "last block" },
            ]),
            user(
              "<command-message>search</command-message>\n<command-name>/search</command-name>\n<command-args>two words</command-args>"
            ),
            reply("done"),
          ]);

          expect((await drain(target)).lines).toEqual([
            { kind: "user", text: "typed\nsecond line" },
            { kind: "assistant", text: "reply\nsecond line" },
            {
              kind: "user",
              text: "block prompt\n[image]\nbetween attachments\n[document]\nlast block",
            },
            { kind: "user", text: "/search two words" },
            { kind: "assistant", text: "done" },
          ]);
        },
        T_TEST
      );

      test(
        "TEST-3 REQ-4: uses salient tool arguments, caps one-liners and omits delegated turns",
        async () => {
          const examples: Array<[string, Json, string]> = [
            [
              "Bash",
              { description: "not the command", command: "git\t status\n --short" },
              "Bash(git status --short)",
            ],
            ["Read", { file_path: "/src/a.ts", offset: 3 }, "Read(/src/a.ts)"],
            ["Write", { content: "not the path", file_path: "/src/new.ts" }, "Write(/src/new.ts)"],
            [
              "Edit",
              { old_string: "old", new_string: "new", file_path: "src/a.ts" },
              "Edit(src/a.ts)",
            ],
            ["MultiEdit", { file_path: "/src/m.ts", edits: [] }, "MultiEdit(/src/m.ts)"],
            ["Glob", { path: "/src", pattern: "**/*.ts" }, "Glob(**/*.ts)"],
            ["Grep", { path: "/src", pattern: "needle" }, "Grep(needle)"],
            [
              "Agent",
              { prompt: "private delegated prompt", description: "inspect files" },
              "Agent(inspect files)",
            ],
            [
              "Task",
              { prompt: "private task prompt", description: "find callers" },
              "Task(find callers)",
            ],
            ["Skill", { args: "ignored", skill: "review" }, "Skill(review)"],
            [
              "WebFetch",
              { prompt: "ignored", url: "https://example.invalid/page" },
              "WebFetch(https://example.invalid/page)",
            ],
            ["WebSearch", { query: "search words" }, "WebSearch(search words)"],
            ["ToolSearch", { query: "select:Read" }, "ToolSearch(select:Read)"],
            [
              "SendMessage",
              { content: "private body", recipient: "reviewer" },
              "SendMessage(reviewer)",
            ],
            [
              "AskUserQuestion",
              { questions: [{ question: "Which fruit?", header: "Fruit" }] },
              "AskUserQuestion(Which fruit?)",
            ],
            [
              "mcp__demo__lookup",
              { empty: "  ", limit: 2, query: "first value", other: "second" },
              "mcp__demo__lookup(first value)",
            ],
            ["NoInput", { count: 3, enabled: true }, "NoInput()"],
          ];
          const target = await prepare(surface, [
            assistant(examples.map(([name, input]) => toolUse(name, input))),
            assistant([toolUse("Bash", { command: "x".repeat(300) })]),
          ]);
          const subagents = join(target.transcript.slice(0, -".jsonl".length), "subagents");
          mkdirSync(subagents, { recursive: true });
          writeFileSync(
            join(subagents, "agent-test.jsonl"),
            jsonl([reply("DELEGATE-ONLY-CONTENT")])
          );

          const result = await drain(target);

          expect(result.lines.slice(0, examples.length)).toEqual(
            examples.map(([, , text]) => ({ kind: "tool", text }))
          );
          expect(result.lines).toHaveLength(examples.length + 1);
          const long = result.lines[examples.length]!;
          expect(long.kind).toBe("tool");
          expect(long.text.startsWith("Bash(")).toBe(true);
          expect(long.text.endsWith("…)")).toBe(true);
          const argument = long.text.slice("Bash(".length, -1);
          expect(argument.length).toBeLessThanOrEqual(160);
          expect(long.text).not.toMatch(/[\r\n\t]/);
          expect(JSON.stringify(result.lines)).not.toContain("DELEGATE-ONLY-CONTENT");
        },
        T_TEST
      );

      test(
        "TEST-4 REQ-5 REQ-20: returns recorded task-file content on each Read, never ordinary tool results",
        async () => {
          const source = recorded("tools-session");
          const recordedPointer = source.find(
            (r) =>
              typeof messageContent(r) === "string" &&
              (messageContent(r) as string).startsWith("Your task is in the file ")
          )!;
          expect(recordedPointer).toBeDefined();
          const recordedPath = "/tmp/cc2/launch-XW9UoC/turn-1.md";
          const taskPath = join(layout.cwd, "launch-prompt", "turn-1.md");
          mkdirSync(dirname(taskPath), { recursive: true });
          writeFileSync(taskPath, "CURRENT-DISK-CONTENT-NOT-THE-READ");
          const pointer = user(
            (messageContent(recordedPointer) as string).replace(recordedPath, taskPath)
          );
          const contents =
            "Reply with the word KIWI, then on a new line the number of lines in this file.\n" +
            "Second line.\nThird line with a tab:\there.\n" +
            "x".repeat(50);
          const recordedResult = source.find(
            (r) =>
              (r.toolUseResult as { file?: { filePath?: string } } | undefined)?.file?.filePath ===
              recordedPath
          )!;
          expect(recordedResult).toBeDefined();
          const readResult = recordedResult.toolUseResult as { file: Json };
          const taskResult: Json = {
            ...recordedResult,
            toolUseResult: { ...readResult, file: { ...readResult.file, filePath: taskPath } },
          };
          const firstId = (messageContent(taskResult) as Json[])[0]!.tool_use_id as string;
          const secondId = randomUUID();
          const repeated = {
            ...taskResult,
            uuid: randomUUID(),
            message: {
              role: "user",
              content: [
                {
                  ...(messageContent(taskResult) as Json[])[0]!,
                  tool_use_id: secondId,
                },
              ],
            },
          };
          const target = await prepare(surface, [
            pointer,
            assistant([toolUse("Read", { file_path: taskPath }, firstId)]),
            taskResult,
            assistant([toolUse("Read", { file_path: taskPath }, secondId)]),
            repeated,
            assistant([toolUse("Read", { file_path: "/ordinary.txt" }, "ordinary")]),
            user([{ type: "tool_result", tool_use_id: "ordinary", content: "HIDDEN-RESULT" }]),
          ]);

          expect(joined((await drain(target)).lines)).toEqual([
            { kind: "user", text: messageContent(pointer) as string },
            { kind: "tool", text: "Read(" + taskPath + ")" },
            { kind: "task_file", text: contents },
            { kind: "tool", text: "Read(" + taskPath + ")" },
            { kind: "task_file", text: contents },
            { kind: "tool", text: "Read(/ordinary.txt)" },
          ]);
        },
        T_TEST
      );

      test(
        "TEST-5 REQ-6 REQ-20: keeps history across compaction but excludes meta and housekeeping",
        async () => {
          const source = recorded("local-commands");
          const boundary = source.find((r) => r.subtype === "compact_boundary")!;
          const summary = source.find((r) => r.isCompactSummary === true)!;
          expect(boundary).toBeDefined();
          expect(summary).toBeDefined();
          const target = await prepare(surface, [
            user("before compaction"),
            reply("old answer"),
            boundary,
            summary,
            user("HIDDEN-META", { isMeta: true }),
            assistant([{ type: "thinking", thinking: "HIDDEN-THINKING", signature: "hidden" }]),
            user([{ type: "tool_result", tool_use_id: "ignored", content: "HIDDEN-RESULT" }]),
            notice("turn_duration", "HIDDEN-TIMING", { durationMs: 1 }),
            notice("stop_hook_summary", "HIDDEN-HOOK"),
            ...[
              "attachment",
              "api-request",
              "api-request-blob",
              "api-request-shape",
              "last-prompt",
              "mode",
              "permission-mode",
              "file-history-snapshot",
              "queue-operation",
              "custom-title",
              "agent-name",
            ].map((type) => ({ type, content: "HIDDEN-" + type })),
            user("after compaction"),
            reply("new answer"),
          ]);

          expect((await drain(target)).lines).toEqual([
            { kind: "user", text: "before compaction" },
            { kind: "assistant", text: "old answer" },
            { kind: "system", text: "Conversation compacted" },
            { kind: "user", text: "after compaction" },
            { kind: "assistant", text: "new answer" },
          ]);
        },
        T_TEST
      );

      test(
        "TEST-6 REQ-6 REQ-20: distinguishes notices from API errors and refusal errors",
        async () => {
          const api = recorded("api-error-hookless").find((r) => r.isApiErrorMessage === true)!;
          expect(api).toBeDefined();
          const target = await prepare(surface, [
            api,
            notice("api_error", "", {
              level: "error",
              error: { formatted: "API Error: upstream unavailable" },
            }),
            notice("model_refusal_no_fallback", "No fallback is available"),
            notice("model_refusal_fallback", "Retrying with another model"),
            notice("scheduled_task_fire", "Scheduled task fired"),
            notice("agents_killed", "Background agents stopped"),
            notice("local_command", "<local-command-stdout>Command output</local-command-stdout>"),
            user("[Request interrupted by user]"),
            user(
              "<task-notification><task-id>bg-one</task-id><status>completed</status><summary>Background task completed</summary></task-notification>"
            ),
            {
              type: "continued-in",
              sessionId: randomUUID(),
              continuedInSessionId: "11111111-2222-4333-8444-555555555555",
            },
          ]);

          const lines = (await drain(target)).lines;

          expect(lines.slice(0, 7)).toEqual([
            {
              kind: "error",
              text: "Please run /login · API Error: 401 OAuth access token is invalid.",
            },
            { kind: "error", text: "API Error: upstream unavailable" },
            { kind: "error", text: "No fallback is available" },
            { kind: "system", text: "Retrying with another model" },
            { kind: "system", text: "Scheduled task fired" },
            { kind: "system", text: "Background agents stopped" },
            { kind: "system", text: "Command output" },
          ]);
          // The contract specifies notice meaning, not generated wording/punctuation.
          expect(lines).toHaveLength(10);
          expect(lines[7]!.kind).toBe("system");
          expect(lines[7]!.text).toMatch(/interrupt/i);
          expect(lines[8]!.kind).toBe("system");
          expect(lines[8]!.text).toContain("Background task completed");
          expect(lines[9]!.kind).toBe("system");
          expect(lines[9]!.text).toContain("11111111-2222-4333-8444-555555555555");
        },
        T_TEST
      );

      test(
        "TEST-7 REQ-7: strips terminal escapes and controls while preserving LF, TAB and valid Unicode",
        async () => {
          const dirty =
            "\x1b[31mred\x1b[0m " +
            "\x1b]8;;https://example.invalid\x07link\x1b]8;;\x1b\\ " +
            "\x1bPdiscarded DCS payload\x1b\\" +
            "\x00\x01\x08\x0b\x0c\x7f" +
            "A\r\nB\tC\uD800D\uDC00😀 \t\n";
          const target = await prepare(surface, [
            user(dirty),
            reply(dirty),
            reply("\x1b[31m\x00 \t\n"),
          ]);

          expect((await drain(target)).lines).toEqual([
            { kind: "user", text: "red link A\nB\tC�D�😀" },
            { kind: "assistant", text: "red link A\nB\tC�D�😀" },
          ]);
        },
        T_TEST
      );

      test(
        "TEST-8 REQ-8: masks known-shaped synthetic credentials without discarding surrounding text",
        async () => {
          // Construct synthetic material; never embed a real credential in test data.
          const credential = ["sk", "ant", "api03"].join("-") + "-" + "A".repeat(90);
          const target = await prepare(surface, [
            user("before " + credential + " after"),
            reply("before " + credential + " after"),
            assistant([toolUse("Bash", { command: "before " + credential + " after" })]),
            notice("api_error", "", {
              error: { formatted: "before " + credential + " after" },
              level: "error",
            }),
          ]);

          const lines = (await drain(target)).lines;

          expect(lines.map((line) => line.kind)).toEqual(["user", "assistant", "tool", "error"]);
          for (const line of lines) {
            expect(line.text).not.toContain(credential);
            expect(line.text).toContain("before ");
            expect(line.text).toContain(" after");
          }
        },
        T_TEST
      );

      for (const count of [0, 199, 200, 201, 405]) {
        test(
          "TEST-9 REQ-10 REQ-12 REQ-13: returns " + count + " short lines exactly once within caps",
          async () => {
            const expected = Array.from(
              { length: count },
              (_, i): TranscriptLine => ({ kind: "user", text: "line-" + i })
            );
            const target = await prepare(
              surface,
              expected.map((line) => user(line.text))
            );

            const result = await drain(target);

            expect(result.lines).toEqual(expected);
            const last = result.pages[result.pages.length - 1]!;
            const final = surface === "team" ? await waitForExhaustedFinal(target, last) : last;
            expect(final.final).toBe(true);
            if (count > 200) expect(result.pages[0]!.more).toBe(true);
            for (const p of result.pages) {
              if (p.more) expect(p.lines.length).toBeGreaterThan(0);
            }
            expect(await page(target, final.cursor)).toMatchObject({
              cursor: final.cursor,
              lines: [],
              more: false,
              final: true,
            });
          },
          T_TEST
        );
      }

      test(
        "TEST-10 REQ-9 REQ-10 REQ-12: reconstructs byte-bounded cont chains across answer boundaries",
        async () => {
          const long =
            "A".repeat(40_001) +
            "界".repeat(12_000) +
            "😀".repeat(9_000) +
            '"\\\n\t'.repeat(4_000) +
            "END";
          const target = await prepare(surface, [reply(long), user("after chain")]);

          const result = await drain(target);

          expect(result.pages.length).toBeGreaterThan(1);
          expect(result.pages.slice(1).some((p) => p.lines[0]?.cont === true)).toBe(true);
          expect(result.lines[0]!.cont).toBeUndefined();
          expect(joined(result.lines)).toEqual([
            { kind: "assistant", text: long },
            { kind: "user", text: "after chain" },
          ]);
          expect(result.lines[result.lines.length - 1]!.cont).toBeUndefined();
          for (const p of result.pages) expect(p.lines.length).toBeGreaterThan(0);
        },
        T_TEST
      );

      test(
        "TEST-11 REQ-10: keeps old remainder before an append between calls without duplication",
        async () => {
          const expected = Array.from(
            { length: 260 },
            (_, i): TranscriptLine => ({ kind: "user", text: "old-" + i })
          );
          const target = await prepare(
            surface,
            expected.map((line) => user(line.text)),
            true
          );
          const first = await page(target);
          expect(first.more).toBe(true);
          expect(first.final).toBe(false);

          appendFileSync(target.transcript, jsonl([reply("appended-between-pages")]));
          const rest = await drain(target, first.cursor);

          expect([...first.lines, ...rest.lines]).toEqual([
            ...expected,
            { kind: "assistant", text: "appended-between-pages" },
          ]);
        },
        T_TEST
      );

      test(
        "TEST-12 REQ-10: withholds incomplete JSON and complete JSON lacking its final newline",
        async () => {
          const target = await prepare(surface, [user("first")], true);
          const pending = JSON.stringify(reply("late complete line"));
          const cut = Math.floor(pending.length / 2);
          appendFileSync(target.transcript, pending.slice(0, cut));

          const first = await page(target);
          expect(first.lines).toEqual([{ kind: "user", text: "first" }]);
          expect((await page(target, first.cursor)).lines).toEqual([]);
          appendFileSync(target.transcript, pending.slice(cut));
          expect((await page(target, first.cursor)).lines).toEqual([]);
          appendFileSync(target.transcript, "\n");

          const complete = await page(target, first.cursor);
          expect(complete.lines).toEqual([{ kind: "assistant", text: "late complete line" }]);
          expect(complete.cursor).not.toBe(first.cursor);
          expect((await page(target, complete.cursor)).lines).toEqual([]);
        },
        T_TEST
      );

      test(
        "TEST-13 REQ-11 REQ-12: advances over excluded records and stabilises when nothing is written",
        async () => {
          const target = await prepare(surface, [user("visible")], true);
          // Appends are legal before final, never after an exhausted final:true answer.
          const now = new Date();
          utimesSync(target.transcript, now, now);
          const first = await page(target);
          expect(first.final).toBe(false);
          appendFileSync(
            target.transcript,
            jsonl([
              { type: "mode", mode: "normal" },
              user("injected", { isMeta: true }),
              notice("turn_duration", "", { durationMs: 1 }),
            ])
          );

          const skipped = await page(target, first.cursor);

          expect(skipped.lines).toEqual([]);
          expect(skipped.cursor).not.toBe(first.cursor);
          const stable = await page(target, skipped.cursor);
          expect(stable.cursor).toBe(skipped.cursor);
          expect(stable.lines).toEqual([]);
          appendFileSync(target.transcript, jsonl([reply("after skipped records")]));
          expect((await page(target, stable.cursor)).lines).toEqual([
            { kind: "assistant", text: "after skipped records" },
          ]);
        },
        T_TEST
      );

      test(
        "TEST-14 REQ-11: a cursor is stable across another server and a restart",
        async () => {
          const target = await prepare(
            surface,
            Array.from({ length: 240 }, (_, i) => user("item-" + i))
          );
          const first = await page(target);
          expect(first.more).toBe(true);
          const expected = await page(target, first.cursor);
          const observer = await startServer();
          observers.push(observer);

          expect(await page(target, first.cursor, observer)).toEqual(expected);
          await restart();
          expect(await page(target, first.cursor)).toEqual(expected);
          expect((await page(target)).cursor).toBe(first.cursor);
        },
        T_TEST
      );

      test(
        "TEST-15 REQ-19: repeated reads leave record files, transcript bytes and mtimes unchanged",
        async () => {
          const target = await prepare(surface, [user("read only"), reply("unchanged")]);
          const beforeRecords = fileSnapshot(target.recordDir);
          const beforeProjects = fileSnapshot(join(layout.configDir, "projects"));

          const first = await page(target);
          await page(target, first.cursor);
          await page(target);

          expect(fileSnapshot(target.recordDir)).toEqual(beforeRecords);
          expect(fileSnapshot(join(layout.configDir, "projects"))).toEqual(beforeProjects);
        },
        T_TEST
      );

      test(
        "TEST-16 REQ-17: rejects genuine cursors past EOF and no longer at a line boundary",
        async () => {
          const target = await prepare(surface, [user("position")], true);
          const now = new Date();
          utimesSync(target.transcript, now, now);
          const end = await page(target);
          expect(end.final).toBe(false);

          writeFileSync(target.transcript, "");
          contractError(
            await call(target.tool, { ...target.args, since: end.cursor }),
            "invalid_args"
          );

          // Keep the issued cursor opaque. Replace its old boundary with part of a longer
          // complete JSONL record, so the real issued position is now inside that record.
          putTranscript(target.transcript, [user("x".repeat(4_000))]);
          contractError(
            await call(target.tool, { ...target.args, since: end.cursor }),
            "invalid_args"
          );
        },
        T_TEST
      );
    }
  );
}

describe("argument validation and lookup errors (no panes)", () => {
  test("TEST-17 REQ-16: validates session identifiers before lookup", async () => {
    for (const session_id of [undefined, "", null, 7, false, [], {}]) {
      contractError(
        await call("transcript_session", session_id === undefined ? {} : { session_id }),
        "invalid_args"
      );
    }
  });

  test("TEST-17 REQ-16: validates optional since and run_id before lookup", async () => {
    // Present null is invalid, not omitted. Malformed cursors also fail before lookup.
    for (const since of ["", null, 7, false, [], {}, "not-a-cursor", "v1.invalid"]) {
      contractError(
        await call("transcript_session", { session_id: "missing", since }),
        "invalid_args",
        "transcript_session since=" + JSON.stringify(since)
      );
      contractError(
        await call("team", {
          mode: "transcript",
          path: join(layout.cwd, "missing"),
          slot: "01",
          since,
        }),
        "invalid_args",
        "team transcript since=" + JSON.stringify(since)
      );
    }
    for (const run_id of ["", null, 7, false, [], {}]) {
      contractError(
        await call("team", {
          mode: "transcript",
          path: join(layout.cwd, "missing"),
          slot: "01",
          run_id,
        }),
        "invalid_args",
        "team transcript run_id=" + JSON.stringify(run_id)
      );
    }
  });

  test("TEST-17 REQ-16: validates required team path and slot before lookup", async () => {
    for (const path of [undefined, "", null, 7, false, [], {}]) {
      contractError(
        await call("team", {
          mode: "transcript",
          slot: "01",
          ...(path === undefined ? {} : { path }),
        }),
        "invalid_args"
      );
    }
    for (const slot of [undefined, "", null, 7, false, [], {}]) {
      contractError(
        await call("team", {
          mode: "transcript",
          path: join(layout.cwd, "missing"),
          ...(slot === undefined ? {} : { slot }),
        }),
        "invalid_args"
      );
    }
  });

  test("TEST-18 REQ-17: returns gone errors for valid requests and performs lookup before cursor ownership", async () => {
    const target = seedSession([user("cursor owner")]);
    const result = await page(target);
    for (const since of [undefined, result.cursor]) {
      const optional = since === undefined ? {} : { since };
      contractError(
        await call("transcript_session", { session_id: "missing", ...optional }),
        "unknown_session"
      );
      contractError(
        await call("team", {
          mode: "transcript",
          path: join(layout.cwd, "missing"),
          slot: "01",
          ...optional,
        }),
        "unknown_run"
      );
    }
  });

  test("TEST-16 REQ-17: rejects another session's cursor even with identical content", async () => {
    const first = seedSession([user("same content")]);
    const second = seedSession([user("same content")]);
    const cursor = (await page(first)).cursor;

    contractError(
      await call("transcript_session", { ...second.args, since: cursor }),
      "invalid_args"
    );
    expect((await page(second)).lines).toEqual([{ kind: "user", text: "same content" }]);
  });
});

describe("session availability and final-state evidence", () => {
  test("TEST-19 REQ-13: an aged final record and quiet transcript prove final regardless of owner liveness", async () => {
    for (const owner of [process.pid, null, 1.5]) {
      const target = seedSession([reply("retained answer")], { owner });
      const result = await page(target);
      expect(result.lines).toEqual([{ kind: "assistant", text: "retained answer" }]);
      expect(result.more).toBe(false);
      expect(result.final).toBe(true);
    }
  });

  test("TEST-19 REQ-13: without a final record a live, null, missing or invalid owner cannot prove final", async () => {
    for (const owner of [process.pid, null, "missing", 1.5] as const) {
      const target = seedSession([reply("retained answer")], {
        terminal: false,
        owner: owner === "missing" ? null : owner,
      });
      if (owner === null) {
        // seedSession's null option omits mcpPid; also exercise an explicit JSON null.
        const spawnPath = join(target.recordDir, "spawn.json");
        const spawn = JSON.parse(readFileSync(spawnPath, "utf8")) as Json;
        writeJson(spawnPath, { ...spawn, mcpPid: null });
      }
      const result = await page(target);
      expect(result.lines).toEqual([{ kind: "assistant", text: "retained answer" }]);
      expect(result.more).toBe(false);
      expect(result.final).toBe(false);
      expect(await page(target, result.cursor)).toMatchObject({
        cursor: result.cursor,
        lines: [],
        more: false,
        final: false,
      });
    }
  });

  test("TEST-19 REQ-13: dead owner is not final until the transcript is quiet, then exhausted polls stay final", async () => {
    const target = seedSession([reply("finished")], { quiet: false });

    const recent = await page(target);
    expect(recent.final).toBe(false);
    age(target.transcript);
    const quiet = await page(target, recent.cursor);
    expect(quiet).toMatchObject({ lines: [], more: false, final: true, cursor: recent.cursor });
    expect(await page(target, quiet.cursor)).toEqual(quiet);
  });

  test("TEST-20 REQ-14: missing transcript is empty both before first prompt and after proven finish", async () => {
    const running = seedSession([], {
      terminal: false,
      owner: process.pid,
      missingTranscript: true,
    });
    const finished = seedSession([], { missingTranscript: true });

    expect(await page(running)).toMatchObject({ lines: [], more: false, final: false });
    expect(await page(finished)).toMatchObject({ lines: [], more: false, final: true });
  });

  test("TEST-20 REQ-14: no conversation id uses only the documented sentinel cursor", async () => {
    const missingId = seedSession([], { missingConversationId: true });
    const first = await page(missingId);
    expect(first).toMatchObject({ cursor: "v1.0.0.00000000", lines: [], more: false });
    expect(await page(missingId, first.cursor)).toEqual(first);
    const other = seedSession([user("has identity")]);
    const otherCursor = (await page(other)).cursor;

    contractError(
      await call("transcript_session", { ...missingId.args, since: otherCursor }),
      "invalid_args"
    );
  });

  test("TEST-21 REQ-15: reads a live spawn-only session by unique id without requiring cwd", async () => {
    const target = seedSession([user("other server prompt"), reply("other server answer")], {
      terminal: false,
      owner: process.pid,
    });

    const result = await page(target);

    expect(result.lines).toEqual([
      { kind: "user", text: "other server prompt" },
      { kind: "assistant", text: "other server answer" },
    ]);
    expect(result.final).toBe(false);
    appendFileSync(target.transcript, jsonl([reply("another live append")]));
    expect((await page(target, result.cursor)).lines).toEqual([
      { kind: "assistant", text: "another live append" },
    ]);
  });

  test("TEST-21 REQ-15: refuses to guess when two project directories contain the same conversation id", async () => {
    const target = seedSession([reply("first candidate")], { terminal: false, owner: process.pid });
    const duplicate = join(
      layout.configDir,
      "projects",
      "another-project",
      target.conversationId + ".jsonl"
    );
    putTranscript(duplicate, [reply("second candidate")]);

    expect(await page(target)).toMatchObject({ lines: [], more: false, final: false });
  });
});

describe("additive transcript MCP surface", () => {
  test("TEST-22 REQ-18: pins v1 capabilities, transcript kinds and numeric limits independently", async () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect([...CAPABILITIES]).toEqual(EXPECTED_CAPABILITIES);
    expect([...TRANSCRIPT_KINDS]).toEqual([
      "user",
      "assistant",
      "tool",
      "task_file",
      "system",
      "error",
    ]);
    expect(MAX_TRANSCRIPT_LINES).toBe(200);
    expect(TRANSCRIPT_LINE_MAX_CHARS).toBe(8_000);
    expect(TRANSCRIPT_LINE_MAX_JSON_BYTES).toBe(16_000);
    expect(TRANSCRIPT_ANSWER_MAX_BYTES).toBe(32_000);
    for (const [tool, args] of [
      ["list_sessions", {}],
      ["team", { mode: "list" }],
    ] as const) {
      expect(ok(await call(tool, args))).toMatchObject({
        contract_version: 1,
        capabilities: EXPECTED_CAPABILITIES,
      });
    }
  });

  test("TEST-22 REQ-18: advertises 20 tools, transcript inputs, caps and cross-answer cont semantics", async () => {
    const response = await currentServer().request("tools/list", {});
    type Listed = {
      name: string;
      description: string;
      inputSchema: { required?: string[]; properties: Record<string, Json> };
    };
    const tools = (response.result as { tools: Listed[] }).tools;
    expect(tools).toHaveLength(20);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(20);
    const transcript = tools.find((tool) => tool.name === "transcript_session")!;
    expect(transcript).toBeDefined();
    expect(transcript.inputSchema.required).toEqual(["session_id"]);
    expect(Object.keys(transcript.inputSchema.properties).sort()).toEqual(["session_id", "since"]);
    expect(transcript.inputSchema.properties).toMatchObject({
      session_id: { type: "string" },
      since: { type: "string" },
    });
    const team = tools.find((tool) => tool.name === "team")!;
    const props = team.inputSchema.properties;
    expect((props.mode!.enum as string[]).slice(-3)).toEqual(["scroll", "transcript", "replay"]);
    expect(props.since).toMatchObject({ type: "string" });
    expect(String(props.mode!.description)).toContain("cont");
    expect(String(props.mode!.description)).toMatch(/next answer/i);
    expect(String(props.since_seq!.description)).toMatch(/capture.*only/i);
    for (const key of ["slot", "run_id"])
      expect(String(props[key]!.description)).toContain("transcript");
    const sessionDescription = transcript.description;
    const teamDescription = String(props.since!.description);
    for (const text of [sessionDescription, teamDescription]) {
      expect(text).toContain("200");
      expect(text).toMatch(/32,?000/);
      expect(text).toContain("cont");
      expect(text).toMatch(/next answer/i);
      expect(text).toContain("cursor");
      expect(text).toMatch(/order/i);
    }
    expect(sessionDescription).toContain("final");
    expect(sessionDescription).toMatch(/read.only/i);
    expect(sessionDescription).toContain("8,000");
  });

  test("TEST-23 REQ-18: session group exposes exactly the twelve session tools", async () => {
    await restart({ CLAUDISH_MCP_TOOLS: "session" });

    expect((await currentServer().listTools()).map((tool) => tool.name).sort()).toEqual([
      "cancel_session",
      "capture_session",
      "close_replay",
      "create_session",
      "get_diagnostics",
      "get_output",
      "list_sessions",
      "replay_session",
      "resize_session",
      "scroll_session",
      "send_input",
      "transcript_session",
    ]);
  });

  for (const group of [undefined, "all", "session", "agentic", "low-level", "debug"]) {
    test("TEST-23 REQ-18: nested " +
      (group ?? "default") +
      " excludes transcript_session", async () => {
      await restart({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_MCP_TOOLS: group });

      expect((await currentServer().listTools()).map((tool) => tool.name)).not.toContain(
        "transcript_session"
      );
    });
  }
});

describe.skipIf(!MAGMUX_AVAILABLE)("live lifecycle and team addressing", () => {
  test(
    "TEST-24 REQ-1 REQ-13: live interactive session is empty before prompt and non-final during a held turn",
    async () => {
      const created = await createSession(currentServer(), {});
      ok(created.result);
      expect(created.sessionId).toBeDefined();
      const sessionId = created.sessionId!;
      const initial = ok(await call("transcript_session", { session_id: sessionId }));
      expect(initial).toMatchObject({
        session_id: sessionId,
        lines: [],
        more: false,
        final: false,
      });

      ok(await sendInput(currentServer(), sessionId, "transcript-live-prompt @@HANG@@"));
      const live = await waitFor(
        async () => {
          const value = ok(await call("transcript_session", { session_id: sessionId }));
          return JSON.stringify(value.lines).includes("transcript-live-prompt") ? value : undefined;
        },
        { what: "live prompt in transcript", timeoutMs: 45_000, intervalMs: 100 }
      );

      expect(live.final).toBe(false);
      expect(
        (live.lines as TranscriptLine[]).some(
          (line) => line.kind === "user" || line.kind === "task_file"
        )
      ).toBe(true);
    },
    T_TEST
  );

  test(
    "TEST-25 TEST-28 REQ-1 REQ-2 REQ-13 REQ-18: team reads active and cancelled slots with unchanged identity",
    async () => {
      const path = join(layout.cwd, "live-team");
      const started = await startTeam(path, "team-live-prompt @@HANG@@", ["contract-fake-model"]);
      const runId = started.run_id as string;
      const args = { mode: "transcript", path, slot: "01", run_id: runId };
      const live = ok(await call("team", args));
      expect(structuredClone(live)).toMatchObject({
        run_id: runId,
        path,
        slot: "01",
        cursor: expect.any(String),
        lines: expect.any(Array),
        more: expect.any(Boolean),
        final: false,
      });
      expect((live.cursor as string).length).toBeGreaterThan(0);
      // A file-delivered prompt is a user pointer, not the task's text. task_file
      // content appears only as the child's Read returns it, not necessarily now.
      // TEST-4 checks that content against controlled transcript data on both surfaces.
      for (const query of [{ mode: "status", path }, { mode: "list" }]) {
        expect(ok(await call("team", query))).toMatchObject({
          contract_version: 1,
          capabilities: EXPECTED_CAPABILITIES,
        });
      }

      ok(await call("team", { mode: "cancel", path, run_id: runId }));
      await paneExited(path, "01", runId);
      let cursor = live.cursor as string;
      const final = await waitFor(
        async () => {
          const next = ok(await call("team", { ...args, since: cursor }));
          cursor = next.cursor as string;
          return next.final === true ? next : undefined;
        },
        { what: "cancelled team's final transcript", timeoutMs: 45_000, intervalMs: 100 }
      );

      expect(final).toMatchObject({ run_id: runId, path, slot: "01", more: false, final: true });
      expect(ok(await call("team", { ...args, since: cursor }))).toMatchObject({
        cursor,
        lines: [],
        more: false,
        final: true,
      });
    },
    T_TEST
  );

  test(
    "TEST-26 REQ-2 REQ-17: newest run and retained older run never exchange transcripts or cursors",
    async () => {
      const path = join(layout.cwd, "reused-team-path");
      const first = await startTeam(path, "FIRST-RUN-MARKER");
      const firstId = first.run_id as string;
      await settled(path, firstId);
      await paneExited(path, "01", firstId);
      const oldArgs = { mode: "transcript", path, slot: "01", run_id: firstId };
      const old = ok(await call("team", oldArgs));
      expect(JSON.stringify(old.lines)).toContain("FIRST-RUN-MARKER");

      // The run API refuses an existing session directory. The first run's pane has stopped.
      // Remove only this test-owned directory; its transcript lives outside it in layout.configDir.
      // Keep the same server: only its memory retains the older run after this deletion.
      rmSync(path, { recursive: true });
      const second = await startTeam(path, "SECOND-RUN-MARKER");
      const secondId = second.run_id as string;
      expect(secondId).not.toBe(firstId);
      await settled(path, secondId);
      const newest = ok(await call("team", { mode: "transcript", path, slot: "01" }));
      expect(newest.run_id).toBe(secondId);
      expect(newest.path).toBe(path);
      expect(JSON.stringify(newest.lines)).toContain("SECOND-RUN-MARKER");
      expect(JSON.stringify(newest.lines)).not.toContain("FIRST-RUN-MARKER");
      expect(JSON.stringify(ok(await call("team", oldArgs)).lines)).toContain("FIRST-RUN-MARKER");
      contractError(
        await call("team", {
          mode: "transcript",
          path,
          slot: "01",
          run_id: secondId,
          since: old.cursor,
        }),
        "invalid_args"
      );
    },
    T_TEST
  );

  test(
    "TEST-27 TEST-18 REQ-2 REQ-11 REQ-17: reads matching on-disk run after restart and distinguishes gone run/slot",
    async () => {
      const target = await prepare("team", [user("recorded run"), reply("retained text")]);

      const explicit = await page(target);
      const byPath = ok(
        await call("team", {
          mode: "transcript",
          path: String(target.args.path) + "/.",
          slot: target.args.slot,
        })
      );
      expect(byPath).toMatchObject({ ...target.identity, ...explicit });
      contractError(
        await call("team", { ...target.args, run_id: "never-retained-run" }),
        "unknown_run"
      );
      contractError(await call("team", { ...target.args, slot: "99" }), "unknown_slot");
      contractError(
        await call("team", { ...target.args, slot: "99", since: explicit.cursor }),
        "unknown_slot"
      );
    },
    T_TEST
  );

  test(
    "TEST-16 REQ-17: same-run cursors are slot-specific, not just run-specific",
    async () => {
      const path = join(layout.cwd, "two-slots");
      const started = await startTeam(path, "shared prompt", ["fake-answer", "fake-no_shape"]);
      const runId = started.run_id as string;
      await settled(path, runId);
      const slots = Object.values(started.slots as Record<string, string>);
      expect(slots).toHaveLength(2);
      const first = ok(
        await call("team", { mode: "transcript", path, run_id: runId, slot: slots[0] })
      );

      contractError(
        await call("team", {
          mode: "transcript",
          path,
          run_id: runId,
          slot: slots[1],
          since: first.cursor,
        }),
        "invalid_args"
      );
    },
    T_TEST
  );
});
