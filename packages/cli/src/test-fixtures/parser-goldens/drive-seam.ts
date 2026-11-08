/**
 * Drives a golden case through the code that replaced the parsers' repair
 * plumbing: the parser (which no longer repairs anything) and then the hook
 * response seam, with the golden's repair rule expressed as a `toolCall` hook.
 *
 * - `none`: no hook; the seam is the identity, so the parser's own bytes reach
 *   the client.
 * - `replace`: a fix-severity hook armed for `tool` returns
 *   `repairToolArgs(args)`; the seam holds that tool's block and finishes it
 *   with one delta carrying the repaired arguments.
 * - `throws`: the same hook throws on every call; the engine fails open and the
 *   seam forwards the model's own arguments.
 */

import { DefaultAPIFormat } from "../../adapters/base-api-format.js";
import { createAnthropicPassthroughStream } from "../../handlers/shared/stream-parsers/anthropic-sse.js";
import { createDevinConnectStream } from "../../handlers/shared/stream-parsers/devin-connect.js";
import { createGeminiSseStream } from "../../handlers/shared/stream-parsers/gemini-sse.js";
import { createResponsesStreamHandler } from "../../handlers/shared/stream-parsers/openai-responses-sse.js";
import { createStreamingResponseHandler } from "../../handlers/shared/stream-parsers/openai-sse.js";
import { HookEngine } from "../../hooks/engine.js";
import { UnavailableSink } from "../../hooks/injection/sinks.js";
import { type HookDefinition, act } from "../../hooks/public.js";
import { HookRegistry } from "../../hooks/registry.js";
import { type HookRequestScope, RequestHooks } from "../../hooks/request-stage.js";
import { applyResponseSeam } from "../../hooks/response-seam.js";
import {
  type GoldenRepair,
  type ParserGolden,
  inputResponse,
  normalizeWire,
} from "./golden-format.js";

/** The minimal Hono context the parsers and the request stage touch. */
function context(): any {
  const vars = new Map<string, unknown>();
  return {
    body: (stream: any, init: any) => new Response(stream, init),
    json: () => {
      throw new Error("Unexpected no-body error path");
    },
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  };
}

/** The golden's repair rule as a hook definition. */
export function repairHook(repair: Exclude<GoldenRepair, { kind: "none" }>): HookDefinition {
  return {
    apiVersion: 1,
    id: "repair",
    on: {
      toolCall: {
        tools: [repair.tool],
        handle: () => {
          if (repair.kind === "throws") throw new Error("synthetic repair failure");
          return [act.repairToolArgs(JSON.parse(repair.args), "golden repair")];
        },
      },
    },
  };
}

/** A request scope whose only hook is `def`, as `withHooks` + a terminal handler would build it. */
export async function scopeWith(
  def: HookDefinition,
  modelName: string,
  c: any = context()
): Promise<HookRequestScope> {
  const engine = new HookEngine({
    registry: new HookRegistry(
      [],
      [{ id: `hook:golden/${def.id}`, module: "/golden.ts", moduleIndex: 0, exportIndex: 0, def }],
      undefined
    ),
    config: {},
    hostMode: "other",
    journalSink: () => {},
    warn: () => {},
    drainTelemetryOutbox: false,
  });
  return new RequestHooks(engine, null, new UnavailableSink(() => {})).beginAttempt(c, {
    claudeRequest: { messages: [{ role: "user", content: "golden" }] },
    route: { modelId: modelName, provider: "golden", native: false },
    model: modelName,
    stream: true,
  });
}

export type ParserCaseInput = Omit<ParserGolden, "kind" | "output">;

/** The parser's own output for a case: no repair plumbing exists any more. */
export function runParser(c: ParserCaseInput): Response {
  const ctx = context();
  const upstream = inputResponse(c.input);
  switch (c.parser) {
    case "openai-sse":
      return createStreamingResponseHandler(
        ctx,
        upstream,
        new DefaultAPIFormat(c.modelName),
        c.modelName,
        null,
        undefined,
        c.toolSchemas
      );
    case "openai-responses-sse":
      return createResponsesStreamHandler(ctx, upstream, { modelName: c.modelName });
    case "anthropic-sse":
      return createAnthropicPassthroughStream(ctx, upstream, { modelName: c.modelName });
    case "gemini-sse":
      return createGeminiSseStream(ctx, upstream, { modelName: c.modelName });
    case "devin-connect":
      return createDevinConnectStream(ctx, upstream, { modelName: c.modelName });
  }
}

/** Run one case through parser + seam and return the client SSE, normalized. */
export async function runParserCase(c: ParserCaseInput): Promise<string> {
  let out = runParser(c);
  if (c.repair.kind !== "none") {
    out = await applyResponseSeam(out, await scopeWith(repairHook(c.repair), c.modelName));
  }
  return normalizeWire(await out.text());
}
