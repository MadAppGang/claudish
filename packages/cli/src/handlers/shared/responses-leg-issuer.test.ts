import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type LegAuthBinding,
  type LegIssuerDeps,
  createLegIssuer,
} from "./responses-leg-issuer.js";

interface Binding extends LegAuthBinding {
  token: string;
}
function fixture(
  options: {
    responses?: Response[];
    refresh?: Binding;
    force?: Binding;
    throws?: boolean;
    mayForceRefresh?: () => boolean;
    issuer?: typeof createLegIssuer;
  } = {}
) {
  let current: Binding = { auth: { arm: "oauth" }, accountKey: "account-a", token: "initial" };
  let forced = 0;
  const sent: Array<{ url: string; authorization: string }> = [];
  const responses = options.responses ?? [new Response("", { status: 200 })];
  const deps: LegIssuerDeps<Binding> = {
    providerDisplayName: "Codex test",
    getBinding: () => current,
    setBinding: (binding) => {
      current = binding;
    },
    refreshAuth: async () => options.refresh ?? current,
    forceRefreshAuth: async () => {
      forced++;
      return options.force ?? { ...current, token: "refreshed" };
    },
    mayForceRefresh: options.mayForceRefresh,
    getEndpoint: (binding) => `http://injected.invalid/${binding?.accountKey}`,
    fetchHeaders: async (binding) => ({ authorization: binding?.token ?? "" }),
    // The issuer treats serialized bytes as opaque; reuse real captured bytes rather than invent a request body.
    serializeBody: () => ({
      body: readFileSync(
        new URL(
          "../../test-fixtures/sse-responses/codex-zero-delta-multicall.sse",
          import.meta.url
        ),
        "utf8"
      ),
      contentType: "text/event-stream",
    }),
    settleStreamHead: async (response) => ({ kind: "ok", response }),
    legDeadlineAt: () => performance.now() + 1000,
    now: () => 12345,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      if (options.throws) throw new TypeError("injected transport disconnected");
      const next = responses.shift();
      if (!next) throw new Error("Unexpected extra request");
      return next;
    }) as typeof fetch,
  };
  return { issue: (options.issuer ?? createLegIssuer)(deps), sent, forced: () => forced };
}

describe("REQ-16 retry leg authentication and errors", () => {
  test("M4 a spent forced-sign budget returns the leg's 401 without resending its bearer", async () => {
    // implementation-log.md § v14 merge fixes / M4; disposable source-copy mutation.
    const root = mkdtempSync(join(tmpdir(), "claudish-leg-budget-"));
    try {
      let issuer = createLegIssuer;
      if (process.env.V14_LEG_MUTATION === "ignore-budget") {
        const path = join(import.meta.dir, "responses-leg-issuer.ts");
        const original = readFileSync(path, "utf8");
        const mutated = original.replace("&& (deps.mayForceRefresh?.() ?? true)", "");
        expect(mutated, "mutation reached issuer budget seam").not.toBe(original);
        const copy = join(root, "issuer.ts");
        writeFileSync(
          copy,
          mutated.replace(
            /(from\s+|import\s*\(\s*)(["'])(\.[^"']+)\2/g,
            (_all, lead, quote, spec) => lead + quote + Bun.resolveSync(spec, dirname(path)) + quote
          )
        );
        issuer = (await import(copy)).createLegIssuer;
      }
      const f = fixture({
        issuer,
        mayForceRefresh: () => false,
        responses: [
          new Response("rejected leg bearer", { status: 401 }),
          new Response("must not resend"),
        ],
      });
      const result = await f.issue(undefined, new AbortController().signal);
      expect(f.sent).toHaveLength(1);
      expect(f.forced()).toBe(0);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("Expected rejected leg error");
      expect(result.message).toContain("HTTP 401");
      expect(result.message).toContain("rejected leg bearer");
      expect(f.sent[0].authorization).toBe("initial");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("REQ-16 TEST-20 a 401 refreshes once and re-fetches with the freshly bound credential", async () => {
    const f = fixture({
      responses: [new Response("unauthorized", { status: 401 }), new Response("healthy")],
    });
    const result = await f.issue(undefined, new AbortController().signal);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected successful leg");
    expect(result.headersAt).toBe(12345);
    expect(await result.response.text()).toBe("healthy");
    expect(f.forced()).toBe(1);
    expect(f.sent.map((r) => r.authorization)).toEqual(["initial", "refreshed"]);
  });

  for (const phase of ["refresh", "force"] as const) {
    for (const change of ["arm", "account"] as const) {
      test(`REQ-16 TEST-21 ${phase} ${change} change returns error and is never resent`, async () => {
        const next: Binding = {
          auth: { arm: change === "arm" ? "api-key" : "oauth" },
          accountKey: change === "account" ? "account-b" : "account-a",
          token: "changed",
        };
        const f = fixture({
          [phase]: next,
          responses: [new Response("unauthorized", { status: 401 })],
        });
        const result = await f.issue(undefined, new AbortController().signal);
        expect(result.kind).toBe("error");
        if (result.kind !== "error") throw new Error("Expected credential-silo error");
        expect(result.message.toLowerCase()).toContain("sign-in changed");
        expect(f.sent).toHaveLength(phase === "refresh" ? 0 : 1);
      });
    }
  }

  test("REQ-16 TEST-22 a retry-leg 429 preserves HTTP status and upstream wording", async () => {
    const f = fixture({ responses: [new Response("usage limit reached", { status: 429 })] });
    const result = await f.issue(undefined, new AbortController().signal);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("Expected 429 leg error");
    expect(result.message).toContain("429");
    expect(result.message).toContain("usage limit reached");
    expect(f.sent).toHaveLength(1);
    expect(f.forced()).toBe(0);
  });

  test("REQ-16 TEST-22 a transport throw becomes an error result rather than a fabricated HTTP verdict", async () => {
    const f = fixture({ throws: true });
    const result = await f.issue(undefined, new AbortController().signal);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("Expected transport leg error");
    expect(result.message).toContain("injected transport disconnected");
    expect(f.sent).toHaveLength(1);
  });

  test("REQ-16 TEST-20 a repeated 401 does not force-refresh twice", async () => {
    const f = fixture({
      responses: [
        new Response("unauthorized", { status: 401 }),
        new Response("still unauthorized", { status: 401 }),
      ],
    });
    const result = await f.issue(undefined, new AbortController().signal);
    expect(result.kind).toBe("error");
    expect(f.forced()).toBe(1);
    expect(f.sent).toHaveLength(2);
  });
});
