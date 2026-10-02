#!/usr/bin/env bun
// packages/cli/src/test-helpers/contract-fake-child.ts
/**
 * A stream-json stand-in for the claudish child, used by the *.contract.test.ts files through
 * CLAUDISH_BIN (sessions, team slots) or a TeamRunOptions.spawnChild seam. Written from the
 * public stream-json shape only; it never calls a model or the network.
 *
 * It emits `system:init` at start, then answers input. Behaviour is chosen by markers anywhere
 * in the input it receives, so one executable serves every test:
 *
 *   (no marker)   each stream-json `user` line gets one assistant message and one success result;
 *                 non-JSON input is answered once, at end of input
 *   @@TOOL@@      the answer runs one tool first: assistant tool_use, user tool_result, then text
 *   @@HANG@@      never answer and ignore end of input; live until signalled
 *   @@LINGER@@    after input ends, stay alive LINGER_MS before exiting 0 (holds `finishing` open)
 *   @@LATE@@      after input ends, emit assistant, user and tool_use frames, then exit 0
 *
 * Markers are also read from argv. Optional env: CONTRACT_FAKE_SIGTERM_MARKER, a file written
 * when SIGTERM arrives; CONTRACT_FAKE_HANG=1, behave as @@HANG@@ whatever the input.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const LINGER_MS = 1_500;
const LATE_GAP_MS = 150;
const SAFETY_MS = Number(process.env.CONTRACT_FAKE_MAX_MS ?? 20_000);

const argv = process.argv.slice(2);
const sidAt = argv.indexOf("--session-id");
const childSessionId = sidAt >= 0 && argv[sidAt + 1] ? argv[sidAt + 1] : randomUUID();

let hang = process.env.CONTRACT_FAKE_HANG === "1";
let linger = false;
let late = false;
let turns = 0;
let sawJsonTurn = false;
let pendingText = "";

process.stdout.on("error", () => process.exit(0));
process.on("SIGTERM", () => {
  const marker = process.env.CONTRACT_FAKE_SIGTERM_MARKER;
  if (marker) {
    try {
      writeFileSync(marker, String(process.pid));
    } catch {
      // the marker is evidence only
    }
  }
  process.exit(143);
});
// Never outlive a broken test by more than SAFETY_MS. Not unref'd: it also keeps @@HANG@@ alive.
setTimeout(() => process.exit(3), SAFETY_MS);

function emit(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function assistantText(id: string, text: string): unknown {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "contract-fake",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: childSessionId,
  };
}

function assistantToolUse(id: string, toolUseId: string): unknown {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "contract-fake",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Read",
          input: { file_path: "contract-fake.txt" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: childSessionId,
  };
}

function userToolResult(toolUseId: string): unknown {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
    session_id: childSessionId,
  };
}

function answer(withTool: boolean): void {
  turns += 1;
  if (withTool) {
    const toolUseId = `toolu_contractfake_${turns}`;
    emit(assistantToolUse(`msg_contractfake_${turns}_tool`, toolUseId));
    emit(userToolResult(toolUseId));
  }
  emit(assistantText(`msg_contractfake_${turns}`, `contract reply ${turns}`));
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: turns,
    result: `contract reply ${turns}`,
    session_id: childSessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function noteMarkers(text: string): void {
  if (text.includes("@@HANG@@")) hang = true;
  if (text.includes("@@LINGER@@")) linger = true;
  if (text.includes("@@LATE@@")) late = true;
}

function onLine(raw: string): void {
  const text = raw.trim();
  if (!text) return;
  noteMarkers(text);
  let isUserFrame = false;
  try {
    const frame = JSON.parse(text) as { type?: unknown };
    isUserFrame = Boolean(frame) && typeof frame === "object" && frame.type === "user";
  } catch {
    isUserFrame = false;
  }
  if (!isUserFrame) {
    pendingText += `${text}\n`;
    return;
  }
  sawJsonTurn = true;
  if (hang) return;
  answer(text.includes("@@TOOL@@"));
}

async function onEnd(): Promise<void> {
  if (hang) return; // live until signalled or the safety timer fires
  if (!sawJsonTurn && pendingText.trim() !== "") answer(pendingText.includes("@@TOOL@@"));
  if (late) {
    await Bun.sleep(LATE_GAP_MS);
    emit(assistantText(`msg_contractfake_late_${turns}`, "a frame after the final result"));
    emit(userToolResult(`toolu_contractfake_late_${turns}`));
    emit(
      assistantToolUse(`msg_contractfake_late_tool_${turns}`, `toolu_contractfake_late_${turns}`)
    );
    await Bun.sleep(LATE_GAP_MS);
  }
  if (linger) await Bun.sleep(LINGER_MS);
  process.exit(0);
}

noteMarkers(argv.join(" "));

emit({
  type: "system",
  subtype: "init",
  session_id: childSessionId,
  model: "contract-fake",
  cwd: process.cwd(),
  tools: [],
  mcp_servers: [],
  permissionMode: "default",
  apiKeySource: "none",
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string | Buffer) => {
  buffer += chunk.toString();
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    onLine(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
  }
});
process.stdin.on("end", () => {
  if (buffer) {
    onLine(buffer);
    buffer = "";
  }
  void onEnd();
});
