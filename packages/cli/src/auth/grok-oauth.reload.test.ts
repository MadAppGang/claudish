import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudishGrokOAuthPath,
  hasClaudishGrokOAuth,
  resolveGrokAccessToken,
  setClaudishGrokOAuthPathForTesting,
  setGrokHomeForTesting,
} from "../providers/grok/grok-credentials";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log";
import { GrokOAuth, type GrokOAuthCredentials, setGrokOAuthPathForTesting } from "./grok-oauth";

const first = {
  access_token: "OPAQUE_TEST_TOKEN_abc",
  refresh_token: "OPAQUE_TEST_TOKEN_refresh",
  client_id: "TEST-CLIENT-ID",
  expires_at: Number.MAX_SAFE_INTEGER,
} satisfies GrokOAuthCredentials;
const newer = {
  ...first,
  access_token: "OPAQUE_TEST_TOKEN_new_login",
  refresh_token: "OPAQUE_TEST_TOKEN_new_lineage",
};
const realFetch = globalThis.fetch;
let root: string;
let path: string;
let oauth: GrokOAuth;
let fetches: ReturnType<typeof mock>;

function write(login: GrokOAuthCredentials, atomic = false) {
  if (atomic) {
    const next = join(root, "replacement.json");
    writeFileSync(next, JSON.stringify(login));
    renameSync(next, path);
  } else {
    writeFileSync(path, JSON.stringify(login));
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w1-grok-reload-"));
  path = join(root, "grok-oauth.json");
  setGrokHomeForTesting(root);
  setGrokOAuthPathForTesting(path);
  oauth = new GrokOAuth();
  fetches = mock(async () => {
    throw new Error("Unexpected network in W1 Grok reload tests");
  });
  globalThis.fetch = fetches as unknown as typeof fetch;
  startLogCapture();
});

afterEach(async () => {
  try {
    const lines = (await capturedLines()).join("\n");
    expect(lines).not.toContain("OPAQUE_TEST_TOKEN");
    for (const login of [first, newer]) {
      expect(lines).not.toContain(login.access_token);
      expect(lines).not.toContain(login.refresh_token);
    }
    expect(fetches).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = realFetch;
    stopLogCapture();
    setGrokOAuthPathForTesting(null);
    setClaudishGrokOAuthPathForTesting(null);
    setGrokHomeForTesting(null);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("W1 Grok public reload behavior without token exchanges", () => {
  test("G1 1.1 the next getToken adopts a renamed login without a fetch", async () => {
    write(first);
    expect(await oauth.getToken()).toBe(first.access_token);
    write(newer, true);
    expect(await oauth.getToken()).toBe(newer.access_token);
    expect(oauth.hasCredentials()).toBe(true);
  }, 5_000);

  test("G1 1.2 the next getToken adopts an in-place login on the same inode", async () => {
    write(first);
    expect(await oauth.getToken()).toBe(first.access_token);
    const ino = statSync(path).ino;
    write(newer);
    expect(statSync(path).ino).toBe(ino);
    expect(await oauth.getToken()).toBe(newer.access_token);
  }, 5_000);

  test("G1 1.3 sync happens before deciding an expired cached token needs refresh", async () => {
    write({ ...first, expires_at: 1 });
    expect(oauth.hasCredentials()).toBe(true);
    write(newer, true);
    expect(await oauth.getToken()).toBe(newer.access_token);
  }, 5_000);

  test("G1 1.10 forced refresh adopts a new login instead of refreshing the stale token", async () => {
    write(first);
    expect(await oauth.getToken()).toBe(first.access_token);
    write(newer, true);
    await oauth.refreshToken();
    expect(await oauth.getToken()).toBe(newer.access_token);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(newer);
  }, 5_000);

  test("G1 1.8 deleting the credential file signs out an already-loaded instance", async () => {
    write(first);
    expect(await oauth.getToken()).toBe(first.access_token);
    unlinkSync(path);
    await expect(oauth.getToken()).rejects.toThrow("No GrokOAuth credentials found");
    expect(oauth.hasCredentials()).toBe(false);
  }, 5_000);

  for (const torn of ["", '{"access_token":"OPAQUE_TEST_TOKEN_abc"']) {
    test(`G3 1.16/1.17 torn own file (${torn.length} bytes) keeps the login and retries`, async () => {
      write(first);
      expect(await oauth.getToken()).toBe(first.access_token);
      writeFileSync(path, torn);
      expect(await oauth.getToken()).toBe(first.access_token);
      expect(oauth.hasCredentials()).toBe(true);
      expect((await capturedLines()).join("\n")).toContain(
        `[GrokOAuth] credential file unreadable (${path}); kept the last good credentials`
      );
      write(newer);
      expect(await oauth.getToken()).toBe(newer.access_token);
    }, 5_000);
  }

  test("G3 1.19 a corrupt first read has no last good login to return", async () => {
    writeFileSync(path, "");
    expect(oauth.hasCredentials()).toBe(false);
    await expect(oauth.getToken()).rejects.toThrow("No GrokOAuth credentials found");
  }, 5_000);

  test("G4 a corrupt initial file never appears in the terminal error text", async () => {
    writeFileSync(path, '{"access_token":"OPAQUE_TEST_TOKEN_abc"');
    const failure: unknown = await oauth.getToken().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("No GrokOAuth credentials found");
    expect(String(failure)).not.toContain(first.access_token);
    expect(String(failure)).not.toContain(first.refresh_token);
  }, 5_000);

  test("G4 reload logs identify the change without printing the parsed credential", async () => {
    write(first);
    await oauth.getToken();
    write(newer, true);
    await oauth.getToken();
    expect((await capturedLines()).join("\n")).toContain(
      "[GrokOAuth] credential file changed on disk; reloaded"
    );
  }, 5_000);

  test("G1 Grok own-file discovery and token use share either path override", async () => {
    setClaudishGrokOAuthPathForTesting(path);
    write(first);
    expect(claudishGrokOAuthPath()).toBe(path);
    expect(hasClaudishGrokOAuth()).toBe(true);
    expect(await oauth.getToken()).toBe(first.access_token);
  }, 5_000);

  test("G1 the Grok CLI credential is re-read after another writer logs in", async () => {
    const cliPath = join(root, "auth.json");
    const scope = "https://auth.x.ai::TEST-CLIENT-ID";
    const cli = (key: string) => ({
      [scope]: {
        key,
        refresh_token: "OPAQUE_TEST_TOKEN_cli_refresh",
        expires_at: "2999-01-01T00:00:00.000Z",
        oidc_client_id: "TEST-CLIENT-ID",
        oidc_issuer: "https://auth.x.ai",
        auth_mode: "oidc",
      },
    });
    writeFileSync(cliPath, JSON.stringify(cli(first.access_token)));
    expect(await resolveGrokAccessToken()).toBe(first.access_token);
    writeFileSync(cliPath, JSON.stringify(cli(newer.access_token)));
    expect(await resolveGrokAccessToken()).toBe(newer.access_token);
  }, 5_000);
});
