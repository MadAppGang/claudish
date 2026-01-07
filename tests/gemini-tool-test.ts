#!/usr/bin/env bun
/**
 * Test Gemini tool calling specifically
 */

import { createProxyServer } from "../src/proxy-server";

const testPort = 9998;

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.log("❌ GEMINI_API_KEY not set");
    process.exit(1);
  }

  console.log("🚀 Testing Gemini Tool Calling");
  console.log("==============================\n");

  const proxy = await createProxyServer(testPort, undefined, undefined, false, undefined, undefined, {});
  console.log(`✅ Proxy server running on port ${testPort}\n`);

  try {
    console.log("🔧 Sending request with calculator tool...");

    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "g/gemini-2.0-flash",
        max_tokens: 200,
        messages: [
          { role: "user", content: "Calculate 15 + 27 using the calculator tool. You must use the tool." }
        ],
        tools: [
          {
            name: "calculator",
            description: "A calculator that adds two numbers together",
            input_schema: {
              type: "object",
              properties: {
                a: { type: "number", description: "First number to add" },
                b: { type: "number", description: "Second number to add" }
              },
              required: ["a", "b"]
            }
          }
        ],
        tool_choice: { type: "tool", name: "calculator" }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ Error: ${response.status} - ${error}`);
      await proxy.shutdown();
      process.exit(1);
    }

    // Read streaming response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let hasToolUse = false;
    let toolName = "";
    let toolArgs = "";
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

            // Check for tool_use block start
            if (parsed.content_block?.type === "tool_use") {
              hasToolUse = true;
              toolName = parsed.content_block.name;
              console.log(`   📦 Tool block started: ${toolName}`);
            }

            // Check for tool arguments
            if (parsed.delta?.type === "input_json_delta") {
              toolArgs += parsed.delta.partial_json || "";
            }

            // Check for text
            if (parsed.delta?.text) {
              textContent += parsed.delta.text;
            }
          } catch {}
        }
      }
    }

    console.log("");
    if (hasToolUse) {
      console.log(`✅ Tool Call Received!`);
      console.log(`   Tool: ${toolName}`);
      console.log(`   Args: ${toolArgs}`);
    } else if (textContent) {
      console.log(`⚠️  Got text response instead of tool call:`);
      console.log(`   "${textContent.trim()}"`);
    } else {
      console.log(`❌ No tool call or text received`);
    }

  } finally {
    console.log("\n🧹 Shutting down...");
    await proxy.shutdown();
  }
}

main().catch(console.error);
