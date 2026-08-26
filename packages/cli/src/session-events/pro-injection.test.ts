import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "hono";
import { ComposedHandler } from "../handlers/composed-handler.js";
import { type SlimModelEntry, writeAllModelsCache } from "../providers/all-models-cache.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { SessionEventRegistry } from "./index.js";
import {
  type ProInjectionOptions,
  applyProInjection,
  resolveVariantPreset,
} from "./pro-injection.js";
import {
  FIXTURE_EFFORT_HIGH_DEFAULT_STDOUT,
  FIXTURE_EFFORT_ULTRACODE_STDOUT,
  FIXTURE_SESSION_ID,
  FIXTURE_ULTRA_EFFORT_ENTER,
  FIXTURE_ULTRA_EFFORT_EXIT,
} from "./test-fixtures.js";

const BASE_MODEL_ID = "gpt-5.6-sol";
const VARIANT_MODEL_ID = "gpt-5.6-sol-pro";
const PROVIDER = "openrouter";
const PRESET = "reasoning.mode=pro";

let home = "";
let registry: SessionEventRegistry | undefined;
let transcriptFile = "";
let cachePath = "";

/** Fake ~/.claude with the real captured transcript lines for FIXTURE_SESSION_ID. */
function makeHome(...lines: string[]): void {
  home = mkdtempSync(join(tmpdir(), "claudish-proinj-"));
  const projectDir = join(home, "projects", "-fake-cwd");
  mkdirSync(projectDir, { recursive: true });
  transcriptFile = join(projectDir, `${FIXTURE_SESSION_ID}.jsonl`);
  writeFileSync(transcriptFile, lines.map((line) => `${line}\n`).join(""));
  cachePath = join(home, "all-models.json");
  registry = new SessionEventRegistry({ claudeHome: home, pollIntervalMs: 60_000 });
  registry.ensureSession(FIXTURE_SESSION_ID);
  registry.sync(FIXTURE_SESSION_ID);
}

function variantEntry(
  provider = PROVIDER,
  preset = PRESET,
  baseModelId = BASE_MODEL_ID
): SlimModelEntry {
  return {
    modelId: VARIANT_MODEL_ID,
    aliases: [],
    sources: {},
    routeVariant: {
      kind: "provider-preset",
      baseModelId,
      provider,
      preset,
    },
  };
}

function writeCatalog(entries: SlimModelEntry[] = [variantEntry()]): void {
  writeAllModelsCache({ entries }, cachePath);
}

function makeProOptions(overrides: Partial<ProInjectionOptions> = {}): ProInjectionOptions {
  return {
    enabled: true,
    sessionId: FIXTURE_SESSION_ID,
    bareModelName: BASE_MODEL_ID,
    provider: PROVIDER,
    targetModel: `${PROVIDER}@${BASE_MODEL_ID}`,
    outputConfig: { effort: "xhigh" },
    registry,
    cachePath,
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  registry?.disposeAll();
  registry = undefined;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
  home = "";
  transcriptFile = "";
  cachePath = "";
});

describe("resolveVariantPreset", () => {
  test("returns the same-provider catalog preset as parsed nested params", () => {
    makeHome();
    writeCatalog();

    expect(resolveVariantPreset(BASE_MODEL_ID, PROVIDER, cachePath)).toEqual({
      params: { reasoning: { mode: "pro" } },
      variantModelId: VARIANT_MODEL_ID,
      provider: PROVIDER,
      preset: PRESET,
    });
  });

  test("returns undefined when the variant belongs to a different provider", () => {
    makeHome();
    writeCatalog([variantEntry("openrouter")]);

    expect(resolveVariantPreset(BASE_MODEL_ID, "openai", cachePath)).toBeUndefined();
  });

  test("returns undefined when the catalog model has no variant", () => {
    makeHome();
    writeCatalog([{ modelId: BASE_MODEL_ID, aliases: [], sources: {} }]);

    expect(resolveVariantPreset(BASE_MODEL_ID, PROVIDER, cachePath)).toBeUndefined();
  });

  test("returns undefined without throwing for a cold or missing cache", () => {
    makeHome();

    expect(resolveVariantPreset(BASE_MODEL_ID, PROVIDER, cachePath)).toBeUndefined();
  });

  test("returns undefined without throwing for an unparseable preset", () => {
    makeHome();
    writeCatalog([variantEntry(PROVIDER, "reasoning-tier")]);

    expect(resolveVariantPreset(BASE_MODEL_ID, PROVIDER, cachePath)).toBeUndefined();
  });
});

describe("applyProInjection", () => {
  test("ultracode enter plus matching provider deep-merges the catalog preset", () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const payload: {
      model: string;
      reasoning: { effort: string; mode?: string };
    } = {
      model: BASE_MODEL_ID,
      reasoning: { effort: "xhigh" },
    };

    expect(applyProInjection(payload, makeProOptions())).toBe(true);
    expect(payload.reasoning).toEqual({ effort: "xhigh", mode: "pro" });
  });

  test("enabled false preserves the default-OFF contract and leaves the payload untouched", () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const payload = { reasoning: { effort: "xhigh" }, marker: "unchanged" };

    expect(applyProInjection(payload, makeProOptions({ enabled: false }))).toBe(false);
    expect(payload).toEqual({ reasoning: { effort: "xhigh" }, marker: "unchanged" });
  });

  test("non-xhigh output effort blocks injection for subagent requests", () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const payload = { marker: "unchanged" };

    expect(applyProInjection(payload, makeProOptions({ outputConfig: { effort: "low" } }))).toBe(
      false
    );
    expect(payload).toEqual({ marker: "unchanged" });
  });

  test("structured output_config.format blocks injection for auxiliary requests", () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const payload = { marker: "unchanged" };

    expect(
      applyProInjection(
        payload,
        makeProOptions({
          outputConfig: { effort: "xhigh", format: { type: "json_schema" } },
        })
      )
    ).toBe(false);
    expect(payload).toEqual({ marker: "unchanged" });
  });

  test("provider mismatch blocks injection and leaves the payload untouched", () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog([variantEntry("openrouter")]);
    const payload = { marker: "unchanged" };

    expect(applyProInjection(payload, makeProOptions({ provider: "openai" }))).toBe(false);
    expect(payload).toEqual({ marker: "unchanged" });
  });

  test("ultracode exit followed by registry.sync stops injection", () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    appendFileSync(
      transcriptFile,
      `${FIXTURE_EFFORT_HIGH_DEFAULT_STDOUT}\n${FIXTURE_ULTRA_EFFORT_EXIT}\n`
    );
    registry?.sync(FIXTURE_SESSION_ID);
    const payload = { marker: "unchanged" };

    expect(applyProInjection(payload, makeProOptions())).toBe(false);
    expect(payload).toEqual({ marker: "unchanged" });
  });

  test("undefined sessionId blocks injection and leaves the payload untouched", () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const payload = { marker: "unchanged" };

    expect(applyProInjection(payload, makeProOptions({ sessionId: undefined }))).toBe(false);
    expect(payload).toEqual({ marker: "unchanged" });
  });
});

// ─── ComposedHandler wiring (step 5a-pre) ────────────────────────────────────

/** Fake transport; the stubbed global fetch captures the final wire payload. */
function makeTransport(): ProviderTransport {
  return {
    name: PROVIDER,
    displayName: "OpenRouter",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

/** Stub fetch → capture outbound body, return a canned error (skips stream parsing). */
function stubFetchCapture(): {
  body: () => Record<string, unknown> & { reasoning?: { mode?: unknown } };
} {
  let captured: Record<string, unknown> & { reasoning?: { mode?: unknown } } = {};
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    const body = (init as { body?: unknown } | undefined)?.body;
    if (typeof body !== "string") throw new Error("expected a JSON request body");
    captured = JSON.parse(body);
    return new Response('{"error":{"message":"stub"}}', { status: 500 });
  }) as unknown as typeof fetch;
  return { body: () => captured };
}

function makeContext(): Context {
  return {
    req: { header: () => ({}) },
    header: () => {},
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;
}

function makeClaudePayload(): Record<string, unknown> {
  return {
    model: BASE_MODEL_ID,
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    // Ultracode main-loop turns carry effort xhigh (composite-guard signature).
    output_config: { effort: "xhigh" },
    metadata: { user_id: `user_e2e_account_e2e_session_${FIXTURE_SESSION_ID}` },
  };
}

function makeHandler(options: {
  proOnUltracode?: boolean;
  modelParams?: Record<string, unknown>;
}): ComposedHandler {
  return new ComposedHandler(makeTransport(), `${PROVIDER}@${BASE_MODEL_ID}`, BASE_MODEL_ID, 8080, {
    ...options,
    sessionEventRegistry: registry,
    catalogCachePath: cachePath,
  });
}

describe("ComposedHandler step 5a-pre wiring", () => {
  test("proOnUltracode true in an ultracode session puts reasoning.mode=pro on the wire", async () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const wire = stubFetchCapture();

    await makeHandler({ proOnUltracode: true }).handle(makeContext(), makeClaudePayload());

    expect(wire.body().reasoning?.mode).toBe("pro");
  });

  test("ORDERING INVARIANT: swapping 5a-pre after 5a would override explicit --model-params", async () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const wire = stubFetchCapture();

    await makeHandler({
      proOnUltracode: true,
      modelParams: { reasoning: { mode: "standard" } },
    }).handle(makeContext(), makeClaudePayload());

    expect(wire.body().reasoning?.mode).toBe("standard");
  });

  test("falsy proOnUltracode leaves reasoning.mode off the wire", async () => {
    makeHome(FIXTURE_EFFORT_ULTRACODE_STDOUT, FIXTURE_ULTRA_EFFORT_ENTER);
    writeCatalog();
    const wire = stubFetchCapture();

    await makeHandler({}).handle(makeContext(), makeClaudePayload());

    expect(wire.body().reasoning?.mode).toBeUndefined();
  });
});
