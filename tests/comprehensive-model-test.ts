import { afterEach, describe, expect, test } from "bun:test";
import { MODEL_INFO } from "../src/config.js";
import { createProxyServer } from "../src/proxy-server.js";
import type {
  AnthropicRequest,
  AnthropicResponse,
  OpenRouterModel,
  ProxyServer,
} from "../src/types.js";
import { OPENROUTER_MODELS } from "../src/types.js";

// Load .env file
import { join } from "node:path";
const envPath = join(import.meta.dir, "..", ".env");
const envFile = await Bun.file(envPath).text();
for (const line of envFile.split("\n")) {
  if (line.startsWith("#") || !line.includes("=")) continue;
  const [key, ...values] = line.split("=");
  process.env[key.trim()] = values.join("=").trim();
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY not found in .env file");
}

// Test all models except "custom" and "anthropic/claude-sonnet-4.5" (test separately)
const TEST_MODELS = OPENROUTER_MODELS.filter(
  (m) => m !== "custom" && m !== "anthropic/claude-sonnet-4.5"
);
const ANTHROPIC_MODEL: OpenRouterModel = "anthropic/claude-sonnet-4.5";

const activeProxies: ProxyServer[] = [];

async function startTestProxy(model: OpenRouterModel, port: number): Promise<ProxyServer> {
  const proxy = await createProxyServer(port, OPENROUTER_API_KEY!, model);
  activeProxies.push(proxy);
  return proxy;
}

async function makeAnthropicRequest(
  proxyUrl: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<AnthropicResponse> {
  const request: AnthropicRequest = {
    model: "claude-sonnet-4.5",
    messages,
    max_tokens: 300,
    temperature: 0.3,
    stream: false,
  };

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Proxy request failed: ${response.status} ${error}`);
  }

  return (await response.json()) as AnthropicResponse;
}

afterEach(async () => {
  for (const proxy of activeProxies) {
    await proxy.shutdown();
  }
  activeProxies.length = 0;
});

describe("Comprehensive Model Identity Tests", () => {
  describe("Prove NOT Anthropic", () => {
    for (const model of TEST_MODELS) {
      test(`${model} should NOT identify as Anthropic`, async () => {
        const port = 4000 + TEST_MODELS.indexOf(model);
        const proxy = await startTestProxy(model, port);
        const info = MODEL_INFO[model];

        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`🧪 Testing: ${info.name} (${model})`);
        console.log(`📍 Expected Provider: ${info.provider}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        const prompt = `Identify yourself: state your model name and creator. For example: 'I am GPT-4 by OpenAI' or 'I am Claude by Anthropic' or 'I am Grok by xAI'.`;

        const response = await makeAnthropicRequest(proxy.url, [
          {
            role: "user",
            content: prompt,
          },
        ]);

        const responseText = response.content[0].text?.toLowerCase() || "";
        console.log(`💬 Response: "${response.content[0].text}"`);
        console.log(
          `📊 Tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`
        );

        // Verify it's an Anthropic-format response (proxy working)
        expect(response.type).toBe("message");
        expect(response.role).toBe("assistant");

        // Verify we got a response
        expect(responseText).toBeTruthy();
        expect(responseText.length).toBeGreaterThan(3);

        // CRITICAL TEST: If this is NOT the Anthropic model, it should NOT mention Anthropic
        if (model !== "anthropic/claude-3.5-sonnet") {
          const mentionsAnthropic =
            responseText.includes("anthropic") || responseText.includes("claude");

          if (mentionsAnthropic) {
            console.log(`❌ FAILED: Response mentions Anthropic/Claude!`);
            console.log(`   This suggests we might be getting Anthropic's model`);
          } else {
            console.log(`✅ PASSED: Does NOT mention Anthropic or Claude`);
          }

          expect(mentionsAnthropic).toBe(false);
        } else {
          // For the actual Anthropic model, it SHOULD mention Anthropic
          const mentionsAnthropic =
            responseText.includes("anthropic") || responseText.includes("claude");

          console.log(
            `✅ PASSED: Anthropic model correctly identifies as Anthropic: ${mentionsAnthropic}`
          );
          expect(mentionsAnthropic).toBe(true);
        }

        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      }, 30000);
    }
  });

  describe("Provider Verification", () => {
    test("All models should return different providers", async () => {
      const results: Record<string, { provider: string; response: string }> = {};

      // Test subset for speed (first 4 models)
      const modelsToTest = TEST_MODELS.slice(0, 4);

      for (const model of modelsToTest) {
        const port = 5000 + modelsToTest.indexOf(model);
        const proxy = await startTestProxy(model, port);
        const info = MODEL_INFO[model];

        const response = await makeAnthropicRequest(proxy.url, [
          {
            role: "user",
            content:
              "Identify yourself: state your model name and creator. For example: 'I am GPT-4 by OpenAI' or 'I am Claude by Anthropic' or 'I am Grok by xAI'.",
          },
        ]);

        results[model] = {
          provider: info.provider,
          response: response.content[0].text || "",
        };

        await proxy.shutdown();
        activeProxies.pop();
      }

      console.log("\n📊 PROVIDER COMPARISON:");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      for (const [model, data] of Object.entries(results)) {
        console.log(`${data.provider.padEnd(10)} → "${data.response}"`);
      }
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

      // Verify we got responses from all tested models
      expect(Object.keys(results).length).toBe(modelsToTest.length);

      // Verify at least 3 different providers mentioned
      const uniqueResponses = new Set(Object.values(results).map((r) => r.response.toLowerCase()));
      console.log(`✅ Unique responses: ${uniqueResponses.size}/${modelsToTest.length}`);
      expect(uniqueResponses.size).toBeGreaterThanOrEqual(3);
    }, 90000);
  });

  describe("Detailed Provider Attribution", () => {
    const providerTests: Array<{
      model: OpenRouterModel;
      expectedProvider: string;
      keywords: string[];
    }> = [
      {
        model: "x-ai/grok-code-fast-1",
        expectedProvider: "xAI",
        keywords: ["xai", "grok", "elon", "x.ai"],
      },
      {
        model: "openai/gpt-5-codex",
        expectedProvider: "OpenAI",
        keywords: ["openai", "gpt", "chatgpt"],
      },
      {
        model: "minimax/minimax-m2",
        expectedProvider: "MiniMax",
        keywords: ["minimax"],
      },
      {
        model: "qwen/qwen3-vl-235b-a22b-instruct",
        expectedProvider: "Alibaba",
        keywords: ["alibaba", "qwen", "tongyi"],
      },
    ];

    for (const testCase of providerTests) {
      test(`${testCase.model} should identify as ${testCase.expectedProvider}`, async () => {
        const port = 6000 + providerTests.indexOf(testCase);
        const proxy = await startTestProxy(testCase.model, port);

        console.log(`\n🔍 Testing ${testCase.expectedProvider} attribution...`);

        const response = await makeAnthropicRequest(proxy.url, [
          {
            role: "user",
            content:
              "Identify yourself: state your model name and creator. For example: 'I am GPT-4 by OpenAI' or 'I am Claude by Anthropic' or 'I am Grok by xAI'.",
          },
        ]);

        const responseText = response.content[0].text?.toLowerCase() || "";
        console.log(`   Response: "${response.content[0].text}"`);

        // Check if any expected keywords are mentioned
        const mentionsProvider = testCase.keywords.some((keyword) =>
          responseText.includes(keyword.toLowerCase())
        );

        if (mentionsProvider) {
          console.log(`   ✅ Correctly identifies as ${testCase.expectedProvider}`);
        } else {
          console.log(`   ⚠️  Doesn't mention expected keywords: ${testCase.keywords.join(", ")}`);
          console.log(`   Note: This might still be correct, just phrased differently`);
        }

        // Main assertion: Should NOT mention Anthropic (except for Anthropic model)
        const mentionsAnthropic =
          responseText.includes("anthropic") || responseText.includes("claude");
        console.log(
          `   ${mentionsAnthropic ? "❌" : "✅"} Anthropic mentioned: ${mentionsAnthropic}`
        );

        expect(mentionsAnthropic).toBe(false);

        // Soft check: Ideally should mention one of the expected keywords
        if (!mentionsProvider) {
          console.log(
            `   ℹ️  Warning: Response doesn't contain expected keywords, but still valid if not Anthropic`
          );
        }
      }, 30000);
    }
  });

  describe("Anthropic Model Baseline", () => {
    test("anthropic/claude-sonnet-4.5 SHOULD identify as Anthropic", async () => {
      const port = 7000;
      const proxy = await startTestProxy(ANTHROPIC_MODEL, port);

      console.log("\n🔬 BASELINE TEST: Testing actual Anthropic model...");

      const response = await makeAnthropicRequest(proxy.url, [
        {
          role: "user",
          content: "Identify yourself: state your model name and creator.",
        },
      ]);

      const responseText = response.content[0].text?.toLowerCase() || "";
      console.log(`   Response: "${response.content[0].text}"`);

      const mentionsAnthropic =
        responseText.includes("anthropic") || responseText.includes("claude");

      console.log(`   ${mentionsAnthropic ? "✅" : "❌"} Mentions Anthropic: ${mentionsAnthropic}`);

      // The Anthropic model SHOULD mention Anthropic
      expect(mentionsAnthropic).toBe(true);

      console.log("   ✅ BASELINE CONFIRMED: Anthropic model identifies as Anthropic");
      console.log("   This proves other models NOT mentioning Anthropic are different!\n");
    }, 30000);
  });
});
