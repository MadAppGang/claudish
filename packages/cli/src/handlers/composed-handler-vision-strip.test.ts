// REGRESSION: an image-only message on a non-vision model was sent with empty content, so the upstream answered 400
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Hono } from "hono";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { lookupModelAcceptsImages } from "../adapters/model-catalog.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import type { DiskCacheV3 } from "../providers/all-models-cache.js";
import type { ResolvedConnection } from "../providers/connection-resolver.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

function tinyPng(): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // Eight-bit RGB, one red pixel.
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk("IEND", new Uint8Array()),
  ]).toString("base64");
}

const png = tinyPng();
const image = () => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: png },
});
const text = (value: string) => ({ type: "text", text: value });

function toolResultConversation() {
  return [
    { role: "user", content: "Read ./pixel.png and describe it." },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_read_pixel",
          name: "Read",
          input: { file_path: "./pixel.png" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_read_pixel", content: [image()] }],
    },
  ];
}

interface CapturedPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface CapturedMessage {
  role: string;
  content?: string | CapturedPart[] | null;
}

interface CapturedBody {
  messages: CapturedMessage[];
}

type Api = "chat-completions" | "anthropic-messages";
const upstreamEndpoint = "https://vision-strip-upstream.invalid/v1/messages";
const visionEndpoint = "https://api.anthropic.com/v1/messages";

async function captureRequest(api: Api, messages: unknown[], acceptsImages = false) {
  const directory = mkdtempSync(join(tmpdir(), "composed-vision-strip-"));
  const cachePath = join(directory, "catalog.json");
  const modelId = acceptsImages ? "test-vision-model" : "test-text-only-model";
  const cache: DiskCacheV3 = {
    version: 3,
    catalogGenerationId: "vision-strip-test-generation",
    lastUpdated: new Date().toISOString(),
    entries: [
      {
        modelId,
        aliases: [],
        inputModalities: acceptsImages ? ["text", "image"] : ["text"],
      },
    ],
    models: [],
    plans: [],
  };
  const connection: ResolvedConnection = {
    provider: "vision-strip-test",
    modelId,
    externalModelId: modelId,
    generationId: cache.catalogGenerationId,
    route: { routeId: "vision-strip-test", routeProfileId: "test" },
    profile: { kind: "direct", apis: { [api]: { baseUrl: upstreamEndpoint } } },
    wire: {
      status: "known",
      api,
      tokenParam: "max_tokens",
      toolsWithReasoning: "ok",
      reasoning: { status: "not_applicable" },
      speed: { status: "not_applicable" },
      evidence: [],
    },
  };
  const transport: ProviderTransport = {
    name: connection.provider,
    displayName: "Vision strip test",
    streamFormat: api === "chat-completions" ? "openai-sse" : "anthropic-sse",
    getEndpoint: () => upstreamEndpoint,
    getHeaders: async () => ({ "content-type": "application/json" }),
  };
  const upstreamBodies: CapturedBody[] = [];
  let visionCalls = 0;
  const originalFetch = globalThis.fetch;
  let handler: ComposedHandler | undefined;

  try {
    writeFileSync(cachePath, JSON.stringify(cache));
    expect(lookupModelAcceptsImages(modelId, cachePath)).toBe(acceptsImages);

    // A valid PNG always reaches fetch in describeImages. Fail that call locally;
    // never delegate any URL to the original fetch.
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === visionEndpoint) {
          visionCalls++;
          return new Response("Vision description unavailable in this test", { status: 503 });
        }
        if (url !== upstreamEndpoint) throw new Error(`Unexpected fetch: ${url}`);
        upstreamBodies.push(JSON.parse(String(init?.body)) as CapturedBody);
        // Stop after request construction without running response parsers or usage writes.
        return new Response("Captured upstream request", { status: 400 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    handler = new ComposedHandler(transport, modelId, modelId, 0, {
      adapter:
        connection.wire.status === "known" && connection.wire.api === "chat-completions"
          ? new OpenAIAPIFormat(modelId)
          : new AnthropicAPIFormat(modelId, transport.name),
      catalogCachePath: cachePath,
      connection,
    });
    const app = new Hono();
    app.post("/", (context) =>
      handler!.handle(context, {
        model: "test-request-model",
        max_tokens: 64,
        stream: false,
        tools: [
          {
            name: "Read",
            description: "Read an image file",
            input_schema: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"],
            },
          },
        ],
        messages: structuredClone(messages),
      })
    );
    const response = await app.request("/", { method: "POST" });
    await response.text();
    expect(upstreamBodies, "The real ComposedHandler must reach the upstream fetch").toHaveLength(
      1
    );
    return { body: upstreamBodies[0]!, visionCalls };
  } finally {
    globalThis.fetch = originalFetch;
    try {
      await handler?.shutdown();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function messageText(message: CapturedMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

function expectNoEmptyContent(body: CapturedBody) {
  const empty = body.messages.filter(
    (message) =>
      message.content === "" || (Array.isArray(message.content) && message.content.length === 0)
  );
  expect(empty, 'No outgoing message may have content "" or []').toEqual([]);
}

function userAfterTool(body: CapturedBody): CapturedMessage {
  const toolIndex = body.messages.findIndex((message) => message.role === "tool");
  expect(toolIndex, "The converted tool_result must be a tool message").toBeGreaterThan(-1);
  const following = body.messages[toolIndex + 1];
  expect(following?.role, "The lifted image must remain in the following user message").toBe(
    "user"
  );
  return following!;
}

describe("ComposedHandler non-vision image omission", () => {
  test("(a) chat-completions: image-only tool_result retains an omission placeholder", async () => {
    const { body, visionCalls } = await captureRequest(
      "chat-completions",
      toolResultConversation()
    );
    expect(visionCalls).toBe(1);
    const following = userAfterTool(body);
    expectNoEmptyContent(body);
    expect(
      messageText(following),
      "The user message after the tool must name the omitted image"
    ).toContain("[image omitted");
  });

  test("(b) chat-completions: top-level image and text retain both text and placeholder", async () => {
    const { body, visionCalls } = await captureRequest("chat-completions", [
      { role: "user", content: [image(), text("Describe the red pixel.")] },
    ]);
    expect(visionCalls).toBe(1);
    expectNoEmptyContent(body);
    const user = body.messages.find((message) => message.role === "user")!;
    expect(messageText(user), "The original user text must survive").toContain(
      "Describe the red pixel."
    );
    expect(messageText(user), "The mixed user message must name the omitted image").toContain(
      "[image omitted"
    );
  });

  test("(c) chat-completions: two top-level images retain two omission placeholders", async () => {
    const { body, visionCalls } = await captureRequest("chat-completions", [
      { role: "user", content: [image(), image()] },
    ]);
    expect(visionCalls).toBe(2);
    expectNoEmptyContent(body);
    const user = body.messages.find((message) => message.role === "user")!;
    expect(
      messageText(user).match(/\[image omitted/g) ?? [],
      "Two omitted images must produce two placeholders"
    ).toHaveLength(2);
  });

  test("(d) anthropic-messages: a top-level image retains an omission placeholder", async () => {
    const { body, visionCalls } = await captureRequest("anthropic-messages", [
      { role: "user", content: [image()] },
    ]);
    expect(visionCalls).toBe(0);
    expectNoEmptyContent(body);
    const user = body.messages.find((message) => message.role === "user")!;
    expect(messageText(user), "The Anthropic user message must name the omitted image").toContain(
      "[image omitted"
    );
  });

  test("(e) vision control: tool_result image reaches upstream unchanged without a placeholder", async () => {
    const { body, visionCalls } = await captureRequest(
      "chat-completions",
      toolResultConversation(),
      true
    );
    expect(visionCalls).toBe(0);
    expectNoEmptyContent(body);
    const following = userAfterTool(body);
    expect(following.content).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
    ]);
    expect(JSON.stringify(body)).not.toContain("[image omitted");
  });
});
