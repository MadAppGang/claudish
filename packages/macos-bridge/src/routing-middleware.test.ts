import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import runtime code only after the child's HOME has been isolated.
test.each([
  ["oai/gpt-6.1-sol", true, "https://api.openai.com/v1/responses", "max_output_tokens"],
  ["openai/gpt-6.1-sol", true, "https://openrouter.ai/api/v1/chat/completions", "max_tokens"],
  ["oai/gpt-6.1-sol", false, "https://api.openai.com/v1/chat/completions", "max_tokens"],
] as const)(
  "bridge %s with catalog=%s uses the expected upstream wire",
  (model, catalog, endpoint, limit) => {
    const home = mkdtempSync(join(tmpdir(), "bridge-wire-"));
    const source = (name: string) => JSON.stringify(new URL(name, import.meta.url).pathname);
    try {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { Hono } from ${JSON.stringify(Bun.resolveSync("hono", import.meta.dir))};
      import { RoutingMiddleware } from ${source("./routing-middleware.ts")};
      import { ALL_MODELS_CACHE_PATH, writeAllModelsCache } from ${source("../../cli/src/providers/all-models-cache.ts")};
      import { getRegisteredRemoteProviders } from ${source("../../cli/src/providers/remote-provider-registry.ts")};
      assert.ok(ALL_MODELS_CACHE_PATH.startsWith(process.env.HOME + "/"));
      if (${catalog}) writeAllModelsCache(JSON.parse(readFileSync(${source("../../cli/src/test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json")}, "utf8")));
      const bridge = new RoutingMiddleware({}, {openai: "fake", openrouter: "fake"});
      // Bun eval strips TypeScript privacy; exercise the handler without a listener.
      const handler = bridge.createHandlerForModel(${JSON.stringify(model)});
      const calls = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        calls.push({url: String(input), body: JSON.parse(String(init.body))});
        return Response.json({error: {message: "intercepted"}}, {status: 418});
      };
      try {
        const app = new Hono();
        app.post("/", c => handler.handle(c, {model: ${JSON.stringify(model)}, messages: [{role: "user", content: "hello"}], max_tokens: 1234, stream: true}));
        await app.request("/", {method: "POST"});
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, ${JSON.stringify(endpoint)});
        assert.equal(calls[0].body[${JSON.stringify(limit)}], 1234);
        for (const field of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
          if (field !== ${JSON.stringify(limit)}) assert.equal(calls[0].body[field], undefined);
        }
        if (!${catalog}) {
          const remote = getRegisteredRemoteProviders().find(p => p.name === "openai");
          assert.equal(calls[0].url, remote.baseUrl + remote.apiPath);
        }
      } finally { globalThis.fetch = original; await handler.shutdown(); }
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
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
);
