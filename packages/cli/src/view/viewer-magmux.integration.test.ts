/**
 * `claudish view <target>` end to end, hermetic, with real magmux: a real claudish MCP server
 * runs a session on the fake interactive child; a second, headless magmux runs `claudish view`
 * on that session in its pane; that pane's screen, read through its control socket, shows the
 * session's screen. The MCP row says a terminal holds the view; keys typed into the viewer never
 * reach the session; q releases the view and the viewer exits.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findMagmuxBinaryOrNull } from "../launcher/magmux-binary.js";
import { MagmuxClient } from "../pane/magmux-client.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  SERVER_ENTRY,
  createSession,
  paneOrphans,
  sendInput,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";

type Json = Record<string, unknown>;
const T = 120_000;
const PROMPT = "VIEWCHECK 視界 alpha";

let layout: TempLayout | undefined;
let server: McpServer | undefined;
let outer: ChildProcess | undefined;
let outerDir: string | undefined;

afterEach(async () => {
  if (outer?.pid) {
    try {
      process.kill(-outer.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  if (outerDir) rmSync(outerDir, { recursive: true, force: true });
  await server?.close();
  if (layout) {
    const report = await paneOrphans(layout);
    layout.cleanup();
    expect(report).toEqual({ processes: [], files: [] });
  }
  layout = undefined;
  server = undefined;
  outer = undefined;
  outerDir = undefined;
});

async function sessionRow(id: string): Promise<Json | undefined> {
  const r = await (server as McpServer).callTool("list_sessions", { include_completed: true });
  const sessions = (r.json?.sessions ?? []) as Json[];
  return sessions.find((s) => s.session_id === id);
}

async function screenOf(client: MagmuxClient): Promise<string> {
  const cap = await client.request<{ text?: string }>({ type: "capture", pane: 0 }, 2_000);
  return cap.ok ? (cap.result.text ?? "") : "";
}

describe.skipIf(!MAGMUX_AVAILABLE)(
  `claudish view in a real magmux pane (${MAGMUX_AVAILABLE ? "" : NO_MAGMUX_MESSAGE})`,
  () => {
    test(
      "the viewer's pane shows the session's screen, holds the view, and forwards no key",
      async () => {
        layout = makeTempLayout("view-e2e");
        const env = serverEnv(layout);
        server = await McpServer.start({ env, cwd: layout.cwd });
        // a promptless session stays open between turns, so it is still live when viewed
        const { sessionId } = await createSession(server, {});
        expect(sessionId).toBeTruthy();
        const id = sessionId as string;
        await waitFor(async () => (await sessionRow(id))?.state === "AWAITING_INPUT", {
          what: "the session to boot",
          timeoutMs: 60_000,
          intervalMs: 200,
        });
        await sendInput(server, id, PROMPT);
        await waitFor(
          async () => {
            const row = await sessionRow(id);
            return row?.state === "AWAITING_INPUT" && row.turns_completed === 1;
          },
          { what: "the session to answer", timeoutMs: 60_000, intervalMs: 200 }
        );

        outerDir = `/tmp/cpv-${randomBytes(4).toString("hex")}`;
        mkdirSync(outerDir, { mode: 0o700 });
        const viewCmd = `${process.execPath} --no-env-file ${SERVER_ENTRY} view s:${id}`;
        outer = spawn(
          findMagmuxBinaryOrNull() as string,
          ["--headless", "--no-status", "--id", "outer", "--sock-dir", outerDir, "-e", viewCmd],
          {
            cwd: layout.cwd,
            env: { ...env, TERM: "xterm-256color", TERM_PROGRAM: "E2ETerm" },
            stdio: ["ignore", "ignore", "ignore"],
            detached: true,
          }
        );
        const control = await MagmuxClient.connect(join(outerDir, "magmux-outer.sock"), {
          timeoutMs: 15_000,
        });
        try {
          const shown = await waitFor(
            async () => {
              const text = await screenOf(control);
              return text.includes("ANSWER") && text.includes("VIEWCHECK") ? text : undefined;
            },
            {
              what: "the session's screen in the viewer's pane",
              timeoutMs: 30_000,
              intervalMs: 200,
            }
          );
          expect(shown).toContain(`s:${id}`);
          expect(shown).toContain("AWAITING_INPUT");

          // the viewer only watches: the session's view is still nobody's
          expect((await sessionRow(id))?.view ?? null).toBeNull();

          // typed into the viewer: none of it may reach the session
          const typed = await control.request({ type: "send", pane: 0, text: "zzkeyprobe\r" });
          expect(typed.ok).toBe(true);
          await Bun.sleep(1_500);
          const inner = await server.callTool("capture_session", { session_id: id });
          expect(inner.text).not.toContain("zzkeyprobe");
          expect((await sessionRow(id))?.state).toBe("AWAITING_INPUT");
          expect((await sessionRow(id))?.turns_completed).toBe(1);

          // `send` presses Enter after the text; the viewer has already exited on the q by then
          const quit = await control.request({ type: "send", pane: 0, text: "q" });
          expect(quit.ok || quit.code === "pane_dead").toBe(true);
          await Bun.sleep(500);
          expect((await sessionRow(id))?.view ?? null).toBeNull();
        } finally {
          control.close();
        }
      },
      T
    );
  }
);
