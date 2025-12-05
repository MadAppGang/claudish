/**
 * Test to verify the EXACT models the user specified
 */

import { join } from "node:path";

// Load .env
const envPath = join(import.meta.dir, "..", ".env");
const envFile = await Bun.file(envPath).text();
for (const line of envFile.split("\n")) {
  if (line.startsWith("#") || !line.includes("=")) continue;
  const [key, ...values] = line.split("=");
  process.env[key.trim()] = values.join("=").trim();
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY not found");
}

// User's EXACT models from original request
const USER_SPECIFIED_MODELS = [
  "x-ai/grok-code-fast-1",
  "openai/gpt-5-codex",
  "minimax/minimax-m2",
  "zhipuai/glm-4", // User said "z-ai/glm-4.6" - trying correct prefix
  "qwen/qwen3-vl-235b-a22b-instruct",
];

console.log("\n🔍 VERIFYING USER-SPECIFIED MODELS");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

for (const model of USER_SPECIFIED_MODELS) {
  console.log(`Testing: ${model}`);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/MadAppGang/claude-code",
        "X-Title": "Claudish Model Verification",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "Say 'hi' in one word",
          },
        ],
        max_tokens: 10,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || "no response";
      console.log(`  ✅ VALID - Response: "${reply}"`);
    } else {
      const error = await response.text();
      console.log(`  ❌ INVALID - Error: ${error}`);

      // Try to suggest correct model ID
      if (error.includes("not a valid model")) {
        console.log("  💡 Suggestion: This model ID may be outdated");
      }
    }
  } catch (err) {
    console.log(`  ❌ ERROR: ${err}`);
  }

  console.log("");
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
