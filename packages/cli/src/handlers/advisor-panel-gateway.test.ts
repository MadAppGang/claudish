import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "hono";
import type { ProfileContext } from "../providers/provider-profiles.js";
import { CatalogPendingHandler } from "../providers/wire-handler.js";
import { TryInTurnHandler, _clearTryInTurnMemory } from "../providers/wire-try-in-turn.js";
import { createAdvisorPanelGateway } from "./advisor-panel-gateway.js";
import {
  type AdvisorChainBuild,
  type AdvisorModelPlan,
  type AdvisorTurn,
  advisorChainKey,
  buildAdvisorChains,
  buildAdvisorPanelPayload,
  describeAdvisorPlan,
} from "./advisor-route-plan.js";
import type { HandlerSet } from "./handler-set.js";
import { recordHopEntry } from "./shared/call-context.js";
import type { ModelHandler } from "./types.js";

const timeout = 10_000;
type RoutedPlan = Extract<AdvisorModelPlan, { kind: "routed" }>;

// Read existing captures verbatim. The structural panel turns are derived from
// every user/assistant record in code-mode/v7-restart-one-transcript.jsonl;
// instructions come from code-mode/claude-code-request-body.json. No protocol
// response or request capture is authored by this test.
const transcript = readFileSync(
  join(import.meta.dir, "../test-fixtures/code-mode/v7-restart-one-transcript.jsonl"),
  "utf8"
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const turns: AdvisorTurn[] = transcript
  .filter((record) => record.type === "user" || record.type === "assistant")
  .map((record) => ({
    role: record.message.role,
    content:
      typeof record.message.content === "string"
        ? record.message.content
        : record.message.content
            .map((block: { type: string; text?: string }) =>
              block.type === "text" ? block.text : JSON.stringify(block)
            )
            .join("\n"),
  }));
const capturedRequest = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../test-fixtures/code-mode/claude-code-request-body.json"),
    "utf8"
  )
);
const system = capturedRequest.instructions as string;
const responseText = readFileSync(
  join(
    import.meta.dir,
    "../test-fixtures/sse-responses/gemini-3.6-flash-antigravity-ok-answer.sse"
  ),
  "utf8"
);

function routed(spec = "google@gemini-test"): RoutedPlan {
  return {
    kind: "routed",
    spec,
    role: "panel",
    invocationMode: "explicit-model",
    explanation: {
      requestedModel: spec,
      routedModel: "gemini-test",
      source: "explicit",
      outcome: { kind: "ok" },
      candidates: [],
      warnings: [],
    },
    hops: [
      {
        provider: "google",
        displayName: "Google planned display name",
        modelSpec: spec,
        wireId: "gemini-test",
        billing: "metered",
      },
    ],
  };
}

function setFor(handler: ModelHandler): HandlerSet {
  return {
    remote: async () => handler,
    openRouter: () => {
      throw new Error("unexpected OpenRouter getter");
    },
    poe: async () => null,
    local: () => null,
    openRouterHandlers: new Map(),
    remoteProviderHandlers: new Map(),
    localProviderHandlers: new Map(),
    poeHandlers: new Map(),
  };
}

function servingHandler(inspect?: (c: Context, payload: unknown) => void): ModelHandler {
  return {
    async handle(c, payload) {
      inspect?.(c, payload);
      const entry = recordHopEntry(c, "gemini", "gemini-test");
      if (!entry) throw new Error("gateway did not install its hop log");
      entry.arm = "api-key";
      entry.billing = "metered";
      return new Response(responseText, { headers: { "content-type": "text/event-stream" } });
    },
    async shutdown() {},
  };
}

// CatalogPendingHandler exposes no registry/factory injection at resolution.
// This getter double has its real public type but supplies the eventual serving
// handler, so the test isolates A3's builder/wrapper/gateway attribution contract.
class ResolvingCatalogPending extends CatalogPendingHandler {
  constructor(private readonly resolved: ModelHandler) {
    super({} as ProfileContext, "google", "route registry is not available yet");
  }

  override handle(c: Context, payload: unknown): Promise<Response> {
    return this.resolved.handle(c, payload);
  }
}

afterEach(() => _clearTryInTurnMemory());

describe("G2 — pending chain attribution through the real gateway", () => {
  test.each(["try-in-turn", "catalog-pending"] as const)(
    "%s stays callable and keeps google's planned uid/display name when gemini serves",
    async (handlerKind) => {
      const plan = routed();
      const resolved = servingHandler();
      const pending =
        handlerKind === "try-in-turn"
          ? new TryInTurnHandler(
              "t3-google-planned-hop",
              "Google",
              ["chat-completions"],
              () => resolved
            )
          : new ResolvingCatalogPending(resolved);
      let providerReads = 0;
      Object.defineProperty(pending, "provider", {
        get() {
          providerReads++;
          throw new Error("a pending handler has no provider transport yet");
        },
      });
      const chains = await buildAdvisorChains([plan], setFor(pending));
      const key = advisorChainKey("panel", plan.spec);
      const build = chains.get(key);
      expect(providerReads).toBe(0);
      expect(build?.builds[0]).toMatchObject({ kind: "built-pending", handlerKind });
      expect(build?.firstCallableHop).toBe(0);
      expect(describeAdvisorPlan(plan, build)).toContain(
        "google@gemini-test -> Google planned display name (metered, billed per token)"
      );
      const gateway = createAdvisorPanelGateway({
        plans: new Map([[key, plan]]),
        chains,
        childAuth: { controlled: true },
      });
      const result = await gateway.call({
        plan,
        payload: buildAdvisorPanelPayload(plan.hops[0].modelSpec, system, turns, 2048),
        timeoutMs: 1000,
      });
      expect(result.failure).toBeUndefined();
      expect(result.status).toBe(200);
      expect(result.bodyText).toBe(responseText);
      expect(result.hops).toHaveLength(1);
      expect(result.hops[0]).toMatchObject({
        provider: "gemini",
        uid: "google",
        plannedUid: "google",
        displayName: "Google planned display name",
        wireModel: "gemini-test",
        arm: "api-key",
        billing: "metered",
      });
      expect(result.plannedHop).toEqual({
        provider: "google",
        displayName: "Google planned display name",
        billing: "metered",
      });
      expect(providerReads).toBe(0);
    },
    timeout
  );
});

describe("G1 — the runtime gateway uses only the startup plan map", () => {
  test(
    "a startup plan is returned by identity, separately for panel and collector",
    () => {
      const panel = routed();
      const collector: AdvisorModelPlan = {
        kind: "refused",
        spec: panel.spec,
        role: "collector",
        cause: "no-credential",
        reason: "collector credential is absent",
      };
      const gateway = createAdvisorPanelGateway({
        plans: new Map<string, AdvisorModelPlan>([
          [advisorChainKey("panel", panel.spec), panel],
          [advisorChainKey("collector", panel.spec), collector],
        ]),
        chains: new Map(),
        childAuth: { controlled: true },
      });
      expect(gateway.plan(panel.spec, "panel")).toBe(panel);
      expect(gateway.plan(panel.spec, "collector")).toBe(collector);
    },
    timeout
  );

  test(
    "an unplanned spec is refused instead of lazily routing it",
    () => {
      const gateway = createAdvisorPanelGateway({
        plans: new Map(),
        chains: new Map(),
        childAuth: { controlled: true },
      });
      expect(gateway.plan("cx@unplanned-test", "panel")).toEqual({
        kind: "refused",
        spec: "cx@unplanned-test",
        role: "panel",
        cause: "no-callable-hop",
        reason: "advisor runtime not planned for this launch",
      });
    },
    timeout
  );
});

describe("G4 — tool-less full-conversation panel payload", () => {
  test(
    "a real Codex handler sends no upstream tools even with code mode on",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "claudish-t3-codex-panel-"));
      const moduleUrl = (path: string) => pathToFileURL(join(import.meta.dir, path)).href;
      // The response is the unmodified real Codex final-answer capture. The
      // request is built by the production payload builder and Responses adapter.
      const script = `
      import { readFileSync } from "node:fs";
      const { ComposedHandler } = await import(${JSON.stringify(moduleUrl("composed-handler.ts"))});
      const { CodexAPIFormat } = await import(${JSON.stringify(moduleUrl("../adapters/codex-api-format.ts"))});
      const { _setCatalogEntriesForTest } = await import(${JSON.stringify(moduleUrl("../providers/catalog-client.ts"))});
      const { createAdvisorPanelGateway } = await import(${JSON.stringify(moduleUrl("advisor-panel-gateway.ts"))});
      const { buildAdvisorChains, buildAdvisorPanelPayload } = await import(${JSON.stringify(moduleUrl("advisor-route-plan.ts"))});
      _setCatalogEntriesForTest([]);
      const model = ${JSON.stringify(capturedRequest.model)};
      const spec = "cx@" + model;
      const plan = {
        kind: "routed", spec, role: "panel", invocationMode: "explicit-model",
        explanation: {requestedModel: spec, routedModel: model, source: "explicit", candidates: [], outcome: {kind: "ok"}, warnings: []},
        hops: [{provider: "openai-codex", displayName: "OpenAI Codex", modelSpec: spec, wireId: model, billing: "subscription"}]
      };
      const captured = readFileSync(${JSON.stringify(join(import.meta.dir, "../test-fixtures/sse-responses/codex-exec-turn2.sse"))}, "utf8");
      const outbound = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url !== "https://upstream.invalid/v1/responses") throw new Error("unexpected network attempt: " + url);
        outbound.push(JSON.parse(init.body));
        return new Response(captured, {headers: {"content-type": "text/event-stream"}});
      };
      const transport = {
        name: "openai-codex", displayName: "OpenAI Codex", streamFormat: "openai-responses-sse",
        getEndpoint: () => "https://upstream.invalid/v1/responses", getHeaders: async () => ({})
      };
      const handler = new ComposedHandler(transport, model, model, 0, {
        requestRole: "advisor", codeMode: "on", adapter: new CodexAPIFormat(model, "openai-responses-sse"),
        catalogCachePath: ${JSON.stringify(join(home, "absent-catalog.json"))}
      });
      try {
        const chains = await buildAdvisorChains([plan], {
          remote: async () => handler, openRouter: () => {throw new Error("unexpected OpenRouter");},
          local: () => null, poe: async () => null,
          openRouterHandlers: new Map(), remoteProviderHandlers: new Map(), localProviderHandlers: new Map(), poeHandlers: new Map()
        });
        const gateway = createAdvisorPanelGateway({plans: new Map([["panel:"+spec, plan]]), chains, childAuth: {controlled: true}});
        const payload = buildAdvisorPanelPayload(spec, ${JSON.stringify(system)}, ${JSON.stringify(turns)}, 2048);
        const result = await gateway.call({plan, payload, timeoutMs: 1000});
        console.log(JSON.stringify({outbound, status: result.status, failure: result.failure, bodyText: result.bodyText}));
      } finally {
        globalThis.fetch = originalFetch;
        await handler.shutdown();
      }
    `;
      try {
        const child = Bun.spawn([process.execPath, "--eval", script], {
          env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        const result = JSON.parse(stdout);
        expect(result.failure).toBeUndefined();
        expect(result.status).toBe(200);
        expect(result.outbound).toHaveLength(1);
        const outbound = result.outbound[0];
        expect(outbound.tools ?? []).toEqual([]);
        expect(outbound).not.toHaveProperty("metadata");
        // The Responses adapter may merge adjacent messages of the same role;
        // every captured turn's text must still reach the upstream request.
        const upstreamText = outbound.input
          .flatMap((message: { content?: Array<{ text?: string }> }) =>
            (message.content ?? []).map((block) => block.text ?? "")
          )
          .join("\n");
        for (const turn of turns) expect(upstreamText).toContain(turn.content);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    timeout
  );

  test(
    "the gateway sends every captured turn with stream false and no tools, metadata or inbound auth",
    async () => {
      expect(turns.length).toBeGreaterThan(4);
      expect(new Set(turns.map((turn) => turn.role))).toEqual(new Set(["user", "assistant"]));
      const plan = routed();
      const payload = buildAdvisorPanelPayload(plan.hops[0].modelSpec, system, turns, 2048);
      const expectedKeys = ["max_tokens", "messages", "model", "stream", "system"];
      expect(Object.keys(payload).sort()).toEqual(expectedKeys);
      let received: unknown;
      let rawBody: unknown;
      const handler = servingHandler((c, body) => {
        received = body;
        rawBody = c.req.json();
        expect(c.req.header("authorization")).toBeUndefined();
        expect(c.req.header("x-api-key")).toBeUndefined();
        expect(c.req.header("x-claudish-no-recovery")).toBe("advisor");
      });
      const key = advisorChainKey("panel", plan.spec);
      const build: AdvisorChainBuild = {
        key,
        builds: [{ kind: "built", handler, transportName: "gemini" }],
        handler,
        firstCallableHop: 0,
        uidByTransportName: new Map([["gemini", "google"]]),
      };
      const gateway = createAdvisorPanelGateway({
        plans: new Map([[key, plan]]),
        chains: new Map([[key, build]]),
        childAuth: { controlled: true },
      });
      const result = await gateway.call({ plan, payload, timeoutMs: 1000 });
      expect(result.failure).toBeUndefined();
      expect(result.status).toBe(200);
      expect(received).toEqual({
        model: plan.hops[0].modelSpec,
        system,
        messages: turns,
        max_tokens: 2048,
        stream: false,
      });
      expect(await rawBody).toEqual(received);
      expect(Object.keys(received as object).sort()).toEqual(expectedKeys);
      for (const key of ["tools", "metadata", "thinking", "output_config", "tool_choice"]) {
        expect(received).not.toHaveProperty(key);
      }
    },
    timeout
  );
});
