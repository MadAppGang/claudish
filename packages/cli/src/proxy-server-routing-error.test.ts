/**
 * S4-d lot A (absorbed upstream bbb448f6 + 218c3586, proxy-server.ts side):
 * routing failures are TERMINAL 400s, and no route rejection can reach a
 * console.
 *
 * The doctrine being pinned: `defaultProvider`/last-resort fallback applies to
 * BARE names only. An explicit provider@model spec whose credential is missing
 * must fail loudly with an actionable hint — never silently fall through to the
 * OpenRouter handler (step 7), which catalog-resolves the bare model name to
 * some unrelated model while Claude Code loops on "API error · Retrying ·
 * attempt N/10" against a retryable 500.
 *
 * Plus the structural pins the S4-d dispatch requires of the implementation PR:
 * relay-before-intercept ordering, resolveFailoverTargetForSession as the single
 * resolution seam, and the fail-closed CLAUDISH_NO_ANTHROPIC guard. The
 * stepFailures-survives-TTL invariant is pinned behaviorally in
 * fork/failover.test.ts (per-step backoff outlives the role-arm TTL).
 *
 * Black-box tests drive the real proxy in-process via createProxyServer() on a
 * loopback port (upstream's harness shape). No network call happens on the
 * fail-loud paths — resolution fails before any upstream fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createProxyServer } from "./proxy-server.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { wrapAnthropicError } from "./handlers/shared/anthropic-error.js";
import type { ProxyServer } from "./types.js";

// ---- harness -----------------------------------------------------------------

const PORT_BASE = 19700;
let portCounter = 0;
const nextPort = () => PORT_BASE + (portCounter++ % 200);

let activeProxy: ProxyServer | null = null;

// profile-config resolves its path at module load as join(homedir(), ".claudish",
// "config.json") and reads per call — so determinism (no operator
// customEndpoints, no stored keys, no defaultProvider) requires sandboxing the
// REAL file and restoring it afterwards. Same strategy as upstream's
// explicit-spec-no-credential.test.ts.
const CONFIG_DIR = join(homedir(), ".claudish");
const REAL_CONFIG_PATH = join(CONFIG_DIR, "config.json");
let configBackup: string | null = null;
let configExisted = false;

// Provider credential env vars — snapshotted+deleted for the duration so the
// missing-credential paths are deterministic on any machine (a dev box with
// every key set must behave like a bare CI runner).
const PROVIDER_ENV_KEYS = [
  "ZAI_API_KEY", "ZAI_CODING_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY",
  "GLM_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_CODING_API_KEY",
  "OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY", "MINIMAX_CODING_API_KEY", "LITELLM_API_KEY", "POE_API_KEY",
  "DEEPSEEK_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDISH_NO_ANTHROPIC", "CLAUDISH_FAILOVER_ACTIVE",
  // Proxy AUTH, not a provider credential — and the reason every HTTP
  // assertion below was inert on any provisioned machine: `bun` auto-loads
  // the repo `.env` (bash does not), that file carries CLAUDISH_PROXY_KEY on
  // every deployed host, so `proxyKeys` came back non-empty
  // (proxy-server.ts:393-396) and the requests took a 401 "invalid proxy
  // authentication" BEFORE reaching guard 6b or any RoutingError mapping.
  // 4 of 12 red on ai-01, green on a machine with no such `.env` — which is
  // exactly the "dev box must behave like a bare CI runner" goal above.
  "CLAUDISH_PROXY_KEY", "CLAUDISH_PROXY_KEY_PREVIOUS",
];
const savedEnv: Record<string, string | undefined> = {};

function sandbox(): void {
  configExisted = existsSync(REAL_CONFIG_PATH);
  configBackup = configExisted ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify({}), "utf-8");
  for (const k of PROVIDER_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify(config), "utf-8");
}

function restore(): void {
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExisted && existsSync(REAL_CONFIG_PATH)) {
    try { rmSync(REAL_CONFIG_PATH); } catch {}
  }
  configBackup = null;
  configExisted = false;
  for (const k of PROVIDER_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

async function spin(): Promise<number> {
  const port = nextPort();
  activeProxy = await createProxyServer(port, undefined, undefined, false, undefined, undefined, {
    quiet: true,
  });
  return port;
}

async function ask(
  port: number,
  model: string,
  route = "/v1/messages"
): Promise<{ status: number; raw: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  let raw: any;
  try { raw = await res.json(); } catch { raw = null; }
  return { status: res.status, raw };
}

beforeEach(() => { sandbox(); });
afterEach(async () => {
  if (activeProxy) { await activeProxy.shutdown(); activeProxy = null; }
  restore();
});

// ---- bbb448f6: explicit spec without credential fails loud, terminal 400 ------

describe("S4-d lot A: RoutingError → terminal 400 (bbb448f6)", () => {
  test("explicit spec with missing credential → 400 invalid_request_error naming the env var, not 500", async () => {
    const port = await spin();
    const { status, raw } = await ask(port, "zai@gm-4.6");

    expect(status).toBe(400);
    expect(raw?.type).toBe("error");
    expect(raw?.error?.type).toBe("invalid_request_error");
    expect(raw?.error?.message).toContain("could not be routed");
    expect(raw?.error?.message).toContain("ZAI_API_KEY");
    // The regression this pins: the pre-absorption behavior fell through to the
    // OpenRouter handler (step 7) — an eventual retryable-looking failure with
    // the real cause (no zai credential) never mentioned.
    expect(status).not.toBe(500);
  });

  test("count_tokens maps the same RoutingError to 400 (second catch site)", async () => {
    const port = await spin();
    const { status, raw } = await ask(port, "zai@gm-4.6", "/v1/messages/count_tokens");

    expect(status).toBe(400);
    expect(raw?.error?.type).toBe("invalid_request_error");
    expect(raw?.error?.message).toContain("ZAI_API_KEY");
  });

  test("explicit OpenRouter spec (or@ / openrouter@) still falls through to the OR handler — no RoutingError", async () => {
    const port = await spin();
    // count_tokens avoids any upstream fetch: a non-native handler answers with
    // the token estimate, proving resolution succeeded past the 6b guard.
    const { status, raw } = await ask(port, "or@qwen/qwen3-coder-next", "/v1/messages/count_tokens");

    expect(status).toBe(200);
    expect(typeof raw?.input_tokens).toBe("number");
  });

  test("bare name with no credentialed route → [Route] failure is a terminal 400, not a retryable 500", async () => {
    // A bare unrecognized name classifies native-anthropic and skips 2c unless
    // the user explicitly routed it (roo-extensions #3401) — so the no-route
    // throw is reachable through a user routing override whose provider has no
    // credential in this sandboxed env.
    writeConfig({
      routing: { "totally-unknown-model-xyz-9f3a": ["google@gemini-2.0-flash"] },
    });
    const port = await spin();
    const { status, raw } = await ask(port, "totally-unknown-model-xyz-9f3a");

    expect(status).toBe(400);
    expect(raw?.error?.type).toBe("invalid_request_error");
    expect(raw?.error?.message).toContain("[Route]");
  });

  test("non-routing errors keep their 500 (malformed body)", async () => {
    const port = await spin();
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const raw: any = await res.json();

    expect(res.status).toBe(500);
    expect(raw?.error?.type).toBe("api_error");
  });
});

// ---- fail-closed leak guard, behavioral (invariant from the S4-d dispatch) ----

describe("S4-d lot A: CLAUDISH_NO_ANTHROPIC stays fail-closed", () => {
  test("bare native name on a NO_ANTHROPIC host without budget reroute → clean 503 refusal, never api.anthropic.com", async () => {
    process.env.CLAUDISH_NO_ANTHROPIC = "1";
    const port = await spin();
    const { status, raw } = await ask(port, "claude-opus-5");

    expect(status).toBe(503);
    expect(raw?.error?.message).toContain("CLAUDISH_NO_ANTHROPIC");
  });
});

// ---- 218c3586: app.onError backstop -------------------------------------------

describe("S4-d lot A: unhandled-error backstop (218c3586)", () => {
  test("a route rejection reaches neither a console nor a text/plain body — it gets a single-line Anthropic JSON 500", async () => {
    // Standalone Hono app with the onError body kept identical to
    // createProxyServer's (upstream's harness): app.request exercises Hono's
    // real unhandled-route rejection path without binding a port.
    const app = new Hono();
    app.onError((err, c) => {
      return c.json(wrapAnthropicError(500, `Proxy error: ${err?.message ?? String(err)}`), 500);
    });
    app.get("/unhandled", () => {
      throw new Error("first line\n\tsecond line\u0007");
    });

    const consoleErrors: unknown[][] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => { consoleErrors.push(args); };
    try {
      const response = await app.request("http://claudish.test/unhandled");
      const raw = await response.text();
      const body = JSON.parse(raw);

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("api_error");
      // c.json serializes: control bytes stay escaped inside the JSON string,
      // so the WIRE stays single-line even before the anthropic-error lane
      // absorbs sanitizeErrorMessage (218c3586's other half).
      expect(raw).not.toMatch(/[\r\n]/);
      expect(raw).not.toBe("Internal Server Error");
      expect(consoleErrors).toEqual([]);
    } finally {
      console.error = realConsoleError;
    }
  });
});

// ---- a9112dce ruling pin (S4-d lot A review, 2026-09-21) ----------------------

describe("S4-d lot A: a9112dce explicitness transition — ACCEPTED (option b), pinned", () => {
  // The original S4-d classification rejected a9112dce with a grep proof
  // ("no NATIVE_MODEL_PATTERNS entry auto-detects openrouter" — 0 hits in
  // model-parser.ts). The instrument was blind, not the file: the patterns are
  // DERIVED from BUILTIN_PROVIDERS (provider-definitions.ts, "Replaces
  // NATIVE_MODEL_PATTERNS in model-parser.ts"), which carries
  // /^openrouter\//i. Executed:
  //   openrouter/qwen/qwen3-coder -> {provider:"openrouter", explicit:FALSE}
  // 2b rewrites that form to openrouter@<resolvedId>, 2c then sees explicit and
  // skips the provider-fallback chain. The ruling: ACCEPT the transition (the
  // name names the aggregator — it routes directly), documented at 2b. This pin
  // records the DECISION so the next grain cannot re-derive it from the refuted
  // proof. A grep is a hypothesis; a derived constant invalidates the searched
  // file — positive control required.
  test("parseModelSpec: openrouter/ is the ONE form that flips explicit at 2b — accepted, not a bug", () => {
    expect(parseModelSpec("openrouter/qwen/qwen3-coder").isExplicitProvider).toBe(false);
    expect(parseModelSpec("openrouter/qwen/qwen3-coder").provider).toBe("openrouter");
    // Already explicit before AND after 2b — no transition:
    expect(parseModelSpec("or/qwen/qwen3-coder").isExplicitProvider).toBe(true);
    expect(parseModelSpec("openrouter@qwen/qwen3-coder").isExplicitProvider).toBe(true);
    // Bare vendor/model forms parse to their OWN provider → stay chain-eligible:
    expect(parseModelSpec("qwen/qwen3-coder").provider).toBe("qwen");
    expect(parseModelSpec("qwen/qwen3-coder").isExplicitProvider).toBe(false);
  });
});

// ---- #65 composition pin (dispatch: pin by test, not by comment) --------------

describe("S4-d lot A: RoutingError is PRE-STREAM — composes with the #65 mid-stream policy lane without interaction", () => {
  test("the RoutingError 400 is a plain JSON response, never an SSE stream", async () => {
    const port = await spin();
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "zai@gm-4.6",
        max_tokens: 16,
        stream: true, // even when the client asked to stream
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const raw: any = await res.json();

    // RoutingError fires at handler CONSTRUCTION (before any stream exists),
    // which is what makes it a lane distinct from the #65 policy-refusal retry
    // (mid-stream predicate !sawMessageStart && highestSeenIndex === -1 &&
    // !lastBlockOpen in anthropic-sse.ts). Asserting content-type JSON — not
    // text/event-stream — is the pin that the two lanes cannot meet.
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(raw?.error?.type).toBe("invalid_request_error");
    // And never the #65 surfacing marker:
    expect(JSON.stringify(raw)).not.toContain("[Upstream policy refusal");
  });
});

// ---- structural pins (S4-d dispatch: absorb without breaking our invariants) --

describe("S4-d lot A: structural invariant pins on proxy-server.ts source", () => {
  const source = readFileSync(new URL("./proxy-server.ts", import.meta.url), "utf-8");

  test("relay branch stays BEFORE interceptWebTools / getHandlerForRequest / logRequest in /v1/messages", () => {
    const routeStart = source.indexOf('app.post("/v1/messages"');
    const routeEnd = source.indexOf('app.post("/v1/chat/completions"');
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = source.slice(routeStart, routeEnd);

    const relayAt = route.indexOf("forwardToUpstream(");
    const interceptAt = route.indexOf("interceptWebTools(");
    const handlerAt = route.indexOf("getHandlerForRequest(");
    const logAt = route.indexOf("logRequest(");

    // A one-sided hunk from upstream would invert this order without breaking
    // the build; mode-aware capture and the leak policy depend on it.
    expect(relayAt).toBeGreaterThan(-1);
    expect(interceptAt).toBeGreaterThan(relayAt);
    expect(handlerAt).toBeGreaterThan(interceptAt);
    expect(logAt).toBeGreaterThan(handlerAt);
  });

  test("resolveFailoverTargetForSession remains the single resolution seam (handler swap + cascade loop)", () => {
    const count = (source.match(/resolveFailoverTargetForSession\(/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("the 6b fail-loud guard sits BEFORE the step-7 OpenRouter fall-through", () => {
    const guardAt = source.indexOf("Explicit model \"${target}\" could not be routed");
    const step7At = source.indexOf(
      "7. OpenRouter Handler (default for any model with \"/\" or explicit OpenRouter spec)"
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(step7At).toBeGreaterThan(guardAt);
  });

  // Review addition (ai-01, 2026-09-21). The onError backstop returned 500 for
  // EVERY error, RoutingError included. Not a live defect — all three routes
  // that can raise one map it first — but it is where a FUTURE route lands, and
  // a 500 there hands back the retryable status this change exists to remove.
  // Structural rather than behavioural on purpose: making a RoutingError escape
  // to onError requires a route that does not exist yet, so a behavioural test
  // would have to invent one and would then pin the invention, not the backstop.
  test("the onError backstop keeps a RoutingError terminal (400, not a retryable 500)", () => {
    const onErrorAt = source.indexOf("app.onError((err, c) =>");
    expect(onErrorAt).toBeGreaterThan(-1);
    // Scope to the handler body, so a mapping elsewhere in the file cannot
    // satisfy this by accident — the whole point is WHERE the check sits.
    const body = source.slice(onErrorAt, onErrorAt + 1200);
    expect(body).toContain("err instanceof RoutingError");
    const mapAt = body.indexOf("err instanceof RoutingError");
    const fallbackAt = body.indexOf("wrapAnthropicError(500");
    expect(fallbackAt).toBeGreaterThan(mapAt); // the 400 must be reached first
  });

  // Added 2026-09-22 (po-2025, hub-bearer cycle). The /v1/messages catch and the
  // /count_tokens catch both returned 500 through log(), which writes to the
  // debug FILE only and is a no-op unless --debug — and the hub container runs
  // with debug off. So the hub could serve a 500 while its own `docker logs`
  // showed nothing at all, which is precisely the shape the fleet reported as
  // `hub HTTP 500` with no obtainable cause (relay.ts maps any `status >= 500`
  // to markFail → AUTONOMOUS hysteresis). Measured on the hub 2026-09-22
  // 03:18:02Z: 18 requests across 6 machines and 4 models reached no upstream
  // (no `[ttft]` for any of them) and the hub logged no line — while the
  // instrument that WOULD have carried one was demonstrably live (773
  // `[claudish]` lines in the same 20-minute window, all through logStderr).
  // Structural pin: a future refactor must not silence this again.
  test("a 500 on a forwarded route emits a countable stderr marker, not a silent log()", () => {
    const markers = source.match(/\[Proxy\] ERROR 500/g) ?? [];
    // Positive control: the pattern must actually match, or "not silent" would
    // be vacuous. Two sites: /v1/messages and /count_tokens.
    expect(markers.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("logStderr(`[Proxy] ERROR 500");
    // and never the silent form: `log(` here would be invisible without --debug
    expect(source).not.toContain("log(`[Proxy] ERROR 500");
  });
});
