/**
 * #224 — media nested inside a `tool_result` must never be JSON-stringified
 * into the tool message.
 *
 * The shape Claude Code produces when it reads a PNG with `Read` or when a
 * browser tool returns a screenshot. Before the fix, the base64 rode as TEXT
 * in the role:"tool" message (200 080 chars for a 200 000-char image), on
 * every later turn of the session, invisible to the vision decision and to
 * the #223 strip.
 *
 * The hoist itself (image parts lifted into a user message placed after the
 * tool messages) landed with the S3 lot-1 série (#27 / 84578c9 + 9f4488d).
 * This file pins what #224 adds on top: the reproduced shape end to end, the
 * #223 notice on a non-vision model, the document/no-source siblings that the
 * hoist cannot express, the simpleFormat wire, Codex/Responses survival, and
 * the Ollama text-only lane.
 */

import { describe, expect, test } from "bun:test";
import { convertMessagesToOpenAI } from "./openai-messages.js";
import {
  STRIPPED_IMAGE_PLACEHOLDER,
  stripImageBlocksFromMessages,
} from "../../composed-handler.js";
import { CodexAPIFormat } from "../../../adapters/codex-api-format.js";
import { OllamaAPIFormat } from "../../../adapters/ollama-api-format.js";

const B64 = "A".repeat(200_000);

function claudeRequestWithImageResult() {
  return {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.png" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: B64 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("#224 — the reproduced shape on the OpenAI wire", () => {
  test("the tool message holds a marker, not the base64; the image rides as a following user message", () => {
    const out = convertMessagesToOpenAI(claudeRequestWithImageResult(), "glm-5.3");
    const tool = out.find((m: any) => m.role === "tool");
    expect(tool?.content).toBe("[image returned; see following message]");
    expect(JSON.stringify(tool)).not.toContain("AAAA");

    // The image message sits AFTER the tool messages, as image_url parts.
    const toolAt = out.findIndex((m: any) => m.role === "tool");
    const imgMsg = out.find(
      (m: any) =>
        m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "image_url"
    );
    expect(imgMsg).toBeDefined();
    expect(out.indexOf(imgMsg!)).toBeGreaterThan(toolAt);
    expect(imgMsg?.content[0].image_url.url).toBe(`data:image/png;base64,${B64}`);
  });

  test("on a non-vision model the #223 notice replaces the hoisted image (ComposedHandler's convert→strip order)", () => {
    // Exactly the order ComposedHandler runs: convertMessages (l. 311), then
    // the non-vision strip over the CONVERTED messages (l. 388). The hoisted
    // user message is array content, so the scan the defect used to miss now
    // sees the image.
    const messages = convertMessagesToOpenAI(claudeRequestWithImageResult(), "glm-5.3");
    stripImageBlocksFromMessages(messages, ["image_url", "image", "document"]);

    const imgMsg = messages.find((m: any) => m.content === STRIPPED_IMAGE_PLACEHOLDER);
    expect(imgMsg?.role).toBe("user");
    // The base64 is gone from the WHOLE conversation…
    expect(JSON.stringify(messages)).not.toContain("AAAA");
    // …while the tool message still names what was returned.
    expect(messages.find((m: any) => m.role === "tool")?.content).toBe(
      "[image returned; see following message]"
    );
  });
});

describe("#224 — media the hoist cannot express", () => {
  test("a document (PDF base64) beside text: text rides, the omission is named, nothing is serialized", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "text", text: "file dumped" },
                  {
                    type: "document",
                    source: { type: "base64", media_type: "application/pdf", data: B64 },
                  },
                ],
              },
            ],
          },
        ],
      },
      "glm-5.3"
    );
    const tool = out.find((m: any) => m.role === "tool");
    expect(tool?.content).toContain("file dumped");
    expect(tool?.content).toContain("[document returned, but this wire cannot forward it]");
    expect(JSON.stringify(out)).not.toContain("AAAA");
    // Nothing was hoisted: the hoist has no part for a document.
    expect(out.some((m: any) => JSON.stringify(m).includes("image_url"))).toBe(false);
  });

  test("an image block with no source is named as dropped, not JSON.stringify'd", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "image" }],
              },
            ],
          },
        ],
      },
      "glm-5.3"
    );
    const tool = out.find((m: any) => m.role === "tool");
    expect(tool?.content).toBe("[image returned, but its source could not be forwarded]");
    expect(JSON.stringify(tool)).not.toContain('"type":"image"'); // not the serialized block
  });

  test("one forwarded and one unforwardable image: both are named, the drop is not silent", () => {
    const out = convertMessagesToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "shots", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
                  { type: "image" },
                ],
              },
            ],
          },
        ],
      },
      "glm-5.3"
    );
    const tool = out.find((m: any) => m.role === "tool");
    expect(tool?.content).toBe(
      "[image returned; see following message]\n[image returned, but its source could not be forwarded]"
    );
    const hoisted = out.filter((m: any) => m.role === "user" && Array.isArray(m.content));
    expect(hoisted.at(-1)?.content.filter((p: any) => p.type === "image_url")).toHaveLength(1);
  });

  test("the simpleFormat wire names the omission instead of emitting an empty tool result", () => {
    // simpleFormat has no part for ANY image: before the fix the image branch
    // contributed nothing and the result came out "[Tool Result]: " — empty.
    const out = convertMessagesToOpenAI(
      claudeRequestWithImageResult(),
      "glm-4.5-air",
      undefined,
      true
    );
    const user = out.find((m: any) => m.role === "user");
    // The source is fine here; the WIRE has no part for it, and the marker
    // says so rather than blaming the source.
    expect(user?.content).toBe("[Tool Result]: [image returned, but this wire cannot forward it]");
    expect(JSON.stringify(out)).not.toContain("AAAA");
  });
});

describe("#224 — Codex/Responses inherits the hoist", () => {
  test("the hoisted image survives buildPayload as input_image; function_call_output stays text", () => {
    const req = claudeRequestWithImageResult();
    const fmt = new CodexAPIFormat("gpt-5.6-sol");
    const payload = fmt.buildPayload(req, convertMessagesToOpenAI(req, "glm-5.3"), []);

    const input = payload.input as any[];
    const imageMsg = input.find((i: any) =>
      i.type === "message" &&
      Array.isArray(i.content) &&
      i.content.some((p: any) => p.type === "input_image")
    );
    expect(imageMsg?.role).toBe("user");
    expect(
      imageMsg?.content.find((p: any) => p.type === "input_image")?.image_url
    ).toBe(`data:image/png;base64,${B64}`);

    const fco = input.find((i: any) => i.type === "function_call_output");
    expect(fco?.output).toBe("[image returned; see following message]");
    expect(JSON.stringify(fco)).not.toContain("AAAA"); // the leak path was here
  });
});

describe("#224 — the Ollama text-only lane", () => {
  test("a nested image is counted and named, never serialized as base64", () => {
    const out = new OllamaAPIFormat("llama3.2:3").convertMessages({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "file dumped" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: B64 },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain("[Tool Result]: file dumped");
    expect(out[0].content).toContain(
      "1 image/document part was present in this tool result but not forwarded: this lane carries text only."
    );
    expect(JSON.stringify(out)).not.toContain("AAAA");
  });

  test("a top-level image sibling gets the same named omission (it used to vanish silently)", () => {
    const out = new OllamaAPIFormat("llama3.2:3").convertMessages({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: B64 } },
          ],
        },
      ],
    });
    expect(out[0].content).toContain("look at this");
    expect(out[0].content).toContain(
      "1 image/document part was present in this message but not forwarded: this lane carries text only."
    );
    expect(JSON.stringify(out)).not.toContain("AAAA");
  });
});
