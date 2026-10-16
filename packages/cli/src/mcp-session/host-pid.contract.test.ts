// packages/cli/src/channel/host-pid.contract.test.ts
/**
 * Black-box contract tests for `hostPid`, `launcherPid` and `mcpPid` in spawn.json, against
 * real entry points (design §3.5 "hostPid, computed once at startup"; §8.1 tests 9a, 9b).
 * The unit cases of hostPidFrom live in parent-session.contract.test.ts.
 *
 * The session is an interactive pane (the pane fake, marker mode, in a real headless magmux
 * under the test's own CLAUDISH_PANE_ROOT; ported per architecture §20.2, every assertion
 * kept). After each test no pane process or file may remain.
 *
 * The test process stands in for Claude Code. Three topologies:
 *   9b    test → `bun src/index.ts --mcp`                       (the compiled-binary branch)
 *   pair  test → a launcher stand-in → `bun src/index.ts --mcp`  (the launcher branch, no build)
 *   9a    test → `node bin/claudish.cjs --mcp` → bun dist        (the npm install, for real)
 *
 * INFERRED: the npm launcher is `<package>/bin/claudish.cjs` and runs `<package>/dist/index.js`
 * after `bun run build` (design §3.5 names `bin/claudish.cjs:112-114` and `dist/index.js`).
 * 9a builds once when dist/index.js is missing, so it never silently skips.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  PACKAGE_DIR,
  SERVER_ENTRY,
  createSession,
  paneOrphans,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import {
  type TempLayout,
  makeTempLayout,
  pidAlive,
  ppidOf,
  spawnRecordViolations,
} from "../test-helpers/contract-records.js";

const T_TEST = 60_000;

let layout: TempLayout;
const servers: McpServer[] = [];

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(() => {
  layout = makeTempLayout("hostpid");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  const report = await paneOrphans(layout);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
}, 40_000);

async function spawnRecordVia(
  command: string[] | undefined,
  extraEnv: Record<string, string | undefined> = {}
) {
  const server = await McpServer.start({
    env: serverEnv(layout, extraEnv),
    cwd: layout.cwd,
    command,
  });
  servers.push(server);
  const { sessionId, result } = await createSession(server, {
    prompt: "@@HANG@@ keep the writer busy",
  });
  expect(result.isError).toBe(false);
  const text = readFileSync(join(layout.sessionsDir, sessionId as string, "spawn.json"), "utf8");
  expect(spawnRecordViolations(text, sessionId as string)).toEqual([]);
  return { server, rec: JSON.parse(text) as Record<string, unknown> };
}

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-3 the compiled-binary branch (9b): claudish started directly by its host",
  () => {
    test(
      "hostPid is the test process, mcpPid is the spawned server, and there is no launcherPid",
      async () => {
        const { server, rec } = await spawnRecordVia(undefined);

        expect({ hostPid: rec.hostPid, mcpPid: rec.mcpPid }).toEqual({
          hostPid: process.pid,
          mcpPid: server.pid,
        });
        expect("launcherPid" in rec).toBe(false);
      },
      T_TEST
    );

    test(
      "a launcher pair leaked from an outer launcher is inert: same result as with no pair",
      async () => {
        const { server, rec } = await spawnRecordVia(undefined, {
          // An OUTER launcher's pair: its pid is not this server's parent (the test process), so
          // CLAUDISH_LAUNCHER_PID != ppid and the pair must be ignored (contract 3.5, hostPidFrom).
          CLAUDISH_LAUNCHER_PID: String(process.ppid),
          CLAUDISH_LAUNCHER_PPID: "1",
        });

        expect({ hostPid: rec.hostPid, mcpPid: rec.mcpPid }).toEqual({
          hostPid: process.pid,
          mcpPid: server.pid,
        });
        expect("launcherPid" in rec).toBe(false);
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)(
  "REQ-3 the launcher branch: a launcher that passes its own pid pair",
  () => {
    test(
      "hostPid is the launcher's parent, launcherPid is the launcher, mcpPid is its child",
      async () => {
        const launcher = join(layout.root, "launcher-stand-in.ts");
        writeFileSync(
          launcher,
          [
            `const child = Bun.spawn([process.execPath, ${JSON.stringify(SERVER_ENTRY)}, "--mcp"], {`,
            `  stdin: "inherit", stdout: "inherit", stderr: "inherit",`,
            "  env: { ...process.env, CLAUDISH_LAUNCHER_PID: String(process.pid), CLAUDISH_LAUNCHER_PPID: String(process.ppid) },",
            "});",
            `process.on("SIGTERM", () => { child.kill("SIGTERM"); });`,
            "process.exitCode = await child.exited;",
            "",
          ].join("\n")
        );

        const { server, rec } = await spawnRecordVia([process.execPath, launcher]);
        const mcpPid = rec.mcpPid as number;

        expect({ hostPid: rec.hostPid, launcherPid: rec.launcherPid }).toEqual({
          hostPid: process.pid,
          launcherPid: server.pid,
        });
        expect(mcpPid).not.toBe(process.pid);
        expect(mcpPid).not.toBe(server.pid);
        expect(pidAlive(mcpPid)).toBe(true);
        expect(ppidOf(mcpPid)).toBe(server.pid);
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)("REQ-3 the installed npm path for real (9a)", () => {
  const launcherScript = join(PACKAGE_DIR, "bin", "claudish.cjs");
  const distEntry = join(PACKAGE_DIR, "dist", "index.js");

  beforeAll(() => {
    if (!existsSync(distEntry)) {
      const build = Bun.spawnSync(["bun", "run", "build"], {
        cwd: PACKAGE_DIR,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (build.exitCode !== 0)
        throw new Error(
          `9a needs a build and \`bun run build\` failed:\n${build.stderr.toString()}`
        );
    }
  }, 180_000);

  test(
    "node bin/claudish.cjs --mcp: hostPid is the test process, launcherPid the node launcher, mcpPid the bun grandchild",
    async () => {
      const node = Bun.which("node");
      if (!node) throw new Error("9a needs `node` on PATH");
      if (!existsSync(launcherScript))
        throw new Error(`9a: missing the npm launcher at ${launcherScript}`);

      const { server, rec } = await spawnRecordVia([node as string, launcherScript, "--mcp"]);
      const mcpPid = rec.mcpPid as number;

      expect({ hostPid: rec.hostPid, launcherPid: rec.launcherPid }).toEqual({
        hostPid: process.pid,
        launcherPid: server.pid,
      });
      expect(mcpPid).not.toBe(process.pid);
      expect(mcpPid).not.toBe(server.pid);
      expect(ppidOf(mcpPid)).toBe(server.pid);
    },
    T_TEST
  );
});
