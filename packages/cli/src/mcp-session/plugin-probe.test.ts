/**
 * The plugin probe: which plugin copies Claude Code loads in setup_from and in work_dir, and
 * which caller copies a work_dir child is handed. Pure parts run on an injected runner; the
 * spawner runs a fake `claude` (test-helpers/fake-claude-plugin-probe.ts), never Claude Code.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shellLookup } from "../claude-runner.js";
import * as logger from "../logger.js";
import { readHostLaunch } from "./host-launch.js";
import { type ManagedPaths, buildInheritedSettingsLayer } from "./inherited-settings.js";
import {
  type LoadedPlugin,
  PLUGIN_PROBE_BASE_URL,
  type PluginProbeRequest,
  type PluginProbeResult,
  type PluginProbeRunner,
  callerLaunchFlags,
  inheritedPluginsFor,
  initPluginsOf,
  pluginProbeArgs,
  pluginProbeEnv,
  pluginProbeRunner,
  pluginProbeSettings,
  pluginsToHandOver,
  policyPlatformOf,
  spawnPluginProbe,
  sweepStaleProbeDirs,
} from "./plugin-probe.js";
import { CALLER_LAUNCH_ENV_KEYS, PROBE_MODE_VARS, PROBE_PLUGIN_VARS } from "./probe-launch-vars.js";
import { processAlive, writeFakeClaude } from "./test-helpers/fake-claude-plugin-probe.js";

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "claudish-pprobe-test-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function mkdirP(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** A plugin copy whose manifest names it `name` (none when `name` is null). */
function pluginCopy(folder: string, name: string | null): string {
  const dir = mkdirP(join(tmp, "cache", folder));
  if (name !== null) put(join(dir, ".claude-plugin", "plugin.json"), { name, version: "x" });
  return dir;
}

const entry = (name: string, path: string, source: string, version?: string): LoadedPlugin => ({
  name,
  path,
  source,
  ...(version !== undefined ? { version } : {}),
});

/** Every line `action` writes through `logger.log`, with the logger silenced meanwhile. */
async function logsOf<T>(action: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const logged = spyOn(logger, "log").mockImplementation(() => {});
  try {
    const value = await action();
    return { value, lines: logged.mock.calls.map((c) => String(c[0])) };
  } finally {
    logged.mockRestore();
  }
}

/**
 * Every managed policy source under `dir/managed`, none present until a test writes it. The
 * plists are read as JSON text by a stand-in for plutil, so these tests run off macOS too.
 */
const managedIn = (dir: string): ManagedPaths => ({
  managedSettingsFile: join(dir, "managed", "managed-settings.json"),
  managedSettingsDropInDir: join(dir, "managed", "managed-settings.d"),
  managedMcpFile: join(dir, "managed", "managed-mcp.json"),
  managedPreferencePlists: [
    join(dir, "managed", "prefs", "user", "com.anthropic.claudecode.plist"),
    join(dir, "managed", "prefs", "com.anthropic.claudecode.plist"),
  ],
  remoteSettingsFile: join(dir, "managed", "config", "remote-settings.json"),
  hybridSettingsDir: join(dir, "managed", "config", "state"),
  registryPolicyKeys: [],
  readPlist: (path) => readFileSync(path, "utf-8"),
});

/**
 * The caller's Claude Code process as the probe reads it: a native `claude` launched in
 * `cwd` with `flags`. The default host of every handover test, launched in the caller
 * repository of `world()`.
 */
function hostWith(
  flags: string[] = [],
  cwd = join(tmp, "caller"),
  env: Record<string, string> | null = {}
) {
  return {
    hostPid: 4242,
    readHostLaunch: (pid: number) =>
      pid === 4242 ? { argv: ["/Users/u/.local/bin/claude", ...flags], cwd, env } : null,
    policyPlatform: "other" as const,
  };
}

describe("sweepStaleProbeDirs", () => {
  const aged = (path: string, minutes: number, now: number) => {
    const at = new Date(now - minutes * 60_000);
    utimesSync(path, at, at);
    return path;
  };

  test("removes a probe folder whose server pid is gone at any age, and keeps a live server's fresh one", () => {
    const root = mkdirP(join(tmp, "tmproot"));
    const now = Date.now();
    const dead = mkdirP(join(root, "claudish-plugin-probe-91001-AbC123"));
    put(join(dead, "caller-settings.json"), { env: { X: "1" } });
    aged(dead, 0, now);
    const live = aged(mkdirP(join(root, "claudish-plugin-probe-91002-XyZ789")), 2, now);
    const alive = (pid: number) => pid === 91002;

    sweepStaleProbeDirs({ root, now, alive });

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("removes a live pid's folder only once it is older than any probe runs: the pid was reused", () => {
    const root = mkdirP(join(tmp, "tmproot"));
    const now = Date.now();
    const reused = aged(mkdirP(join(root, "claudish-plugin-probe-91002-Old001")), 11, now);
    const unnamed = aged(mkdirP(join(root, "claudish-plugin-probe-AbC123")), 11, now);
    const unnamedFresh = aged(mkdirP(join(root, "claudish-plugin-probe-AbC124")), 2, now);

    sweepStaleProbeDirs({ root, now, alive: () => true });

    expect(existsSync(reused)).toBe(false);
    expect(existsSync(unnamed)).toBe(false);
    expect(existsSync(unnamedFresh)).toBe(true);
  });

  test("leaves anything else: another name, a file, and a symlink to a probe-named folder", () => {
    const root = mkdirP(join(tmp, "tmproot"));
    const now = Date.now();
    const otherName = aged(mkdirP(join(root, "claudish-plugin-probe-toolong1")), 60, now);
    const file = join(root, "claudish-plugin-probe-91001-File01");
    put(file, "x");
    const target = mkdirP(join(tmp, "elsewhere"));
    const link = join(root, "claudish-plugin-probe-91001-Link01");
    symlinkSync(target, link);

    sweepStaleProbeDirs({ root, now, alive: () => false });

    for (const kept of [otherName, file, link, target]) expect(existsSync(kept)).toBe(true);
  });

  test("never throws for a root that cannot be listed", () => {
    expect(() => sweepStaleProbeDirs({ root: join(tmp, "missing") })).not.toThrow();
  });
});

describe("pluginProbeArgs", () => {
  test("is the quiet /effort probe with only the plugin-loading flags it is given, /effort last", () => {
    const child = mkdirP(join(tmp, "work"));
    const args = pluginProbeArgs(
      "/s/probe-settings.json",
      [
        "--effort",
        "high",
        "--plugin-dir",
        "rel/own",
        "--plugin-dir=/abs/two",
        "--plugin-dir-no-mcp",
        "/abs/three",
        "--plugin-url",
        "https://example.invalid/p.zip",
        "--plugin-url=https://example.invalid/q.zip",
        "--setting-sources=user,project",
        "--mcp-config",
        "/m.json",
        "--settings",
        '{"model":"x"}',
        "--agent",
        "dev:qa",
        "--safe-mode",
        "--bare",
        "--restricted",
      ],
      child
    );

    expect(args).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      "/s/probe-settings.json",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--plugin-dir",
      join(child, "rel", "own"),
      "--plugin-dir",
      "/abs/two",
      "--plugin-dir-no-mcp",
      "/abs/three",
      "--setting-sources",
      "user,project",
      "--safe-mode",
      "--bare",
      "--restricted",
      "-p",
      "/effort",
    ]);
  });

  test("resolves a relative --plugin-dir and --plugin-dir-no-mcp against the directory it is given", () => {
    const a = mkdirP(join(tmp, "a"));
    const b = mkdirP(join(tmp, "b"));
    const flags = ["--plugin-dir", "./extras", "--plugin-dir-no-mcp=../nomcp"];

    expect(pluginProbeArgs("/s.json", flags, a)).toContain(join(a, "extras"));
    expect(pluginProbeArgs("/s.json", flags, a)).toContain(join(tmp, "nomcp"));
    expect(pluginProbeArgs("/s.json", flags, b)).toContain(join(b, "extras"));
  });
});

describe("pluginProbeSettings", () => {
  test("holds disableAllHooks and the closed env block, over any layer value of the same name in any case", () => {
    const settings = pluginProbeSettings({
      enabledPlugins: { "alpha@m": true },
      disableAllHooks: false,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-from-layer",
        anthropic_base_url: "https://gateway.example.invalid",
        Claude_Code_Use_Bedrock: "1",
        claude_code_use_gateway: "1",
        CLAUDE_CODE_USE_MANTLE: "1",
        ANTHROPIC_AWS_BASE_URL: "https://aws.example.invalid",
        CLAUDE_CODE_USE_COWORK_PLUGINS: "1",
        claude_code_enable_proxy_auth_helper: "1",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        KEEP_ME: "1",
      },
    });

    expect(settings).toEqual({
      enabledPlugins: { "alpha@m": true },
      disableAllHooks: true,
      env: {
        CLAUDE_CODE_USE_COWORK_PLUGINS: "1",
        KEEP_ME: "1",
        ANTHROPIC_BASE_URL: PLUGIN_PROBE_BASE_URL,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ...Object.fromEntries(HOST_HANDOFF_VARS.map((key) => [key, ""])),
        CLAUDE_CODE_USE_BEDROCK: "",
        CLAUDE_CODE_USE_VERTEX: "",
        CLAUDE_CODE_USE_FOUNDRY: "",
        CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
        CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
        CLAUDE_CODE_USE_MANTLE: "",
        CLAUDE_CODE_USE_GATEWAY: "",
        ANTHROPIC_BEDROCK_BASE_URL: "",
        ANTHROPIC_VERTEX_BASE_URL: "",
        ANTHROPIC_FOUNDRY_BASE_URL: "",
        ANTHROPIC_AWS_BASE_URL: "",
        ANTHROPIC_GOOGLE_CLOUD_BASE_URL: "",
        ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "",
        CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER: "",
        CLAUDE_CODE_ENABLE_TELEMETRY: "",
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "",
        CLAUDE_CODE_CLIENT_DATA_URL: "",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      },
    });
  });

  test("leaves out every command-valued setting and the hooks of a layer", () => {
    const settings = pluginProbeSettings({
      enabledPlugins: { "alpha@m": true },
      apiKeyHelper: "/bin/echo k",
      statusLine: { type: "command", command: "/bin/echo s" },
      awsAuthRefresh: "/bin/echo a",
      policyHelpers: { macos: { path: "/bin/echo p" } },
      hooks: { SessionStart: [] },
    });

    expect(Object.keys(settings).sort()).toEqual(["disableAllHooks", "enabledPlugins", "env"]);
  });

  test("without a layer holds only disableAllHooks and the closed env block", () => {
    expect(Object.keys(pluginProbeSettings(null)).sort()).toEqual(["disableAllHooks", "env"]);
  });
});

/**
 * Claude Code 2.1.332's launch mode switches, each with a value a launch can carry: every one
 * takes away setting sources, plugins, skills or MCP configs a launch loads.
 */
const LAUNCH_MODE_SWITCHES: Record<string, string> = {
  CLAUDE_CODE_RESTRICTED: "1",
  CLAUDE_CODE_SAFE_MODE: "true",
  CLAUDE_CODE_SIMPLE: "1",
  CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: "1",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
  CLAUDE_CODE_DISABLE_POLICY_SKILLS: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL: "1",
  CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "1",
  CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS_EXCEPT: "canary@canarymkt",
  CLAUDE_CODE_SKIP_PLUGIN_LOCAL_MCP_SERVERS: "1",
  CLAUDE_CODE_SKIP_PLUGIN_MCP_BUNDLES: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

/** The plugin variables the probe takes from the launch it stands for. */
const PLUGIN_VARS_OF_LAUNCH: Record<string, string> = {
  CLAUDE_CODE_PLUGIN_CACHE_DIR: "/cache",
  CLAUDE_CODE_PLUGIN_SEED_DIR: "/seed",
  CLAUDE_CODE_PLUGIN_DIRS: "/dirs",
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: "1",
};

describe("pluginProbeEnv", () => {
  /** The probe's own values, set whatever the parent holds. */
  const FIXED = {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ANTHROPIC_BASE_URL: PLUGIN_PROBE_BASE_URL,
  };

  /** Every name the parent may hand the probe, with the value it holds. */
  const ALLOWED = {
    PATH: "/usr/bin:/bin",
    HOME: "/h",
    USER: "u",
    LOGNAME: "u",
    SHELL: "/bin/zsh",
    TMPDIR: "/tmp/u",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: "/h/.config",
    XDG_DATA_HOME: "/h/.local/share",
    XDG_CACHE_HOME: "/h/.cache",
    CLAUDE_CONFIG_DIR: "/h/.claude",
    CLAUDE_PATH: "/opt/claude",
    CLAUDE_CODE_PLUGIN_CACHE_DIR: "/cache",
    CLAUDE_CODE_PLUGIN_SEED_DIR: "/seed",
    CLAUDE_CODE_PLUGIN_DIRS: "/dirs",
    CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: "1",
  };

  test("hands over each allowlisted name unchanged, beside the probe's own values", () => {
    expect(pluginProbeEnv({ ...ALLOWED, UNSET: undefined })).toEqual({ ...ALLOWED, ...FIXED });
    expect(PLUGIN_PROBE_BASE_URL).toBe("http://127.0.0.1:9");
  });

  test("hands over nothing else: no socket, no handoff, no credential, no previously withheld name, no unknown name", () => {
    const settingsNames = Object.keys(pluginProbeSettings(null).env as Record<string, string>);
    const parent: Record<string, string> = Object.fromEntries(
      settingsNames.map((key) => [key, "parent-value"])
    );
    Object.assign(parent, {
      CLAUDE_CODE_RUNNER_MODEL_SOCKET: "/run/runner.sock",
      ANTHROPIC_UNIX_SOCKET: "/run/anthropic.sock",
      CLAUDE_CODE_HOST_CREDS_FILE: "/run/handoff/creds.json",
      FOO: "bar",
      CLAUDECODE: "1",
      HERDR_PANE: "p",
      CLAUDE_CODE_SYNC_PLUGIN_INSTALL: "1",
      CLAUDE_CODE_USE_COWORK_PLUGINS: "1",
      NODE_OPTIONS: "--require /x.js",
      LCX: "not a locale",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
    });

    expect(pluginProbeEnv(parent)).toEqual(FIXED);
  });

  test("the mode switch, plugin variable and caller key lists are exactly these", () => {
    expect<string[]>([...PROBE_MODE_VARS]).toEqual(Object.keys(LAUNCH_MODE_SWITCHES));
    expect<string[]>([...PROBE_PLUGIN_VARS]).toEqual(Object.keys(PLUGIN_VARS_OF_LAUNCH));
    expect<string[]>([...CALLER_LAUNCH_ENV_KEYS]).toEqual([
      "CLAUDE_CONFIG_DIR",
      ...Object.keys(PLUGIN_VARS_OF_LAUNCH),
      ...Object.keys(LAUNCH_MODE_SWITCHES),
    ]);
  });

  test("passes each launch mode switch the parent holds, with its value, and sets none it lacks", () => {
    expect(pluginProbeEnv({ HOME: "/h", ...LAUNCH_MODE_SWITCHES })).toEqual({
      HOME: "/h",
      ...LAUNCH_MODE_SWITCHES,
      ...FIXED,
    });
    const without = pluginProbeEnv({ HOME: "/h" });
    for (const key of Object.keys(LAUNCH_MODE_SWITCHES)) expect(key in without).toBe(false);
  });

  test("the settings env empties the first-party base URL switches and sets the host-managed marker", () => {
    const env = pluginProbeSettings({
      env: {
        _claude_code_assume_first_party_base_url: "1",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "",
      },
    }).env as Record<string, string>;
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("");
    expect(env.CLAUDE_CODE_CLIENT_DATA_URL).toBe("");
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(env._claude_code_assume_first_party_base_url).toBeUndefined();
  });
});

/**
 * The host credential handoff of Claude Code 2.1.332: under the host-managed marker `REr()`
 * reads `CLAUDE_CODE_HOST_CREDS_FILE` and can restore `ANTHROPIC_AUTH_TOKEN`; the others name
 * the bearer variable, start or time a host token refresh, or hand a credential over a file
 * descriptor or a file.
 */
const HOST_HANDOFF_VARS = [
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_AUTH_ASK_AT_START",
  "CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_LAUNCHER_RUNS_API_KEY_HELPER",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
];

describe("the host credential handoff", () => {
  test("the probe's environment carries no handoff variable, whatever the parent holds", () => {
    const parent = Object.fromEntries(HOST_HANDOFF_VARS.map((key) => [key, "/handoff/x"]));
    const env = pluginProbeEnv({ ...parent, HOME: "/h" });

    for (const key of HOST_HANDOFF_VARS) expect(env[key]).toBeUndefined();
    expect(env.HOME).toBe("/h");
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  test("ANTHROPIC_UNIX_SOCKET is left out of the settings env", () => {
    const settingsEnv = pluginProbeSettings(null).env as Record<string, string>;
    expect("ANTHROPIC_UNIX_SOCKET" in settingsEnv).toBe(false);
  });

  test("a launcher's creds file next to the marker does not reach the probe", () => {
    const env = pluginProbeEnv({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_HOST_CREDS_FILE: "/run/handoff/creds.json",
    });

    expect(env.CLAUDE_CODE_HOST_CREDS_FILE).toBeUndefined();
  });

  test("the settings env sets every handoff variable empty, over a layer value of the same name in any case", () => {
    const layerEnv = Object.fromEntries(
      HOST_HANDOFF_VARS.map((key) => [key.toLowerCase(), "/handoff/x"])
    );
    const env = pluginProbeSettings({ env: layerEnv }).env as Record<string, string>;

    for (const key of HOST_HANDOFF_VARS) {
      expect(env[key]).toBe("");
      expect(env[key.toLowerCase()]).toBeUndefined();
    }
    expect(
      (pluginProbeSettings(null).env as Record<string, string>).CLAUDE_CODE_HOST_CREDS_FILE
    ).toBe("");
  });
});

describe("initPluginsOf", () => {
  test("reads name, path, source and version of every entry, builtins included", () => {
    const plugins = initPluginsOf({
      type: "system",
      subtype: "init",
      plugins: [
        { name: "alpha", path: "/c/alpha/2.0.0", source: "alpha@m", version: "2.0.0" },
        { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
      ],
    });

    expect(plugins).toEqual([
      entry("alpha", "/c/alpha/2.0.0", "alpha@m", "2.0.0"),
      entry("cc-plugin-telemetry", "builtin", "cc-plugin-telemetry@builtin"),
    ]);
  });

  test("is null for a missing or malformed plugins field", () => {
    const init = (plugins: unknown) => ({ type: "system", subtype: "init", plugins });
    expect(initPluginsOf({ type: "system", subtype: "init" })).toBeNull();
    expect(initPluginsOf(init({ a: 1 }))).toBeNull();
    expect(initPluginsOf(init(["alpha"]))).toBeNull();
    expect(initPluginsOf(init([{ name: "a", path: "/p" }]))).toBeNull();
    expect(initPluginsOf(init([{ name: "a", path: "/p", source: "a@m", version: 2 }]))).toBeNull();
  });
});

describe("pluginsToHandOver", () => {
  test("hands over a caller copy at another path or missing in the child, in the caller's order", async () => {
    const alpha2 = pluginCopy("alpha/2.0.0", "alpha");
    const alpha1 = pluginCopy("alpha/1.0.0", "alpha");
    const beta1 = pluginCopy("beta/1.0.0", "beta");
    const gamma1 = pluginCopy("gamma/1.0.0", "gamma");
    const caller = [
      entry("alpha", alpha2, "alpha@m", "2.0.0"),
      entry("gamma", gamma1, "gamma@m", "1.0.0"),
      entry("beta", beta1, "beta@m", "1.0.0"),
    ];
    const child = [
      entry("gamma", gamma1, "gamma@m", "1.0.0"),
      entry("alpha", alpha1, "alpha@m", "1.0.0"),
    ];

    const { value } = await logsOf(() => pluginsToHandOver(caller, child));

    expect(value).toEqual([
      { id: "alpha@m", version: "2.0.0", path: alpha2 },
      { id: "beta@m", version: "1.0.0", path: beta1 },
    ]);
  });

  test("skips @inline and builtin caller entries: neither comes from an install row", async () => {
    const own = pluginCopy("own", "own");
    const caller = [
      entry("own", own, "own@inline", "0.1.0"),
      entry("cc-plugin-privacy", "builtin", "cc-plugin-privacy@builtin"),
    ];

    const { value } = await logsOf(() => pluginsToHandOver(caller, []));

    expect(value).toEqual([]);
  });

  test("skips, and logs the id of, a copy whose manifest is missing or names another plugin", async () => {
    const noManifest = pluginCopy("alpha/2.0.0", null);
    const otherName = pluginCopy("beta/1.0.0", "not-beta");
    const manifestDir = pluginCopy("gamma/1.0.0", null);
    mkdirSync(join(manifestDir, ".claude-plugin", "plugin.json"), { recursive: true });
    const caller = [
      entry("alpha", noManifest, "alpha@m", "2.0.0"),
      entry("beta", otherName, "beta@m", "1.0.0"),
      entry("gamma", manifestDir, "gamma@m", "1.0.0"),
    ];

    const { value, lines } = await logsOf(() => pluginsToHandOver(caller, []));

    expect(value).toEqual([]);
    for (const id of ["alpha@m", "beta@m", "gamma@m"]) {
      expect(lines.some((l) => l.includes(id))).toBe(true);
    }
    expect(lines.join("\n")).not.toContain(tmp);
  });

  test("hands one path over once", async () => {
    const alpha2 = pluginCopy("alpha/2.0.0", "alpha");
    const caller = [
      entry("alpha", alpha2, "alpha@m", "2.0.0"),
      entry("alpha", alpha2, "alpha@other", "2.0.0"),
    ];

    const { value } = await logsOf(() => pluginsToHandOver(caller, []));

    expect(value).toEqual([{ id: "alpha@m", version: "2.0.0", path: alpha2 }]);
  });
});

/** A runner answering from `lists` by cwd, recording each request. */
function scriptedRunner(
  lists: Record<string, LoadedPlugin[]>,
  calls: PluginProbeRequest[],
  answer?: (req: PluginProbeRequest) => PluginProbeResult
): PluginProbeRunner {
  return async (req) => {
    calls.push(req);
    return answer ? answer(req) : { ok: true, plugins: lists[req.cwd] ?? [] };
  };
}

describe("inheritedPluginsFor", () => {
  /** A caller repository, an outside work_dir, and alpha at two copies. */
  function world() {
    const caller = mkdirP(join(tmp, "caller"));
    mkdirSync(join(caller, ".git"), { recursive: true });
    const work = mkdirP(join(tmp, "work"));
    const alpha2 = pluginCopy("alpha/2.0.0", "alpha");
    const alpha1 = pluginCopy("alpha/1.0.0", "alpha");
    const lists = {
      [caller]: [entry("alpha", alpha2, "alpha@m", "2.0.0")],
      [work]: [entry("alpha", alpha1, "alpha@m", "1.0.0")],
    };
    return { caller, work, alpha2, alpha1, lists };
  }

  test("probes setup_from and work_dir in parallel and hands over the caller's differing copy", async () => {
    const { caller, work, alpha2, lists } = world();
    const calls: PluginProbeRequest[] = [];
    let release: () => void = () => {};
    const bothStarted = new Promise<void>((r) => {
      release = r;
    });
    let serial = false;
    const runner: PluginProbeRunner = async (req) => {
      calls.push(req);
      if (calls.length === 2) release();
      // a serial caller starts the second probe only after the first answered
      const both = await Promise.race([
        bothStarted.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!both) serial = true;
      return { ok: true, plugins: lists[req.cwd] ?? [] };
    };

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner,
      })
    );

    expect(value).toEqual({
      plugins: [{ id: "alpha@m", version: "2.0.0", path: alpha2 }],
      outcome: "ok",
    });
    expect(serial).toBe(false);
    expect(calls.map((c) => c.cwd).sort()).toEqual([caller, work].sort());
    for (const call of calls) {
      expect(call.env.ANTHROPIC_BASE_URL).toBe(PLUGIN_PROBE_BASE_URL);
      expect(call.args.slice(-2)).toEqual(["-p", "/effort"]);
      expect(call.timeoutMs).toBe(10_000);
    }
  });

  /** The `--settings` file a probe request names, its mode and its content. */
  function settingsOf(req: PluginProbeRequest): { path: string; mode: number; value: unknown } {
    const path = req.args[req.args.indexOf("--settings") + 1] as string;
    return {
      path,
      mode: statSync(path).mode & 0o777,
      value: JSON.parse(readFileSync(path, "utf-8")),
    };
  }

  test("gives the work_dir probe the layer and the setup_from probe none, each in a private settings file removed after", async () => {
    const { caller, work, lists } = world();
    const seen = new Map<string, { path: string; mode: number; value: unknown }>();
    const runner = scriptedRunner(lists, [], (req) => {
      seen.set(req.cwd, settingsOf(req));
      return { ok: true, plugins: lists[req.cwd] ?? [] };
    });
    const layer = { enabledPlugins: { "alpha@m": true }, disableAllHooks: false };

    await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner,
      })
    );

    expect(seen.get(caller)?.value).toEqual(pluginProbeSettings(null));
    expect(seen.get(work)?.value).toEqual(pluginProbeSettings(layer));
    expect((seen.get(work)?.value as { disableAllHooks: unknown }).disableAllHooks).toBe(true);
    for (const s of seen.values()) {
      expect(s.mode).toBe(0o600);
      expect(s.path.startsWith(`${caller}/`)).toBe(false);
      expect(s.path.startsWith(`${work}/`)).toBe(false);
      expect(existsSync(s.path)).toBe(false);
    }
  });

  test("does not report for the caller a plugin turned on only by the inherited layer", async () => {
    const { caller, work, alpha2 } = world();
    const layerOnly = pluginCopy("layer-only/1.0.0", "layer-only");
    // Claude Code's answer, read from what each probe was given: `layer-only` has an install
    // row only for setup_from and loads there when a settings file turns it on; alpha 2.0.0
    // loads in setup_from.
    const runner = scriptedRunner({}, [], (req) => {
      const settings = settingsOf(req).value as { enabledPlugins?: Record<string, boolean> };
      const plugins: LoadedPlugin[] = [];
      if (req.cwd === caller) plugins.push(entry("alpha", alpha2, "alpha@m", "2.0.0"));
      if (req.cwd === caller && settings.enabledPlugins?.["layer-only@m"] === true) {
        plugins.push(entry("layer-only", layerOnly, "layer-only@m", "1.0.0"));
      }
      return { ok: true, plugins };
    });

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: { enabledPlugins: { "layer-only@m": true } },
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner,
      })
    );

    expect(value).toEqual({
      plugins: [{ id: "alpha@m", version: "2.0.0", path: alpha2 }],
      outcome: "ok",
    });
  });

  test("starts no probe and hands over nothing when the caller passes --plugin-url", async () => {
    const { caller, work, lists } = world();
    for (const flags of [
      ["--plugin-url", "https://example.invalid/p.zip"],
      ["--plugin-url=https://example.invalid/p.zip"],
    ]) {
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: flags,
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith(),
          runner: scriptedRunner(lists, calls),
        })
      );

      expect(value).toEqual({ plugins: [], outcome: "plugin_url" });
      expect(calls).toEqual([]);
      expect(lines.some((l) => l.includes("--plugin-url"))).toBe(true);
      expect(lines.join("\n")).not.toContain("example.invalid");
    }
  });

  test("an abort while the probes run hands every probe the signal and still removes the settings files", async () => {
    const { caller, work } = world();
    const controller = new AbortController();
    const seen: PluginProbeRequest[] = [];
    const paths: string[] = [];
    const runner: PluginProbeRunner = (req) => {
      seen.push(req);
      paths.push(settingsOf(req).path);
      if (seen.length === 2) controller.abort();
      return new Promise((settle) => {
        const aborted = () => settle({ ok: false, cause: "aborted" });
        if (req.signal?.aborted) aborted();
        req.signal?.addEventListener("abort", aborted);
      });
    };

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner,
        signal: controller.signal,
      })
    );

    expect(value).toEqual({ plugins: [], outcome: "aborted" });
    expect(seen.every((r) => r.signal === controller.signal)).toBe(true);
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });

  test("starts no probe without setup_from, or for a child in the same repository", async () => {
    const { caller } = world();
    const sub = mkdirP(join(caller, "sub"));
    const gitDir = join(caller, ".git", "worktrees", "wt");
    put(join(gitDir, "commondir"), "../..\n");
    const worktree = mkdirP(join(tmp, "wt"));
    put(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const calls: PluginProbeRequest[] = [];
    const runner = scriptedRunner({}, calls);
    const input = {
      layer: null,
      childFlags: [],
      env: { HOME: join(tmp, "home") },
      managed: managedIn(tmp),
      ...hostWith(),
      runner,
    };

    expect(await inheritedPluginsFor({ ...input, setupReal: undefined, childCwd: sub })).toBeNull();
    expect(await inheritedPluginsFor({ ...input, setupReal: caller, childCwd: sub })).toBeNull();
    expect(
      await inheritedPluginsFor({ ...input, setupReal: caller, childCwd: worktree })
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test("probes a subfolder child of a setup_from outside Git, and a nested repository", async () => {
    const plain = mkdirP(join(tmp, "plain"));
    const plainSub = mkdirP(join(plain, "sub"));
    const { caller } = world();
    const nested = mkdirP(join(caller, "nested"));
    mkdirSync(join(nested, ".git"));
    const calls: PluginProbeRequest[] = [];
    const runner = scriptedRunner({}, calls);
    const input = {
      layer: null,
      childFlags: [],
      env: { HOME: join(tmp, "home") },
      managed: managedIn(tmp),
      ...hostWith(),
      runner,
    };

    const outside = await logsOf(() =>
      inheritedPluginsFor({
        ...input,
        ...hostWith([], plain),
        setupReal: plain,
        childCwd: plainSub,
      })
    );
    const inside = await logsOf(() =>
      inheritedPluginsFor({ ...input, setupReal: caller, childCwd: nested })
    );

    expect(outside.value).toEqual({ plugins: [], outcome: "ok" });
    expect(inside.value).toEqual({ plugins: [], outcome: "ok" });
    expect(calls.map((c) => c.cwd)).toEqual(expect.arrayContaining([plain, plainSub, nested]));
  });

  /** inheritedPluginsFor on {@link world} with `managed`, its log lines and the probe requests. */
  async function handoverUnder(
    managed: Partial<ManagedPaths>,
    extra: {
      childFlags?: string[];
      env?: Record<string, string>;
      hostFlags?: string[];
      policyPlatform?: "windows" | "wsl" | "other";
    } = {}
  ) {
    const { caller, work, lists } = world();
    const calls: PluginProbeRequest[] = [];
    const { value, lines } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: extra.childFlags ?? [],
        env: { HOME: join(tmp, "home"), ...extra.env },
        managed,
        ...hostWith(extra.hostFlags ?? []),
        ...(extra.policyPlatform ? { policyPlatform: extra.policyPlatform } : {}),
        runner: scriptedRunner(lists, calls),
      })
    );
    return { value, lines, calls };
  }

  /** Where `which` lives under `managedIn(tmp)`. */
  function policyPath(which: string): string {
    const m = managedIn(tmp);
    const config = join(tmp, "managed", "config");
    const paths: Record<string, string> = {
      "managed-settings.json": m.managedSettingsFile,
      "a managed-settings.d drop-in": join(m.managedSettingsDropInDir, "10-policy.json"),
      "a managed-settings.d entry Claude Code would skip": join(
        m.managedSettingsDropInDir,
        ".DS_Store"
      ),
      "the per-user plist": m.managedPreferencePlists[0] as string,
      "the device plist": m.managedPreferencePlists[1] as string,
      "remote-settings.json": m.remoteSettingsFile as string,
      "managed-mcp.json": m.managedMcpFile,
      "the hybrid sign-in cache": join(config, "state", "hybrid-settings.json"),
      "a suffixed hybrid sign-in cache": join(config, "state", "hybrid-settings-org.json"),
    };
    return paths[which] as string;
  }

  for (const which of [
    "managed-settings.json",
    "a managed-settings.d drop-in",
    "a managed-settings.d entry Claude Code would skip",
    "the per-user plist",
    "the device plist",
    "remote-settings.json",
    "managed-mcp.json",
    "the hybrid sign-in cache",
    "a suffixed hybrid sign-in cache",
  ]) {
    for (const [content, label] of [
      ["{}", "that sets nothing"],
      ["{ broken", "that cannot be parsed"],
    ] as const) {
      // an empty server-managed cache is what an ordinary login leaves: tested below
      if (which === "remote-settings.json" && content === "{}") continue;
      test(`starts no probe when ${which} exists ${label} (managed_policy_present)`, async () => {
        const path = policyPath(which);
        put(path, content);

        const { value, lines, calls } = await handoverUnder(managedIn(tmp));

        expect(value).toEqual({ plugins: [], outcome: "managed_policy_present" });
        expect(calls).toEqual([]);
        expect(lines.some((l) => l.includes(path))).toBe(true);
      });
    }
  }

  test("probes beside a remote-settings.json that holds only Claude Code's $-prefixed metadata, as an ordinary login leaves it", async () => {
    const path = managedIn(tmp).remoteSettingsFile as string;
    for (const content of [
      "{}",
      '{"$schema":"https://json.schemastore.org/claude-code-settings.json"}',
      '{"$x":1,"$schema":"s"}',
    ]) {
      put(path, content);
      const { value, calls } = await handoverUnder(managedIn(tmp));
      expect(value?.outcome).toBe("ok");
      expect(calls).toHaveLength(2);
    }
  });

  test("starts no probe beside a remote-settings.json that sets anything, cannot be parsed, is not an object, is too large or is not a regular file", async () => {
    const path = managedIn(tmp).remoteSettingsFile as string;
    const big = `{"$pad":"${"x".repeat(8 * 1024 * 1024)}"}`;
    for (const content of [
      '{"hooks":{}}',
      '{"$schema":"s","env":{}}',
      "{ broken",
      "[]",
      "null",
      '"x"',
      big,
    ]) {
      put(path, content);
      const { value, calls, lines } = await handoverUnder(managedIn(tmp));
      expect(value).toEqual({ plugins: [], outcome: "managed_policy_present" });
      expect(calls).toEqual([]);
      expect(lines.some((l) => l.includes(path))).toBe(true);
    }
    rmSync(path);
    mkdirSync(path);
    expect((await handoverUnder(managedIn(tmp))).value?.outcome).toBe("managed_policy_present");
    rmSync(path, { recursive: true });
    const target = join(tmp, "elsewhere.json");
    put(target, "{}");
    symlinkSync(target, path);
    expect((await handoverUnder(managedIn(tmp))).value?.outcome).toBe("managed_policy_present");
  });

  test("checks the config dir of each probe: a relative CLAUDE_CONFIG_DIR is resolved against setup_from and against work_dir", async () => {
    const managed = { ...managedIn(tmp), remoteSettingsFile: null, hybridSettingsDir: null };
    const env = { CLAUDE_CONFIG_DIR: "cfg", HOME: join(tmp, "home") };
    expect((await handoverUnder(managed, { env })).value?.outcome).toBe("ok");
    for (const repo of ["caller", "work"]) {
      for (const file of ["remote-settings.json", join("state", "hybrid-settings.json")]) {
        const path = join(tmp, repo, "cfg", file);
        put(path, { hooks: {} });
        const { value, calls, lines } = await handoverUnder(managed, { env });
        expect(value).toEqual({ plugins: [], outcome: "managed_policy_present" });
        expect(calls).toEqual([]);
        expect(lines.some((l) => l.includes(path))).toBe(true);
        rmSync(path);
      }
    }
  });

  test("starts no probe when a policy source is a named pipe, and never opens it", async () => {
    const path = managedIn(tmp).managedPreferencePlists[0] as string;
    mkdirSync(join(path, ".."), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", path], { env: { PATH: "/usr/bin:/bin" } }).exitCode).toBe(0);
    let opened = false;
    const managed = {
      ...managedIn(tmp),
      readPlist: () => {
        opened = true;
        return "{}";
      },
    };

    const { value, calls } = await handoverUnder(managed);

    expect(value?.outcome).toBe("managed_policy_present");
    expect(opened).toBe(false);
    expect(calls).toEqual([]);
  });

  test("starts no probe when a dangling symlink names a policy source", async () => {
    const path = managedIn(tmp).managedSettingsFile;
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(join(tmp, "nowhere.json"), path);

    expect((await handoverUnder(managedIn(tmp))).value?.outcome).toBe("managed_policy_present");
  });

  test("starts no probe when the hybrid cache's folder cannot be listed", async () => {
    const state = join(tmp, "managed", "config", "state");
    mkdirSync(state, { recursive: true });
    chmodSync(state, 0o000);
    try {
      const { value, lines } = await handoverUnder(managedIn(tmp));
      expect(value?.outcome).toBe("managed_policy_present");
      expect(lines.some((l) => l.includes(state))).toBe(true);
    } finally {
      chmodSync(state, 0o700);
    }
  });

  test("probes beside an empty managed-settings.d, and a state folder without a hybrid cache", async () => {
    mkdirSync(managedIn(tmp).managedSettingsDropInDir, { recursive: true });
    put(join(tmp, "managed", "config", "state", "other.json"), {});

    const { value, calls } = await handoverUnder(managedIn(tmp));

    expect(value?.outcome).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("reads remote-settings.json and the hybrid cache from the child's CLAUDE_CONFIG_DIR when no path is given", async () => {
    const config = mkdirP(join(tmp, "child-config"));
    const managed = { ...managedIn(tmp), remoteSettingsFile: null, hybridSettingsDir: null };
    const env = { CLAUDE_CONFIG_DIR: config, HOME: join(tmp, "home") };
    expect((await handoverUnder(managed, { env })).value?.outcome).toBe("ok");

    for (const file of ["remote-settings.json", join("state", "hybrid-settings.json")]) {
      put(join(config, file), { hooks: {} });
      const { value, lines } = await handoverUnder(managed, { env });
      expect(value?.outcome).toBe("managed_policy_present");
      expect(lines.some((l) => l.includes(join(config, file)))).toBe(true);
      rmSync(join(config, file));
    }
  });

  test("starts no probe on Windows or WSL, whatever their files hold", async () => {
    for (const policyPlatform of ["windows", "wsl"] as const) {
      const { value, lines, calls } = await handoverUnder(managedIn(tmp), { policyPlatform });
      expect(value).toEqual({ plugins: [], outcome: "managed_policy_present" });
      expect(calls).toEqual([]);
      expect(lines.some((l) => l.toLowerCase().includes(policyPlatform))).toBe(true);
    }
  });

  test("starts no probe when the child or the caller passes --managed-settings", async () => {
    for (const flags of [["--managed-settings", '{"model":"x"}'], ["--managed-settings={}"]]) {
      const child = await handoverUnder(managedIn(tmp), { childFlags: flags });
      expect(child.value).toEqual({ plugins: [], outcome: "managed_policy_present" });
      expect(child.calls).toEqual([]);
      expect(child.lines.some((l) => l.includes("--managed-settings"))).toBe(true);

      const caller = await handoverUnder(managedIn(tmp), { hostFlags: flags });
      expect(caller.value).toEqual({ plugins: [], outcome: "managed_policy_present" });
      expect(caller.calls).toEqual([]);
    }
  });

  test("probes under absent policy sources", async () => {
    const { value, calls } = await handoverUnder(managedIn(tmp));
    expect(value?.outcome).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  describe("policyPlatformOf", () => {
    const noProc = () => {
      throw new Error("ENOENT");
    };
    test("is windows on win32, and wsl as Claude Code 2.1.332 decides it", () => {
      expect(policyPlatformOf("win32", {}, noProc)).toBe("windows");
      expect(policyPlatformOf("linux", { WSL_DISTRO_NAME: "Ubuntu" }, noProc)).toBe("wsl");
      expect(policyPlatformOf("linux", { WSL_INTEROP: "/run/WSL/1_interop" }, noProc)).toBe("wsl");
      expect(
        policyPlatformOf("linux", {}, () => "Linux version 5.15.153.1-Microsoft-standard-WSL2")
      ).toBe("wsl");
      expect(policyPlatformOf("linux", {}, () => "Linux version 4.4.0-19041-wsl1 (gcc)")).toBe(
        "wsl"
      );
    });

    test("is other on plain Linux, an unreadable /proc/version, and macOS", () => {
      expect(policyPlatformOf("linux", {}, () => "Linux version 6.8.0-45-generic")).toBe("other");
      expect(policyPlatformOf("linux", {}, noProc)).toBe("other");
      expect(policyPlatformOf("darwin", { WSL_DISTRO_NAME: "x" }, () => "microsoft")).toBe("other");
    });
  });

  /* ───────────── the caller's own launch, read from the host process ───────────── */

  test("starts the caller probe with the caller's own launch flags and the child probe with the child's", async () => {
    const { caller, work } = world();
    const hostCwd = mkdirP(join(caller, "host-cwd"));
    const calls: PluginProbeRequest[] = [];

    await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: ["--plugin-dir", "./child-extras", "--setting-sources", "project", "--bare"],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(
          [
            "--resume",
            "abc",
            "--plugin-dir",
            "host-extras",
            "--plugin-dir-no-mcp=/abs/nomcp",
            "--setting-sources=user,project",
            "--restricted",
            "--model",
            "opus",
          ],
          hostCwd
        ),
        runner: scriptedRunner({}, calls),
      })
    );

    const argsAt = (cwd: string) => calls.find((c) => c.cwd === cwd)?.args ?? [];
    const loading = (args: string[]) => args.slice(7, -2);
    expect(loading(argsAt(hostCwd))).toEqual([
      "--plugin-dir",
      join(hostCwd, "host-extras"),
      "--plugin-dir-no-mcp",
      "/abs/nomcp",
      "--setting-sources",
      "user,project",
      "--restricted",
    ]);
    expect(loading(argsAt(work))).toEqual([
      "--plugin-dir",
      join(work, "child-extras"),
      "--setting-sources",
      "project",
      "--bare",
    ]);
  });

  test("does not hand over a copy the caller's own --settings turn off", async () => {
    const { caller, work, alpha2 } = world();
    const beta = pluginCopy("beta/1.0.0", "beta");
    // Claude Code's answer, read from what each probe was given: the caller loads alpha only
    // when its settings do not turn it off; the outside child has no install row for either.
    const runner = scriptedRunner({}, [], (req) => {
      if (req.cwd !== hostCwd) return { ok: true, plugins: [] };
      const settings = settingsOf(req).value as { enabledPlugins?: Record<string, boolean> };
      const plugins = [entry("beta", beta, "beta@m", "1.0.0")];
      if (settings.enabledPlugins?.["alpha@m"] !== false) {
        plugins.unshift(entry("alpha", alpha2, "alpha@m", "2.0.0"));
      }
      return { ok: true, plugins };
    });
    const hostCwd = mkdirP(join(caller, "host-cwd"));
    put(join(hostCwd, "launch.json"), { enabledPlugins: { "alpha@m": false } });

    for (const flags of [
      ["--settings", '{"enabledPlugins":{"alpha@m":false}}'],
      ["--settings=launch.json"],
      ["--settings", '{"enabledPlugins":{"alpha@m":true}}', "--settings", "launch.json"],
    ]) {
      const { value } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith(flags, hostCwd),
          runner,
        })
      );

      expect(value).toEqual({
        plugins: [{ id: "beta@m", version: "1.0.0", path: beta }],
        outcome: "ok",
      });
    }
  });

  test("keeps the closed env block over the caller's --settings env", async () => {
    const { caller, work, lists } = world();
    const calls: PluginProbeRequest[] = [];
    let callerSettings: Record<string, unknown> = {};
    const runner = scriptedRunner(lists, calls, (req) => {
      if (req.cwd === caller) callerSettings = settingsOf(req).value as Record<string, unknown>;
      return { ok: true, plugins: lists[req.cwd] ?? [] };
    });
    const flags = [
      "--settings",
      '{"env":{"ANTHROPIC_BASE_URL":"https://gw.invalid","ANTHROPIC_API_KEY":"sk-x"},"apiKeyHelper":"/bin/echo k"}',
    ];

    await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(flags),
        runner,
      })
    );

    const callerReq = calls.find((c) => c.cwd === caller) as PluginProbeRequest;
    const settings = callerSettings;
    expect((settings.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(PLUGIN_PROBE_BASE_URL);
    expect((settings.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("");
    expect(settings).not.toHaveProperty("apiKeyHelper");
    expect(callerReq.args.filter((a) => a === "--settings")).toHaveLength(1);
  });

  test("starts no probe when the caller's launch cannot be read (caller_argv_unreadable)", async () => {
    const { caller, work, lists } = world();
    const readers = [
      () => null,
      () => {
        throw new Error("EPERM");
      },
      // another MCP host than Claude Code
      () => ({
        argv: ["/Applications/X.app/codex", "app-server", "--plugin-dir", "/p"],
        cwd: tmp,
        env: {},
      }),
      // a pre-started Claude Code whose launch flags arrive over a socket, never in argv
      () => ({
        argv: ["claude", "bg-spare", "--bg-spare", "/tmp/x.claim.sock"],
        cwd: tmp,
        env: {},
      }),
      // a Node launch with runtime options before the script
      () => ({
        argv: ["node", "--inspect", "/n/@anthropic-ai/claude-code/cli.js"],
        cwd: tmp,
        env: {},
      }),
    ];
    for (const readHostLaunch of readers) {
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith(),
          readHostLaunch,
          runner: scriptedRunner(lists, calls),
        })
      );

      expect(value).toEqual({ plugins: [], outcome: "caller_argv_unreadable" });
      expect(calls).toEqual([]);
      expect(lines.some((l) => l.includes("4242"))).toBe(true);
    }
  });

  test("starts no probe when the caller's --settings cannot be read (caller_settings_unreadable)", async () => {
    for (const flags of [
      ["--settings", "missing.json"],
      ["--settings", "{ broken"],
    ]) {
      const { value, calls } = await handoverUnder(managedIn(tmp), { hostFlags: flags });
      expect(value).toEqual({ plugins: [], outcome: "caller_settings_unreadable" });
      expect(calls).toEqual([]);
    }
  });

  test("starts no probe when the caller itself passes --plugin-url", async () => {
    const { value, calls, lines } = await handoverUnder(managedIn(tmp), {
      hostFlags: ["--plugin-url=https://example.invalid/p.zip"],
    });
    expect(value).toEqual({ plugins: [], outcome: "plugin_url" });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).not.toContain("example.invalid");
  });

  test("starts no probe when setup_from and the caller's launch directory do not share a main checkout (setup_from_not_caller)", async () => {
    const { caller, work, lists } = world();
    const outside = mkdirP(join(tmp, "outside"));
    const otherRepo = mkdirP(join(tmp, "other-repo"));
    mkdirSync(join(otherRepo, ".git"));
    const plain = mkdirP(join(tmp, "plain"));
    const plainSub = mkdirP(join(plain, "sub"));
    const gitDir = join(caller, ".git", "worktrees", "wt");
    put(join(gitDir, "commondir"), "../..\n");
    const worktree = mkdirP(join(tmp, "wt"));
    put(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const run = async (setupReal: string, hostCwd: string) => {
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith([], hostCwd),
          runner: scriptedRunner(lists, calls),
        })
      );
      return { outcome: value?.outcome, calls: calls.length, lines };
    };

    for (const hostCwd of [outside, otherRepo]) {
      const refused = await run(caller, hostCwd);
      expect(refused.outcome).toBe("setup_from_not_caller");
      expect(refused.calls).toBe(0);
      expect(refused.lines.some((l) => l.includes("setup_from"))).toBe(true);
    }
    // outside Git a folder is its own key: a subfolder is another launch directory
    expect((await run(plain, plainSub)).outcome).toBe("setup_from_not_caller");
    expect((await run(plain, plain)).outcome).toBe("ok");
    expect((await run(caller, mkdirP(join(caller, "sub")))).outcome).toBe("ok");
    expect((await run(caller, worktree)).outcome).toBe("ok");
  });

  /**
   * A runner that answers as Claude Code would for `alpha@m`, enabled in user settings: the
   * child loads 1.0.0 (its user row), every other directory 2.0.0 (a project row), unless the
   * cwd's own project `.claude/settings.json` turns it off.
   */
  function projectSettingsRunner(
    copies: { work: string; alpha1: string; alpha2: string },
    calls: PluginProbeRequest[]
  ): PluginProbeRunner {
    return scriptedRunner({}, calls, (req) => {
      let off = false;
      try {
        const project = JSON.parse(
          readFileSync(join(req.cwd, ".claude", "settings.json"), "utf-8")
        );
        off = project?.enabledPlugins?.["alpha@m"] === false;
      } catch {
        // no project settings: alpha stays on
      }
      const [path, version] =
        req.cwd === copies.work ? [copies.alpha1, "1.0.0"] : [copies.alpha2, "2.0.0"];
      return { ok: true, plugins: off ? [] : [entry("alpha", path, "alpha@m", version)] };
    });
  }

  test("boots the caller probe in the caller's own launch directory, not in a setup_from that only shares its main checkout", async () => {
    const { caller, work, alpha1, alpha2 } = world();
    // setup_from is the main checkout; the caller runs in a linked worktree whose own project
    // settings (another branch's .claude/settings.json) turn alpha off
    const gitDir = join(caller, ".git", "worktrees", "wt");
    put(join(gitDir, "commondir"), "../..\n");
    const worktree = mkdirP(join(tmp, "wt"));
    put(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    put(join(worktree, ".claude", "settings.json"), { enabledPlugins: { "alpha@m": false } });
    const run = async (hostCwd: string) => {
      const calls: PluginProbeRequest[] = [];
      const { value } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith([], hostCwd),
          runner: projectSettingsRunner({ work, alpha1, alpha2 }, calls),
        })
      );
      return { value, cwds: calls.map((c) => c.cwd) };
    };

    const fromWorktree = await run(worktree);
    expect(fromWorktree.value).toEqual({ plugins: [], outcome: "ok" });
    expect(fromWorktree.cwds.sort()).toEqual([work, worktree].sort());

    // the default case: setup_from is the caller's own launch directory, probed there
    const fromSetup = await run(caller);
    expect(fromSetup.value).toEqual({
      plugins: [{ id: "alpha@m", version: "2.0.0", path: alpha2 }],
      outcome: "ok",
    });
    expect(fromSetup.cwds.sort()).toEqual([caller, work].sort());
  });

  test("checks the managed policy in the caller's own launch directory too", async () => {
    const { caller, work, lists } = world();
    const sub = mkdirP(join(caller, "sub"));
    // a relative CLAUDE_CONFIG_DIR resolves against each probe's cwd: only the caller's has one
    put(join(sub, "cfg", "remote-settings.json"), { permissions: { deny: ["Bash"] } });
    const calls: PluginProbeRequest[] = [];
    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home"), CLAUDE_CONFIG_DIR: "cfg" },
        managed: { ...managedIn(tmp), remoteSettingsFile: null, hybridSettingsDir: null },
        ...hostWith([], sub, { CLAUDE_CONFIG_DIR: "cfg" }),
        runner: scriptedRunner(lists, calls),
      })
    );
    expect(value).toEqual({ plugins: [], outcome: "managed_policy_present" });
    expect(calls).toEqual([]);
  });

  describe("a caller in safe or bare mode (caller_mode_unmodelled)", () => {
    async function underCaller(flags: string[], hostEnv: Record<string, string>) {
      const { caller, work, lists } = world();
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith(flags, caller, hostEnv),
          runner: scriptedRunner(lists, calls),
        })
      );
      return { value, lines, calls };
    }

    const triggers: [string, string[], Record<string, string>][] = [
      ["CLAUDE_CODE_SAFE_MODE=1", [], { CLAUDE_CODE_SAFE_MODE: "1" }],
      ["--safe-mode", ["--safe-mode"], {}],
      ["CLAUDE_CODE_SIMPLE=true", [], { CLAUDE_CODE_SIMPLE: "true" }],
      ["--bare", ["--bare"], {}],
      ["CLAUDE_CODE_SAFE_MODE= On ", [], { CLAUDE_CODE_SAFE_MODE: " On " }],
      ["CLAUDE_CODE_SIMPLE=yes", [], { CLAUDE_CODE_SIMPLE: "yes" }],
    ];
    for (const [name, flags, hostEnv] of triggers) {
      test(`${name} hands over nothing and starts no probe`, async () => {
        const { value, lines, calls } = await underCaller(flags, hostEnv);
        expect(value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
        expect(calls).toEqual([]);
        expect(lines.some((l) => l.includes("no plugin handed over"))).toBe(true);
      });
    }

    test("a falsy value, as Claude Code reads it, does not refuse", async () => {
      for (const value of ["0", "false", "no", "off", ""]) {
        const { value: got, calls } = await underCaller([], {
          CLAUDE_CODE_SAFE_MODE: value,
          CLAUDE_CODE_SIMPLE: value,
        });
        expect(got?.outcome).toBe("ok");
        expect(calls.length).toBe(2);
      }
    });

    test("restricted mode is still probed, not refused", async () => {
      const env = await underCaller(["--restricted"], { CLAUDE_CODE_RESTRICTED: "1" });
      expect(env.value?.outcome).toBe("ok");
      expect(env.calls.length).toBe(2);
    });

    test("a server in safe mode, with a caller that is not, does not refuse", async () => {
      const { caller, work, lists } = world();
      const calls: PluginProbeRequest[] = [];
      const value = await inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home"), CLAUDE_CODE_SAFE_MODE: "1", CLAUDE_CODE_SIMPLE: "1" },
        managed: managedIn(tmp),
        ...hostWith([], caller, {}),
        runner: scriptedRunner(lists, calls),
      });
      expect(value?.outcome).toBe("ok");
    });
  });

  describe("the caller's effective launch environment: settings env blocks over its launch env", () => {
    const home = () => join(tmp, "home");
    async function underLaunch(opts: {
      hostFlags?: string[];
      hostEnv?: Record<string, string>;
      files?: Record<string, unknown>;
      user?: unknown;
    }) {
      const { caller, work, lists } = world();
      for (const [rel, value] of Object.entries(opts.files ?? {})) put(join(caller, rel), value);
      if (opts.user !== undefined) put(join(home(), ".claude", "settings.json"), opts.user);
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: home() },
          managed: managedIn(tmp),
          ...hostWith(opts.hostFlags ?? [], caller, opts.hostEnv ?? {}),
          runner: scriptedRunner(lists, calls),
        })
      );
      const callerCall = calls.find((c) => c.cwd === caller);
      return { caller, value, lines, calls, callerEnv: callerCall?.env };
    }
    const inline = (env: Record<string, string>) => ["--settings", JSON.stringify({ env })];

    test("CLAUDE_CODE_SAFE_MODE only in the caller's inline --settings env refuses", async () => {
      const got = await underLaunch({ hostFlags: inline({ CLAUDE_CODE_SAFE_MODE: "1" }) });
      expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
      expect(got.calls).toEqual([]);
    });

    test("CLAUDE_CODE_SAFE_MODE only in a --settings file, relative to the caller's cwd, refuses", async () => {
      const got = await underLaunch({
        hostFlags: ["--settings", "own.json"],
        files: { "own.json": { env: { CLAUDE_CODE_SAFE_MODE: "1" } } },
      });
      expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
      expect(got.calls).toEqual([]);
    });

    for (const file of [".claude/settings.json", ".claude/settings.local.json"]) {
      test(`CLAUDE_CODE_SAFE_MODE only in the caller's ${file} env refuses`, async () => {
        const got = await underLaunch({
          files: { [file]: { env: { CLAUDE_CODE_SAFE_MODE: "1" } } },
        });
        expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
        expect(got.calls).toEqual([]);
      });
    }

    test("CLAUDE_CODE_SIMPLE only in the caller's user settings env, in any case, refuses", async () => {
      const got = await underLaunch({ user: { env: { claude_code_simple: "true" } } });
      expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
    });

    test("user settings the caller's --setting-sources leaves out do not refuse", async () => {
      const got = await underLaunch({
        user: { env: { CLAUDE_CODE_SAFE_MODE: "1" } },
        hostFlags: ["--setting-sources", "project,local"],
      });
      expect(got.value?.outcome).toBe("ok");
      expect(got.calls).toHaveLength(2);
    });

    test("a settings layer that reads CLAUDE_CODE_RESTRICTED other than the launch refuses: the caller picked its setting sources before any env block applied", async () => {
      const cases: Parameters<typeof underLaunch>[0][] = [
        { hostFlags: inline({ CLAUDE_CODE_RESTRICTED: "1" }) },
        {
          hostEnv: { CLAUDE_CODE_RESTRICTED: "1" },
          hostFlags: inline({ CLAUDE_CODE_RESTRICTED: "0" }),
        },
        { hostFlags: ["--restricted", ...inline({ CLAUDE_CODE_RESTRICTED: "off" })] },
        { user: { env: { claude_code_restricted: "true" } } },
        { files: { ".claude/settings.local.json": { env: { CLAUDE_CODE_RESTRICTED: "1" } } } },
      ];
      for (const opts of cases) {
        const got = await underLaunch(opts);
        expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
        expect(got.calls).toEqual([]);
        expect(got.lines.some((l) => l.includes("CLAUDE_CODE_RESTRICTED"))).toBe(true);
      }
    });

    test("the caller probe gets the launch's CLAUDE_CODE_RESTRICTED, never a settings layer's", async () => {
      const same = await underLaunch({
        hostEnv: { CLAUDE_CODE_RESTRICTED: "1" },
        hostFlags: inline({ CLAUDE_CODE_RESTRICTED: "true" }),
      });
      expect(same.value?.outcome).toBe("ok");
      expect(same.calls).toHaveLength(2);
      expect(same.callerEnv?.CLAUDE_CODE_RESTRICTED).toBe("1");
      const off = await underLaunch({ hostFlags: inline({ CLAUDE_CODE_RESTRICTED: "0" }) });
      expect(off.value?.outcome).toBe("ok");
      expect(off.callerEnv !== undefined && "CLAUDE_CODE_RESTRICTED" in off.callerEnv).toBe(false);
    });

    test("a --restricted after -- is not the flag: the caller's user settings env still counts", async () => {
      const got = await underLaunch({
        user: { env: { CLAUDE_CODE_SAFE_MODE: "1" } },
        hostFlags: ["--", "--restricted"],
      });
      expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
      expect(got.calls).toEqual([]);
    });

    test("a caller settings file that is not a regular file refuses (caller_settings_unreadable) without blocking", async () => {
      const dir = join(tmp, "caller", ".claude");
      mkdirSync(dir, { recursive: true });
      expect(
        Bun.spawnSync(["mkfifo", join(dir, "settings.local.json")], {
          env: { PATH: "/usr/bin:/bin" },
        }).exitCode
      ).toBe(0);
      const got = await underLaunch({});
      expect(got.value).toEqual({ plugins: [], outcome: "caller_settings_unreadable" });
      expect(got.calls).toEqual([]);
    });

    test("a plugin variable in the caller's user settings env reaches the caller probe, and its value is never logged", async () => {
      const marker = join(tmp, "cache-dir-marker-value");
      const got = await underLaunch({ user: { env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: marker } } });
      expect(got.value?.outcome).toBe("ok");
      expect(got.callerEnv?.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe(marker);
      expect(got.lines.join("\n")).not.toContain(marker);
    });

    test("a later layer wins: --settings over user settings over the launch env", async () => {
      const flagOff = await underLaunch({
        user: { env: { CLAUDE_CODE_SAFE_MODE: "1" } },
        hostFlags: inline({ CLAUDE_CODE_SAFE_MODE: "0" }),
      });
      expect(flagOff.value?.outcome).toBe("ok");
      const userOff = await underLaunch({
        hostEnv: { CLAUDE_CODE_SAFE_MODE: "1" },
        user: { env: { CLAUDE_CODE_SAFE_MODE: "0" } },
      });
      expect(userOff.value?.outcome).toBe("ok");
      const flagOn = await underLaunch({
        hostEnv: { CLAUDE_CODE_SAFE_MODE: "0" },
        hostFlags: inline({ CLAUDE_CODE_SAFE_MODE: "1" }),
      });
      expect(flagOn.value?.outcome).toBe("caller_mode_unmodelled");
    });

    test("a project or local 0 does not clear a user 1: Claude Code can ignore a project env key", async () => {
      for (const file of [".claude/settings.json", ".claude/settings.local.json"]) {
        const got = await underLaunch({
          user: { env: { CLAUDE_CODE_SAFE_MODE: "1" } },
          files: { [file]: { env: { CLAUDE_CODE_SAFE_MODE: "0" } } },
        });
        expect(got.value?.outcome).toBe("caller_mode_unmodelled");
      }
    });

    test("an unparseable --settings file refuses (caller_settings_unreadable)", async () => {
      const got = await underLaunch({
        hostFlags: ["--settings", "own.json"],
        files: { "own.json": "{ broken" },
      });
      expect(got.value).toEqual({ plugins: [], outcome: "caller_settings_unreadable" });
      expect(got.calls).toEqual([]);
    });

    test("an unparseable caller settings.local.json refuses (caller_settings_unreadable)", async () => {
      const got = await underLaunch({ files: { ".claude/settings.local.json": "{ broken" } });
      expect(got.value).toEqual({ plugins: [], outcome: "caller_settings_unreadable" });
    });

    test("a settings env block that moves CLAUDE_CONFIG_DIR refuses, and a matching one does not", async () => {
      const moved = await underLaunch({
        hostFlags: inline({ CLAUDE_CONFIG_DIR: join(tmp, "elsewhere") }),
      });
      expect(moved.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
      const same = await underLaunch({
        hostEnv: { CLAUDE_CONFIG_DIR: join(tmp, "cfg") },
        hostFlags: inline({ CLAUDE_CONFIG_DIR: join(tmp, "cfg") }),
      });
      expect(same.value?.outcome).toBe("ok");
    });

    test("a settings env block that is not an object refuses (caller_settings_unreadable)", async () => {
      const got = await underLaunch({ user: { env: ["CLAUDE_CODE_SAFE_MODE=1"] } });
      expect(got.value).toEqual({ plugins: [], outcome: "caller_settings_unreadable" });
    });
  });

  describe("cowork plugins mode (caller_mode_unmodelled)", () => {
    async function underCowork(opts: {
      hostFlags?: string[];
      hostEnv?: Record<string, string>;
      env?: Record<string, string>;
      user?: unknown;
      layer?: Record<string, unknown> | null;
    }) {
      const { caller, work, lists } = world();
      if (opts.user !== undefined) put(join(tmp, "home", ".claude", "settings.json"), opts.user);
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: opts.layer ?? null,
          childFlags: [],
          env: { HOME: join(tmp, "home"), ...opts.env },
          managed: managedIn(tmp),
          ...hostWith(opts.hostFlags ?? [], caller, opts.hostEnv ?? {}),
          runner: scriptedRunner(lists, calls),
        })
      );
      return { value, lines, calls };
    }
    const refusedCases: [string, Parameters<typeof underCowork>[0]][] = [
      ["in the caller's launch env", { hostEnv: { CLAUDE_CODE_USE_COWORK_PLUGINS: "1" } }],
      [
        "in the caller's --settings env",
        { hostFlags: ["--settings", '{"env":{"CLAUDE_CODE_USE_COWORK_PLUGINS":"true"}}'] },
      ],
      [
        "in the caller's user settings env",
        { user: { env: { CLAUDE_CODE_USE_COWORK_PLUGINS: "yes" } } },
      ],
      ["in the child's spawn env", { env: { CLAUDE_CODE_USE_COWORK_PLUGINS: "1" } }],
      [
        "in the child's inherited settings env",
        { layer: { env: { claude_code_use_cowork_plugins: "on" } } },
      ],
      ["by the caller's --cowork flag", { hostFlags: ["--cowork"] }],
    ];
    for (const [where, opts] of refusedCases) {
      test(`cowork plugins mode ${where} hands over nothing and starts no probe`, async () => {
        const got = await underCowork(opts);
        expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
        expect(got.calls).toEqual([]);
        expect(got.lines.some((l) => l.includes("cowork"))).toBe(true);
      });
    }

    test("cowork plugins mode in work_dir's project settings env refuses", async () => {
      put(join(tmp, "work", ".claude", "settings.json"), {
        env: { CLAUDE_CODE_USE_COWORK_PLUGINS: "1" },
      });
      const got = await underCowork({});
      expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
      expect(got.calls).toEqual([]);
    });

    test("a later 0 never clears an earlier on: the caller picked cowork_settings.json before any env block applied", async () => {
      const off = ["--settings", '{"env":{"CLAUDE_CODE_USE_COWORK_PLUGINS":"0"}}'];
      for (const opts of [
        { hostEnv: { CLAUDE_CODE_USE_COWORK_PLUGINS: "1" }, hostFlags: off },
        { user: { env: { CLAUDE_CODE_USE_COWORK_PLUGINS: "1" } }, hostFlags: off },
      ]) {
        const got = await underCowork(opts);
        expect(got.value).toEqual({ plugins: [], outcome: "caller_mode_unmodelled" });
        expect(got.calls).toEqual([]);
      }
    });

    test("a falsy value, as Claude Code reads it, does not refuse, and no probe gets it", async () => {
      const got = await underCowork({
        hostEnv: { CLAUDE_CODE_USE_COWORK_PLUGINS: "0" },
        env: { CLAUDE_CODE_USE_COWORK_PLUGINS: "false" },
      });
      expect(got.value?.outcome).toBe("ok");
      expect(got.calls).toHaveLength(2);
      for (const call of got.calls) {
        expect("CLAUDE_CODE_USE_COWORK_PLUGINS" in call.env).toBe(false);
      }
    });
  });

  describe("the caller's own CLAUDE_CONFIG_DIR, read from its launch environment", () => {
    async function underHostEnv(
      hostEnv: Record<string, string> | null,
      serverEnv: Record<string, string> = {}
    ) {
      const { caller, work, lists } = world();
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home"), ...serverEnv },
          managed: managedIn(tmp),
          ...hostWith([], caller, hostEnv),
          runner: scriptedRunner(lists, calls),
        })
      );
      const byCwd = (cwd: string) => calls.find((c) => c.cwd === cwd)?.env;
      return { value, lines, calls, caller: byCwd(caller), child: byCwd(work) };
    }

    test("gives the caller probe the caller's CLAUDE_CONFIG_DIR and the child probe the server's", async () => {
      const { value, caller, child } = await underHostEnv(
        { CLAUDE_CONFIG_DIR: join(tmp, "caller-config") },
        { CLAUDE_CONFIG_DIR: join(tmp, "server-config") }
      );
      expect(value?.outcome).toBe("ok");
      expect(caller?.CLAUDE_CONFIG_DIR).toBe(join(tmp, "caller-config"));
      expect(child?.CLAUDE_CONFIG_DIR).toBe(join(tmp, "server-config"));
    });

    test("a caller launched without CLAUDE_CONFIG_DIR gets a caller probe without the server's", async () => {
      const { caller, child } = await underHostEnv(
        {},
        { CLAUDE_CONFIG_DIR: join(tmp, "server-config") }
      );
      expect(caller !== undefined && "CLAUDE_CONFIG_DIR" in caller).toBe(false);
      expect(child?.CLAUDE_CONFIG_DIR).toBe(join(tmp, "server-config"));
    });

    test("gives the caller probe the caller's CLAUDE_CODE_RESTRICTED when the server has none", async () => {
      const { value, caller, child } = await underHostEnv({ CLAUDE_CODE_RESTRICTED: "1" });
      expect(value?.outcome).toBe("ok");
      expect(caller?.CLAUDE_CODE_RESTRICTED).toBe("1");
      expect(child !== undefined && "CLAUDE_CODE_RESTRICTED" in child).toBe(false);
    });

    test("drops the server's CLAUDE_CODE_RESTRICTED from the caller probe when the caller has none", async () => {
      const { caller, child } = await underHostEnv({}, { CLAUDE_CODE_RESTRICTED: "1" });
      expect(caller !== undefined && "CLAUDE_CODE_RESTRICTED" in caller).toBe(false);
      expect(child?.CLAUDE_CODE_RESTRICTED).toBe("1");
    });

    test("every mode switch and plugin variable of the caller probe is the caller's, never the server's", async () => {
      const keys = Object.keys({ ...LAUNCH_MODE_SWITCHES, ...PLUGIN_VARS_OF_LAUNCH });
      const valued = (who: string) => Object.fromEntries(keys.map((k) => [k, `${who}-${k}`]));

      const both = await underHostEnv(valued("caller"), valued("server"));
      for (const key of keys) {
        expect(both.caller?.[key]).toBe(`caller-${key}`);
        expect(both.child?.[key]).toBe(`server-${key}`);
      }
      const serverOnly = await underHostEnv({}, valued("server"));
      for (const key of keys) {
        expect(serverOnly.caller !== undefined && key in serverOnly.caller).toBe(false);
        expect(serverOnly.child?.[key]).toBe(`server-${key}`);
      }
    });

    test("starts no probe when the caller's launch environment cannot be read (caller_env_unreadable)", async () => {
      const { value, lines, calls } = await underHostEnv(null);
      expect(value).toEqual({ plugins: [], outcome: "caller_env_unreadable" });
      expect(calls).toEqual([]);
      expect(lines.some((l) => l.includes("CLAUDE_CONFIG_DIR"))).toBe(true);
    });

    test("reads the caller's user settings and managed cache under the caller's own config dir", async () => {
      const callerConfig = join(tmp, "caller-config");
      put(join(callerConfig, "settings.json"), { apiKeyHelper: "/bin/echo would-run" });
      const helper = await underHostEnv({ CLAUDE_CONFIG_DIR: callerConfig });
      expect(helper.value).toEqual({ plugins: [], outcome: "user_command_setting" });
      expect(helper.calls).toEqual([]);

      rmSync(join(callerConfig, "settings.json"));
      put(join(callerConfig, "remote-settings.json"), { permissions: { deny: ["Bash"] } });
      const { caller, work, lists } = world();
      const calls: PluginProbeRequest[] = [];
      const { value } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: { ...managedIn(tmp), remoteSettingsFile: null, hybridSettingsDir: null },
          ...hostWith([], caller, { CLAUDE_CONFIG_DIR: callerConfig }),
          runner: scriptedRunner(lists, calls),
        })
      );
      expect(value).toEqual({ plugins: [], outcome: "managed_policy_present" });
      expect(calls).toEqual([]);
    });
  });

  describe("helpers in the caller's own project settings (caller_command_setting)", () => {
    async function underCaller(files: Record<string, unknown>, hostFlags: string[] = []) {
      const { caller, work, lists } = world();
      for (const [rel, value] of Object.entries(files)) put(join(caller, rel), value);
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith(hostFlags, caller),
          runner: scriptedRunner(lists, calls),
        })
      );
      return { caller, value, lines, calls };
    }

    for (const key of [
      "apiKeyHelper",
      "otelHeadersHelper",
      "proxyAuthHelper",
      "awsAuthRefresh",
      "awsCredentialExport",
      "gcpAuthRefresh",
      "policyHelpers",
    ]) {
      for (const file of [".claude/settings.json", ".claude/settings.local.json"]) {
        test(`starts no probe when the caller's ${file} sets ${key}`, async () => {
          const { caller, value, lines, calls } = await underCaller({
            [file]: { [key]: "/bin/echo would-run" },
          });
          expect(value).toEqual({ plugins: [], outcome: "caller_command_setting" });
          expect(calls).toEqual([]);
          expect(lines.some((l) => l.includes(join(caller, file)) && l.includes(key))).toBe(true);
          expect(lines.join("\n")).not.toContain("would-run");
        });
      }
    }

    test("checks the caller's --project-config-root, resolved against its launch directory", async () => {
      const { value, calls } = await underCaller(
        { "cfgroot/.claude/settings.json": { apiKeyHelper: "/bin/echo would-run" } },
        ["--project-config-root", "cfgroot"]
      );
      expect(value).toEqual({ plugins: [], outcome: "caller_command_setting" });
      expect(calls).toEqual([]);
    });

    test("starts no probe when the caller's project settings cannot be parsed", async () => {
      // an env layer of the caller's launch, read before the helper check
      const { value } = await underCaller({ ".claude/settings.json": "{ broken" });
      expect(value).toEqual({ plugins: [], outcome: "caller_settings_unreadable" });
    });

    test("probes beside a caller project statusLine, which a -p boot never runs", async () => {
      const { value, calls } = await underCaller({
        ".claude/settings.json": { statusLine: { type: "command", command: "/bin/echo s" } },
      });
      expect(value?.outcome).toBe("ok");
      expect(calls).toHaveLength(2);
    });
  });

  test("names each probe's temp folder with the server's pid, and removes a dead server's folder first", async () => {
    const { caller, work, lists } = world();
    const root = mkdirP(join(tmp, "probe-root"));
    const leftover = mkdirP(join(root, "claudish-plugin-probe-91001-AbC123"));
    put(join(leftover, "caller-settings.json"), { env: { X: "1" } });
    const folders: string[] = [];
    const runner = scriptedRunner(lists, [], (req) => {
      const settings = req.args[req.args.indexOf("--settings") + 1] as string;
      folders.push(join(settings, ".."));
      return { ok: true, plugins: lists[req.cwd] ?? [] };
    });

    await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner,
        probeTmpRoot: root,
        pidAlive: (pid) => pid === process.pid,
      })
    );

    expect(existsSync(leftover)).toBe(false);
    expect(folders).toHaveLength(2);
    for (const folder of folders) {
      expect(folder.startsWith(join(root, `claudish-plugin-probe-${process.pid}-`))).toBe(true);
      expect(existsSync(folder)).toBe(false);
    }
  });

  describe("user settings that run a command at a probe boot (user_command_setting)", () => {
    const home = () => join(tmp, "home");
    const userFile = () => join(home(), ".claude", "settings.json");
    async function underUser(
      user: unknown,
      extra: {
        childFlags?: string[];
        hostFlags?: string[];
        env?: Record<string, string>;
        hostEnv?: { CLAUDE_CONFIG_DIR?: string };
      } = {}
    ) {
      const { caller, work, lists } = world();
      if (user !== undefined) put(userFile(), user);
      const calls: PluginProbeRequest[] = [];
      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: extra.childFlags ?? [],
          env: { HOME: home(), ...extra.env },
          managed: managedIn(tmp),
          ...hostWith(extra.hostFlags ?? [], undefined, extra.hostEnv ?? {}),
          runner: scriptedRunner(lists, calls),
        })
      );
      return { value, lines, calls };
    }

    for (const key of [
      "apiKeyHelper",
      "otelHeadersHelper",
      "proxyAuthHelper",
      "awsAuthRefresh",
      "awsCredentialExport",
      "gcpAuthRefresh",
    ]) {
      test(`starts no probe when the user settings set ${key}`, async () => {
        const { value, lines, calls } = await underUser({ [key]: "/bin/echo would-run" });
        expect(value).toEqual({ plugins: [], outcome: "user_command_setting" });
        expect(calls).toEqual([]);
        expect(lines.some((l) => l.includes(userFile()) && l.includes(key))).toBe(true);
        expect(lines.join("\n")).not.toContain("would-run");
      });
    }

    test("probes beside a user statusLine, subagentStatusLine, fileSuggestion or processWrapper", async () => {
      const { value, calls } = await underUser({
        statusLine: { type: "command", command: "/bin/echo status" },
        subagentStatusLine: { type: "command", command: "/bin/echo sub" },
        fileSuggestion: { type: "command", command: "/bin/echo files" },
        processWrapper: "/bin/echo wrap",
      });
      expect(value?.outcome).toBe("ok");
      expect(calls).toHaveLength(2);
    });

    test("starts no probe when the user settings cannot be parsed", async () => {
      // the caller's user settings are an env layer of the caller's launch, read first
      const { value, calls } = await underUser("{ broken");
      expect(value).toEqual({ plugins: [], outcome: "caller_settings_unreadable" });
      expect(calls).toEqual([]);
    });

    test("reads the user settings in each probe's config dir: CLAUDE_CONFIG_DIR, resolved against the probe's cwd", async () => {
      const { caller } = world();
      put(join(caller, "cfg", "settings.json"), { apiKeyHelper: "/bin/echo would-run" });
      const { value, calls } = await underUser(undefined, {
        env: { CLAUDE_CONFIG_DIR: "cfg" },
        hostEnv: { CLAUDE_CONFIG_DIR: "cfg" },
      });
      expect(value).toEqual({ plugins: [], outcome: "user_command_setting" });
      expect(calls).toEqual([]);
    });

    test("probes when neither launch loads user settings (--setting-sources), and refuses when either does", async () => {
      const user = { apiKeyHelper: "/bin/echo would-run" };
      const noUser = ["--setting-sources", "project,local"];
      const neither = await underUser(user, { childFlags: noUser, hostFlags: noUser });
      expect(neither.value?.outcome).toBe("ok");
      expect(neither.calls).toHaveLength(2);
      const callerLoads = await underUser(user, { childFlags: noUser });
      expect(callerLoads.value?.outcome).toBe("user_command_setting");
      const childLoads = await underUser(user, { hostFlags: ["--setting-sources=project"] });
      expect(childLoads.value?.outcome).toBe("user_command_setting");
    });
  });

  test("passes the caller's --project-config-root to the caller probe and the child's to the child probe, each resolved against its launch directory", async () => {
    const { caller, work } = world();
    const calls: PluginProbeRequest[] = [];

    await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: ["--project-config-root=../child-root"],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(["--project-config-root", "conf", "--model", "opus"]),
        runner: scriptedRunner({}, calls),
      })
    );

    const loading = (cwd: string) => (calls.find((c) => c.cwd === cwd)?.args ?? []).slice(7, -2);
    expect(loading(caller)).toEqual(["--project-config-root", join(caller, "conf")]);
    expect(loading(work)).toEqual(["--project-config-root", join(tmp, "child-root")]);
  });

  test("starts no probe when work_dir's project settings file is not a regular file, without blocking on it", async () => {
    const { caller, work, lists } = world();
    mkdirSync(join(work, ".claude"), { recursive: true });
    expect(
      Bun.spawnSync(["mkfifo", join(work, ".claude", "settings.json")], {
        env: { PATH: "/usr/bin:/bin" },
      }).exitCode
    ).toBe(0);
    const calls: PluginProbeRequest[] = [];

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner: scriptedRunner(lists, calls),
      })
    );

    expect(value).toEqual({ plugins: [], outcome: "work_dir_command_setting" });
    expect(calls).toEqual([]);
  });

  test("starts no probe when the child's --project-config-root has project settings that set a command", async () => {
    const { caller, work, lists } = world();
    const root = mkdirP(join(tmp, "child-root"));
    put(join(root, ".claude", "settings.json"), { apiKeyHelper: "/bin/echo would-run" });
    const calls: PluginProbeRequest[] = [];

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: ["--project-config-root", root],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner: scriptedRunner(lists, calls),
      })
    );

    expect(value).toEqual({ plugins: [], outcome: "work_dir_command_setting" });
    expect(calls).toEqual([]);
  });

  test("starts no probe when the caller or the child is launched to read settings or plugins from stdin (await_initialize)", async () => {
    for (const flags of [
      ["--await-initialize"],
      ["--await-initialize", "--initialize-fields=settings"],
      ["--initialize-fields", "settings"],
      ["--managed-settings-in-initialize"],
    ]) {
      const caller = await handoverUnder(managedIn(tmp), { hostFlags: flags });
      expect(caller.value).toEqual({ plugins: [], outcome: "await_initialize" });
      expect(caller.calls).toEqual([]);
      expect(caller.lines.some((l) => l.includes("stdin"))).toBe(true);

      const child = await handoverUnder(managedIn(tmp), { childFlags: flags });
      expect(child.value).toEqual({ plugins: [], outcome: "await_initialize" });
      expect(child.calls).toEqual([]);
    }
  });

  test("does not hand over a caller copy of a plugin the child loads from its own --plugin-dir", async () => {
    const { caller, work, alpha2 } = world();
    const ownAlpha = pluginCopy("own-alpha", "alpha");
    const beta = pluginCopy("beta/1.0.0", "beta");
    // Claude Code's answer: the child's own --plugin-dir copy loads as alpha@inline
    const runner = scriptedRunner({}, [], (req) =>
      req.cwd === caller
        ? {
            ok: true,
            plugins: [entry("alpha", alpha2, "alpha@m", "2.0.0"), entry("beta", beta, "beta@m")],
          }
        : {
            ok: true,
            plugins: req.args.includes(ownAlpha) ? [entry("alpha", ownAlpha, "alpha@inline")] : [],
          }
    );

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: ["--plugin-dir", ownAlpha],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner,
      })
    );

    expect(value).toEqual({
      plugins: [{ id: "beta@m", version: undefined, path: beta }],
      outcome: "ok",
    });
  });

  describe("callerLaunchFlags", () => {
    test("is the flags after a native claude, a versioned binary, or node and the package's cli.js", () => {
      expect(callerLaunchFlags(["claude", "--resume", "a b"])).toEqual(["--resume", "a b"]);
      expect(callerLaunchFlags(["/Users/u/.local/bin/claude"])).toEqual([]);
      expect(
        callerLaunchFlags(["/Users/u/.local/share/claude/versions/2.1.332", "-w", "x"])
      ).toEqual(["-w", "x"]);
      expect(
        callerLaunchFlags([
          "node",
          "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
          "--plugin-dir",
          "/p",
        ])
      ).toEqual(["--plugin-dir", "/p"]);
    });

    test("is null for an empty argv, another program, a runtime option, or a pre-started spare", () => {
      expect(callerLaunchFlags([])).toBeNull();
      expect(callerLaunchFlags(["/bin/zsh", "-c", "claude"])).toBeNull();
      expect(callerLaunchFlags(["node", "/x/other.js"])).toBeNull();
      expect(
        callerLaunchFlags(["node", "--inspect", "/n/@anthropic-ai/claude-code/cli.js"])
      ).toBeNull();
      expect(callerLaunchFlags(["claude", "bg-spare", "--bg-spare", "/s"])).toBeNull();
      expect(callerLaunchFlags(["claude", "bg-pty-host", "--bg-pty-host", "/s"])).toBeNull();
      expect(callerLaunchFlags(["claude", "daemon", "run"])).toBeNull();
    });
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "readHostLaunch reads a live process's exact argv and cwd, and null for a gone one",
    async () => {
      const cwd = mkdirP(join(tmp, "dir with space"));
      const args = ["-c", "sleep 30; :", "a b", "", '--settings={"x": 1}', "ü"];
      const child = Bun.spawn(["/bin/sh", ...args], { cwd, env: { PATH: "/usr/bin:/bin" } });
      try {
        await Bun.sleep(100);
        const launch = readHostLaunch(child.pid);
        expect(launch?.argv).toEqual(["/bin/sh", ...args]);
        expect(launch?.cwd).toBe(cwd);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
      expect(readHostLaunch(child.pid)).toBeNull();
    }
  );

  for (const [file, key] of [
    ["settings.json", "apiKeyHelper"],
    ["settings.json", "statusLine"],
    ["settings.local.json", "otelHeadersHelper"],
    ["settings.local.json", "processWrapper"],
  ] as const) {
    test(`starts no probe when work_dir's ${file} sets ${key}`, async () => {
      const { caller, work, lists } = world();
      const path = join(work, ".claude", file);
      put(path, { [key]: "/bin/echo would-run" });
      const calls: PluginProbeRequest[] = [];

      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith(),
          runner: scriptedRunner(lists, calls),
        })
      );

      expect(value).toEqual({ plugins: [], outcome: "work_dir_command_setting" });
      expect(calls).toEqual([]);
      expect(lines.some((l) => l.includes(path) && l.includes(key))).toBe(true);
      expect(lines.join("\n")).not.toContain("would-run");
    });
  }

  test("starts no probe when work_dir's project settings cannot be parsed", async () => {
    const { caller, work, lists } = world();
    put(join(work, ".claude", "settings.json"), "{ broken");
    const calls: PluginProbeRequest[] = [];

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner: scriptedRunner(lists, calls),
      })
    );

    expect(value).toEqual({ plugins: [], outcome: "work_dir_command_setting" });
    expect(calls).toEqual([]);
  });

  test("probes beside a setup_from command setting no -p boot runs, and work_dir's other settings", async () => {
    const { caller, work, lists } = world();
    // a startup helper in the caller's own project settings refuses (caller_command_setting)
    put(join(caller, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "/bin/echo caller" },
    });
    put(join(work, ".claude", "settings.json"), { model: "x", env: { FOO: "1" } });
    const calls: PluginProbeRequest[] = [];

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner: scriptedRunner(lists, calls),
      })
    );

    expect(value?.outcome).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("does not hand over a copy the child's --settings turn off for it", async () => {
    const { caller, work, alpha2 } = world();
    const beta = pluginCopy("beta/1.0.0", "beta");
    const lists = {
      [caller]: [
        entry("alpha", alpha2, "alpha@m", "2.0.0"),
        entry("beta", beta, "beta@m", "1.0.0"),
      ],
      [work]: [],
    };
    const flags = ["--settings", '{"enabledPlugins":{"alpha@m":false}}'];
    const { layer } = buildInheritedSettingsLayer(caller, flags);

    const { value, lines } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer,
        childFlags: flags,
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner: scriptedRunner(lists, []),
      })
    );

    expect(value).toEqual({
      plugins: [{ id: "beta@m", version: "1.0.0", path: beta }],
      outcome: "ok",
    });
    expect(lines.some((l) => l.includes("alpha@m"))).toBe(true);
  });

  test("hands over a copy the child's settings set to true, or do not name", async () => {
    const { caller, work, alpha2 } = world();
    const lists = { [caller]: [entry("alpha", alpha2, "alpha@m", "2.0.0")], [work]: [] };
    for (const layer of [{ enabledPlugins: { "alpha@m": true } }, { enabledPlugins: {} }, null]) {
      const { value } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer,
          childFlags: [],
          env: { HOME: join(tmp, "home") },
          managed: managedIn(tmp),
          ...hostWith(),
          runner: scriptedRunner(lists, []),
        })
      );
      expect(value?.plugins.map((p) => p.id)).toEqual(["alpha@m"]);
    }
  });

  for (const cause of [
    "no_claude_binary",
    "spawn_failed",
    "exited_before_init",
    "timeout",
    "plugins_malformed",
    "assistant_before_init",
    "output_too_large",
    "no_result",
    "bad_result",
    "nonzero_exit",
    "turns",
    "aborted",
  ] as const) {
    test(`a probe that fails with ${cause} hands over nothing and logs the cause`, async () => {
      const { caller, work, lists } = world();
      const runner = scriptedRunner(lists, [], (req) =>
        req.cwd === work ? { ok: false, cause } : { ok: true, plugins: lists[req.cwd] ?? [] }
      );

      const { value, lines } = await logsOf(() =>
        inheritedPluginsFor({
          setupReal: caller,
          childCwd: work,
          layer: null,
          childFlags: [],
          env: { HOME: join(tmp, "home"), ANTHROPIC_API_KEY: "sk-ant-never-logged" },
          managed: managedIn(tmp),
          ...hostWith(),
          runner,
        })
      );

      expect(value).toEqual({ plugins: [], outcome: cause });
      expect(lines.filter((l) => l.includes(cause))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("sk-ant-never-logged");
    });
  }

  test("a runner that throws hands over nothing", async () => {
    const { caller, work } = world();
    const runner: PluginProbeRunner = async () => {
      throw new Error("boom");
    };

    const { value } = await logsOf(() =>
      inheritedPluginsFor({
        setupReal: caller,
        childCwd: work,
        layer: null,
        childFlags: [],
        env: { HOME: join(tmp, "home") },
        managed: managedIn(tmp),
        ...hostWith(),
        runner,
      })
    );

    expect(value).toEqual({ plugins: [], outcome: "spawn_failed" });
  });
});

describe("spawnPluginProbe", () => {
  function setup(mode: Parameters<ReturnType<typeof writeFakeClaude>["setPlan"]>[0]["mode"]) {
    const fake = writeFakeClaude(mkdirP(join(tmp, "bin")));
    const cwd = mkdirP(join(tmp, "probe-cwd"));
    const alpha = pluginCopy("alpha/2.0.0", "alpha");
    fake.setPlan({
      mode,
      lists: { [cwd]: [{ name: "alpha", path: alpha, source: "alpha@m", version: "2.0.0" }] },
    });
    const request: PluginProbeRequest = {
      cwd,
      args: ["-p", "/effort"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CLAUDE_PATH: fake.binary,
        FAKE_CLAUDE_PLAN: fake.planFile,
      },
      timeoutMs: 3_000,
    };
    return { fake, cwd, alpha, request };
  }

  /** The one fake run's pid, and whether it is gone. */
  function onlyRunGone(fake: ReturnType<typeof writeFakeClaude>): boolean {
    const runs = fake.runs();
    expect(runs).toHaveLength(1);
    return !processAlive((runs[0] as { pid: number }).pid);
  }

  test("reads the init plugins of a probe that exits 0 on a successful result with no turn", async () => {
    const { fake, cwd, alpha, request } = setup("ok");

    const result = await spawnPluginProbe(request);

    expect(result).toEqual({
      ok: true,
      plugins: [{ name: "alpha", path: alpha, source: "alpha@m", version: "2.0.0" }],
    });
    expect(fake.runs()[0]?.cwd).toBe(cwd);
    expect(onlyRunGone(fake)).toBe(true);
  });

  for (const [mode, cause] of [
    ["fatal", "bad_result"],
    ["fatalzero", "bad_result"],
    ["resultfirst", "bad_result"],
    ["tworesults", "bad_result"],
    ["errorthenok", "bad_result"],
    ["errorzero", "bad_result"],
    ["nosubtype", "bad_result"],
    ["okexit1", "nonzero_exit"],
    ["turn", "turns"],
    ["model", "turns"],
    ["noresult", "no_result"],
  ] as const) {
    test(`a probe that prints its init plugins and then ${mode} fails closed as ${cause}`, async () => {
      const { fake, request } = setup(mode);
      expect(await spawnPluginProbe(request)).toEqual({ ok: false, cause });
      expect(onlyRunGone(fake)).toBe(true);
    });
  }

  test("a probe that prints its init plugins and then hangs fails closed as timeout, within the deadline", async () => {
    const { fake, request } = setup("hang");
    const started = Date.now();
    expect(await spawnPluginProbe({ ...request, timeoutMs: 800 })).toEqual({
      ok: false,
      cause: "timeout",
    });
    // end to end: the deadline holds the kill and the wait for the group
    expect(Date.now() - started).toBeLessThan(800 + 250);
    expect(onlyRunGone(fake)).toBe(true);
  });

  test("a wrapper that exits before any output has its whole process group killed", async () => {
    const { fake, request } = setup("wrapper");

    expect(await spawnPluginProbe(request)).toEqual({ ok: false, cause: "exited_before_init" });

    const run = fake.runs()[0] as { pid: number; descendantPid?: number };
    expect(run.descendantPid).toBeGreaterThan(0);
    expect(processAlive(run.descendantPid as number)).toBe(false);
    expect(processAlive(run.pid)).toBe(false);
  });

  test("an assistant event before init fails closed and kills the probe", async () => {
    const { fake, request } = setup("assistant");
    expect(await spawnPluginProbe(request)).toEqual({ ok: false, cause: "assistant_before_init" });
    expect(onlyRunGone(fake)).toBe(true);
  });

  /**
   * The pids the fake's wrapper wrote, once one is there or `waitMs` has passed: a run killed
   * before its wrapper's first command writes none, and a run that outlived a kill writes its
   * pid however late it was scheduled.
   */
  async function startedPids(
    fake: ReturnType<typeof writeFakeClaude>,
    waitMs: number
  ): Promise<number[]> {
    const until = Date.now() + waitMs;
    while (fake.starts().length === 0 && Date.now() < until) await Bun.sleep(25);
    return fake.starts();
  }

  test("no init within the timeout fails closed and kills the probe", async () => {
    const { fake, request } = setup("noinit");
    const started = Date.now();
    expect(await spawnPluginProbe({ ...request, timeoutMs: 400 })).toEqual({
      ok: false,
      cause: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(400 + 250);
    // Nothing waits on how fast the fake starts: on a loaded machine the kill can land before
    // its Bun, or its wrapper, has run at all. Every pid the wrapper wrote must be gone.
    const pids = await startedPids(fake, 2_000);
    expect(pids.length).toBeLessThanOrEqual(1);
    for (const pid of pids) expect(processAlive(pid)).toBe(false);
  });

  test("an exit before init fails closed", async () => {
    const { fake, request } = setup("exit1");
    expect(await spawnPluginProbe(request)).toEqual({ ok: false, cause: "exited_before_init" });
    expect(onlyRunGone(fake)).toBe(true);
  });

  test("a malformed plugins field fails closed and kills the probe", async () => {
    const { fake, request } = setup("malformed");
    expect(await spawnPluginProbe(request)).toEqual({ ok: false, cause: "plugins_malformed" });
    expect(onlyRunGone(fake)).toBe(true);
  });

  test("an abort fails closed as aborted and kills the probe", async () => {
    const { fake, request } = setup("noinit");
    const controller = new AbortController();
    const result = spawnPluginProbe({ ...request, timeoutMs: 30_000, signal: controller.signal });
    for (let i = 0; i < 100 && fake.runs().length === 0; i++) await Bun.sleep(50);
    controller.abort();

    expect(await result).toEqual({ ok: false, cause: "aborted" });
    expect(onlyRunGone(fake)).toBe(true);
  });

  test("a signal aborted before the start starts no probe", async () => {
    const { fake, request } = setup("ok");
    expect(await spawnPluginProbe({ ...request, signal: AbortSignal.abort() })).toEqual({
      ok: false,
      cause: "aborted",
    });
    expect(fake.runs()).toEqual([]);
  });

  test("the binary lookup is aborted at the deadline and at shutdown, and the probe waits for it", async () => {
    for (const [abortAt, cause] of [
      ["deadline", "timeout"],
      ["shutdown", "aborted"],
    ] as const) {
      const controller = new AbortController();
      let lookupSettled = false;
      let probeSettledFirst = false;
      const runner = pluginProbeRunner((_env, signal) => {
        if (abortAt === "shutdown") setTimeout(() => controller.abort(), 50);
        return new Promise((settle) => {
          signal?.addEventListener("abort", () =>
            // a lookup that needs a moment to reap its shell after the abort
            setTimeout(() => {
              lookupSettled = true;
              settle(null);
            }, 30)
          );
        });
      });
      const started = Date.now();
      const result = await runner({
        cwd: tmp,
        args: [],
        env: { HOME: join(tmp, "home") },
        timeoutMs: 400,
        signal: controller.signal,
      }).then((r) => {
        probeSettledFirst = !lookupSettled;
        return r;
      });

      expect(result).toEqual({ ok: false, cause });
      expect(probeSettledFirst).toBe(false);
      expect(Date.now() - started).toBeLessThan(400 + 250);
    }
  });

  test("a binary lookup that never settles after its abort still answers timeout at the deadline, and logs that it outlived it", async () => {
    for (const [abortAt, cause] of [
      ["deadline", "timeout"],
      ["shutdown", "aborted"],
    ] as const) {
      const controller = new AbortController();
      let lookupAborted = false;
      const runner = pluginProbeRunner((_env, signal) => {
        if (abortAt === "shutdown") setTimeout(() => controller.abort(), 50);
        signal.addEventListener("abort", () => {
          lookupAborted = true;
        });
        // a lookup shell stuck where SIGKILL cannot reap it: never settles
        return new Promise(() => {});
      });
      const started = Date.now();
      const { value, lines } = await logsOf(() =>
        runner({ cwd: tmp, args: [], env: {}, timeoutMs: 400, signal: controller.signal })
      );

      expect(value).toEqual({ ok: false, cause });
      expect(lookupAborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(400 + 250);
      expect(lines.some((l) => l.includes("binary lookup") && l.includes("deadline"))).toBe(true);
    }
  });

  test("shellLookup kills the lookup shell and its children on abort, and settles once they are gone", async () => {
    const pidFile = join(tmp, "shell.pid");
    const controller = new AbortController();
    const found = shellLookup(`echo $$ > '${pidFile}'; sleep 30; echo /never`, controller.signal);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(20);
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    expect(processAlive(pid)).toBe(true);

    controller.abort();

    expect(await found).toBeNull();
    expect(processAlive(pid)).toBe(false);
  });

  test("shellLookup starts nothing for a signal already aborted, and reads the first line otherwise", async () => {
    const marker = join(tmp, "ran");
    expect(await shellLookup(`touch '${marker}'; echo /x`, AbortSignal.abort())).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(await shellLookup("echo /usr/bin/claude; echo /other")).toBe("/usr/bin/claude");
    expect(await shellLookup("exit 1")).toBeNull();
  });

  test("a CLAUDE_PATH that cannot be started fails closed as spawn_failed", async () => {
    const { request } = setup("ok");
    const notExecutable = join(tmp, "not-executable");
    writeFileSync(notExecutable, "plain text\n", { mode: 0o644 });

    expect(
      await spawnPluginProbe({ ...request, env: { ...request.env, CLAUDE_PATH: notExecutable } })
    ).toEqual({ ok: false, cause: "spawn_failed" });
  });
});

describe("pluginProbeRunner: the binary the probe starts", () => {
  /** A good fake under `server/bin`, and a script at the same relative path under the probe cwd. */
  function twoBinaries() {
    const server = mkdirP(join(tmp, "server"));
    const fake = writeFakeClaude(mkdirP(join(server, "bin")));
    const cwd = mkdirP(join(tmp, "probe-cwd"));
    fake.setPlan({ mode: "ok", lists: { [cwd]: [] } });
    const decoy = join(mkdirP(join(cwd, "bin")), "fake-claude");
    writeFileSync(decoy, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const request: PluginProbeRequest = {
      cwd,
      args: ["-p", "/effort"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_CLAUDE_PLAN: fake.planFile },
      timeoutMs: 3_000,
    };
    return { server, fake, cwd, request };
  }

  test("starts a relative binary from the server's directory, not from the probe's cwd", async () => {
    const { server, fake, request } = twoBinaries();
    const runner = pluginProbeRunner(
      async () => "./bin/fake-claude",
      () => server
    );

    expect(await runner(request)).toEqual({ ok: true, plugins: [] });
    expect(fake.runs()).toHaveLength(1);
  });

  test("asks the lookup for a relative CLAUDE_PATH as its absolute real path in the server's directory", async () => {
    const { server, request } = twoBinaries();
    const asked: (string | undefined)[] = [];
    const runner = pluginProbeRunner(
      async (env) => {
        asked.push(env.CLAUDE_PATH);
        return null;
      },
      () => server
    );

    await runner({ ...request, env: { ...request.env, CLAUDE_PATH: "bin/fake-claude" } });

    expect(asked).toEqual([realpathSync(join(server, "bin", "fake-claude"))]);
  });

  test("a relative CLAUDE_PATH that names nothing in the server's directory starts no probe", async () => {
    const { request } = twoBinaries();
    const asked: (string | undefined)[] = [];
    const runner = pluginProbeRunner(
      async (env) => {
        asked.push(env.CLAUDE_PATH);
        return "/bin/false";
      },
      () => mkdirP(join(tmp, "empty-server"))
    );

    expect(
      await runner({ ...request, env: { ...request.env, CLAUDE_PATH: "bin/fake-claude" } })
    ).toEqual({ ok: false, cause: "no_claude_binary" });
    expect(asked).toEqual([]);
  });

  /** `<root>/link -> <root>/a/b`, so `link/..` is `<root>/a` on disk and `<root>` lexically. */
  function dotDotWorld(executableAt: "a/bin" | "bin") {
    const root = mkdirP(join(tmp, "dotdot"));
    mkdirP(join(root, "a", "b"));
    symlinkSync(join(root, "a", "b"), join(root, "link"));
    const fake = join(mkdirP(join(root, executableAt)), "fake");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { root, fake };
  }

  function askingRunner(server: string) {
    const asked: (string | undefined)[] = [];
    const runner = pluginProbeRunner(
      async (env) => {
        asked.push(env.CLAUDE_PATH);
        return null;
      },
      () => server
    );
    return { asked, runner };
  }

  test("a relative CLAUDE_PATH with no empty, `.` or `..` segment is joined to the server's directory as text", async () => {
    const root = mkdirP(join(tmp, "plain-join"));
    const fake = join(mkdirP(join(root, "bin")), "fake");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { request } = twoBinaries();
    const { asked, runner } = askingRunner(root);

    for (const named of ["./bin/fake", "bin/fake"]) {
      await runner({ ...request, env: { ...request.env, CLAUDE_PATH: named } });
    }

    expect(asked).toEqual([`${root}/bin/fake`, `${root}/bin/fake`]);
  });

  test("a relative CLAUDE_PATH with a trailing slash, an empty, `.` or `..` segment starts no probe, even where a file is found", async () => {
    const { request } = twoBinaries();
    // From "/", the kernel refuses the first two (ENOTDIR) where a component walk finds /usr/bin/true.
    const fromRoot = askingRunner("/");
    for (const named of ["./usr/bin/true/", "./usr/bin/true/."]) {
      expect(
        await fromRoot.runner({ ...request, env: { ...request.env, CLAUDE_PATH: named } })
      ).toEqual({ ok: false, cause: "no_claude_binary" });
    }
    const root = mkdirP(join(tmp, "segments"));
    mkdirP(join(root, "a"));
    writeFileSync(join(root, "b"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(root, "a", "b"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const inRoot = askingRunner(root);
    for (const named of ["./a/../b", "a//b", "a/./b", "../segments/b"]) {
      expect(
        await inRoot.runner({ ...request, env: { ...request.env, CLAUDE_PATH: named } })
      ).toEqual({ ok: false, cause: "no_claude_binary" });
    }
    expect([...fromRoot.asked, ...inRoot.asked]).toEqual([]);
  });

  test("a relative CLAUDE_PATH through a symlink and `..` starts no probe, wherever the file is", async () => {
    const { request } = twoBinaries();
    for (const at of ["a/bin", "bin"] as const) {
      const { root } = dotDotWorld(at);
      const { asked, runner } = askingRunner(root);
      expect(
        await runner({ ...request, env: { ...request.env, CLAUDE_PATH: "./link/../bin/fake" } })
      ).toEqual({ ok: false, cause: "no_claude_binary" });
      expect(asked).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a relative binary the lookup finds is checked by the same rule", async () => {
    const { server, fake, request } = twoBinaries();
    for (const found of ["./bin/fake-claude/", "bin//fake-claude", "./x/../bin/fake-claude"]) {
      const runner = pluginProbeRunner(
        async () => found,
        () => server
      );
      expect(await runner(request)).toEqual({ ok: false, cause: "no_claude_binary" });
    }
    expect(fake.runs()).toHaveLength(0);
  });

  test("a relative CLAUDE_PATH naming a directory or a file that is not executable starts no probe", async () => {
    const root = mkdirP(join(tmp, "not-binaries"));
    writeFileSync(join(root, "plain"), "x\n", { mode: 0o644 });
    mkdirP(join(root, "dir"));
    const { request } = twoBinaries();
    const { asked, runner } = askingRunner(root);

    for (const named of ["plain", "dir"]) {
      expect(await runner({ ...request, env: { ...request.env, CLAUDE_PATH: named } })).toEqual({
        ok: false,
        cause: "no_claude_binary",
      });
    }
    expect(asked).toEqual([]);
  });
});
