/**
 * A connection whose wire nobody established — `wire.status: "unknown"`, or a
 * model the catalog does not publish on this provider at all — is not guessed
 * at. Its route profile still publishes which APIs the host serves, so each is
 * tried in turn (catalog 3.7.0 R4; Jack's decision 3.2):
 *
 * - order: `responses`, `anthropic-messages`, `chat-completions`, `gemini`,
 *   restricted to the profile's `apis`, with the API that last worked first;
 * - advance ONLY on a protocol mismatch: 404, 405, or a 400 whose body says the
 *   endpoint or protocol is wrong. Never on 401, 403, 429, 5xx or a network
 *   error, which say nothing about the API;
 * - no output limit and no reasoning field is sent while trying, because no
 *   source established either for this connection;
 * - what worked is remembered per connection until the next catalog
 *   generation, and every fallback is logged: each one is a gap Models Index
 *   should close.
 */
import type { Context } from "hono";
import { extractUpstreamStatus } from "../handlers/shared/anthropic-error.js";
import type { ModelHandler } from "../handlers/types.js";
import { log } from "../logger.js";
import type { KnownWire, WireApi } from "./connection-wire.js";

export const TRY_IN_TURN_ORDER: readonly WireApi[] = [
  "responses",
  "anthropic-messages",
  "chat-completions",
  "gemini",
];

/** A wire that establishes the API and nothing else. */
export function apiOnlyWire(api: WireApi): KnownWire {
  return {
    status: "known",
    api,
    tokenParam: api === "gemini" ? { status: "not_applicable" } : { status: "unknown" },
    toolsWithReasoning: { status: "unknown" },
    reasoning: { status: "unknown" },
    speed: { status: "unknown" },
    evidence: [],
  };
}

/**
 * Whether an error answer says "wrong API for this model". The status is the
 * upstream's own, recovered from the body when the handler remapped it to 400.
 */
export function isProtocolMismatch(status: number, body: string): boolean {
  const upstream = extractUpstreamStatus(body) ?? status;
  if (upstream === 404 || upstream === 405) return true;
  if (upstream !== 400) return false;
  return /protocol|endpoint|unsupported api|use the v1\/\w+|has moved to 'input'|unsupported parameter: 'messages'|unknown (field|parameter)[^.]{0,20}'(messages|input|contents)'/i.test(
    body
  );
}

const remembered = new Map<string, WireApi>();

export function _clearTryInTurnMemory(): void {
  remembered.clear();
}

export function tryInTurnOrder(apis: WireApi[], key: string): WireApi[] {
  const ordered = TRY_IN_TURN_ORDER.filter((api) => apis.includes(api));
  const winner = remembered.get(key);
  return winner && ordered.includes(winner)
    ? [winner, ...ordered.filter((a) => a !== winner)]
    : ordered;
}

export class TryInTurnHandler implements ModelHandler {
  private readonly handlers = new Map<WireApi, ModelHandler | null>();

  /**
   * @param key   Connection identity plus generation: what worked is remembered under it.
   * @param label `route · wire id`, for the log.
   * @param apis  The route profile's published APIs.
   * @param build Builds the handler for one API (an {@link apiOnlyWire} connection).
   */
  constructor(
    private readonly key: string,
    private readonly label: string,
    private readonly apis: WireApi[],
    private readonly build: (api: WireApi) => ModelHandler | null
  ) {}

  private handlerFor(api: WireApi): ModelHandler | null {
    if (!this.handlers.has(api)) this.handlers.set(api, this.build(api));
    return this.handlers.get(api) ?? null;
  }

  async handle(c: Context, payload: any): Promise<Response> {
    let last: Response | undefined;
    for (const api of tryInTurnOrder(this.apis, this.key)) {
      const handler = this.handlerFor(api);
      if (!handler) continue;
      const response = await handler.handle(c, structuredClone(payload));
      if (response.ok) {
        if (remembered.get(this.key) !== api) {
          remembered.set(this.key, api);
          log(
            `[Wire] ${this.label}: wire unknown — ${api} answered; remembered until the next generation`
          );
        }
        return response;
      }
      const body = await response.clone().text();
      if (!isProtocolMismatch(response.status, body)) return response;
      log(
        `[Wire] ${this.label}: wire unknown — ${api} is not this model's API (${response.status}); trying the next`
      );
      last = response;
    }
    return (
      last ??
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `claudish: ${this.label} has no API in its route profile that claudish can call`,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    );
  }

  async shutdown(): Promise<void> {
    for (const handler of this.handlers.values()) await handler?.shutdown();
  }
}
