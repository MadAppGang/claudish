import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { FallbackCandidate } from "./fallback-handler.js";

// Bun caches homedir at process startup: changing HOME inside a test is not isolation.
// Import production modules only in a child whose HOME was isolated before startup.
if (process.env.CLAUDISH_T5_CREDENTIAL_WORKER !== "1") {
  test("T5 G1-G4 run with an isolated HOME and no network", () => {
    const home = mkdtempSync(join(tmpdir(), "claudish-t5-credential-"));
    try {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        env: {
          ...process.env,
          HOME: home,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_T5_CREDENTIAL_WORKER: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 18_000,
      });
      console.log(child.stdout.toString() + child.stderr.toString());
      expect(child.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    () => {
      throw new Error("T5 forbids all network requests");
    },
    { preconnect: () => {} }
  ) as unknown as typeof fetch;

  // Install only the billing probe; no credential is read or hydrated in these tests.
  await import("../auth/credentials/authority.js");
  const { clearSignedArm, recordSignedArm } = await import("../auth/credentials/billing-probe.js");
  const {
    FallbackHandler,
    _resetCredentialRejectionNotices,
    announceCredentialRejection,
    isRetryableError,
  } = await import("./fallback-handler.js");
  const { authVerdictHeaders } = await import("./shared/auth-failure.js");
  const { connectionFaultHeaders, recoveryHoldHeaders, streamFailureHeaders } = await import(
    "./shared/recovery-marker.js"
  );
  const { acquireSigningLease } = await import("../redact.js");
  const logger = await import("../logger.js");

  const capturedError = readFileSync(
    new URL("../test-fixtures/advisor/d7-provider-error.sse", import.meta.url),
    "utf8"
  );
  const capturedAnswer = readFileSync(
    new URL("../test-fixtures/advisor/d7-metered-answer.sse", import.meta.url),
    "utf8"
  );
  const errorFrame = JSON.parse(
    capturedError
      .split("\n")
      .find((line) => line.startsWith('data: {"error":'))!
      .slice(6)
  );
  // Derived internal error input, not a new provider capture: the envelope is the
  // captured Z.ai error above; the observed credential message is verbatim from
  // model-failures-2026-10-21.md D7 (Zen Go: "This API key has expired").
  // Status, verdict and upstream_status are structural routing inputs. Only the
  // redaction case adds the explicitly required, obviously fake signing value.
  const expiredMessage = "This API key has expired";
  function rejectionBody(status = 401, message = expiredMessage): string {
    return JSON.stringify({
      ...errorFrame,
      error: { ...errorFrame.error, message, upstream_status: status },
    });
  }
  function rejection(
    status = 400,
    headers: Record<string, string> = authVerdictHeaders("terminal")
  ) {
    return new Response(rejectionBody(status === 400 ? 401 : status), { status, headers });
  }
  function answer() {
    return new Response(capturedAnswer, { headers: { "content-type": "text/event-stream" } });
  }

  const originalStderrWrite = process.stderr.write;
  let stderrChunks: string[] = [];
  jest.useFakeTimers();
  logger.initLogger(true, "debug");
  logger.setStderrQuiet(false);
  beforeEach(() => {
    stderrChunks = [];
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    _resetCredentialRejectionNotices();
    clearSignedArm();
  });
  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    _resetCredentialRejectionNotices();
    clearSignedArm();
  });
  afterAll(() => {
    process.stderr.write = originalStderrWrite;
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  async function runChain(hops: { name: string; provider: string; response: Response }[]) {
    const calls = hops.map(() => 0);
    const candidates: FallbackCandidate[] = hops.map((hop, i) => ({
      name: hop.name,
      provider: hop.provider,
      handler: {
        async handle() {
          calls[i]++;
          return hop.response;
        },
        async shutdown() {},
      },
    }));
    const chain = new FallbackHandler(candidates);
    let returned: Response | undefined;
    const app = new Hono();
    app.get("/", async (c) => {
      // Only routing metadata is needed; no provider request body is synthesized.
      returned = await chain.handle(c, { model: "deepseek-v4-pro" });
      return returned;
    });
    try {
      const response = await app.request("http://in-process.invalid/");
      return { returned, response, body: await response.text(), calls };
    } finally {
      await chain.shutdown();
    }
  }
  function metered(response = answer()) {
    return { name: "OpenRouter", provider: "openrouter", response };
  }

  describe("T5 G1 subscription credential rejection advances", () => {
    for (const provider of [
      "kimi-coding",
      "grok-subscription",
      "opencode-zen-go",
      "qwen-token-plan",
      "devin",
      "antigravity",
      "openai-codex",
    ]) {
      for (const status of [400, 401, 403]) {
        test(`${provider} ${status === 400 ? "terminal verdict" : `headerless ${status}`} returns the next metered answer`, async () => {
          if (provider === "openai-codex") recordSignedArm(provider, "subscription");
          const failed = rejection(status, status === 400 ? authVerdictHeaders("terminal") : {});
          expect(
            isRetryableError(
              failed.status,
              await failed.clone().text(),
              provider,
              failed.headers,
              provider
            )
          ).toBe(true);
          const served = answer();
          const result = await runChain([
            { name: provider, provider, response: failed },
            metered(served),
            { name: "Kimi Coding", provider: "kimi-coding", response: answer() },
          ]);
          expect(result.calls).toEqual([1, 1, 0]);
          expect(result.returned).toBe(served);
          expect(result.response.status).toBe(200);
          expect(result.body).toBe(capturedAnswer);
        }, 5_000);
      }
    }
  });

  describe("T5 G2 stop verdicts take precedence over credential rejection", () => {
    for (const [label, marker, status] of [
      ["network fault (terminal remap)", connectionFaultHeaders(), 400],
      ["network fault (503)", connectionFaultHeaders(), 503],
      ["recovery hold", recoveryHoldHeaders(), 503],
      ["stream failure", streamFailureHeaders(), 400],
    ] as const) {
      test(`${label} never invokes a metered hop`, async () => {
        // Connection producers emit a connection verdict, not an auth verdict.
        const failed = rejection(status, marker);
        expect(
          isRetryableError(
            status,
            await failed.clone().text(),
            "kimi-coding",
            failed.headers,
            "kimi-coding"
          )
        ).toBe(false);
        // Classification must also prefer the safety marker to a credential verdict.
        expect(
          isRetryableError(
            status,
            await failed.clone().text(),
            "kimi-coding",
            new Headers({ ...authVerdictHeaders("terminal"), ...marker }),
            "kimi-coding"
          )
        ).toBe(false);
        const body = await failed.clone().text();
        const result = await runChain([
          { name: "Kimi Coding", provider: "kimi-coding", response: failed },
          metered(),
        ]);
        expect(result.calls).toEqual([1, 0]);
        expect(result.returned).toBe(failed);
        expect(result.response.status).toBe(status);
        expect(result.body).toBe(body);
      }, 5_000);
    }

    test("a transient subscription verdict stops instead of advancing", async () => {
      const failed = rejection(503, authVerdictHeaders("transient"));
      expect(
        isRetryableError(
          503,
          await failed.clone().text(),
          "kimi-coding",
          failed.headers,
          "kimi-coding"
        )
      ).toBe(false);
      const result = await runChain([
        { name: "Kimi Coding", provider: "kimi-coding", response: failed },
        metered(),
      ]);
      expect(result.calls).toEqual([1, 0]);
      expect(result.returned).toBe(failed);
      expect(result.response.headers.get("x-claudish-auth-verdict")).toBe("transient");
    }, 5_000);

    for (const provider of ["openrouter", "openai-codex"]) {
      test(`${provider} metered terminal credential rejection still stops`, async () => {
        if (provider === "openai-codex") recordSignedArm(provider, "metered");
        const failed = rejection();
        expect(
          isRetryableError(400, await failed.clone().text(), provider, failed.headers, provider)
        ).toBe(false);
        const result = await runChain([
          { name: provider, provider, response: failed },
          { name: "Kimi Coding", provider: "kimi-coding", response: answer() },
          metered(),
        ]);
        expect(result.calls).toEqual([1, 0, 0]);
        expect(result.returned).toBe(failed);
      }, 5_000);
    }
  });

  describe("T5 G3 credential rejection notices", () => {
    test("stderr is once per provider/status across requests, every occurrence is logged, and signing values are redacted", async () => {
      const path = logger.getLogFilePath();
      expect(path).not.toBeNull();
      const readLogUntil = async (ready: (contents: string) => boolean) => {
        let contents = readFileSync(path!, "utf8");
        // Bun also fakes captured clocks and promise timers. Count real 10ms sleeps
        // for a 2s bound, yielding through reads so asynchronous appends can finish.
        for (let attempts = 0; !ready(contents) && attempts < 200; attempts++) {
          Bun.sleepSync(10);
          contents = await readFile(path!, "utf8");
        }
        return contents;
      };
      // Fake timers trigger the flush, but appendFile still finishes asynchronously.
      // Include a marker so earlier tests' pending writes precede the baseline.
      const baseline = "T5 G3 log baseline";
      logger.log(baseline);
      jest.advanceTimersByTime(2_000);
      const initialLog = await readLogUntil((contents) => contents.includes(baseline));
      expect(initialLog).toContain(baseline);
      const before = initialLog.length;
      const lease = acquireSigningLease();
      lease.add(["OPAQUE_TEST_TOKEN_abc"]);
      try {
        for (const [provider, name, upstream] of [
          ["kimi-coding", "Kimi Coding", 401],
          ["kimi-coding", "Kimi Coding", 401],
          ["kimi-coding", "Kimi Coding", 401],
          ["kimi-coding", "Kimi Coding", 403],
          ["grok-subscription", "Grok Build (subscription)", 401],
        ] as const) {
          const response = new Response(
            rejectionBody(upstream, `${expiredMessage}: OPAQUE_TEST_TOKEN_abc`),
            {
              status: 400,
              headers: authVerdictHeaders("terminal"),
            }
          );
          const result = await runChain([{ name, provider, response }, metered()]);
          expect(result.calls).toEqual([1, 1]);
        }
        const notices = stderrChunks
          .join("")
          .split("\n")
          .filter((line) => line.includes("rejected its credential"));
        expect(notices).toHaveLength(3);
        expect(
          notices.filter((line) => line.includes("Kimi Coding") && line.includes("(401:"))
        ).toHaveLength(1);
        expect(
          notices.filter((line) => line.includes("Kimi Coding") && line.includes("(403:"))
        ).toHaveLength(1);
        expect(
          notices.filter((line) => line.includes("Grok Build") && line.includes("(401:"))
        ).toHaveLength(1);
        expect(notices[0]).toContain(expiredMessage);
        expect(notices[0]).toContain("moving to OpenRouter (metered, billed per token)");
        expect(notices[0]).toContain("claudish login kimi");
        expect(notices.join("\n")).toContain("[redacted]");
        expect(notices.join("\n")).not.toContain("OPAQUE_TEST_TOKEN_abc");
        jest.advanceTimersByTime(2_000);
        const logged = (
          await readLogUntil(
            (contents) =>
              contents
                .slice(before)
                .split("\n")
                .filter((line) => line.includes("rejected its credential")).length >= 5
          )
        ).slice(before);
        expect(
          logged.split("\n").filter((line) => line.includes("rejected its credential"))
        ).toHaveLength(5);
        expect(logged).toContain("[redacted]");
        expect(logged).not.toContain("OPAQUE_TEST_TOKEN_abc");
      } finally {
        lease.release();
      }
    }, 5_000);

    test("a subscription next hop is named and billed as subscription", () => {
      announceCredentialRejection(
        { name: "Zen Go", provider: "opencode-zen-go" },
        400,
        rejectionBody(),
        { name: "Kimi Coding", provider: "kimi-coding" }
      );
      const text = stderrChunks.join("");
      expect(text).toContain("Zen Go rejected its credential (401:");
      expect(text).toContain("moving to Kimi Coding (subscription)");
      expect(text).not.toContain("metered, billed per token");
    }, 5_000);
  });

  describe("T5 G4 an exhausted chain preserves the actionable rejection", () => {
    test("combined error.message and stderr keep the first rejection after later failures", async () => {
      const result = await runChain([
        { name: "Zen Go", provider: "opencode-zen-go", response: rejection() },
        metered(new Response(JSON.stringify(errorFrame), { status: 404 })),
      ]);
      expect(result.calls).toEqual([1, 1]);
      expect(result.response.status).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error.type).toBe("all_providers_failed");
      expect(body.error.message).toContain(expiredMessage);
      // The earlier advancing notice is not evidence that the exhausted summary kept it.
      const summary = stderrChunks.filter((line) => !line.includes("moving to"));
      expect(summary.join("")).toContain(expiredMessage);
    }, 5_000);

    test("a rejection as the only failure returns its response unchanged", async () => {
      const failed = rejection();
      failed.headers.set("x-t5-original-response", "retained");
      const body = await failed.clone().text();
      const result = await runChain([
        { name: "Zen Go", provider: "opencode-zen-go", response: failed },
      ]);
      expect(result.calls).toEqual([1]);
      expect(result.returned).toBe(failed);
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("x-claudish-auth-verdict")).toBe("terminal");
      expect(result.response.headers.get("x-t5-original-response")).toBe("retained");
      expect(result.body).toBe(body);
      expect(result.body).not.toContain("all_providers_failed");
    }, 5_000);
  });
}
