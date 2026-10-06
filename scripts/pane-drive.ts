#!/usr/bin/env bun
/**
 * scripts/pane-drive.ts — drive ONE interactive Claude Code session in a headless magmux
 * pane through `PaneSession` (packages/cli/src/pane/), exactly as MCP `team` slots and
 * `create_session` run: claudish `-i --model <m> -y --quiet --session-id <uuid>` in a
 * per-session magmux, prompts typed or delivered by file, settle read from the transcript.
 * Replaces the polling reference driver `magmux-drive-session.ts`.
 *
 *   bun scripts/pane-drive.ts [--model haiku] [--cwd <dir>] [--flags '<json array>']
 *                             [--fake <scenario>] "<prompt>" ["<next prompt>" …]
 *
 * One prompt → a one-shot session; more → an interactive session, each later prompt sent
 * after the previous turn settled. Prints every wire transition and, at the end, one JSON
 * line `{ok, state, reason, detail, turns:[{answer, settledBy, stopReason}], anomalies}`.
 * Exit 0 when the session COMPLETED.
 *
 * Without `--fake` this runs the real claudish (CLAUDISH_BIN or `claudish` on PATH) with
 * YOUR environment and Claude Code config, and spends real tokens. `--fake <scenario>`
 * runs the test fake child in a hermetic temp environment instead (no cost, no login).
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkChildFlags,
  flagsRemoveRead,
  startPaneSession,
} from "../packages/cli/src/pane/index.ts";
import type { SettledTurn } from "../packages/cli/src/pane/types.ts";
import { projectsDir, transcriptPathFor } from "../packages/cli/src/session/session-discovery.ts";

function parse(argv: string[]) {
  const o = {
    model: "haiku",
    cwd: process.cwd(),
    flags: [] as string[],
    fake: null as string | null,
    prompts: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--model") o.model = argv[++i] as string;
    else if (a === "--cwd") o.cwd = resolve(argv[++i] as string);
    else if (a === "--flags") o.flags = JSON.parse(argv[++i] as string);
    else if (a === "--fake") o.fake = argv[++i] as string;
    else o.prompts.push(a);
  }
  return o;
}

async function main(): Promise<number> {
  const o = parse(process.argv.slice(2));
  if (o.prompts.length === 0) {
    console.error(
      'usage: bun scripts/pane-drive.ts [--model m] [--cwd dir] [--flags json] [--fake scenario] "<prompt>" …'
    );
    return 2;
  }
  const check = checkChildFlags(o.flags);
  if (!check.ok) {
    console.error(`invalid --flags: ${check.message}`);
    return 2;
  }
  let parentEnv: Record<string, string | undefined> = process.env;
  let cwd = realpathSync(o.cwd);
  let cleanup = () => {};
  let model = o.model;
  if (o.fake) {
    const { makePaneTestEnv } = await import(
      "../packages/cli/src/pane/test-helpers/hermetic-env.ts"
    );
    const t = makePaneTestEnv();
    parentEnv = t.env;
    cwd = realpathSync(t.cwd);
    model = `fake-${o.fake}`;
    cleanup = () => t.cleanup();
  }
  const uuid = crypto.randomUUID();
  const interactive = o.prompts.length > 1;
  const turns: SettledTurn[] = [];
  const t0 = Date.now();
  const s = await startPaneSession({
    kind: "s",
    label: "drive",
    callerFlags: o.flags,
    spawnModel: model,
    cwd,
    sessionUuid: uuid,
    transcriptPath: transcriptPathFor(cwd, uuid, projectsDir(parentEnv)),
    slotEnv: {},
    shape: interactive ? "interactive" : "one-shot",
    initialPrompt: o.prompts[0],
    readAvailable: !flagsRemoveRead(o.flags),
    parentEnv,
    decide: (turn) => {
      turns.push(turn);
      if (turn.apiError)
        return { state: "FAILED", reason: "api_error", detail: turn.apiError.text };
      if (turns.length < o.prompts.length) return "continue";
      return turn.answer.trim()
        ? { state: "COMPLETED" }
        : { state: "EMPTY", reason: "empty_output" };
    },
    onBlocked: (b) => ({ state: "FAILED", reason: "blocked", detail: `${b.tool}: ${b.text}` }),
    onTransition: (x) =>
      console.error(`[pane ${((Date.now() - t0) / 1000).toFixed(1)}s] ${x.from} → ${x.to}`),
  });
  console.error(`[pane] ${s.paneId} session ${uuid}`);
  for (const p of o.prompts.slice(1)) s.send(p);
  const snap = await s.terminal;
  await s.reaped();
  cleanup();
  console.log(
    JSON.stringify({
      ok: snap.state === "COMPLETED",
      state: snap.state,
      reason: snap.reason,
      detail: snap.detail,
      turns: turns.map((t) => ({
        answer: t.answer,
        settledBy: t.settledBy,
        stopReason: t.stopReason,
        delivery: t.delivery.mode,
      })),
      anomalies: snap.anomalies,
      claudeCode: snap.claudeCodeVersion,
    })
  );
  return snap.state === "COMPLETED" ? 0 : 1;
}

process.exit(await main());
