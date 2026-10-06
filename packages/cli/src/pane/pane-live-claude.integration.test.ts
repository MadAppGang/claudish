/**
 * OPT-IN live tests: a real pane — this tree's claudish and the REAL Claude Code, native
 * haiku — driven by PaneSession. Skipped unless the operator asks for them, because they
 * spend money and need a login:
 *
 *   CLAUDISH_PANE_LIVE=1 CLAUDE_CODE_OAUTH_TOKEN=<token> \
 *     bun test packages/cli/src/pane/pane-live-claude.integration.test.ts
 *
 * The config dir is hermetic (a temp CLAUDE_CONFIG_DIR is "Not logged in", so the token
 * must come from the operator's env). The test never reads the keychain or ~/.claude.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startPaneSession } from "./pane-session.js";
import {
  MAGMUX,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "./test-helpers/hermetic-env.js";
import type { SettledTurn } from "./types.js";

const LIVE =
  process.env.CLAUDISH_PANE_LIVE === "1" && !!process.env.CLAUDE_CODE_OAUTH_TOKEN && !!MAGMUX;
const INDEX = join(import.meta.dir, "..", "index.ts");
const envs: PaneTestEnv[] = [];
afterAll(() => {
  for (const t of envs) {
    killLeftovers({ sockRoot: t.sockRoot });
    t.cleanup();
  }
});

async function live(
  prompt: string,
  shape: "one-shot" | "interactive" = "one-shot",
  follow?: string
) {
  const t = makePaneTestEnv({
    CLAUDISH_BIN: INDEX,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN as string,
  });
  envs.push(t);
  writeFileSync(
    join(t.configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: { [realpathSync(t.cwd)]: { hasTrustDialogAccepted: true } },
    })
  );
  const uuid = crypto.randomUUID();
  const turns: SettledTurn[] = [];
  const s = await startPaneSession({
    kind: "s",
    label: "live",
    callerFlags: [],
    spawnModel: "haiku",
    cwd: t.cwd,
    sessionUuid: uuid,
    transcriptPath: t.transcriptPathFor(uuid),
    slotEnv: { CLAUDISH_TOKEN_FILE: join(t.tmp, "tokens.json") },
    shape,
    initialPrompt: prompt,
    readAvailable: true,
    parentEnv: t.env,
    sockRoot: t.sockRoot,
    decide: (turn) => {
      turns.push(turn);
      if (shape === "interactive" && turns.length < 2) return "continue";
      return turn.apiError
        ? { state: "FAILED", reason: "api_error", detail: turn.apiError.text }
        : { state: "COMPLETED" };
    },
    onBlocked: (b) => ({ state: "FAILED", reason: "blocked", detail: b.text }),
  });
  if (follow) {
    await s.ready;
    s.send(follow);
  }
  const snap = await s.terminal;
  await s.reaped();
  const left = await waitNoOrphans({
    sockRoot: t.sockRoot,
    ids: [uuid],
    pgids: [snap.panePid ?? 0],
  });
  return { snap, turns, left };
}

describe.skipIf(!LIVE)(
  "live: real claudish + real Claude Code in a pane (opt-in: CLAUDISH_PANE_LIVE=1)",
  () => {
    test("a typed one-shot prompt completes on turn_duration", async () => {
      const r = await live("Reply with exactly PEAR and nothing else.");
      expect(r.snap.state).toBe("COMPLETED");
      expect(r.turns[0]?.answer).toContain("PEAR");
      expect(r.turns[0]?.settledBy).toBe("turn_duration");
      expect(r.left).toEqual({ processes: [], files: [] });
    }, 180_000);

    test("a multi-line prompt is delivered by file and fully read", async () => {
      const r = await live(
        "Reply with the word KIWI and nothing else.\nThis second line is part of the task."
      );
      expect(r.snap.state).toBe("COMPLETED");
      expect(r.turns[0]?.delivery).toMatchObject({ mode: "file", complete: true });
      expect(r.turns[0]?.answer).toContain("KIWI");
      expect(r.left).toEqual({ processes: [], files: [] });
    }, 180_000);

    test("interactive: a queued second prompt is answered as turn 2", async () => {
      const r = await live("Reply with exactly ONE.", "interactive", "Reply with exactly TWO.");
      expect(r.snap.state).toBe("COMPLETED");
      expect(r.turns.map((x) => x.answer.trim())).toEqual(["ONE", "TWO"]);
      expect(r.snap.turnsCompleted).toBe(2);
    }, 240_000);
  }
);
