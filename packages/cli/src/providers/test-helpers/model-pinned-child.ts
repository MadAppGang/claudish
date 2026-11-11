import assert from "node:assert/strict";
import { credentials } from "../../auth/credentials/authority.js";
import { modelPinnedHonoured } from "../../pane/child-env.js";
import { createProxyServer } from "../../proxy-server.js";
import { stubEvents } from "../../test-helpers/stub-upstream.js";
import { _setBundledListForTest } from "../all-models-cache.js";
import { _resetCatalogClient, catalogOrigin } from "../catalog-client.js";
import { catalogRouteForProvider } from "../catalog-route-bindings.js";
import { getProviderByName } from "../provider-definitions.js";
import { routingSetupCatalog } from "../test-data/routing-setups.js";

const scenario = process.env.SCENARIO!;
const data = routingSetupCatalog();
const spec = "opencode-zen-go@kimi-k3";
const realFetch = globalThis.fetch;
const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
const unexpected: string[] = [];
let server: Awaited<ReturnType<typeof createProxyServer>> | undefined;
try {
  _setBundledListForTest(data.bundle);
  _resetCatalogClient();
  assert.equal(catalogOrigin(), "bundled");
  assert.equal(
    data.bundle.entries
      .find((m) => m.modelId === "kimi-k3")!
      .aggregators!.some(
        (c) => c.route?.routeId === "opencode" && c.route.routeProfileId === "go-subscription"
      ),
    false
  );
  const binding = catalogRouteForProvider("opencode-zen-go");
  assert.ok(binding);
  const profile =
    data.bundle.routeRegistry.registry.routes[binding.routeId]!.profiles[binding.routeProfileId]!;
  const upstreamOrigins = new Set(
    Object.values(profile.apis).flatMap((api) =>
      api?.baseUrl ? [new URL(api.baseUrl).origin] : []
    )
  );
  assert.ok(upstreamOrigins.size > 0, "the captured profile must name an upstream endpoint");
  const definition = getProviderByName("opencode-zen-go");
  assert.ok(definition);
  if (definition.apiKeyEnvVar) process.env[definition.apiKeyEnvVar] = "routing-test-data";
  credentials.describeReadiness = async (provider) => ({
    readiness: provider === "opencode-zen-go" ? "present" : "absent",
  });
  credentials.isAvailable = async (provider) => provider === "opencode-zen-go";
  credentials.accountIdentity = async () => undefined;
  credentials.getRequestAuth = async () => ({
    headers: { Authorization: "Bearer routing-test-data" },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (server && url.origin === new URL(server.url).origin) return realFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "kimi-k3" }, { id: "glm-5.3" }] });
    }
    if (method === "POST" && upstreamOrigins.has(url.origin)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sent.push({ url: url.href, body });
      if (!url.pathname.endsWith("/chat/completions"))
        return Response.json({ error: { message: "API not found" } }, { status: 404 });
      if (body.stream === true)
        return new Response(
          stubEvents(
            "openai-sse",
            { parts: [{ text: "PINNED OFFLINE ANSWER" }] },
            String(body.model)
          ).join(""),
          { headers: { "content-type": "text/event-stream" } }
        );
      return Response.json({
        id: "pin-test-answer",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "PINNED OFFLINE ANSWER" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      });
    }
    unexpected.push(url.href);
    throw new Error("Unexpected network in pin test: " + url.href);
  }) as typeof fetch;
  const flag = scenario === "parent-pin" || scenario === "spoofed-pin";
  const markers =
    scenario === "parent-pin"
      ? { CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: process.env.HOME }
      : {};
  const honoured = modelPinnedHonoured(flag, markers);
  assert.equal(honoured, scenario === "parent-pin");
  server = await createProxyServer(0, undefined, spec, false, undefined, undefined, {
    quiet: true,
    hooks: false,
    modelChainPinned: honoured,
    ...(scenario === "typed-chain" ? { modelChain: [spec, "opencode-zen-go@glm-5.3"] } : {}),
  });
  const response = await realFetch(new URL("/v1/messages", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: spec,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "Reply" }],
    }),
  });
  const text = await response.text();
  if (scenario === "parent-pin") {
    assert.equal(response.status, 200, text);
    assert.match(text, /PINNED OFFLINE ANSWER/);
    assert.ok(sent.length > 0, "the routed pin must reach an upstream");
    assert.equal(sent.at(-1)!.body.model, "kimi-k3");
    assert.match(sent.at(-1)!.url, /\/chat\/completions$/);
  } else {
    assert.equal(response.status, 400, text);
    assert.match(text, /bundled recommended list/);
    assert.match(text, /no.*opencode-zen-go.*connection/i);
    assert.deepEqual(
      sent,
      [],
      "a typed spec or chain must not become a routed try-in-turn request"
    );
  }
  assert.deepEqual(unexpected, []);
  process.stdout.write(JSON.stringify({ scenario, result: "passed" }) + "\n");
} finally {
  await server?.shutdown();
  data.cleanup();
}
process.exit(0);
