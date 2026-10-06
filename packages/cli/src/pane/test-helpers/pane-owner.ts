#!/usr/bin/env bun
/**
 * A stand-alone pane OWNER for the registry tests (test-only): starts N pane sessions
 * that hang (`@@HANG@@`), prints one JSON line describing them, then waits to be killed.
 * The test SIGKILLs it to prove the watchers clean up with no help from the owner.
 *
 * Input: env PANE_OWNER_SPEC = JSON { n, sockRoot, cwd, configDir, env }.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startPaneSession } from "../pane-session.js";

const spec = JSON.parse(process.env.PANE_OWNER_SPEC ?? "{}") as {
  n: number;
  sockRoot: string;
  cwd: string;
  configDir: string;
  env: Record<string, string>;
};

const sessions = await Promise.all(
  Array.from({ length: spec.n }, async (_, i) => {
    const uuid = crypto.randomUUID();
    const s = await startPaneSession({
      kind: "t",
      label: `0${i + 1}`,
      callerFlags: [],
      spawnModel: "contract-fake-model",
      cwd: spec.cwd,
      sessionUuid: uuid,
      transcriptPath: join(spec.configDir, "projects", "x", `${uuid}.jsonl`),
      slotEnv: {},
      shape: "one-shot",
      initialPrompt: "@@HANG@@",
      readAvailable: true,
      parentEnv: { ...spec.env, CONTRACT_FAKE_MAX_MS: "120000" },
      sockRoot: spec.sockRoot,
      decide: () => ({ state: "COMPLETED" }),
      onBlocked: () => "wait",
      timings: { replStableMs: 200 },
    });
    await s.ready;
    return { s, uuid };
  })
);

// let the registry tick record each verified group (members with start times)
await Bun.sleep(2500);
const records = readdirSync(join(spec.sockRoot, "panes")).map((n) =>
  JSON.parse(readFileSync(join(spec.sockRoot, "panes", n), "utf8"))
);
process.stdout.write(
  `${JSON.stringify({
    owner: process.pid,
    panes: sessions.map(({ s, uuid }) => ({
      paneId: s.paneId,
      uuid,
      state: s.snapshot().state,
      panePid: s.snapshot().panePid,
    })),
    records,
  })}\n`
);
await new Promise(() => {});
