/**
 * Fork extensions barrel export + registration.
 *
 * All fork-specific features are wired through this single entry point.
 * proxy-server.ts calls registerForkExtensions() to activate them.
 * This keeps the diff between our fork and upstream minimal.
 */

import type { Hono } from "hono";
import { log } from "../logger.js";
import { createProxyAuthMiddleware } from "./middleware/proxy-auth.js";
import { registerModelDiscoveryRoute } from "./routes/model-discovery.js";

export { createProxyAuthMiddleware } from "./middleware/proxy-auth.js";
export { registerModelDiscoveryRoute } from "./routes/model-discovery.js";
export { stripBillingHeaderFromBody } from "./middleware/billing-header-strip.js";
export { resolveSourceIp, logRequest } from "./middleware/request-logger.js";
export { createHostnameConfig, type HostnameConfig } from "./server/hostname-binding.js";

export interface ForkExtensionsOptions {
  proxyKey?: string;
}

/**
 * Register all fork extensions on the Hono app.
 * Called once from proxy-server.ts during startup.
 */
export function registerForkExtensions(app: Hono, opts: ForkExtensionsOptions): void {
  // 1. Proxy authentication middleware
  if (opts.proxyKey) {
    app.use("/v1/*", createProxyAuthMiddleware(opts.proxyKey));
    log("[Proxy] Authentication enabled (Anthropic pass-through; proxy key required for other providers)");
  }

  // 2. Model discovery endpoint
  registerModelDiscoveryRoute(app);
}
