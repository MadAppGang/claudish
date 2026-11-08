import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokOAuth, type GrokOAuthCredentials, setGrokOAuthPathForTesting } from "./grok-oauth.js";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

interface DeviceAuthorizationFixture {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface GrokOAuthTestInternals {
  requestDeviceCode(clientId: string): Promise<DeviceAuthorizationFixture>;
  saveCredentials(credentials: GrokOAuthCredentials): void;
  deleteCredentials(): void;
  openBrowser(url: string, message?: string): Promise<void>;
  presentAuthUrl(url: string): () => void;
}

// The credential file is read lazily and re-read on change, so every test points
// GrokOAuth at a temp file (`setGrokOAuthPathForTesting`), never at the developer's
// real ~/.claudish/grok-oauth.json.
class HermeticGrokOAuth extends GrokOAuth {}

let credentialDir: string;
let credentialPath: string;

beforeEach(() => {
  credentialDir = mkdtempSync(join(tmpdir(), "claudish-grok-oauth-"));
  credentialPath = join(credentialDir, "grok-oauth.json");
  setGrokOAuthPathForTesting(credentialPath);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  setGrokOAuthPathForTesting(null);
  rmSync(credentialDir, { recursive: true, force: true });
});

/** Write the login another process (or an earlier session) left on disk. */
function seedCredentialFile(credentials: GrokOAuthCredentials): void {
  writeFileSync(credentialPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

function readCredentialFile(): GrokOAuthCredentials {
  return JSON.parse(readFileSync(credentialPath, "utf-8")) as GrokOAuthCredentials;
}

function internals(oauth: GrokOAuth): GrokOAuthTestInternals {
  return oauth as unknown as GrokOAuthTestInternals;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected promise to reject");
}

function deviceAuthorization(
  overrides: Partial<DeviceAuthorizationFixture> = {}
): DeviceAuthorizationFixture {
  return {
    device_code: "device-aaa",
    user_code: "USER-AAA",
    verification_uri: "https://auth.fixture.invalid/device",
    expires_in: 60,
    interval: 1,
    ...overrides,
  };
}

function useImmediateTimers(): number[] {
  const delays: number[] = [];
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    delays.push(Number(delay ?? 0));
    queueMicrotask(() => callback(...args));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  return delays;
}

function installLoginFetch(
  pollSteps: Array<Record<string, unknown> | Error>,
  auth: DeviceAuthorizationFixture = deviceAuthorization()
) {
  let call = 0;
  const fetchMock = mock(async () => {
    if (call++ === 0) return jsonResponse(auth);
    const next = pollSteps.shift();
    if (!next) throw new Error("fixture exhausted its token-poll responses");
    if (next instanceof Error) throw next;
    return jsonResponse(next);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function stubLoginSideEffects(oauth: GrokOAuth) {
  const state = internals(oauth);
  const disposePrompt = mock(() => {});
  const saveCredentials = mock((_credentials: GrokOAuthCredentials) => {});
  state.presentAuthUrl = mock(() => disposePrompt);
  state.openBrowser = mock(async () => {});
  state.saveCredentials = saveCredentials;
  return { disposePrompt, saveCredentials };
}

describe("GrokOAuth device authorization", () => {
  test("pins the public-client form and complete inference-capable scope set", async () => {
    const oauth = new HermeticGrokOAuth();
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(deviceAuthorization())
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await internals(oauth).requestDeviceCode("client-aaa");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://auth.x.ai/oauth2/device/code");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("client_id")).toBe("client-aaa");
    const scopes = form.get("scope")?.split(" ") ?? [];
    expect(scopes).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "grok-cli:access",
      "api:access",
      "conversations:read",
      "conversations:write",
      "workspaces:read",
      "workspaces:write",
    ]);
    // Login once succeeded without this scope, but every inference then failed with a 403.
    expect(scopes).toContain("api:access");
    // Login also stays deceptively green without this scope while issuing no refresh token.
    expect(scopes).toContain("offline_access");
    // auth.x.ai registers this CLI as a public client, so there is no secret to send.
    expect([...form.keys()].some((key) => /secret/i.test(key))).toBe(false);
  });

  test.each([
    [
      "a non-OK response",
      400,
      { error: "invalid_request", error_description: "fixture authorization rejected" },
      "fixture authorization rejected",
    ],
    [
      "a response missing device_code",
      200,
      {
        user_code: "USER-AAA",
        verification_uri: "https://auth.fixture.invalid/device",
        expires_in: 60,
        error_description: "fixture device code missing",
      },
      "fixture device code missing",
    ],
    [
      "a response missing user_code",
      200,
      {
        device_code: "device-aaa",
        verification_uri: "https://auth.fixture.invalid/device",
        expires_in: 60,
        error_description: "fixture user code missing",
      },
      "fixture user code missing",
    ],
  ])("surfaces the server message for %s", async (_case, status, body, message) => {
    const oauth = new HermeticGrokOAuth();
    globalThis.fetch = mock(async () => jsonResponse(body, status)) as unknown as typeof fetch;

    await expect(internals(oauth).requestDeviceCode("client-aaa")).rejects.toThrow(message);
  });
});

describe("GrokOAuth login polling", () => {
  test("keeps polling after authorization_pending and persists a refreshable credential", async () => {
    const oauth = new HermeticGrokOAuth();
    const { disposePrompt, saveCredentials } = stubLoginSideEffects(oauth);
    const delays = useImmediateTimers();
    const fetchMock = installLoginFetch([
      { error: "authorization_pending" },
      {
        access_token: "tok-aaa",
        refresh_token: "ref-aaa",
        expires_in: 3600,
        scope: "openid api:access offline_access",
      },
    ]);
    const beforeLogin = Date.now();

    await expect(oauth.login("client-aaa")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 1000]);
    expect(saveCredentials).toHaveBeenCalledTimes(1);
    const saved = saveCredentials.mock.calls[0][0];
    expect(saved).toMatchObject({
      access_token: "tok-aaa",
      refresh_token: "ref-aaa",
      client_id: "client-aaa",
    });
    // The stored deadline must describe a live token, not the poll completion instant.
    expect(saved.expires_at).toBeGreaterThan(beforeLogin);
    // Cleanup runs from finally so every completed login restores its URL prompt state.
    expect(disposePrompt).toHaveBeenCalledTimes(1);
  });

  test("keeps the RFC slow_down interval increase for every later poll", async () => {
    const oauth = new HermeticGrokOAuth();
    stubLoginSideEffects(oauth);
    const delays = useImmediateTimers();
    installLoginFetch([
      { error: "slow_down" },
      { error: "authorization_pending" },
      { access_token: "tok-aaa", refresh_token: "ref-aaa", expires_in: 3600 },
    ]);

    await expect(oauth.login("client-aaa")).resolves.toBeUndefined();

    // The second 6s delay proves the increase is permanent, not a one-shot bump.
    expect(delays).toEqual([1000, 6000, 6000]);
  });

  test("retries a network throw while the user may still be approving", async () => {
    const oauth = new HermeticGrokOAuth();
    const { saveCredentials } = stubLoginSideEffects(oauth);
    const delays = useImmediateTimers();
    installLoginFetch([
      new Error("fixture transient network failure"),
      { access_token: "tok-aaa", refresh_token: "ref-aaa", expires_in: 3600 },
    ]);

    await expect(oauth.login("client-aaa")).resolves.toBeUndefined();

    // A transport blip must not discard an authorization already in progress.
    expect(delays).toEqual([1000, 1000]);
    expect(saveCredentials).toHaveBeenCalledTimes(1);
  });

  test("rejects a terminal polling error and still disposes the prompt", async () => {
    const oauth = new HermeticGrokOAuth();
    const { disposePrompt, saveCredentials } = stubLoginSideEffects(oauth);
    useImmediateTimers();
    installLoginFetch([
      { error: "access_denied", error_description: "fixture user declined access" },
    ]);

    await expect(oauth.login("client-aaa")).rejects.toThrow("fixture user declined access");
    expect(saveCredentials).toHaveBeenCalledTimes(0);
    // Declined login still reaches finally; otherwise raw terminal mode could remain armed.
    expect(disposePrompt).toHaveBeenCalledTimes(1);
  });
});

describe("GrokOAuth refresh", () => {
  function expiredCredentials(): GrokOAuthCredentials {
    return {
      access_token: "tok-old",
      refresh_token: "ref-old",
      expires_at: 0,
      client_id: "client-aaa",
      scope: "openid api:access offline_access",
    };
  }

  test("uses a public-client refresh form and persists a rotated refresh token", async () => {
    const oauth = new HermeticGrokOAuth();
    seedCredentialFile(expiredCredentials());
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        access_token: "tok-aaa",
        refresh_token: "ref-aaa",
        expires_in: 3600,
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(oauth.getToken()).resolves.toBe("tok-aaa");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://auth.x.ai/oauth2/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "ref-old",
      client_id: "client-aaa",
    });
    // Public-client refresh must never grow an accidental confidential-client secret.
    expect([...form.keys()].some((key) => /secret/i.test(key))).toBe(false);
    // The refresh is committed to the credential file (refreshAndCommit), not to memory only.
    expect(readCredentialFile()).toMatchObject({
      access_token: "tok-aaa",
      refresh_token: "ref-aaa",
      client_id: "client-aaa",
    });
  });

  test("keeps the existing refresh token when the server does not rotate it", async () => {
    const oauth = new HermeticGrokOAuth();
    seedCredentialFile(expiredCredentials());
    globalThis.fetch = mock(async () =>
      jsonResponse({ access_token: "tok-aaa", expires_in: 3600 })
    ) as unknown as typeof fetch;

    await expect(oauth.getToken()).resolves.toBe("tok-aaa");

    // Dropping the old value here would strand the very next refresh attempt.
    expect(readCredentialFile().refresh_token).toBe("ref-old");
  });

  test("names claudish login grok when refresh fails", async () => {
    const oauth = new HermeticGrokOAuth();
    const state = internals(oauth);
    seedCredentialFile(expiredCredentials());
    const saveCredentials = mock((_credentials: GrokOAuthCredentials) => {});
    state.saveCredentials = saveCredentials;
    globalThis.fetch = mock(async () =>
      jsonResponse(
        { error: "invalid_grant", error_description: "fixture refresh token rejected" },
        400
      )
    ) as unknown as typeof fetch;

    const error = await rejectedError(oauth.getToken());
    expect(error.message).toContain("fixture refresh token rejected");
    expect(error.message).toContain("claudish login grok");
    expect(saveCredentials).toHaveBeenCalledTimes(0);
  });
});

describe("GrokOAuth logout", () => {
  function loggedInCredentials(): GrokOAuthCredentials {
    return {
      access_token: "tok-aaa",
      refresh_token: "ref-aaa",
      expires_at: Date.now() + 3600 * 1000,
      client_id: "client-aaa",
    };
  }

  test("revokes the refresh token before clearing local state", async () => {
    const oauth = new HermeticGrokOAuth();
    const state = internals(oauth);
    seedCredentialFile(loggedInCredentials());
    const order: string[] = [];
    const deleteCredentials = mock(() => order.push("delete"));
    state.deleteCredentials = deleteCredentials;
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      order.push("revoke");
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(oauth.logout()).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://auth.x.ai/oauth2/revoke");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      token: "ref-aaa",
      token_type_hint: "refresh_token",
      client_id: "client-aaa",
    });
    expect(order).toEqual(["revoke", "delete"]);
    expect(oauth.hasCredentials()).toBe(false);
  });

  test("clears local state even when revocation fails", async () => {
    const oauth = new HermeticGrokOAuth();
    const state = internals(oauth);
    seedCredentialFile(loggedInCredentials());
    const deleteCredentials = mock(() => {});
    state.deleteCredentials = deleteCredentials;
    globalThis.fetch = mock(async () => {
      throw new Error("fixture revocation unavailable");
    }) as unknown as typeof fetch;

    await expect(oauth.logout()).resolves.toBeUndefined();

    // Leaving a usable token on disk after logout is more surprising than failed revocation.
    expect(deleteCredentials).toHaveBeenCalledTimes(1);
    expect(oauth.hasCredentials()).toBe(false);
  });
});
