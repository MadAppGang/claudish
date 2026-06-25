#!/usr/bin/env bun
/**
 * Claudish Standalone Proxy Server (fork extension)
 *
 * Starts the proxy server without wrapping Claude Code.
 * Used for cluster deployments where other machines route LLM requests
 * through this proxy.
 *
 * Usage: bun packages/cli/src/fork/server/standalone-proxy.ts [--port 3000]
 */

import { config } from "dotenv";
config({ quiet: true });

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Load stored API keys from ~/.claudish/config.json
function loadStoredApiKeys(): void {
  try {
    const configPath = join(homedir(), ".claudish", "config.json");
    if (!existsSync(configPath)) return;
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as {
      apiKeys?: Record<string, string>;
      endpoints?: Record<string, string>;
    };
    if (cfg.apiKeys) {
      for (const [envVar, value] of Object.entries(cfg.apiKeys)) {
        if (!process.env[envVar] && typeof value === "string") {
          process.env[envVar] = value;
        }
      }
    }
    if (cfg.endpoints) {
      for (const [envVar, value] of Object.entries(cfg.endpoints)) {
        if (!process.env[envVar] && typeof value === "string") {
          process.env[envVar] = value;
        }
      }
    }
  } catch {
    // Silently ignore
  }
}

loadStoredApiKeys();

// Parse --port and --host from args
const args = process.argv.slice(2);
let port = 3000;
let hostname = process.env.CLAUDISH_HOST || "127.0.0.1";
const portIdx = args.indexOf("--port");
if (portIdx !== -1 && args[portIdx + 1]) {
  port = Number.parseInt(args[portIdx + 1], 10);
}
const hostIdx = args.indexOf("--host");
if (hostIdx !== -1 && args[hostIdx + 1]) {
  hostname = args[hostIdx + 1];
}

import { createProxyServer } from "../../proxy-server.js";
import { loadConfig, getModelMapping } from "../../profile-config.js";

// Role remapping from the active profile (2026-06-25). Without a modelMap, a
// client that sends a literal Anthropic role name — e.g. `claude-sonnet-4-6`
// because its model selector didn't resolve the "Sonnet" alias to glm-5.2 —
// fell through to the native-anthropic passthrough check (proxy-server.ts isNative)
// and leaked budget Anthropic credits on the Sonnet route. Loading the profile's
// opus/sonnet/haiku map activates proxy-server.ts's role remapping:
//   claude-sonnet-* → glm-5.2 (gc@), claude-haiku-* → qwen, claude-opus-* → claude-opus-4-8 (native, ai-01).
// Models already sent by their budgeted name (glm-5.2, qwen3.6-…) are unaffected.
const profileConfig = loadConfig();
const modelMap = getModelMapping(profileConfig.defaultProfile);

const server = await createProxyServer(
  port,
  process.env.OPENROUTER_API_KEY,
  undefined,
  false,
  process.env.ANTHROPIC_API_KEY,
  modelMap,
  { quiet: false, hostname }
);

console.log(`[claudish-proxy] Standalone proxy running on http://${hostname}:${port}`);
console.log(`[claudish-proxy] Config: ~/.claudish/config.json`);
console.log(`[claudish-proxy] Press Ctrl+C to stop`);

// Keep process alive
process.on("SIGINT", async () => {
  console.log("\n[claudish-proxy] Shutting down...");
  await server.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.shutdown();
  process.exit(0);
});
