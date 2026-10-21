import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { _resetAgyClientVersion } from "./antigravity-client-version.js";
import {
  type AntigravityTokenDeps,
  _resetAntigravityTokenState,
  forceRefreshAntigravityToken,
  getValidAntigravityAccessToken,
} from "./antigravity-token.js";
import {
  _resetAntigravityServedModelsCache,
  buildAntigravityUserAgent,
  getServedAntigravityModels,
  resetAntigravityUserCache,
} from "./antigravity-user.js";

const realFetch = globalThis.fetch;
const NOW = Date.parse("2026-10-14T00:00:00Z");
const oldCapture = JSON.parse(
  readFileSync(
    new URL("./fixtures/antigravity-fetchAvailableModels-1.1.9.json", import.meta.url),
    "utf8"
  )
);
const newCapture = JSON.parse(
  readFileSync(
    new URL("./fixtures/antigravity-fetchAvailableModels-1.3.5.json", import.meta.url),
    "utf8"
  )
);
const agentIds: string[] = newCapture.agentModelSorts[0].groups[0].modelIds;

function fakeSession(readAgyVersion?: () => string | null) {
  function encoded(accessToken: string): string {
    return (
      "go-keyring-base64:" +
      Buffer.from(
        JSON.stringify({
          token: {
            access_token: accessToken,
            token_type: "Bearer",
            refresh_token: "offline-refresh",
            expiry: new Date(NOW + 3_600_000).toISOString(),
          },
        })
      ).toString("base64")
    );
  }
  let store = encoded("offline-first");
  const deps: AntigravityTokenDeps = {
    readStore: () => store,
    writeStore: (raw) => {
      store = raw;
    },
    deleteStore: () => {
      store = "";
    },
    runAgyRefresh: mock(() => {
      store = encoded("offline-reminted");
      return { kind: "ran" as const };
    }),
    ...(readAgyVersion ? { readAgyVersion } : {}),
    now: () => NOW,
  };
  return {
    deps,
    changeToken: (id: string) => {
      store = encoded(id);
    },
  };
}

function resetState(): void {
  _resetAgyClientVersion();
  _resetAntigravityServedModelsCache();
  resetAntigravityUserCache();
  _resetAntigravityTokenState();
}

beforeEach(() => {
  resetState();
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected network request");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetState();
});

describe("Antigravity captured client version", () => {
  test("B1: valid stored token captures 1.3.5 in the User-Agent", async () => {
    const { deps } = fakeSession(() => "1.3.5");
    expect(await getValidAntigravityAccessToken(deps)).toBe("offline-first");
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.3.5 ");
  });

  test("B2: before capture the User-Agent uses the 1.1.9 floor", () => {
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.1.9 ");
  });

  test("B2: omitted version dependency retains the floor without running agy", async () => {
    const { deps } = fakeSession();
    expect(await getValidAntigravityAccessToken(deps)).toBe("offline-first");
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.1.9 ");
    expect(deps.runAgyRefresh).not.toHaveBeenCalled();
  });

  test("B3: read once per access token and recapture 1.4.0 for a new session", async () => {
    let version = "1.3.5";
    const readVersion = mock(() => version);
    const session = fakeSession(readVersion);
    await getValidAntigravityAccessToken(session.deps);
    await getValidAntigravityAccessToken(session.deps);
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.3.5 ");
    version = "1.4.0";
    session.changeToken("offline-second");
    expect(await getValidAntigravityAccessToken(session.deps)).toBe("offline-second");
    expect(readVersion).toHaveBeenCalledTimes(2);
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.4.0 ");
    await getValidAntigravityAccessToken(session.deps);
    expect(readVersion).toHaveBeenCalledTimes(2);
  });

  test("B4: failed read retains the last good version and is not retried", async () => {
    let version: string | null = "1.3.5";
    const readVersion = mock(() => version);
    const session = fakeSession(readVersion);
    await getValidAntigravityAccessToken(session.deps);
    version = null;
    session.changeToken("offline-second");
    await getValidAntigravityAccessToken(session.deps);
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.3.5 ");
    expect(readVersion).toHaveBeenCalledTimes(2);
    await getValidAntigravityAccessToken(session.deps);
    expect(readVersion).toHaveBeenCalledTimes(2);
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.3.5 ");
  });

  test("B5: forced refresh captures the version for the re-minted token", async () => {
    let version = "1.3.5";
    const readVersion = mock(() => version);
    const { deps } = fakeSession(readVersion);
    await getValidAntigravityAccessToken(deps);
    version = "1.4.0";
    expect(await forceRefreshAntigravityToken(deps)).toBe("offline-reminted");
    expect(deps.runAgyRefresh).toHaveBeenCalledTimes(1);
    expect(readVersion).toHaveBeenCalledTimes(2);
    expect(buildAntigravityUserAgent()).toStartWith("antigravity/cli/1.4.0 ");
    await getValidAntigravityAccessToken(deps);
    expect(readVersion).toHaveBeenCalledTimes(2);
  });

  test("B6: served-model request sends the captured 1.3.5 User-Agent", async () => {
    const token = await getValidAntigravityAccessToken(fakeSession(() => "1.3.5").deps);
    const fetchStub = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(newCapture)
    );
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    await getServedAntigravityModels(token, "offline-project");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [input, init] = fetchStub.mock.calls[0];
    expect(String(input)).toEndWith("/v1internal:fetchAvailableModels");
    expect(new Headers(init?.headers).get("User-Agent")).toStartWith("antigravity/cli/1.3.5 ");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer offline-first");
    expect(JSON.parse(String(init?.body))).toEqual({ project: "offline-project" });
  });

  test("B7: version change invalidates an unexpired cache; same version reuses it", async () => {
    const fetchStub = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const ua = new Headers(init?.headers).get("User-Agent") ?? "";
      if (ua.startsWith("antigravity/cli/1.1.9 ")) return Response.json(oldCapture);
      if (ua.startsWith("antigravity/cli/1.3.5 ")) return Response.json(newCapture);
      throw new Error(`Unexpected User-Agent: ${ua}`);
    });
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    const oldResult = await getServedAntigravityModels("offline-first", "offline-project");
    expect(oldResult.servedIds).not.toContain("gemini-4-argon-medium");
    expect(await getServedAntigravityModels("offline-first", "offline-project")).toBe(oldResult);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await getValidAntigravityAccessToken(fakeSession(() => "1.3.5").deps);
    const newResult = await getServedAntigravityModels("offline-first", "offline-project");
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(newResult.servedIds).toContain("gemini-4-argon-medium");
    expect(await getServedAntigravityModels("offline-first", "offline-project")).toBe(newResult);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("B8: real capture exposes exactly the 13 agy ids in their published order", async () => {
    globalThis.fetch = mock(async () => Response.json(newCapture)) as unknown as typeof fetch;
    const result = await getServedAntigravityModels("offline-first", "offline-project");
    expect(agentIds).toHaveLength(13);
    expect(result.agentModelIds).toEqual(agentIds);
  });

  test("B8: repeated ids across groups and sorts retain their first position", async () => {
    const capture = structuredClone(newCapture);
    capture.agentModelSorts[0].groups.push({ modelIds: [agentIds[2], agentIds[0]] });
    capture.agentModelSorts.push({ groups: [{ modelIds: [agentIds[12], agentIds[1]] }] });
    globalThis.fetch = mock(async () => Response.json(capture)) as unknown as typeof fetch;
    expect(
      (await getServedAntigravityModels("offline-first", "offline-project")).agentModelIds
    ).toEqual(agentIds);
  });

  test.each(["absent", "empty", "empty-groups"])(
    "B8: %s agentModelSorts yields undefined",
    async (mode) => {
      const capture = structuredClone(newCapture);
      if (mode === "absent") delete capture.agentModelSorts;
      else capture.agentModelSorts = mode === "empty" ? [] : [{ groups: [{ modelIds: [] }] }];
      globalThis.fetch = mock(async () => Response.json(capture)) as unknown as typeof fetch;
      expect(
        (await getServedAntigravityModels("offline-first", "offline-project")).agentModelIds
      ).toBeUndefined();
    }
  );
});
