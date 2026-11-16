import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetAntigravityUserCache, setupAntigravityUser } from "./antigravity-user.js";

const originalFetch = globalThis.fetch;
const originalHost = process.env.AICODE_ENDPOINT_URL;
let urls: string[];

beforeEach(() => {
  urls = [];
  process.env.AICODE_ENDPOINT_URL = "http://127.0.0.1:1";
  resetAntigravityUserCache();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith(":loadCodeAssist")) {
      return Response.json({ cloudaicompanionProject: "project-one", currentTier: "free-tier" });
    }
    return new Response("{}");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHost === undefined) delete process.env.AICODE_ENDPOINT_URL;
  else process.env.AICODE_ENDPOINT_URL = originalHost;
  resetAntigravityUserCache();
});

async function settled(count: number): Promise<void> {
  for (let i = 0; i < 100 && urls.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("setting up an account sends the Antigravity CLI's account lookups once", async () => {
  await setupAntigravityUser("access-token");
  await settled(5);
  await setupAntigravityUser("access-token");
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(urls).toEqual([
    "http://127.0.0.1:1/v1internal:loadCodeAssist",
    "http://127.0.0.1:1/v1internal:fetchAdminControls",
    "http://127.0.0.1:1/v1internal:fetchUserInfo",
    "http://127.0.0.1:1/v1internal:retrieveUserQuotaSummary",
    "http://127.0.0.1:1/v1internal:listExperiments",
  ]);
});

test("an account whose set-up fails sends no lookup", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response("denied", { status: 403 });
  }) as typeof fetch;

  await expect(setupAntigravityUser("access-token")).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(urls).toEqual(["http://127.0.0.1:1/v1internal:loadCodeAssist"]);
});
