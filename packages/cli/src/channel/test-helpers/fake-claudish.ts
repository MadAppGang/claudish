#!/usr/bin/env bun
/**
 * Stream-json claudish stand-in used by:
 * - packages/cli/src/channel/session-manager.test.ts
 * - packages/cli/src/team-orchestrator.test.ts (--print-argv pins the exact spawn contract,
 *   including flag order)
 * - focused spawn-environment tests (--print-env reports one selected variable)
 * - team-orchestrator.test.ts (--close-stdout-first ends the output before the exit)
 * A flag unused by one consumer may be load-bearing for the other; running only the channel
 * suite will not catch its removal.
 */

const args = process.argv.slice(2);

function getFlag(name: string): string | null {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function write(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sessionId = getFlag("--session-id") ?? "fake-0000-1111-2222-333333333333";

async function runTurn(turn: number, inputLine: string): Promise<void> {
  const input = JSON.parse(inputLine) as {
    type?: unknown;
    message?: { role?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
  };
  if (
    input.type !== "user" ||
    input.message?.role !== "user" ||
    input.message.content?.[0]?.type !== "text" ||
    typeof input.message.content[0].text !== "string"
  ) {
    throw new Error(`invalid user frame: ${inputLine}`);
  }

  if (turn === 1) {
    write({
      type: "system",
      subtype: "hook_started",
      hook_name: "SessionStart:startup",
      hook_event: "SessionStart",
      session_id: sessionId,
    });
    write({
      type: "system",
      subtype: "hook_response",
      hook_name: "SessionStart:startup",
      exit_code: 0,
      outcome: "success",
      session_id: sessionId,
    });
    write({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: sessionId,
      tools: ["Bash", "Read"],
    });
  }

  write({ type: "system", subtype: "status", status: "requesting", session_id: sessionId });
  write({ type: "user", message: input.message, session_id: sessionId, isReplay: true });
  await sleep(20);
  write({
    type: "stream_event",
    event: { type: "message_start", message: { model: "fake", usage: {} } },
    session_id: sessionId,
    ttft_ms: 12,
  });

  const lineCount = Number.parseInt(getFlag("--lines") ?? "0", 10);
  if (lineCount > 0) {
    for (let line = 1; line <= lineCount; line++) {
      write({
        type: "assistant",
        message: {
          model: "fake",
          role: "assistant",
          content: [{ type: "text", text: `line ${line}` }],
        },
        session_id: sessionId,
      });
    }
  } else {
    for (const fragment of ["Hel", "lo ", "from ", "the ", "fake ", "child"]) {
      write({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: fragment },
        },
        session_id: sessionId,
      });
    }
    write({
      type: "assistant",
      message: {
        model: "fake",
        role: "assistant",
        content: [{ type: "text", text: `Hello from the fake child (turn ${turn})` }],
      },
      session_id: sessionId,
    });
    write({
      type: "assistant",
      message: {
        model: "fake",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "true" } }],
      },
      session_id: sessionId,
    });
    await sleep(20);
    process.stdout.write(
      "Client.listTools() called but server does not advertise tools capability - returning empty list\n"
    );
    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      session_id: sessionId,
    });
    write({
      type: "assistant",
      message: {
        model: "fake",
        role: "assistant",
        content: [{ type: "text", text: "ANSWER-MARKER done." }],
      },
      session_id: sessionId,
    });
    write({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed" },
      session_id: sessionId,
    });
  }

  write({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: turn,
    stop_reason: "end_turn",
    session_id: sessionId,
    total_cost_usd: 0.42,
    usage: { input_tokens: 1234, output_tokens: 56 },
    permission_denials: [],
    terminal_reason: "completed",
    api_error_status: null,
    result: lineCount > 0 ? `line ${lineCount}` : "ANSWER-MARKER done.",
    duration_ms: 200,
  });
}

async function main(): Promise<void> {
  // --print-argv: expose the exact spawn contract to parent-process tests
  if (hasFlag("--print-argv")) {
    process.stdout.write(`${JSON.stringify(args)}\n`);
    process.exit(0);
  }

  // --print-env <NAME>: expose one selected child env value as ordinary
  // stream-json prose. Existing modes stay byte-for-byte unchanged, while
  // both channel and team supervisors can inspect the actual spawn env.
  const envName = getFlag("--print-env");
  if (envName !== null) {
    const answer = JSON.stringify({ [envName]: process.env[envName] ?? null });
    write({
      type: "assistant",
      message: {
        model: "fake",
        role: "assistant",
        content: [{ type: "text", text: answer }],
      },
      session_id: sessionId,
    });
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      stop_reason: "end_turn",
      session_id: sessionId,
      terminal_reason: "completed",
      api_error_status: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      permission_denials: [],
      result: answer,
    });
    process.exit(0);
  }

  // --close-stdout-first <ms>: write the argv, close stdout, and exit 0 only
  // <ms> later, so the parent sees its output end well before the child's
  // exit. A supervisor that settles on the output alone reads no exit code.
  const closeFirstMs = getFlag("--close-stdout-first");
  if (closeFirstMs !== null) {
    const { closeSync, writeSync } = await import("node:fs");
    writeSync(1, `${JSON.stringify(args)}\n`);
    closeSync(1);
    await sleep(Number.parseInt(closeFirstMs, 10));
    process.exit(0);
  }

  if (hasFlag("--fail")) process.exit(1);

  const sleepSeconds = getFlag("--sleep");
  if (sleepSeconds !== null) {
    await sleep(Number.parseFloat(sleepSeconds) * 1000);
    process.exit(0);
  }

  let pending = "";
  let turns = 0;
  let turnQueue = Promise.resolve();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    let newlineAt = pending.indexOf("\n");
    while (newlineAt !== -1) {
      const line = pending.slice(0, newlineAt);
      pending = pending.slice(newlineAt + 1);
      newlineAt = pending.indexOf("\n");
      if (!line.trim()) continue;
      turnQueue = turnQueue.then(() => runTurn(++turns, line));
    }
  });
  process.stdin.on("end", () => {
    void turnQueue.finally(() => setTimeout(() => process.exit(0), 20));
  });
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
