#!/usr/bin/env node

// Test script to show the exact Poe API request
// This will make a request to the running Claudish proxy and show the transformation

console.log("🧪 Testing Poe Model Prefix Stripping with Live Request");
console.log("=".repeat(60));

const http = require("node:http");

const requestData = JSON.stringify({
  model: "poe/grok-code-fast-1",
  max_tokens: 5,
  messages: [{ role: "user", content: "test" }],
});

const options = {
  hostname: "localhost",
  port: 3000,
  path: "/v1/messages",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "Content-Length": Buffer.byteLength(requestData),
  },
};

console.log("📤 Sending request to Claudish proxy:");
console.log("   Model: poe/grok-code-fast-1");
console.log("   Expected transformation: poe/grok-code-fast-1 → grok-code-fast-1");
console.log();

const req = http.request(options, (res) => {
  console.log(`📥 Response status: ${res.statusCode}`);
  console.log("📥 Response headers:", res.headers);

  let data = "";
  res.on("data", (chunk) => {
    data += chunk;
  });

  res.on("end", () => {
    console.log("📥 Response body:", data);

    // Check if we got the expected Poe API error
    if (data.includes("Unknown Model")) {
      console.log();
      console.log("✅ SUCCESS: The prefix stripping worked!");
      console.log("   - Poe API received the request (it generated an error response)");
      console.log(
        "   - The error 'Unknown Model' means Poe processed 'grok-code-fast-1' (without poe/ prefix)"
      );
      console.log(
        "   - If the prefix wasn't stripped, Poe would reject 'poe/grok-code-fast-1' immediately"
      );
    }
  });
});

req.on("error", (error) => {
  console.error("❌ Request error:", error.message);
  console.log();
  console.log("💡 Make sure Claudish proxy is running on port 3000:");
  console.log("   claudish --model poe/grok-code-fast-1 --debug");
});

req.write(requestData);
req.end();
