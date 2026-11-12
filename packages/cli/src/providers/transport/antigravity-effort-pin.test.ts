// Assumed seam: ProviderTransport.setEffortOverride?(level: EffortLevel): void pins transport effort.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EffortLevel } from "../../adapters/base-api-format.js";
import * as antigravityToken from "../../auth/antigravity-token.js";
import * as antigravityUser from "../../auth/antigravity-user.js";
import { credentials } from "../../auth/credentials/authority.js";
import { ComposedHandler } from "../../handlers/composed-handler.js";
import * as allModelsCache from "../all-models-cache.js";
import type { DiskCacheV3 } from "../all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../catalog-client.js";
import { catalogEntry, connection, effortMap } from "../test-helpers/model-id-effort.js";
import { AntigravityProviderTransport } from "./antigravity.js";
import type { ProviderTransport } from "./types.js";

const { AntigravityCredentialProvider } = await import(
  "../../auth/credentials/antigravity-credential.js"
);

type PinnableTransport = ProviderTransport & {
  setEffortOverride?: (level: EffortLevel) => void;
};

const BASE = "gemini-4-carbon";
const HIGH = `${BASE}-high`;
const MEDIUM = `${BASE}-medium`;
const LOW = `${BASE}-low`;
const entries = [
  catalogEntry(BASE, [
    connection("antigravity", BASE, effortMap({ high: HIGH, medium: MEDIUM, low: LOW })),
  ]),
];
const served: antigravityUser.AntigravityServedModels = {
  servedIds: [HIGH, MEDIUM, LOW],
  defaultId: HIGH,
  meta: {},
};
const originalFetch = globalThis.fetch;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in Antigravity effort pin tests");
});
let restore: Array<() => void> = [];
let useLocalBuilder = false;

beforeEach(() => {
  restore = [];
  useLocalBuilder = false;
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  _resetCatalogClient();
  _setCatalogEntriesForTest(entries);

  const disk = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "model-id-effort-test-data",
      entries,
      models: [],
      plans: [],
    })
  );
  const token = spyOn(antigravityToken, "getValidAntigravityAccessToken").mockResolvedValue(
    "unit-test-token"
  );
  const user = spyOn(antigravityUser, "setupAntigravityUser").mockResolvedValue({
    projectId: "unit-test-project",
    tierId: "free-tier",
  });
  const models = spyOn(antigravityUser, "getServedAntigravityModels").mockResolvedValue(served);
  const agent = spyOn(antigravityUser, "buildAntigravityUserAgent").mockReturnValue(
    "unit-test-agent"
  );
  const auth = spyOn(credentials, "getRequestAuth").mockImplementation(async (provider, ctx) => {
    if (provider !== "antigravity") throw new Error(`Unexpected credential request: ${provider}`);
    return useLocalBuilder
      ? { headers: {} }
      : new AntigravityCredentialProvider().getRequestAuth(ctx);
  });
  for (const spy of [disk, token, user, models, agent, auth]) {
    restore.push(() => spy.mockRestore());
  }
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  _resetCatalogClient();
  globalThis.fetch = originalFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

for (const path of ["cached credential transform", "local envelope builder"] as const) {
  describe(path, () => {
    async function transportWithPin(pin?: EffortLevel): Promise<AntigravityProviderTransport> {
      useLocalBuilder = path === "local envelope builder";
      const transport = new AntigravityProviderTransport(BASE);
      if (pin !== undefined) (transport as PinnableTransport).setEffortOverride?.(pin);
      await transport.refreshAuth();
      return transport;
    }

    test("pinned low overrides request high in the envelope model id", async () => {
      const transport = await transportWithPin("low");
      const envelope = transport.transformPayload(
        { contents: [] },
        { output_config: { effort: "high" } }
      );
      expect(envelope.model).toBe(LOW);
    });

    test("pinned medium selects the medium model id when the request has no effort", async () => {
      const transport = await transportWithPin("medium");
      const envelope = transport.transformPayload({ contents: [] }, {});
      expect(envelope.model).toBe(MEDIUM);
    });

    test("without a pin request low still selects the low model id", async () => {
      const transport = await transportWithPin();
      const envelope = transport.transformPayload(
        { contents: [] },
        { output_config: { effort: "low" } }
      );
      expect(envelope.model).toBe(LOW);
    });
  });
}

test("ComposedHandler forwards effortOverride low to the transport pin method", () => {
  const setEffortOverride = mock((_level: EffortLevel) => {});
  const transport: PinnableTransport = {
    name: "antigravity",
    displayName: "Antigravity",
    streamFormat: "gemini-sse",
    getEndpoint: () => "http://localhost/",
    getHeaders: async () => ({}),
    setEffortOverride,
  };

  new ComposedHandler(transport, `ag@${BASE}`, BASE, 8080, { effortOverride: "low" });

  expect(setEffortOverride).toHaveBeenCalledWith("low");
});
