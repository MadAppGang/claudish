/**
 * Drives the Gemini thought-signature middleware the way ComposedHandler wires
 * it today (`MiddlewareManager`, openai-sse), over the Gemini golden.
 *
 * Bound to `middleware/`, which the raw tier replaces; this driver goes with
 * it, and the Gemini built-in's parity test drives the same golden through the
 * hook raw tier instead. The golden itself never changes.
 */

import { DefaultAPIFormat } from "../../adapters/base-api-format.js";
import { createStreamingResponseHandler } from "../../handlers/shared/stream-parsers/openai-sse.js";
import { GeminiThoughtSignatureMiddleware, MiddlewareManager } from "../../middleware/index.js";
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

function runOpenAiSse(
  input: GoldenInput,
  modelId: string,
  toolSchemas: GoldenToolSchema[],
  manager: MiddlewareManager | null
): Promise<string> {
  return createStreamingResponseHandler(
    ctx,
    inputResponse(input),
    new DefaultAPIFormat(modelId),
    modelId,
    manager,
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

/**
 * Run the Gemini middleware the way ComposedHandler wires it: one middleware
 * instance per handler (its cache lives as long as the handler), streams through
 * openai-sse with `target = modelId`, then `beforeRequest` on the next request.
 */
export async function runGeminiCapture(
  id: string,
  modelId: string,
  toolSchemas: GoldenToolSchema[],
  applicabilityModels: string[],
  scenarios: GeminiScenarioInput[]
): Promise<GeminiMiddlewareGolden> {
  const probe = new GeminiThoughtSignatureMiddleware();
  const applicability = applicabilityModels.map((m) => {
    const manager = new MiddlewareManager();
    manager.register(new GeminiThoughtSignatureMiddleware());
    return {
      modelId: m,
      shouldHandle: probe.shouldHandle(m),
      activeNames: manager.getActiveNames(m),
    };
  });

  const outScenarios: GeminiMiddlewareGolden["scenarios"] = [];
  for (const scenario of scenarios) {
    const manager = new MiddlewareManager();
    manager.register(new GeminiThoughtSignatureMiddleware());
    await manager.initialize();

    const streams: GeminiMiddlewareGolden["scenarios"][number]["streams"] = [];
    for (const input of scenario.streams) {
      const output = await runOpenAiSse(input, modelId, toolSchemas, manager);
      const without = await runOpenAiSse(input, modelId, toolSchemas, null);
      streams.push({ input, output, outputUnchangedByMiddleware: output === without });
    }

    const before = structuredClone(scenario.nextRequestMessages) as any[];
    const messages = structuredClone(scenario.nextRequestMessages) as any[];
    await manager.beforeRequest({
      modelId,
      messages,
      tools: [],
      stream: true,
      claudeRequest: {},
      claudeTools: [],
    });
    // Round-trip through JSON: the golden records what reaches the wire.
    const after = JSON.parse(JSON.stringify(messages));

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
