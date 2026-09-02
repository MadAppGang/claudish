/**
 * Regression pin for Step 5b — OpenAI Codex OAuth delegation.
 *
 * OpenAICodexTransport used to read ~/.claudish/codex-oauth.json directly in BOTH
 * getEndpoint() and getHeaders(), and minted OAuth headers / picked the chatgpt.com
 * endpoint inline. Step 5 moves all of that to credentials.getRequestAuth("openai-codex"),
 * cached by a new refreshAuth() (called by composed-handler BEFORE getEndpoint/getHeaders).
 *
 * This test pins:
 *   OAuth present → chatgpt.com/backend-api/codex/responses endpoint
 *                 + buildOAuthHeaders shape (6 headers w/ accountId)
 *                 + transformPayload adds store:false / include + model normalization
 *   No OAuth (key only) → api.openai.com static endpoint + Bearer <apiKey>
 *                 + transformPayload still normalizes model (pure, non-auth) but
 *                   does NOT add the store/include auth bits.
 *   OAuth present but its refresh REJECTED → the same api-key-shaped result, by a
 *                 different mechanism (cachedAuth null → super.getHeaders()).
 *
 * Hermetic: mock credentials.getRequestAuth (the delegation target), with each
 * fixture shaped like what the REAL half returns, `arm` included.
 *
 * "No OAuth" is NOT a throw. `CompositeCredentialProvider.getRequestAuth` falls
 * through to `this.fallback.getRequestAuth(ctx)`, and `ApiKeyCredentialProvider`
 * ALWAYS returns an artifact — `{arm:"api-key", headers:{Authorization:"Bearer …"}}`
 * with a key, `{arm:"api-key", headers:{}}` without one. It never returns null and
 * never throws. This file used to model the api-key arm as a throw, which is why it
 * stayed green while `refreshAuth` labelled every metered request `subscription`
 * (review round 1, C-1). The throw is a real path — an AVAILABLE OAuth primary
 * whose refresh is then rejected — so it keeps its own test below, and no longer
 * doubles as the api-key case.
 *
 * `refreshAuth()` also writes the process-wide signed-arm record
 * (auth/credentials/billing-probe.ts). Every test here that calls it must clear
 * that record, or the next FILE in the Bun run inherits a billing answer from a
 * fixture — see the afterEach.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearSignedArm } from "../../auth/credentials/billing-probe.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";

const FAKE_TOKEN = "codex-oauth-token-abc";
const FAKE_ACCOUNT = "acct-123";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// What the real CodexOAuthHalf.getRequestAuth() returns (buildOAuthHeaders + endpoint + transform).
const CODEX_OAUTH_AUTH = {
  // `arm` is part of the artifact the real half returns (codex-credential.ts) and
  // it is what refreshAuth() turns into the SUB billing label. A fixture that
  // omits it is not the OAuth artifact — it is an unmarked one, which the
  // transport reads as metered.
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
  transformPayload: (p: any) => ({
    ...p,
    store: false,
    include: ["reasoning.encrypted_content"],
  }),
};

// What the real ApiKeyCredentialProvider.getRequestAuth() returns for the same
// provider: a marked artifact with a Bearer header, NO endpoint, NO
// transformPayload. Never null, never a throw.
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

beforeEach(() => {
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => CODEX_OAUTH_AUTH as any);
});

afterEach(() => {
  mock.restore();
  // refreshAuth() ALWAYS calls recordSignedArm, so this endpoint/header suite
  // writes a process-wide billing record it never meant to touch. The record is
  // read BEFORE the presence probe (billing-probe.ts), and Bun runs every test
  // file in one process — so without this clear, the OAuth fixture above leaves
  // "subscription" behind and the next file answers
  // isSubscriptionProvider("openai-codex") = true on a machine where no
  // credential would sign. Measured: validation/fix2-residue-leak.txt.
  clearSignedArm("openai-codex");
});

describe("OpenAICodexTransport — OAuth present (delegated)", () => {
  test("refreshAuth → chatgpt.com endpoint + OAuth headers + store/include transform", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "ignored-api-key");
    await t.refreshAuth();

    // endpoint comes from cachedAuth
    expect(t.getEndpoint()).toBe(CODEX_ENDPOINT);

    // headers come from cachedAuth (the 6 OAuth headers w/ accountId)
    const headers = await t.getHeaders();
    expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["chatgpt-account-id"]).toBe(FAKE_ACCOUNT);
    expect(headers["x-conversation-id"]).toBe("claudish-session");
    expect(headers["x-session-id"]).toBe("claudish-session");

    // transformPayload adds the auth-derived store/include bits.
    const out = t.transformPayload({ model: "gpt-5.1-codex", input: "hi" });
    expect(out.store).toBe(false);
    expect(out.include).toEqual(["reasoning.encrypted_content"]);

    // delegates with the openai-codex catalog name
    expect(getRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getRequestAuthMock.mock.calls[0][0]).toBe("openai-codex");
  });
});

describe("OpenAICodexTransport — no OAuth (api-key half answers)", () => {
  beforeEach(() => {
    // What the composite ACTUALLY does with no OAuth: no throw, no null — it
    // returns the api-key half's artifact verbatim, `arm` and all
    // (composite-credential.ts, api-key-credential.ts). Endpoint-less, so the
    // transport lands on the base OpenAI path.
    getRequestAuthMock = mock(async () => API_KEY_AUTH);
  });

  test("refreshAuth → static api.openai.com endpoint + Bearer apiKey, no OAuth headers", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();

    // The artifact carries no endpoint override, so getEndpoint() falls to
    // super.getEndpoint() — the codex Responses endpoint on api.openai.com.
    expect(t.getEndpoint()).toBe("https://api.openai.com/v1/responses");

    // Headers are the api-key artifact's: Bearer <key>, nothing OAuth-shaped.
    const headers = await t.getHeaders();
    expect(headers.Authorization).toBe("Bearer sk-codex-key");
    expect(headers["OpenAI-Beta"]).toBeUndefined();
    expect(headers["chatgpt-account-id"]).toBeUndefined();
  });

  test("transformPayload normalizes model but does NOT add auth store/include bits", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();
    const out = t.transformPayload({ model: "gpt-5.1-codex", input: "y" });
    expect(out.store).toBeUndefined();
    expect(out.include).toBeUndefined();
    expect(typeof out.model).toBe("string");
  });
});

describe("OpenAICodexTransport — OAuth available but its refresh is rejected", () => {
  beforeEach(() => {
    // The ONLY way getRequestAuth throws: the composite took an AVAILABLE OAuth
    // primary and the refresh failed with something other than fallbackSignal
    // (Codex declares none), so it rethrows rather than falling through.
    getRequestAuthMock = mock(async () => {
      throw new Error("refresh_token rejected");
    });
  });

  test("refreshAuth swallows the throw → cachedAuth null → super endpoint + Bearer apiKey", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();

    // Same observable result as the api-key arm above, reached by a different
    // mechanism: null cachedAuth rather than an endpoint-less artifact. Keeping
    // both is the point — they were conflated once, and the billing label that
    // was inferred from "cachedAuth is null" was wrong for the api-key arm.
    expect(t.getEndpoint()).toBe("https://api.openai.com/v1/responses");
    const headers = await t.getHeaders();
    expect(headers.Authorization).toBe("Bearer sk-codex-key");
    expect(headers["chatgpt-account-id"]).toBeUndefined();

    const out = t.transformPayload({ model: "gpt-5.1-codex", input: "y" });
    expect(out.store).toBeUndefined();
    expect(out.include).toBeUndefined();
  });
});
