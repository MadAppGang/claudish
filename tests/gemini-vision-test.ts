#!/usr/bin/env bun
/**
 * Test Gemini vision (sending images to Gemini)
 */

import { createProxyServer } from "../src/proxy-server";

const testPort = 9997;

// Fetch the Google logo for testing
async function getGoogleLogo(): Promise<string> {
  const response = await fetch("https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png");
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log("❌ GEMINI_API_KEY not set");
    process.exit(1);
  }

  console.log("🚀 Testing Gemini Vision (Image Input)");
  console.log("======================================\n");

  const proxy = await createProxyServer(testPort, undefined, undefined, false, undefined, undefined, {});
  console.log(`✅ Proxy server running on port ${testPort}\n`);

  try {
    console.log("🖼️  Fetching Google logo...");
    const googleLogo = await getGoogleLogo();
    console.log(`   Got ${googleLogo.length} bytes of base64 data`);

    console.log("🖼️  Sending request with image...");

    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "g/gemini-2.0-flash",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: googleLogo
                }
              },
              {
                type: "text",
                text: "What company logo is this? Answer in one word."
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ Error: ${response.status}`);
      try {
        const parsed = JSON.parse(error);
        console.log(`   Message: ${parsed.error?.message || parsed.error || error}`);
      } catch {
        console.log(`   ${error.substring(0, 500)}`);
      }
      await proxy.shutdown();
      process.exit(1);
    }

    // Read streaming response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let textContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.delta?.text) {
              textContent += parsed.delta.text;
            }
          } catch {}
        }
      }
    }

    console.log("");
    if (textContent) {
      console.log(`✅ Gemini Vision Response: "${textContent.trim()}"`);

      // Check if it recognized Google
      if (textContent.toLowerCase().includes("google")) {
        console.log(`✅ Correctly identified the Google logo!`);
      }
    } else {
      console.log(`❌ No text response received`);
    }

  } finally {
    console.log("\n🧹 Shutting down...");
    await proxy.shutdown();
  }
}

main().catch(console.error);
