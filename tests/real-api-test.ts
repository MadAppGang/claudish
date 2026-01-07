#!/usr/bin/env bun
/**
 * Real API integration test for Gemini and OpenAI direct handlers
 *
 * Run with: bun run tests/real-api-test.ts
 */

import { createProxyServer } from "../src/proxy-server";

const testPort = 9999;

async function testOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("⏭️  Skipping OpenAI test - OPENAI_API_KEY not set");
    return false;
  }

  console.log("\n🔵 Testing OpenAI Direct API (oai/gpt-4o-mini)...");

  try {
    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "oai/gpt-4o-mini",
        max_tokens: 100,
        messages: [
          { role: "user", content: "Say 'Hello from OpenAI!' in exactly 5 words." }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ OpenAI Error: ${response.status} - ${error}`);
      return false;
    }

    // Read streaming response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let hasContent = false;

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
              fullText += parsed.delta.text;
              hasContent = true;
            }
          } catch {}
        }
      }
    }

    if (hasContent) {
      console.log(`✅ OpenAI Response: "${fullText.trim()}"`);
      return true;
    } else {
      console.log("❌ OpenAI: No content received in stream");
      return false;
    }
  } catch (e) {
    console.log(`❌ OpenAI Error: ${e}`);
    return false;
  }
}

async function testGemini() {
  if (!process.env.GEMINI_API_KEY) {
    console.log("⏭️  Skipping Gemini test - GEMINI_API_KEY not set");
    return false;
  }

  console.log("\n🟢 Testing Gemini Direct API (g/gemini-2.0-flash)...");

  try {
    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "g/gemini-2.0-flash",
        max_tokens: 100,
        messages: [
          { role: "user", content: "Say 'Hello from Gemini!' in exactly 5 words." }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ Gemini Error: ${response.status} - ${error}`);
      return false;
    }

    // Read streaming response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let hasContent = false;

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
              fullText += parsed.delta.text;
              hasContent = true;
            }
          } catch {}
        }
      }
    }

    if (hasContent) {
      console.log(`✅ Gemini Response: "${fullText.trim()}"`);
      return true;
    } else {
      console.log("❌ Gemini: No content received in stream");
      return false;
    }
  } catch (e) {
    console.log(`❌ Gemini Error: ${e}`);
    return false;
  }
}

async function testToolCall() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("⏭️  Skipping tool call test - OPENAI_API_KEY not set");
    return false;
  }

  console.log("\n🔧 Testing Tool Calling with OpenAI (oai/gpt-4o-mini)...");

  try {
    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "oai/gpt-4o-mini",
        max_tokens: 200,
        messages: [
          { role: "user", content: "What is 2 + 2? Use the calculator tool to compute this." }
        ],
        tools: [
          {
            name: "calculator",
            description: "A simple calculator that can add two numbers",
            input_schema: {
              type: "object",
              properties: {
                a: { type: "number", description: "First number" },
                b: { type: "number", description: "Second number" }
              },
              required: ["a", "b"]
            }
          }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ Tool Call Error: ${response.status} - ${error}`);
      return false;
    }

    // Read streaming response and look for tool_use
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let hasToolUse = false;
    let toolName = "";

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
            if (parsed.content_block?.type === "tool_use") {
              hasToolUse = true;
              toolName = parsed.content_block.name;
            }
          } catch {}
        }
      }
    }

    if (hasToolUse) {
      console.log(`✅ Tool Call Received: ${toolName}`);
      return true;
    } else {
      console.log("❌ Tool Call: No tool_use block received");
      return false;
    }
  } catch (e) {
    console.log(`❌ Tool Call Error: ${e}`);
    return false;
  }
}

async function main() {
  console.log("🚀 Starting Real API Integration Tests");
  console.log("=====================================");

  // Start proxy server
  console.log("\n📡 Starting proxy server...");
  const proxy = await createProxyServer(testPort, undefined, undefined, false, undefined, undefined, {});
  console.log(`✅ Proxy server running on port ${testPort}`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Test OpenAI
  const openaiResult = await testOpenAI();
  if (openaiResult === true) passed++;
  else if (openaiResult === false && !process.env.OPENAI_API_KEY) skipped++;
  else failed++;

  // Test Gemini
  const geminiResult = await testGemini();
  if (geminiResult === true) passed++;
  else if (geminiResult === false && !process.env.GEMINI_API_KEY) skipped++;
  else failed++;

  // Test Tool Calling
  const toolResult = await testToolCall();
  if (toolResult === true) passed++;
  else if (toolResult === false && !process.env.OPENAI_API_KEY) skipped++;
  else failed++;

  // Cleanup
  console.log("\n🧹 Shutting down proxy server...");
  await proxy.shutdown();

  // Summary
  console.log("\n=====================================");
  console.log("📊 Test Summary:");
  console.log(`   ✅ Passed:  ${passed}`);
  console.log(`   ❌ Failed:  ${failed}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
