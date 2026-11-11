import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { credentials } from "../../auth/credentials/authority.js";
import {
  buildAdvisorChains,
  describeAdvisorPlan,
  planAdvisorModel,
  shutdownAdvisorChains,
} from "../../handlers/advisor-route-plan.js";
import { createHandlerSet } from "../../handlers/handler-set.js";
import type { ModelHandler } from "../../handlers/types.js";
import { settleLaunchCatalogVerdict } from "../../launcher/catalog-warm.js";
import { setConfigFileOverride } from "../../profile-config.js";
import { type StubFormat, stubEvents } from "../../test-helpers/stub-upstream.js";
import {
  ALL_MODELS_CACHE_PATH,
  _clearAllModelsCacheMemo,
  _setBundledListForTest,
  readAllModelsCache,
  readDiskCatalog,
  writeAllModelsCache,
} from "../all-models-cache.js";
import { bundledListNote, bundledRecommendedModelsDoc } from "../bundled-list.js";
import {
  _resetCatalogClient,
  catalogOrigin,
  ensureCatalogReady,
  settleCatalogRefresh,
  settleCatalogVerdict,
} from "../catalog-client.js";
import { catalogReachability } from "../catalog-reachability.js";
import {
  LIVE_MS,
  deriveAccountKey,
  writeStoredModelsList,
} from "../dynamic-models-catalog-store.js";
import { refreshAccountModelsList } from "../dynamic-models-catalog.js";
import {
  currentEffortRecommendations,
  effortRecommendationsPathFor,
  writeEffortRecommendations,
} from "../effort-recommendations.js";
import { ensureEndpointsRegistered } from "../endpoint-registration.js";
import { _resetGatewayWireListsForTest } from "../gateway-wire-lists.js";
import { setKeychainTestDeps } from "../keychain.js";
import { parseModelSpec } from "../model-parser.js";
import { getProviderByName, toRemoteProvider } from "../provider-definitions.js";
import {
  awaitsCatalogBody,
  getMissingKeyError,
  getMissingKeyResolutions,
  getMissingKeysError,
  validateApiKeysForModels,
} from "../provider-resolver.js";
import {
  type RouteExplanation,
  type RoutePlan,
  effectiveDefaultProviderResolution,
  explainRoute,
  route,
  routeExplained,
} from "../routing-rules.js";
import {
  type Column,
  type ExpectedRoute,
  GENERATION,
  ROUTING_SETUPS,
  routingSetupCatalog,
} from "../test-data/routing-setups.js";
import { buildWireHandler } from "../wire-handler.js";

const row = ROUTING_SETUPS.find((r) => r.id === process.env.SETUP_ID);
assert.ok(row, "unknown setup");
const column = process.env.SETUP_COLUMN as Column;
assert.ok(["C", "B", "disabled"].includes(column));
assert.equal(homedir(), process.env.HOME);
assert.ok(ALL_MODELS_CACHE_PATH.startsWith(homedir() + "/"));
assert.equal(existsSync(ALL_MODELS_CACHE_PATH), false);
const data = routingSetupCatalog();
const enabled = column === "B";
_setBundledListForTest(data.bundle);
const expected = row[column];
const config = {
  version: "1.0.0",
  defaultProfile: "default",
  profiles: {},
  ...(row.fallback !== undefined && row.id !== "S9" && !row.id.startsWith("S17")
    ? { defaultProvider: row.fallback }
    : {}),
  predefinedEndpoints: { enable: row.credentials },
  keychain: { enabled: row.keychain ?? false },
  customEndpoints: {
    mylab: {
      kind: "simple",
      url: "https://mylab.invalid/v1",
      format: "openai",
      apiKey: "routing-test-data",
    },
  },
};
const configPath = join(homedir(), ".claudish", "config.json");
mkdirSync(join(homedir(), ".claudish"), { recursive: true });
writeFileSync(configPath, JSON.stringify(config));
setConfigFileOverride(configPath);
if (row.id === "S9" || row.id.startsWith("S17"))
  process.env.CLAUDISH_DEFAULT_PROVIDER = row.fallback;
if (row.credentials.includes("openrouter") && !row.keychain)
  process.env.OPENROUTER_API_KEY = "routing-test-data";
if (column === "C") {
  // Deliberately old: a readable catalog of ANY age beats bundled data (RB-16).
  writeAllModelsCache({ ...data.cache, lastUpdated: "2001-01-01T00:00:00.000Z" });
}
const ready = new Set(row.credentials);
credentials.describeReadiness = async (name) => ({
  readiness: ready.has(name) ? "present" : "absent",
});
credentials.isAvailable = async (name) => ready.has(name);
credentials.accountIdentity = async (name) =>
  ready.has(name) ? `routing-test-account:${name}` : undefined;
credentials.getRequestAuth = async () => ({
  headers: { Authorization: "Bearer routing-test-data" },
});
setKeychainTestDeps({
  platform: () => "darwin",
  run: (args) => {
    assert.equal(args[0], "dump-keychain", "routing presence must not read a secret");
    assert.equal(args.includes("-d"), false, "routing presence must not read item data");
    return {
      code: 0,
      stderr: "",
      stdout: row.keychain
        ? 'keychain: "test"\nclass: "genp"\nattributes:\n    "svce"<blob>="claudish"\n    "acct"<blob>="OPENROUTER_API_KEY"\n'
        : "",
    };
  },
  runAsync: async () => {
    throw new Error("unexpected Keychain value read");
  },
  spawnAsync: () => {
    throw new Error("unexpected Keychain value read");
  },
});
// All Keychain operations now target the injected fake, never the login store.
process.env.CLAUDISH_DISABLE_KEYCHAIN = "0";
ensureEndpointsRegistered({ force: true, config });
for (const name of ready) {
  if (name === "openai-codex" || (name === "openrouter" && row.keychain)) continue;
  const envVar = getProviderByName(name)?.apiKeyEnvVar;
  if (envVar) process.env[envVar] = "routing-test-data";
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const bodyGate = deferred<void>();
const requestGate = deferred<void>();
const gatewayGate = deferred<Response>();
const timeouts: AbortController[] = [];
const nativeTimeout = AbortSignal.timeout;
AbortSignal.timeout = (ms) => {
  if (ms !== 8000) return nativeTimeout(ms);
  const control = new AbortController();
  timeouts.push(control);
  return control.signal;
};
let catalogCalls = 0;
let gatewayFetches = 0;
const upstream: Array<{ url: string; body: Record<string, unknown> }> = [];
const unexpected: string[] = [];
let failGateway = row.gateway === "fail";
let refreshed = false;
const envelope = (payload: unknown) => ({
  contractVersion: 3,
  generationId: GENERATION,
  generatedAt: data.cache.lastUpdated,
  data: payload,
});
const slimEnvelope = envelope({
  mode: "slim",
  models: data.cache.entries,
  total: data.cache.entries.length,
});
const catalogOriginUrl = "https://routing-catalog.invalid";
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // Embedded data is local; HTTP(S) requests still go through the guards below.
  if (url.protocol === "data:") return nativeFetch(input, init);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (url.origin === catalogOriginUrl) {
    catalogCalls++;
    requestGate.resolve();
    if (row.refresh === "transport") throw new TypeError("test catalog connection refused");
    if (row.refresh === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (url.pathname === "/queryPlans")
      return Response.json(envelope({ plans: data.cache.plans, total: data.cache.plans.length }));
    if (url.searchParams.get("catalog") === "routes")
      return Response.json(
        envelope({ mode: "routes", registry: data.cache.routeRegistry!.registry })
      );
    if (url.searchParams.get("catalog") === "slim") {
      const held = row.refresh === "held-success" || row.refresh === "held-fail";
      if (!held || refreshed) return Response.json(slimEnvelope);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const fail = () => {
              if (!closed) {
                closed = true;
                controller.error(signal?.reason ?? new Error("body aborted"));
              }
            };
            signal?.addEventListener("abort", fail, { once: true });
            void bodyGate.promise.then(() => {
              if (closed) return;
              closed = true;
              refreshed = true;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(slimEnvelope)));
              controller.close();
            }, fail);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    unexpected.push(url.href);
    throw new Error("unexpected catalog endpoint " + url);
  }
  const discovery = (!init?.method || init.method === "GET") && url.pathname.endsWith("/models");
  if (discovery) {
    if (url.hostname === "openrouter.ai" || row.gateway === "together") {
      gatewayFetches++;
      if (row.gateway === "hang") return gatewayGate.promise;
      if (failGateway) throw new TypeError("gateway models list unavailable");
      const ids =
        row.gateway === "together"
          ? ["moonshotai/Kimi-K3"]
          : ["~moonshotai/kimi-latest", "moonshotai/kimi-k3", "kimi-k3"];
      return Response.json({ data: ids.map((id) => ({ id })) });
    }
    if (row.account === "go-missing") throw new TypeError("no newer account list available");
    if (row.account === "grok") return Response.json({ data: [{ id: "grok-4.7" }] });
    if (row.account === "go") return Response.json({ data: [{ id: "kimi-k3" }] });
    throw new TypeError("no dynamic models catalog supplied");
  }
  if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    upstream.push({ url: url.href, body });
    if (row.id === "S10" && column !== "C" && !url.pathname.endsWith("/chat/completions")) {
      return Response.json({ error: { message: "API not found" } }, { status: 404 });
    }
    if (body.stream === true) {
      const format: StubFormat = url.pathname.endsWith("/responses")
        ? "openai-responses-sse"
        : url.pathname.endsWith("/messages")
          ? "anthropic-sse"
          : "openai-sse";
      return new Response(
        stubEvents(format, { parts: [{ text: "ROUTED ANSWER" }] }, String(body.model)).join(""),
        {
          headers: { "content-type": "text/event-stream" },
        }
      );
    }
    if (url.pathname.endsWith("/responses"))
      return Response.json({
        id: "routing-response",
        object: "response",
        status: "completed",
        model: body.model,
        output: [
          {
            type: "message",
            id: "routing-message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ROUTED ANSWER", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      });
    if (url.pathname.endsWith("/messages"))
      return Response.json({
        id: "routing-message",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "ROUTED ANSWER" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      });
    return Response.json({
      id: "routing-chat",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ROUTED ANSWER" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  }
  unexpected.push(url.href);
  throw new Error("forbidden network: " + url.href);
}) as typeof fetch;

const handlers = new Set<ModelHandler>();
async function send(handler: ModelHandler, model = row!.model) {
  handlers.add(handler);
  const app = new Hono();
  app.post("/v1/messages", async (c) => handler.handle(c, await c.req.json()));
  const response = await app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "Reply" }],
    }),
  });
  return { status: response.status, text: await response.text() };
}
function hopIdentity(hop: { provider: string; modelSpec: string }): string {
  const parsed = parseModelSpec(hop.modelSpec);
  if (parsed.isExplicitProvider) {
    assert.equal(parsed.provider, hop.provider, "the model spec must name the hop's provider");
    return `${hop.provider}@${parsed.model}`;
  }
  return `${hop.provider}@${hop.modelSpec}`;
}
function hops(plan: RoutePlan) {
  return plan.kind === "ok" ? [plan.primary, ...plan.fallbacks].map(hopIdentity) : [];
}
function checkExplanation(value: RouteExplanation, wanted: ExpectedRoute) {
  assert.deepEqual(
    value.candidates.filter((c) => c.outcome === "kept").map((c) => `${c.provider}@${c.wireId}`),
    wanted.hops
  );
  assert.equal(value.outcome.kind, wanted.hops.length ? "ok" : "no-route");
  if (wanted.cause) {
    assert.equal(value.outcome.kind, "no-route");
    if (value.outcome.kind === "no-route") assert.equal(value.outcome.cause, wanted.cause);
  }
  if (wanted.withheld) assert.equal(value.fallbackWithheld, wanted.withheld);
  if (wanted.excluded) {
    const excluded = value.candidates.find(
      (c) => c.provider === wanted.excluded && c.outcome === "gateway-id-unknown"
    );
    assert.ok(excluded, "withheld gateway must remain in the explanation");
    assert.equal(excluded.position, row!.rules ? "candidate" : "fallback");
    if (!row!.rules) assert.equal(value.candidates.at(-1), excluded);
  }
}
async function checkChain(
  wanted = expected,
  source: "disk" | "bundled" | "none" = column === "C" ? "disk" : enabled ? "bundled" : "none"
) {
  const rules = row!.rules ?? {};
  const fallback = row!.rulesOnly ? undefined : "resolve";
  const cachePath = column === "C" ? data.cachePath : undefined;
  const explanation = await explainRoute(row!.model, {
    rules,
    defaultProvider: fallback,
    cachePath,
  });
  checkExplanation(explanation, wanted);
  assert.equal(explanation.catalogSource, source === "none" ? undefined : source);
  const plan = row!.rulesOnly
    ? await route(row!.model, rules, undefined, cachePath)
    : await route(row!.model, rules, "resolve", cachePath);
  assert.deepEqual(
    hops(plan),
    wanted.hops,
    "proxy-shaped routing disagrees with the required chain"
  );
  assert.equal(plan.kind, explanation.outcome.kind);
  return explanation;
}
async function noAddedWait<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_yes, no) => {
        timer = setTimeout(
          () => no(new Error("background operation waited on an unresolved network response")),
          1500
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function prepareAccount() {
  const provider = row!.account === "grok" ? "grok-subscription" : "opencode-zen-go";
  if (!row!.account) return;
  if (row!.account === "go-missing") {
    // RB-13: this positive-only list cannot turn absence into a denial.
    const key = deriveAccountKey(provider, `routing-test-account:${provider}`);
    assert.equal(key.ok, true);
    if (key.ok)
      assert.equal(
        writeStoredModelsList(provider, key.accountKey, [{ id: "grok-4.7", reported: "chat" }], {
          now: () => Date.now() - LIVE_MS - 1,
        }),
        true
      );
  } else {
    const result = await refreshAccountModelsList(provider, "route-bare", { minAgeMs: 0 });
    assert.equal(result.kind, "refreshed");
    if (result.kind === "refreshed") assert.equal(result.outcome.kind, "served");
  }
}
async function buildRequest(spec: string, routed = false) {
  const at = spec.indexOf("@");
  const name = spec.slice(0, at);
  const definition = getProviderByName(name);
  assert.ok(definition);
  const result = await buildWireHandler(
    {
      provider: toRemoteProvider(definition),
      modelName: spec.slice(at + 1),
      targetModel: spec,
      apiKey: "routing-test-data",
      port: 0,
      sharedOpts: { requestRole: "advisor" },
      ...(routed ? { hopOrigin: "routed" as const } : {}),
    },
    name,
    { waitForCatalog: false }
  );
  assert.equal(result.kind, "handler");
  if (result.kind !== "handler") throw new Error("no handler");
  return send(result.handler, spec);
}

try {
  await prepareAccount();
  if (row.feature === "advisor") {
    if (column !== "C" && row.refresh) await settleCatalogVerdict();
    if (row.id === "S11e" && enabled) await route(row.model, {}, "resolve");
    const planned = await noAddedWait(
      planAdvisorModel(row.model, "panel", {
        childAuth: { controlled: true },
        anthropicKeyPresent: async () => false,
      })
    );
    if (expected.hops.length) {
      assert.equal(planned.kind, "routed");
      if (planned.kind !== "routed") throw new Error("advisor refused");
      assert.deepEqual(
        planned.hops.map((h) => `${h.provider}@${h.wireId}`),
        expected.hops
      );
      const set = createHandlerSet({ port: 0, quiet: true, requestRole: "advisor" });
      const builds = await noAddedWait(buildAdvisorChains([planned], set));
      const build = [...builds.values()][0]!;
      assert.notEqual(build.handler, null);
      const notice = describeAdvisorPlan(planned, build);
      if (enabled) {
        assert.match(notice, /bundled recommended list/);
        assert.ok(notice.includes(GENERATION));
      }
      if (row.id === "S11c" && enabled) {
        assert.equal(catalogReachability().state, "contacted");
        assert.equal(readAllModelsCache(), null, "advisor scope escaped");
        const concurrent = await Promise.all([
          planAdvisorModel(row.model, "panel", {
            childAuth: { controlled: true },
            anthropicKeyPresent: async () => false,
          }),
          route(row.model, {}, "resolve"),
        ]);
        assert.equal(concurrent[0].kind, "routed");
        assert.equal(concurrent[1].kind, "no-route");
        const main = await explainRoute(row.model, { rules: {}, defaultProvider: "resolve" });
        assert.equal(main.outcome.kind, "no-route");
        if (main.outcome.kind === "no-route")
          assert.equal(main.outcome.cause, "catalog-unreadable");
        assert.equal(build.builds[0]?.kind, "built");
        timeouts[0]!.abort(new DOMException("test body timeout", "TimeoutError"));
        await settleCatalogRefresh();
        assert.equal(catalogReachability().state, "unreachable");
      }
      const result = await send(build.handler!);
      assert.equal(result.status, 200);
      assert.match(result.text, /ROUTED ANSWER/);
      await shutdownAdvisorChains(builds.values());
    } else {
      assert.equal(planned.kind, "refused");
      if (planned.kind === "refused") assert.equal(planned.cause, expected.cause);
    }
    if (row.id === "S11d" && enabled) {
      assert.equal(gatewayFetches, 1);
      const context = await noAddedWait(
        route(row.model, {}, "resolve", undefined, { network: "background" })
      );
      assert.equal(context.kind, "no-route");
      assert.equal(gatewayFetches, 1);
    }
    // On contacted main routing the bundle is intentionally unavailable.
    if (row.id !== "S11c" || column === "C") {
      if (row.id === "S11d") gatewayGate.resolve(Response.json({ data: [] }));
      await checkChain();
    }
    if (row.id === "S11c" && column === "disabled") await checkChain();
  } else if (row.feature === "launch") {
    const verdict = settleLaunchCatalogVerdict({
      model: row.model,
      skipModelsUpdate: row.refresh === "skip",
    });
    if (row.refresh === "timeout" && enabled) {
      let settled = false;
      void verdict.then(() => {
        settled = true;
      });
      await requestGate.promise;
      await Promise.resolve();
      assert.equal(settled, false, "launch skipped the catalog request's verdict");
      timeouts[0]!.abort(new DOMException("test request timeout", "TimeoutError"));
    }
    await verdict;
    if (row.refresh === "skip" && enabled) {
      assert.equal(catalogCalls, 0);
      assert.deepEqual(catalogReachability().state, "unreachable");
      const skipped = catalogReachability();
      assert.equal(skipped.state, "unreachable");
      if (skipped.state === "unreachable") assert.equal(skipped.reason, "disabled");
    }
    if (row.id === "S12e") {
      const all = await validateApiKeysForModels([
        "minimax-m3",
        "qwen3.8-max",
        "openai@gpt-6.1-sol",
      ]);
      const missing = getMissingKeyResolutions(all);
      const text = getMissingKeysError(missing);
      if (column !== "C") {
        for (const id of ["minimax-m3", "qwen3.8-max"]) {
          assert.ok(text.includes(id));
          assert.ok(all.find((r) => r.fullModelId === id)?.routeRefusal);
        }
        assert.match(text, /--models-refresh/);
        assert.match(text, /OpenAI API Key is required/);
        if (enabled) assert.match(text, /bundled recommended list/);
      }
    } else {
      let resolutions = await validateApiKeysForModels([row.model]);
      const missing = getMissingKeyResolutions(resolutions);
      const bodyHeld = row.id.startsWith("S16") && column !== "C" && enabled;
      if (bodyHeld && row.id !== "S16c") {
        assert.equal(catalogReachability().state, "contacted");
        assert.equal(missing.length, 1);
        assert.equal(awaitsCatalogBody(missing[0]!), true);
        assert.equal(missing[0]!.routeRefusal?.cause, "catalog-unreadable");
        assert.equal(readAllModelsCache(), null);
        const settle = settleCatalogRefresh();
        if (row.id === "S16b")
          timeouts[0]!.abort(new DOMException("test body timeout", "TimeoutError"));
        else bodyGate.resolve();
        await settle;
        resolutions = await validateApiKeysForModels([row.model]);
        assert.equal(getMissingKeyResolutions(resolutions).length, 0);
        assert.equal(catalogOrigin(), row.id === "S16" ? "disk" : "bundled");
        const routed = await routeExplained(row.model);
        assert.equal(routed.explanation.catalogSource, row.id === "S16" ? "disk" : "bundled");
        assert.deepEqual(hops(routed.plan), ["openai-codex@gpt-6.1-sol"]);
      } else if (row.id === "S16c") {
        assert.equal(missing.length, 0);
        if (enabled) {
          assert.equal(catalogReachability().state, "contacted");
          assert.equal(readDiskCatalog(), null);
        }
      } else if (row.id === "S12b") {
        assert.equal(missing.length, 1);
        if (column !== "C") {
          assert.equal(missing[0]!.routeRefusal?.cause, "catalog-unreadable");
          const text = getMissingKeyError(missing[0]!);
          assert.match(text, /no cloud models catalog/);
          assert.match(text, /--models-refresh/);
          assert.doesNotMatch(text, /API Key is required|or@minimax-m3/);
          if (enabled) assert.match(text, /not in the bundled recommended list/);
        }
      } else if (column === "disabled") {
        assert.ok(missing.length > 0);
        if (!row.id.startsWith("S16"))
          assert.match(getMissingKeysError(missing), /--models-refresh/);
      } else assert.equal(missing.length, 0);
    }
    await checkChain(
      expected,
      row.id === "S16" && enabled
        ? "disk"
        : row.id === "S16c" && enabled
          ? "none"
          : column === "C"
            ? "disk"
            : enabled
              ? "bundled"
              : "none"
    );
  } else if (row.feature === "efforts") {
    const path = effortRecommendationsPathFor(ALL_MODELS_CACHE_PATH);
    const raw = (data.inputs.recommended.recommendations as { efforts: Record<string, unknown> })
      .efforts;
    writeEffortRecommendations(
      column === "C" ? GENERATION : "different-generation",
      {
        "gpt-6.1-sol": {
          coding: {
            effort: "low",
            basis: "sidecar",
            sendableOn: [
              {
                routeId: "openai",
                routeProfileId: "direct-api",
                externalModelId: "gpt-6.1-sol",
                encoding: "request_parameter",
              },
            ],
          },
        },
      },
      path
    );
    const table = currentEffortRecommendations(path);
    assert.equal(table?.efforts["gpt-6.1-sol"]?.coding?.effort, column === "B" ? "high" : "low");
    if (enabled) {
      const doc = bundledRecommendedModelsDoc();
      assert.equal(doc.generationId, GENERATION);
      assert.deepEqual(
        new Set(doc.models.map((m) => m.id)),
        new Set(data.bundle.entries.map((m) => m.modelId))
      );
      assert.match(bundledListNote(), /bundled/);
      assert.ok(bundledListNote().includes(GENERATION));
      const { effortClarification } = await import("../../mcp-server.js");
      assert.deepEqual(effortClarification(["gpt-6.1-sol"]), { "gpt-6.1-sol": { coding: "high" } });
      assert.ok(raw["gpt-6.1-sol"]);
    }
    await checkChain();
  } else if (row.feature === "slow" && column !== "C") {
    // A response's headers are not a catalog. A caller wait cannot activate the list.
    await settleCatalogVerdict();
    assert.equal(catalogReachability().state, "contacted");
    assert.equal(readAllModelsCache(), null);
    const first = await explainRoute(row.model, { rules: {}, defaultProvider: "resolve" });
    assert.equal(first.outcome.kind, "no-route");
    if (first.outcome.kind === "no-route") assert.equal(first.outcome.cause, "catalog-unreadable");
    await ensureCatalogReady(1);
    assert.equal(catalogReachability().state, "contacted");
    assert.equal(readAllModelsCache(), null);
    bodyGate.resolve();
    await settleCatalogRefresh();
    assert.equal(catalogOrigin(), "disk");
    await checkChain(row.C, "disk");
  } else if (row.feature === "rebuild" && enabled) {
    await checkChain();
    const set = createHandlerSet({ port: 0, quiet: true, requestRole: "advisor" });
    const old = await set.remote("kimi@kimi-k3", "auto-route", "routed");
    assert.ok(old);
    const before = await send(old);
    assert.equal(before.status, 200);
    assert.equal(catalogOrigin(), "bundled");
    // The returning catalog changes the published wire id, so keeping a bundled
    // handler would be observable in the next outgoing request, not private state.
    const landed = structuredClone(data.cache);
    landed.catalogGenerationId = "synthetic-returned-generation";
    landed.routeRegistry!.generationId = landed.catalogGenerationId;
    const kimiModel = landed.entries.find((m) => m.modelId === "kimi-k3")!;
    const connection = kimiModel.aggregators!.find(
      (c) => c.route?.routeId === "moonshotai" && c.route.routeProfileId === "direct-api"
    )!;
    connection.externalModelId = "kimi-k3-returned";
    writeAllModelsCache(landed);
    _resetCatalogClient();
    _clearAllModelsCacheMemo();
    const next = await set.remote("kimi@kimi-k3", "auto-route", "routed");
    assert.ok(next);
    const after = await send(next);
    assert.equal(after.status, 200);
    assert.equal(upstream.at(-1)?.body.model, "kimi-k3-returned");
    assert.equal(catalogOrigin(), "disk");
  } else {
    await checkChain();
    if (row.id === "S1-kc")
      assert.equal(effectiveDefaultProviderResolution().source, "openrouter-key");
    if (row.id === "S17") assert.equal(effectiveDefaultProviderResolution().source, "env-var");
    if (row.id === "S17b") {
      const value = await explainRoute(row.model, {
        rules: row.rules,
        cachePath: column === "C" ? data.cachePath : undefined,
      });
      // RB-11: the disk catalog already gathers OpenRouter, so it is not
      // appended a second time in the fallback position.
      assert.deepEqual(
        value.candidates.filter((c) => c.position === "fallback").map((c) => c.provider),
        []
      );
      if (column === "C") {
        assert.equal(value.candidates.filter((c) => c.provider === "openrouter").length, 1);
        assert.equal(value.fallbackWithheld, "already-gathered");
      }
      assert.equal(
        value.candidates.some((c) => c.provider === "mylab"),
        false
      );
    }
    if (
      ["S8", "S8b", "S8c", "S10"].includes(row.id) &&
      !(row.id === "S10" && column === "disabled")
    ) {
      const spec = row.id === "S10" ? "opencode-zen-go@kimi-k3" : row.model;
      const result = await buildRequest(spec, row.id === "S10");
      const refused =
        column !== "C" && (row.id === "S8b" || row.id === "S8c" || (!enabled && row.id !== "S10"));
      if (refused) {
        assert.equal(result.status, 400);
        assert.equal(upstream.length, 0);
        assert.match(result.text, /cloud models catalog/i);
        if (enabled && row.id === "S8b")
          assert.match(result.text, /not in the bundled recommended list/);
        if (enabled && row.id === "S8c")
          assert.match(result.text, /no.*opencode-zen-go.*connection/i);
      } else {
        assert.equal(result.status, 200);
        assert.match(result.text, /ROUTED ANSWER/);
        if (row.id === "S10" && column !== "C") {
          assert.deepEqual(
            upstream.map((c) => new URL(c.url).pathname.split("/").at(-1)),
            ["responses", "messages", "completions"]
          );
          assert.equal(upstream.at(-1)?.body.model, "kimi-k3");
          for (const call of upstream) {
            for (const field of [
              "max_tokens",
              "max_completion_tokens",
              "max_output_tokens",
              "reasoning_effort",
              "reasoning",
              "thinking",
            ]) {
              assert.equal(
                call.body[field],
                undefined,
                "try-in-turn must not invent limit or reasoning fields"
              );
            }
          }
        }
      }
    }
    if (row.id === "S1b" && enabled) {
      failGateway = false;
      const recovered = await route(row.model, {}, "resolve");
      assert.deepEqual(
        hops(recovered),
        ["openrouter@moonshotai/kimi-k3"],
        "failed gateway discovery must not cache a refusal"
      );
    }
  }
  assert.deepEqual(unexpected, []);
  process.stdout.write(JSON.stringify({ setup: row.id, column, result: "passed" }) + "\n");
} finally {
  gatewayGate.resolve(Response.json({ data: [] }));
  bodyGate.resolve();
  for (const timeout of timeouts) timeout.abort(new Error("test complete"));
  await Promise.allSettled([...handlers].map((h) => h.shutdown()));
  _resetGatewayWireListsForTest();
  data.cleanup();
}
// Some production readiness races retain a losing timer. All scenario work above
// is joined; exit avoids making that timer the test's wall-clock duration.
process.exit(0);
