import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Import Kimi only in the child: Bun fixes homedir() when the process starts.
if (process.env.CLAUDISH_W1_KIMI_CHILD !== "1") {
  test("W1 Kimi contracts run with HOME redirected before any production import", async () => {
    const home = mkdtempSync(join(tmpdir(), "w1-kimi-home-"));
    try {
      const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
        cwd: resolve(import.meta.dir, "../../../.."),
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_W1_KIMI_CHILD: "1",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stdout + stderr).toBe(0);
      expect(stdout + stderr).toContain("0 fail");
      process.stdout.write(stdout + stderr);
      expect(existsSync(join(home, ".claudish", "kimi-device-id"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const { KimiOAuth, setKimiOAuthPathForTesting, setKimiDeviceIdPathForTesting } = await import(
    "./kimi-oauth"
  );
  const { capturedLines, startLogCapture, stopLogCapture } = await import(
    "../recovery/test-helpers/capture-log"
  );
  const first = {
    access_token: "OPAQUE_TEST_TOKEN_abc",
    refresh_token: "OPAQUE_TEST_TOKEN_refresh",
    expires_at: Number.MAX_SAFE_INTEGER,
    scope: "openid",
    token_type: "Bearer",
  };
  const newer = {
    ...first,
    access_token: "OPAQUE_TEST_TOKEN_new_login",
    refresh_token: "OPAQUE_TEST_TOKEN_new_lineage",
  };
  const realFetch = globalThis.fetch;
  let root: string;
  let path: string;
  let devicePath: string;
  let fetches: ReturnType<typeof mock>;

  function write(login: typeof first, atomic = false) {
    if (atomic) {
      const next = join(root, "replacement.json");
      writeFileSync(next, JSON.stringify(login));
      renameSync(next, path);
    } else {
      writeFileSync(path, JSON.stringify(login));
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "w1-kimi-reload-"));
    path = join(root, "kimi-oauth.json");
    devicePath = join(root, "device", "id");
    setKimiOAuthPathForTesting(path);
    setKimiDeviceIdPathForTesting(devicePath);
    KimiOAuth._resetForTests();
    fetches = mock(async () => {
      throw new Error("Unexpected network in W1 Kimi reload tests");
    });
    globalThis.fetch = fetches as unknown as typeof fetch;
    startLogCapture();
  });

  afterEach(async () => {
    try {
      const lines = (await capturedLines()).join("\n");
      for (const login of [first, newer]) {
        expect(lines).not.toContain(login.access_token);
        expect(lines).not.toContain(login.refresh_token);
      }
      expect(fetches).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      stopLogCapture();
      KimiOAuth._resetForTests();
      setKimiOAuthPathForTesting(null);
      setKimiDeviceIdPathForTesting(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("W1 Kimi public reload behavior without token exchanges", () => {
    test("G1 1.1 a long-lived singleton adopts a renamed login", async () => {
      const oauth = KimiOAuth.getInstance();
      write(first);
      expect(await oauth.getAccessToken()).toBe(first.access_token);
      write(newer, true);
      expect(await oauth.getAccessToken()).toBe(newer.access_token);
      expect(oauth.hasCredentials()).toBe(true);
    }, 5_000);

    test("G1 1.2 an in-place login on the same inode is reloaded", async () => {
      const oauth = KimiOAuth.getInstance();
      write(first);
      expect(await oauth.getAccessToken()).toBe(first.access_token);
      const ino = statSync(path).ino;
      write(newer);
      expect(statSync(path).ino).toBe(ino);
      expect(await oauth.getAccessToken()).toBe(newer.access_token);
    }, 5_000);

    test("G1 1.3 a newer login is checked before refreshing the expired cached token", async () => {
      const oauth = KimiOAuth.getInstance();
      write({ ...first, expires_at: 1 });
      expect(oauth.hasCredentials()).toBe(true);
      write(newer, true);
      expect(await oauth.getAccessToken()).toBe(newer.access_token);
    }, 5_000);

    test("G1 1.8 a deleted login clears both token use and credential presence", async () => {
      const oauth = KimiOAuth.getInstance();
      write(first);
      expect(await oauth.getAccessToken()).toBe(first.access_token);
      unlinkSync(path);
      await expect(oauth.getAccessToken()).rejects.toThrow("No Kimi OAuth credentials found");
      expect(oauth.hasCredentials()).toBe(false);
    }, 5_000);

    for (const torn of ["", '{"access_token":"OPAQUE_TEST_TOKEN_abc"']) {
      test(`G3 1.16/1.17 a torn Kimi file (${torn.length} bytes) keeps the last good login`, async () => {
        const oauth = KimiOAuth.getInstance();
        write(first);
        expect(await oauth.getAccessToken()).toBe(first.access_token);
        writeFileSync(path, torn);
        expect(await oauth.getAccessToken()).toBe(first.access_token);
        expect(oauth.hasCredentials()).toBe(true);
        expect((await capturedLines()).join("\n")).toContain(
          `[KimiOAuth] credential file unreadable (${path}); kept the last good credentials`
        );
        write(newer);
        expect(await oauth.getAccessToken()).toBe(newer.access_token);
      }, 5_000);
    }

    test("G3 1.19 no last good login means a corrupt initial file is unauthenticated", async () => {
      writeFileSync(path, "");
      const oauth = KimiOAuth.getInstance();
      expect(oauth.hasCredentials()).toBe(false);
      await expect(oauth.getAccessToken()).rejects.toThrow("No Kimi OAuth credentials found");
    }, 5_000);

    test("G1 1.12 reset retains identity and clears the cached device id", () => {
      const oauth = KimiOAuth.getInstance();
      const headers = oauth.getPlatformHeaders();
      const previous = readFileSync(devicePath, "utf8").trim();
      expect(Object.values(headers)).toContain(previous);
      devicePath = join(root, "another-device", "id");
      setKimiDeviceIdPathForTesting(devicePath);
      KimiOAuth._resetForTests();
      expect(KimiOAuth.getInstance()).toBe(oauth);
      const nextHeaders = oauth.getPlatformHeaders();
      const next = readFileSync(devicePath, "utf8").trim();
      expect(next).not.toBe(previous);
      expect(Object.values(nextHeaders)).toContain(next);
      expect(statSync(devicePath).mode & 0o777).toBe(0o600);
    }, 5_000);

    test("G1 1.20 importing the authority and obtaining the singleton does no home I/O", async () => {
      expect(existsSync(join(homedir(), ".claudish"))).toBe(false);
      await import("./credentials/authority");
      KimiOAuth.getInstance();
      expect(existsSync(join(homedir(), ".claudish"))).toBe(false);
      expect(existsSync(devicePath)).toBe(false);
      KimiOAuth.getInstance().getPlatformHeaders();
      expect(existsSync(devicePath)).toBe(true);
      expect(statSync(devicePath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(homedir(), ".claudish"))).toBe(false);
    }, 5_000);

    test("G4 a corrupt initial file never appears in the terminal error text", async () => {
      writeFileSync(path, '{"access_token":"OPAQUE_TEST_TOKEN_abc"');
      const failure: unknown = await KimiOAuth.getInstance()
        .getAccessToken()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("No Kimi OAuth credentials found");
      expect(String(failure)).not.toContain(first.access_token);
      expect(String(failure)).not.toContain(first.refresh_token);
    }, 5_000);

    test("G4 reload logging contains the label without the parsed token values", async () => {
      write(first);
      const oauth = KimiOAuth.getInstance();
      await oauth.getAccessToken();
      write(newer, true);
      await oauth.getAccessToken();
      expect((await capturedLines()).join("\n")).toContain(
        "[KimiOAuth] credential file changed on disk; reloaded"
      );
    }, 5_000);
  });
}
