import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  credentialHttpError,
  isTransientCredentialError,
  terminalCredentialError,
} from "../../auth/credentials/credential-error.js";
import {
  AUTH_VERDICT_HEADER,
  authVerdict,
  authVerdictHeaders,
  classifyAuthFailure,
  isCredentialRejection,
  respondAuthFailure,
} from "./auth-failure.js";

async function refusedFetch(): Promise<unknown> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const url = `http://127.0.0.1:${server.port}/token`;
  await server.stop(true);
  try {
    await fetch(url);
  } catch (error) {
    return error;
  }
  throw new Error("Refused-fetch fixture unexpectedly succeeded");
}

describe("F1: credential failure classification", () => {
  test("real connection failure wins over terminal and transient markers, including causes", async () => {
    const raw = await refusedFetch();
    expect(classifyAuthFailure(raw).kind).toBe("connection");
    const wrapped = Object.assign(new Error("run `claudish login muse`", { cause: raw }), {
      terminal: true,
      transient: true,
      upstreamStatus: 503,
    });
    expect(classifyAuthFailure(wrapped).kind).toBe("connection");
  });

  test("positive terminal marker wins over transient marker", () => {
    const error = Object.assign(terminalCredentialError("run `claudish login muse`", 401), {
      transient: true,
    });
    expect(classifyAuthFailure(error)).toEqual({
      kind: "terminal",
      message: "run `claudish login muse`",
      upstreamStatus: 401,
    });
  });

  test.each([429, 500, 503])("HTTP %i is transient, with its status retained", (status) => {
    const error = credentialHttpError(`key service unavailable (${status})`, status);
    expect(isTransientCredentialError(error)).toBe(true);
    expect(classifyAuthFailure(error)).toEqual({
      kind: "transient",
      status,
      message: `key service unavailable (${status})`,
    });
  });

  test.each(["OAuth unavailable", "refresh_token rejected"])(
    "unclassified %s stays unknown",
    (message) => {
      expect(classifyAuthFailure(new Error(message))).toEqual({ kind: "unknown", message });
    }
  );

  test.each(["terminal", "transient"] as const)(
    "%s verdict survives Headers conversion",
    (verdict) => {
      const headers = new Headers(authVerdictHeaders(verdict));
      expect(AUTH_VERDICT_HEADER).toBe("x-claudish-auth-verdict");
      expect(headers.get("x-claudish-auth-verdict")).toBe(verdict);
      expect(authVerdict(headers)).toBe(verdict);
      expect(authVerdict(new Headers())).toBeUndefined();
    }
  );

  test.each([
    [
      terminalCredentialError("run `claudish login muse`", 401),
      true,
      400,
      "terminal",
      "login muse",
    ],
    [
      terminalCredentialError(
        "subscribe at https://accountscenter.meta.com/muse_code/?ep=no_payg",
        403
      ),
      true,
      400,
      "terminal",
      "subscribe at",
    ],
    [credentialHttpError("key service unavailable (429)", 429), true, 429, "transient", "429"],
    [credentialHttpError("key service unavailable (500)", 500), true, 503, "transient", "500"],
    [credentialHttpError("key service unavailable (503)", 503), true, 503, "transient", "503"],
    [new Error("OAuth unavailable"), true, 503, "transient", "OAuth unavailable"],
    [new Error("OAuth unavailable"), false, 401, null, "OAuth unavailable"],
  ] as const)(
    "responds to %s (subscription=%s)",
    async (error, isSubscription, status, verdict, message) => {
      const app = new Hono();
      app.post(
        "/",
        (c) =>
          respondAuthFailure(c, classifyAuthFailure(error), {
            isSubscription,
            providerDisplayName: "Muse Code",
          }) ?? new Response("unexpected connection branch", { status: 599 })
      );
      const response = await app.request("http://localhost/", { method: "POST" });
      expect(response.status).toBe(status);
      expect(response.headers.get(AUTH_VERDICT_HEADER)).toBe(verdict);
      const body = await response.text();
      expect(body).toContain(message);
      if (status === 400) {
        expect(JSON.parse(body).error.type).toBe("invalid_request_error");
        expect(JSON.parse(body).error.upstream_status).toBe(
          (error as { upstreamStatus?: number }).upstreamStatus
        );
      }
    }
  );

  test.each([terminalCredentialError("login muse", 403), credentialHttpError("retry", 503)])(
    "wrapped credential markers stay unknown and subscription response is transient",
    async (cause) => {
      const failure = classifyAuthFailure(new Error("wrapper", { cause }));
      expect(failure).toEqual({ kind: "unknown", message: "wrapper" });
      const app = new Hono();
      app.post(
        "/",
        (c) =>
          respondAuthFailure(c, failure, {
            isSubscription: true,
            providerDisplayName: "Muse Code",
          }) ?? new Response("unexpected connection branch", { status: 599 })
      );
      const response = await app.request("http://localhost/", { method: "POST" });
      expect(response.status).toBe(503);
      expect(response.headers.get(AUTH_VERDICT_HEADER)).toBe("transient");
      expect(await response.text()).toContain("wrapper");
    }
  );

  test("a connection is left to recovery, rather than serialized as credential rejection", async () => {
    const failure = classifyAuthFailure(await refusedFetch());
    const app = new Hono();
    let result: Response | null | undefined;
    app.get("/", (c) => {
      result = respondAuthFailure(c, failure, {
        isSubscription: true,
        providerDisplayName: "Muse Code",
      });
      return new Response("recovery");
    });
    await app.request("http://localhost/");
    expect(result).toBeNull();
  });
});

describe("F2: credential rejection excludes model misses and allowance exhaustion", () => {
  test.each([401, 403])("invalid key HTTP %i rejects the credential", (status) => {
    // wire-capture §7's synthetic rejection body, preserved verbatim.
    expect(
      isCredentialRejection(
        status,
        JSON.stringify({ error: { type: "invalid_api_key", message: "Unauthorized" } })
      )
    ).toBe(true);
  });
  test.each([
    "Model deepseek-v4-pro-0813 is not supported",
    "Model grok-4.6 is not supported for format oa-compat",
    "You've reached your usage limit for this billing cycle",
  ])("measured request-specific failure: %s", (message) => {
    for (const status of [401, 403]) expect(isCredentialRejection(status, message)).toBe(false);
  });
  test("429 allowance exhaustion is not a dead login", () => {
    expect(
      isCredentialRejection(429, "You've reached your usage limit for this billing cycle")
    ).toBe(false);
  });
  test.skip("BLOCKED F2: no measured region-opt-in wording is supplied", () => {});
});
