import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import type { CredentialArm } from "../auth/credentials/types.js";
import type { AuthBinding, ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import { type LegAuthBinding, isSameCredentialSilo } from "./shared/responses-leg-issuer.js";

const capture: {
  model: string;
  max_output_tokens: number;
  input: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>;
} = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/code-mode/claude-code-request-body.json", import.meta.url),
    "utf8"
  )
);
// Derived structural inbound messages from the real outbound request's input_text blocks.
// This is not a new protocol capture; source: test-fixtures/code-mode/claude-code-request-body.json.
function request() {
  return {
    model: capture.model,
    max_tokens: capture.max_output_tokens,
    stream: false,
    messages: capture.input
      .filter((item) => item.type === "message" && item.role === "user")
      .slice(0, 1)
      .map((item) => ({
        role: item.role,
        content: item.content
          .filter((block) => block.type === "input_text")
          .map((block) => ({ type: "text", text: block.text })),
      })),
  };
}
function binding(
  account: string,
  token: string,
  endpoint: string,
  arm: CredentialArm | undefined = "oauth"
): AuthBinding {
  return {
    auth: {
      arm,
      endpoint,
      headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": account },
    },
  };
}
function context(): Context {
  return {
    req: {
      header: (name?: string) =>
        name === undefined ? {} : name === "x-claudish-no-recovery" ? "1" : undefined,
    },
    header() {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as unknown as Context;
}
function transport(initial: AuthBinding, refreshed: () => Promise<AuthBinding>): ProviderTransport {
  return {
    name: "openai-codex",
    displayName: "OpenAI Codex",
    streamFormat: "openai-responses-sse",
    refreshAuth: async () => initial,
    forceRefreshAuth: refreshed,
    getEndpoint: (_model, bound) => bound?.auth?.endpoint ?? "https://unbound.invalid/responses",
    getHeaders: async (_request, bound) => bound?.auth?.headers ?? {},
  } as ProviderTransport;
}
function handler(t: ProviderTransport) {
  return new ComposedHandler(t, `cx@${capture.model}`, capture.model, 0, {
    codeMode: "off",
    adapter: new CodexAPIFormat(capture.model),
  });
}
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function upstream(statuses: number[]) {
  const sent: Array<{ endpoint: string; authorization: string | null; account: string | null }> =
    [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      endpoint: String(url),
      authorization: headers.get("authorization"),
      account: headers.get("chatgpt-account-id"),
    });
    const status = statuses.shift();
    if (status === undefined) throw new Error("unexpected additional outgoing request");
    // Status-only upstream failures: no hand-crafted Responses/SSE body.
    return new Response(null, { status });
  }) as typeof fetch;
  return sent;
}

describe("T5 primary-request OAuth 401 behavior", () => {
  test("REQ-2 TEST-4 recomputes endpoint and headers from a same-account refresh", async () => {
    const a = binding("account-a", "TOKEN_OLD", "https://old.invalid/codex/responses");
    const fresh = binding("account-a", "TOKEN_NEW", "https://new.invalid/codex/responses");
    const sent = upstream([401, 503]);
    const h = handler(transport(a, async () => fresh));
    try {
      const response = await h.handle(context(), request());

      expect(response.status).toBe(503);
      expect(sent).toEqual([
        { endpoint: a.auth!.endpoint!, authorization: "Bearer TOKEN_OLD", account: "account-a" },
        {
          endpoint: fresh.auth!.endpoint!,
          authorization: "Bearer TOKEN_NEW",
          account: "account-a",
        },
      ]);
    } finally {
      await h.shutdown();
    }
  });

  test("REQ-5 REQ-6 TEST-5 answers 401 not resent when refresh changes account", async () => {
    const a = binding("account-a", "TOKEN_A", "https://a.invalid/codex/responses");
    const b = binding("account-b", "TOKEN_B", "https://b.invalid/codex/responses");
    const sent = upstream([401]);
    const h = handler(transport(a, async () => b));
    const logs: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const response = await h.handle(context(), request());
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(body).toContain("Codex sign-in changed during the request; it was not resent");
      expect(sent).toEqual([
        { endpoint: a.auth!.endpoint!, authorization: "Bearer TOKEN_A", account: "account-a" },
      ]);
      // R2-6 specifies this stderr summary; the separate `Not resent:` line
      // is a debug-log seam, not a promise about stderr's formatting.
      expect(logs.join("\n")).toContain(
        "HTTP 401; the sign-in changed to another account during the request, so it was not resent."
      );
      expect(logs.join("\n")).not.toContain("HTTP 401 after auth retry");
    } finally {
      stderr.mockRestore();
      await h.shutdown();
    }
  });

  test.each(["api-key", undefined] as const)(
    "REQ-3 TEST-6 a request with arm %s never attempts forced OAuth refresh",
    async (arm) => {
      // Explicitly assign arm so undefined does not take binding()'s OAuth default.
      const initial = binding("account-a", "API_KEY", "https://key.invalid/v1/responses");
      initial.auth!.arm = arm;
      const sent = upstream([401]);
      const h = handler(
        transport(initial, async () =>
          binding("account-b", "OAUTH_TOKEN", "https://b.invalid/codex/responses")
        )
      );
      try {
        const response = await h.handle(context(), request());

        // The ordinary terminal-auth path is remapped to 400 by the supplied
        // project invariant; retain the actual 401 in the error envelope.
        const body = (await response.json()) as {
          error: { upstream_status: number; message: string };
        };
        expect(response.status).toBe(400);
        expect(body.error.upstream_status).toBe(401);
        expect(sent).toHaveLength(1);
        expect(body.error.message).not.toContain("sign-in changed");
      } finally {
        await h.shutdown();
      }
    }
  );

  test("REQ-7 TEST-7 classifies a refresh connection fault instead of inventing a 401", async () => {
    const sent = upstream([401]);
    // Structural error input from Bun's documented connection vocabulary; never a real socket.
    const error = Object.assign(
      new TypeError("Unable to connect. Is the computer able to access the url?"),
      { code: "ConnectionRefused" }
    );
    const h = handler(
      transport(binding("account-a", "TOKEN_A", "https://a.invalid/codex/responses"), async () => {
        throw error;
      })
    );
    try {
      const response = await h.handle(context(), request());
      const body = (await response.json()) as { error: { type: string } };

      expect(response.status).not.toBe(401);
      expect(response.status).toBe(400);
      expect(body.error.type).toBe("connection_error");
      expect(sent).toHaveLength(1);
    } finally {
      await h.shutdown();
    }
  });
});

describe("T5 public credential-silo predicate", () => {
  const oauth = (accountKey: string): LegAuthBinding => ({ auth: { arm: "oauth" }, accountKey });
  test.each([
    ["same OAuth account", oauth("account-a"), oauth("account-a"), true],
    ["different OAuth account", oauth("account-a"), oauth("account-b"), false],
    ["OAuth to api-key", oauth("account-a"), { auth: { arm: "api-key" } }, false],
    ["api-key to OAuth", { auth: { arm: "api-key" } }, oauth("account-a"), false],
    ["same api-key arm", { auth: { arm: "api-key" } }, { auth: { arm: "api-key" } }, true],
  ] as const)("REQ-5 TEST-8 %s returns %s", (_name, a, b, same) => {
    expect(isSameCredentialSilo(a, b)).toBe(same);
  });
});
