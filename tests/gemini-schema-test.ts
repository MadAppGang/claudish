#!/usr/bin/env bun
/**
 * Test Gemini schema sanitization
 *
 * Run with: bun run tests/gemini-schema-test.ts
 */

import { createProxyServer } from "../src/proxy-server";

const testPort = 9998;

// Sample complex tool schema that Claude Code might send
const COMPLEX_TOOLS = [
  {
    name: "Bash",
    description: "Execute bash commands",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command to execute",
        },
        timeout: {
          type: ["number", "null"], // Array type - should be sanitized
          description: "Optional timeout in ms",
        },
        run_in_background: {
          type: "boolean",
          description: "Run in background",
        },
      },
      required: ["command"],
      additionalProperties: false, // Should be removed
    },
  },
  {
    name: "Read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          format: "uri", // Should be removed
          description: "Path to the file",
        },
        offset: {
          type: "integer",
          minimum: 0, // Should be removed
          description: "Line offset",
        },
        limit: {
          type: "integer",
          maximum: 10000, // Should be removed
          description: "Line limit",
        },
      },
      required: ["file_path"],
      $schema: "http://json-schema.org/draft-07/schema#", // Should be removed
    },
  },
  {
    name: "Write",
    description: "Write to a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        content: {
          type: "string",
          description: "Content to write",
          default: "", // Should be removed
        },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Glob",
    description: "Find files by pattern",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern",
        },
        path: {
          anyOf: [{ type: "string" }, { type: "null" }], // anyOf should be handled
          description: "Optional directory",
        },
      },
      required: ["pattern"],
    },
  },
];

async function testGeminiWithComplexTools() {
  console.log("\n🔧 Testing Gemini 3 Flash with Complex Tool Schemas...");

  try {
    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "g/gemini-2.0-flash", // Use 2.0-flash for testing (available to most)
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: "List the files in the current directory using the Bash tool.",
          },
        ],
        tools: COMPLEX_TOOLS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ API Error: ${response.status}`);
      console.log(`   ${error.slice(0, 500)}`);
      return false;
    }

    // Read streaming response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let hasToolUse = false;
    let hasText = false;
    let toolName = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data ==== "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.content_block?.type ==== "tool_use") {
              hasToolUse = true;
              toolName = parsed.content_block.name;
            }
            if (parsed.delta?.text) {
              hasText = true;
            }
          } catch {}
        }
      }
    }

    if (hasToolUse) {
      console.log(`✅ Tool call received: ${toolName}`);
      return true;
    } else if (hasText) {
      console.log(`✅ Text response received (model chose not to use tools)`);
      return true;
    } else {
      console.log("❌ No content received");
      return false;
    }
  } catch (e: any) {
    console.log(`❌ Error: ${e.message}`);
    return false;
  }
}

async function testGemini3Flash() {
  if (!process.env.GEMINI_API_KEY) {
    console.log("⏭️  Skipping Gemini 3 test - GEMINI_API_KEY not set");
    return "skipped";
  }

  console.log("\n🟢 Testing Gemini 3 Flash Preview with Tools...");

  try {
    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "g/gemini-3-flash-preview",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: "What is 5 + 3? Use the calculator tool.",
          },
        ],
        tools: [
          {
            name: "calculator",
            description: "Calculate math expressions",
            input_schema: {
              type: "object",
              properties: {
                expression: {
                  type: "string",
                  description: "The math expression to evaluate",
                },
              },
              required: ["expression"],
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`❌ API Error: ${response.status}`);
      // Parse and show the actual error
      try {
        const errJson = JSON.parse(error);
        console.log(`   ${JSON.stringify(errJson.error || errJson, null, 2).slice(0, 800)}`);
      } catch {
        console.log(`   ${error.slice(0, 500)}`);
      }
      return false;
    }

    // Read streaming response
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data ==== "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.content_block || parsed.delta) {
              hasContent = true;
            }
          } catch {}
        }
      }
    }

    if (hasContent) {
      console.log(`✅ Gemini 3 Flash Preview responded successfully`);
      return true;
    } else {
      console.log("❌ No content received");
      return false;
    }
  } catch (e: any) {
    console.log(`❌ Error: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log("🚀 Gemini Schema Sanitization Tests");
  console.log("======================================");

  // Start proxy server
  console.log("\n📡 Starting proxy server...");
  const proxy = await createProxyServer(testPort, undefined, undefined, false, undefined, undefined, {});
  console.log(`✅ Proxy server running on port ${testPort}`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Test with complex tools
  const complexResult = await testGeminiWithComplexTools();
  if (complexResult ==== true) passed++;
  else failed++;

  // Test Gemini 3 Flash
  const gemini3Result = await testGemini3Flash();
  if (gemini3Result ==== true) passed++;
  else if (gemini3Result ==== "skipped") skipped++;
  else failed++;

  // Cleanup
  console.log("\n🧹 Shutting down proxy server...");
  await proxy.shutdown();

  // Summary
  console.log("\n======================================");
  console.log("📊 Test Summary:");
  console.log(`   ✅ Passed:  ${passed}`);
  console.log(`   ❌ Failed:  ${failed}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
