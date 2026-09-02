/**
 * Regression coverage for OpenAI Codex prompt-cache affinity.
 *
 * The cache-routing key must stay stable for a Claude Code conversation across
 * transport instances and process restarts without exposing the raw session id.
 * Every request also needs a fallback key, while explicit caller keys and the
 * existing model/auth payload transforms must continue to win where applicable.
 *
 * Hermetic: mock only credentials.getRequestAuth, matching the sibling OAuth
 * transport test, so no real credentials, filesystem, or network are touched.
 * Both arms are modelled as the artifacts the real halves return (`arm` included);
 * the api-key half never throws, so nothing here pretends it does. See the sibling
 * file's header for why that distinction is load-bearing.
 *
 * The two tests that call refreshAuth() write the process-wide signed-arm record;
 * the afterEach clears it. See the sibling file's afterEach.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearSignedArm } from "../../auth/credentials/billing-probe.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

const FAKE_TOKEN = "codex-oauth-token-abc";
const FAKE_ACCOUNT = "acct-123";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const CODEX_OAUTH_AUTH = {
  // Stamped by CodexOAuthHalf; this is what refreshAuth reads to record the SUB
  // billing arm. A fixture without it is not the OAuth artifact.
  arm: "oauth" as const,
  headers: {
    Authorization: `Bearer ${FAKE_TOKEN}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
    "chatgpt-account-id": FAKE_ACCOUNT,
    "x-conversation-id": "claudish-session",
    "x-session-id": "claudish-session",
  },
  endpoint: CODEX_ENDPOINT,
  transformPayload: (payload: any) => ({
    ...payload,
    store: false,
    include: ["reasoning.encrypted_content"],
  }),
};

/** What ApiKeyCredentialProvider.getRequestAuth() returns: marked, no endpoint. */
const API_KEY_AUTH = {
  arm: "api-key" as const,
  headers: { Authorization: "Bearer sk-codex-key" },
};

let getRequestAuthMock = mock(async (_name: string, _ctx: any) => CODEX_OAUTH_AUTH as any);

mock.module("../../auth/credentials/authority.js", () => ({
  credentials: {
    getRequestAuth: (name: string, ctx: any) => getRequestAuthMock(name, ctx),
  },
}));

const { OpenAICodexTransport } = await import("./openai-codex.js");

const provider: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@", "codex@"],
};

function createTransport(): InstanceType<typeof OpenAICodexTransport> {
  return new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
}

function requestForSession(sessionId: string): any {
  return {
    metadata: {
      user_id: JSON.stringify({
        device_id: "device-123",
        account_uuid: "",
        session_id: sessionId,
      }),
    },
  };
}

function promptCacheKey(payload: any): string {
  expect(typeof payload.prompt_cache_key).toBe("string");
  expect(payload.prompt_cache_key.length).toBeGreaterThan(0);
  expect(payload.prompt_cache_key.startsWith("claudish_")).toBe(true);
  return payload.prompt_cache_key;
}

beforeEach(() => {
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => CODEX_OAUTH_AUTH as any);
});

afterEach(() => {
  mock.restore();
  // refreshAuth() always records a billing arm; this suite is about cache keys
  // and must not decide billing for the next file in the Bun run.
  clearSignedArm("openai-codex");
});

describe("OpenAICodexTransport prompt_cache_key", () => {
  test("is stable for one session across calls and transport instances without exposing the id", () => {
    const sessionId = "019c7f9e-1111-7000-8000-111111111111";
    const claudeRequest = requestForSession(sessionId);
    const firstTransport = createTransport();
    const secondTransport = createTransport();

    const firstKey = promptCacheKey(
      firstTransport.transformPayload({ input: "one" }, claudeRequest)
    );
    const repeatedKey = promptCacheKey(
      firstTransport.transformPayload({ input: "two" }, claudeRequest)
    );
    const restartedKey = promptCacheKey(
      secondTransport.transformPayload({ input: "three" }, claudeRequest)
    );

    expect(repeatedKey).toBe(firstKey);
    expect(restartedKey).toBe(firstKey);
    expect(firstKey.includes(sessionId)).toBe(false);
  });

  test("isolates different session ids", () => {
    const transport = createTransport();
    const firstKey = promptCacheKey(
      transport.transformPayload(
        { input: "one" },
        requestForSession("019c7f9e-2222-7000-8000-222222222222")
      )
    );
    const secondKey = promptCacheKey(
      transport.transformPayload(
        { input: "two" },
        requestForSession("019c7f9e-3333-7000-8000-333333333333")
      )
    );

    expect(secondKey).not.toBe(firstKey);
  });

  test("emits a fallback key without valid session metadata", () => {
    const transport = createTransport();
    const requests = [undefined, {}, { metadata: { user_id: "plain-non-json-user-id" } }];

    for (const claudeRequest of requests) {
      promptCacheKey(transport.transformPayload({ input: "fallback" }, claudeRequest));
    }
  });

  test("preserves an explicit incoming key", () => {
    const explicitKey = "caller-supplied-cache-key";
    const out = createTransport().transformPayload(
      { input: "explicit", prompt_cache_key: explicitKey },
      requestForSession("019c7f9e-4444-7000-8000-444444444444")
    );

    expect(out.prompt_cache_key).toBe(explicitKey);
  });

  test("coexists with model normalization and OAuth payload transforms", async () => {
    const transport = createTransport();
    await transport.refreshAuth();

    const out = transport.transformPayload(
      { model: "cx@gpt-5.1-codex", input: "oauth" },
      requestForSession("019c7f9e-5555-7000-8000-555555555555")
    );

    expect(out.model).toBe("gpt-5.1-codex");
    promptCacheKey(out);
    expect(out.store).toBe(false);
    expect(out.include).toEqual(["reasoning.encrypted_content"]);
    expect(getRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getRequestAuthMock.mock.calls[0][0]).toBe("openai-codex");
  });

  test("emits a key on the non-OAuth api-key path", async () => {
    // The api-key half's real return: a marked, endpoint-less artifact. Not a
    // throw — the composite falls THROUGH to this half rather than failing.
    getRequestAuthMock = mock(async () => API_KEY_AUTH);
    const transport = createTransport();
    await transport.refreshAuth();

    const out = transport.transformPayload(
      { input: "api-key" },
      requestForSession("019c7f9e-6666-7000-8000-666666666666")
    );

    promptCacheKey(out);
    expect(out.store).toBeUndefined();
    expect(out.include).toBeUndefined();
  });
});
