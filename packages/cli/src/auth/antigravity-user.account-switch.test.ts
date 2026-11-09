import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetAgyClientVersion } from "./antigravity-client-version.js";
import {
  type AntigravityTokenDeps,
  _resetAntigravityTokenState,
  getValidAntigravityAccessToken,
} from "./antigravity-token.js";
import {
  _resetAntigravityServedModelsCache,
  getServedAntigravityModels,
  peekServedAntigravityModels,
  resetAntigravityUserCache,
  setupAntigravityUser,
} from "./antigravity-user.js";

const realFetch = globalThis.fetch;
const NOW = Date.parse("2026-11-06T12:00:00Z");
let store: string;
let deps: AntigravityTokenDeps;
let calls: Array<{ account: string; action: string; project?: string }>;

function encodedAccount(account: string): string {
  return (
    "go-keyring-base64:" +
    Buffer.from(
      JSON.stringify({
        token: {
          access_token: `offline-access-${account}`,
          refresh_token: `offline-lineage-${account}`,
          token_type: "Bearer",
          expiry: new Date(NOW + 3_600_000).toISOString(),
        },
      })
    ).toString("base64")
  );
}

function resetState(): void {
  _resetAgyClientVersion();
  _resetAntigravityTokenState();
  resetAntigravityUserCache();
  _resetAntigravityServedModelsCache();
}

beforeEach(() => {
  resetState();
  store = encodedAccount("a");
  deps = {
    readStore: () => store,
    writeStore: () => {
      throw new Error("Unexpected token write");
    },
    deleteStore: () => {
      throw new Error("Unexpected token deletion");
    },
    runAgyRefresh: () => {
      throw new Error("Unexpected token refresh");
    },
    readAgyVersion: () => "1.3.5",
    now: () => NOW,
  };
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    const account = ["a", "b"].find((id) => authorization === `Bearer offline-access-${id}`);
    const action = new URL(String(input)).pathname.split(":").at(-1);
    if (!account || (action !== "loadCodeAssist" && action !== "fetchAvailableModels")) {
      throw new Error("Unexpected Antigravity request");
    }
    const body = JSON.parse(String(init?.body));
    calls.push({ account, action, project: body.project });
    if (action === "loadCodeAssist") {
      return Response.json({
        cloudaicompanionProject: `project-${account}`,
        paidTier: { id: `tier-${account}`, name: `Account ${account}` },
      });
    }
    if (body.project !== `project-${account}`) {
      return new Response("wrong account project", { status: 403 });
    }
    return Response.json({
      models: { [`m-${account}`]: {} },
      defaultAgentModelId: `m-${account}`,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetState();
});

async function warmAccountA(): Promise<void> {
  const accessToken = await getValidAntigravityAccessToken(deps);
  expect(accessToken).toBe("offline-access-a");
  const setup = await setupAntigravityUser(accessToken);
  expect(setup).toEqual({ projectId: "project-a", tierId: "tier-a" });
  const models = await getServedAntigravityModels(accessToken, setup.projectId);
  expect(models.servedIds).toEqual(["m-a"]);
  expect(peekServedAntigravityModels()?.servedIds).toEqual(["m-a"]);
}

describe("Antigravity dynamic models catalog account switching", () => {
  test("a new stored token lineage replaces the cached project, tier and models", async () => {
    await warmAccountA();
    // A different process changes the store; the client version stays the same.
    store = encodedAccount("b");
    const accessToken = await getValidAntigravityAccessToken(deps);
    expect(accessToken).toBe("offline-access-b");

    const setup = await setupAntigravityUser(accessToken);
    const models = await getServedAntigravityModels(accessToken, setup.projectId);

    expect({ ...setup, servedIds: models.servedIds, defaultId: models.defaultId }).toEqual({
      projectId: "project-b",
      tierId: "tier-b",
      servedIds: ["m-b"],
      defaultId: "m-b",
    });
    expect(calls.filter((call) => call.account === "b")).toEqual([
      { account: "b", action: "loadCodeAssist", project: undefined },
      { account: "b", action: "fetchAvailableModels", project: "project-b" },
    ]);
  });

  test("the cache peek cannot expose the previous account's models after a lineage change", async () => {
    await warmAccountA();
    store = encodedAccount("b");
    const accessToken = await getValidAntigravityAccessToken(deps);
    expect(accessToken).toBe("offline-access-b");
    await setupAntigravityUser(accessToken);

    const cached = peekServedAntigravityModels();

    expect(cached?.servedIds ?? []).not.toContain("m-a");
    if (cached) {
      expect(cached.servedIds).toEqual(["m-b"]);
      expect(cached.defaultId).toBe("m-b");
    }
  });
});
