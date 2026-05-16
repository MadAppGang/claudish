/**
 * Model discovery endpoint (fork extension).
 *
 * Claude Code queries /v1/models when CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1.
 * Returns all routable models from config.json routing rules + custom endpoints.
 */

import type { Hono } from "hono";
import { loadConfig } from "../../profile-config.js";

export function registerModelDiscoveryRoute(app: Hono): void {
  app.get("/v1/models", (c) => {
    const cfg = loadConfig();
    const seen = new Set<string>();
    const models: { id: string; display_name: string; created_at: string }[] = [];

    // From routing rules — each key is a model name
    if (cfg.routing) {
      for (const modelName of Object.keys(cfg.routing)) {
        if (!seen.has(modelName)) {
          seen.add(modelName);
          models.push({
            id: modelName,
            display_name: modelName,
            created_at: "2026-01-01T00:00:00Z",
          });
        }
      }
    }

    // From custom endpoints — each declared model
    if (cfg.customEndpoints) {
      for (const [, ep] of Object.entries(cfg.customEndpoints)) {
        const endpoint = ep as { models?: string[] };
        if (endpoint.models) {
          for (const m of endpoint.models) {
            if (!seen.has(m)) {
              seen.add(m);
              models.push({
                id: m,
                display_name: m,
                created_at: "2026-01-01T00:00:00Z",
              });
            }
          }
        }
      }
    }

    return c.json({
      object: "list",
      data: models,
    });
  });
}
