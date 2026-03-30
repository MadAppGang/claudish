#!/usr/bin/env bun
/**
 * Direct API Connectivity Diagnostic
 *
 * Run with: bun run tests/direct-api-diagnostic.ts
 *
 * Tests connectivity to direct API endpoints (Gemini, OpenAI)
 * and provides detailed diagnostic information.
 */

interface DiagnosticResult {
  provider: string;
  endpoint: string;
  dnsResolved: boolean;
  tcpConnected: boolean;
  tlsHandshake: boolean;
  apiResponded: boolean;
  latencyMs: number;
  error?: string;
}

async function testDns(hostname: string): Promise<{ resolved: boolean; addresses?: string[]; error?: string }> {
  try {
    const { resolve } = await import("node:dns/promises");
    const addresses = await resolve(hostname, "A");
    return { resolved: true, addresses };
  } catch (e: any) {
    return { resolved: false, error: e.message };
  }
}

async function testHttps(url: string, headers?: Record<string, string>): Promise<{
  success: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return {
      success: true,
      status: response.status,
      latencyMs: Date.now() - start,
    };
  } catch (e: any) {
    clearTimeout(timeoutId);
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: e.cause?.code || e.message,
    };
  }
}

async function testGeminiApi(): Promise<DiagnosticResult> {
  const hostname = "generativelanguage.googleapis.com";
  const endpoint = `https://${hostname}/v1beta/models`;
  const apiKey = process.env.GEMINI_API_KEY;

  console.log("\n🟢 Gemini API Diagnostic");
  console.log("=========================");

  // Test DNS
  console.log(`\n1. DNS Resolution for ${hostname}...`);
  const dnsResult = await testDns(hostname);
  if (dnsResult.resolved) {
    console.log(`   ✅ Resolved to: ${dnsResult.addresses?.join(", ")}`);
  } else {
    console.log(`   ❌ DNS failed: ${dnsResult.error}`);
    return {
      provider: "gemini",
      endpoint,
      dnsResolved: false,
      tcpConnected: false,
      tlsHandshake: false,
      apiResponded: false,
      latencyMs: 0,
      error: `DNS resolution failed: ${dnsResult.error}`,
    };
  }

  // Test HTTPS connection
  console.log(`\n2. HTTPS Connection to ${endpoint}...`);
  const httpsResult = await testHttps(endpoint, {
    "x-goog-api-key": apiKey || "test-key",
  });

  if (httpsResult.success) {
    console.log(`   ✅ Connected! Status: ${httpsResult.status}, Latency: ${httpsResult.latencyMs}ms`);
  } else {
    console.log(`   ❌ Connection failed: ${httpsResult.error}`);
    return {
      provider: "gemini",
      endpoint,
      dnsResolved: true,
      tcpConnected: false,
      tlsHandshake: false,
      apiResponded: false,
      latencyMs: httpsResult.latencyMs,
      error: httpsResult.error,
    };
  }

  // Test API key
  console.log("\n3. API Key Validation...");
  if (!apiKey) {
    console.log("   ⚠️  GEMINI_API_KEY not set - cannot test API authentication");
    return {
      provider: "gemini",
      endpoint,
      dnsResolved: true,
      tcpConnected: true,
      tlsHandshake: true,
      apiResponded: true,
      latencyMs: httpsResult.latencyMs,
      error: "API key not configured",
    };
  }

  // Test actual API call
  console.log("\n4. Testing API Call...");
  const apiStart = Date.now();
  try {
    const response = await fetch(
      `https://${hostname}/v1beta/models/gemini-2.0-flash:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          generationConfig: { maxOutputTokens: 10 },
        }),
      }
    );

    const apiLatency = Date.now() - apiStart;

    if (response.ok) {
      console.log(`   ✅ API call successful! Latency: ${apiLatency}ms`);
      return {
        provider: "gemini",
        endpoint,
        dnsResolved: true,
        tcpConnected: true,
        tlsHandshake: true,
        apiResponded: true,
        latencyMs: apiLatency,
      };
    } else {
      const errorText = await response.text();
      console.log(`   ❌ API error: ${response.status} - ${errorText.slice(0, 200)}`);
      return {
        provider: "gemini",
        endpoint,
        dnsResolved: true,
        tcpConnected: true,
        tlsHandshake: true,
        apiResponded: false,
        latencyMs: apiLatency,
        error: `API returned ${response.status}`,
      };
    }
  } catch (e: any) {
    console.log(`   ❌ API call failed: ${e.message}`);
    return {
      provider: "gemini",
      endpoint,
      dnsResolved: true,
      tcpConnected: true,
      tlsHandshake: true,
      apiResponded: false,
      latencyMs: Date.now() - apiStart,
      error: e.message,
    };
  }
}

async function testOpenAIApi(): Promise<DiagnosticResult> {
  const hostname = "api.openai.com";
  const endpoint = `https://${hostname}/v1/models`;
  const apiKey = process.env.OPENAI_API_KEY;

  console.log("\n🔵 OpenAI API Diagnostic");
  console.log("=========================");

  // Test DNS
  console.log(`\n1. DNS Resolution for ${hostname}...`);
  const dnsResult = await testDns(hostname);
  if (dnsResult.resolved) {
    console.log(`   ✅ Resolved to: ${dnsResult.addresses?.slice(0, 3).join(", ")}...`);
  } else {
    console.log(`   ❌ DNS failed: ${dnsResult.error}`);
    return {
      provider: "openai",
      endpoint,
      dnsResolved: false,
      tcpConnected: false,
      tlsHandshake: false,
      apiResponded: false,
      latencyMs: 0,
      error: `DNS resolution failed: ${dnsResult.error}`,
    };
  }

  // Test HTTPS connection
  console.log(`\n2. HTTPS Connection to ${endpoint}...`);
  const httpsResult = await testHttps(endpoint, {
    Authorization: `Bearer ${apiKey || "test-key"}`,
  });

  if (httpsResult.success) {
    console.log(`   ✅ Connected! Status: ${httpsResult.status}, Latency: ${httpsResult.latencyMs}ms`);
  } else {
    console.log(`   ❌ Connection failed: ${httpsResult.error}`);
    return {
      provider: "openai",
      endpoint,
      dnsResolved: true,
      tcpConnected: false,
      tlsHandshake: false,
      apiResponded: false,
      latencyMs: httpsResult.latencyMs,
      error: httpsResult.error,
    };
  }

  // Test API key
  console.log("\n3. API Key Validation...");
  if (!apiKey) {
    console.log("   ⚠️  OPENAI_API_KEY not set - cannot test API authentication");
    return {
      provider: "openai",
      endpoint,
      dnsResolved: true,
      tcpConnected: true,
      tlsHandshake: true,
      apiResponded: true,
      latencyMs: httpsResult.latencyMs,
      error: "API key not configured",
    };
  }

  // Test actual API call
  console.log("\n4. Testing API Call...");
  const apiStart = Date.now();
  try {
    const response = await fetch(`https://${hostname}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 10,
      }),
    });

    const apiLatency = Date.now() - apiStart;

    if (response.ok) {
      console.log(`   ✅ API call successful! Latency: ${apiLatency}ms`);
      return {
        provider: "openai",
        endpoint,
        dnsResolved: true,
        tcpConnected: true,
        tlsHandshake: true,
        apiResponded: true,
        latencyMs: apiLatency,
      };
    } else {
      const errorText = await response.text();
      console.log(`   ❌ API error: ${response.status} - ${errorText.slice(0, 200)}`);
      return {
        provider: "openai",
        endpoint,
        dnsResolved: true,
        tcpConnected: true,
        tlsHandshake: true,
        apiResponded: false,
        latencyMs: apiLatency,
        error: `API returned ${response.status}`,
      };
    }
  } catch (e: any) {
    console.log(`   ❌ API call failed: ${e.message}`);
    return {
      provider: "openai",
      endpoint,
      dnsResolved: true,
      tcpConnected: true,
      tlsHandshake: true,
      apiResponded: false,
      latencyMs: Date.now() - apiStart,
      error: e.message,
    };
  }
}

async function main() {
  console.log("🔍 Direct API Connectivity Diagnostic");
  console.log("======================================");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Node: ${process.version}`);

  // Environment check
  console.log("\n📋 Environment Variables:");
  console.log(`   GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? "✅ Set" : "❌ Not set"}`);
  console.log(`   OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "✅ Set" : "❌ Not set"}`);
  console.log(`   HTTP_PROXY: ${process.env.HTTP_PROXY || process.env.http_proxy || "Not set"}`);
  console.log(`   HTTPS_PROXY: ${process.env.HTTPS_PROXY || process.env.https_proxy || "Not set"}`);

  const results: DiagnosticResult[] = [];

  // Test Gemini
  results.push(await testGeminiApi());

  // Test OpenAI
  results.push(await testOpenAIApi());

  // Summary
  console.log("\n======================================");
  console.log("📊 Diagnostic Summary:");
  console.log("======================================\n");

  for (const result of results) {
    const status = result.apiResponded ? "✅ Working" : "❌ Failed";
    console.log(`${result.provider.toUpperCase()}: ${status}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
    if (result.apiResponded) {
      console.log(`   Latency: ${result.latencyMs}ms`);
    }
    console.log();
  }

  // Recommendations
  const failedProviders = results.filter((r) => !r.apiResponded);
  if (failedProviders.length > 0) {
    console.log("💡 Recommendations:");
    for (const failed of failedProviders) {
      if (!failed.dnsResolved) {
        console.log(`   - Check DNS settings for ${failed.endpoint}`);
      } else if (!failed.tcpConnected) {
        console.log(`   - Check firewall/VPN settings blocking ${failed.endpoint}`);
      } else if (failed.error?.includes("API key")) {
        console.log(`   - Set ${failed.provider.toUpperCase()}_API_KEY environment variable`);
      }
    }
  }

  process.exit(failedProviders.length > 0 ? 1 : 0);
}

main().catch(console.error);
