import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildAuthControl } from "../child-auth-types.js";
import type { ClaudeAdvisorAuth, ClaudeRequestFacts } from "./native-handler-advisor.js";
import type { SigningSecrets } from "./shared/call-context.js";

const FILE = import.meta.path;
const TIMEOUT = 20_000;

if (process.env.T4_ISOLATED_FILE !== FILE) {
  test(
    "T4 G2/G4 runs with an isolated HOME and no inherited credentials",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "t4-claude-arm-"));
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(ANTHROPIC|CLAUDE|CLAUDISH|OPENAI|OP_)/.test(key)) delete env[key];
      }
      const child = Bun.spawn([process.execPath, "test", FILE], {
        cwd: home,
        env: {
          ...env,
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, "claude"),
          T4_ISOLATED_FILE: FILE,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        console.info(stdout + stderr);
        expect(code).toBe(0);
      } finally {
        child.kill();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT
  );
} else {
  let api: typeof import("./native-handler-advisor.js");
  let callContext: typeof import("./shared/call-context.js");
  let wrapAnthropicError: typeof import("./shared/anthropic-error.js").wrapAnthropicError;
  let calculateCost: typeof import("./shared/remote-provider-types.js").calculateCost;
  let Hono: typeof import("hono").Hono;
  const dataRoot = join(import.meta.dir, "../test-fixtures");
  const inbound = readFileSync(join(dataRoot, "advisor/inbound-login.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((entry) => entry.body?.toolsCount > 0);
  const requestBody = JSON.parse(
    readFileSync(join(dataRoot, "code-mode/cc-2.1.304-inbound-system.jsonl"), "utf8")
      .trim()
      .split("\n")[0]!
  ).body;
  const matrix = JSON.parse(
    readFileSync(join(dataRoot, "advisor/replay-results-1792535094326.json"), "utf8")
  );
  const accepted = matrix.results.find((entry: any) => entry.shape === "A");
  const refused = matrix.results.find((entry: any) => entry.shape === "A0");
  const token = "OPAQUE_TEST_TOKEN_abc";
  const inboundKey = "OPAQUE_TEST_KEY_inbound";
  const resolvedKey = "OPAQUE_TEST_KEY_resolved";
  const leases: SigningSecrets[] = [];
  const noNetwork = (() => {
    throw new Error("T4 forbids network");
  }) as unknown as typeof fetch;
  let successBody: string;

  beforeAll(async () => {
    globalThis.fetch = noNetwork;
    api = await import("./native-handler-advisor.js");
    callContext = await import("./shared/call-context.js");
    ({ wrapAnthropicError } = await import("./shared/anthropic-error.js"));
    ({ calculateCost } = await import("./shared/remote-provider-types.js"));
    ({ Hono } = await import("hono"));
    const logger = await import("../logger.js");
    logger.initLogger(false, "minimal", true);
    logger.setStderrQuiet(true);
    const { sseResponseToJson } = await import("./shared/collect-sse-message.js");
    // Derive the JSON reply with the production collector from this real Anthropic SSE capture.
    successBody = await (
      await sseResponseToJson(
        new Response(
          readFileSync(
            join(dataRoot, "sse-responses/minimax-m3-anthropic-implicit-signature-r10416.sse")
          ),
          { headers: { "content-type": "text/event-stream" } }
        ),
        accepted.tier
      )
    ).text();
  });

  afterEach(() => {
    for (const secrets of leases.splice(0)) secrets.lease.release();
    api._debug_resetClaudeAuthWarnings();
    api._debug_resetClaudeAdvisorSpend();
    globalThis.fetch = noNetwork;
  });

  async function facts(
    options: {
      childAuth?: ChildAuthControl;
      bearer?: string | null;
      key?: string;
      userToken?: string;
      omitBeta?: boolean;
    } = {}
  ): Promise<ClaudeRequestFacts> {
    // Header map from the S0 main-turn capture; only the redacted credential is replaced.
    const headers = new Headers(inbound.headers);
    if (options.bearer === null) headers.delete("authorization");
    else headers.set("authorization", `Bearer ${options.bearer ?? token}`);
    if (options.key) headers.set("x-api-key", options.key);
    if (options.omitBeta) headers.delete("anthropic-beta");
    const app = new Hono();
    let result!: ClaudeRequestFacts;
    app.post("/", (c) => {
      const secrets = callContext.createSigningSecrets();
      leases.push(secrets);
      c.set(callContext.SIGNING_SECRETS_KEY, secrets);
      result = api.claudeRequestFacts(c, requestBody, {
        childAuth: options.childAuth ?? { controlled: true },
        env: options.userToken ? { ANTHROPIC_AUTH_TOKEN: options.userToken } : {},
      });
      return c.text("ok");
    });
    await app.request("/", { method: "POST", headers });
    return result;
  }

  function callParams(auth: ClaudeAdvisorAuth, role: "panel" | "collector" = "panel") {
    return {
      role,
      spec: accepted.tier,
      model: accepted.tier,
      auth,
      system: accepted.sent.systemShape.blocks.at(-1).text,
      // Turns derived from the real inbound Claude Code capture, not a synthetic request body.
      turns: [
        {
          role: "user" as const,
          content: api.extractBlocksAsText(requestBody.messages[0].content),
        },
      ],
      timeoutMs: 1000,
    };
  }

  function fetchReply(body = successBody, status = 200, headers: HeadersInit = {}) {
    const requests: Request[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input instanceof Request ? input.clone() : new Request(input, init));
      return new Response(body, { status, headers });
    }) as unknown as typeof fetch;
    return { requests, fetchImpl };
  }

  describe("G2 Claude login arm — A1/A9 and S0", () => {
    for (const role of ["panel", "collector"] as const) {
      test(
        `${role}: controlled login signs only the fixed Anthropic endpoint with shape A`,
        async () => {
          const f = await facts({ omitBeta: true });
          let resolutions = 0;
          const auth = await api.resolveClaudeAdvisorAuth(f, async () => {
            resolutions++;
            return resolvedKey;
          });
          expect(auth.arm).toBe("oauth");
          expect(resolutions).toBe(0);
          const reply = fetchReply();
          const warnings: string[] = [];
          const result = await api.runClaudeAdvisorCall({
            ...callParams(auth, role),
            ...reply,
            warn: (message) => warnings.push(message),
          });
          expect(reply.requests).toHaveLength(1);
          const request = reply.requests[0]!;
          expect(request.url).toBe("https://api.anthropic.com/v1/messages");
          expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
          expect(request.headers.has("x-api-key")).toBe(false);
          const body = await request.json();
          expect(body.system[0]).toEqual({ type: "text", text: f.identityBlock });
          expect(body.system[0]).not.toHaveProperty("cache_control");
          expect(body.system).toHaveLength(2);
          expect(result).toMatchObject({
            origin: "upstream",
            servedArm: "oauth",
            billing: "subscription",
            systemHead: "identity",
          });
          expect(warnings).toEqual([]);
          expect(JSON.stringify(result)).not.toContain(token);
        },
        TIMEOUT
      );
    }

    test(
      "the captured advisor beta is stripped without removing the login beta",
      async () => {
        const auth = await api.resolveClaudeAdvisorAuth(await facts(), async () => undefined);
        const reply = fetchReply();
        await api.runClaudeAdvisorCall({ ...callParams(auth), ...reply, warn() {} });
        const beta = reply.requests[0]!.headers.get("anthropic-beta")!;
        expect(beta).not.toContain("advisor-tool-2026-03-01");
        expect(beta).toContain("oauth-2025-04-20");
      },
      TIMEOUT
    );

    for (const source of ["settings-auth-token", "api-key-helper", "proxy-auth"] as const) {
      test(
        `uncontrolled ${source} never signs with a bearer and warns before metered use`,
        async () => {
          const f = await facts({
            childAuth: { controlled: false, reason: source, where: "T4 settings" },
            key: inboundKey,
          });
          let resolutions = 0;
          const auth = await api.resolveClaudeAdvisorAuth(f, async () => {
            resolutions++;
            return resolvedKey;
          });
          expect(f.login).toBeUndefined();
          expect(f.loginSkipped).toBe("launch-auth-not-claudish-controlled");
          expect(auth).toMatchObject({ arm: "api-key", source: "inbound-x-api-key" });
          expect(resolutions).toBe(0);
          const reply = fetchReply();
          const warnings: string[] = [];
          const result = await api.runClaudeAdvisorCall({
            ...callParams(auth),
            ...reply,
            warn: (message) => warnings.push(message),
          });
          expect(reply.requests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
          expect(reply.requests[0]!.headers.has("authorization")).toBe(false);
          expect(reply.requests[0]!.headers.get("x-api-key")).toBe(inboundKey);
          expect(result).toMatchObject({
            origin: "upstream",
            servedArm: "api-key",
            billing: "metered",
          });
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain(source);
          expect(warnings[0]).toMatch(/metered|billed per token/);
          expect(warnings.join(" ")).not.toContain(token);
        },
        TIMEOUT
      );
    }

    test(
      "a user's ANTHROPIC_AUTH_TOKEN is excluded even when the beta and controlled flag are present",
      async () => {
        const f = await facts({ userToken: token });
        const auth = await api.resolveClaudeAdvisorAuth(f, async () => resolvedKey);
        expect(f.login).toBeUndefined();
        expect(f.loginSkipped).toBe("user-auth-token");
        expect(auth).toMatchObject({ arm: "api-key", source: "ANTHROPIC_API_KEY" });
        const reply = fetchReply();
        const warnings: string[] = [];
        await api.runClaudeAdvisorCall({
          ...callParams(auth),
          ...reply,
          warn: (message) => warnings.push(message),
        });
        expect(reply.requests[0]!.headers.has("authorization")).toBe(false);
        expect(reply.requests[0]!.headers.get("x-api-key")).toBe(resolvedKey);
        expect(warnings.join(" ")).toContain("ANTHROPIC_AUTH_TOKEN");
        expect(warnings.join(" ")).not.toContain(token);
      },
      TIMEOUT
    );

    test(
      "no bearer uses the resolved key, warns once per reason, and warns for a later different reason",
      async () => {
        const noBearer = await api.resolveClaudeAdvisorAuth(
          await facts({ bearer: null }),
          async () => resolvedKey
        );
        const skipped = await api.resolveClaudeAdvisorAuth(
          await facts({ userToken: token }),
          async () => resolvedKey
        );
        const reply = fetchReply();
        const warnings: string[] = [];
        for (const auth of [noBearer, noBearer, skipped, skipped]) {
          const result = await api.runClaudeAdvisorCall({
            ...callParams(auth),
            ...reply,
            warn: (message) => warnings.push(message),
          });
          expect(result.billing).toBe("metered");
        }
        expect(warnings).toHaveLength(2);
        expect(new Set(warnings).size).toBe(2);
        expect(reply.requests.every((request) => !request.headers.has("authorization"))).toBe(true);
      },
      TIMEOUT
    );

    test(
      "no accepted login and no key produces a credential stub without fetching",
      async () => {
        const auth = await api.resolveClaudeAdvisorAuth(
          await facts({ bearer: null }),
          async () => undefined
        );
        const reply = fetchReply();
        const warnings: string[] = [];
        const result = await api.runClaudeAdvisorCall({
          ...callParams(auth),
          ...reply,
          warn: (message) => warnings.push(message),
        });
        expect(reply.requests).toHaveLength(0);
        expect(result.origin).toBe("stub");
        expect(result.reason).toContain("no Claude credential");
        expect(warnings).toHaveLength(1);
      },
      TIMEOUT
    );

    test(
      "S0 429 Error without unified headers is a shape stub, never retried or cooled down",
      async () => {
        // Derived from S0 replay-results-1792535094326.json: captured error type/message/status
        // and headers are passed through the production Anthropic error builder, not retyped.
        const body = JSON.stringify(
          wrapAnthropicError(refused.status, refused.errorMessage, refused.errorType)
        );
        expect(
          api.isClaudeShapeRefusal(refused.status, body, new Headers(refused.responseHeaders))
        ).toBe(true);
        expect(
          api.isClaudeShapeRefusal(refused.status, body, new Headers(accepted.responseHeaders))
        ).toBe(false);
        expect(api.isClaudeShapeRefusal(401, body, new Headers(refused.responseHeaders))).toBe(
          false
        );
        const auth = await api.resolveClaudeAdvisorAuth(await facts(), async () => resolvedKey);
        const reply = fetchReply(body, refused.status, refused.responseHeaders);
        for (let i = 0; i < 2; i++) {
          const result = await api.runClaudeAdvisorCall({
            ...callParams(auth),
            ...reply,
            warn() {},
          });
          expect(result).toMatchObject({
            origin: "stub",
            upstreamStatus: refused.status,
            shapeRefusal: true,
          });
          expect(result.reason).toContain("shape");
          expect(result.reason).toContain("not a quota");
          expect(reply.requests).toHaveLength(i + 1);
        }
        expect(reply.requests.every((request) => request.headers.has("authorization"))).toBe(true);
      },
      TIMEOUT
    );
  });

  describe("G4 advisor stats and the main status line", () => {
    test(
      "Claude stats have request_role advisor and accumulate metered spend, never subscription spend",
      () => {
        const outcome = { upstreamStatus: 200, latencyMs: 1, usage: accepted.ok.usage };
        const login = api.claudeAdvisorStatsEvent(accepted.tier, "oauth", outcome);
        expect(login).toMatchObject({
          request_role: "advisor",
          estimated_cost: 0,
          is_free_model: true,
          provider_name: "native-anthropic",
        });
        const cost = calculateCost(
          "native-anthropic",
          accepted.tier,
          outcome.usage.input_tokens,
          outcome.usage.output_tokens
        );
        expect(cost).toBeGreaterThan(0);
        const first = api.claudeAdvisorStatsEvent(accepted.tier, "api-key", outcome);
        const second = api.claudeAdvisorStatsEvent(accepted.tier, "api-key", outcome);
        expect(first.estimated_cost).toBeCloseTo(cost, 12);
        expect(second).toMatchObject({ request_role: "advisor", is_free_model: false });
        expect(second.estimated_cost).toBeCloseTo(cost * 2, 12);
        const afterLogin = api.claudeAdvisorStatsEvent(accepted.tier, "oauth", outcome);
        expect(afterLogin.estimated_cost).toBeCloseTo(cost * 2, 12);
        const failed = api.claudeAdvisorStatsEvent(accepted.tier, "api-key", {
          upstreamStatus: 429,
          latencyMs: 1,
        });
        expect(failed).toMatchObject({ request_role: "advisor", success: false, http_status: 429 });
        expect(failed.estimated_cost).toBeCloseTo(cost * 2, 12);
      },
      TIMEOUT
    );

    test(
      "Claude panel and collector calls leave the main token file byte-identical",
      async () => {
        const path = join(process.env.HOME!, "main-token.json");
        const sentinel = JSON.stringify({
          model: "main-session",
          input_tokens: 71,
          output_tokens: 9,
        });
        writeFileSync(path, sentinel);
        process.env.CLAUDISH_TOKEN_FILE = path;
        try {
          for (const role of ["panel", "collector"] as const) {
            for (const bearer of [token, null]) {
              const auth = await api.resolveClaudeAdvisorAuth(
                await facts({ bearer }),
                async () => resolvedKey
              );
              await api.runClaudeAdvisorCall({
                ...callParams(auth, role),
                ...fetchReply(),
                warn() {},
              });
              expect(readFileSync(path, "utf8")).toBe(sentinel);
            }
          }
        } finally {
          delete process.env.CLAUDISH_TOKEN_FILE;
        }
      },
      TIMEOUT
    );
  });
}
