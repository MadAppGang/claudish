import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { join } from "node:path";
import { MagmuxClient, type MagmuxReply } from "./magmux-client.js";

type FailureLine = {
  ok: false;
  code: string;
  error: string;
  reason?: string;
  typed?: boolean;
};

// A protocol-decoding unit test, not a simulated pane integration test. Replay
// only NDJSON replies through the public socket API; no child, credentials or
// real magmux socket is opened. Each exchange owns and removes its short path.
async function exchange(replies: FailureLine[], fragmented = false): Promise<MagmuxReply[]> {
  const root = mkdtempSync("/tmp/cmr-");
  const sockPath = join(root, "m.sock");
  const peers = new Set<Socket>();
  let nextReply = 0;
  const server = createServer((socket) => {
    peers.add(socket);
    socket.write(`${JSON.stringify({ type: "snapshot", panes: [] })}\n`);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id: string };
        const reply = replies[nextReply++];
        if (!reply) {
          socket.destroy();
          continue;
        }
        const encoded = `${JSON.stringify({ type: "reply", id: request.id, ...reply })}\n`;
        if (fragmented) {
          // Split inside reason; the remainder carries typed and the line terminator.
          const cut = encoded.indexOf("dialog:") + "dialog:".length;
          socket.write(encoded.slice(0, cut));
          setImmediate(() => {
            if (!socket.destroyed) socket.write(encoded.slice(cut));
          });
        } else {
          socket.write(encoded);
        }
      }
    });
  });

  let client: MagmuxClient | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(sockPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    client = await MagmuxClient.dial(sockPath);
    const results: MagmuxReply[] = [];
    for (let index = 0; index < replies.length; index++) {
      results.push(
        await client.request({ type: "send", pane: 0, text: "run the tests", typed: true }, 2000)
      );
    }
    return results;
  } finally {
    client?.close();
    for (const socket of peers) socket.destroy();
    try {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(server.listening).toBe(false);
    expect([...peers].every((socket) => socket.destroyed)).toBe(true);
    expect(existsSync(root)).toBe(false);
  }
}

describe("U2 MagmuxClient failure reply fields", () => {
  test("keeps busy reason and typed true", async () => {
    const reply: FailureLine = {
      ok: false,
      code: "busy",
      error: "typing stopped",
      reason: "dialog:permission",
      typed: true,
    };
    expect(await exchange([reply])).toEqual([reply]);
  });

  test("keeps not_accepted reason and typed true", async () => {
    const reply: FailureLine = {
      ok: false,
      code: "not_accepted",
      error: "the text is still in the box",
      reason: "still_in_box",
      typed: true,
    };
    expect(await exchange([reply])).toEqual([reply]);
  });

  test("keeps reason while omitting absent typed", async () => {
    const reply: FailureLine = { ok: false, code: "busy", error: "booting", reason: "starting" };
    const results = await exchange([reply]);
    expect(results).toEqual([reply]);
    expect(Object.hasOwn(results[0]!, "typed")).toBe(false);
  });

  test("keeps typed while omitting absent reason", async () => {
    const reply: FailureLine = {
      ok: false,
      code: "pane_dead",
      error: "pane died while typing",
      typed: true,
    };
    const results = await exchange([reply]);
    expect(results).toEqual([reply]);
    expect(Object.hasOwn(results[0]!, "reason")).toBe(false);
  });

  test("preserves an explicitly false typed field", async () => {
    const reply: FailureLine = {
      ok: false,
      code: "busy",
      error: "not ready",
      reason: "terminal_not_ready",
      typed: false,
    };
    const results = await exchange([reply]);
    expect(results).toEqual([reply]);
    expect(Object.hasOwn(results[0]!, "typed")).toBe(true);
  });

  test("omits both fields on an ordinary failure", async () => {
    const reply: FailureLine = {
      ok: false,
      code: "no_such_pane",
      error: "no pane 0 (it may have been closed)",
    };
    const results = await exchange([reply]);
    expect(results).toEqual([reply]);
    expect(Object.hasOwn(results[0]!, "reason")).toBe(false);
    expect(Object.hasOwn(results[0]!, "typed")).toBe(false);
  });

  test("keeps an unknown reason verbatim", async () => {
    const reply: FailureLine = {
      ok: false,
      code: "busy",
      error: "new gate state",
      reason: "dialog:future_kind",
      typed: true,
    };
    expect(await exchange([reply])).toEqual([reply]);
  });

  test("does not carry optional fields into the next reply on the connection", async () => {
    const replies: FailureLine[] = [
      { ok: false, code: "busy", error: "dialog", reason: "dialog:question", typed: true },
      { ok: false, code: "bad_request", error: "unknown key name" },
    ];
    const results = await exchange(replies);
    expect(results).toEqual(replies);
    expect(Object.hasOwn(results[1]!, "reason")).toBe(false);
    expect(Object.hasOwn(results[1]!, "typed")).toBe(false);
  });

  test("keeps optional fields when a failure line arrives in fragments", async () => {
    const reply: FailureLine = {
      ok: false,
      code: "busy",
      error: "question appeared",
      reason: "dialog:question",
      typed: true,
    };
    expect(await exchange([reply], true)).toEqual([reply]);
  });
});
