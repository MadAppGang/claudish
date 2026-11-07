// REGRESSION: an image-only message on a non-vision model was sent with empty content, so the upstream answered 400
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Hono } from "hono";
import { AnthropicAPIFormat } from "../adapters/anthropic-api-format.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
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
  tool_use_id?: string;
  content?: CapturedPart[];
}

interface CapturedMessage {
  role: string;
  content?: string | CapturedPart[] | null;
}

interface CapturedBody {
  messages: CapturedMessage[];
}

interface CapturedResponsesBody {
  input: CapturedMessage[];
}

type Api = "chat-completions" | "anthropic-messages" | "responses";
const upstreamEndpoint = "https://vision-strip-upstream.invalid/v1/messages";
const visionEndpoint = "https://api.anthropic.com/v1/messages";

async function captureRequest(
  api: "responses",
  messages: unknown[],
  acceptsImages?: boolean
): Promise<{ body: CapturedResponsesBody; visionCalls: number }>;
async function captureRequest(
  api: Exclude<Api, "responses">,
  messages: unknown[],
  acceptsImages?: boolean
): Promise<{ body: CapturedBody; visionCalls: number }>;
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
    streamFormat: (
      {
        "chat-completions": "openai-sse",
        "anthropic-messages": "anthropic-sse",
        responses: "openai-responses-sse",
      } as const
    )[api],
    getEndpoint: () => upstreamEndpoint,
    getHeaders: async () => ({ "content-type": "application/json" }),
  };
  const upstreamBodies: (CapturedBody | CapturedResponsesBody)[] = [];
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
        upstreamBodies.push(JSON.parse(String(init?.body)) as CapturedBody | CapturedResponsesBody);
        // Stop after request construction without running response parsers or usage writes.
        return new Response("Captured upstream request", { status: 400 });
      },
      { preconnect: originalFetch.preconnect }
    ) as typeof fetch;

    handler = new ComposedHandler(transport, modelId, modelId, 0, {
      adapter:
        api === "responses"
          ? new CodexAPIFormat(modelId, undefined, { codexExtras: false })
          : api === "chat-completions"
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

function expectNoEmptyInputContent(body: CapturedResponsesBody) {
  expect(body.input).toBeArray();
  expect(body.input.length).toBeGreaterThan(0);
  const empty = body.input.filter(
    (item) => item.content === "" || (Array.isArray(item.content) && item.content.length === 0)
  );
  expect(empty, 'No outgoing input item may have content "" or []').toEqual([]);
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

function partsOfType(value: unknown, type: string): CapturedPart[] {
  if (value === null || typeof value !== "object") return [];
  const matches = "type" in value && value.type === type ? [value as CapturedPart] : [];
  return [...matches, ...Object.values(value).flatMap((child) => partsOfType(child, type))];
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

  test("(f) anthropic-messages: nested tool_result image retains an omission placeholder", async () => {
    const { body } = await captureRequest("anthropic-messages", toolResultConversation());
    expect(
      partsOfType(body, "image"),
      "No image block may reach a non-vision model, including nested tool_result content"
    ).toEqual([]);
    const toolResults = partsOfType(body, "tool_result");
    expect(toolResults).toHaveLength(1);
    const toolResult = toolResults[0]!;
    expect(toolResult.tool_use_id).toBe("toolu_read_pixel");
    expectNoEmptyContent(body);
    expect(toolResult.content, "The tool_result content must not be empty").toBeArray();
    expect(toolResult.content!.length).toBeGreaterThan(0);
    expect(
      partsOfType(toolResult.content, "text").some((part) => part.text?.includes("[image omitted")),
      "The nested tool_result must name the omitted image"
    ).toBe(true);
  });

  test("(g) anthropic-messages vision control: nested tool_result image reaches upstream unchanged", async () => {
    const { body, visionCalls } = await captureRequest(
      "anthropic-messages",
      toolResultConversation(),
      true
    );
    expect(visionCalls).toBe(0);
    expectNoEmptyContent(body);
    const toolResults = partsOfType(body, "tool_result");
    expect(toolResults).toHaveLength(1);
    const toolResult = toolResults[0]!;
    expect(toolResult.tool_use_id).toBe("toolu_read_pixel");
    expect(toolResult.content).toEqual([image()]);
    expect(partsOfType(body, "image")).toEqual([image()]);
    expect(JSON.stringify(body)).not.toContain("[image omitted");
  });

  test("(h) responses: tool_result and top-level images retain text and omission placeholders", async () => {
    const conversations = [
      {
        messages: toolResultConversation(),
        userText: "Read ./pixel.png and describe it.",
      },
      {
        messages: [{ role: "user", content: [image(), text("Describe the red pixel.")] }],
        userText: "Describe the red pixel.",
      },
    ];
    for (const { messages, userText } of conversations) {
      const { body } = await captureRequest("responses", messages);
      expect(
        partsOfType(body, "input_image"),
        "No input_image item may reach a non-vision model"
      ).toEqual([]);
      expectNoEmptyInputContent(body);
      expect(JSON.stringify(body)).toContain("[image omitted");
      const userTextSent = body.input
        .filter((item) => item.role === "user")
        .map(messageText)
        .join("\n");
      expect(userTextSent, "The original user text must survive").toContain(userText);
    }
  });

  test("(i) responses vision control: tool_result image reaches upstream without a placeholder", async () => {
    const { body, visionCalls } = await captureRequest("responses", toolResultConversation(), true);
    expect(visionCalls).toBe(0);
    expectNoEmptyInputContent(body);
    expect(partsOfType(body, "input_image").length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("[image omitted");
  });
});
