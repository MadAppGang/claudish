/**
 * Drives the Gemini thought-signature built-in through the hook raw tier, the
 * way ComposedHandler wires it: a `RawStreamTap` on openai-sse per stream, then
 * `providerRequest` on the next request, over the Gemini golden captured from
 * the pre-hook `MiddlewareManager` (P0). The golden itself never changes.
 *
 * `shouldHandle` is whether the built-in applies to a route for that model, and
 * `activeNames` is the `middleware_names` stats value (`statsNames`).
 */

import { DefaultAPIFormat } from "../../adapters/base-api-format.js";
import { createStreamingResponseHandler } from "../../handlers/shared/stream-parsers/openai-sse.js";
import { createGeminiThoughtSignatureHook } from "../../hooks/builtins/gemini-thought-signature.js";
import { HookEngine } from "../../hooks/engine.js";
import type { JournalEntry } from "../../hooks/journal.js";
import type { RouteInfo } from "../../hooks/public.js";
import { RawRequest, type RawStreamTap, statsNames } from "../../hooks/raw.js";
import { HookRegistry } from "../../hooks/registry.js";
import {
  type GeminiMiddlewareGolden,
  type GoldenInput,
  type GoldenToolSchema,
  inputResponse,
  normalizeWire,
} from "./golden-format.js";

/** The minimal Hono context the parser touches. */
const ctx: any = {
  body: (stream: any, init: any) => new Response(stream, init),
  json: () => {
    throw new Error("Unexpected no-body error path");
  },
};

const route = (modelId: string): RouteInfo => ({ modelId, provider: "openrouter", native: false });

/** One engine, as one process has: the built-in's caches live as long as it does. */
export function geminiEngine(journal: JournalEntry[] = []): HookEngine {
  return new HookEngine({
    registry: new HookRegistry([createGeminiThoughtSignatureHook()], [], undefined),
    config: {},
    hostMode: "other",
    journalSink: (e) => journal.push(e),
    warn: () => {},
    drainTelemetryOutbox: false,
  });
}

function rawRequest(engine: HookEngine, modelId: string): RawRequest {
  return new RawRequest(
    engine,
    route(modelId),
    { model: modelId, provider: "openrouter" },
    { model: modelId, stream: true, systemText: "", messages: [], tools: [] }
  );
}

function runOpenAiSse(
  input: GoldenInput,
  modelId: string,
  toolSchemas: GoldenToolSchema[],
  tap: RawStreamTap | undefined
): Promise<string> {
  return createStreamingResponseHandler(
    ctx,
    inputResponse(input),
    new DefaultAPIFormat(modelId),
    modelId,
    tap,
    undefined,
    toolSchemas
  )
    .text()
    .then(normalizeWire);
}

export interface GeminiScenarioInput {
  id: string;
  description: string;
  streams: GoldenInput[];
  nextRequestMessages: unknown[];
}

/** Replay the Gemini golden's scenarios through the raw tier. */
export async function runGeminiCapture(
  id: string,
  modelId: string,
  toolSchemas: GoldenToolSchema[],
  applicabilityModels: string[],
  scenarios: GeminiScenarioInput[]
): Promise<GeminiMiddlewareGolden> {
  const probe = geminiEngine();
  const applicability = applicabilityModels.map((m) => ({
    modelId: m,
    shouldHandle: probe.registry.applicable("raw.providerChunk", { route: route(m) }).length > 0,
    activeNames: statsNames(probe, route(m)),
  }));

  const outScenarios: GeminiMiddlewareGolden["scenarios"] = [];
  for (const scenario of scenarios) {
    const engine = geminiEngine();

    const streams: GeminiMiddlewareGolden["scenarios"][number]["streams"] = [];
    for (const input of scenario.streams) {
      const tap = rawRequest(engine, modelId).streamTap();
      const output = await runOpenAiSse(input, modelId, toolSchemas, tap);
      const without = await runOpenAiSse(input, modelId, toolSchemas, undefined);
      streams.push({ input, output, outputUnchangedByMiddleware: output === without });
    }

    const before = structuredClone(scenario.nextRequestMessages) as any[];
    const next = await rawRequest(engine, modelId).providerRequest({
      claudeRequest: {},
      messages: structuredClone(scenario.nextRequestMessages) as any[],
      tools: [],
    });
    // Round-trip through JSON: the golden records what reaches the wire.
    const after = JSON.parse(JSON.stringify(next.messages));

    outScenarios.push({
      id: scenario.id,
      description: scenario.description,
      streams,
      nextRequest: { before, after },
    });
  }

  return {
    kind: "gemini-middleware",
    id,
    modelId,
    toolSchemas,
    applicability,
    scenarios: outScenarios,
  };
}
