import { afterEach, beforeEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanEnv } from "./claude-behaviour.js";

export interface BlindSandbox {
  home: string;
  settingsFile: string;
  ledgerPath: string;
  tokenFile: string;
  configFile: string;
}

export function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

export function json<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function childEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...cleanEnv(home),
    CLAUDISH_TOKEN_FILE: join(home, "tokens.json"),
    CLAUDISH_CONFIG: join(home, "config.json"),
    ...extra,
  };
}

/** Production module imports occur inside isolatedFile, after its disposable HOME exists. */
export function useSandbox(): () => BlindSandbox {
  let current: BlindSandbox;
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    const home = mkdtempSync(join(tmpdir(), "model-lineup-blind-"));
    current = {
      home,
      settingsFile: join(home, ".claude", "settings.json"),
      ledgerPath: join(home, ".claudish", "model-setting-restore.json"),
      tokenFile: join(home, "tokens.json"),
      configFile: join(home, "config.json"),
    };
    const marker = process.env.T_CLAUDE_BEHAVIOUR_FILE;
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, childEnv(home));
    if (marker) process.env.T_CLAUDE_BEHAVIOUR_FILE = marker;
    put(current.settingsFile, {});
    put(current.configFile, {});
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(current.home, { recursive: true, force: true });
  });

  return () => current;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function networkGuard(home: string): string {
  const path = join(home, "deny-network.ts");
  put(
    path,
    [
      "const original = globalThis.fetch;",
      "globalThis.fetch = Object.assign(async function(input, init) {",
      "  const raw = input instanceof Request ? input.url : String(input);",
      "  const url = new URL(raw);",
      '  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {',
      '    throw new Error("Network denied by blind test: " + url.origin);',
      "  }",
      "  return original(input, init);",
      "}, original);",
    ].join("\n")
  );
  return path;
}

export async function runProgram(
  home: string,
  args: string[],
  extra: Record<string, string> = {},
  timeoutMs = 30_000
) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--preload", networkGuard(home), ...args],
    {
      cwd: home,
      env: childEnv(home, extra),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

export async function runChild(home: string, source: string, extra: Record<string, string> = {}) {
  return runProgram(home, ["--eval", source], extra);
}

/** A stand-in records only disposable test data; it never contacts a model. */
export function fakeClaude(home: string): Record<string, string> {
  const path = join(home, "fake-claude");
  put(
    path,
    "#!" +
      process.execPath +
      "\n" +
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'if (args.includes("--version")) { console.log("2.1.325 (Claude Code)"); process.exit(0); }',
        'const i = args.indexOf("--settings");',
        "let settings = {};",
        'if (i >= 0 && existsSync(args[i + 1])) settings = JSON.parse(readFileSync(args[i + 1], "utf8"));',
        "writeFileSync(process.env.T_CHILD_RECORD, JSON.stringify({ args, settings, env: process.env }));",
        'console.log(JSON.stringify({type:"result", subtype:"success", result:"stand-in", is_error:false, usage:{input_tokens:0,output_tokens:0}}));',
      ].join("\n")
  );
  chmodSync(path, 0o700);
  return {
    CLAUDE_PATH: path,
    CLAUDISH_BIN: path,
    T_CHILD_RECORD: join(home, "child-record.json"),
  };
}

export async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (true) {
    try {
      readFileSync(path);
      return;
    } catch {
      /* The other process has not published yet. */
    }
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for " + path);
    await Bun.sleep(10);
  }
}
