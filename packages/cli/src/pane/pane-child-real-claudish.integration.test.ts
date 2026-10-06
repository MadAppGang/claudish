/**
 * The REAL pane child claudish, hermetically (architecture §12.2, X-M6): the launcher
 * execs this tree's `src/index.ts` (CLAUDISH_BIN), and that claudish launches the fake
 * child in "claude" mode as Claude Code (CLAUDE_PATH), with a native model so no proxy
 * request is ever made. The fake dumps the argv, env, cwd and `--settings` it was given.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startPaneSession } from "./pane-session.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
  writeFakeClaudeWrapper,
} from "./test-helpers/hermetic-env.js";

const INDEX = join(import.meta.dir, "..", "index.ts");
const envs: PaneTestEnv[] = [];
afterAll(() => {
  for (const t of envs) {
    killLeftovers({ sockRoot: t.sockRoot });
    t.cleanup();
  }
});

async function run(callerFlags: string[] = []) {
  const t = makePaneTestEnv();
  envs.push(t);
  const dump = join(t.tmp, "claude-dump.json");
  const tokenFile = join(t.tmp, "tokens.json");
  const env = {
    ...t.env,
    CLAUDISH_BIN: INDEX,
    CLAUDE_PATH: writeFakeClaudeWrapper(t.tmp),
    FAKE_CLAUDE_DUMP: dump,
    PANE_TEST_CANARY: "kept",
    CLAUDE_CODE_CHILD_SESSION: "1",
    // an MCP server started by a wrapped claudish inherits a claudish-marked watchdog (D22)
    CLAUDE_CODE_RETRY_WATCHDOG: "1",
    CLAUDISH_SET_RETRY_WATCHDOG: "1",
    CONTRACT_FAKE_MAX_MS: "60000",
  };
  const uuid = crypto.randomUUID();
  const s = await startPaneSession({
    kind: "s",
    label: "real",
    callerFlags,
    spawnModel: "haiku",
    cwd: t.cwd,
    sessionUuid: uuid,
    transcriptPath: t.transcriptPathFor(uuid),
    slotEnv: { CLAUDISH_TOKEN_FILE: tokenFile },
    shape: "one-shot",
    initialPrompt: "Reply with exactly PEAR.",
    readAvailable: true,
    parentEnv: env,
    sockRoot: t.sockRoot,
    decide: (turn) =>
      turn.answer ? { state: "COMPLETED" } : { state: "EMPTY", reason: "empty_output" },
    onBlocked: () => "wait",
    bootTimeoutMs: 45_000,
  });
  const snap = await Promise.race([
    s.terminal,
    Bun.sleep(60_000).then(() => {
      throw new Error(`no terminal state: ${JSON.stringify(s.snapshot())}`);
    }),
  ]);
  s.cancel();
  await s.reaped();
  const left = await waitNoOrphans({
    sockRoot: t.sockRoot,
    ids: [uuid],
    pgids: [snap.panePid ?? 0],
  });
  return { t, snap, dump, tokenFile, left };
}

describe.skipIf(!MAGMUX)(
  `the real pane child claudish (${MAGMUX ? "" : NO_MAGMUX_MESSAGE})`,
  () => {
    test("snapshot and cwd restored; overlay key; markers, child-session and watchdog stripped; answered", async () => {
      const { t, snap, dump, tokenFile, left } = await run();
      expect(snap.state).toBe("COMPLETED");
      expect(left).toEqual({ processes: [], files: [] });
      expect(existsSync(dump)).toBe(true);
      const d = JSON.parse(readFileSync(dump, "utf8")) as {
        argv: string[];
        env: Record<string, string>;
        cwd: string;
        settings: Record<string, unknown> | string | null;
      };
      // child-env.ts re-applied the server's snapshot: the real SHELL (not the shim), the canary, the config dir
      expect(d.env.SHELL).toBe("/bin/zsh");
      expect(d.env.PANE_TEST_CANARY).toBe("kept");
      expect(d.env.CLAUDE_CONFIG_DIR).toBe(t.configDir);
      expect(d.cwd.endsWith("/cwd")).toBe(true);
      for (const k of [
        "CLAUDISH_PANE_CHILD",
        "CLAUDISH_PANE_ENV",
        "CLAUDISH_PANE_CWD",
        "CLAUDE_CODE_CHILD_SESSION",
      ])
        expect(d.env[k]).toBeUndefined();
      expect(d.env.CLAUDE_CODE_RETRY_WATCHDOG).toBeUndefined();
      expect(typeof d.settings === "object" && d.settings !== null).toBe(true);
      expect((d.settings as Record<string, unknown>).skipDangerousModePermissionPrompt).toBe(true);
      expect(
        JSON.stringify(d.settings).includes(tokenFile) || d.env.CLAUDISH_TOKEN_FILE === tokenFile
      ).toBe(true);
      expect(d.argv).toContain("--session-id");
      expect(d.argv.some((a) => a === "-p" || a === "--print")).toBe(false);
    }, 90_000);

    test("a --team that slipped past the server walker: the child refuses with exit 64", async () => {
      const { snap, left } = await run(["--team", "a,b"]);
      expect(snap.state).toBe("FAILED");
      expect(snap.reason).toBe("child_exited");
      expect(snap.exitCode).toBe(64);
      expect(snap.detail).toContain("pane child refused");
      expect(left).toEqual({ processes: [], files: [] });
    }, 90_000);
  }
);
