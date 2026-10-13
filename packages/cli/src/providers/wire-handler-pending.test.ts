import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3 } from "./all-models-cache.js";

const fixturePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
const fixture: DiskCacheV3 = JSON.parse(readFileSync(fixturePath, "utf8"));
const source = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).pathname);

// Only the child imports runtime modules: HOME is isolated before their default
// cache paths are evaluated. No shared module mocks or parent environment edits.
const scenarioScript = `
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from ${JSON.stringify(Bun.resolveSync("hono", import.meta.dir))};
import { buildWireHandler, CatalogPendingHandler } from ${source("./wire-handler.ts")};
import { ComposedHandler } from ${source("../handlers/composed-handler.ts")};
import { getProviderByName, toRemoteProvider } from ${source("./provider-definitions.ts")};
import { _clearAllModelsCacheMemo } from ${source("./all-models-cache.ts")};

assert.equal(homedir(), process.env.HOME);
const cachePath = join(homedir(), ".claudish", "cloud-models-catalog-v3.json");
assert.equal(existsSync(cachePath), false);
const origin = new URL(process.env.CLAUDISH_CATALOG_URL).origin;
const realFetch = globalThis.fetch;
const upstream = [];
let catalogCalls = 0;
let forbidCatalog = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === origin) {
    catalogCalls++;
    assert.equal(forbidCatalog, false, "the built handler must be retained");
    return realFetch(input, init);
  }
  assert.equal(url.href, "https://api.openai.com/v1/responses", "unexpected external fetch");
  upstream.push(url.href);
  // A terminal upstream response proves delegation without stream timers/retries.
  return Response.json({ error: { message: "intercepted upstream" } }, { status: 418 });
};
const ctx = {
  provider: toRemoteProvider(getProviderByName("openai")),
  modelName: "gpt-6.1-sol",
  targetModel: "openai@gpt-6.1-sol",
  apiKey: "sk-test-not-a-key",
  port: 0,
  sharedOpts: {},
};
const scenario = process.env.SCENARIO;
if (scenario === "seam") {
  const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
  delete fixture.routeRegistry;
  ctx.catalogCachePath = join(homedir(), "registry-less.json");
  writeFileSync(ctx.catalogCachePath, JSON.stringify(fixture));
  const result = await buildWireHandler(ctx, "openai");
  assert.deepEqual({ kind: result.kind, catalogCalls, upstream },
    { kind: "refused", catalogCalls: 0, upstream: [] });
} else {
  const result = await buildWireHandler(ctx, "openai");
  assert.equal(result.kind, "handler");
  const handler = result.handler;
  if (scenario === "immediate") {
    assert.ok(handler instanceof ComposedHandler);
    assert.equal(handler.describeComposition().endpoint, "https://api.openai.com/v1/responses");
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")).routeRegistry,
      JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8")).routeRegistry);
  } else {
    assert.ok(handler instanceof CatalogPendingHandler);
    const app = new Hono();
    app.post("/v1/messages", async c => handler.handle(c, await c.req.json()));
    const request = () => app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-sol", max_tokens: 1024, stream: true,
        messages: [{ role: "user", content: "Hello" }] }),
    });
    const refused = await request();
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /cloud models catalog.*not available/);
    assert.equal(upstream.length, 0);
    await realFetch(origin + "/ready", { method: "POST" });
    const delegated = await request();
    assert.match(await delegated.text(), /intercepted upstream/);
    assert.deepEqual(upstream, ["https://api.openai.com/v1/responses"]);
    assert.ok(JSON.parse(readFileSync(cachePath, "utf8")).routeRegistry);
    unlinkSync(cachePath);
    _clearAllModelsCacheMemo();
    forbidCatalog = true;
    const callsBefore = catalogCalls;
    const retained = await request();
    assert.match(await retained.text(), /intercepted upstream/);
    assert.equal(catalogCalls, callsBefore);
    assert.equal(upstream.length, 2);
  }
  await handler.shutdown();
}
console.log("scenario passed");
// ensureRouteRegistryReady leaves its losing 30s race timer alive.
process.exit(0);
`;

async function runScenario(scenario: "immediate" | "pending" | "seam") {
  const home = mkdtempSync(join(tmpdir(), "claudish-wire-pending-"));
  let ready = scenario !== "pending";
  const envelope = (data: unknown) =>
    Response.json({
      contractVersion: 3,
      generationId: fixture.catalogGenerationId,
      generatedAt: "2026-10-12T10:10:07.285Z",
      data,
    });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (scenario !== "seam")
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/ready" && request.method === "POST") {
            ready = true;
            return new Response("ready");
          }
          if (url.pathname === "/queryModels" && url.searchParams.get("catalog") === "routes") {
            if (!ready) return new Response("unavailable", { status: 503 });
            if (url.searchParams.get("generationId") !== fixture.catalogGenerationId)
              return new Response("wrong generation", { status: 400 });
            return envelope({ mode: "routes", registry: fixture.routeRegistry!.registry });
          }
          if (url.pathname === "/queryPlans") {
            return envelope({ plans: fixture.plans, total: fixture.plans.length });
          }
          if (url.pathname === "/queryModels" && url.searchParams.get("catalog") === "slim") {
            const second = url.searchParams.has("cursor");
            return envelope({
              mode: "slim",
              models: second ? fixture.entries.slice(8) : fixture.entries.slice(0, 8),
              total: fixture.entries.length,
              ...(second ? {} : { nextCursor: "page-two" }),
            });
          }
          return new Response("unexpected request", { status: 404 });
        },
      });
    child = Bun.spawn([process.execPath, "-e", scenarioScript], {
      cwd: home,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_CATALOG_URL: `${server?.url ?? "http://127.0.0.1:1/"}queryModels?catalog=slim`,
        SCENARIO: scenario,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    timeout = setTimeout(() => child?.kill(), 8_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr: exitCode === 0 ? "" : stderr, stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "scenario passed\n",
    });
  } finally {
    clearTimeout(timeout);
    child?.kill();
    await child?.exited;
    server?.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

test(
  "cold production cache builds a Responses handler and persists the route registry",
  () => runScenario("immediate"),
  10_000
);

test(
  "pending production handler refuses only unavailable requests, then retains its delegate",
  () => runScenario("pending"),
  10_000
);

test("registry-less catalogCachePath refuses without fetching", () => runScenario("seam"), 10_000);
