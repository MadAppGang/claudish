import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// contract/wire-capture.md §8 shape; sent credentials use ASCII test placeholders.
const ACCESS_TOKEN = "dca:TESTTOKEN0001";
const CAPTURE = {
  api_key: "LLM|TESTKEY0001",
  base_url: "https://api.meta.ai/v1",
  has_payment_method: true,
  require_payment: false,
  is_subs_active: true,
  can_subscribe: false,
  show_subs_upsell: true,
  user_full_name: "TEST USER",
  user_email: "test@example.invalid",
  user_avatar_url: null,
  payment_method: "TEST PAYMENT METHOD",
  action_url: null,
  subs_tier_id: "<tier-id>",
  subs_tier_name: "Muse Code Power Usage",
  is_subs_upgrade_available: true,
  subs_usage: {
    window: { used_percent: 1, window_duration_mins: 300, resets_at: 1792136182 },
    weekly: { used_percent: 0, resets_at: 1792368000 },
    tier: "<tier-id>",
  },
};
const SUBSCRIBE = "https://accountscenter.meta.com/muse_code/?ep=no_payg";

type MintModule = typeof import("./muse-mint.js");
type FailureModule = typeof import("../../handlers/shared/auth-failure.js");
let mint: MintModule;
let failures: FailureModule;
// Mint and interpretation use no directory; every mint call supplies fake fetch.
let priorGuard: string | undefined;

beforeEach(async () => {
  priorGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  mint = await import("./muse-mint.js");
  failures = await import("../../handlers/shared/auth-failure.js");
});

afterEach(async () => {
  if (priorGuard === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = priorGuard;
});

function adapter(reply: () => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetcher = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      requests.push(new Request(args[0], args[1]));
      return reply();
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  return { fetcher, requests };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected mint to reject, but it returned a key");
}

describe("M1 — fixed mint request and returned key", () => {
  test("POSTs the durable access token and capture headers to Meta only", async () => {
    const io = adapter(() => Response.json(CAPTURE));
    const result = await mint.mintMuseApiKey(ACCESS_TOKEN, { fetch: io.fetcher });
    expect(io.requests).toHaveLength(1);
    const request = io.requests[0]!;
    expect(request.url).toBe("https://api.meta.ai/muse-code/key");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request.headers.get("x-api-version")).toBe("1.0.0");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.json()).toEqual({ onboard: false });
    expect(result.apiKey).toBe(CAPTURE.api_key);
    expect(result.apiKey).not.toBe(ACCESS_TOKEN);
    expect(result.subsTierId).toBe(CAPTURE.subs_tier_id);
    expect(result.subsTierName).toBe(CAPTURE.subs_tier_name);
  });
});

describe("M2 — exact entitlement booleans", () => {
  test("accepts the captured true/false confirmation", () => {
    expect(mint.interpretMint({ ...CAPTURE })).toMatchObject({
      apiKey: CAPTURE.api_key,
      subsTierId: CAPTURE.subs_tier_id,
      subsTierName: CAPTURE.subs_tier_name,
    });
  });

  // Explicit mutations of §8, not additional captured responses.
  for (const field of ["is_subs_active", "require_payment"] as const) {
    const wrongBoolean = field !== "is_subs_active";
    for (const value of [wrongBoolean, undefined, null, "true", "false", 0, 1]) {
      test(`rejects ${field}=${String(value)} with the default subscribe URL`, () => {
        const body: Record<string, unknown> = { ...CAPTURE, [field]: value };
        if (value === undefined) delete body[field];
        let error: unknown;
        try {
          mint.interpretMint(body);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(mint.MuseSubscriptionRequiredError);
        expect(failures.classifyAuthFailure(error)).toMatchObject({ kind: "terminal" });
        expect((error as Error).message).toContain(`subscribe at ${SUBSCRIBE}`);
      });
    }
  }

  test("uses the response action URL for an inactive subscription", () => {
    // Action URL is an explicit mutation using the documented subscribe URL.
    const action = "https://accountscenter.meta.com/muse_code/?ep=no_payg&test=1";
    expect(() =>
      mint.interpretMint({ ...CAPTURE, is_subs_active: false, action_url: action })
    ).toThrow(`subscribe at ${action}`);
  });

  test("does not return an empty minted key even with confirmed entitlement", () => {
    expect(() => mint.interpretMint({ ...CAPTURE, api_key: "" })).toThrow(/empty.*key/i);
  });

  test("the network mint boundary also refuses an unconfirmed result", async () => {
    const io = adapter(() => Response.json({ ...CAPTURE, require_payment: null }));
    const error = await rejected(mint.mintMuseApiKey(ACCESS_TOKEN, { fetch: io.fetcher }));
    expect(error).toBeInstanceOf(mint.MuseSubscriptionRequiredError);
    expect(error.message).toContain(SUBSCRIBE);
    expect(io.requests).toHaveLength(1);
  });
});

describe("M3 — mint rejection versus temporary service faults", () => {
  for (const status of [401, 403]) {
    test(`HTTP ${status} is terminal and names login`, async () => {
      // §7's synthetic invalid-key body, status explicitly mutated for 403.
      const io = adapter(() =>
        Response.json(
          {
            error: { type: "invalid_api_key", message: "Unauthorized" },
          },
          { status }
        )
      );
      const error = await rejected(mint.mintMuseApiKey(ACCESS_TOKEN, { fetch: io.fetcher }));
      expect(error).toBeInstanceOf(mint.MuseLoginExpiredError);
      expect(failures.classifyAuthFailure(error)).toMatchObject({ kind: "terminal" });
      expect(error.message).toContain("claudish login muse");
      expect(io.requests).toHaveLength(1);
    });
  }

  for (const status of [429, 500, 502, 503]) {
    test(`HTTP ${status} is retryable with its upstream status`, async () => {
      // Status-only mutation: no invented Meta error payload.
      const io = adapter(() => new Response(null, { status }));
      const error = await rejected(mint.mintMuseApiKey(ACCESS_TOKEN, { fetch: io.fetcher }));
      expect(error).toBeInstanceOf(mint.MuseMintTransientError);
      expect(error).toMatchObject({ transient: true, upstreamStatus: status });
      expect(failures.classifyAuthFailure(error)).toMatchObject({
        kind: "transient",
      });
      expect(error.message).toContain(String(status));
      expect(io.requests).toHaveLength(1);
    });
  }

  for (const kind of ["non-JSON", "broken stream"] as const) {
    test(`a 200 ${kind} response cannot become a dead login`, async () => {
      const io = adapter(() =>
        kind === "non-JSON"
          ? new Response("<html>", { headers: { "content-type": "application/json" } })
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"api_key":'));
                  controller.error(new Error("test body stream interrupted"));
                },
              }),
              { headers: { "content-type": "application/json" } }
            )
      );
      const error = await rejected(mint.mintMuseApiKey(ACCESS_TOKEN, { fetch: io.fetcher }));
      expect(error).not.toBeInstanceOf(mint.MuseLoginExpiredError);
      expect(error).not.toBeInstanceOf(mint.MuseSubscriptionRequiredError);
      expect(error.message.length).toBeGreaterThan(0);
      expect(["transient", "unknown", "connection"]).toContain(
        failures.classifyAuthFailure(error).kind
      );
      expect(io.requests).toHaveLength(1);
    });
  }

  for (const wrap of [false, true]) {
    test(`a real refused loopback fetch remains retryable (wrapped=${wrap})`, async () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("unused"),
      });
      const url = `http://127.0.0.1:${server.port}/mint`;
      await server.stop(true);
      let real: unknown;
      try {
        await fetch(url);
      } catch (error) {
        real = error;
      }
      expect(real).toBeInstanceOf(Error);
      expect(failures.classifyAuthFailure(real).kind).toBe("connection");
      const fault = wrap ? new Error("mint transport failed", { cause: real }) : real;
      const requests: Request[] = [];
      const fetcher = Object.assign(
        async (...args: Parameters<typeof fetch>) => {
          requests.push(new Request(args[0], args[1]));
          throw fault;
        },
        { preconnect: () => {} }
      ) as typeof fetch;
      const error = await rejected(mint.mintMuseApiKey(ACCESS_TOKEN, { fetch: fetcher }));
      expect(failures.classifyAuthFailure(error).kind).toBe("connection");
      expect(requests.map((request) => request.url)).toEqual(["https://api.meta.ai/muse-code/key"]);
    });
  }
});
