import { afterEach, describe, expect, test } from "bun:test";
import { CodexOAuth } from "../codex-oauth.js";
import { CodexOAuthHalf } from "./codex-credential.js";

const savedTestUpstream = process.env.CLAUDISH_TEST_UPSTREAM;

afterEach(() => {
  if (savedTestUpstream === undefined) delete process.env.CLAUDISH_TEST_UPSTREAM;
  else process.env.CLAUDISH_TEST_UPSTREAM = savedTestUpstream;
});

describe("CodexOAuthHalf forced signing", () => {
  test("delegates the 401 path to the gated single-flight exactly once", async () => {
    const calls: string[] = [];
    const fakeOAuth = {
      reloadCredentials(): void {
        calls.push("reload");
      },
      async refreshToken(): Promise<void> {
        calls.push("refresh");
      },
      async forceRefresh(): Promise<string> {
        calls.push("force");
        return "fresh-access-token";
      },
      async getAccessToken(): Promise<string> {
        calls.push("access");
        return "cached-access-token";
      },
      getAccountId(): string {
        calls.push("account");
        return "account-123";
      },
    };

    // Replace the singleton before CodexOAuthHalf's field initializer runs. This
    // is an injected in-memory collaborator: no credential file, network, or
    // macOS Keychain is read. Restore the prior singleton before leaving.
    const singleton = CodexOAuth as unknown as { instance: CodexOAuth | null };
    const previous = singleton.instance;
    singleton.instance = fakeOAuth as unknown as CodexOAuth;
    process.env.CLAUDISH_TEST_UPSTREAM = "chatgpt.com=http://127.0.0.1:4567";
    try {
      const half = new CodexOAuthHalf();
      const signed = await half.getRequestAuth({ model: "gpt-test", forceRefresh: true });

      expect(calls).toEqual(["force", "account"]);
      expect(signed.arm).toBe("oauth");
      expect(signed.headers.Authorization).toBe("Bearer fresh-access-token");
      expect(signed.endpoint).toBe("http://127.0.0.1:4567/backend-api/codex/responses");
    } finally {
      singleton.instance = previous;
    }

    // Mutation caught: restore the old reloadCredentials() -> refreshToken() ->
    // getAccessToken() sequence. That sequence clears the in-process flight and
    // bypasses the pool's cross-process refresh gate.
  });
});
