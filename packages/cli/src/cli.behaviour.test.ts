import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  KEY,
  MODEL,
  childRecord,
  cli,
  contractConfig,
  isolatedFile,
  put,
  standIn,
  temp,
} from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const { CLAUDISH_PLACEHOLDER_AUTH_TOKEN } = await import("./auth/claudish-placeholder.js");
  const { decideClaudeLaunch } = await import("./launcher/claude-launch.js");

  test("B-28 keeps the API key outside the child for every API shortcut", async () => {
    for (const prefix of ["anthropic", "a", "api"]) {
      const home = temp();
      try {
        const env = standIn(home);
        const result = await cli(home, ["--model", prefix + "@" + MODEL, "-y", "hi"], {
          ...env,
          ANTHROPIC_API_KEY: KEY,
        });
        expect(result.code, result.stderr).toBe(0);
        const child = childRecord(home);
        expect(child.env.ANTHROPIC_AUTH_TOKEN).toBe(CLAUDISH_PLACEHOLDER_AUTH_TOKEN);
        expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(child.env.ANTHROPIC_MODEL).toBe(MODEL);
        expect(child.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
        expect(child.env.CLAUDISH_SET_HOST_ROUTING_VARS).toBe("marker");
        expect(child.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
        expect(child.settings.forceLoginMethod).toBe("console");
        expect(JSON.stringify(child)).not.toContain(KEY);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }, 45_000);

  test("B-29 signs monitor requests with the launch key only", async () => {
    const home = temp();
    const received: Array<{ headers: Headers; body: unknown }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        received.push({ headers: req.headers, body: await req.json() });
        return Response.json({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    try {
      const result = await cli(home, ["--model", "anthropic@" + MODEL, "-y", "hi"], {
        ...standIn(home),
        ANTHROPIC_API_KEY: KEY,
        CLAUDISH_TEST_UPSTREAM: upstream.url.origin,
        T_SEND_REQUEST: "1",
        T_REQUEST_AUTH: "Bearer " + CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0].headers.get("x-api-key")).toBe(KEY);
      expect(received[0].headers.has("authorization")).toBe(false);
      expect(received[0].body).toEqual({
        model: MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(JSON.parse(readFileSync(join(home, "request.json"), "utf8")).status).toBe(200);
    } finally {
      upstream.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  test("B-30 refuses API launches before starting a child", async () => {
    const cases: Array<[string[], Record<string, string>, string]> = [
      [
        ["--model", "api@" + MODEL, "-y", "hi"],
        {},
        "No Anthropic API key for the Claude API (looked in environment, ~/.claudish/config.json",
      ],
      [
        ["--model", "anthropic@" + MODEL + "#fast", "-y", "hi"],
        { ANTHROPIC_API_KEY: KEY },
        "speed and mode markers cannot apply",
      ],
      [
        ["--model", "anthropic@" + MODEL, "--model-haiku", MODEL, "-y", "hi"],
        { ANTHROPIC_API_KEY: KEY },
        "does not use role mappings",
      ],
    ];
    for (const [args, keys, message] of cases) {
      const home = temp();
      try {
        const result = await cli(home, args, { ...standIn(home), ...keys });
        expect(result.code, result.stderr).toBe(1);
        expect(result.stderr).toContain("[claudish] Error:");
        expect(result.stderr).toContain(message);
        expect(existsSync(join(home, "child.json"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }, 45_000);

  test("B-36 hides incidental keys on explicit subscription launches", async () => {
    for (const spec of ["claude@" + MODEL, "claude@gpt-6"]) {
      const home = temp();
      try {
        put(join(home, ".claude", ".credentials.json"), "");
        const result = await cli(home, ["--model", spec, "-y", "hi"], {
          ...standIn(home),
          ANTHROPIC_API_KEY: KEY,
        });
        if (spec === "claude@gpt-6") {
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("gpt-6 is not one");
          expect(existsSync(join(home, "child.json"))).toBe(false);
        } else {
          expect(result.code, result.stderr).toBe(0);
          const child = childRecord(home);
          expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
          expect(child.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
          expect(child.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
          expect(child.env.ANTHROPIC_MODEL).toBe(MODEL);
          expect(child.settings.forceLoginMethod).toBeUndefined();
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("B-50 keeps bare launches unmonitored and hides keys unless opted in", async () => {
    const config = contractConfig({ model: MODEL });
    expect(
      decideClaudeLaunch(config, { paneChild: false, shadowedEndpointRefusal: () => null })
    ).toEqual({ ok: true });
    expect(config).toEqual(contractConfig({ model: MODEL }));
    for (const optIn of [false, true]) {
      const home = temp();
      try {
        put(join(home, ".claude", ".credentials.json"), "");
        const result = await cli(
          home,
          ["--model", MODEL, ...(optIn ? ["--anthropic-api-billing"] : []), "-y", "hi"],
          { ...standIn(home), ANTHROPIC_API_KEY: KEY }
        );
        expect(result.code, result.stderr).toBe(0);
        expect(childRecord(home).env.ANTHROPIC_API_KEY).toBe(optIn ? KEY : undefined);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("B-66 refuses settings keys and tokens before starting a subscription", async () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      const home = temp();
      try {
        put(join(home, ".claude", ".credentials.json"), "");
        const settings = join(home, ".claude", "settings.json");
        put(settings, { env: { [name]: "sk-ant-settings-fake-000000" } });
        const result = await cli(home, ["--model", "claude@" + MODEL, "-y", "hi"], standIn(home));
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(settings);
        expect(result.stderr).toContain(name);
        expect(existsSync(join(home, "child.json"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
