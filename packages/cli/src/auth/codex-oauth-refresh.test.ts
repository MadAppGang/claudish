import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { accountLockPath, legacyCodexCredentialsPath } from "./accounts/paths.js";
import { LEGACY_CODEX_ACCOUNT_ID } from "./accounts/types.js";
import { CodexOAuth, CodexOAuthRefreshError } from "./codex-oauth.js";

const realFetch = globalThis.fetch;
const savedEnv = new Map(
  [
    "HOME",
    "CLAUDISH_ACCOUNTS_DIR",
    "CLAUDISH_TEST_UPSTREAM",
    "CLAUDISH_DISABLE_KEYCHAIN",
    "CLAUDISH_DISABLE_OP",
  ].map((name) => [name, process.env[name]])
);
const tempRoots = new Set<string>();

interface ProvisionalTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * PROVISIONAL: constructed OAuth token response. Replace it with a sanitized
 * capture from the Phase V rotating-token probe when that capture exists.
 */
function provisionalTokenResponse(
  accessToken: string,
  refreshToken: string
): ProvisionalTokenResponse {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3_600,
    token_type: "bearer",
  };
}

/**
 * PROVISIONAL: constructed legacy credential document. Replace its OAuth field
 * layout with a sanitized real codex-oauth.json capture when one is available.
 */
function credentialDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "access-old",
    refresh_token: "refresh-old",
    expires_at: Date.now() + 3_600_000,
    account_id: "account-old",
    claudish_generation: 5,
    claudish_journal: {
      status: "pending",
      predecessor: "refresh-old-fingerprint",
      intended: "refresh-new-fingerprint",
    },
    future_pool_key: { keep: true },
    ...overrides,
  };
}

function makeSandbox(): {
  root: string;
  home: string;
  accountsDir: string;
  credentialPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "claudish-codex-oauth-"));
  tempRoots.add(root);
  const home = join(root, "home");
  const accountsDir = join(root, "accounts");
  mkdirSync(join(home, ".claudish"), { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  process.env.CLAUDISH_ACCOUNTS_DIR = accountsDir;
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  process.env.CLAUDISH_DISABLE_OP = "1";
  CodexOAuth._resetInstanceForTests();
  return {
    root,
    home,
    accountsDir,
    credentialPath: legacyCodexCredentialsPath(),
  };
}

function seedCredentialFile(path: string, document = credentialDocument()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(document, null, 2), { mode: 0o644 });
  chmodSync(path, 0o644);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Codex OAuth child barrier");
    await sleep(5);
  }
}

interface ChildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function collectChild(child: ReturnType<typeof forcedRefreshChild>): Promise<ChildResult> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function forcedRefreshChild(
  moduleUrl: string,
  readyPath: string,
  goPath: string,
  env: Record<string, string | undefined>
) {
  const source = `
    import { existsSync, writeFileSync } from "node:fs";
    const { CodexOAuth } = await import(${JSON.stringify(moduleUrl)});
    const oauth = CodexOAuth.getInstance();
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
    while (!existsSync(${JSON.stringify(goPath)})) await Bun.sleep(2);
    try {
      const token = await oauth.forceRefresh();
      process.stdout.write(JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
      process.stderr.write(error?.stack ?? String(error));
      process.exitCode = 1;
    }
  `;
  return Bun.spawn([process.execPath, "--eval", source], {
    cwd: import.meta.dir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  CodexOAuth._resetInstanceForTests();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("CodexOAuth forced refresh coordination", () => {
  test("joins concurrent forced refreshes into one in-process exchange", async () => {
    const sandbox = makeSandbox();
    seedCredentialFile(sandbox.credentialPath);
    process.env.CLAUDISH_TEST_UPSTREAM = "auth.openai.com=http://127.0.0.1:9";
    let exchangeRequests = 0;
    globalThis.fetch = (async () => {
      exchangeRequests++;
      await Bun.sleep(50);
      // Deliberately keep the access token text unchanged while rotating the
      // refresh token. Without the in-process flight, queued calls cannot adopt
      // by access-token comparison and each performs another exchange.
      return Response.json(provisionalTokenResponse("access-old", "refresh-rotated"));
    }) as unknown as typeof fetch;

    const oauth = CodexOAuth.getInstance();
    oauth.reloadCredentials();
    const tokens = await Promise.all(Array.from({ length: 8 }, () => oauth.forceRefresh()));

    expect(tokens).toEqual(Array.from({ length: 8 }, () => "access-old"));
    expect(exchangeRequests).toBe(1);

    // Mutation caught: remove forceRefresh()'s refreshPromise join. The same
    // access token is not adoptable, so all eight queued flights exchange.
  });

  test("serializes forced refreshes across independent OS processes", async () => {
    const sandbox = makeSandbox();
    seedCredentialFile(sandbox.credentialPath);
    const goPath = join(sandbox.root, "go");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "codex-oauth.ts")).href;
    let exchangeRequests = 0;
    let validRefreshToken = "refresh-old";
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        exchangeRequests++;
        const body = (await request.json()) as { refresh_token?: string };
        if (body.refresh_token !== validRefreshToken) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        validRefreshToken = "refresh-rotated";
        await Bun.sleep(150);
        return Response.json(provisionalTokenResponse("access-rotated", validRefreshToken));
      },
    });

    try {
      const children = Array.from({ length: 4 }, (_, index) => {
        const readyPath = join(sandbox.root, `ready-${index}`);
        return {
          readyPath,
          process: forcedRefreshChild(moduleUrl, readyPath, goPath, {
            ...process.env,
            HOME: sandbox.home,
            CLAUDISH_ACCOUNTS_DIR: sandbox.accountsDir,
            CLAUDISH_TEST_UPSTREAM: `auth.openai.com=${endpoint.url.origin}`,
            CLAUDISH_DISABLE_KEYCHAIN: "1",
            CLAUDISH_DISABLE_OP: "1",
          }),
        };
      });

      await waitFor(() => children.every((child) => existsSync(child.readyPath)));
      writeFileSync(goPath, "go");
      const results = await Promise.all(children.map((child) => collectChild(child.process)));

      expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
      expect(results.map((result) => result.stderr)).toEqual(["", "", "", ""]);
      const outputs = results.map(
        (result) => JSON.parse(result.stdout) as { pid: number; token: string }
      );
      expect(new Set(outputs.map((output) => output.pid)).size).toBe(4);
      expect(outputs.map((output) => output.token)).toEqual([
        "access-rotated",
        "access-rotated",
        "access-rotated",
        "access-rotated",
      ]);
      expect(exchangeRequests).toBe(1);
      const persisted = JSON.parse(readFileSync(sandbox.credentialPath, "utf8"));
      expect(persisted.claudish_generation).toBe(6);

      // Mutation caught: bypass the in-process flight/gate or skip the under-gate
      // re-read. More than one OS process reaches the rotating token endpoint.
    } finally {
      endpoint.stop(true);
    }
  }, 15_000);

  test("adopts a token another process wrote and performs zero exchanges", async () => {
    const sandbox = makeSandbox();
    seedCredentialFile(sandbox.credentialPath);
    const readyPath = join(sandbox.root, "ready");
    const goPath = join(sandbox.root, "go");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "codex-oauth.ts")).href;
    let exchangeRequests = 0;
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        exchangeRequests++;
        return Response.json(provisionalTokenResponse("unexpected", "unexpected"));
      },
    });

    try {
      const child = forcedRefreshChild(moduleUrl, readyPath, goPath, {
        ...process.env,
        HOME: sandbox.home,
        CLAUDISH_ACCOUNTS_DIR: sandbox.accountsDir,
        CLAUDISH_TEST_UPSTREAM: `auth.openai.com=${endpoint.url.origin}`,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
      });
      await waitFor(() => existsSync(readyPath));

      // The child already cached access-old. This parent process is the other
      // writer: it publishes a fresh token before allowing the child to refresh.
      seedCredentialFile(
        sandbox.credentialPath,
        credentialDocument({
          access_token: "access-from-other-process",
          refresh_token: "refresh-from-other-process",
          claudish_generation: 6,
        })
      );
      writeFileSync(goPath, "go");
      const result = await collectChild(child);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ token: "access-from-other-process" });
      expect(exchangeRequests).toBe(0);

      // Mutation caught: exchange before the locked disk re-read, or compare only
      // expiry and not the rejected bearer. The token endpoint is contacted.
    } finally {
      endpoint.stop(true);
    }
  }, 15_000);

  test("uses the legacy pool account's exact lock file", async () => {
    const sandbox = makeSandbox();
    seedCredentialFile(sandbox.credentialPath);
    process.env.CLAUDISH_TEST_UPSTREAM = "auth.openai.com=http://127.0.0.1:9";
    const lockPath = accountLockPath("openai-codex", LEGACY_CODEX_ACCOUNT_ID);
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 42,
        host: "foreign-test-host",
        nonce: "held-by-the-pool",
        at: Date.now(),
      })}\n`,
      { mode: 0o600 }
    );
    let exchangeRequests = 0;
    globalThis.fetch = (async () => {
      exchangeRequests++;
      return Response.json(provisionalTokenResponse("unexpected", "unexpected"));
    }) as unknown as typeof fetch;

    const oauth = CodexOAuth.getInstance();
    oauth.reloadCredentials();
    let thrown: unknown;
    try {
      await oauth.forceRefresh();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(CodexOAuthRefreshError);
    expect(thrown).toMatchObject({ transient: true, upstreamStatus: 503 });
    expect((thrown as { terminal?: boolean }).terminal).toBeUndefined();
    expect((thrown as Error).message).toContain("foreign-host");
    expect((thrown as Error).message).not.toContain("claudish login");
    expect(exchangeRequests).toBe(0);

    // Mutation caught: remove the gate or use any path other than the pool's
    // accountLockPath(openai-codex, legacy-codex). The exchange then proceeds.
  });
});

describe("CodexOAuth refresh failure verdicts", () => {
  for (const reason of ["timeout", "foreign-host", "unwritable"] as const) {
    test(`${reason} refresh gate has the correct error and handler verdict without signing or exchange`, () => {
      const sandbox = makeSandbox();
      seedCredentialFile(sandbox.credentialPath);
      const moduleUrl = pathToFileURL(join(import.meta.dir, "codex-oauth.ts")).href;
      const handlerUrl = pathToFileURL(
        join(import.meta.dir, "../handlers/composed-handler.ts")
      ).href;
      const source = `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { dirname, join } from "node:path";
        const { CodexOAuth, CodexOAuthRefreshError } = await import(${JSON.stringify(moduleUrl)});
        const { ComposedHandler } = await import(${JSON.stringify(handlerUrl)});
        const reason = ${JSON.stringify(reason)};
        const oauth = CodexOAuth.getInstance();
        oauth.reloadCredentials();
        const lockPath = join(process.env.CLAUDISH_ACCOUNTS_DIR, "test-locks", "held.lock");
        mkdirSync(dirname(lockPath), { recursive: true });
        if (reason === "unwritable") {
          writeFileSync(dirname(lockPath) + "/blocked", "not a directory");
        } else {
          writeFileSync(lockPath, JSON.stringify({
            pid: process.pid,
            host: reason === "foreign-host" ? "foreign-test-host" : "local-test-host",
            nonce: "held-by-test",
            at: 1000,
          }));
        }
        let clock = 1000;
        oauth._setRefreshGateOptionsForTests({
          path: reason === "unwritable" ? dirname(lockPath) + "/blocked/held.lock" : lockPath,
          deps: {
            now: () => clock,
            hostname: () => "local-test-host",
            isProcessAlive: () => true,
            sleep: async (ms) => { clock += ms; },
          },
        });
        let exchanges = 0;
        globalThis.fetch = async (input) => {
          if (!String(input).includes("/oauth/token")) return new Response(null, { status: 404 });
          exchanges++;
          throw new Error("must never exchange without the gate");
        };
        let failure;
        try { await oauth.forceRefresh(); }
        catch (error) {
          failure = {
            terminalClass: error instanceof CodexOAuthRefreshError,
            transient: error.transient,
            terminal: error.terminal,
            upstreamStatus: error.upstreamStatus,
            message: error.message,
          };
        }
        const signedArms = [];
        const transport = {
          name: "openai-codex", displayName: "OpenAI Codex", streamFormat: "openai-sse",
          signRequest: async () => {
            const token = await oauth.forceRefresh();
            signedArms.push("oauth");
            return { arm: "oauth", headers: { Authorization: "Bearer " + token } };
          },
          getEndpoint: () => "http://upstream.test/inference",
          getHeaders: async (_request, auth) => auth.headers,
        };
        const handler = new ComposedHandler(transport, "auth-test-model", "auth-test-model", 8080, {});
        const response = await handler.handle({
          req: { header: () => ({}) }, header: () => {},
          json: (body, status = 200, headers) => Response.json(body, { status, headers }),
        }, { model: "auth-test-model", max_tokens: 16, messages: [{ role: "user", content: "gate" }] });
        process.stdout.write(JSON.stringify({
          failure, exchanges, signedArms,
          status: response.status,
          verdict: response.headers.get("x-claudish-auth-verdict"),
        }));
      `;
      try {
        const child = Bun.spawnSync([process.execPath, "--eval", source], {
          env: { ...process.env, HOME: sandbox.home, CLAUDISH_ACCOUNTS_DIR: sandbox.accountsDir },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(child.exitCode).toBe(0);
        const result = JSON.parse(new TextDecoder().decode(child.stdout));
        expect(result.exchanges).toBe(0);
        expect(result.signedArms).toEqual([]);
        if (reason === "unwritable") {
          // implementation-log.md § v14 merge fixes / M2: local gate failure
          // is transient and cannot invent an upstream credential rejection.
          expect(result.failure).toMatchObject({ terminalClass: false, transient: true });
          expect(result.failure.terminal).toBeUndefined();
          expect(result.failure.upstreamStatus).toBeUndefined();
          expect(result.failure.message).toContain("refresh lock");
          expect(result.failure.message).toContain("claudish login codex");
          expect(result.status).toBe(503);
          expect(result.verdict).toBe("transient");
        } else {
          expect(result.failure).toMatchObject({
            terminalClass: false,
            transient: true,
            upstreamStatus: 503,
          });
          expect(result.failure.terminal).toBeUndefined();
          expect(result.failure.message).toContain(reason);
          expect(result.failure.message).not.toContain("claudish login");
          expect(result.status).toBe(503);
          expect(result.verdict).toBe("transient");
        }
      } finally {
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    });
  }

  for (const code of [undefined, "ECONNRESET"]) {
    test(`an unreadable 2xx token body (${code ?? "unknown"}) leads with login and never persists or re-exchanges`, async () => {
      const sandbox = makeSandbox();
      seedCredentialFile(sandbox.credentialPath);
      const before = readFileSync(sandbox.credentialPath, "utf8");
      process.env.CLAUDISH_TEST_UPSTREAM = "auth.openai.com=http://127.0.0.1:9";
      const bodyError = Object.assign(new Error("token body unreadable"), code ? { code } : {});
      let exchanges = 0;
      globalThis.fetch = (async () => {
        exchanges++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(bodyError);
            },
          }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;
      try {
        const oauth = CodexOAuth.getInstance();
        oauth.reloadCredentials();
        let failure: unknown;
        try {
          await oauth.forceRefresh();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(CodexOAuthRefreshError);
        expect(failure).toMatchObject({ terminal: true, upstreamStatus: 401 });
        expect((failure as Error).message).toStartWith("Run `claudish login codex`");
        expect((failure as Error).message).toContain(
          "only if another claudish process already saved a newer token"
        );
        expect(exchanges).toBe(1);
        expect(readFileSync(sandbox.credentialPath, "utf8")).toBe(before);
      } finally {
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    });
  }
});

describe("CodexOAuth shared credential-file writes", () => {
  test("refresh and login preserve pool keys, advance generation, and enforce 0600", async () => {
    const sandbox = makeSandbox();
    const journal = credentialDocument().claudish_journal;
    seedCredentialFile(sandbox.credentialPath);
    process.env.CLAUDISH_TEST_UPSTREAM = "auth.openai.com=http://127.0.0.1:9";
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      );
      return Response.json(provisionalTokenResponse("access-refreshed", "refresh-refreshed"));
    }) as unknown as typeof fetch;

    const oauth = CodexOAuth.getInstance();
    oauth.reloadCredentials();
    expect(await oauth.forceRefresh()).toBe("access-refreshed");

    const afterRefresh = JSON.parse(readFileSync(sandbox.credentialPath, "utf8"));
    expect(afterRefresh.claudish_generation).toBe(6);
    expect(afterRefresh.claudish_journal).toEqual(journal);
    expect(afterRefresh.future_pool_key).toEqual({ keep: true });
    expect(statSync(sandbox.credentialPath).mode & 0o777).toBe(0o600);
    expect(requestedUrls).toEqual(["http://127.0.0.1:9/oauth/token"]);

    await oauth.login({
      browser: async () => {},
      callback: async (opts) => ({
        authCode: "provisional-auth-code",
        state: opts.state,
        redirectUri: "http://localhost:1455/auth/callback",
      }),
      fetch: (async () =>
        Response.json(
          provisionalTokenResponse("access-from-login", "refresh-from-login")
        )) as unknown as typeof fetch,
    });

    const afterLogin = JSON.parse(readFileSync(sandbox.credentialPath, "utf8"));
    expect(afterLogin.claudish_generation).toBe(7);
    expect(afterLogin.claudish_journal).toEqual(journal);
    expect(afterLogin.future_pool_key).toEqual({ keep: true });
    expect(statSync(sandbox.credentialPath).mode & 0o777).toBe(0o600);

    // Mutation caught: restore either whole-document write, stop bumping the
    // generation, or drop the explicit chmod from the atomic publisher.
  });
});
