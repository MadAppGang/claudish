#!/usr/bin/env node
/**
 * Simple bridge test - tests CycleTLS and interception
 */

import { spawn } from "child_process";
import { setTimeout } from "timers/promises";

const BRIDGE_DIR = new URL("..", import.meta.url).pathname;

async function main() {
  console.log("==== Simple Bridge Test ====\n");

  // Kill any existing bridges
  try {
    const { execSync } = await import("child_process");
    execSync("pkill -9 -f 'macos-bridge/dist/index.js'", { stdio: "ignore" });
    execSync("rm -f ~/.claudish-proxy/bridge.pid", { stdio: "ignore" });
  } catch {}

  await setTimeout(1000);

  // Start bridge
  console.log("[1] Starting bridge...");
  const bridge = spawn("node", ["dist/index.js"], {
    cwd: BRIDGE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let port = "";
  let token = "";
  let output = "";

  // Capture output from both stdout and stderr
  const handleOutput = (data) => {
    const str = data.toString();
    output += str;
    process.stdout.write(data);

    // Extract port/token
    const portMatch = str.match(/CLAUDISH_BRIDGE_PORT=(\d+)/);
    const tokenMatch = str.match(/CLAUDISH_BRIDGE_TOKEN=(\w+)/);
    if (portMatch) port = portMatch[1];
    if (tokenMatch) token = tokenMatch[1];
  };

  bridge.stdout.on("data", handleOutput);
  bridge.stderr.on("data", handleOutput);

  // Wait for startup
  await setTimeout(3000);

  if (!port || !token) {
    console.error("\n[ERROR] Failed to get port/token");
    bridge.kill();
    process.exit(1);
  }

  console.log(`\n[2] Bridge ready on port ${port}`);

  // Enable proxy
  console.log("[3] Enabling HTTPS proxy...");
  try {
    const enableRes = await fetch(`http://127.0.0.1:${port}/proxy/enable`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        routing: {
          enabled: true,
          targetUrl: "https://openrouter.ai/api/v1/chat/completions",
          modelMap: {
            "claude-sonnet-4-20250514": "anthropic/claude-sonnet-4",
          },
        },
      }),
    });
    const data = await enableRes.json();
    console.log("   Proxy enabled:", JSON.stringify(data));
  } catch (err) {
    console.error("   Failed to enable proxy:", err);
    bridge.kill();
    process.exit(1);
  }

  await setTimeout(2000);

  // Check CycleTLS
  if (output.includes("CycleTLS client initialized")) {
    console.log("[4] ✓ CycleTLS initialized");
  } else {
    console.log("[4] ✗ CycleTLS NOT initialized");
  }

  // Configure system proxy
  console.log("[5] Configuring system proxy...");
  const { execSync } = await import("child_process");
  const pacUrl = `http://127.0.0.1:${port}/proxy.pac`;

  try {
    execSync(`networksetup -setautoproxyurl "Wi-Fi" "${pacUrl}"`, { stdio: "inherit" });
    execSync(`networksetup -setautoproxystate "Wi-Fi" on`, { stdio: "inherit" });
    console.log("   System proxy configured with PAC:", pacUrl);
  } catch (err) {
    console.error("   Failed to configure system proxy:", err);
  }

  // Wait for traffic
  console.log("\n[6] Waiting 30s for Claude Desktop traffic...");
  console.log("    Send a message in Claude Desktop now!\n");

  await setTimeout(30000);

  // Analyze
  console.log("\n==== Analysis ====");
  const connectCount = (output.match(/CONNECT request/g) || []).length;
  const cycleTLS200 = (output.match(/CycleTLS response: 200/g) || []).length;
  const completions = (output.match(/completion/gi) || []).length;
  const errors403 = (output.match(/403/g) || []).length;

  console.log(`CONNECT requests:    ${connectCount}`);
  console.log(`CycleTLS 200 OK:     ${cycleTLS200}`);
  console.log(`Completion matches:  ${completions}`);
  console.log(`403 errors:          ${errors403}`);

  if (cycleTLS200 > 0 && errors403 ==== 0) {
    console.log("\n✓ CycleTLS Cloudflare bypass: WORKING");
  } else if (connectCount ==== 0) {
    console.log("\n○ No traffic captured - is Claude Desktop using the proxy?");
  } else {
    console.log("\n✗ Issues detected");
  }

  // Cleanup
  console.log("\n[7] Cleaning up...");
  try {
    execSync(`networksetup -setautoproxystate "Wi-Fi" off`, { stdio: "inherit" });
  } catch {}

  bridge.kill();
  console.log("Done.");
}

main().catch(console.error);
