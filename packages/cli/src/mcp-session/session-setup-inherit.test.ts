/** Process-level coverage for caller setup inheritance in a real headless magmux pane. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

import * as logger from "../logger.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import { FINISH_PANE_TEST_HOOK_MS, FINISH_PANE_TEST_MS } from "../test-helpers/team-pane.js";
import type { HostLaunchReader } from "./host-launch.js";
import { SessionManager } from "./session-manager.js";
import {
  type FakeClaude,
  processAlive,
  writeFakeClaude,
} from "./test-helpers/fake-claude-plugin-probe.js";

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
    let fake: FakeClaude;

    beforeEach(() => {
      t = makePaneTestEnv();
      sessionsDir = join(t.tmp, "sessions");
      probe = join(t.tmp, "probe-{session}.json");
      managers = [];
      const fakeDir = join(t.tmp, "fake-claude");
      mkdirSync(fakeDir);
      fake = writeFakeClaude(fakeDir);
    });

    afterEach(async () => {
      for (const m of managers) await m.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot }, FINISH_PANE_TEST_MS);
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    }, FINISH_PANE_TEST_HOOK_MS);

    function makeManager(
      env: Record<string, string> = t.env,
      opts: {
        pluginProbeTimeoutMs?: number;
        readHostLaunch?: HostLaunchReader;
      } = {}
    ): SessionManager {
      // An empty managed dir: the machine's own managed files never decide a result here.
      const managed = join(t.tmp, "managed");
      const manager = new SessionManager({
        sessionsDir,
        hostPid: 1,
        // The caller is a plain `claude` launch in the caller repository: no process of the
        // machine is read.
        readHostLaunch: (pid) =>
          pid === 1 ? { argv: ["claude"], cwd: join(t.tmp, "caller"), env: {} } : null,
        pluginPolicyPlatform: "other",
        // The plugin probe runs the fake `claude`, never Claude Code.
        parentEnv: {
          ...env,
          FAKE_PROBE_FILE: probe,
          CLAUDE_PATH: fake.binary,
          FAKE_CLAUDE_PLAN: fake.planFile,
        },
        ...opts,
        paneTimings: { replStableMs: 200 },
        managedPaths: {
          managedSettingsFile: join(managed, "managed-settings.json"),
          managedSettingsDropInDir: join(managed, "managed-settings.d"),
          managedMcpFile: join(managed, "managed-mcp.json"),
          managedPreferencePlists: [
            join(managed, "prefs", "user", "com.anthropic.claudecode.plist"),
            join(managed, "prefs", "com.anthropic.claudecode.plist"),
          ],
          remoteSettingsFile: join(managed, "remote-settings.json"),
          hybridSettingsDir: join(managed, "state"),
          registryPolicyKeys: [],
          // the plists are JSON text here: no plutil, and nothing under /Library
          readPlist: (path) => readFileSync(path, "utf-8"),
        },
      });
      managers.push(manager);
      return manager;
    }

    async function childProbe(manager: SessionManager, sessionId: string): Promise<ChildProbe> {
      const path = probe.replace("{session}", manager.getSession(sessionId).claudeSessionId);
      // the child writes the file in more than one write: wait until it parses, not until it exists
      let parsed: ChildProbe | null = null;
      await waitUntil(() => {
        try {
          parsed = JSON.parse(readFileSync(path, "utf-8")) as ChildProbe;
          return true;
        } catch {
          return false;
        }
      });
      return parsed as unknown as ChildProbe;
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

    /* ───────────── the caller's plugin copies, from the plugin probe ───────────── */

    type Loaded = { name: string; path: string; source: string; version?: string };

    /** A plugin copy under the test's temp dir whose manifest names it `name`. */
    function pluginCopy(name: string, version: string, folder = name): string {
      const dir = join(t.tmp, "cache", "m", folder, version);
      put(join(dir, ".claude-plugin", "plugin.json"), { name, version });
      return dir;
    }

    const loaded = (name: string, path: string, version?: string): Loaded => ({
      name,
      path,
      source: `${name}@m`,
      ...(version ? { version } : {}),
    });

    /** Every `--plugin-dir` value in an argv, in order; fails on the `=` spelling. */
    function pluginDirs(argv: string[]): string[] {
      expect(argv.some((arg) => arg.startsWith("--plugin-dir="))).toBe(false);
      return argv.flatMap((arg, i) => (arg === "--plugin-dir" ? [argv[i + 1] as string] : []));
    }

    function spawnRecord(sessionDir: string): Record<string, unknown> {
      return JSON.parse(readFileSync(join(sessionDir, "spawn.json"), "utf-8")) as Record<
        string,
        unknown
      >;
    }

    /** Every fake probe run so far is gone. */
    function expectProbesGone(): void {
      for (const run of fake.runs()) expect(processAlive(run.pid)).toBe(false);
    }

    function expectNoInheritedPlugins(child: ChildProbe, sessionDir: string): void {
      expect(pluginDirs(child.argv)).toEqual([]);
      expect(spawnRecord(sessionDir)).not.toHaveProperty("inheritedPlugins");
    }

    /**
     * The probe lists of a caller at `caller` (created, a main checkout) and a `work` (created):
     * the caller loads alpha 2.0.0, gamma 1.0.0, beta 1.0.0, a caller `@inline` copy and a
     * builtin; the child loads alpha 1.0.0 and gamma 1.0.0.
     */
    function scriptProbes(
      caller: string,
      work: string,
      opts: { alphaFolder?: string } = {}
    ): { alpha2: string; beta1: string } {
      mainCheckout(caller);
      mkdirSync(work, { recursive: true });
      const alpha2 = pluginCopy("alpha", "2.0.0", opts.alphaFolder);
      const alpha1 = pluginCopy("alpha", "1.0.0", opts.alphaFolder);
      const beta1 = pluginCopy("beta", "1.0.0");
      const gamma1 = pluginCopy("gamma", "1.0.0");
      const own = pluginCopy("own", "0.1.0");
      fake.setPlan({
        mode: "ok",
        lists: {
          [realpathSync(caller)]: [
            loaded("alpha", alpha2, "2.0.0"),
            loaded("gamma", gamma1, "1.0.0"),
            loaded("beta", beta1, "1.0.0"),
            { name: "own", path: own, source: "own@inline", version: "0.1.0" },
            { name: "cc-plugin-privacy", path: "builtin", source: "cc-plugin-privacy@builtin" },
          ],
          [realpathSync(work)]: [
            loaded("alpha", alpha1, "1.0.0"),
            loaded("gamma", gamma1, "1.0.0"),
          ],
        },
      });
      return { alpha2, beta1 };
    }

    test(
      "hands an outside work_dir child the caller's copies the two probes disagree on, after the inherited --mcp-config and before the caller's flags",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        const { alpha2, beta1 } = scriptProbes(caller, work);
        writeCallerMcp(caller);
        // the empty server-managed cache an ordinary login leaves does not stop the probes
        put(join(t.tmp, "managed", "remote-settings.json"), "{}");
        const manager = makeManager({ ...t.env, ANTHROPIC_API_KEY: "sk-ant-probe-never-sees" });

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: ["--effort", "high"],
        });

        expect(pluginDirs(child.argv)).toEqual([alpha2, beta1]);
        const at = (token: string) => child.argv.indexOf(token);
        const firstPluginDir = at("--plugin-dir");
        expect(at("--mcp-config")).toBeLessThan(firstPluginDir);
        expect(child.argv[firstPluginDir - 1]).toBe(join(sessionDir, INHERITED_MCP));
        expect(child.argv.slice(firstPluginDir, firstPluginDir + 5)).toEqual([
          "--plugin-dir",
          alpha2,
          "--plugin-dir",
          beta1,
          "--effort",
        ]);
        const spawn = spawnRecord(sessionDir);
        expect(spawn.inheritedPlugins).toEqual([
          { id: "alpha@m", version: "2.0.0" },
          { id: "beta@m", version: "1.0.0" },
        ]);
        expect(spawn.pluginProbe).toBe("ok");
        expect(readFileSync(join(sessionDir, "spawn.json"), "utf-8")).not.toContain(
          join(t.tmp, "cache")
        );

        const runs = fake.runs();
        expect(runs.map((r) => r.cwd).sort()).toEqual(
          [realpathSync(caller), realpathSync(work)].sort()
        );
        for (const run of runs) {
          expect(run.baseUrl).toBe("http://127.0.0.1:9");
          expect(run.credentialVars).toEqual([]);
          expect(run.argv.slice(-2)).toEqual(["-p", "/effort"]);
          expect(run.argv).not.toContain("--effort");
          const settings = run.settings as {
            disableAllHooks?: unknown;
            env?: Record<string, string>;
          };
          expect(settings.disableAllHooks).toBe(true);
          expect(settings.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9");
          expect(settings.env?.ANTHROPIC_API_KEY).toBe("");
        }
        expectProbesGone();
        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );

    test(
      "starts no probe and hands no --plugin-dir to a child in the same repository",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(caller, "sub");
        scriptProbes(caller, work);
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expectNoInheritedPlugins(child, sessionDir);
        expect(spawnRecord(sessionDir)).not.toHaveProperty("pluginProbe");
        expect(fake.runs()).toEqual([]);
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "starts no probe when setup inheritance is off",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        scriptProbes(caller, work);
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, { cwd: work, claudishFlags: [] });

        expectNoInheritedPlugins(child, sessionDir);
        expect(fake.runs()).toEqual([]);
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "starts no probe and hands no --plugin-dir and no --mcp-config under a managed disableSideloadFlags",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        scriptProbes(caller, work);
        writeCallerMcp(caller);
        put(join(t.tmp, "managed", "managed-settings.json"), { disableSideloadFlags: true });
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expectNoInheritedPlugins(child, sessionDir);
        expectNoInheritedMcp(child, sessionDir);
        expect(spawnRecord(sessionDir).pluginProbe).toBe("managed_policy_present");
        expect(fake.runs()).toEqual([]);
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "a probe that prints an assistant event, never prints init, exits 1, prints malformed plugins or ends on a fatal result hands over nothing, logs why, and is gone",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        scriptProbes(caller, work);
        const { lists } = JSON.parse(readFileSync(fake.planFile, "utf-8")) as {
          lists: Record<string, unknown[]>;
        };
        const manager = makeManager(t.env, { pluginProbeTimeoutMs: 1_000 });
        const cases = [
          ["assistant", "assistant_before_init"],
          ["noinit", "timeout"],
          ["exit1", "exited_before_init"],
          ["malformed", "plugins_malformed"],
          ["fatal", "bad_result"],
        ] as const;

        for (const [mode, cause] of cases) {
          fake.setPlan({ mode, lists });
          const logged = spyOn(logger, "log").mockImplementation(() => {});
          let started: { child: ChildProbe; sessionDir: string };
          let lines: string[];
          try {
            started = await startChild(manager, {
              cwd: work,
              setupFrom: caller,
              claudishFlags: [],
            });
          } finally {
            lines = logged.mock.calls.map((c) => String(c[0]));
            logged.mockRestore();
          }
          expect(lines.filter((l) => l.includes(cause))).toHaveLength(1);
          expectNoInheritedPlugins(started.child, started.sessionDir);
          expect(spawnRecord(started.sessionDir).pluginProbe).toBe(cause);
          expectProbesGone();
        }
        await manager.shutdownAll();
      },
      T_PANE * 2
    );

    test(
      "hands a plugin path with a space over as one argv token",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        const { alpha2 } = scriptProbes(caller, work, { alphaFolder: "alpha sp" });
        const manager = makeManager();

        const { child } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expect(alpha2).toContain(" ");
        expect(pluginDirs(child.argv)[0]).toBe(alpha2);
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "a shutdown while the plugin probes hang kills them, removes their settings files and starts no pane",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        scriptProbes(caller, work);
        const { lists } = JSON.parse(readFileSync(fake.planFile, "utf-8")) as {
          lists: Record<string, unknown[]>;
        };
        fake.setPlan({ mode: "noinit", lists });
        const manager = makeManager(t.env, { pluginProbeTimeoutMs: 25_000 });

        const logged = spyOn(logger, "log").mockImplementation(() => {});
        let created: { error?: unknown };
        try {
          const creating = manager
            .createSession({ model: "fake-env_probe", cwd: work, setupFrom: caller })
            .then(
              () => ({}),
              (error: unknown) => ({ error })
            );
          await waitUntil(() => fake.runs().length === 2);
          const shutdownStarted = Date.now();
          await manager.shutdownAll();
          // the hung probes are killed, not waited out
          expect(Date.now() - shutdownStarted).toBeLessThan(10_000);
          expectProbesGone();
          created = await creating;
        } finally {
          logged.mockRestore();
        }

        expect(String(created.error)).toContain("shutting down");
        for (const run of fake.runs()) {
          const settings = run.argv[run.argv.indexOf("--settings") + 1] as string;
          expect(existsSync(settings)).toBe(false);
        }
        expect(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).toEqual([]);
      },
      T_PANE
    );

    test(
      "a start that enters while a shutdown is under way starts no probe and no pane",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        scriptProbes(caller, work);
        const { lists } = JSON.parse(readFileSync(fake.planFile, "utf-8")) as {
          lists: Record<string, unknown[]>;
        };
        fake.setPlan({ mode: "noinit", lists });
        const manager = makeManager(t.env, { pluginProbeTimeoutMs: 4_000 });
        const settle = (p: Promise<string>) =>
          p.then(
            () => ({}),
            (error: unknown) => ({ error })
          );

        const logged = spyOn(logger, "log").mockImplementation(() => {});
        let first: { error?: unknown };
        let late: { error?: unknown };
        try {
          const creating = settle(
            manager.createSession({ model: "fake-env_probe", cwd: work, setupFrom: caller })
          );
          await waitUntil(() => fake.runs().length === 2);
          // the shutdown has begun and is waiting on the first start when the second arrives
          const shutdown = manager.shutdownAll();
          const lateStart = settle(
            manager.createSession({ model: "fake-env_probe", cwd: work, setupFrom: caller })
          );
          await shutdown;
          first = await creating;
          late = await lateStart;
          // a late start that slipped through would be probing now
          await Bun.sleep(500);
        } finally {
          logged.mockRestore();
        }

        expect(String(first.error)).toContain("shutting down");
        expect(String(late.error)).toContain("shutting down");
        expect(fake.runs()).toHaveLength(2);
        expectProbesGone();
        expect(existsSync(sessionsDir) ? readdirSync(sessionsDir) : []).toEqual([]);
      },
      T_PANE
    );

    test(
      "does not hand over a plugin the caller's --settings turn off for the child",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        const { beta1 } = scriptProbes(caller, work);
        const manager = makeManager();

        const logged = spyOn(logger, "log").mockImplementation(() => {});
        let started: { child: ChildProbe; sessionDir: string };
        try {
          started = await startChild(manager, {
            cwd: work,
            setupFrom: caller,
            claudishFlags: ["--settings", '{"enabledPlugins":{"alpha@m":false}}'],
          });
        } finally {
          logged.mockRestore();
        }

        expect(pluginDirs(started.child.argv)).toEqual([beta1]);
        expect(spawnRecord(started.sessionDir).inheritedPlugins).toEqual([
          { id: "beta@m", version: "1.0.0" },
        ]);
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "does not hand over a plugin the caller's own launch --settings turn off, read from the host process",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        const { beta1 } = scriptProbes(caller, work);
        // The fake lists alpha for the caller only when its settings do not turn it off.
        const plan = JSON.parse(readFileSync(fake.planFile, "utf-8")) as {
          lists: Record<string, unknown[]>;
        };
        fake.setPlan({ mode: "ok", lists: plan.lists, unlessDisabled: true });
        // the caller probe runs in the host's cwd, which reads the relative --settings path
        put(join(caller, "launch.json"), { enabledPlugins: { "alpha@m": false } });
        const manager = makeManager(t.env, {
          readHostLaunch: () => ({
            argv: ["/Users/u/.local/bin/claude", "--settings", "launch.json"],
            cwd: realpathSync(caller),
            env: {},
          }),
        });

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expect(pluginDirs(child.argv)).toEqual([beta1]);
        expect(spawnRecord(sessionDir).pluginProbe).toBe("ok");
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "starts no probe and hands no --plugin-dir when the caller's launch cannot be read",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        scriptProbes(caller, work);
        writeCallerMcp(caller);
        const manager = makeManager(t.env, { readHostLaunch: () => null });

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expectNoInheritedPlugins(child, sessionDir);
        expect(spawnRecord(sessionDir).pluginProbe).toBe("caller_argv_unreadable");
        // the MCP hand-over does not depend on the caller's argv
        expect(readInheritedMcp(child, sessionDir).mcpServers).toBeDefined();
        expect(fake.runs()).toEqual([]);
        await manager.shutdownAll();
      },
      T_PANE
    );

    test(
      "starts no probe and hands no --plugin-dir and no --mcp-config under a managed preference plist disableSideloadFlags",
      async () => {
        const caller = join(t.tmp, "caller");
        const work = join(t.tmp, "work");
        scriptProbes(caller, work);
        writeCallerMcp(caller);
        put(join(t.tmp, "managed", "prefs", "com.anthropic.claudecode.plist"), {
          disableSideloadFlags: true,
        });
        const manager = makeManager();

        const { child, sessionDir } = await startChild(manager, {
          cwd: work,
          setupFrom: caller,
          claudishFlags: [],
        });

        expectNoInheritedPlugins(child, sessionDir);
        expectNoInheritedMcp(child, sessionDir);
        expect(spawnRecord(sessionDir).pluginProbe).toBe("managed_policy_present");
        expect(fake.runs()).toEqual([]);
        await manager.shutdownAll();
      },
      T_PANE
    );
  }
);
