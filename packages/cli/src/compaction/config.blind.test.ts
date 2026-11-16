import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.COMPACTION_BLIND_FILE !== import.meta.path) {
  test("runs compaction contract cases with an isolated HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "compaction-blind-home-"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC|CLAUDE|CLAUDISH|OPENAI|OP_|XDG_)/.test(key)) delete env[key];
    }
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: home,
      env: {
        ...env,
        HOME: home,
        COMPACTION_BLIND_FILE: import.meta.path,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const watchdog = setTimeout(() => child.kill(), 50_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally {
      clearTimeout(watchdog);
      child.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
} else {
  const localFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === "http:" || url.protocol === "https:") {
      throw new Error("Unexpected network access in blind tests");
    }
    return localFetch(input, init);
  }) as typeof fetch;

  const { mkdirSync, writeFileSync } = await import("node:fs");
  const {
    DEFAULT_COMPACTION_SETTINGS,
    DEFAULT_COMPACTION_MODEL,
    COMPACTION_ENV_VAR,
    parseCompactionEnv,
    resolveCompactionEnabled,
    readCompactionBlock,
    resolveCompactionModel,
  } = await import("./config.js");
  const { loadConfig } = await import("../profile-config.js");
  const { parseArgs } = await import("../cli.js");
  const configFile = join(process.env.HOME!, ".claudish", "config.json");
  let previousEnv: string | undefined;
  beforeEach(() => {
    previousEnv = process.env.CLAUDISH_COMPACTION;
    delete process.env.CLAUDISH_COMPACTION;
    mkdirSync(join(process.env.HOME!, ".claudish"), { recursive: true });
    writeFileSync(configFile, "{}");
  });
  afterEach(() => {
    if (previousEnv === undefined) delete process.env.CLAUDISH_COMPACTION;
    else process.env.CLAUDISH_COMPACTION = previousEnv;
    rmSync(configFile, { force: true });
  });

  test("REQ-1 REQ-2 REQ-13: defaults are opt-in, haiku, and the documented numeric limits", () => {
    expect(COMPACTION_ENV_VAR).toBe("CLAUDISH_COMPACTION");
    expect(DEFAULT_COMPACTION_MODEL).toBe("haiku");
    expect(DEFAULT_COMPACTION_SETTINGS).toMatchObject({
      enabled: false,
      model: "haiku",
      toolOutputs: { enabled: true, minTokens: 4000, timeoutMs: 20000, maxRatio: 0.6 },
      history: { enabled: true, precomputeAt: 0.6, applyAt: 0.75 },
    });
    expect(resolveCompactionEnabled({})).toBe(false);
  });

  for (const flag of [undefined, false, true]) {
    for (const env of [undefined, "0", "1", "invalid"]) {
      for (const enabled of [undefined, false, true]) {
        test("REQ-1: precedence flag=" + flag + " env=" + env + " file=" + enabled, () => {
          const expected = flag ?? (env === "1" ? true : env === "0" ? false : (enabled ?? false));
          expect(
            resolveCompactionEnabled({
              flag,
              env,
              block: enabled === undefined ? undefined : { enabled },
            })
          ).toBe(expected);
        });
      }
    }
  }
  test("REQ-1: env accepts documented case-insensitive values and ignores unrecognized values", () => {
    for (const value of ["1", "true", "on", "yes", "TRUE", "On", "YeS"])
      expect(parseCompactionEnv(value)).toBe(true);
    for (const value of ["0", "false", "off", "no", "FALSE", "Off", "No"])
      expect(parseCompactionEnv(value)).toBe(false);
    for (const value of [undefined, "", "2", "enabled"])
      expect(parseCompactionEnv(value)).toBeUndefined();
  });

  for (const block of [
    { enabled: "true" },
    { enabled: true, toolOutputs: { minTokens: 0 } },
    { enabled: true, toolOutputs: { minTokens: 1.5 } },
    { enabled: true, toolOutputs: { timeoutMs: -1 } },
    { enabled: true, toolOutputs: { maxRatio: 0 } },
    { enabled: true, toolOutputs: { maxRatio: 1.01 } },
    { enabled: true, history: { precomputeAt: 0 } },
    { enabled: true, history: { applyAt: 1.1 } },
    { enabled: true, history: { precomputeAt: 0.8, applyAt: 0.8 } },
    { enabled: true, history: { precomputeAt: 0.9, applyAt: 0.8 } },
  ]) {
    test("REQ-1: invalid block is ignored with a warning: " + JSON.stringify(block), () => {
      const result = readCompactionBlock(block);
      expect(result.warning).toMatch(/compaction/i);
      expect(result.enabled).not.toBe(true);
      expect(result.settings).toMatchObject({
        toolOutputs: DEFAULT_COMPACTION_SETTINGS.toolOutputs,
        history: DEFAULT_COMPACTION_SETTINGS.history,
      });
      expect(resolveCompactionEnabled({ block })).toBe(false);
    });
  }

  test("REQ-1: loadConfig retains the full compaction block", () => {
    const block = {
      enabled: true,
      model: "claude-haiku-5-5",
      toolOutputs: { enabled: false, minTokens: 123, timeoutMs: 456, maxRatio: 0.4 },
      history: { enabled: true, precomputeAt: 0.5, applyAt: 0.9 },
    };
    writeFileSync(configFile, JSON.stringify({ compaction: block }));
    expect(loadConfig().compaction).toEqual(block);
  });

  for (const [flags, env, file, expected] of [
    [[], undefined, undefined, false],
    [[], undefined, true, true],
    [[], "0", true, false],
    [[], "1", false, true],
    [["--compaction"], "0", false, true],
    [["--no-compaction"], "1", true, false],
  ] as const) {
    test("REQ-1: parseArgs honors flags/env/file: " +
      JSON.stringify({ flags, env, file }), async () => {
      writeFileSync(
        configFile,
        JSON.stringify({ compaction: file === undefined ? undefined : { enabled: file } })
      );
      if (env === undefined) delete process.env.CLAUDISH_COMPACTION;
      else process.env.CLAUDISH_COMPACTION = env;
      const parsed = await parseArgs(["--model", "ollama@test-model", ...flags]);
      expect(parsed.compaction).toBe(expected);
      expect(typeof parsed.compaction).toBe("boolean");
    });
  }
  test("REQ-2: non-Claude model resolution is rejected", () => {
    expect(resolveCompactionModel("not-a-claude-model")).toMatchObject({
      ok: false,
      reason: expect.any(String),
    });
  });
}
