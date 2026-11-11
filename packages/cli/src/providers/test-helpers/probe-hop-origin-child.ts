import assert from "node:assert/strict";
import { credentials } from "../../auth/credentials/authority.js";
import { createProxyServer } from "../../proxy-server.js";
import { stubEvents } from "../../test-helpers/stub-upstream.js";
import { _setBundledListForTest } from "../all-models-cache.js";
import { _resetCatalogClient, catalogOrigin } from "../catalog-client.js";
import { catalogRouteForProvider } from "../catalog-route-bindings.js";
import { PROBE_HOP_ORIGIN_HEADER } from "../probe-hop-origin.js";
import { getProviderByName } from "../provider-definitions.js";
import { routingSetupCatalog } from "../test-data/routing-setups.js";

/**
 * One request for an account-listed hop the bundled recommended list has no
 * connection for (`opencode-zen-go@kimi-k3`), sent to a proxy with the bundled
 * list as its catalog. Scenarios:
 *
 * - `probe-routed`: a probe proxy, the request marked as a hop of a routed chain
 *   → the proxy builds it as a routed hop and tries the provider's APIs in turn.
 * - `normal-routed`: a proxy serving Claude Code, the same marked request → the
 *   marker is ignored and the explicit spec is refused offline.
 * - `probe-unmarked`: a probe proxy, no marker (a spec the user typed) → refused.
 */
const scenario = process.env.SCENARIO!;
assert.ok(["probe-routed", "normal-routed", "probe-unmarked"].includes(scenario));
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
    false,
    "the hop under test must have no bundled connection"
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
      return Response.json({ data: [{ id: "kimi-k3" }] });
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
            { parts: [{ text: "PROBE HOP ANSWER" }] },
            String(body.model)
          ).join(""),
          { headers: { "content-type": "text/event-stream" } }
        );
      return Response.json({
        id: "probe-hop-answer",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "PROBE HOP ANSWER" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
      });
    }
    unexpected.push(url.href);
    throw new Error("Unexpected network in probe hop test: " + url.href);
  }) as typeof fetch;

  // The probe call sites start their proxy with no default model; so does this one.
  server = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
    quiet: true,
    hooks: false,
    ...(scenario === "normal-routed" ? {} : { probeProxy: true }),
  });
  const response = await realFetch(new URL("/v1/messages", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(scenario === "probe-unmarked" ? {} : { [PROBE_HOP_ORIGIN_HEADER]: "routed" }),
    },
    body: JSON.stringify({
      model: spec,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "Reply" }],
    }),
  });
  const text = await response.text();
  if (scenario === "probe-routed") {
    assert.equal(response.status, 200, text);
    assert.match(text, /PROBE HOP ANSWER/);
    assert.doesNotMatch(text, /bundled recommended list has no/);
    assert.deepEqual(
      sent.map((c) => new URL(c.url).pathname.split("/").at(-1)),
      ["responses", "messages", "completions"],
      "a routed hop with no bundled connection tries the provider's APIs in turn"
    );
    assert.equal(sent.at(-1)!.body.model, "kimi-k3");
  } else {
    assert.equal(response.status, 400, text);
    assert.match(text, /bundled recommended list/);
    assert.match(text, /no.*opencode-zen-go.*connection/i);
    assert.deepEqual(sent, [], "an explicit spec must not become a routed try-in-turn request");
  }
  assert.deepEqual(unexpected, []);
  process.stdout.write(JSON.stringify({ scenario, result: "passed" }) + "\n");
} finally {
  await server?.shutdown();
  data.cleanup();
}
process.exit(0);
