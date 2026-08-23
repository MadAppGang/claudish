import { describe, expect, test } from "bun:test";
import type { ProviderTransport } from "../providers/transport/types.js";
import {
  ComposedHandler,
  STRIPPED_IMAGE_PLACEHOLDER,
  stripImageBlocksFromMessages,
} from "./composed-handler.js";

// REGRESSION: structural weakness that allowed #102 — ComposedHandler must reject
// provider-routed strings in the modelName slot so dialect selection cannot be
// confused by provider-prefix characters. Fixed in /dev:fix session
// dev-fix-20260415-000620-e95d5090.

function makeFakeTransport(): ProviderTransport {
  return {
    name: "test-provider",
    displayName: "Test",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/",
    getHeaders: () => ({}),
  } as unknown as ProviderTransport;
}

describe("ComposedHandler — modelName invariant (#102 structural fix)", () => {
  test("throws when modelName contains '@' (routed string leaked into bare slot)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      // Passing a routed string in the modelName slot is structurally invalid —
      // the bare slot must never contain provider routing syntax.
      new ComposedHandler(transport, "zai@glm-4.7", "zai@glm-4.7", 8080, {});
    }).toThrow(/modelName.*must.*not.*contain/i);
  });

  test("accepts valid bare modelName with routed targetModel", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "zai@glm-4.7", "glm-4.7", 8080, {});
    }).not.toThrow();
  });

  test("accepts bare modelName when targetModel is also bare (no provider prefix)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "glm-4.7", "glm-4.7", 8080, {});
    }).not.toThrow();
  });

  test("accepts vendor-prefixed modelName (slash separator is legitimate)", () => {
    const transport = makeFakeTransport();
    expect(() => {
      new ComposedHandler(transport, "openrouter@x-ai/grok-beta", "x-ai/grok-beta", 8080, {});
    }).not.toThrow();
  });
});

// REGRESSION (2026-08-14, po-2025:CoursIA PDF read): when a non-vision model
// (glm-5.3 absent from the catalog → supportsVision=false) received a user
// message of [tool_result, image×N] with no text block, stripping the images
// left {"role":"user","content":""} — Z.AI rejected it with HTTP 400 code 1213
// "The prompt parameter was not received normally" (deterministic, 4/4 repro),
// and the client retried into the same wall. The placeholder keeps the
// message non-empty so the request can never hit that 400 again.
describe("stripImageBlocksFromMessages — empty-content regression", () => {
  test("images-only message becomes the placeholder, not empty string", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[0].content).toBe(STRIPPED_IMAGE_PLACEHOLDER);
    expect((messages[0].content as string).length).toBeGreaterThan(0);
  });

  test("single remaining text block collapses to a plain string", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: {} },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[0].content).toBe("hello");
  });

  test("text + multiple text blocks stay an array", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "document", source: {} },
        ],
      },
    ];
    stripImageBlocksFromMessages(messages, ["document"]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  test("PDF-read shape (tool result already extracted, images-only user msg) never yields empty content", () => {
    // Shape seen in the wild: conversion turns [tool_result, image×5] into a
    // role:tool message plus a user message holding only image_url parts.
    const messages = [
      { role: "tool", content: "PDF pages extracted: 5 page(s)", tool_call_id: "tu1" },
      {
        role: "user",
        content: Array.from({ length: 5 }, () => ({
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,XXX" },
        })),
      },
    ];
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);
    expect(messages[1].content).toBe(STRIPPED_IMAGE_PLACEHOLDER);
    // The tool message is untouched.
    expect(messages[0].content).toBe("PDF pages extracted: 5 page(s)");
  });

  test("non-array (plain string) content passes through unchanged", () => {
    const messages = [{ role: "user", content: "plain text" }];
    stripImageBlocksFromMessages(messages, ["image_url"]);
    expect(messages[0].content).toBe("plain text");
  });
});
