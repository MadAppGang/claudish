/**
 * Drives the CURRENT parsers — the pre-hook API, with repair plumbing on each
 * parser and the Gemini middleware on `MiddlewareManager` — over golden inputs.
 *
 * This file is bound to the API the hook system deletes. When P4 removes the
 * parser repair options and P5 removes `middleware/`, this driver goes with
 * them, and the parity test drives the new parser + seam over the same golden
 * files instead. The goldens themselves never change.
 */

import { DefaultAPIFormat } from "../../adapters/base-api-format.js";
import { createAnthropicPassthroughStream } from "../../handlers/shared/stream-parsers/anthropic-sse.js";
import { createDevinConnectStream } from "../../handlers/shared/stream-parsers/devin-connect.js";
import { createGeminiSseStream } from "../../handlers/shared/stream-parsers/gemini-sse.js";
import { createResponsesStreamHandler } from "../../handlers/shared/stream-parsers/openai-responses-sse.js";
import { createStreamingResponseHandler } from "../../handlers/shared/stream-parsers/openai-sse.js";
import { GeminiThoughtSignatureMiddleware, MiddlewareManager } from "../../middleware/index.js";
import {
  type GeminiMiddlewareGolden,
  type GoldenInput,
  type GoldenRepair,
  type GoldenToolSchema,
  type ParserGolden,
  inputResponse,
  normalizeWire,
} from "./golden-format.js";

/**
 * The minimal Hono context the parsers touch (same stub as behavior-repair.test.ts).
 *
 * openai-sse also takes an adapter. behavior-repair.test.ts passed `{}`, which
 * works only because its inputs carry no text: `{}` has no `processTextContent`,
 * so the parser's per-chunk catch silently drops every text chunk. The goldens
 * use the real `DefaultAPIFormat`, as format-translation.test.ts does; for the
 * tool-only repair inputs the output is byte-identical either way.
 */
const ctx: any = {
  body: (stream: any, init: any) => new Response(stream, init),
  json: () => {
    throw new Error("Unexpected no-body error path");
  },
};

interface RepairFns {
  shouldBufferTool: (name: string) => boolean;
  repair: (name: string, argsJson: string) => string | undefined;
}

/** The repair rule as the callbacks the old plumbing took (mirrors `fakeSession()`). */
function repairFns(repair: GoldenRepair): RepairFns | undefined {
  switch (repair.kind) {
    case "none":
      return undefined;
    case "replace":
      return {
        shouldBufferTool: (name) => name === repair.tool,
        repair: (name) => (name === repair.tool ? repair.args : undefined),
      };
    case "throws":
      return {
        shouldBufferTool: (name) => name === repair.tool,
        repair: () => {
          throw new Error("synthetic repair failure");
        },
      };
  }
}

export type ParserCaseInput = Omit<ParserGolden, "kind" | "output">;

/** Run one parser case and return the client SSE, normalized. */
export async function runParserCase(c: ParserCaseInput): Promise<string> {
  const fns = repairFns(c.repair);
  const upstream = inputResponse(c.input);
  let out: Response;

  switch (c.parser) {
    case "openai-sse":
      out = createStreamingResponseHandler(
        ctx,
        upstream,
        new DefaultAPIFormat(c.modelName),
        c.modelName,
        null,
        undefined,
        c.toolSchemas,
        undefined,
        undefined,
        fns && {
          shouldBufferTool: fns.shouldBufferTool,
          onToolCall: fns.repair,
        }
      );
      break;
    case "openai-responses-sse":
      out = createResponsesStreamHandler(ctx, upstream, {
        modelName: c.modelName,
        ...(fns ? { shouldBufferTool: fns.shouldBufferTool, onToolCall: fns.repair } : {}),
      });
      break;
    case "anthropic-sse":
      out = createAnthropicPassthroughStream(ctx, upstream, {
        modelName: c.modelName,
        ...(fns ? { shouldBufferTool: fns.shouldBufferTool, repairToolArgs: fns.repair } : {}),
      });
      break;
    case "gemini-sse":
      // gemini-sse never buffers (a functionCall arrives whole); the old test
      // passed `repairToolArgs` alone.
      out = createGeminiSseStream(ctx, upstream, {
        modelName: c.modelName,
        ...(fns ? { repairToolArgs: fns.repair } : {}),
      });
      break;
    case "devin-connect":
      out = createDevinConnectStream(ctx, upstream, {
        modelName: c.modelName,
        ...(fns ? { shouldBufferTool: fns.shouldBufferTool, repairToolArgs: fns.repair } : {}),
      });
      break;
  }

  return normalizeWire(await out.text());
}

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
