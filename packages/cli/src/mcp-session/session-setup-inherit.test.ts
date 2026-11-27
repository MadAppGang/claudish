/** Process-level coverage for caller setup inheritance in a real headless magmux pane. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import { FINISH_PANE_TEST_HOOK_MS, FINISH_PANE_TEST_MS } from "../test-helpers/team-pane.js";
import { SessionManager } from "./session-manager.js";

const T_PANE = 30_000;

type ChildProbe = { argv: string[]; env: Record<string, string>; cwd: string };
type InheritedSettings = { enabledPlugins: Record<string, boolean>; model?: string };
type McpConfigFile = { mcpServers: Record<string, unknown> };

/** The inherited MCP server file's name in the session dir. */
const INHERITED_MCP = "inherited-mcp.json";

/** A caller `.mcp.json` server whose argument names a variable the child must expand itself. */
const KEEP_SERVER = { command: "/bin/sh", args: ["-c", "echo ${SOME_VAR} > /dev/null"] };
const DROPPED_SERVER = { command: "/usr/bin/true", args: [] };
const LOCAL_SERVER = { type: "stdio", command: "/usr/bin/true", args: ["local"] };

function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** `.mcp.json` with `keep` and `dropped`, and a local settings file that disables `dropped`. */
function writeCallerMcp(caller: string): void {
  put(join(caller, ".mcp.json"), { mcpServers: { keep: KEEP_SERVER, dropped: DROPPED_SERVER } });
  put(join(caller, ".claude", "settings.local.json"), { disabledMcpjsonServers: ["dropped"] });
}

/** A main checkout: a `.git` directory, as Git lays it out. */
function mainCheckout(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

/** A linked worktree `worktree` of the main checkout `main`, written as Git lays it out. */
function linkedWorktree(main: string, worktree: string): void {
  const gitDir = join(main, ".git", "worktrees", "wt");
  mkdirSync(gitDir, { recursive: true });
  put(join(gitDir, "commondir"), "../..\n");
  put(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
}

/** Claude Code's global config holding local-scope servers keyed by `projectKey`. */
function writeLocalScope(file: string, projectKey: string, servers: Record<string, unknown>): void {
  put(file, { projects: { [projectKey]: { mcpServers: servers } } });
}

/** Every `--mcp-config` token in an argv, in both spellings. */
function mcpConfigTokens(argv: string[]): string[] {
  return argv.filter((arg) => arg === "--mcp-config" || arg.startsWith("--mcp-config="));
}

function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(check, 20);
    };
    check();
  });
}

describe.skipIf(!MAGMUX)(
  `SessionCreateOptions setup inheritance (${MAGMUX ? "magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    let t: PaneTestEnv;
    let sessionsDir: string;
    let probe: string;
    let managers: SessionManager[];

    beforeEach(() => {
      t = makePaneTestEnv();
      sessionsDir = join(t.tmp, "sessions");
      probe = join(t.tmp, "probe-{session}.json");
      managers = [];
    });

    afterEach(async () => {
      for (const m of managers) await m.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot }, FINISH_PANE_TEST_MS);
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    }, FINISH_PANE_TEST_HOOK_MS);

    function makeManager(env: Record<string, string> = t.env): SessionManager {
      // An empty managed dir: the machine's own managed files never decide a result here.
      const managed = join(t.tmp, "managed");
      const manager = new SessionManager({
        sessionsDir,
        hostPid: 1,
        parentEnv: { ...env, FAKE_PROBE_FILE: probe },
        paneTimings: { replStableMs: 200 },
        managedPaths: {
          managedSettingsFile: join(managed, "managed-settings.json"),
          managedSettingsDropInDir: join(managed, "managed-settings.d"),
          managedMcpFile: join(managed, "managed-mcp.json"),
        },
      });
      managers.push(manager);
      return manager;
    }

    async function childProbe(manager: SessionManager, sessionId: string): Promise<ChildProbe> {
      const path = probe.replace("{session}", manager.getSession(sessionId).claudeSessionId);
      await waitUntil(() => existsSync(path));
      return JSON.parse(readFileSync(path, "utf-8")) as ChildProbe;
    }

    async function expectInheritedSession(claudishFlags: string[]): Promise<InheritedSettings> {
      const caller = join(t.tmp, "caller");
      const work = join(t.tmp, "work");
      mkdirSync(join(caller, ".claude"), { recursive: true });
      mkdirSync(work);
      const callerSettings = join(caller, ".claude", "settings.json");
      writeFileSync(callerSettings, '{"enabledPlugins":{"dev@magus":true}}\n');
      const before = readFileSync(callerSettings);
      const manager = makeManager();

      const sessionId = await manager.createSession({
        model: "fake-env_probe",
        cwd: work,
        setupFrom: caller,
        claudishFlags,
      });
      const child = await childProbe(manager, sessionId);
      const sessionDir = join(sessionsDir, sessionId);
      expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
      expect(child.argv.filter((arg) => arg === "--settings")).toHaveLength(1);
      expect(child.argv.some((arg) => arg.startsWith("--settings="))).toBe(false);
      const settingsPath = child.argv[child.argv.indexOf("--settings") + 1];
      expect(isAbsolute(settingsPath)).toBe(true);
      expect(settingsPath).toBe(join(sessionDir, "inherited-settings.json"));
      expect(settingsPath.startsWith(`${sessionsDir}${sep}`)).toBe(true);
      expect(settingsPath.startsWith(`${work}${sep}`)).toBe(false);
      expect(settingsPath.startsWith(`${caller}${sep}`)).toBe(false);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as InheritedSettings;
      expect(settings.enabledPlugins["dev@magus"]).toBe(true);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      expect(child.cwd).toBe(realpathSync(work));
      const spawn = JSON.parse(readFileSync(join(sessionDir, "spawn.json"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(spawn.setupFrom).toBe(caller);

      await manager.shutdownAll();
      expect(readdirSync(work)).toEqual([]);
      expect(readFileSync(callerSettings)).toEqual(before);
      return settings;
    }

    test(
      "inherits caller plugins through one private settings file outside the work directory",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        await expectInheritedSession([]);
      },
      T_PANE
    );

    test(
      "merges a caller settings flag into the inherited file without adding another settings flag",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        const settings = await expectInheritedSession(["--settings", '{"model":"c"}']);
        expect(settings.model).toBe("c");
      },
      T_PANE
    );

    test(
      "omitting setupFrom adds no settings flag, inherited file, or spawn metadata",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        const work = join(t.tmp, "work");
        mkdirSync(work);
        const manager = makeManager();
        const sessionId = await manager.createSession({
          model: "fake-env_probe",
          cwd: work,
          claudishFlags: [],
        });
        const child = await childProbe(manager, sessionId);
        const sessionDir = join(sessionsDir, sessionId);

        expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
        expect(
          child.argv.filter((arg) => arg === "--settings" || arg.startsWith("--settings="))
        ).toEqual([]);
        expect(existsSync(join(sessionDir, "inherited-settings.json"))).toBe(false);
        const spawn = JSON.parse(readFileSync(join(sessionDir, "spawn.json"), "utf-8")) as Record<
          string,
          unknown
        >;
        expect(spawn).not.toHaveProperty("setupFrom");
        expect(child.cwd).toBe(realpathSync(work));

        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );

    /** Start an env_probe child and return its argv probe and session dir. */
    async function startChild(
      manager: SessionManager,
      opts: { cwd: string; setupFrom?: string; claudishFlags: string[] }
    ): Promise<{ child: ChildProbe; sessionDir: string }> {
      const sessionId = await manager.createSession({ model: "fake-env_probe", ...opts });
      const child = await childProbe(manager, sessionId);
      return { child, sessionDir: join(sessionsDir, sessionId) };
    }

    function readInheritedMcp(child: ChildProbe, sessionDir: string): McpConfigFile {
      const mcpPath = join(sessionDir, INHERITED_MCP);
      expect(mcpConfigTokens(child.argv)).toEqual(["--mcp-config"]);
      expect(child.argv[child.argv.indexOf("--mcp-config") + 1]).toBe(mcpPath);
      expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
      return JSON.parse(readFileSync(mcpPath, "utf-8")) as McpConfigFile;
    }

    function expectNoInheritedMcp(child: ChildProbe, sessionDir: string): void {
      expect(mcpConfigTokens(child.argv)).toEqual([]);
      expect(existsSync(join(sessionDir, INHERITED_MCP))).toBe(false);
    }

    test(
      "hands a work_dir child outside the caller's tree the caller's .mcp.json servers in one private --mcp-config file",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        writeCallerMcp(caller);
        mkdirSync(work);
        const manager = makeManager({ ...t.env, SOME_VAR: "expanded-secret" });

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: ["--effort", "high"],
        });

        expect(child.argv).toContain("--effort");
        const config = readInheritedMcp(child, sessionDir);
        expect(child.argv.indexOf("--mcp-config")).toBeLessThan(child.argv.indexOf("--effort"));
        expect(Object.keys(config)).toEqual(["mcpServers"]);
        expect(config.mcpServers).toEqual({ keep: KEEP_SERVER });
        const text = readFileSync(join(sessionDir, INHERITED_MCP), "utf-8");
        expect(text).toContain("${SOME_VAR}");
        expect(text).not.toContain("expanded-secret");

        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );

    test(
      "adds no --mcp-config for a work_dir inside the caller's tree, which reads .mcp.json itself",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(caller, "sub");
        writeCallerMcp(caller);
        mkdirSync(work);
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expectNoInheritedMcp(child, sessionDir);
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "adds no --mcp-config when the caller's flags carry --strict-mcp-config",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        writeCallerMcp(caller);
        mkdirSync(work);
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: ["--strict-mcp-config"],
        });

        expect(child.argv).toContain("--strict-mcp-config");
        expectNoInheritedMcp(child, sessionDir);
        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );

    test(
      "adds no --mcp-config when setup inheritance is off",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        writeCallerMcp(caller);
        mkdirSync(work);
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, { cwd: work, claudishFlags: [] });

        expectNoInheritedMcp(child, sessionDir);
        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );

    test(
      "hands a separate repository inside the caller's tree the caller's local-scope servers from HOME's .claude.json",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(caller, "nested-repo");
        mainCheckout(caller);
        mainCheckout(work);
        writeLocalScope(join(t.home, ".claude.json"), caller, { localsrv: LOCAL_SERVER });
        const { CLAUDE_CONFIG_DIR: _configDir, ...homeOnly } = t.env;
        const manager = makeManager(homeOnly);

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expect(readInheritedMcp(child, sessionDir).mcpServers).toEqual({ localsrv: LOCAL_SERVER });
        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([".git"]);
      },
      T_PANE
    );

    test(
      "reads local-scope servers from CLAUDE_CONFIG_DIR's .claude.json when it is set",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(caller, "nested-repo");
        mainCheckout(caller);
        mainCheckout(work);
        writeLocalScope(join(t.configDir, ".claude.json"), caller, { localsrv: LOCAL_SERVER });
        writeLocalScope(join(t.home, ".claude.json"), caller, { homesrv: LOCAL_SERVER });
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expect(readInheritedMcp(child, sessionDir).mcpServers).toEqual({ localsrv: LOCAL_SERVER });
        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([".git"]);
      },
      T_PANE
    );

    test(
      "puts the inherited --mcp-config before the caller's own --mcp-config, so the caller's file wins a name clash",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        writeCallerMcp(caller);
        mkdirSync(work);
        const own = join(t.tmp, "own-mcp.json");
        put(own, { mcpServers: { keep: DROPPED_SERVER } });
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: ["--mcp-config", own],
        });

        const inheritedPath = join(sessionDir, INHERITED_MCP);
        const configs = child.argv.flatMap((arg, i) =>
          arg === "--mcp-config" ? [child.argv[i + 1]] : []
        );
        expect(configs).toEqual([inheritedPath, own]);
        expect(statSync(inheritedPath).mode & 0o777).toBe(0o600);
        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );

    test(
      "adds no --mcp-config for a linked worktree of the caller's repository inside its tree",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(caller, "wt");
        mainCheckout(caller);
        linkedWorktree(caller, work);
        writeLocalScope(join(t.configDir, ".claude.json"), caller, { localsrv: LOCAL_SERVER });
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expectNoInheritedMcp(child, sessionDir);
        await manager.shutdownAll();
      },
      T_PANE
    );
  }
);
