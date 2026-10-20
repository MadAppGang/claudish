import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuseOAuthDeps } from "./meta-muse-oauth.js";

// Each OAuth instance receives this directory through its complete deps object.
let home: string;
let priorGuard: string | undefined;
let oauth: typeof import("./meta-muse-oauth.js");

beforeEach(async () => {
  priorGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  home = await mkdtemp(join(tmpdir(), "muse-oauth-test-"));
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  oauth = await import("./meta-muse-oauth.js");
});

afterEach(async () => {
  if (priorGuard === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = priorGuard;
  await rm(home, { recursive: true, force: true });
});

// wire-capture.md §8 shape; the sent device code is an ASCII test placeholder.
// There is no token-success fixture.
const DEVICE = {
  device_code: "TESTDEVICECODE0001",
  user_code: "XXXX-XXXX",
  verification_uri: "https://auth.meta.com/oauth/device/",
  verification_uri_complete: "https://auth.meta.com/oauth/device/?code=XXXX-XXXX",
  expires_in: 600,
  interval: 5,
};
const AUTHORIZATION = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN = "https://auth.meta.com/oidc/device/token/";

function deviceFlow(slowDown: boolean) {
  let now = 0;
  let polls = 0;
  let mints = 0;
  const requests: { request: Request; at: number }[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const printed: string[] = [];
  const deps: MuseOAuthDeps = {
    fetch: async (...args) => {
      const request = new Request(args[0], args[1]);
      requests.push({ request, at: now });
      if (request.url === AUTHORIZATION) return Response.json(DEVICE);
      if (request.url !== TOKEN) throw new Error(`Unexpected OAuth URL: ${request.url}`);
      if (++polls > 130) throw new Error("Polling continued beyond device expiry");
      // Captured errors, not an invented successful token body.
      return Response.json(
        { error: slowDown && polls === 2 ? "slow_down" : "authorization_pending" },
        { status: 400 }
      );
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
    openBrowser: async (url) => {
      opened.push(url);
    },
    print: (line) => {
      printed.push(line);
    },
    mint: async () => {
      mints++;
      throw new Error("Pending authorization must not mint");
    },
    dir: () => home,
  };
  return { deps, requests, sleeps, opened, printed, mintCount: () => mints, now: () => now };
}

describe("O1 — captured device authorization, pending and backoff", () => {
  test("uses the captured device client id", () => {
    expect(oauth.MUSE_OIDC_CLIENT_ID).toBe("1031625952748946");
  });

  for (const slowDown of [false, true]) {
    test(`posts exact device forms, displays/opens verification and stops at expiry (slow_down=${slowDown})`, async () => {
      const io = deviceFlow(slowDown);
      let failure: unknown;
      try {
        await new oauth.MuseCodeOAuth(io.deps).login();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/expir/i);

      const authorization = io.requests.filter(({ request }) => request.url === AUTHORIZATION);
      const polls = io.requests.filter(({ request }) => request.url === TOKEN);
      expect(authorization).toHaveLength(1);
      expect(io.requests).toHaveLength(1 + polls.length);
      expect(polls.length).toBeGreaterThan(3);
      expect(authorization[0]!.request.method).toBe("POST");
      expect(authorization[0]!.request.headers.get("content-type")).toContain(
        "application/x-www-form-urlencoded"
      );
      expect([...new URLSearchParams(await authorization[0]!.request.text()).entries()]).toEqual([
        ["client_id", "1031625952748946"],
      ]);
      for (const { request } of polls) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
        const form = new URLSearchParams(await request.text());
        expect(Object.fromEntries(form)).toEqual({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: DEVICE.device_code,
          client_id: "1031625952748946",
        });
        expect([...form.keys()]).toHaveLength(3);
        expect(form.has("scope")).toBe(false);
      }
      expect(io.opened).toEqual([DEVICE.verification_uri_complete]);
      expect(io.printed.join("\n")).toContain(DEVICE.user_code);
      expect(io.printed.join("\n")).toContain(DEVICE.verification_uri);
      // The interval after pending is 5 s; after the second poll's slow_down,
      // each remaining poll must wait 5 s more. Also detects ignored backoff.
      for (let i = 1; i < polls.length; i++) {
        expect(polls[i]!.at - polls[i - 1]!.at).toBe(slowDown && i >= 2 ? 10_000 : 5_000);
      }
      expect(io.sleeps.length).toBeGreaterThan(0);
      expect(polls.every(({ at }) => at < DEVICE.expires_in * 1000)).toBe(true);
      expect(io.now()).toBeGreaterThanOrEqual(DEVICE.expires_in * 1000);
      expect(io.mintCount()).toBe(0);
      expect(await readdir(home)).toEqual([]);
    });
  }
});

test.skip("BLOCKED O2 inactive/unconfirmed login must not replace stores: no captured device-token success body; login() is the only public save boundary", () => {});
test.skip("BLOCKED O2 transient mint must preserve existing stores: no captured device-token success body; no public token-to-mint/save seam", () => {});
test.skip("BLOCKED O1 successful device-token decoding: wire-capture.md §8 explicitly did not capture approval success", () => {});
