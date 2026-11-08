import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialArm } from "../../auth/credentials/types.js";
import type { AuthBinding, ProviderTransport } from "../../providers/transport/types.js";
import type { ComposedHandler } from "../composed-handler.js";
import type { HopAttempt, SigningSecrets } from "./call-context.js";

const FILE = import.meta.path;
const TIMEOUT = 20_000;

if (process.env.T4_ISOLATED_FILE !== FILE) {
  test(
    "T4 G3/G4 runs with an isolated HOME and no inherited credentials",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "t4-signed-billing-"));
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
  let pricing: typeof import("./remote-provider-types.js");
  let TokenTracker: typeof import("./token-tracker.js").TokenTracker;
  let Handler: typeof import("../composed-handler.js").ComposedHandler;
  let OpenAIAPIFormat: typeof import("../../adapters/openai-api-format.js").OpenAIAPIFormat;
  let callContext: typeof import("./call-context.js");
  let Hono: typeof import("hono").Hono;
  let previousProbe: ReturnType<typeof pricing.registerSubscriptionCredentialProbe>;
  const noNetwork = (() => {
    throw new Error("T4 forbids network");
  }) as unknown as typeof fetch;
  const handlers: ComposedHandler[] = [];
  const leases: SigningSecrets[] = [];
  const dataRoot = join(import.meta.dir, "../../test-fixtures");
  const requestBody = JSON.parse(
    readFileSync(join(dataRoot, "code-mode/cc-2.1.304-inbound-system.jsonl"), "utf8")
      .trim()
      .split("\n")[0]!
  ).body;
  const sse = readFileSync(join(dataRoot, "sse-responses/gpt-5.6-sol-responses-turn1.sse"), "utf8");
  const completed = sse
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "response.completed").response;
  const model: string = completed.model;
  const usage: { input_tokens: number; output_tokens: number } = completed.usage;

  beforeAll(async () => {
    globalThis.fetch = noNetwork;
    pricing = await import("./remote-provider-types.js");
    ({ TokenTracker } = await import("./token-tracker.js"));
    ({ ComposedHandler: Handler } = await import("../composed-handler.js"));
    ({ OpenAIAPIFormat } = await import("../../adapters/openai-api-format.js"));
    callContext = await import("./call-context.js");
    ({ Hono } = await import("hono"));
    const logger = await import("../../logger.js");
    logger.initLogger(false, "minimal", true);
    logger.setStderrQuiet(true);
    previousProbe = pricing.registerSubscriptionCredentialProbe(null);
  });

  afterEach(async () => {
    for (const handler of handlers.splice(0)) await handler.shutdown();
    for (const secrets of leases.splice(0)) secrets.lease.release();
    pricing.registerSubscriptionCredentialProbe(previousProbe);
    globalThis.fetch = noNetwork;
    delete process.env.CLAUDISH_TOKEN_FILE;
  });

  function cost(input: number, output: number): number {
    const rates = pricing.getModelPricing("openai-codex", model, { subscription: false });
    return (input * rates.inputCostPer1M + output * rates.outputCostPer1M) / 1_000_000;
  }

  function tracker() {
    return new TokenTracker(0, {
      providerName: "openai-codex",
      modelName: model,
      contextWindow: 0,
      writesTokenFile: false,
    });
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function handlerWithArms(
    arms: Array<CredentialArm | undefined>,
    onSign: (arm: CredentialArm | undefined) => void
  ) {
    let index = 0;
    const provider: ProviderTransport = {
      name: "openai-codex",
      displayName: "T4 Codex",
      streamFormat: "openai-responses-sse",
      overrideStreamFormat: () => "openai-responses-sse",
      getEndpoint: () => "https://t4.invalid/v1/responses",
      async getHeaders(_request, binding) {
        return { "content-type": "application/json", "x-t4-arm": binding?.auth?.arm ?? "absent" };
      },
      async refreshAuth(): Promise<AuthBinding> {
        const arm = arms[index++];
        onSign(arm);
        return { auth: { headers: {}, ...(arm ? { arm } : {}) } };
      },
    };
    const handler = new Handler(provider, model, model, 0, {
      adapter: new OpenAIAPIFormat(model),
      tokenStrategy: "standard",
      requestRole: "advisor",
      codeMode: "off",
      catalogCachePath: join(process.env.HOME!, "no-catalog.json"),
    });
    handlers.push(handler);
    return handler;
  }

  function startCall(handler: ComposedHandler) {
    const hops: HopAttempt[] = [];
    const secrets = callContext.createSigningSecrets();
    leases.push(secrets);
    const app = new Hono();
    app.post("/", (c) => {
      c.set(callContext.HOP_LOG_KEY, hops);
      c.set(callContext.SIGNING_SECRETS_KEY, secrets);
      // Replay the real inbound body through the public handler. No request protocol is invented.
      return handler.handle(c, structuredClone(requestBody));
    });
    return { hops, response: app.request("/", { method: "POST" }) };
  }

  describe("G3 billing follows each request's signing arm", () => {
    test(
      "request pricing overrides the opposite process-wide credential probe",
      () => {
        pricing.registerSubscriptionCredentialProbe(() => true);
        expect(pricing.getModelPricing("openai-codex", model).isSubscription).toBe(true);
        const metered = pricing.getModelPricing("openai-codex", model, { subscription: false });
        expect(metered.inputCostPer1M + metered.outputCostPer1M).toBeGreaterThan(0);
        expect(metered.isSubscription).not.toBe(true);
        pricing.registerSubscriptionCredentialProbe(() => false);
        expect(
          pricing.getModelPricing("openai-codex", model, { subscription: true })
        ).toMatchObject({ inputCostPer1M: 0, outputCostPer1M: 0, isSubscription: true });
      },
      TIMEOUT
    );

    for (const strategy of ["update", "accumulateBoth", "updateWithDelta"] as const) {
      test(
        `${strategy}: metered token costs and retry-leg extra input survive an oauth probe`,
        () => {
          pricing.registerSubscriptionCredentialProbe(() => true);
          const t = tracker();
          t[strategy](usage.input_tokens, usage.output_tokens, undefined, { subscription: false });
          expect(t.getTotalCost()).toBeCloseTo(cost(usage.input_tokens, usage.output_tokens), 12);
          t.addBilledInputTokens(usage.input_tokens, undefined, { subscription: false });
          expect(t.getTotalCost()).toBeCloseTo(
            cost(usage.input_tokens * 2, usage.output_tokens),
            12
          );
        },
        TIMEOUT
      );

      test(
        `${strategy}: oauth token costs and retry-leg extra input stay zero under a metered probe`,
        () => {
          pricing.registerSubscriptionCredentialProbe(() => false);
          const t = tracker();
          t[strategy](usage.input_tokens, usage.output_tokens, undefined, { subscription: true });
          t.addBilledInputTokens(usage.input_tokens, undefined, { subscription: true });
          expect(t.getTotalCost()).toBe(0);
        },
        TIMEOUT
      );
    }

    for (const arm of ["oauth", "api-key", undefined] as const) {
      test(
        `ComposedHandler arm ${arm ?? "absent"} labels and prices the captured stream independently of the probe`,
        async () => {
          const oauth = arm === "oauth";
          pricing.registerSubscriptionCredentialProbe(() => !oauth);
          const handler = handlerWithArms([arm], () => {});
          const signed: string[] = [];
          globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            signed.push(new Headers(init?.headers).get("x-t4-arm")!);
            return new Response(sse, { headers: { "content-type": "text/event-stream" } });
          }) as unknown as typeof fetch;
          const call = startCall(handler);
          const response = await call.response;
          expect(response.status).toBe(200);
          await response.text();
          expect(signed).toEqual([arm ?? "absent"]);
          expect(call.hops).toHaveLength(1);
          expect(call.hops[0]).toMatchObject({
            arm: arm ?? null,
            billing: oauth ? "subscription" : "metered",
          });
          expect(handler.getTokenTracker().getTotalCost()).toBeCloseTo(
            oauth ? 0 : cost(usage.input_tokens, usage.output_tokens),
            12
          );
        },
        TIMEOUT
      );
    }

    for (const arms of [
      [undefined, "oauth"],
      ["oauth", undefined],
    ] as const) {
      test(
        `overlapping ${arms[0] ?? "absent"} then ${arms[1] ?? "absent"} requests cannot exchange rates`,
        async () => {
          let currentArm: CredentialArm | undefined;
          pricing.registerSubscriptionCredentialProbe(() => currentArm === "oauth");
          const handler = handlerWithArms([...arms], (arm) => {
            currentArm = arm;
          });
          const issued = [deferred<void>(), deferred<void>()];
          const replies = [deferred<Response>(), deferred<Response>()];
          let fetchIndex = 0;
          globalThis.fetch = (async () => {
            const index = fetchIndex++;
            issued[index]!.resolve();
            return replies[index]!.promise;
          }) as unknown as typeof fetch;
          const first = startCall(handler);
          await issued[0]!.promise;
          const second = startCall(handler);
          await issued[1]!.promise;
          expect(currentArm).toBe(arms[1]);
          // The second request signs before the first receives usage, then completes first.
          replies[1]!.resolve(
            new Response(sse, { headers: { "content-type": "text/event-stream" } })
          );
          await (await second.response).text();
          expect(handler.getTokenTracker().getTotalCost()).toBeCloseTo(
            arms[1] === "oauth" ? 0 : cost(usage.input_tokens, usage.output_tokens),
            12
          );
          replies[0]!.resolve(
            new Response(sse, { headers: { "content-type": "text/event-stream" } })
          );
          await (await first.response).text();
          expect(first.hops[0]).toMatchObject({
            arm: arms[0] ?? null,
            billing: arms[0] === "oauth" ? "subscription" : "metered",
          });
          expect(second.hops[0]).toMatchObject({
            arm: arms[1] ?? null,
            billing: arms[1] === "oauth" ? "subscription" : "metered",
          });
          expect(handler.getTokenTracker().getTotalCost()).toBeCloseTo(
            cost(usage.input_tokens, usage.output_tokens),
            12
          );
          expect(fetchIndex).toBe(2);
        },
        TIMEOUT
      );
    }
  });

  describe("G4 advisor token-file isolation", () => {
    test(
      "all tracker update and rewrite entry points preserve the main token file",
      () => {
        const path = join(process.env.HOME!, "main-token.json");
        const sentinel = JSON.stringify({
          model: "main-session",
          input_tokens: 71,
          output_tokens: 9,
        });
        writeFileSync(path, sentinel);
        process.env.CLAUDISH_TOKEN_FILE = path;
        const t = tracker();
        t.update(usage.input_tokens, usage.output_tokens, undefined, { subscription: false });
        t.accumulateBoth(usage.input_tokens, usage.output_tokens, undefined, {
          subscription: false,
        });
        t.updateWithDelta(usage.input_tokens, usage.output_tokens, undefined, {
          subscription: false,
        });
        t.addBilledInputTokens(usage.input_tokens, undefined, { subscription: false });
        t.setPlanUsage(undefined);
        t.rewrite();
        expect(t.getTotalCost()).toBeGreaterThan(0);
        expect(readFileSync(path, "utf8")).toBe(sentinel);
      },
      TIMEOUT
    );

    test(
      "an advisor ComposedHandler tags emitted stats without overwriting main status-line counts",
      async () => {
        const path = join(process.env.HOME!, "main-token.json");
        const sentinel = JSON.stringify({
          model: "main-session",
          input_tokens: 71,
          output_tokens: 9,
        });
        writeFileSync(path, sentinel);
        process.env.CLAUDISH_TOKEN_FILE = path;
        const handler = handlerWithArms(["api-key"], () => {});
        globalThis.fetch = (async () =>
          new Response(sse, {
            headers: { "content-type": "text/event-stream" },
          })) as unknown as typeof fetch;
        // Instrument only this HOME-isolated process; never mock.module shared infrastructure.
        const stats = await import("../../stats.js");
        const emitted = spyOn(stats, "recordStats").mockImplementation(() => {});
        try {
          await (await startCall(handler).response).text();
          expect(emitted).toHaveBeenCalled();
          for (const [event] of emitted.mock.calls) expect(event.request_role).toBe("advisor");
          expect(handler.getTokenTracker().getTotalCost()).toBeGreaterThan(0);
          expect(readFileSync(path, "utf8")).toBe(sentinel);
        } finally {
          emitted.mockRestore();
        }
      },
      TIMEOUT
    );
  });
}
