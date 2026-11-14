import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "./config-override.js";

interface LaunchResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  childEnv: Record<string, string> | null;
  output: string;
}

const foreignArgs = ["--model", "ollama@llama3.2"];
const invalidGatewayUrl = "http://example.com:18081";

function killLaunchGroup(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  try {
    // Each launch has its own process group, including the stand-in child.
    process.kill(-proc.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function targetHeaderLines(env: Record<string, string>): string[] {
  return (env.ANTHROPIC_CUSTOM_HEADERS ?? "")
    .split(/\r?\n/)
    .filter((line) => /^\s*x-target-url\s*:/i.test(line));
}

function startedChild(result: LaunchResult): Record<string, string> {
  expect({ code: result.code, signal: result.signal }, result.output).toEqual({
    code: 0,
    signal: null,
  });
  expect(result.childEnv, result.output).not.toBeNull();
  if (!result.childEnv) throw new Error("The stand-in Claude Code child did not start");
  return result.childEnv;
}

describe.skipIf(process.platform === "win32")("REQ-5: harness gateway CLI launches", () => {
  let dir: string;
  let home: string;
  let configPath: string;
  let gateway: ReturnType<typeof Bun.serve>;
  let gatewayUrl: string;
  let active: { proc: ChildProcess; closed: Promise<unknown> } | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudish-gateway-launch-test-"));
    home = join(dir, "home");
    mkdirSync(home);
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".config"));
    configPath = join(dir, "config.json");
    writeFileSync(configPath, "{}");
    setConfigFileOverride(configPath);

    // Reserve a distinct ephemeral gateway port; no real gateway or model is run.
    gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("No model requests are expected in this launch test", { status: 503 }),
    });
    gatewayUrl = gateway.url.origin;
  });

  afterEach(async () => {
    try {
      if (active) {
        killLaunchGroup(active.proc);
        await active.closed;
      }
    } finally {
      active = undefined;
      setConfigFileOverride(null);
      gateway?.stop(true);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function launch(
    args: string[],
    config: { harnessGateway?: { url: string } }
  ): Promise<LaunchResult> {
    writeFileSync(configPath, JSON.stringify(config));
    const out = join(dir, "child-env.json");
    const standIn = join(dir, "claude");
    writeFileSync(
      standIn,
      `#!/bin/sh\nexec "${process.execPath}" --no-env-file -e 'require("fs").writeFileSync(process.env.ENV_OUT, JSON.stringify(process.env))'\n`
    );
    chmodSync(standIn, 0o755);

    // Startup must not contact a real provider, catalog, telemetry or update service.
    const denyFetch = join(dir, "deny-fetch.cjs");
    writeFileSync(
      denyFetch,
      `globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, self, args) {
    const input = args[0];
    const url = String(input && typeof input === "object" && "url" in input ? input.url : input);
    // In-process data, such as a WebAssembly module inlined as a data: URL, is not network access.
    if (url.startsWith("data:") || url.startsWith("file:")) return Reflect.apply(target, self, args);
    throw new Error("Network access is disabled in the gateway launch test");
  }
});\n`
    );

    const proc = spawn(
      process.execPath,
      [
        "run",
        "--no-env-file",
        "--preload",
        denyFetch,
        join(import.meta.dir, "index.ts"),
        ...args,
        "-y",
        "hi",
      ],
      {
        cwd: dir,
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: dir,
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          XDG_CONFIG_HOME: join(home, ".config"),
          ZDOTDIR: home,
          CLAUDISH_CONFIG: configPath,
          CLAUDE_PATH: standIn,
          ENV_OUT: out,
          _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    let spawnError: Error | undefined;
    proc.once("error", (error) => {
      spawnError = error;
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        proc.once("close", (code, signal) => resolve({ code, signal }));
      }
    );
    active = { proc, closed };

    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      killLaunchGroup(proc);
    }, 25_000);
    try {
      const exit = await closed;
      if (spawnError) throw spawnError;
      if (timedOut) throw new Error(`Claudish launch timed out.\n${output}`);
      return {
        ...exit,
        childEnv: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null,
        output,
      };
    } finally {
      clearTimeout(deadline);
      killLaunchGroup(proc);
      active = undefined;
    }
  }

  test("REQ-5: a valid gateway reaches the foreign-model child with one proxy target", async () => {
    const result = await launch(foreignArgs, { harnessGateway: { url: gatewayUrl } });

    const env = startedChild(result);
    expect(env.ANTHROPIC_BASE_URL).toBe(gatewayUrl);
    const targets = targetHeaderLines(env);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatch(/^X-Target-URL: http:\/\/127\.0\.0\.1:\d+$/);
    const proxyUrl = new URL(targets[0].slice("X-Target-URL: ".length));
    expect(Number(proxyUrl.port)).toBeGreaterThan(0);
    expect(Number(proxyUrl.port)).toBeLessThanOrEqual(65_535);
    expect(proxyUrl.port).not.toBe(new URL(gatewayUrl).port);
  }, 30_000);

  test("REQ-5: an invalid gateway exits nonzero without starting Claude Code", async () => {
    const result = await launch(foreignArgs, { harnessGateway: { url: invalidGatewayUrl } });

    expect(result.signal, result.output).toBeNull();
    expect(result.code, result.output).not.toBeNull();
    expect(result.code, result.output).not.toBe(0);
    expect(result.childEnv, result.output).toBeNull();
  }, 30_000);

  test("REQ-5: no gateway key keeps the foreign-model child on the local proxy", async () => {
    const result = await launch(foreignArgs, {});

    const env = startedChild(result);
    expect(env.ANTHROPIC_BASE_URL).toStartWith("http://127.0.0.1:");
    expect(targetHeaderLines(env)).toEqual([]);
  }, 30_000);

  test.each(["valid", "invalid"] as const)(
    "REQ-5: a monitor child ignores a %s gateway",
    async (validity) => {
      const configuredUrl = validity === "valid" ? gatewayUrl : invalidGatewayUrl;

      const result = await launch(["--monitor"], { harnessGateway: { url: configuredUrl } });

      const env = startedChild(result);
      expect(env.ANTHROPIC_BASE_URL).not.toBe(configuredUrl);
      expect(targetHeaderLines(env)).toEqual([]);
    },
    30_000
  );
});
