/**
 * Proxy authentication middleware (fork extension).
 *
 * Anthropic pass-through is exempt (OAuth or proxy-key swap handled by NativeHandler).
 * Non-Anthropic providers require the proxy key in x-api-key / authorization / x-proxy-key.
 * GET requests and health endpoints are exempt for Docker healthcheck and model discovery.
 */

import type { MiddlewareHandler } from "hono";
import { wrapAnthropicError } from "../../handlers/shared/anthropic-error.js";
import { parseModelSpec } from "../../providers/model-parser.js";

export function createProxyAuthMiddleware(proxyKey: string): MiddlewareHandler {
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

    // Anthropic pass-through: skip proxy key validation entirely.
    // NativeHandler will either swap proxyKey → stored Anthropic key,
    // or pass the client's OAuth token through unchanged.
    if (model) {
      const spec = parseModelSpec(model);
      if (spec.provider === "native-anthropic") {
        return await next();
      }
    }

    // Non-Anthropic: enforce proxy key
    const authHeader = c.req.header("authorization");
    const apiKeyHeader = c.req.header("x-api-key");
    const proxyKeyHeader = c.req.header("x-proxy-key");

    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    const provided = proxyKeyHeader || apiKeyHeader || bearerToken;
    if (!provided || provided !== proxyKey) {
      return c.json(wrapAnthropicError(401, "invalid proxy authentication"), 401);
    }
    await next();
  };
}
