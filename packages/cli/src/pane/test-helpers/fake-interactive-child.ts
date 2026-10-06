#!/usr/bin/env bun
/**
 * The fake interactive child (architecture §12.2): a stand-in for "claudish → Claude Code"
 * inside a real magmux pane. Test-only.
 *
 * It draws the REPL with lines COPIED from the phase-2 real screen fixtures, reads raw
 * keystrokes with the key semantics measured from the real REPL's keylog (phase2-captures
 * §3: `\r` submits, ctrl-j inserts a newline, Esc closes a menu / declines a dialog /
 * interrupts, Enter on an `@` menu submits as typed), and writes its transcript to
 * `<CLAUDE_CONFIG_DIR>/projects/<slug(realpath cwd)>/<uuid>.jsonl` by TEMPLATING records
 * from the real transcript fixtures (ids, text and times substituted; never hand-written).
 *
 * Three ways to run it:
 *   - as claudish (`CLAUDISH_BIN=<this file>`): `-i --model fake-<scenario>[-<n>] -y --quiet
 *     --session-id <uuid> --add-dir <dir> [flags]`;
 *   - marker mode: any other `--model` (the contract suites pass `contract-fake-model`): the
 *     scenario comes from markers in the delivered prompt (`@@TOOL@@`, `@@HANG@@`,
 *     `@@LINGER@@`, `@@LATE@@`) or `CONTRACT_FAKE_HANG=1`;
 *   - "claude" mode (`--fake-as-claude` first, via a CLAUDE_PATH wrapper): the REAL claudish
 *     launches it as Claude Code; it dumps argv, env, cwd and the `--settings` content to
 *     `FAKE_CLAUDE_DUMP`, then emulates the REPL in marker mode.
 *
 * A file-delivered prompt (the fixed template) is read back exactly as Read returns it
 * (numbered lines, `toolUseResult.file`), reconstructed (split markers joined), and
 * answered `ANSWER <model> <sha1(reconstructed)[0..8]>`, so a test can compare the hash
 * with sha1 of the caller's prompt and see any loss. A typed line hashes the line.
 *
 * Gaps come from `FAKE_GAP_MS_<NAME>` so scenarios keep their ORDER at a fraction of real
 * time. `CONTRACT_FAKE_MAX_MS` (default 20 s) is a safety exit so a broken test never
 * leaves a REPL behind. `CONTRACT_FAKE_SIGTERM_MARKER` is written on SIGTERM or SIGHUP.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDirNameFor } from "../../channel/parent-proof.js";

/* ───────────────────────────── argv and env ───────────────────────────── */

const rawArgv = process.argv.slice(2);
const asClaude = rawArgv[0] === "--fake-as-claude";
const argv = asClaude ? rawArgv.slice(1) : rawArgv;

function flag(name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === name) return argv[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

const env = process.env;
const model = flag("--model") ?? "fake-answer";
const sessionId = flag("--session-id") ?? randomUUID();
const agent = flag("--agent");
const scenario = asClaude
  ? (env.FAKE_SCENARIO ?? "marker")
  : model.startsWith("fake-")
    ? model.slice(5).replace(/-\d+$/, "")
    : "marker";
const COLS = Number(env.COLUMNS) || 160;
const ROWS = Number(env.LINES) || 50;
const cwd = (() => {
  try {
    return realpathSync(process.cwd());
  } catch {
    return process.cwd();
  }
})();

function gap(name: string, dflt: number): number {
  const v = Number(env[`FAKE_GAP_MS_${name}`]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ───────────────────────────── fixtures ───────────────────────────── */

const FIX = join(import.meta.dir, "..", "test-fixtures");
// biome-ignore lint/suspicious/noExplicitAny: raw JSON records copied from real captures
type Rec = Record<string, any>;

function lines(name: string): Rec[] {
  return readFileSync(join(FIX, "transcripts", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function screenLines(name: string): string[] {
  return (
    JSON.parse(readFileSync(join(FIX, "screens", `${name}.json`), "utf8")) as { lines: string[] }
  ).lines;
}

const TOOLS = lines("tools-session");
const T = {
  user: TOOLS[4] as Rec,
  text: TOOLS[28] as Rec,
  td: TOOLS[29] as Rec,
  tdPending: TOOLS[72] as Rec,
  bashUse: TOOLS[19] as Rec,
  bashResult: TOOLS[20] as Rec,
  bgBashUse: TOOLS[45] as Rec,
  bgBashResult: TOOLS[46] as Rec,
  bgNotify: TOOLS[53] as Rec,
  agentUse: TOOLS[61] as Rec,
  agentResult: TOOLS[62] as Rec,
  agentNotify: TOOLS[73] as Rec,
  askUse: TOOLS[82] as Rec,
  rejectResult: TOOLS[83] as Rec,
  interruptTool: TOOLS[84] as Rec,
  interruptPlain: TOOLS[98] as Rec,
  readUse: TOOLS[132] as Rec,
  readResult: TOOLS[133] as Rec,
  compactBoundary: TOOLS[144] as Rec,
  compactSummary: TOOLS[145] as Rec,
  stopSummary: lines("stop-hook-matrix")[25] as Rec,
  apiError: lines("api-error-hookless")[18] as Rec,
  writeUse: lines("permission-write-esc")[19] as Rec,
  command: lines("slash-and-reads")[4] as Rec,
};
/** Claude Code 2.1.291 local-command records (code-review captures, cr1-commands). */
const LOCAL = lines("local-commands");
const L = {
  systemCommand: LOCAL[27] as Rec, // /color: system/local_command <command-name>
  systemStdout: LOCAL[28] as Rec, // /color: system/local_command <local-command-stdout>
  caveat: LOCAL[30] as Rec, // user isMeta <local-command-caveat>
  userCommand: LOCAL[31] as Rec, // /model: user <command-name>
  userStdout: LOCAL[32] as Rec, // /model: user <local-command-stdout>
  compactTyped: LOCAL[34] as Rec, // the plain "/compact" user record before the boundary
  compactBoundary: LOCAL[40] as Rec,
  compactSummary: LOCAL[41] as Rec,
};
const MAX_TOKENS_SLICE = lines("max-tokens-hookless").slice(18, 26);
const REFUSAL_SLICE = lines("corpus-redacted/refusal-then-fallback").slice(30, 36);

/* ───────────────────────────── transcript writer ───────────────────────────── */

const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "/tmp", ".claude");
const transcript = join(configDir, "projects", projectDirNameFor(cwd), `${sessionId}.jsonl`);
let parent: string | null = null;
let msgCounter = 0;
const writeTranscript = ![
  "no_transcript",
  "empty_transcript",
  "missing_no_warning",
  "screen_fast",
  "screen_api_error",
].includes(scenario);

function newMsgId(): string {
  return `msg_fake${process.pid}_${++msgCounter}_${randomUUID().slice(0, 8)}`;
}

function emit(template: Rec, patch: (r: Rec) => void = () => {}): Rec {
  const r = structuredClone(template);
  r.uuid = randomUUID();
  if ("parentUuid" in r) r.parentUuid = parent;
  r.timestamp = new Date().toISOString();
  if ("sessionId" in r) r.sessionId = sessionId;
  if ("session_id" in r) r.session_id = sessionId;
  if ("cwd" in r) r.cwd = cwd;
  patch(r);
  if (writeTranscript) {
    mkdirSync(dirname(transcript), { recursive: true });
    appendFileSync(transcript, `${JSON.stringify(r)}\n`);
  }
  parent = r.uuid;
  return r;
}

const rec = {
  user(text: string) {
    return emit(T.user, (r) => {
      r.message.content = text;
      r.promptId = randomUUID();
    });
  },
  command(name: string, args: string) {
    return emit(T.command, (r) => {
      r.message.content = `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args ? `\n<command-args>${args}</command-args>` : ""}`;
    });
  },
  /**
   * A local command run in the REPL, as 2.1.291 writes it: user records (caveat,
   * `<command-name>`, `<local-command-stdout>`), or — for `/color` — two
   * `system/local_command` records.
   */
  localCommand(name: string, args: string, stdout: string, as: "user" | "system" = "user") {
    const body = `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`;
    if (as === "system") {
      emit(L.systemCommand, (r) => {
        r.content = body;
      });
      emit(L.systemStdout, (r) => {
        r.content = `<local-command-stdout>${stdout}</local-command-stdout>`;
        r.commandRun = { command: name, args };
      });
      return;
    }
    emit(L.caveat);
    emit(L.userCommand, (r) => {
      r.message.content = body;
    });
    emit(L.userStdout, (r) => {
      r.message.content = `<local-command-stdout>${stdout}</local-command-stdout>`;
    });
  },
  text(text: string, stop: string | null = "end_turn", id = newMsgId()) {
    return emit(T.text, (r) => {
      r.message.id = id;
      r.message.content = [{ type: "text", text }];
      r.message.stop_reason = stop;
    });
  },
  toolUse(
    name: string,
    input: unknown,
    opts: { id?: string; msgId?: string; template?: Rec } = {}
  ) {
    const id = opts.id ?? `toolu_fake${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    emit(opts.template ?? T.bashUse, (r) => {
      r.message.id = opts.msgId ?? newMsgId();
      r.message.content = [{ ...r.message.content[0], type: "tool_use", id, name, input }];
      r.message.stop_reason = "tool_use";
    });
    return id;
  },
  toolResult(
    id: string,
    content: unknown,
    tur: unknown,
    opts: { isError?: boolean; template?: Rec } = {}
  ) {
    return emit(opts.template ?? T.bashResult, (r) => {
      r.message.content = [
        { tool_use_id: id, type: "tool_result", content, is_error: !!opts.isError },
      ];
      r.toolUseResult = tur;
      r.sourceToolAssistantUUID = parent;
    });
  },
  td(pending = 0) {
    return emit(pending > 0 ? T.tdPending : T.td, (r) => {
      if (pending > 0) r.pendingBackgroundAgentCount = pending;
      else delete r.pendingBackgroundAgentCount;
    });
  },
  stopSummary() {
    return emit(T.stopSummary);
  },
  interrupt(forTool: boolean) {
    return emit(forTool ? T.interruptTool : T.interruptPlain);
  },
  notify(template: Rec, oldId: string, newId: string) {
    return emit(template, (r) => {
      r.message.content = String(r.message.content).replaceAll(oldId, newId);
    });
  },
  apiError(text: string) {
    return emit(T.apiError, (r) => {
      r.message.id = randomUUID();
      r.message.content = [{ type: "text", text }];
    });
  },
  /** Replay a real slice with fresh ids (message ids made unique, tool ids kept per slice). */
  slice(records: Rec[]) {
    const ids = new Map<string, string>();
    for (const t of records) {
      emit(t, (r) => {
        const mid = r.message?.id;
        if (typeof mid === "string" && r.type === "assistant") {
          if (!ids.has(mid)) ids.set(mid, newMsgId());
          r.message.id = ids.get(mid);
        }
      });
    }
  },
};

/* ───────────────────────────── screen ───────────────────────────── */

const BANNER = screenLines("repl-boot-empty").slice(0, 4);
const RULE = "─".repeat(COLS);
const STATUS = [
  "  cwd • fake • $0.000 • N/A",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
];
const PLACEHOLDER = 'Try "how does <filepath> work?"'; // repl-boot-placeholder, attr 2 (faint)

const S = {
  booted: false,
  box: "",
  history: [] as string[],
  working: null as string | null,
  full: null as string[] | null, // a whole fixture screen (dialogs, panels)
  menu: null as string | null,
  statusTick: 0,
  ghost: false,
};

function fit(l: string): string {
  return Array.from(l).slice(0, COLS).join("");
}

function render(): void {
  let out = "\x1b[H\x1b[2J";
  const rows = S.full ? S.full.slice(0, ROWS) : replRows();
  rows.forEach((l, y) => {
    if (!l) return;
    out += `\x1b[${y + 1};1H`;
    if (l.startsWith("\u0000ghost")) out += `❯ \x1b[2m${PLACEHOLDER}\x1b[22m`;
    else out += fit(l);
  });
  const boxRow = S.full ? ROWS - 1 : ROWS - 4;
  out += `\x1b[${boxRow + 1};${3 + Array.from(S.box.split("\n").pop() ?? "").length}H`;
  process.stdout.write(out);
}

function replRows(): string[] {
  const out: string[] = Array.from({ length: ROWS }, () => "");
  const boxLines = S.box.split("\n");
  const top = ROWS - 4 - boxLines.length;
  BANNER.forEach((l, i) => {
    out[i] = i === 3 ? `${l.slice(0, 11)}${cwd}` : l;
  });
  out[top] = RULE;
  boxLines.forEach((l, i) => {
    out[top + 1 + i] = i === 0 ? `❯ ${l}` : `  ${l}`;
  });
  if (!S.box && S.ghost) out[top + 1] = "\u0000ghost";
  out[ROWS - 3] = RULE;
  out[ROWS - 2] = S.statusTick ? `${STATUS[0]} · ${S.statusTick}` : (STATUS[0] as string);
  out[ROWS - 1] = STATUS[1] as string;
  const above: string[] = [...S.history];
  if (S.working) above.push(S.working);
  if (S.menu) above.push("", S.menu);
  const room = top - 4;
  const shown = above.slice(-room);
  shown.forEach((l, i) => {
    out[4 + i] = l;
  });
  return out;
}

function showHistory(...rows: string[]): void {
  S.history.push(...rows);
  render();
}

function finishedRow(): string {
  return "✻ Cogitated for 1s";
}

/* ───────────────────────────── turns ───────────────────────────── */

const TEMPLATE_RE = /^Your task is in the file `([^`]+)`\./;
let turn = 0;
let busy = false;
let pendingEsc: (() => void) | null = null;
let swallowUntilEsc = false;
let firstSubmitIgnored = false;
let menuEaten = false;

function sha8(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function answerFor(content: string): string {
  if (scenario === "no_shape") return "Here is some prose without the expected shape.";
  if (scenario === "multibyte") return `答え 🍐 ANSWER ${model} ${sha8(content)} — 東京 ✓`;
  return `ANSWER ${model} ${sha8(content)}`;
}

interface Delivered {
  content: string;
  file: string | null;
}

/** Read the turn file the way Read does: numbered lines, `toolUseResult.file`, CR stripped. */
function readTurnFile(
  file: string,
  line: string,
  opts: { narrate?: boolean; partial?: boolean }
): string {
  const text = readFileSync(file, "utf8");
  const all = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const take = opts.partial ? all.slice(0, Math.max(1, Math.ceil(all.length / 2))) : all;
  const msgId = newMsgId();
  if (opts.narrate) rec.text("I'll read the task file first.", "tool_use", msgId);
  const id = rec.toolUse("Read", { file_path: file }, { msgId, template: T.readUse });
  const content = take.map((l, i) => `${i + 1}\t${l}`).join("\n");
  rec.toolResult(
    id,
    content,
    {
      type: "text",
      file: {
        filePath: file,
        content: take.join("\n"),
        numLines: take.length,
        startLine: 1,
        totalLines: all.length,
      },
    },
    { template: T.readResult }
  );
  const marker = line.includes("ending in ⤶") ? "⤶" : line.includes("ending in ↩") ? "↩" : null;
  let joined = take.join("\n");
  if (marker) joined = joinSplit(joined, marker);
  return joined;
}

function joinSplit(content: string, marker: string): string {
  const out: string[] = [];
  let acc = "";
  for (const l of content.split("\n")) {
    if (l.endsWith(marker)) acc += l.slice(0, -marker.length);
    else {
      out.push(acc + l);
      acc = "";
    }
  }
  if (acc) out.push(acc);
  return out.join("\n");
}

function deliveredOf(line: string): Delivered {
  const m = line.match(TEMPLATE_RE);
  if (!m) return { content: line, file: null };
  const file = m[1] as string;
  if (scenario === "no_read") return { content: "", file };
  const content = readTurnFile(file, line, {
    narrate: scenario === "narrate_then_read",
    partial: scenario === "partial_read",
  });
  return { content, file };
}

function markerScenario(content: string): string {
  if (env.CONTRACT_FAKE_HANG === "1" || content.includes("@@HANG@@")) return "hang";
  if (content.includes("@@TOOL@@")) return "tool";
  if (content.includes("@@LINGER@@")) return "linger";
  if (content.includes("@@LATE@@")) return "rewake";
  return "answer";
}

/** Blocking scenarios block turn 1 only; the prompt sent after the decline is answered. */
const FIRST_TURN_ONLY = new Set(["ask_user", "ask_user_send", "interrupt_td", "permission"]);

function effectiveScenario(content: string): string {
  if (scenario === "marker") return markerScenario(content);
  if (turn > 1 && FIRST_TURN_ONLY.has(scenario)) return "answer";
  return scenario;
}

async function answerTurn(content: string): Promise<void> {
  rec.text(answerFor(content));
  rec.td();
  showHistory(`⏺ ${answerFor(content)}`, finishedRow());
}

function waitEsc(): Promise<void> {
  return new Promise((r) => {
    pendingEsc = r;
  });
}

async function runScenario(name: string, d: Delivered): Promise<void> {
  const c = d.content;
  switch (name) {
    case "hang":
      S.working = "✶ Simmering… (thinking)";
      render();
      await new Promise(() => {});
      return;
    case "tool":
    case "tool_slow":
    case "tool_slow_numbered": {
      const id = rec.toolUse("Bash", { command: "sleep 5", description: "Sleep for 5 seconds" });
      if (name === "tool_slow_numbered") S.full = screenLines("numbered-prose-bash-running");
      else showHistory("⏺ Sleeping for 5 seconds", "  ⎿  $ sleep 5");
      render();
      await sleep(name === "tool" ? 100 : gap("TOOL", 5000));
      S.full = null;
      rec.toolResult(id, "", {
        stdout: "",
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: true,
      });
      S.history.push("  Ran 1 shell command");
      return answerTurn(c);
    }
    case "linger":
      rec.text(answerFor(c));
      showHistory(`⏺ ${answerFor(c)}`);
      await sleep(gap("LINGER", Number(env.LINGER_MS) || 1500));
      rec.stopSummary();
      rec.td();
      showHistory(finishedRow());
      return;
    case "quiet":
      rec.text(answerFor(c));
      rec.stopSummary();
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      return;
    case "quiet_no_summary":
      rec.text(answerFor(c));
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      return;
    case "hookless_quiet":
      rec.text(answerFor(c));
      if (turn === 1) rec.td();
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      return;
    case "rewake":
      rec.text(answerFor(c));
      rec.stopSummary();
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      await sleep(gap("REWAKE", 2000));
      rec.text("LATE second message");
      rec.td();
      showHistory("⏺ LATE second message", finishedRow());
      return;
    case "slow_stop_hook":
      rec.text(answerFor(c));
      showHistory(`⏺ ${answerFor(c)}`);
      await sleep(gap("HOOK", 3000));
      rec.stopSummary();
      rec.td();
      showHistory(finishedRow());
      return;
    case "bg_rewake":
      return bgRewake(c);
    case "bg_server":
      return bgServer(c);
    case "ask_user":
    case "ask_user_send":
    case "interrupt_td":
      return askUser(name, c);
    case "permission":
      return permission(c);
    case "narrate_then_read":
      rec.text("VERDICT: ok");
      rec.td();
      showHistory("⏺ VERDICT: ok", finishedRow());
      return;
    case "compaction":
      rec.text("before compaction");
      rec.slice([T.compactBoundary, T.compactSummary]);
      rec.text(answerFor(c));
      rec.td();
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      return;
    case "max_tokens":
      rec.slice(MAX_TOKENS_SLICE);
      rec.td();
      showHistory(
        "⏺ API Error: Claude's response exceeded the output token maximum.",
        finishedRow()
      );
      return;
    case "refusal":
      rec.slice(REFUSAL_SLICE);
      rec.text(answerFor(c));
      rec.td();
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      return;
    case "null_stop":
      rec.text(answerFor(c), null);
      rec.td();
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      return;
    case "api_error":
      rec.apiError("Please run /login · API Error: 401 OAuth access token is invalid.");
      rec.td();
      showHistory(
        "⏺ Please run /login · API Error: 401 OAuth access token is invalid.",
        finishedRow()
      );
      return;
    case "exit_mid_turn":
      await sleep(300);
      return quit(3);
    case "exit_after_settle":
    case "interactive_exit_after_settle":
      rec.text(answerFor(c));
      rec.td();
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      await sleep(20);
      return quit(0);
    case "exit_before_td":
      rec.text(answerFor(c));
      showHistory(`⏺ ${answerFor(c)}`);
      await sleep(20);
      return quit(0);
    case "turn2_exit0":
      if (turn >= 2) {
        await sleep(200);
        return quit(0);
      }
      return answerTurn(c);
    default:
      return answerTurn(c);
  }
}

async function bgRewake(c: string): Promise<void> {
  const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const oldId = String(T.agentResult.toolUseResult.agentId);
  const id = rec.toolUse(
    "Agent",
    { description: "fruit", prompt: "Reply OK", subagent_type: "general-purpose" },
    { template: T.agentUse }
  );
  rec.toolResult(
    id,
    T.agentResult.message.content[0].content,
    { ...T.agentResult.toolUseResult, agentId },
    { template: T.agentResult }
  );
  rec.text("LAUNCHED");
  rec.td(1);
  showHistory("⏺ LAUNCHED", "✻ Waiting for 1 background agent to finish");
  await sleep(gap("BG", 1500));
  rec.notify(T.agentNotify, oldId, agentId);
  rec.text(answerFor(c));
  rec.td();
  showHistory(`⏺ Agent "fruit" finished · 1s`, `⏺ ${answerFor(c)}`, finishedRow());
}

async function bgServer(c: string): Promise<void> {
  const id = rec.toolUse(
    "Bash",
    {
      command: "fake-dev-server --port 0",
      description: "Background server",
      run_in_background: true,
    },
    { template: T.bgBashUse }
  );
  rec.toolResult(
    id,
    T.bgBashResult.message.content[0].content,
    { ...T.bgBashResult.toolUseResult, backgroundTaskId: `b${process.pid}` },
    { template: T.bgBashResult }
  );
  // a real process in the pane group, so the reap can be seen ending "the shell"
  spawn("sleep", ["300"], { stdio: "ignore" }).unref();
  return answerTurn(c);
}

async function askUser(name: string, _c: string): Promise<void> {
  const id = rec.toolUse("AskUserQuestion", T.askUse.message.content[0].input, {
    template: T.askUse,
  });
  S.full = screenLines("ask-user-question");
  render();
  await waitEsc();
  S.full = null;
  rec.toolResult(id, T.rejectResult.message.content[0].content, "User rejected tool use", {
    isError: true,
    template: T.rejectResult,
  });
  rec.interrupt(true);
  if (name === "interrupt_td") rec.td();
  showHistory(
    "⏺ User declined to answer questions",
    "  ⎿  Interrupted · What should Claude do instead?"
  );
}

async function permission(_c: string): Promise<void> {
  const id = rec.toolUse(
    "Write",
    { file_path: join(cwd, "hello.txt"), content: "hi" },
    { template: T.writeUse }
  );
  S.full = screenLines("permission-write");
  render();
  await waitEsc();
  S.full = null;
  rec.toolResult(id, T.rejectResult.message.content[0].content, "User rejected tool use", {
    isError: true,
    template: T.rejectResult,
  });
  rec.interrupt(true);
  rec.td();
  showHistory("  ⎿  User rejected write to hello.txt");
}

async function screenOnlyTurn(line: string): Promise<void> {
  // degraded scenarios: no transcript evidence at all; the screen is the only witness
  S.history.push(`❯ ${line}`);
  if (scenario === "no_transcript") S.history.push("  ⎿  Transcript saving is off");
  if (scenario !== "screen_fast") {
    S.working = "✶ Simmering… (1s)";
    render();
    await sleep(gap("SCREEN", 600));
  }
  S.working = null;
  if (scenario === "screen_api_error")
    showHistory(
      "⏺ Please run /login · API Error: 401 OAuth access token is invalid.",
      finishedRow()
    );
  else showHistory(`⏺ ${answerFor(line)}`, finishedRow());
}

/** Local commands the fake runs the way 2.1.291 does: their own records, no model turn. */
const LOCAL_COMMANDS = new Set(["compact", "model", "color"]);

async function localCommandTurn(name: string, args: string): Promise<void> {
  S.history.push(`❯ /${name}${args ? ` ${args}` : ""}`);
  let stdout = `Set model to \`${args}\``;
  if (name === "compact") {
    // file order as captured: the typed line, the boundary and summary, then the
    // command's caveat / <command-name> / <local-command-stdout>
    rec.slice([L.compactTyped]);
    S.working = "✶ Compacting conversation…";
    render();
    await sleep(gap("COMPACT", 300));
    rec.slice([L.compactBoundary, L.compactSummary]);
    stdout = "\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m";
  }
  S.working = null;
  if (name === "color") stdout = `Session color set to: ${args}`;
  rec.localCommand(name, args, stdout, name === "color" ? "system" : "user");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ANSI the stdout carries
  showHistory(`  ⎿  ${stdout.replace(/\x1b\[[0-9;]*m/g, "")}`);
}

async function submit(line: string): Promise<void> {
  turn++;
  busy = true;
  try {
    if (
      [
        "no_transcript",
        "empty_transcript",
        "missing_no_warning",
        "screen_fast",
        "screen_api_error",
      ].includes(scenario)
    )
      return await screenOnlyTurn(line);
    if (scenario === "slow_prompt_hook") {
      S.history.push(`❯ ${line}`);
      S.working = "✶ Blanching… (running UserPromptSubmit hook · 2s)";
      render();
      await sleep(gap("PROMPT_HOOK", 12_000));
      S.working = null;
      rec.user(line);
    } else {
      if (scenario !== "immediate_write") await sleep(gap("WITNESS", 50));
      const slash = line.match(/^\/([A-Za-z0-9][A-Za-z0-9:_-]*)\s*(.*)$/);
      if (slash && LOCAL_COMMANDS.has(slash[1] as string))
        return await localCommandTurn(slash[1] as string, slash[2] ?? "");
      if (slash) rec.command(slash[1] as string, slash[2] ?? "");
      else rec.user(line);
      S.history.push(`❯ ${line.split("\n")[0]}`);
    }
    S.working = "✶ Simmering… (thinking)";
    render();
    await sleep(gap("THINK", 50));
    const d = deliveredOf(line);
    S.working = null;
    await runScenario(effectiveScenario(d.content), d);
  } finally {
    S.working = null;
    busy = false;
    render();
  }
}

/* ───────────────────────────── keys ───────────────────────────── */

function onEnter(): void {
  const text = S.box;
  if (!text.trim()) return;
  if (scenario === "menu_eats_enter" && !menuEaten) {
    menuEaten = true; // the first Enter only closes a menu (phase-2 keylog: Esc/Enter on menus)
    S.menu = null;
    render();
    return;
  }
  if (scenario === "ignore_input") return;
  if (scenario === "promptless_first_send_ignored" && !firstSubmitIgnored) {
    firstSubmitIgnored = true;
    S.box = "";
    render();
    return;
  }
  S.box = "";
  S.menu = null;
  render();
  const t = text.trim();
  if (t === "/exit" || t === "/quit") return void exitCommand(t.slice(1));
  if (t === "/cost") {
    S.full = screenLines("usage-panel");
    swallowUntilEsc = true;
    render();
    return;
  }
  if (busy) return; // a real REPL would queue it; the server never types while a turn runs
  void submit(text);
}

function onEsc(): void {
  if (swallowUntilEsc) {
    swallowUntilEsc = false;
    S.full = null;
    render();
    return;
  }
  if (S.menu) {
    S.menu = null;
    render();
    return;
  }
  if (pendingEsc) {
    const r = pendingEsc;
    pendingEsc = null;
    r();
  }
}

function updateMenu(): void {
  const b = S.box;
  if (/^\/\S*$/.test(b))
    S.menu = `  ❯ ${b.length > 1 ? b : "/add-dir"}                    Run a command`;
  else if (/(^|\s)@\S*$/.test(b)) S.menu = "    + notes.md";
  else S.menu = null;
}

/** One plain key (not an escape sequence). */
function onKey(ch: string): void {
  if (ch === "\x1b") {
    onEsc();
    return;
  }
  if (swallowUntilEsc) return;
  if (ch === "\r") {
    onEnter();
    return;
  }
  if (ch === "\n") S.box += "\n";
  else if (ch === "\x7f" || ch === "\b") S.box = S.box.slice(0, -1);
  else if (ch === "\x15") S.box = "";
  else if (ch >= " ") S.box += ch;
  updateMenu();
}

/** Consume a bracketed paste or a CSI/SS3 sequence at the head of `s`; null when none. */
function consumeSequence(s: string): string | null {
  if (s.startsWith("\x1b[200~")) {
    const end = s.indexOf("\x1b[201~");
    if (!swallowUntilEsc) S.box += end >= 0 ? s.slice(6, end) : s.slice(6);
    return end >= 0 ? s.slice(end + 6) : "";
  }
  if (s.startsWith("\x1b[") || s.startsWith("\x1bO")) {
    const m = s.slice(2).search(/[@-~]/);
    return m >= 0 ? s.slice(m + 3) : "";
  }
  return null;
}

function onData(buf: Buffer): void {
  let s = buf.toString("utf8");
  while (s.length) {
    const rest = consumeSequence(s);
    if (rest !== null) {
      s = rest;
      continue;
    }
    onKey(s[0] as string);
    s = s.slice(1);
  }
  render();
}

/* ───────────────────────────── lifecycle ───────────────────────────── */

function restore(): void {
  try {
    process.stdout.write("\x1b[?2004l\x1b[?1049l");
  } catch {
    // pty gone
  }
}

/**
 * `/exit`: Claude Code 2.1.282–2.1.285 write the command's records (the caveat,
 * `<command-name>/exit`, `<local-command-stdout>(no content)`; real 2.1.285 records in
 * `corpus-redacted/exit-command.jsonl`) and exit a moment later; 2.1.291 writes none
 * (`FAKE_EXIT_RECORDS=none`).
 */
async function exitCommand(name: string): Promise<void> {
  if (env.FAKE_EXIT_RECORDS !== "none") {
    rec.localCommand(name, "", "(no content)");
    showHistory(`❯ /${name}`, "  ⎿  (no content)");
    await sleep(gap("EXIT", 600));
  }
  return quit(0);
}

async function quit(code: number): Promise<void> {
  restore();
  await sleep(30);
  process.exit(code);
}

function markSignal(sig: string): void {
  const m = env.CONTRACT_FAKE_SIGTERM_MARKER;
  if (m) {
    try {
      appendFileSync(m, `${sig}\n`);
    } catch {
      // ignore
    }
  }
}

function installSignals(): void {
  const ignoreTerm = scenario === "ignore_term";
  const ignoreHup = scenario === "ignore_hup" || ignoreTerm;
  process.on("SIGTERM", () => {
    markSignal("SIGTERM");
    if (!ignoreTerm) process.exit(143);
  });
  process.on("SIGHUP", () => {
    markSignal("SIGHUP");
    if (!ignoreHup) process.exit(129);
  });
}

function dumpClaudeMode(): void {
  const out = env.FAKE_CLAUDE_DUMP;
  if (!out) return;
  const settingsArg = flag("--settings");
  let settings: unknown = null;
  if (settingsArg) {
    try {
      settings = JSON.parse(
        settingsArg.trim().startsWith("{") ? settingsArg : readFileSync(settingsArg, "utf8")
      );
    } catch {
      settings = settingsArg;
    }
  }
  writeFileSync(out, JSON.stringify({ argv, env: { ...env }, cwd, settings }, null, 1));
}

async function boot(): Promise<void> {
  if (asClaude) dumpClaudeMode();
  // `{session}` in the path is replaced by this child's --session-id, so several slots of
  // one run can each leave a probe.
  if (env.FAKE_PROBE_FILE && scenario === "env_probe")
    writeFileSync(
      env.FAKE_PROBE_FILE.replace("{session}", sessionId),
      JSON.stringify({ env: { ...env }, cwd, argv }, null, 1)
    );
  if (agent?.startsWith("zzz")) {
    process.stdout.write(
      `--agent '${agent}' not found. Available agents: claude, claude-code-guide, Explore, general-purpose, Plan, statusline-setup\r\n`
    );
    await sleep(50);
    process.exit(1);
  }
  installSignals();
  setTimeout(() => void quit(0), Number(env.CONTRACT_FAKE_MAX_MS) || 20_000).unref?.();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", onData);
  if (scenario === "orphan_grandchild") {
    spawn("sleep", ["300"], { stdio: "ignore" }).unref();
    setTimeout(() => process.exit(0), gap("ORPHAN", 3000));
  }
  if (scenario.startsWith("dialog_")) {
    const name =
      scenario === "dialog_unknown" ? "dialog-unnamed-mcp-server" : `dialog-${scenario.slice(7)}`;
    S.full = screenLines(name);
    render();
    return;
  }
  if (scenario === "slow_boot") {
    process.stdout.write("\x1b[H\x1b[2Jbooting the fake child…");
    await sleep(gap("BOOT", 3000));
  }
  if (scenario === "empty_transcript") {
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, "");
  }
  process.stdout.write("\x1b[?1049h\x1b[?2004h");
  S.booted = true;
  S.ghost = scenario === "idle_suggestion";
  render();
  if (scenario === "status_tick")
    setInterval(() => {
      S.statusTick++;
      render();
    }, 1000);
}

void boot();
