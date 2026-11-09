import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexDiscoveryOptions,
  clearCodexModelsMemo,
  codexModelsUrl,
  getCodexModelInfo,
} from "./codex-models-discovery.js";
import type { AuthBinding } from "./transport/types.js";

const capturedBytes = readFileSync(
  new URL("../test-fixtures/code-mode/codex-models-response.json", import.meta.url),
  "utf8"
);
const captured: {
  models: Array<{
    slug: string;
    tool_mode?: string;
    use_responses_lite?: boolean;
    default_reasoning_level?: string;
    default_verbosity?: string;
    truncation_policy?: { mode: string; limit: number };
    service_tiers?: Array<{ id: string; name: string; description?: string }>;
    default_service_tier?: string | null;
  }>;
} = JSON.parse(capturedBytes);
const sol = captured.models.find((model) => model.slug === "gpt-6.1-sol");
if (!sol) throw new Error("real /models capture must contain gpt-6.1-sol");
const expected = {
  slug: sol.slug,
  toolMode: sol.tool_mode,
  useResponsesLite: sol.use_responses_lite,
  defaultReasoningLevel: sol.default_reasoning_level,
  defaultVerbosity: sol.default_verbosity,
  truncationPolicy: sol.truncation_policy,
  serviceTiers: sol.service_tiers?.map(({ id, name }) => ({ id, name })),
};
let home: string;
const realFetch = globalThis.fetch;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-t5-discovery-"));
  clearCodexModelsMemo();
  globalThis.fetch = (async () => {
    throw new Error("T5 forbids network access");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  jest.useRealTimers();
  clearCodexModelsMemo();
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});
function binding(
  account = "account-a",
  endpoint = "https://chatgpt.com/backend-api/codex/responses"
): AuthBinding {
  return {
    auth: {
      arm: "oauth",
      endpoint,
      headers: { Authorization: "Bearer TOKEN", "chatgpt-account-id": account },
    },
  };
}
function capturedResponse() {
  return new Response(capturedBytes, { headers: { "content-type": "application/json" } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flushMicrotasks() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}
function options(
  fetchImpl: CodexDiscoveryOptions["fetchImpl"],
  extra: Partial<CodexDiscoveryOptions> = {}
): CodexDiscoveryOptions {
  return { codexHome: home, fetchImpl, now: () => 1000, ...extra };
}

describe("T5 Codex /models discovery", () => {
  test("REQ-9 TEST-11 translates captured gpt-6.1-sol metadata and matches slugs case-insensitively", async () => {
    const opts = options((async () => capturedResponse()) as unknown as typeof fetch);

    const info = await getCodexModelInfo("GPT-6.1-SOL", binding(), "key-a", opts);

    // Concrete values are pinned to the evidence, not model data from memory.
    expect(sol.tool_mode).toBe("code_mode_only");
    expect(sol.use_responses_lite).toBe(true);
    expect(sol.truncation_policy).toEqual({ mode: "tokens", limit: 10000 });
    expect(sol.service_tiers?.map((tier) => tier.id)).toEqual(["priority"]);
    expect(sol.default_service_tier).toBeNull();
    expect(info).toEqual(expected);
  });

  test("keeps well-formed service tiers and a string default tier, drops malformed entries", async () => {
    const body = JSON.stringify({
      models: [
        {
          slug: "m",
          default_service_tier: "priority",
          service_tiers: [{ id: "priority", name: "Fast" }, { id: 7 }, null, { name: "Flex" }],
        },
      ],
    });
    const opts = options((async () => new Response(body)) as unknown as typeof fetch);

    const info = await getCodexModelInfo("m", binding(), "key-tiers", opts);

    expect(info?.serviceTiers).toEqual([{ id: "priority", name: "Fast" }]);
    expect(info?.defaultServiceTier).toBe("priority");
  });

  test("REQ-10 TEST-12 concurrent lookups share one outgoing fetch", async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const sent: string[] = [];
    const opts = options((async (url: string | URL | Request) => {
      sent.push(String(url));
      started.resolve();
      return response.promise;
    }) as typeof fetch);

    const first = getCodexModelInfo(sol.slug, binding(), "key-a", opts);
    const second = getCodexModelInfo(sol.slug.toUpperCase(), binding(), "key-a", opts);
    await started.promise;
    response.resolve(capturedResponse());
    const results = await Promise.all([first, second]);

    expect(sent).toHaveLength(1);
    expect(results).toEqual([expected, expected]);
  });

  test("REQ-10 TEST-13 memo is scoped to the account rather than the model or process", async () => {
    const sent: string[] = [];
    const opts = options((async (_url, init) => {
      sent.push(new Headers(init?.headers).get("chatgpt-account-id")!);
      return capturedResponse();
    }) as typeof fetch);

    expect(await getCodexModelInfo(sol.slug, binding("account-a"), "key-a", opts)).toEqual(
      expected
    );
    expect(await getCodexModelInfo(sol.slug, binding("account-b"), "key-b", opts)).toEqual(
      expected
    );
    expect(await getCodexModelInfo(sol.slug, binding("account-a"), "key-a", opts)).toEqual(
      expected
    );
    expect(sent).toEqual(["account-a", "account-b"]);
  });

  test("REQ-11 TEST-14 returns undefined for a slug absent from the captured body", async () => {
    expect(
      await getCodexModelInfo(
        "t5-does-not-exist",
        binding(),
        "key-a",
        options((async () => capturedResponse()) as unknown as typeof fetch)
      )
    ).toBeUndefined();
  });

  test("REQ-11 TEST-15 resolves undefined when fetch throws and no fallback cache exists", async () => {
    const opts = options((async () => {
      throw new TypeError("discovery unavailable");
    }) as unknown as typeof fetch);

    await expect(getCodexModelInfo(sol.slug, binding(), "key-a", opts)).resolves.toBeUndefined();
    expect(readdirSync(home)).toEqual([]);
  });

  test("REQ-12 TEST-16 derives the models URL and sends this binding's headers plus JSON accept", async () => {
    const auth = binding("account-a", "https://edge.invalid/account/codex/responses");
    const sent: Array<{ url: URL; headers: Headers; signal: AbortSignal | null | undefined }> = [];
    const opts = options((async (url, init) => {
      sent.push({
        url: new URL(String(url)),
        headers: new Headers(init?.headers),
        signal: init?.signal,
      });
      return capturedResponse();
    }) as typeof fetch);

    expect(codexModelsUrl(auth, "0.161.0")).toBe(
      "https://edge.invalid/account/codex/models?client_version=0.161.0"
    );
    expect(await getCodexModelInfo(sol.slug, auth, "key-a", opts)).toEqual(expected);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.origin).toBe("https://edge.invalid");
    expect(sent[0]!.url.pathname).toBe("/account/codex/models");
    expect(sent[0]!.url.searchParams.get("client_version")).toBeTruthy();
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer TOKEN");
    expect(sent[0]!.headers.get("chatgpt-account-id")).toBe("account-a");
    expect(sent[0]!.headers.get("accept")).toBe("application/json");
    expect(sent[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("REQ-11 REQ-12 TEST-17 unsupported endpoint returns unknown without sending discovery", async () => {
    const sent: string[] = [];
    const auth = binding("account-a", "https://edge.invalid/chat/completions");
    const opts = options((async (url) => {
      sent.push(String(url));
      return capturedResponse();
    }) as typeof fetch);

    expect(codexModelsUrl(auth, "0.161.0")).toBeUndefined();
    expect(await getCodexModelInfo(sol.slug, auth, "key-a", opts)).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("REQ-13 TEST-18 refetches only after the one-hour memo TTL expires", async () => {
    let now = 1000;
    const sent: number[] = [];
    const opts = options(
      (async () => {
        sent.push(now);
        return capturedResponse();
      }) as unknown as typeof fetch,
      { now: () => now }
    );

    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);
    now += 3_600_000 - 1;
    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);
    expect(sent).toHaveLength(1);
    now += 2;
    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);
    expect(sent).toHaveLength(2);
  });

  test("REQ-13 TEST-19 a failed expired refetch retains the last good answer", async () => {
    let now = 1000;
    const sent: number[] = [];
    const opts = options(
      (async () => {
        sent.push(now);
        if (sent.length > 1) throw new TypeError("refetch unavailable");
        return capturedResponse();
      }) as unknown as typeof fetch,
      { now: () => now }
    );
    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);

    now += 3_600_001;
    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);
    await flushMicrotasks();
    expect(sent).toHaveLength(2);
    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);
  });

  test("REQ-14 TEST-20 stops waiting at two seconds and later reuses the background result", async () => {
    jest.useFakeTimers();
    const response = deferred<Response>();
    const started = deferred<void>();
    const sent: string[] = [];
    const opts = options((async (url) => {
      sent.push(String(url));
      started.resolve();
      return response.promise;
    }) as typeof fetch);
    let settled = false;
    const lookup = getCodexModelInfo(sol.slug, binding(), "key-a", opts).then((info) => {
      settled = true;
      return info;
    });
    await started.promise;
    await flushMicrotasks();

    jest.advanceTimersByTime(1999);
    await flushMicrotasks();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(lookup).resolves.toBeUndefined();
    response.resolve(capturedResponse());
    await flushMicrotasks();

    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);
    expect(sent).toHaveLength(1);
  });

  test("REQ-15 TEST-21 reads an injected models cache without changing any of its bytes", async () => {
    const cacheFile = join(home, "models_cache.json");
    // Derived cache envelope, not a protocol capture: models are copied unchanged
    // from codex-models-response.json; timestamp/client_version are cache metadata.
    const cacheBytes = JSON.stringify({
      fetched_at: new Date().toISOString(),
      client_version: "0.161.0",
      models: captured.models,
    });
    writeFileSync(cacheFile, cacheBytes);
    const before = readdirSync(home);
    const opts = options((async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch);

    expect(await getCodexModelInfo(sol.slug, binding(), "key-a", opts)).toEqual(expected);
    expect(readFileSync(cacheFile, "utf8")).toBe(cacheBytes);
    expect(readdirSync(home)).toEqual(before);
  });

  test("REQ-15 TEST-22 successful discovery never persists models to the injected home", async () => {
    expect(
      await getCodexModelInfo(
        sol.slug,
        binding(),
        "key-a",
        options((async () => capturedResponse()) as unknown as typeof fetch)
      )
    ).toEqual(expected);
    expect(readdirSync(home)).toEqual([]);
  });
});
