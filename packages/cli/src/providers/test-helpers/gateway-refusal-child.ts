import assert from "node:assert/strict";
import { credentials } from "../../auth/credentials/authority.js";
import { _setBundledListForTest } from "../all-models-cache.js";
import { _resetCatalogClient, catalogOrigin } from "../catalog-client.js";
import { ensureEndpointsRegistered } from "../endpoint-registration.js";
import { getProviderByName } from "../provider-definitions.js";
import { explainRoute, toRoutePlan } from "../routing-rules.js";
import { registerRuntimeProvider } from "../runtime-providers.js";
import { routingSetupCatalog } from "../test-data/routing-setups.js";

const scenario = process.env.SCENARIO!;
const data = routingSetupCatalog();
const gateway = scenario === "no-list" ? "together" : "openrouter";
let recovered = false;
const unexpected: string[] = [];
try {
  _setBundledListForTest(data.bundle);
  _resetCatalogClient();
  process.env.TOGETHER_API_KEY = "routing-test-data";
  ensureEndpointsRegistered({
    force: true,
    config: {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      predefinedEndpoints: { enable: ["together"] },
    },
  });
  if (scenario === "no-list") {
    const definition = getProviderByName("together");
    assert.ok(definition, "the test needs the predefined Together endpoint");
    // The input is a gateway definition with no discovery descriptor, not a failed fetch.
    const noList = { ...definition };
    delete noList.modelDiscovery;
    registerRuntimeProvider(noList);
    assert.equal(getProviderByName("together")?.modelDiscovery, undefined);
  }
  credentials.describeReadiness = async (provider) => ({
    readiness: provider === gateway ? "present" : "absent",
  });
  credentials.isAvailable = async (provider) => provider === gateway;
  credentials.accountIdentity = async () => undefined;
  credentials.getRequestAuth = async () => ({
    headers: { Authorization: "Bearer routing-test-data" },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (gateway === "openrouter" && url.href === "https://openrouter.ai/api/v1/models") {
      if (scenario === "unreadable" && !recovered)
        throw new TypeError("gateway test connection refused");
      const ids = recovered
        ? ["moonshotai/kimi-k3"]
        : ["moonshotai/Kimi-K3", "~moonshotai/kimi-latest"];
      return Response.json({ data: ids.map((id) => ({ id })) });
    }
    unexpected.push(url.href);
    throw new Error("Unexpected network in gateway refusal test: " + url.href);
  }) as typeof fetch;
  assert.equal(catalogOrigin(), "bundled");
  const options = {
    rules: { "kimi-*": [gateway] },
    defaultProvider: { provider: "", source: "config-file", legacyAutoPromoted: false } as const,
  };
  const explanation = await explainRoute("kimi-k3", options);
  assert.equal(explanation.source, "user-rule");
  assert.equal(explanation.catalogSource, "bundled");
  assert.equal(explanation.candidates.length, 1);
  const candidate = explanation.candidates[0]!;
  assert.equal(candidate.provider, gateway);
  assert.equal(candidate.position, "candidate");
  assert.equal(candidate.outcome, "gateway-id-unknown");
  assert.equal(candidate.gatewayHasNoList === true, scenario === "no-list");
  assert.equal(candidate.gatewayListUnreadable === true, scenario === "unreadable");
  assert.equal(explanation.outcome.kind, "no-route");
  if (explanation.outcome.kind !== "no-route") throw new Error("Unexpected usable gateway route");
  assert.equal(explanation.outcome.cause, "gateway-id-unknown");
  // REQ-109 constrains the diagnostic meaning, not a particular sentence template.
  const reason = explanation.outcome.reason;
  if (scenario === "no-list")
    assert.match(
      reason,
      /no.*models list|models list.*(?:exist|available|supported)|does not.*models list/i
    );
  else if (scenario === "unreadable")
    assert.match(reason, /could not be read|unreadable|cannot.*read/i);
  else assert.match(reason, /no exact id|lacks.*id|does not.*(?:list|include|contain)/i);
  const plan = toRoutePlan(explanation);
  assert.equal(plan.kind, "no-route");
  if (plan.kind === "no-route") assert.equal(plan.reason, reason);

  if (scenario === "unreadable") {
    recovered = true;
    const next = await explainRoute("kimi-k3", options);
    assert.deepEqual(next.outcome, { kind: "ok" });
    assert.deepEqual(
      next.candidates
        .filter((c) => c.outcome === "kept")
        .map((c) => ({
          provider: c.provider,
          wireId: c.wireId,
        })),
      [{ provider: "openrouter", wireId: "moonshotai/kimi-k3" }],
      "a failed models list must not cache a refusal"
    );
  }
  assert.deepEqual(unexpected, []);
  process.stdout.write(JSON.stringify({ scenario, result: "passed" }) + "\n");
} finally {
  data.cleanup();
}
process.exit(0);
