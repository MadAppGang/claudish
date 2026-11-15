import { describe, expect, test } from "bun:test";
import { removeProviderRefusedText } from "./provider-refused-text.js";

const SECURITY =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

const BEFORE = "You are an agent working with the user toward their goals.";
const AFTER = "# Harness\n - Text you output outside of tool use is displayed to the user.";

describe("removeProviderRefusedText", () => {
  test("removes the security paragraph from a string system prompt on antigravity", () => {
    const req = { system: `${BEFORE}\n\n${SECURITY}\n\n${AFTER}`, messages: [] };
    const out = removeProviderRefusedText(req, "antigravity");
    expect(out.system).toBe(`${BEFORE}\n\n${AFTER}`);
  });

  test("removes it when it is the last paragraph", () => {
    const req = { system: `${BEFORE}\n\n${SECURITY}` };
    expect(removeProviderRefusedText(req, "antigravity").system).toBe(BEFORE);
  });

  test("removes it when it is the first paragraph", () => {
    const req = { system: `${SECURITY}\n\n${AFTER}` };
    expect(removeProviderRefusedText(req, "antigravity").system).toBe(AFTER);
  });

  test("removes a paragraph that keeps the opening words but has other wording after", () => {
    const reworded = "IMPORTANT: Assist with authorized security testing only. Other words here.";
    const req = { system: `${BEFORE}\n\n${reworded}\n\n${AFTER}` };
    expect(removeProviderRefusedText(req, "antigravity").system).toBe(`${BEFORE}\n\n${AFTER}`);
  });

  test("removes every occurrence", () => {
    const req = { system: `${SECURITY}\n\n${BEFORE}\n\n${SECURITY}\n\n${AFTER}` };
    expect(removeProviderRefusedText(req, "antigravity").system).toBe(`${BEFORE}\n\n${AFTER}`);
  });

  test("keeps the shape of a block system prompt and its cache_control", () => {
    const req = {
      system: [
        { type: "text", text: BEFORE },
        {
          type: "text",
          text: `${SECURITY}\n\n${AFTER}`,
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    const out = removeProviderRefusedText(req, "antigravity");
    expect(out.system).toEqual([
      { type: "text", text: BEFORE },
      { type: "text", text: AFTER, cache_control: { type: "ephemeral" } },
    ]);
  });

  test("drops a block that held only the paragraph", () => {
    const req = {
      system: [
        { type: "text", text: BEFORE },
        { type: "text", text: SECURITY },
      ],
    };
    expect(removeProviderRefusedText(req, "antigravity").system).toEqual([
      { type: "text", text: BEFORE },
    ]);
  });

  test("returns the same request for another provider", () => {
    const req = { system: `${BEFORE}\n\n${SECURITY}\n\n${AFTER}` };
    expect(removeProviderRefusedText(req, "gemini")).toBe(req);
    expect(removeProviderRefusedText(req, "openrouter")).toBe(req);
  });

  test("returns the same request when the paragraph is absent", () => {
    const req = { system: `${BEFORE}\n\n${AFTER}` };
    expect(removeProviderRefusedText(req, "antigravity")).toBe(req);
  });

  test("keeps the words when they do not start a line", () => {
    const quoted = `The prompt says "IMPORTANT: Assist with authorized security testing" somewhere.`;
    const req = { system: `${BEFORE}\n\n${quoted}\n\n${AFTER}` };
    expect(removeProviderRefusedText(req, "antigravity")).toBe(req);
  });

  test("does not change the conversation", () => {
    const messages = [{ role: "user", content: `Explain this:\n\n${SECURITY}` }];
    const req = { system: `${BEFORE}\n\n${SECURITY}`, messages };
    const out = removeProviderRefusedText(req, "antigravity");
    expect(out.messages).toBe(messages);
  });

  test("leaves a request with no system prompt alone", () => {
    const req = { messages: [] };
    expect(removeProviderRefusedText(req, "antigravity")).toBe(req);
  });

  test("stays fast on a long prompt with many near matches", () => {
    const system = "\nIMPORTANT: Assist with authorized security".repeat(50_000);
    const started = performance.now();
    removeProviderRefusedText({ system }, "antigravity");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
