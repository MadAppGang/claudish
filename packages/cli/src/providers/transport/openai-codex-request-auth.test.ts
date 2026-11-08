import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexOAuth } from "../../auth/codex-oauth.js";
import { credentials } from "../../auth/credentials/authority.js";
import { clearSignedArm } from "../../auth/credentials/billing-probe.js";
import type {
  CredentialProvider,
  RequestAuth,
  RequestAuthContext,
} from "../../auth/credentials/types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { OpenAICodexTransport } from "./openai-codex.js";

const realFetch = globalThis.fetch;
const savedEnv = new Map(
  ["HOME", "CLAUDISH_ACCOUNTS_DIR", "CLAUDISH_TEST_UPSTREAM", "OPENAI_CODEX_API_KEY"].map(
    (name) => [name, process.env[name]]
  )
);
const tempRoots = new Set<string>();

const provider: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@", "codex@"],
};

function artifact(account: string): RequestAuth {
  return {
    arm: "oauth",
    endpoint: `https://chatgpt.test/${account}/responses`,
    headers: { Authorization: `Bearer ${account}` },
    transformPayload: (payload) => ({ ...payload, account }),
  };
}

type TestCredentialAuthority = {
  get?: (name: string) => CredentialProvider | undefined;
  register?: (provider: CredentialProvider, aliases?: string[]) => void;
  getRequestAuth?: (name: string, ctx: RequestAuthContext) => Promise<RequestAuth>;
};

let originalCredential: CredentialProvider | undefined;
let originalGetRequestAuth: TestCredentialAuthority["getRequestAuth"];
let replacementMode: "registry" | "method" | undefined;

function testCredentialAuthority(): TestCredentialAuthority {
  return credentials as unknown as TestCredentialAuthority;
}

function installCredentialForTest(provider: CredentialProvider): void {
  const authority = testCredentialAuthority();
  if (
    originalCredential &&
    typeof authority.get === "function" &&
    typeof authority.register === "function"
  ) {
    authority.register(provider, ["openai-codex"]);
    replacementMode = "registry";
    return;
  }
  if (typeof authority.getRequestAuth === "function") {
    authority.getRequestAuth = async (name, ctx) => {
      if (name === "openai-codex") return provider.getRequestAuth(ctx);
      if (originalGetRequestAuth) return originalGetRequestAuth.call(authority, name, ctx);
      throw new Error(`No credential provider for ${name}`);
    };
    replacementMode = "method";
    return;
  }
  throw new Error("Credential authority has no request-auth test seam");
}

beforeEach(() => {
  const authority = testCredentialAuthority();
  originalCredential =
    typeof authority.get === "function" ? authority.get("openai-codex") : undefined;
  originalGetRequestAuth =
    typeof authority.getRequestAuth === "function" ? authority.getRequestAuth : undefined;
  replacementMode = undefined;
});

afterEach(() => {
  const authority = testCredentialAuthority();
  if (
    replacementMode === "registry" &&
    originalCredential &&
    typeof authority.register === "function"
  ) {
    authority.register(originalCredential, ["openai-codex"]);
  } else if (
    replacementMode === "method" &&
    originalGetRequestAuth &&
    typeof authority.getRequestAuth === "function"
  ) {
    authority.getRequestAuth = originalGetRequestAuth;
  }
  clearSignedArm("openai-codex");
  globalThis.fetch = realFetch;
  CodexOAuth._resetInstanceForTests();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("OpenAICodexTransport request auth", () => {
  test("forwards forceRefresh to the credential authority instead of swallowing it", async () => {
    const contexts: RequestAuthContext[] = [];
    const fakeCredential: CredentialProvider = {
      catalogName: "openai-codex",
      isAvailable: async () => true,
      getRequestAuth: async (ctx) => {
        contexts.push({ ...ctx });
        return artifact(ctx.forceRefresh ? "fresh" : "cached");
      },
    };
    installCredentialForTest(fakeCredential);
    const transport = new OpenAICodexTransport(provider, "gpt-5.1-codex", "ignored");

    const cached = await transport.signRequest({});
    const fresh = await transport.signRequest({ forceRefresh: true });

    expect(contexts).toEqual([{ model: "" }, { model: "", forceRefresh: true }]);
    expect(cached.endpoint).toContain("/cached/");
    expect(fresh.endpoint).toContain("/fresh/");

    // Mutation caught: ignore ctx.forceRefresh in signRequest. The authority's
    // second context loses the flag and returns the cached artifact again.
  });

  test("endpoint, headers, and payload transformation use the explicit artifact", async () => {
    const fakeCredential: CredentialProvider = {
      catalogName: "openai-codex",
      isAvailable: async () => true,
      getRequestAuth: async () => artifact("unused"),
    };
    installCredentialForTest(fakeCredential);
    const transport = new OpenAICodexTransport(provider, "gpt-5.1-codex", "ignored");
    const first = artifact("account-A");
    const second = artifact("account-B");

    expect(transport.getEndpoint(undefined, { auth: first })).toBe(
      "https://chatgpt.test/account-A/responses"
    );
    expect(transport.getEndpoint(undefined, { auth: second })).toBe(
      "https://chatgpt.test/account-B/responses"
    );
    expect(await transport.getHeaders(undefined, { auth: first })).toEqual({
      Authorization: "Bearer account-A",
    });
    expect(await transport.getHeaders(undefined, { auth: second })).toEqual({
      Authorization: "Bearer account-B",
    });
    expect(
      transport.transformPayload({ model: "gpt-5.1-codex" }, undefined, { auth: first }).account
    ).toBe("account-A");
    expect(
      transport.transformPayload({ model: "gpt-5.1-codex" }, undefined, { auth: second }).account
    ).toBe("account-B");

    // Mutation caught: restore cachedAuth as the request path and ignore the
    // trailing artifact arguments. Two explicit artifacts then collapse to one.
  });

  test("failed OAuth refresh never signs a metered request even when a key exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-codex-no-downgrade-"));
    tempRoots.add(root);
    const home = join(root, "home");
    const credentialDir = join(home, ".claudish");
    mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(credentialDir, "codex-oauth.json"),
      JSON.stringify({
        // PROVISIONAL: constructed OAuth credential fixture. Replace with a
        // sanitized real codex-oauth.json capture when one is available.
        access_token: "subscription-access",
        refresh_token: "subscription-refresh",
        expires_at: Date.now() + 3_600_000,
        account_id: "subscription-account",
      }),
      { mode: 0o600 }
    );
    const canary = "sk-codex-metered-canary-never-send";
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      const src = process.env.TEST_SRC;
      const calls = [];
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith("http://127.0.0.1:")) throw new Error("non-loopback request forbidden");
        calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        if (url === "http://127.0.0.1:4102/oauth/token") return Response.json({ error: "invalid_grant", error_description: "refresh token revoked" }, { status: 400 });
        return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
      };
      const { OpenAICodexTransport } = await import(src + "/providers/transport/openai-codex.ts");
      const { ComposedHandler } = await import(src + "/handlers/composed-handler.ts");
      const { Hono } = await import("hono");
      const transport = new OpenAICodexTransport(${JSON.stringify(provider)}, "gpt-5.1-codex", "ignored");
      const handler = new ComposedHandler(transport, "gpt-5.1-codex", "gpt-5.1-codex", 8080, { codeMode: "off" });
      const app = new Hono();
      app.post("/", c => handler.handle(c, { model: "gpt-5.1-codex", max_tokens: 16, messages: [{ role: "user", content: "refresh must not downgrade" }] }));
      const response = await app.request("http://localhost/", { method: "POST" });
      console.log(JSON.stringify({ status: response.status, body: await response.json(), calls }));
      process.exit(0);
    `,
      ],
      {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_ACCOUNTS_FAULT: "",
          CLAUDISH_TEST_UPSTREAM:
            "chatgpt.com=http://127.0.0.1:4101,auth.openai.com=http://127.0.0.1:4102,api.openai.com=http://127.0.0.1:4103",
          OPENAI_CODEX_API_KEY: canary,
          TEST_SRC: join(import.meta.dir, "../.."),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    const calls = result.calls;
    expect(result.status).toBe(400);
    expect(result.body?.error?.upstream_status).toBe(401);
    expect(result.body?.error?.message).toContain("claudish login codex");
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:4101/backend-api/codex/responses",
        authorization: "Bearer subscription-access",
      },
      {
        url: "http://127.0.0.1:4102/oauth/token",
        authorization: null,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(canary);

    // Mutation caught: turn the refresh failure into a plain/bare 401, or catch
    // it and degrade to the api-key arm. The hint disappears or a metered request
    // reaches the 4103 canary target carrying OPENAI_CODEX_API_KEY.
  });
});
