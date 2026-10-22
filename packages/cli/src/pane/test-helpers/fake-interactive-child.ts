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
 *   - proxied "claude" mode (`FAKE_CLAUDE_PROXY=1`, hook-system §11.2): each delivered
 *     prompt is POSTed as a streaming `/v1/messages` to `ANTHROPIC_BASE_URL` (the real
 *     child claudish's proxy) with `metadata.user_id` carrying the `--session-id`; the
 *     SSE that comes back is folded, and the RECEIVED text is written as the assistant
 *     record, then `turn_duration`. Whatever the proxy did, rewriting included, is in
 *     the transcript. `FAKE_CLAUDE_SIDE=<text>` also fires one side request on turn 1
 *     that is NOT awaited (a background subagent's stream) before the turn ends.
 *
 * A file-delivered prompt (the fixed template) is read back exactly as Read returns it
 * (numbered lines, `toolUseResult.file`), reconstructed (split markers joined), and
 * answered `ANSWER <model> <sha1(reconstructed)[0..8]>`, so a test can compare the hash
 * with sha1 of the caller's prompt and see any loss. A typed line hashes the line.
 *
 * Scripted mode (`--model fake-scripted`, hook-system §11.5): `FAKE_SCRIPT` is a JSON array
 * with one entry per submitted turn (see `TurnScript`), so a test fixes each turn's answer,
 * a partial answer that never ends, a dialog, a missing witness, an unread task file, a
 * re-wake after the answer, or an exit. `FAKE_KEYLOG` names a file that receives every
 * submitted line and every Esc, so a test can prove what was (never) typed.
 * `FAKE_INITIAL_PROMPT` is a prompt given on the command line: its user record is written
 * before the REPL is first drawn (scripted mode).
 *
 * Gaps come from `FAKE_GAP_MS_<NAME>` so scenarios keep their ORDER at a fraction of real
 * time. `CONTRACT_FAKE_MAX_MS` (default 20 s) is a safety exit so a broken test never
 * leaves a REPL behind. `CONTRACT_FAKE_SIGTERM_MARKER` is written on SIGTERM or SIGHUP.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { projectDirNameFor } from "../../mcp-session/home-dir.js";
import { wrapPrompt } from "./repl-wrap.js";

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
let COLS = Number(env.COLUMNS) || 160;
let ROWS = Number(env.LINES) || 50;
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
/** The value `exit_secret` prints; a redaction test greps every record for it. */
const SECRET_ON_SCREEN = "redaction-probe-not-a-real-credential";

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

/** Background-Bash rewake records copied from cibashfix1, transcript
 * 9e55054b-7c70-4730-b450-0778cfe546cc.jsonl, lines 33, 34 and 36.
 * Embedded here so this fake does not depend on gitignored session artifacts.
 */
const BG_BASH_REWAKE = {
  notify: {
    parentUuid: "aea1dacf-329d-477e-a01e-c30a0f470f66",
    isSidechain: false,
    promptId: "23543b14-c4e2-4edb-9556-38acaab5fd15",
    type: "user",
    message: {
      role: "user",
      content:
        '<task-notification>\n<task-id>bqbb17qlh</task-id>\n<tool-use-id>call_1791895264997</tool-use-id>\n<output-file>/fake/tasks/bqbb17qlh.output</output-file>\n<status>completed</status>\n<summary>Background command "bg sleep" completed (exit code 0)</summary>\n</task-notification>',
    },
    uuid: "1404bc3e-6333-4ade-b38d-a5344c216e08",
    timestamp: "2026-10-13T12:41:21.522Z",
    permissionMode: "bypassPermissions",
    origin: {
      kind: "task-notification",
      producer: "session-task",
      runId: "0mv6o6cgv-3c792776",
    },
    promptSource: "system",
    turnOrigin: "task_notification",
    turnPosition: {
      promptIndex: 1,
      turnIndex: 2,
    },
    queueSkipAttachments: true,
    userType: "external",
    entrypoint: "cli",
    cwd: "/fake/work",
    sessionId: "9e55054b-7c70-4730-b450-0778cfe546cc",
    version: "2.1.296",
    gitBranch: "fake-branch",
  },
  text: {
    parentUuid: "1404bc3e-6333-4ade-b38d-a5344c216e08",
    isSidechain: false,
    message: {
      id: "msg_1791895281539_a7o8nmutgri",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "FINAL-ANSWER-AFTER-BG: background work reported done.",
        },
      ],
      model: "fake-model",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
        output_tokens_details: {
          thinking_tokens: 0,
        },
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
        service_tier: "standard",
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: "",
        iterations: [],
        speed: "standard",
        fallback_credit: null,
      },
      stop_details: null,
    },
    apiBlockIndex: 0,
    requestedModel: "vllm@fake-model",
    type: "assistant",
    uuid: "0e35a338-d91e-49b0-bbe7-2f44777673f0",
    timestamp: "2026-10-13T12:41:21.543Z",
    effort: "xhigh",
    perTurnEffort: null,
    session_id: "9e55054b-7c70-4730-b450-0778cfe546cc",
    userType: "external",
    entrypoint: "cli",
    cwd: "/fake/work",
    sessionId: "9e55054b-7c70-4730-b450-0778cfe546cc",
    version: "2.1.296",
    gitBranch: "fake-branch",
  },
  td: {
    parentUuid: "d5c27bc6-9056-4322-b158-2c16a93d5408",
    isSidechain: false,
    type: "system",
    subtype: "turn_duration",
    durationMs: 38,
    messageCount: 21,
    timestamp: "2026-10-13T12:41:21.556Z",
    uuid: "3df0ad6a-f00f-488d-8b8b-b02672b298a7",
    isMeta: false,
    userType: "external",
    entrypoint: "cli",
    cwd: "/fake/work",
    sessionId: "9e55054b-7c70-4730-b450-0778cfe546cc",
    version: "2.1.296",
    gitBranch: "fake-branch",
  },
};

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
  "never_submit_transcript_off",
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
const STATUS = [
  "  cwd • fake • $0.000 • N/A",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
];
const PLACEHOLDER = 'Try "how does <filepath> work?"'; // repl-boot-placeholder, attr 2 (faint)

const S = {
  booted: false,
  box: "",
  drawnBox: "", // F4: bytes reach the editor before its next render
  history: [] as string[],
  working: null as string | null,
  full: null as string[] | null, // a whole fixture screen (dialogs, panels)
  menu: null as string | null,
  statusTick: 0,
  ghost: false,
  vim: false,
};

function fit(l: string): string {
  return Array.from(l).slice(0, COLS).join("");
}

function render(): void {
  let out = "\x1b[H\x1b[2J";
  const rows = S.full ? S.full.slice(0, ROWS) : replRows();
  let cursorRow = 0;
  rows.forEach((l, y) => {
    if (!l) return;
    // Claude Code walks down relatively; CUP here would hide stale scroll-region bugs.
    if (y > cursorRow) out += `\r\x1b[${y - cursorRow}B`;
    cursorRow = y;
    if (l.startsWith("\u0000ghost")) out += `❯ \x1b[2m${PLACEHOLDER}\x1b[22m`;
    else out += fit(l);
  });
  const lastBoxLine = wrapPrompt(S.drawnBox, COLS).at(-1) ?? "❯ ";
  const selected = S.full?.findIndex((line) => /^❯ /.test(line));
  const boxRow = S.full
    ? selected !== undefined && selected >= 0
      ? selected
      : ROWS - 1
    : ROWS - 4;
  const cursorCol = S.full ? 2 : Math.min(COLS - 1, Bun.stringWidth(lastBoxLine));
  out += `\x1b[${boxRow + 1};${cursorCol + 1}H`;
  process.stdout.write(out);
}

function replRows(): string[] {
  const RULE = "─".repeat(COLS);
  const out: string[] = Array.from({ length: ROWS }, () => "");
  const boxLines = wrapPrompt(S.drawnBox, COLS).slice(-(ROWS - 9));
  const top = ROWS - 4 - boxLines.length;
  BANNER.forEach((l, i) => {
    out[i] = i === 3 ? `${l.slice(0, 11)}${cwd}` : l;
  });
  out[top] = RULE;
  boxLines.forEach((l, i) => {
    out[top + 1 + i] = l;
  });
  if (!S.drawnBox && S.ghost) out[top + 1] = "\u0000ghost";
  out[ROWS - 3] = RULE;
  out[ROWS - 2] = S.statusTick ? `${STATUS[0]} · ${S.statusTick}` : (STATUS[0] as string);
  out[ROWS - 1] = S.vim ? "-- INSERT --" : (STATUS[1] as string);
  const above = S.history.flatMap((line) =>
    line.startsWith("❯ ") ? wrapPrompt(line.slice(2), COLS, true) : [line]
  );
  if (S.working) above.push(S.working);
  if (S.menu) above.push("", S.menu);
  const room = top - 4;
  const shown = above.slice(-room);
  shown.forEach((l, i) => {
    out[4 + i] = l;
  });
  return out;
}

const renderLagMs = Math.max(0, Number(env.FAKE_RENDER_LAG_MS) || 0);
let inputRender: ReturnType<typeof setTimeout> | null = null;
let selfSubmit: ReturnType<typeof setTimeout> | null = null;
let externalSubmitDone = false;

function drawInput(): void {
  if (inputRender) clearTimeout(inputRender);
  inputRender = null;
  const selfSubmitting = scenario.startsWith("self_submit") && S.box && !externalSubmitDone;
  const historyWithheld = scenario === "self_submit_history_withheld";
  // F14a must submit before the first verify read at 150 ms; never draw the exact text.
  // F14b needs a non-exact prefix visible to verify before the box empties, with no history.
  S.drawnBox = selfSubmitting ? (historyWithheld ? S.box.slice(0, -1) : "") : S.box;
  render();
  if (selfSubmitting) {
    if (selfSubmit) clearTimeout(selfSubmit);
    selfSubmit = setTimeout(
      () => {
        externalSubmitDone = true;
        acceptText(S.box);
      },
      historyWithheld ? 300 : 75
    );
  }
  if (
    scenario === "command_left_box" &&
    !env.FAKE_COMMAND_LEFT_BOX_FILE &&
    S.box.startsWith("/model ") &&
    !externalSubmitDone
  ) {
    if (selfSubmit) clearTimeout(selfSubmit);
    selfSubmit = setTimeout(() => {
      externalSubmitDone = true;
      acceptText(S.box);
    }, 1800);
  }
}

function renderInput(): void {
  if (!renderLagMs) drawInput();
  else if (!inputRender) inputRender = setTimeout(drawInput, renderLagMs);
}

function showHistory(...rows: string[]): void {
  S.history.push(...rows);
  render();
}

function finishedRow(): string {
  return "✻ Cogitated for 1s";
}

/* ───────────────────────────── scripted turns ───────────────────────────── */

/** One turn of `FAKE_SCRIPT` (scenario `scripted`). Every field is optional. */
interface TurnScript {
  /** the exact answer text (default: `ANSWER <model> <sha8>`) */
  say?: string;
  /** stream this text with no ending stop_reason and no end record, then hang */
  partial?: string;
  /** write this text (if non-empty), then open an AskUserQuestion and wait for Esc */
  ask?: string;
  /**
   * the turn is never accepted: no user record and no echo in the conversation, so neither
   * claudish's witness nor magmux's input gate (whose `history` evidence is that echo) has
   * evidence it was submitted
   */
  noWitness?: boolean;
  /** exit with this code as soon as the line is submitted (before any witness) */
  exitOnSubmit?: number;
  /** a file-delivered prompt is not read at all */
  noRead?: boolean;
  /** the turn ends with this API error record instead of an answer */
  apiError?: string;
  /** wait this long before the answer */
  delayMs?: number;
  /**
   * after the answer and its end record: a background notification, then a continuation.
   * `workingMs`: the working row shows this long BEFORE any record of the re-wake is
   * written (the screen leads the transcript). `quietMs`: the re-wake's records are
   * written and the screen is not redrawn for this long, so a reader sees them only by
   * polling the transcript. `gateFile`: the re-wake waits for this file to exist before
   * its `delayMs`, so a test starts it at a point it chose (a hold it observed).
   * `clearWithRecords` (with `workingMs`): the cleared row is drawn in the same instant
   * the records are written, so the frame that shows an idle screen is the first sign of
   * the re-wake, and only a transcript read made after it sees the records.
   */
  rewake?: {
    delayMs: number;
    say: string;
    workingMs?: number;
    quietMs?: number;
    gateFile?: string;
    clearWithRecords?: boolean;
  };
  /** after the answer: exit with this code, `exitDelayMs` (default 20) later */
  exitAfter?: number;
  exitDelayMs?: number;
}

const SCRIPT: TurnScript[] = (() => {
  try {
    const v = JSON.parse(env.FAKE_SCRIPT ?? "[]");
    return Array.isArray(v) ? (v as TurnScript[]) : [];
  } catch {
    return [];
  }
})();

function scriptOf(n: number): TurnScript {
  return SCRIPT[n - 1] ?? {};
}

/** Every submitted line and every Esc, one per line, for "never typed" assertions. */
function keylog(entry: string): void {
  const f = env.FAKE_KEYLOG;
  if (!f) return;
  try {
    appendFileSync(f, `${entry}\n`);
  } catch {
    // diagnostics only
  }
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
  if (scenario === "scripted" && scriptOf(turn).noRead) return { content: "", file };
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
const FIRST_TURN_ONLY = new Set([
  "ask_user",
  "ask_user_send",
  "interrupt_td",
  "permission",
  "td_withheld",
]);

function effectiveScenario(content: string): string {
  if (scenario === "marker") return markerScenario(content);
  if (turn > 1 && FIRST_TURN_ONLY.has(scenario)) return "answer";
  return scenario;
}

/* ───────────────────────────── proxied "claude" mode ───────────────────────────── */

const PROXIED = asClaude && env.FAKE_CLAUDE_PROXY === "1";

/** One streaming /v1/messages to the child claudish's proxy; the folded text of the reply. */
async function proxiedAnswer(content: string): Promise<string> {
  const base = (env.ANTHROPIC_BASE_URL ?? "").replace(/\/$/, "");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY ?? "placeholder",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content }],
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    }),
  });
  const raw = await res.text();
  if (!res.ok) return `PROXY ERROR ${res.status}: ${raw.slice(0, 200)}`;
  let text = "";
  for (const event of raw.split(/\r?\n\r?\n/)) {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const d = JSON.parse(line.slice(5).trim()) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (d.type === "content_block_delta" && d.delta?.type === "text_delta")
          text += d.delta.text ?? "";
      } catch {
        // [DONE] or a keepalive
      }
    }
  }
  return text;
}

let sideFired = false;

async function answerTurn(content: string): Promise<void> {
  if (PROXIED) {
    if (env.FAKE_CLAUDE_SIDE && !sideFired) {
      sideFired = true;
      void proxiedAnswer(env.FAKE_CLAUDE_SIDE).catch(() => "");
    }
    const text = await proxiedAnswer(content).catch((e) => `PROXY FAILED ${String(e)}`);
    rec.text(text);
    rec.td();
    showHistory(`⏺ ${text}`, finishedRow());
    return;
  }
  rec.text(answerFor(content));
  rec.td();
  showHistory(`⏺ ${answerFor(content)}`, finishedRow());
}

function waitEsc(): Promise<void> {
  return new Promise((r) => {
    pendingEsc = r;
  });
}

/** A settled turn woken by a background notification, then continued (`TurnScript.rewake`). */
async function rewakeAfter(rw: NonNullable<TurnScript["rewake"]>): Promise<void> {
  if (rw.gateFile) while (!existsSync(rw.gateFile)) await sleep(20);
  await sleep(rw.delayMs);
  if (rw.workingMs) {
    S.working = "✶ Simmering… (thinking)";
    render();
    await sleep(rw.workingMs);
    S.working = null;
  }
  emit(T.bgNotify);
  rec.text(rw.say);
  rec.td();
  if (rw.clearWithRecords) render();
  if (rw.quietMs) await sleep(rw.quietMs);
  showHistory(`⏺ ${rw.say}`, finishedRow());
}

/** One scripted turn (`FAKE_SCRIPT`): the transcript and screen of a real REPL turn. */
async function runScripted(sc: TurnScript, d: Delivered): Promise<void> {
  const c = d.content;
  if (sc.delayMs) await sleep(sc.delayMs);
  if (sc.partial !== undefined) {
    rec.text(sc.partial, null);
    S.history.push(`⏺ ${sc.partial}`);
    S.working = "✶ Simmering… (thinking)";
    render();
    await new Promise(() => {});
    return;
  }
  if (sc.ask !== undefined) {
    if (sc.ask) {
      rec.text(sc.ask, "tool_use");
      S.history.push(`⏺ ${sc.ask}`);
    }
    return askUser("ask_user", c);
  }
  if (sc.apiError !== undefined) {
    rec.apiError(sc.apiError);
    rec.td();
    showHistory(`⏺ ${sc.apiError}`, finishedRow());
    return;
  }
  const text = sc.say ?? answerFor(c);
  rec.text(text);
  rec.td();
  showHistory(`⏺ ${text}`, finishedRow());
  if (sc.rewake) await rewakeAfter(sc.rewake);
  if (sc.exitAfter !== undefined) {
    await sleep(sc.exitDelayMs ?? 20);
    return quit(sc.exitAfter);
  }
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
    case "settle_box_text":
      await answerTurn(c);
      S.box = "Unsent text after the end record";
      drawInput();
      return;
    case "td_withheld":
      // the answer, but no turn_duration: the test appends it itself, at the moment it chooses
      rec.text(answerFor(c));
      showHistory(`⏺ ${answerFor(c)}`, finishedRow());
      return;
    case "finishing_then_wake":
      // an ending answer with no end-of-turn record (finishing, static screen), then a
      // background task notification wakes the model and the turn ends normally
      rec.text("first part");
      showHistory("⏺ first part");
      await sleep(gap("WAKE", 2500));
      emit(T.bgNotify);
      {
        const id = rec.toolUse("Bash", { command: "sleep 2", description: "Sleep" });
        showHistory("⏺ Sleeping", "  ⎿  $ sleep 2");
        await sleep(gap("WAKE_TOOL", 2000));
        rec.toolResult(id, "", { stdout: "", stderr: "", interrupted: false, isImage: false });
      }
      return answerTurn(c);
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
    case "bg_bash_rewake":
      return bgBashRewake(c);
    case "bg_rewake":
      return bgRewake(c);
    case "bg_server":
      return bgServer(c);
    case "bg_detached":
      return bgDetached(c);
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
    case "exit_secret":
      // a credential the child itself echoed is on screen when it dies mid-turn
      showHistory("⏺ Bash(env | grep TOKEN)", `  ⎿  MY_SERVICE_TOKEN=${SECRET_ON_SCREEN}`);
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

async function bgBashRewake(c: string): Promise<void> {
  const id = rec.toolUse(
    "Bash",
    { command: "sleep 1", description: "bg sleep", run_in_background: true },
    { template: T.bgBashUse }
  );
  rec.toolResult(
    id,
    T.bgBashResult.message.content[0].content,
    { ...T.bgBashResult.toolUseResult, backgroundTaskId: "bqbb17qlh" },
    { template: T.bgBashResult }
  );
  await answerTurn(c);
  // D23 settles despite the background Bash. Leave time for the first settle.
  await sleep(1500);
  emit(BG_BASH_REWAKE.notify, (r) => {
    r.promptId = randomUUID();
    r.message.content = r.message.content.replace("call_1791895264997", id);
  });
  const answer = `REWAKE ${createHash("sha1").update(c).digest("hex").slice(0, 8)}`;
  emit(BG_BASH_REWAKE.text, (r) => {
    r.message.id = newMsgId();
    r.message.content[0].text = answer;
  });
  emit(BG_BASH_REWAKE.td);
  showHistory(`⏺ ${answer}`, finishedRow());
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
  spawn("sleep", ["300"], { env: { ...process.env }, stdio: "ignore" }).unref();
  return answerTurn(c);
}

/**
 * A background shell in a process group of its OWN, as Claude Code 2.1.291 runs a
 * `run_in_background` Bash (measured: pgid = the shell's pid). Unlike real Claude Code
 * the fake never ends it on exit, so only claudish's reap can.
 */
async function bgDetached(c: string): Promise<void> {
  const child = spawn("sleep", ["300"], {
    env: { ...process.env },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  if (env.FAKE_BG_PID_FILE && child.pid) writeFileSync(env.FAKE_BG_PID_FILE, String(child.pid));
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

async function submit(line: string, opts: { argv?: boolean } = {}): Promise<void> {
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
    if (scenario === "scripted") {
      const sc = scriptOf(turn);
      if (sc.exitOnSubmit !== undefined) {
        await sleep(30);
        return await quit(sc.exitOnSubmit);
      }
      if (sc.noWitness) return;
      // A command-line prompt is written at once, before the REPL is drawn.
      if (!opts.argv) await sleep(gap("WITNESS", 50));
      rec.user(line);
      S.history.push(`❯ ${line.split("\n")[0]}`);
      S.working = "✶ Simmering… (thinking)";
      render();
      await sleep(gap("THINK", 50));
      const d = deliveredOf(line);
      S.working = null;
      return await runScripted(sc, d);
    }
    if (scenario === "slow_prompt_hook") {
      S.working = "✶ Blanching… (running UserPromptSubmit hook · 2s)";
      render();
      await sleep(gap("PROMPT_HOOK", 12_000));
      S.working = null;
      rec.user(line);
    } else {
      if (scenario !== "immediate_write")
        await sleep(
          gap(
            "WITNESS",
            ["self_submit_history_withheld", "command_left_box"].includes(scenario) ? 5000 : 50
          )
        );
      const slash = line.match(/^\/([A-Za-z0-9][A-Za-z0-9:_-]*)\s*(.*)$/);
      if (slash && LOCAL_COMMANDS.has(slash[1] as string))
        return await localCommandTurn(slash[1] as string, slash[2] ?? "");
      if (slash) rec.command(slash[1] as string, slash[2] ?? "");
      else rec.user(line);
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

let ignoredEnters = 0;
const ignoredEnterLimit =
  scenario === "enter_ignored_forever"
    ? Number.POSITIVE_INFINITY
    : Number(scenario.match(/^enter_ignored_(\d+)$/)?.[1]) || 0;

function onEnter(): void {
  const text = S.box;
  if (!text.trim() || S.vim) return;
  if (ignoredEnters++ < ignoredEnterLimit || scenario === "never_submit_transcript_off") return;
  // only a line Enter submits is logged: an ignored Enter submitted nothing
  keylog(text);
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
    drawInput();
    return;
  }
  acceptText(text);
}

/** F9 counts accepted submissions, not Enter attempts or transient box contents. */
function acceptText(text: string): void {
  if (!text.trim() || (busy && !/^\/(exit|quit)$/.test(text.trim()))) return;
  if (env.FAKE_SUBMIT_LOG)
    appendFileSync(env.FAKE_SUBMIT_LOG, `${JSON.stringify({ text, at: Date.now() })}\n`);
  S.box = "";
  S.menu = null;
  if (!["history_withheld", "self_submit_history_withheld", "command_left_box"].includes(scenario))
    S.history.push(`❯ ${text}`);
  drawInput(); // history and empty box are one render, as in the real REPL
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
  keylog("<ESC>");
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

let firstBurstDropped = false;
let dropUntil = 0;

/** F6/F13 lose a whole typing burst, not just its first character. */
function dropTyping(ch: string): boolean {
  if (Date.now() < dropUntil) {
    dropUntil = Date.now() + 700;
    return true;
  }
  if (
    !firstBurstDropped &&
    ch >= " " &&
    ["late_reset_swallow", "drop_first_prompt"].includes(scenario)
  ) {
    firstBurstDropped = true;
    dropUntil = Date.now() + 700;
    if (scenario === "late_reset_swallow" && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      // A swallowed burst must not become kernel-echoed box text while cooked.
      spawnSync("stty", ["-echo"], {
        env: { ...process.env },
        stdio: ["inherit", "ignore", "ignore"],
      });
      setTimeout(() => process.stdin.setRawMode(true), 120);
    }
    return true;
  }
  return false;
}

/** One plain key (not an escape sequence). */
function onKey(ch: string): void {
  if (dropTyping(ch)) return;
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
  renderInput();
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
    showHistory("  ⎿  (no content)");
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
  process.on("SIGWINCH", () => {
    try {
      // Bun's stdout dimensions can still be stale inside SIGWINCH; query the pty.
      const size = spawnSync("stty", ["size"], {
        env: { ...process.env },
        stdio: ["inherit", "pipe", "ignore"],
      });
      const match =
        size.status === 0
          ? size.stdout
              ?.toString()
              .trim()
              .match(/^(\d+)\s+(\d+)$/)
          : null;
      if (match) {
        const rows = Number(match[1]);
        const cols = Number(match[2]);
        if (Number.isSafeInteger(rows) && rows > 0 && Number.isSafeInteger(cols) && cols > 0) {
          ROWS = rows;
          COLS = cols;
        }
      }
    } catch {
      // Keep the current dimensions if the terminal size cannot be read.
    }
    render();
  });
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
    spawn("sleep", ["300"], { env: { ...process.env }, stdio: "ignore" }).unref();
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
  // `claude "<prompt>"`: Claude Code may write the prompt's record before the REPL
  // is drawn (hook-system §7.5: the interactive driver's first turn opens at offset 0).
  const initial = env.FAKE_INITIAL_PROMPT;
  if (initial) void submit(initial, { argv: true });
  process.stdout.write("\x1b[?1049h\x1b[?2004h");
  S.booted = true;
  S.ghost = scenario === "idle_suggestion";
  S.vim = scenario === "vim_insert" && !env.FAKE_VIM_FILE;
  if (scenario === "never_submit_transcript_off") S.history.push("  ⎿  Transcript saving is off");
  render();
  // F1: the first box precedes Claude Code's cooked → raw startup reset.
  if (scenario !== "no_boot_reset" && process.stdin.isTTY) {
    await sleep(100);
    process.stdin.setRawMode(false);
    await sleep(120);
    process.stdin.setRawMode(true);
  }
  if (env.FAKE_VIM_FILE)
    setInterval(() => {
      if (!S.vim && existsSync(env.FAKE_VIM_FILE as string)) {
        S.vim = true;
        render();
      }
    }, 20);
  if (scenario === "command_left_box" && env.FAKE_COMMAND_LEFT_BOX_FILE)
    setInterval(() => {
      if (externalSubmitDone || !S.box.startsWith("/model ")) return;
      if (env.FAKE_COMMAND_LEFT_BOX_FILE && !existsSync(env.FAKE_COMMAND_LEFT_BOX_FILE)) return;
      externalSubmitDone = true;
      acceptText(S.box);
    }, 20);
  if (scenario === "status_tick")
    setInterval(() => {
      S.statusTick++;
      render();
    }, 1000);
}

void boot();
