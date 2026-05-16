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
import { loadConfig } from "../../profile-config.js";

// No modelMap — the proxy is a transparent router. Every model name routes
// to its provider via config.json routing rules:
//   claude-opus-4-7 → anthropic, glm-5.1 → z.ai, qwen3.6-35b-a3b → vllm-myia
// Any model can be used directly; no role remapping.

const server = await createProxyServer(
  port,
  process.env.OPENROUTER_API_KEY,
  undefined,
  false,
  process.env.ANTHROPIC_API_KEY,
  undefined,
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
