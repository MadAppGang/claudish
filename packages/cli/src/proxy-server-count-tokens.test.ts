import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setConfigFileOverride } from "./config-override.js";
import { createProxyServer } from "./proxy-server.js";
import { redactSecrets } from "./redact.js";
import type { ProxyServer } from "./types.js";

/**
 * PROVISIONAL: this repo has no captured native count_tokens success/error
 * bodies yet. Replace the constructed upstream responses below with a real
 * api.anthropic.com count_tokens capture from Phase V.
 */
interface CapturedUpstream {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

async function countTokensAgainst(
  upstreamResponse: () => Response,
  requestHeaders: Record<string, string> = {},
  constructionKey?: string
): Promise<{
  status: number;
  body: Record<string, unknown>;
  upstream: CapturedUpstream[];
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "claudish-count-tokens-"));
  const configPath = join(tempDir, "config.json");
  writeFileSync(configPath, "{}", "utf8");
  setConfigFileOverride(configPath);

  const calls: CapturedUpstream[] = [];
  const upstreamServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        headers[name] = value;
      });
      calls.push({
        url: request.url,
        headers,
        body: JSON.parse(await request.text()) as Record<string, unknown>,
      });
      return upstreamResponse();
    },
  });

  const savedOverride = process.env.CLAUDISH_TEST_UPSTREAM;
  const savedDisableKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  const savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  process.env.CLAUDISH_TEST_UPSTREAM = `api.anthropic.com=http://127.0.0.1:${upstreamServer.port}`;
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  process.env.CLAUDISH_DISABLE_OP = "1";
  let proxy: ProxyServer | undefined;

  try {
    let create = createProxyServer;
    const mutation = process.env.V14_COUNT_MUTATION;
    if (mutation) {
      const originalPath = join(import.meta.dir, "proxy-server.ts");
      const original = readFileSync(originalPath, "utf8");
      const mutated =
        mutation === "no-lease"
          ? original.replace("addSigningSecrets(c, credentialValuesFromRequest(headers));", "")
          : mutation === "raw-error"
            ? original.replace("JSON.parse(res.ok ? raw : redactForClient(raw))", "JSON.parse(raw)")
            : mutation === "redact-success"
              ? original.replace(
                  "JSON.parse(res.ok ? raw : redactForClient(raw))",
                  "JSON.parse(redactForClient(raw))"
                )
              : original.replace("res.status === 401 || res.status === 403", "false");
      expect(mutated, "mutation reached count_tokens seam").not.toBe(original);
      const copy = join(tempDir, "proxy-server.ts");
      writeFileSync(
        copy,
        mutated.replace(/(from\s+|import\s*\(\s*)(["'])([^"']+)\2/g, (all, lead, quote, spec) => {
          try {
            return lead + quote + Bun.resolveSync(spec, dirname(originalPath)) + quote;
          } catch {
            return all;
          } // Leave prose mentioning 'from "..."' unchanged.
        })
      );
      create = (await import(copy)).createProxyServer;
    }
    proxy = await create(0, undefined, undefined, false, constructionKey, undefined, {
      quiet: true,
    });
    const response = await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...requestHeaders },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "count this" }],
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      upstream: calls,
    };
  } finally {
    if (proxy) await proxy.shutdown();
    upstreamServer.stop(true);
    setConfigFileOverride(null);
    rmSync(tempDir, { recursive: true, force: true });
    if (savedOverride === undefined) delete process.env.CLAUDISH_TEST_UPSTREAM;
    else process.env.CLAUDISH_TEST_UPSTREAM = savedOverride;
    if (savedDisableKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedDisableKeychain;
    if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
    else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  }
}

describe("POST /v1/messages/count_tokens native forwarding", () => {
  test("forwards inbound subscription auth and Anthropic protocol headers", async () => {
    const result = await countTokensAgainst(
      () =>
        new Response(JSON.stringify({ input_tokens: 37 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      {
        Authorization: "Bearer inbound-oauth",
        "x-api-key": "inbound-api-key",
        "anthropic-beta": "oauth-2025-04-20,test-beta",
        "anthropic-version": "2024-01-01",
      }
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ input_tokens: 37 });
    expect(result.upstream).toHaveLength(1);
    expect(new URL(result.upstream[0].url).pathname).toBe("/v1/messages/count_tokens");
    expect(result.upstream[0].headers.authorization).toBe("Bearer inbound-oauth");
    expect(result.upstream[0].headers["x-api-key"]).toBe("inbound-api-key");
    expect(result.upstream[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20,test-beta");
    expect(result.upstream[0].headers["anthropic-version"]).toBe("2024-01-01");

    // Mutation caught: restore api-key-only signing. The inbound OAuth and beta
    // headers disappear (and the old code sends an empty construction-time key).
  });

  test("preserves a non-auth upstream status instead of publishing an error body as 200", async () => {
    const result = await countTokensAgainst(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "rate limited" },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        ),
      { Authorization: "Bearer inbound-oauth" }
    );

    expect(result.status).toBe(429);
    expect(result.body).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "rate limited" },
    });

    // Mutation caught: return c.json(await res.json()) without res.status. That
    // old path republishes this exact upstream 429 as HTTP 200.
  });

  for (const status of [400, 429]) {
    for (const source of ["bearer", "x-api-key", "construction-key"] as const) {
      test(`M1 ${status} redacts the ${source} from the upstream error and active signing sinks`, async () => {
        // implementation-log.md § v14 merge fixes / M1. Scripted echo, not a vendor capture.
        const secret = "COUNT_TOKEN_CREDENTIAL_" + source + "_ONLY_THIS_REQUEST";
        let sink = "";
        const result = await countTokensAgainst(
          () => {
            sink = redactSecrets("upstream quoted " + secret);
            return Response.json({ error: { message: "upstream quoted " + secret } }, { status });
          },
          source === "bearer"
            ? { Authorization: "Bearer " + secret }
            : source === "x-api-key"
              ? { "x-api-key": secret }
              : {},
          source === "construction-key" ? secret : undefined
        );
        expect(result.status).toBe(status);
        expect(result.upstream).toHaveLength(1);
        expect(
          result.upstream[0].headers[source === "bearer" ? "authorization" : "x-api-key"]
        ).toBe(source === "bearer" ? "Bearer " + secret : secret);
        expect(JSON.stringify(result.body)).not.toContain(secret);
        expect(JSON.stringify(result.body)).toContain("[redacted]");
        expect(sink).not.toContain(secret);
        expect(sink).toContain("[redacted]");
      });
    }
  }

  test("M1 preserves a successful count body without redacting its values", async () => {
    const secret = "SUCCESS_COUNT_CREDENTIAL_VALUE";
    const payload = { input_tokens: 37, upstream_note: secret };
    const result = await countTokensAgainst(() => Response.json(payload), { "x-api-key": secret });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(payload);
  });

  for (const status of [401, 403]) {
    test(`M1 falls back to a token estimate for ${status} instead of returning an error-shaped count`, async () => {
      const result = await countTokensAgainst(
        () =>
          new Response(
            JSON.stringify({
              type: "error",
              error: { type: "authentication_error", message: "expired login" },
            }),
            { status, headers: { "Content-Type": "application/json" } }
          ),
        { Authorization: "Bearer expired-oauth" }
      );

      expect(result.status).toBe(200);
      expect(typeof result.body.input_tokens).toBe("number");
      expect(result.body.error).toBeUndefined();

      // Mutation caught: preserve 401 blindly. Authentication failure is the one
      // documented exception to status passthrough because it is not a token count.
    });
  }
});
