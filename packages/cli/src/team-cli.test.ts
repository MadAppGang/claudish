/**
 * G3 (#27 triage follow-up): `claudish team run --interactive` must actually
 * reach runWithGrid as mode "interactive".
 *
 * Found by the #27 G2 tsc triage: team-cli.ts passed `{ timeout, interactive }`
 * while runWithGrid reads `opts?.mode ?? "default"` (team-grid.ts) and never
 * `opts.interactive` — the legacy `--interactive` flag (mapped to effectiveMode
 * at team-cli.ts) reached the grid branch (only "json" takes the other path)
 * and was silently ignored: every grid run behaved as default mode.
 *
 * Non-vacuity: written before the fix; red on main (captured.mode undefined,
 * the `interactive` key dead). team-grid is mocked at the module registry
 * because team-cli imports it DYNAMICALLY (await import) inside the grid
 * branch — mock.module covers the dynamic resolve. The bare factory exports
 * only runWithGrid: no other test file imports team-grid.js (the e2e file
 * goes through e2e-helpers), so the process-global mock (#272) is contained.
 */
import { describe, expect, mock, test } from "bun:test";
import { teamCommand } from "./team-cli.js";

const captured: Array<Record<string, unknown>> = [];
const STATUS = { startedAt: "2026-10-19T00:00:00.000Z", models: {} };

mock.module("./team-grid.js", () => ({
  runWithGrid: async (
    _sessionPath: string,
    _models: string[],
    _input: string,
    opts?: Record<string, unknown>
  ) => {
    captured.push(opts ?? {});
    return STATUS;
  },
}));

async function run(args: string[]): Promise<Record<string, unknown>> {
  const before = captured.length;
  const realLog = console.log;
  console.log = () => {};
  try {
    await teamCommand(args);
  } finally {
    console.log = realLog;
  }
  // Positive control: the grid branch ran (a json-branch take-over would make
  // this fail, not the mode assertion vacuously pass).
  expect(captured.length).toBe(before + 1);
  return captured[captured.length - 1];
}

describe("team-cli: --interactive reaches runWithGrid as mode (G3, #27)", () => {
  test('legacy --interactive flag → opts.mode === "interactive", not a dead `interactive` key', async () => {
    const opts = await run(["run", "--models", "qwen3.6-35b-a3b", "--interactive"]);
    expect(opts.mode).toBe("interactive");
  });

  test("--mode interactive (new syntax) is equally honored; default stays default", async () => {
    expect((await run(["--models", "qwen3.6-35b-a3b", "--mode", "interactive"])).mode).toBe("interactive");
    expect((await run(["--models", "qwen3.6-35b-a3b"])).mode).toBe("default");
  });
});
