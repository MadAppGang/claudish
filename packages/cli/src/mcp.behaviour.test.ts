import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isolatedFile, MODEL, LOGIN, temp, put, cleanEnv, standIn, childRecord, contractConfig, CONTRACT_OFFLINE_NETWORK } from "./test-helpers/claude-behaviour.js";
await isolatedFile(import.meta, async () => {
  const { stripUnrequestedProvider, givenWhereNotNative, claudeSpecRefusalResult, runPrompt } = await import("./mcp-server.js");
  const { claudeCodePrintArgv, runPromptViaClaudeCode } = await import("./mcp/run-prompt-claude-code.js");
  const { claudeSubscriptionSpecRefusal } = await import("./providers/native-route.js");

  async function withPrintEnv(run: (home: string) => Promise<void>) {
    const home = temp();
    const env = { ...standIn(home), CLAUDE_CODE_OAUTH_TOKEN: LOGIN };
    const names = Object.keys(env), saved = names.map(n => process.env[n]);
    Object.assign(process.env, env);
    try { await run(home); } finally {
      names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("B-37 preserves subscription specs while stripping unrequested API routes", () => {
    const isCatalog = () => true;
    expect(stripUnrequestedProvider("anthropic@" + MODEL, false, isCatalog)).toBe(MODEL);
    for (const spec of ["claude@" + MODEL, "claude@gpt-6-luna", "claude@" + MODEL + "#fast", "claude@" + MODEL + ":3"])
      for (const required of [false, true]) expect(stripUnrequestedProvider(spec, required, isCatalog)).toBe(spec);
    expect(givenWhereNotNative(["anthropic@" + MODEL, "grok@g"], [MODEL, "grok@g"])).toEqual(["grok@g"]);
  });

  test("B-38 returns the original subscription refusal as an MCP error", () => {
    expect(claudeSpecRefusalResult(["claude@gpt-6"])).toEqual({
      isError: true, content: [{ type: "text", text: "Error: claude@gpt-6 refused: claude@ serves Claude Code's own Claude models; gpt-6 is not one" }],
    });
    expect(claudeSpecRefusalResult([MODEL, "anthropic@" + MODEL])).toBeUndefined();
  });

  test("B-39 refuses run_prompt modifiers before spawning", async () => {
    await withPrintEnv(async home => {
      for (const suffix of ["#fast", ":3"]) {
        const spec = "claude@" + MODEL + suffix;
        await expect(runPrompt(spec, "hi")).rejects.toThrow(claudeSubscriptionSpecRefusal(spec)!);
        expect(existsSync(join(home, "child.json"))).toBe(false);
      }
    });
  });

  test("B-40 pins only explicit subscription print children", async () => {
    const bare = claudeCodePrintArgv("claude-haiku-x", undefined);
    expect(bare).toEqual(claudeCodePrintArgv("claude-haiku-x", undefined, {}));
    expect(bare).not.toContain("--claude-subscription-pin");
    const pinned = claudeCodePrintArgv("claude-haiku-x", undefined, { subscriptionPin: true });
    const modelIndex = pinned.indexOf("--model");
    expect(pinned.slice(modelIndex, modelIndex + 3)).toEqual(["--model", "claude-haiku-x", "--claude-subscription-pin"]);
    for (const explicit of [true, false]) await withPrintEnv(async home => {
      await runPrompt((explicit ? "claude@" : "") + "claude-haiku-x", "hi");
      const args = childRecord(home).args as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-x");
      expect(args.includes("--claude-subscription-pin")).toBe(explicit);
    });
  }, 20_000);

  test("B-45 refuses shadowed endpoint names on every planning path", async () => {
    if (!process.env.T_SHADOWED_ENDPOINT) {
      const home = temp();
      try {
        put(join(home, ".claudish", "config.json"), {
          version: "1.0.0", defaultProfile: "default", profiles: {},
          customEndpoints: { anthropic: { baseUrl: "http://127.0.0.1:1", apiKey: "fake-custom-key", transport: "anthropic" } },
        });
        const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path, "-t", "B-45"], {
          cwd: home, env: { ...cleanEnv(home), T_CLAUDE_BEHAVIOUR_FILE: import.meta.path, T_SHADOWED_ENDPOINT: "1" },
          stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code, stdout + stderr).toBe(0);
      } finally { rmSync(home, { recursive: true, force: true }); }
      return;
    }
    const { decideClaudeLaunch } = await import("./launcher/claude-launch.js");
    const { explainRoute } = await import("./providers/routing-rules.js");
    const { preflightModel } = await import("./providers/preflight-chain.js");
    const { planAdvisorModel, describeAdvisorRefusal } = await import("./handlers/advisor-route-plan.js");
    expect(decideClaudeLaunch(contractConfig({ model: "anthropic@" + MODEL }))).toMatchObject({ ok: false, message: expect.stringContaining("Rename customEndpoints['anthropic']") });
    const result = claudeSpecRefusalResult(["anthropic@" + MODEL]);
    expect(result).toMatchObject({ isError: true });
    expect(result?.content[0].text).toStartWith("Error: anthropic@" + MODEL + ": 'anthropic@' is the builtin");
    const e = await explainRoute("anthropic@claude-haiku-x", { network: CONTRACT_OFFLINE_NETWORK, rules: {} });
    expect(e.outcome).toMatchObject({ kind: "no-route", cause: "explicit-refused" });
    expect(e.candidates).toEqual([]);
    expect(await preflightModel("anthropic@claude-haiku-x", { probe: null })).toMatchObject({ kind: "route-error" });
    for (const role of ["panel", "collector"] as const) {
      const spec = "anthropic@claude-haiku-x";
      const out = await planAdvisorModel(spec, role, {
        childAuth: { controlled: true }, anthropicKeyPresent: async () => true,
        ensureCatalog: async () => {}, warmCatalog: async () => {},
      });
      expect(out).toMatchObject({ kind: "refused", cause: "explicit-refused" });
      if (out.kind !== "refused") throw new Error("shadowed advisor accepted");
      expect(describeAdvisorRefusal(out).split(spec)).toHaveLength(2);
    }
  }, 30_000);

  test("B-77 refuses managed print-child keys but ignores disabled user settings", async () => {
    const home = temp();
    try {
      const env = { ...cleanEnv(home), ...standIn(home), CLAUDE_CODE_OAUTH_TOKEN: LOGIN };
      await expect(runPromptViaClaudeCode("claude-haiku-x", "hi", undefined, {
        parentEnv: env, settingsFindings: () => [{ where: "/m/managed.json", kind: "api-key" }],
      })).rejects.toThrow("/m/managed.json");
      expect(existsSync(join(home, "child.json"))).toBe(false);
      // Inspect the refusal text without relying on a particular Error subclass.
      const refusal = await runPromptViaClaudeCode("claude-haiku-x", "hi", undefined, {
        parentEnv: env, settingsFindings: () => [{ where: "/m/managed.json", kind: "api-key" }],
      }).then(() => "unexpected success", e => String(e));
      expect(refusal).not.toContain("--anthropic-api-billing");
      expect(refusal).toContain("/m/managed.json");
      put(join(home, ".claude", "settings.json"), { apiKeyHelper: "fake-helper-never-executed" });
      await runPromptViaClaudeCode("claude-haiku-x", "hi", undefined, { parentEnv: env });
      expect(existsSync(join(home, "child.json"))).toBe(true);
      const args = childRecord(home).args as string[];
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 20_000);
});
