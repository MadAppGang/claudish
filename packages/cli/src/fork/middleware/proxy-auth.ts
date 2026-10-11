/**
 * Proxy authentication middleware (fork extension).
 *
 * Anthropic pass-through is exempt (OAuth or proxy-key swap handled by NativeHandler).
 * Non-Anthropic providers require the proxy key in x-api-key / authorization / x-proxy-key.
 * GET requests and health endpoints are exempt for Docker healthcheck and model discovery.
 *
 * #400 — scoped inbound keys authenticate like a proxy key but are gated to
 * their allowModels BEFORE anything else (including the native exemption: a
 * scoped key never rides the Anthropic passthrough). Everything outside the
 * allowlist is a labeled 403 — wording deliberately free of quota-class words
 * (same doctrine as #296: isQuotaExhaustion must never arm on this refusal).
 */

import type { MiddlewareHandler } from "hono";
import { wrapAnthropicError } from "../../handlers/shared/anthropic-error.js";
import { matchesProxyKey } from "../../handlers/shared/proxy-keys.js";
import { noteProxyKeyAuthentication } from "../../handlers/shared/proxy-key-rotation.js";
import {
  acquireInboundSlot,
  inboundInFlight,
  inboundModelAllowed,
  matchesInboundKey,
  markInboundKey,
  releaseInboundSlot,
  type InboundKeyEntry,
} from "../../handlers/shared/inbound-keys.js";
import { markKeylessExempt } from "../../handlers/shared/keyless-exempt.js";
import { logStderr } from "../../logger.js";
import { parseModelSpec } from "../../providers/model-parser.js";
import type { ClaudishProfileConfig } from "../../profile-config.js";

/**
 * #410 — the bare model names that leave the native lane: routing-map keys
 * plus custom-endpoint model ids. Custom-endpoint ids are family-unknown by
 * construction, so parseModelSpec defaults them to "native-anthropic"; without
 * this set the pass-through exemption would serve them with the cluster's
 * stored credentials (measured: no-auth model=frognano-4b → 200).
 */
export function collectRoutedBareNames(
  config: Pick<ClaudishProfileConfig, "routing" | "customEndpoints">
): Set<string> {
  return new Set<string>([
    ...Object.keys(config.routing ?? {}),
    ...Object.values(config.customEndpoints ?? {}).flatMap((ep) =>
      ep && typeof ep === "object" && Array.isArray((ep as { models?: unknown }).models)
        ? (ep as { models: unknown[] }).models.filter(
            (m): m is string => typeof m === "string" && m.length > 0
          )
        : []
    ),
  ]);
}

export function createProxyAuthMiddleware(
  proxyKeys: string[],
  inboundKeys: InboundKeyEntry[] = [],
  routedBareNames: ReadonlySet<string> = new Set()
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "GET") {
      return await next();
    }

    // Peek at body.model to determine target provider.
    // Hono caches parsed JSON — safe to call again from the route handler.
    let model: string | undefined;
    try {
      const body = await c.req.json();
      model = body?.model;
    } catch {
      return await next(); // Malformed body — let handler return 400
    }

    const authHeader = c.req.header("authorization");
    const apiKeyHeader = c.req.header("x-api-key");
    const proxyKeyHeader = c.req.header("x-proxy-key");

    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    const provided = proxyKeyHeader || apiKeyHeader || bearerToken;

    // #400 — scoped inbound keys: gate BEFORE the native exemption. A scoped
    // key sees only its allowlist, on every ingress route this middleware
    // covers (/v1/messages, /v1/chat/completions, count_tokens included).
    if (inboundKeys.length > 0 && typeof model === "string" && model.length > 0) {
      const scoped = matchesInboundKey(provided, inboundKeys);
      if (scoped) {
        markInboundKey(c.req.raw, scoped.name);
        if (!inboundModelAllowed(scoped, model)) {
          // Countable marker via logStderr — the hub runs with debug off, where
          // log() alone is file-only and invisible to docker logs (#212 lesson).
          logStderr(
            `[InboundKey] refused key=${scoped.name} model=${model} (allowlist: ${scoped.allowModels.join(", ")})`
          );
          return c.json(
            wrapAnthropicError(
              403,
              `[InboundKey] key '${scoped.name}' is not permitted to use model '${model}' — allowed models: ${scoped.allowModels.join(", ")}`,
              "permission_error"
            ),
            403
          );
        }
        // Per-key in-flight cap (ASK FROGNANO-ACCESS): acquired BEFORE the
        // handler does any work. Wording deliberately avoids every word
        // `isQuotaExhaustion` arms on (quota/credit/balance/weekly/exhaust/
        // usage limit/plan limit/"exceed your account") — a per-key cap must
        // never divert the fleet's failover. Pinned by test.
        if (!acquireInboundSlot(scoped)) {
          logStderr(
            `[InboundKey] concurrency cap reached key=${scoped.name} cap=${scoped.maxConcurrency} inFlight=${inboundInFlight(scoped.name)}`
          );
          return c.json(
            wrapAnthropicError(
              429,
              `[InboundKey] key '${scoped.name}' already has ${scoped.maxConcurrency} request(s) in flight — retry shortly`,
              "rate_limit_error"
            ),
            429
          );
        }
        // Release on completion. SSE bodies outlive this middleware, so they are
        // released by the stream tracker's end/cancel hooks instead; everything
        // else (JSON responses, errors, throws) is done by the time next()
        // returns — including the 403 above, which returns before acquiring.
        try {
          await next();
        } catch (err) {
          releaseInboundSlot(scoped.name);
          throw err;
        }
        const contentType = c.res?.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          releaseInboundSlot(scoped.name);
        }
        return;
      }
    }

    // Anthropic pass-through: skip proxy key validation entirely.
    // NativeHandler will either swap proxyKey → stored Anthropic key,
    // or pass the client's OAuth token through unchanged.
    //
    // #410 — the exemption is for the Anthropic lane ONLY. parseModelSpec
    // defaults every family-unknown bare name to "native-anthropic", but the
    // handler then resolves such a name through routing/customEndpoints to a
    // remote handler running with the CLUSTER's stored credentials — so
    // without this guard, every routed bare name (frognano-4b, mini,
    // local-fast, …) was served with no credential at all (measured: no-auth
    // POST /v1/messages model=frognano-4b → 200). Explicit provider@model
    // forms never parsed as native and are unaffected.
    if (model) {
      const spec = parseModelSpec(model);
      if (spec.provider === "native-anthropic" && !routedBareNames.has(model)) {
        // #412 — the exemption ADMITS, it no longer decides alone. Record
        // whether this request holds a credential of its own; the resolution
        // site refuses it later if it lands anywhere but the native
        // passthrough (see keyless-exempt.ts). Without the record, a keyless
        // `claude-*` whose modelMap/wall resolution reaches a subscription or
        // PAYG step is served on the FLEET's credential while the caller's own
        // meter — the one actually exhausted — is never surfaced.
        //
        // A scoped inbound key never reaches this line (handled and returned
        // above), so `provided` here is a cluster key or nothing/foreign.
        if (!matchesProxyKey(provided, proxyKeys)) {
          markKeylessExempt(c.req.raw);
        }
        // #439 — the exemption branch AUTHENTICATES as much as the enforce
        // branch does: the matchesProxyKey call above just decided the
        // keyless mark on this very key. A bare `claude-*` that modelMap or
        // wall resolution then remaps onto a remote lane never reaches any
        // native swap site, so this is the only site that can count it —
        // the dominant fleet shape (review of 91311241). The raw-request
        // mark makes the two native swap sites skip their own count for
        // this same request.
        noteProxyKeyAuthentication(
          provided,
          {
            "x-claudish-machine": c.req.header("x-claudish-machine"),
            "user-agent": c.req.header("user-agent"),
          },
          c.req.raw
        );
        return await next();
      }
    }

    // Non-Anthropic: enforce proxy key
    if (!matchesProxyKey(provided, proxyKeys)) {
      return c.json(wrapAnthropicError(401, "invalid proxy authentication"), 401);
    }
    // #439 — the request is authenticated and this middleware is the site
    // that accepted the key: count it when it is the retiring one. Marked
    // here (c.req.raw) so a later native swap for the same request — a
    // non-native name that ROLE_MODELS/modelMap resolves onto the Anthropic
    // lane — does not count it a second time.
    noteProxyKeyAuthentication(
      provided,
      {
        "x-claudish-machine": c.req.header("x-claudish-machine"),
        "user-agent": c.req.header("user-agent"),
      },
      c.req.raw
    );
    await next();
  };
}
