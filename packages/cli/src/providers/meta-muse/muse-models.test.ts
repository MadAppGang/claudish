import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let savedExit: typeof process.exit;
// Any unexpected CLI exit must fail the case instead of terminating Bun's runner.
class UnexpectedProcessExit extends Error {
  constructor(code?: string | number | null) {
    super(`RUN5_PROCESS_EXIT:${code ?? 0}`);
    this.name = "UnexpectedProcessExit";
  }
}
beforeEach(() => {
  savedEnv = { CLAUDISH_DISABLE_KEYCHAIN: process.env.CLAUDISH_DISABLE_KEYCHAIN };
  home = mkdtempSync(join(tmpdir(), "muse-run5-"));
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  savedExit = process.exit;
  process.exit = (code?: string | number | null): never => {
    throw new UnexpectedProcessExit(code);
  };
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected network in Run 5 test");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
});
function restoreHarness() {
  process.exit = savedExit;
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}

// HOME is not an isolation seam in Bun. Every filesystem-capable dependency
// below is explicit and test-owned; omitted production defaults are forbidden.
function fakeCoreDeps(
  overrides: Partial<import("./muse-credentials.js").MuseCoreDeps> = {}
): import("./muse-credentials.js").MuseCoreDeps {
  return {
    dir: () => home,
    now: () => 1792088000000,
    readStore: () => null,
    writeBorrowedCopy: () => {
      throw new Error("Unexpected borrowed-copy write");
    },
    mint: async () => {
      throw new Error("Unexpected mint");
    },
    keychainLogin: async () => {
      throw new Error("Keychain forbidden");
    },
    ...overrides,
  };
}
function fakeMuseKeychainDeps(
  overrides: Partial<import("./muse-keychain.js").MuseKeychainDeps> = {}
): import("./muse-keychain.js").MuseKeychainDeps {
  return {
    dir: () => home,
    env: () => ({}),
    now: () => 1792088000000,
    sleep: async () => {
      throw new Error("Unexpected Keychain wait");
    },
    pid: () => 424242,
    isAlive: () => false,
    presence: async () => ({ kind: "absent" }),
    startRead: () => {
      throw new Error("Keychain forbidden");
    },
    ...overrides,
  };
}
let previousConfigPath: string | null;
const restoreRegistrations: (() => void)[] = [];
beforeEach(async () => {
  const keychain = await import("../keychain.js");
  const forbidden = () => {
    throw new Error("Real Keychain process forbidden");
  };
  keychain.setKeychainTestDeps({
    platform: () => "darwin",
    run: forbidden,
    runAsync: async () => forbidden(),
    spawnAsync: forbidden,
  });
  const core = await import("./muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(fakeCoreDeps());
  const museKeychain = await import("./muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
  (await import("../../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  const config = await import("../../config-override.js");
  previousConfigPath = config.getConfigFileOverride();
  config.setConfigFileOverride(join(home, "config.json"));
});
afterEach(async () => {
  for (const restore of restoreRegistrations.splice(0).reverse()) restore();
  const core = await import("./muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  const museKeychain = await import("./muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(null);
  const keychain = await import("../keychain.js");
  keychain.invalidateKeychainCache();
  keychain.setKeychainTestDeps(null);
  (await import("../../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  (await import("../../auth/credentials/billing-probe.js")).clearSignedArm();
  (await import("../model-discovery.js")).invalidateModelDiscovery("meta-muse-code");
  (await import("../all-models-cache.js"))._clearAllModelsCacheMemo();
  (await import("../catalog-client.js"))._resetCatalogClient();
  (await import("../../config-override.js")).setConfigFileOverride(previousConfigPath);
  restoreHarness();
});

// Capture-derived reconstruction from wire-capture.md §4: reported metadata fields.
function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "meta",
    metadata: {
      "muse-code": {
        name: id,
        family: "avocado",
        is_hidden: false,
        reasoning: true,
        temperature: false,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1007997, output: 128000 },
        options: {
          reasoningEffort: "high",
          forceReasoning: true,
          include: ["reasoning.encrypted_content"],
        },
        variants: {
          minimal: { reasoningEffort: "minimal" },
          high: { reasoningEffort: "high" },
          max: { reasoningEffort: "max" },
        },
        background_agent_model: "muse-spark-1.3",
        ...overrides,
      },
    },
  };
}

test("N1: fixed models URL and capture-derived name/window metadata", async () => {
  const { MUSE_MODELS_URL, parseMuseModels } = await import("./muse-models.js");
  expect(MUSE_MODELS_URL).toBe("https://api.meta.ai/muse-code/models");
  const models = parseMuseModels({
    data: [row("muse-wonder-full-1.0", { name: "Muse Wonder Full" })],
  });
  expect(models).toHaveLength(1);
  expect(models?.[0]).toMatchObject({
    id: "muse-wonder-full-1.0",
    displayName: "Muse Wonder Full",
    contextWindow: 1007997,
  });
});

test("N1: hidden rows are excluded and non-chat rows reported; exact contributor entitlement is retained", async () => {
  const { parseMuseModels } = await import("./muse-models.js");
  const models = parseMuseModels({
    data: [
      row("muse-wonder-full-1.0-contributor"),
      row("muse-wonder-full-1.0"),
      row("muse-image-1.0", { is_hidden: true }),
      // Explicit negative mutation of captured modalities, not an additional capture.
      row("muse-spark-1.3", { modalities: { input: ["image"], output: ["image"] } }),
    ],
  });
  expect(models?.map((model) => model.id)).toEqual([
    "muse-wonder-full-1.0-contributor",
    "muse-wonder-full-1.0",
    "muse-spark-1.3",
  ]);
  expect(models?.find((model) => model.id === "muse-spark-1.3")?.reported).toBe("not-chat");
  expect(models?.some((model) => model.id === "muse-image-1.0")).toBe(false);
});

test("N1: malformed bodies cannot become a successful model list", async () => {
  const { parseMuseModels } = await import("./muse-models.js");
  for (const body of [null, "not JSON", { error: "login required" }, { data: "bad" }]) {
    expect(parseMuseModels(body)).toBeNull();
  }
});

test("N1: capture metadata reports chat and tools through declared projection fields", async () => {
  const { parseMuseModels } = await import("./muse-models.js");
  expect(parseMuseModels({ data: [row("muse-spark-1.3")] })?.[0]).toMatchObject({
    reported: "chat",
    supportsTools: true,
  });
  expect(
    parseMuseModels({ data: [row("muse-spark-1.3", { tool_call: false })] })?.[0].supportsTools
  ).toBe(false);
});

test("N1: minted bearer fetches fixed models root; no login makes zero requests", async () => {
  const core = await import("./muse-credentials.js");
  const { fetchMuseCodeModelsCatalog } = await import("./muse-models.js");
  const { credentials } = await import("../../auth/credentials/authority.js");
  const { MuseCodeCredentialProvider } = await import(
    "../../auth/credentials/muse-code-credential.js"
  );
  const { setCredentialPromptRole } = await import("../../auth/credentials/prompt-role.js");
  const { clearSignedArm } = await import("../../auth/credentials/billing-probe.js");
  const prior = credentials.get("meta-muse-code");
  if (!prior) throw new Error("missing default Muse credential");
  restoreRegistrations.push(() => {
    credentials.register(prior);
    credentials.invalidate("meta-muse-code");
  });
  const role = setCredentialPromptRole("never");
  let present = true;
  let mints = 0;
  const requests: { url: string; headers: unknown }[] = [];
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps({
    ...fakeCoreDeps(),
    dir: () => home,
    readStore: () => (present ? { access_token: "dca:TESTTOKEN0001" } : null),
    keychainLogin: async () => {
      throw new Error("Keychain forbidden");
    },
    mint: async () => {
      mints++;
      return { apiKey: "LLM|TESTKEY0001" };
    },
  });
  credentials.register(new MuseCodeCredentialProvider());
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        headers: init?.headers,
      });
      return Response.json({ data: [row("muse-spark-1.3")] });
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  try {
    const result = await fetchMuseCodeModelsCatalog();
    expect(result.kind).toBe("models");
    if (result.kind !== "models") throw new Error(JSON.stringify(result));
    expect(result.models[0]).toMatchObject({
      id: "muse-spark-1.3",
      contextWindow: 1007997,
      supportsTools: true,
      reported: "chat",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.meta.ai/muse-code/models");
    expect(JSON.stringify(requests[0].headers)).toContain("Bearer LLM|TESTKEY0001");
    expect(mints).toBe(1);
    present = false;
    core.resetMuseCredentialState();
    credentials.invalidate("meta-muse-code");
    const absent = await fetchMuseCodeModelsCatalog();
    expect(absent.kind).toBe("failed");
    if (absent.kind !== "failed") throw new Error(JSON.stringify(absent));
    expect(absent.failure.kind).toBe("no-credentials");
    expect(absent.failure.detail).toContain("login");
    expect(requests).toHaveLength(1);
  } finally {
    credentials.register(prior);
    credentials.invalidate("meta-muse-code");
    clearSignedArm();
    core.resetMuseCredentialState();
    core.setMuseCoreTestDeps(null);
    setCredentialPromptRole(role);
    const { invalidateModelDiscovery } = await import("../model-discovery.js");
    invalidateModelDiscovery("meta-muse-code");
  }
});

test.skip("N1 BLOCKED: DiscoveredModel declares neither output-token limit nor input/output modality projection fields", () => {});
