// #686 — client attribution to custom endpoints.
//
// The engine behind our own vLLM front sees one credential for ~everything
// (fingerprint be312daf7c1c = VLLM_API_KEY_MEDIUM, 96% of engine traffic,
// measured 25/10), so `machine:workspace` must ride a client-controlled
// header. These pins hold the frozen format: the composed value, the
// part-wise `unknown` fallback (the header is NEVER absent), the verbatim
// machine forward, and the global kill switch.

import { describe, expect, test } from "bun:test";
import {
  clientAttributionEnabled,
  clientAttributionHeaders,
  composeClientAttributionValue,
} from "./client-attribution.js";
import type { Context } from "hono";

function ctxWith(headers: Record<string, string>): Context {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? undefined,
    },
  } as unknown as Context;
}

describe("client-attribution (#686)", () => {
  test("composeClientAttributionValue — both parts present", () => {
    expect(composeClientAttributionValue("myia-po-2025", "claudish")).toBe("myia-po-2025:claudish");
  });

  test("a missing part reads `unknown` — never an absent part, never a blank", () => {
    expect(composeClientAttributionValue("myia-po-2025", null)).toBe("myia-po-2025:unknown");
    expect(composeClientAttributionValue(null, "claudish")).toBe("unknown:claudish");
    expect(composeClientAttributionValue(null, null)).toBe("unknown:unknown");
  });

  test("blank strings are missing, not values — 'not attributable' must be sayable", () => {
    expect(composeClientAttributionValue("  ", "claudish")).toBe("unknown:claudish");
    expect(composeClientAttributionValue("myia-po-2025", "")).toBe("myia-po-2025:unknown");
  });

  test("clientAttributionHeaders — machine forwarded verbatim when present", () => {
    const out = clientAttributionHeaders(ctxWith({ "x-claudish-machine": "myia-po-2025", "x-claudish-workspace": "claudish" }));
    expect(out["x-claudish-client"]).toBe("myia-po-2025:claudish");
    expect(out["x-claudish-machine"]).toBe("myia-po-2025");
  });

  test("clientAttributionHeaders — machine header never fabricated", () => {
    const out = clientAttributionHeaders(ctxWith({ "x-claudish-workspace": "claudish" }));
    expect(out["x-claudish-client"]).toBe("unknown:claudish");
    expect(out["x-claudish-machine"]).toBeUndefined();
  });

  test("kill switch — `0` off, unset/anything else armed", () => {
    expect(clientAttributionEnabled({})).toBe(true);
    expect(clientAttributionEnabled({ CLAUDISH_CLIENT_ATTRIBUTION: undefined })).toBe(true);
    expect(clientAttributionEnabled({ CLAUDISH_CLIENT_ATTRIBUTION: "1" })).toBe(true);
    expect(clientAttributionEnabled({ CLAUDISH_CLIENT_ATTRIBUTION: "0" })).toBe(false);
  });
});
