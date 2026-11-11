import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkChildFlags } from "../pane/pane-launch.js";
import {
  FAKE_CHILD,
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import { waitUntil } from "../test-helpers/team-pane.js";
import { SessionManager } from "./session-manager.js";
import type { SessionCreateOptions } from "./types.js";

test.each(["--model-pinned", "--model-pinned=true"])(
  "REQ-107 RB-27: caller flag %s is refused before a pane may start",
  (flag) => {
    const result = checkChildFlags([flag]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("The parent-only flag was accepted");
    expect(result.message).toContain("--model-pinned");
  }
);

test.skipIf(!MAGMUX)(
  "REQ-107 RB-2 RB-27: createSession accepts a user-typed + chain and launches it without a parent pin",
  async () => {
    const t = makePaneTestEnv();
    const model = "openai@one+openrouter@two";
    const probe = join(t.tmp, "chain-argv.json");
    const child = join(t.tmp, "record-chain-argv.ts");
    writeFileSync(
      child,
      [
        'import { renameSync, writeFileSync } from "node:fs";',
        `const probe = ${JSON.stringify(probe)};`,
        'writeFileSync(probe + ".tmp", JSON.stringify({ argv: process.argv.slice(2) }));',
        'renameSync(probe + ".tmp", probe);',
        `await import(${JSON.stringify(FAKE_CHILD)});`,
      ].join("\n")
    );
    const manager = new SessionManager({
      sessionsDir: join(t.tmp, "sessions"),
      parentEnv: { ...t.env, CLAUDISH_BIN: child },
      hookEngine: async () => null,
      magmuxBinary: MAGMUX!,
    });
    try {
      const id = await manager.createSession({ model, cwd: t.cwd });
      const info = manager.getSession(id);
      await waitUntil(() => existsSync(probe), "the chain child's argv report");
      const { argv } = JSON.parse(readFileSync(probe, "utf8")) as { argv: string[] };

      expect(info.model).toBe(model);
      expect(info.spawnModel).toBeNull();
      expect(argv.slice(0, 3)).toEqual(["-i", "--model", model]);
      expect(
        argv.filter((value) => value === "--model-pinned" || value.startsWith("--model-pinned="))
      ).toEqual([]);
    } finally {
      await manager.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot });
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    }
  },
  30_000
);

test.each(["--model-pinned", "--model-pinned=true"])(
  "REQ-107: createSession refuses caller-owned %s before creating a session record",
  async (flag) => {
    const t = makePaneTestEnv();
    const sessionsDir = join(t.tmp, "sessions");
    const manager = new SessionManager({
      sessionsDir,
      parentEnv: t.env,
      hookEngine: async () => null,
      magmuxBinary: join(t.tmp, "no-magmux-should-be-needed"),
    });
    try {
      await expect(
        manager.createSession({
          model: "openai@named-model",
          claudishFlags: [flag],
          cwd: t.cwd,
        })
      ).rejects.toThrow(/--model-pinned/);
      expect(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).toEqual([]);
    } finally {
      await manager.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot });
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    }
  }
);

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);
describe.skipIf(!MAGMUX)("REQ-107 RB-27: SessionCreateOptions.spawnPinned is explicit", () => {
  for (const spawnPinned of [true, false, undefined]) {
    test(`REQ-107: spawnModel with spawnPinned=${String(spawnPinned)} ${spawnPinned ? "adds" : "does not add"} --model-pinned`, async () => {
      const t = makePaneTestEnv();
      const probe = join(t.tmp, "probe-{session}.json");
      const manager = new SessionManager({
        sessionsDir: join(t.tmp, "sessions"),
        parentEnv: { ...t.env, FAKE_PROBE_FILE: probe },
        magmuxBinary: MAGMUX!,
        hookEngine: async () => null,
      });
      try {
        const options: SessionCreateOptions = {
          model: "display-model",
          spawnModel: "fake-env_probe",
          ...(spawnPinned === undefined ? {} : { spawnPinned }),
          cwd: t.cwd,
        };
        const id = await manager.createSession(options);
        const info = manager.getSession(id);
        const probePath = probe.replace("{session}", info.claudeSessionId);
        await waitUntil(() => existsSync(probePath), "the child's argv report");
        const { argv } = JSON.parse(readFileSync(probePath, "utf8")) as { argv: string[] };

        expect(info.model).toBe("display-model");
        expect(info.spawnModel).toBe("fake-env_probe");
        expect(argv.slice(0, 3)).toEqual(["-i", "--model", "fake-env_probe"]);
        expect(argv.filter((value) => value === "--model-pinned")).toHaveLength(
          spawnPinned ? 1 : 0
        );
        if (spawnPinned) expect(argv[3]).toBe("--model-pinned");
        const sessionArg = argv.indexOf("--session-id");
        expect(sessionArg).toBeGreaterThan(2);
        expect(argv[sessionArg + 1]).toBe(info.claudeSessionId);
      } finally {
        await manager.shutdownAll();
        const report = await waitNoOrphans({ sockRoot: t.sockRoot });
        killLeftovers({ sockRoot: t.sockRoot });
        t.cleanup();
        expect(report).toEqual({ processes: [], files: [] });
      }
    }, 30_000);
  }
});
