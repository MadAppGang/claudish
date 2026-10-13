import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parseArgs exports served-model consent and step 5w honors it for Kimi Code", () => {
  const home = mkdtempSync(join(tmpdir(), "accept-served-"));
  const source = new URL("../", import.meta.url).pathname;
  const fixture = new URL(
    "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
    import.meta.url
  ).pathname;
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      const { Hono } = await import("hono");
      const { parseArgs } = await import(${JSON.stringify(source + "cli.ts")});
      const { buildWireHandler } = await import(${JSON.stringify(source + "providers/wire-handler.ts")});
      const { getProviderByName, toRemoteProvider } = await import(${JSON.stringify(source + "providers/provider-definitions.ts")});
      const previousEnv = process.env.CLAUDISH_ACCEPT_SERVED_MODEL;
      const originalFetch = globalThis.fetch;
      const bodies = [];
      globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response("captured", {status: 400}); };
      try {
        delete process.env.CLAUDISH_ACCEPT_SERVED_MODEL;
        const built = await buildWireHandler({ provider: toRemoteProvider(getProviderByName("kimi-coding")), modelName: "k3", targetModel: "kimi-coding@k3", apiKey: "fake", port: 0, catalogCachePath: ${JSON.stringify(fixture)}, sharedOpts: {} }, "kimi-coding");
        if (built.kind !== "handler") throw new Error(JSON.stringify(built));
        try {
          const app = new Hono();
          app.post("/", c => built.handler.handle(c, { max_tokens: 512, messages: [{ role: "user", content: "hello" }], thinking: {type: "disabled"} }));
          await app.request("/", {method: "POST"});
          const config = await parseArgs(["--accept-served-model", "--model", "kimi-coding@k3", "hello"]);
          const accepted = process.env.CLAUDISH_ACCEPT_SERVED_MODEL;
          await app.request("/", {method: "POST"});
          console.log(JSON.stringify({ accepted, args: config.claudeArgs, bodies }));
        } finally { await built.handler.shutdown(); }
      } finally {
        globalThis.fetch = originalFetch;
        if (previousEnv === undefined) delete process.env.CLAUDISH_ACCEPT_SERVED_MODEL;
        else process.env.CLAUDISH_ACCEPT_SERVED_MODEL = previousEnv;
      }
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.accepted).toBe("1");
    expect(result.args).toEqual(["hello"]);
    expect(result.bodies).toHaveLength(2);
    expect(result.bodies[0].reasoning_effort).toBe("low");
    expect(result.bodies[1].reasoning_effort).toBe("none");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
