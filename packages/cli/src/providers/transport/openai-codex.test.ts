import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MeteredEscapeError } from "../../auth/accounts/errors.js";
import { credentials } from "../../auth/credentials/authority.js";
import { clearSignedArm } from "../../auth/credentials/billing-probe.js";
import type { RequestAuth, RequestAuthContext } from "../../auth/credentials/types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { OpenAICodexTransport } from "./openai-codex.js";
import type { AuthBinding } from "./types.js";

const provider: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@", "codex@"],
};
const capture = JSON.parse(
  readFileSync(
    new URL("../../test-fixtures/code-mode/claude-code-request-body.json", import.meta.url),
    "utf8"
  )
);
const realFetch = globalThis.fetch;
const originalGetRequestAuth = credentials.getRequestAuth;
beforeEach(() => {
  noNetwork();
});
function installCredential(sign: (ctx: RequestAuthContext) => Promise<RequestAuth>) {
  credentials.getRequestAuth = async (name, ctx) => {
    expect(name).toBe("openai-codex");
    return sign(ctx);
  };
}
afterEach(() => {
  credentials.getRequestAuth = originalGetRequestAuth;
  globalThis.fetch = realFetch;
  clearSignedArm("openai-codex");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function auth(account: string, token: string, endpoint: string): RequestAuth {
  return {
    arm: "oauth",
    endpoint,
    headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": account },
    // Derived request transform: same store/include fields as the real request capture.
    transformPayload: (payload) => ({ ...payload, store: capture.store, include: capture.include }),
  };
}
function noNetwork() {
  globalThis.fetch = (async () => {
    throw new Error("T5 forbids network access");
  }) as unknown as typeof fetch;
}

describe("T5 request-scoped Codex auth bindings", () => {
  test("REQ-1 TEST-1 keeps the first request's endpoint and headers after an overlapping refresh", async () => {
    noNetwork();
    const a: AuthBinding = {
      auth: auth("account-a", "TOKEN_A", "https://a.invalid/codex/responses"),
    };
    const b = {
      ...auth("account-b", "TOKEN_B", "https://b.invalid/codex/responses"),
      transformPayload: undefined,
    };
    const refreshEntered = deferred<void>();
    const refreshDone = deferred<void>();
    // Rebase resolution decision 3: exercise the credential seam through the real signRequest.
    installCredential(async (ctx) => {
      expect(ctx.forceRefresh).toBe(true);
      refreshEntered.resolve();
      await refreshDone.promise;
      return b;
    });
    const transport = new OpenAICodexTransport(provider, capture.model, "API_KEY");
    const firstCanSign = deferred<void>();
    const firstRequest = (async () => {
      await firstCanSign.promise;
      return {
        endpoint: transport.getEndpoint(capture.model, a),
        headers: new Headers(await transport.getHeaders(undefined, a)),
        payload: transport.transformPayload(
          (() => {
            // Remove captured OAuth fields so only A's transform can supply them.
            const payload = structuredClone(capture);
            delete payload.store;
            delete payload.include;
            return payload;
          })(),
          undefined,
          a
        ),
      };
    })();

    const secondRefresh = transport.forceRefreshAuth();
    await refreshEntered.promise;
    refreshDone.resolve();
    const secondBinding = await secondRefresh;
    firstCanSign.resolve();
    const first = await firstRequest;

    expect(first.endpoint).toBe(a.auth!.endpoint!);
    expect(first.headers.get("authorization")).toBe("Bearer TOKEN_A");
    expect(first.headers.get("chatgpt-account-id")).toBe("account-a");
    expect(first.payload.store).toBe(capture.store);
    expect(first.payload.include).toEqual(capture.include);
    expect(transport.getEndpoint(capture.model, secondBinding)).toBe(b.endpoint!);
    expect(
      new Headers(await transport.getHeaders(undefined, secondBinding)).get("authorization")
    ).toBe("Bearer TOKEN_B");
  });

  test("REQ-1 REQ-3 TEST-2 an explicit null binding stays on the api-key path after OAuth refresh", async () => {
    noNetwork();
    installCredential(async (ctx) => {
      expect(ctx.forceRefresh).toBe(true);
      return auth("account-a", "OAUTH_TOKEN", "https://a.invalid/codex/responses");
    });
    const transport = new OpenAICodexTransport(provider, capture.model, "API_KEY");
    await transport.forceRefreshAuth();

    const binding: AuthBinding = { auth: null };
    const headers = new Headers(await transport.getHeaders(undefined, binding));
    // Derived from the captured request; remove OAuth-only fields before testing the base transform.
    const payload = structuredClone(capture);
    delete payload.store;
    delete payload.include;
    const transformed = transport.transformPayload(payload, undefined, binding);

    expect(transport.getEndpoint(capture.model, binding)).toBe(
      "https://api.openai.com/v1/responses"
    );
    expect(headers.get("authorization")).toBe("Bearer API_KEY");
    expect(headers.get("chatgpt-account-id")).toBeNull();
    expect(transformed.store).toBeUndefined();
    expect(transformed.include).toBeUndefined();
  });

  test("REQ-7 TEST-3 rethrows the identical connection failure from the credential seam", async () => {
    noNetwork();
    // Error test data, not protocol data. Bun's connection vocabulary is already documented
    // by composed-handler-connection-error.test.ts; no socket or OAuth singleton is touched.
    const error = Object.assign(
      new TypeError("Unable to connect. Is the computer able to access the url?"),
      { code: "ConnectionRefused" }
    );
    installCredential(async (ctx) => {
      expect(ctx.forceRefresh).toBe(true);
      throw error;
    });
    const transport = new OpenAICodexTransport(provider, capture.model, "API_KEY");

    await expect(transport.forceRefreshAuth()).rejects.toBe(error);
  });

  test("REQ-3 forced refresh cannot substitute an api-key artifact when OAuth is required", async () => {
    noNetwork();
    const rejected = auth("account-a", "REJECTED", "https://a.invalid/codex/responses");
    const pin = { provider: "openai-codex" as const, id: "aaaaaaaaaaaa", label: "A" };
    installCredential(async (ctx) => {
      expect(ctx).toMatchObject({ forceRefresh: true, requireOAuth: true, pin, rejected });
      return { arm: "api-key", headers: { Authorization: "Bearer API_KEY" } };
    });
    const transport = new OpenAICodexTransport(provider, capture.model, "API_KEY");

    // Decision 3 removes nullable minting; the real signRequest guard must reject the key.
    await expect(
      transport.forceRefreshAuth({ requireOAuth: true, pin, rejected })
    ).rejects.toBeInstanceOf(MeteredEscapeError);
  });
});
