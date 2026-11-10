import { describe, expect, test } from "bun:test";
import { probeLink } from "./probe-live.js";

interface CapturedProbeBody {
  output_config?: { effort?: string };
}

const MINIMAL_ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
  "",
].join("\n\n");

async function captureProbeBody(provider: string): Promise<CapturedProbeBody> {
  let captured: CapturedProbeBody | undefined;
  const handleRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return new Response("not found", { status: 404 });
    }
    captured = (await request.json()) as CapturedProbeBody;
    return new Response(MINIMAL_ANTHROPIC_SSE, {
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  let server: ReturnType<typeof Bun.serve> | undefined;
  let proxyUrl = "http://proxy.test";
  const realFetch = globalThis.fetch;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handleRequest });
    proxyUrl = `http://127.0.0.1:${server.port}`;
  } catch (error) {
    // The Codex filesystem sandbox used for local validation denies every bind
    // as EADDRINUSE. Normal runs use Bun.serve; this preserves the same Request
    // handler and body/SSE round-trip when local sockets are unavailable.
    if ((error as { code?: unknown }).code !== "EADDRINUSE") throw error;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      handleRequest(new Request(input, init))) as typeof fetch;
  }

  try {
    const result = await probeLink(
      proxyUrl,
      { provider, modelSpec: `${provider}@test-model`, hasCredentials: true },
      1000
    );
    expect(result.state).toBe("live");
  } finally {
    server?.stop(true);
    globalThis.fetch = realFetch;
  }

  if (!captured) throw new Error("probeLink did not POST a JSON body");
  return captured;
}

describe("probe effort per provider", () => {
  // Mutation targets: probe-live.ts:120, :136 and :140. Removing Antigravity
  // from EFFORT_OMITTED adds minimal; dropping the Anthropic set sends minimal;
  // changing the default sends low to OpenAI.
  test("Antigravity omits output_config", async () => {
    expect(await captureProbeBody("antigravity")).not.toHaveProperty("output_config");
  });

  test("native Anthropic uses low effort", async () => {
    expect((await captureProbeBody("native-anthropic")).output_config?.effort).toBe("low");
  });

  for (const provider of ["glm", "z-ai", "glm-coding"]) {
    test(`${provider} never asks GLM to stop thinking`, async () => {
      const effort = (await captureProbeBody(provider)).output_config?.effort;

      expect(effort).toBe("low");
      expect(effort).not.toBe("minimal");
    });
  }

  test("Google never receives unsupported minimal effort", async () => {
    const effort = (await captureProbeBody("google")).output_config?.effort;

    expect(effort).toBe("low");
    expect(effort).not.toBe("minimal");
  });

  test("Alibaba PAYG never receives unsupported minimal effort", async () => {
    const effort = (await captureProbeBody("qwen-payg")).output_config?.effort;

    expect(effort).toBe("low");
    expect(effort).not.toBe("minimal");
  });

  test("OpenAI uses minimal effort", async () => {
    expect((await captureProbeBody("openai")).output_config?.effort).toBe("minimal");
  });
});
