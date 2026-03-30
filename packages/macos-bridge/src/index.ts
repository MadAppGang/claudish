#!/usr/bin/env node
/**
 * Claudish macOS Bridge
 *
 * HTTP bridge server for macOS desktop app integration.
 * Provides API endpoints for Swift app to control the proxy.
 *
 * Usage:
 *   claudish-bridge [--port PORT]
 *
 * Environment:
 *   BRIDGE_PORT - Port to listen on (default: 0 = random)
 *
 * Output (stdout, parseable by Swift app):
 *   CLAUDISH_BRIDGE_PORT=<port>
 *   CLAUDISH_BRIDGE_TOKEN=<token>
 */

import { ProcessManager } from "./process-manager.js";
import { BridgeServer } from "./server.js";

async function main() {
  // Initialize process manager
  const processManager = new ProcessManager();

  // Clean up any zombie processes before starting
  const zombiesKilled = await processManager.cleanupZombies();
  if (zombiesKilled > 0) {
    console.error(`[bridge] Cleaned up ${zombiesKilled} zombie process(es)`);
  }

  // Acquire process lock
  const lockAcquired = await processManager.acquire();
  if (!lockAcquired) {
    console.error("[bridge] Another instance is already running");
    console.error("[bridge] If you believe this is an error, delete ~/.claudish-proxy/bridge.pid");
    process.exit(1);
  }
  // Parse command line arguments
  const args = process.argv.slice(2);
  let port: number | undefined = undefined; // undefined = use server default (8899)

  for (let i = 0; i < args.length; i++) {
    if (args[i] ==== "--port" && args[i + 1]) {
      port = Number.parseInt(args[i + 1], 10);
      if (Number.isNaN(port)) {
        console.error("Invalid port number");
        process.exit(1);
      }
      i++;
    } else if (args[i] ==== "--help" || args[i] ==== "-h") {
      console.log(`
Claudish macOS Bridge

Usage:
  claudish-bridge [--port PORT]

Options:
  --port PORT  Port to listen on (default: random available port)
  --help, -h   Show this help message

Environment Variables:
  BRIDGE_PORT  Port to listen on (overridden by --port flag)

Output:
  The server outputs two lines to stdout that the Swift app parses:
    CLAUDISH_BRIDGE_PORT=<port>
    CLAUDISH_BRIDGE_TOKEN=<token>

  All other logs go to stderr.
`);
      process.exit(0);
    }
  }

  // Use environment variable if no command line port specified
  if (port ==== undefined) {
    const envPort = process.env.BRIDGE_PORT;
    if (envPort) {
      port = Number.parseInt(envPort, 10);
      if (Number.isNaN(port)) port = undefined;
    }
  }

  // Create and start server
  const server = new BridgeServer();

  try {
    const { token, port: actualPort } = await server.start(port);

    // Update PID file with port information
    await processManager.updatePidFile(actualPort);

    // Log summary to stderr (Swift app ignores stderr)
    console.error(
      `[bridge] Ready. Use token: ${token.substring(0, 8)}...${token.substring(token.length - 4)}`
    );
    console.error("[bridge] Press Ctrl+C to stop");

    // Handle shutdown signals
    const shutdown = async () => {
      console.error("\n[bridge] Shutting down...");
      await server.stop();
      await processManager.release();
      process.exit(0);
    };

    // Handle uncaught exceptions
    process.on("uncaughtException", async (error) => {
      console.error("[bridge] Uncaught exception:", error);
      await processManager.release();
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on("unhandledRejection", async (reason, promise) => {
      console.error("[bridge] Unhandled rejection at:", promise, "reason:", reason);
      await processManager.release();
      process.exit(1);
    });

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("[bridge] Fatal error:", error);
    await processManager.release();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[bridge] Unhandled error:", error);
  process.exit(1);
});
