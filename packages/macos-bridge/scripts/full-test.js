#!/usr/bin/env node
/**
 * Full Claude Desktop interception test
 * - Starts bridge
 * - Configures system proxy
 * - Restarts Claude Desktop (to pick up proxy)
 * - Sends test message via AppleScript
 * - Monitors for interception
 */

import { spawn, execSync } from "child_process";
import { setTimeout } from "timers/promises";

const BRIDGE_DIR = new URL("..", import.meta.url).pathname;

function runAppleScript(script) {
  try {
    return execSync(`osascript -e '${script}'`, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       Full Claude Desktop Interception Test                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Step 1: Cleanup
  console.log("[1] Cleaning up...");
  try {
    execSync("pkill -9 -f 'macos-bridge/dist'", { stdio: "ignore" });
  } catch {}
  try {
    execSync("rm -f ~/.claudish-proxy/bridge.pid", { stdio: "ignore" });
  } catch {}
  try {
    execSync('networksetup -setautoproxystate "Wi-Fi" off', { stdio: "ignore" });
  } catch {}
  await setTimeout(2000);
  console.log("   Done\n");

  // Step 2: Start bridge
  console.log("[2] Starting bridge...");
  const bridge = spawn("node", ["dist/index.js"], {
    cwd: BRIDGE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let port = "";
  let token = "";
  let output = "";

  const handleOutput = (data) => {
    const str = data.toString();
    output += str;

    // Only print key lines
    if (str.includes("CLAUDISH_BRIDGE_PORT") ||
        str.includes("CycleTLS") ||
        str.includes("CONNECT") ||
        str.includes("completion") ||
        str.includes("403") ||
        str.includes("200")) {
      process.stdout.write("   " + str);
    }

    const portMatch = str.match(/CLAUDISH_BRIDGE_PORT=(\d+)/);
    const tokenMatch = str.match(/CLAUDISH_BRIDGE_TOKEN=(\w+)/);
    if (portMatch) port = portMatch[1];
    if (tokenMatch) token = tokenMatch[1];
  };

  bridge.stdout.on("data", handleOutput);
  bridge.stderr.on("data", handleOutput);

  await setTimeout(3000);

  if (!port || !token) {
    console.error("\n   ✗ Failed to start bridge");
    console.error("   Output:", output);
    bridge.kill();
    process.exit(1);
  }

  console.log(`   ✓ Bridge running on port ${port}\n`);

  // Step 3: Enable proxy
  console.log("[3] Enabling HTTPS proxy...");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/proxy/enable`, {
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
    const data = await res.json();
    console.log(`   ✓ HTTPS proxy on port ${data.data?.httpsProxyPort}\n`);
  } catch (err) {
    console.error("   ✗ Failed:", err.message);
    bridge.kill();
    process.exit(1);
  }

  await setTimeout(2000);

  // Step 4: Configure system proxy
  console.log("[4] Configuring system proxy...");
  const pacUrl = `http://127.0.0.1:${port}/proxy.pac`;
  try {
    execSync(`networksetup -setautoproxyurl "Wi-Fi" "${pacUrl}"`, { stdio: "inherit" });
    execSync('networksetup -setautoproxystate "Wi-Fi" on', { stdio: "inherit" });
    console.log(`   ✓ PAC URL: ${pacUrl}\n`);
  } catch (err) {
    console.error("   ✗ Failed to configure system proxy");
  }

  // Step 5: Restart Claude Desktop
  console.log("[5] Restarting Claude Desktop (to pick up proxy)...");

  // Quit Claude
  runAppleScript('tell application "Claude" to quit');
  await setTimeout(2000);

  // Launch Claude
  runAppleScript('tell application "Claude" to activate');
  await setTimeout(5000);

  console.log("   ✓ Claude Desktop restarted\n");

  // Step 6: Send test message
  console.log("[6] Sending test message via AppleScript...");

  const testMessage = "Say hello";

  const script = `
    tell application "Claude"
      activate
      delay 1
    end tell

    tell application "System Events"
      tell process "Claude"
        set frontmost to true
        delay 0.5

        -- New chat
        keystroke "n" using command down
        delay 2

        -- Type message
        keystroke "${testMessage}"
        delay 0.3

        -- Send
        keystroke return
      end tell
    end tell
  `;

  try {
    execSync(`osascript -e '${script}'`, { stdio: "inherit" });
    console.log("   ✓ Message sent\n");
  } catch (err) {
    console.log("   ○ AppleScript may have had issues (continuing anyway)\n");
  }

  // Step 7: Wait and monitor
  console.log("[7] Monitoring traffic for 25 seconds...");
  console.log("─────────────────────────────────────────────────────────────────");

  await setTimeout(25000);

  console.log("─────────────────────────────────────────────────────────────────\n");

  // Step 8: Analyze results
  console.log("[8] Analysis:");
  const connectCount = (output.match(/CONNECT request/g) || []).length;
  const cycleTLS200 = (output.match(/CycleTLS response: 200/g) || []).length;
  const completions = (output.match(/\/completion/gi) || []).length;
  const errors403 = (output.match(/\b403\b/g) || []).length;
  const bootstrap = (output.match(/bootstrap/gi) || []).length;

  console.log(`   CONNECT requests:    ${connectCount}`);
  console.log(`   Bootstrap requests:  ${bootstrap}`);
  console.log(`   CycleTLS 200 OK:     ${cycleTLS200}`);
  console.log(`   Completion requests: ${completions}`);
  console.log(`   403 errors:          ${errors403}`);

  console.log("\n[9] Verdict:");
  if (cycleTLS200 > 0) {
    console.log("   ✓ CycleTLS Cloudflare bypass: WORKING");
  } else if (connectCount > 0) {
    console.log("   ○ Traffic captured but CycleTLS may not have been used");
  } else {
    console.log("   ○ No traffic captured - proxy may not be active");
  }

  if (errors403 ==== 0 && connectCount > 0) {
    console.log("   ✓ No 403 Cloudflare blocks");
  } else if (errors403 > 0) {
    console.log("   ✗ Got 403 errors - Cloudflare blocked some requests");
  }

  if (completions > 0) {
    console.log("   ✓ Completion requests detected - interception working!");
  }

  // Cleanup
  console.log("\n[10] Cleaning up...");
  try {
    execSync('networksetup -setautoproxystate "Wi-Fi" off', { stdio: "ignore" });
  } catch {}
  bridge.kill();

  console.log("   Done.\n");
}

main().catch(console.error);
