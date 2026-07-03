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
import { createRelayState, startUpstreamProber, type RelayState } from "./relay.js";

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

// Sidecar relay (fork extension). When CLAUDISH_RELAY_UPSTREAM is set, this
// process is a sidecar: it relays traffic to the central hub in NOMINAL mode and
// falls back to the local pipeline (AUTONOMOUS) when the hub is unreachable.
// Unset → this process IS the hub (po-2023): no relay, always local, unchanged.
//   CLAUDISH_RELAY_UPSTREAM — hub base URL (LAN http://192.168.0.46:3000 or WAN https://models.myia.io)
//   CLAUDISH_RELAY_COMPRESS — "1"/"true" → gzip the forwarded request body (WAN externals only)
//   CLAUDISH_NO_ANTHROPIC   — set on every non-ai-01 sidecar; read in proxy-server's leak guard
const relayUpstream = process.env.CLAUDISH_RELAY_UPSTREAM?.trim();
const relayCompress = /^(1|true|yes)$/i.test(process.env.CLAUDISH_RELAY_COMPRESS?.trim() ?? "");
let relay: RelayState | undefined;
let stopProber: (() => void) | undefined;
if (relayUpstream) {
  relay = createRelayState({
    upstream: relayUpstream,
    compress: relayCompress,
    proxyKey: process.env.CLAUDISH_PROXY_KEY || profileConfig.proxyKey,
  });
  stopProber = startUpstreamProber(relay);
}

const server = await createProxyServer(
  port,
  process.env.OPENROUTER_API_KEY,
  undefined,
  false,
  process.env.ANTHROPIC_API_KEY,
  modelMap,
  { quiet: false, hostname, relay }
);

console.log(`[claudish-proxy] Standalone proxy running on http://${hostname}:${port}`);
console.log(`[claudish-proxy] Config: ~/.claudish/config.json`);
console.log(`[claudish-proxy] Press Ctrl+C to stop`);

// Keep process alive
process.on("SIGINT", async () => {
  console.log("\n[claudish-proxy] Shutting down...");
  stopProber?.();
  await server.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  stopProber?.();
  await server.shutdown();
  process.exit(0);
});
