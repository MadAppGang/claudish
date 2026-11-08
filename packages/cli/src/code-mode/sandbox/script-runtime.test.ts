import { afterEach, describe, expect, test } from "bun:test";
import { ToolNameTable } from "../tool-names";
import {
  currentQuickJSModule,
  loadQuickJSModule,
  resetQuickJSLoaderForTests,
} from "./quickjs-loader";
import {
  DEFAULT_SANDBOX_LIMITS,
  type SandboxLimits,
  type ScriptRuntime,
  type ScriptStep,
  createScriptRuntime,
} from "./script-runtime";

const MiB = 1024 * 1024;
const runtimes: ScriptRuntime[] = [];

async function runtime(limits: Partial<SandboxLimits> = {}, seed = "T3-seed") {
  const module = await loadQuickJSModule();
  if (!module) throw new Error("REQ-12: the real isolated QuickJS module must load");
  const result = createScriptRuntime({
    tools: new ToolNameTable(["X", "Y", "Z"]),
    limits,
    seed,
    module,
  });
  runtimes.push(result);
  return result;
}

function completed(step: ScriptStep) {
  expect(step.kind).toBe("done");
  if (step.kind !== "done") throw new Error("Expected a terminal script step");
  expect(step.output.status).toBe("completed");
  return step.output;
}

function outputText(step: ScriptStep): string {
  return completed(step)
    .parts.map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("");
}

function blocked(step: ScriptStep) {
  expect(step.kind).toBe("blocked");
  if (step.kind !== "blocked") throw new Error("Expected pending tool calls");
  return step.calls;
}

function failure(step: ScriptStep) {
  expect(step.kind).toBe("done");
  if (step.kind !== "done") throw new Error("Expected a failed script, not a tool batch");
  expect(step.output.status).toBe("failed");
  return step.output.error ?? "";
}

afterEach(() => {
  for (const item of runtimes.splice(0)) item.dispose();
  resetQuickJSLoaderForTests();
});

describe("T3 runtime relay", () => {
  test("REQ-1 returns three ordered concurrent calls and completes with their results", async () => {
    const script = await runtime();
    const calls = blocked(
      script.start(`
      const results = await Promise.all([
        tools.X({position: 0}), tools.Y({position: 1}), tools.Z({position: 2})
      ]);
      text(results.join("|"));
    `)
    );

    expect(calls).toEqual([
      { seq: 0, ident: "X", name: "X", input: { position: 0 } },
      { seq: 1, ident: "Y", name: "Y", input: { position: 1 } },
      { seq: 2, ident: "Z", name: "Z", input: { position: 2 } },
    ]);
    expect(
      outputText(
        script.resume([
          { seq: 2, ok: true, text: "third" },
          { seq: 0, ok: true, text: "first" },
          { seq: 1, ok: true, text: "second" },
        ])
      )
    ).toBe("first|second|third");
    expect(script.alive).toBe(false);
  }, 20_000);

  test("REQ-2 emits only one call at each sequential await", async () => {
    const script = await runtime();
    expect(
      blocked(
        script.start(`
      const first = await tools.X({});
      const second = await tools.Y({first});
      text(first + ":" + second);
    `)
      )
    ).toEqual([{ seq: 0, ident: "X", name: "X", input: {} }]);

    expect(blocked(script.resume([{ seq: 0, ok: true, text: "A" }]))).toEqual([
      { seq: 1, ident: "Y", name: "Y", input: { first: "A" } },
    ]);
    expect(outputText(script.resume([{ seq: 1, ok: true, text: "B" }]))).toBe("A:B");
  }, 20_000);

  test("REQ-3 exposes is_error as a plain-string allSettled rejection", async () => {
    const script = await runtime();
    blocked(
      script.start(`
      const result = (await Promise.allSettled([tools.X({})]))[0];
      text(JSON.stringify({status: result.status, reason: result.reason, type: typeof result.reason}));
    `)
    );

    expect(
      JSON.parse(outputText(script.resume([{ seq: 0, ok: false, text: "denied by user" }])))
    ).toEqual({
      status: "rejected",
      reason: "denied by user",
      type: "string",
    });
  }, 20_000);

  test("REQ-3 rejects missing results with the contract's plain string", async () => {
    const script = await runtime();
    blocked(script.start("text(JSON.stringify(await Promise.allSettled([tools.X({})])));"));

    expect(JSON.parse(outputText(script.resume([])))).toEqual([
      { status: "rejected", reason: "no tool_result returned" },
    ]);
  }, 20_000);

  test.each(["null", "42", '"value"', "true", "undefined", "[]"])(
    "REQ-4 rejects non-object argument %s without relaying it",
    async (argument) => {
      const script = await runtime();
      const result = script.start(`
        const results = await Promise.allSettled([tools.X(${argument})]);
        text(JSON.stringify(results));
      `);

      expect(JSON.parse(outputText(result))).toEqual([
        {
          status: "rejected",
          reason: "claudish: tools.X takes an object as its argument; this call was not run",
        },
      ]);
    },
    20_000
  );

  test.each([
    "new Promise(() => {})",
    "Promise.resolve({value: 1})",
    'Promise.reject("already rejected")',
  ])(
    "REQ-4 M8 rejects promise argument %s instead of serializing it",
    async (argument) => {
      const script = await runtime();
      const result = JSON.parse(
        outputText(
          script.start(`
      const results = await Promise.allSettled([tools.X(${argument})]);
      text(JSON.stringify(results));
    `)
        )
      );

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("rejected");
      expect(typeof result[0].reason).toBe("string");
      expect(result[0].reason).toContain("was given a promise; await it");
    },
    20_000
  );

  test("REQ-5 rejects the 33rd concurrent call while the other 32 finish", async () => {
    const script = await runtime();
    const calls = blocked(
      script.start(`
      const results = await Promise.allSettled(Array.from({length: 33}, (_, i) => tools.X({i})));
      text(JSON.stringify(results));
    `)
    );
    expect(calls).toHaveLength(32);
    expect(calls.map((call) => call.seq)).toEqual(Array.from({ length: 32 }, (_, i) => i));

    const results = JSON.parse(
      outputText(
        script.resume(
          calls.map((call) => ({ seq: call.seq, ok: true, text: `result-${call.seq}` }))
        )
      )
    );
    expect(results.slice(0, 32)).toEqual(
      Array.from({ length: 32 }, (_, i) => ({
        status: "fulfilled",
        value: `result-${i}`,
      }))
    );
    expect(results[32]).toEqual({
      status: "rejected",
      reason: "claudish: more than 32 tool calls in one batch; this call was not run",
    });
  }, 20_000);

  test("REQ-5 rejects call 257 after 256 sequential calls without wedging", async () => {
    const script = await runtime();
    let step = script.start(`
      for (let i = 0; i < 256; i++) await tools.X({i});
      try { await tools.X({i: 256}); } catch (reason) { text(reason); }
    `);
    for (let seq = 0; seq < 256; seq++) {
      expect(blocked(step)).toEqual([{ seq, ident: "X", name: "X", input: { i: seq } }]);
      step = script.resume([{ seq, ok: true, text: "ok" }]);
    }

    expect(outputText(step)).toBe(
      "claudish: more than 256 tool calls in one script; this call was not run"
    );
  }, 20_000);

  test.each(['tools.X({}); text("finished");', 'tools.X({}); text("finished"); exit();'])(
    "REQ-6 discards unawaited calls when the script settles: %s",
    async (source) => {
      const script = await runtime();
      expect(outputText(script.start(source))).toBe("finished");
      expect(script.alive).toBe(false);
    },
    20_000
  );

  test("REQ-7 fails an await with no tool calls using the exact deadlock text", async () => {
    const script = await runtime();
    expect(failure(script.start("await new Promise(() => {});"))).toBe(
      "deadlocked: the script awaits a promise that can never settle (no tool calls are pending)"
    );
    expect(script.alive).toBe(false);
  }, 20_000);
});

describe("T3 runtime resource limits", () => {
  test("REQ-8 interrupts a CPU loop at the default budget", async () => {
    const script = await runtime();
    expect(failure(script.start("while (true) {}"))).toContain(
      "interrupted: exceeded the 2 s CPU budget"
    );
    expect(script.alive).toBe(false);
  }, 20_000);

  test("REQ-8 charges CPU cumulatively across successful tool suspensions", async () => {
    const script = await runtime({ cpuMs: 200, callsPerScript: 1024 });
    let step = script.start(`
      for (let i=0; i<1000; i++) {
        let total = 0;
        for (let j=0; j<100000; j++) total += j;
        await tools.X({i, total});
      }
    `);
    expect(step.kind).toBe("blocked");
    let resumed = 0;
    while (step.kind === "blocked" && resumed < 1000) {
      expect(step.calls).toHaveLength(1);
      step = script.resume([{ seq: step.calls[0].seq, ok: true, text: "ok" }]);
      resumed++;
    }

    expect(resumed).toBeGreaterThan(0);
    expect(failure(step)).toMatch(/interrupted: exceeded .* CPU budget/);
    expect(script.alive).toBe(false);
  }, 20_000);

  test.each([
    ["toJSON", "throw {toJSON(){while(true){}}};"],
    ["message getter", "throw {get message(){while(true){}}};"],
    ["enumerable getter", "throw {get value(){while(true){}}};"],
    ["Proxy ownKeys", "throw new Proxy({}, {ownKeys(){while(true){}}});"],
    ["post-await toJSON", "await Promise.resolve(); throw {toJSON(){while(true){}}};"],
  ])(
    "REQ-8 K1 bounds hostile settlement through %s",
    async (_name, source) => {
      const script = await runtime({ cpuMs: 75 });
      expect(failure(script.start(source))).toMatch(/interrupted: exceeded .* CPU budget/);
      expect(script.alive).toBe(false);
    },
    20_000
  );

  test("REQ-9 fails memory runaway without poisoning an innocent subsequent script", async () => {
    const script = await runtime({ memoryBytes: 8 * MiB });
    const error = failure(
      script.start(`
      const held = [];
      while (true) held.push({i: held.length, value: "x".repeat(1024)});
    `)
    );
    expect(error).toContain("out of memory");
    expect(script.alive).toBe(false);

    const innocent = await runtime();
    expect(outputText(innocent.start('text("still usable");'))).toBe("still usable");
  }, 20_000);

  test("REQ-10 fails source beyond the injected source ceiling before running tools", async () => {
    const script = await runtime({ sourceBytes: 32 });
    expect(failure(script.start("await tools.X({}); // " + "x".repeat(64))).length).toBeGreaterThan(
      0
    );
    expect(script.alive).toBe(false);
  }, 20_000);

  test("REQ-10 rejects an oversized call input with a string instead of relaying it", async () => {
    const script = await runtime({ callInputBytes: 32 });
    expect(
      outputText(
        script.start(`
      try { await tools.X({value: "x".repeat(64)}); }
      catch (error) { text(typeof error); }
    `)
      )
    ).toBe("string");
  }, 20_000);

  test("REQ-10 rejects just the call beyond a batch's input byte cap", async () => {
    const script = await runtime({ callInputBytes: 256, batchInputBytes: 64 });
    const calls = blocked(
      script.start(`
      const results = await Promise.allSettled([
        tools.X({value: "x".repeat(40)}), tools.Y({value: "x".repeat(40)})
      ]);
      text(JSON.stringify(results.map(r => r.status)));
    `)
    );
    expect(calls).toHaveLength(1);
    expect(outputText(script.resume([{ seq: calls[0]!.seq, ok: true, text: "ok" }]))).toBe(
      '["fulfilled","rejected"]'
    );
  }, 20_000);

  test("REQ-10 truncates a too-large result and keeps a truncation marker", async () => {
    const script = await runtime({ resultBytes: 64 });
    blocked(script.start("text(await tools.X({}));"));
    const text = outputText(script.resume([{ seq: 0, ok: true, text: "a".repeat(256) }]));
    expect(text.startsWith("a")).toBe(true);
    expect(text).toMatch(/truncat/i);
    expect(text.length).toBeLessThan(256);
  }, 20_000);

  test("REQ-10 rejects delivery beyond the cumulative result budget", async () => {
    const script = await runtime({ resultBytes: 64, resultBytesPerScript: 96 });
    const calls = blocked(
      script.start(`
      const results = await Promise.allSettled([tools.X({}), tools.Y({})]);
      text(JSON.stringify(results.map(r => r.status)));
    `)
    );
    expect(
      outputText(
        script.resume(
          calls.map((call) => ({
            seq: call.seq,
            ok: true,
            text: "a".repeat(64),
          }))
        )
      )
    ).toBe('["fulfilled","rejected"]');
  }, 20_000);

  test("REQ-11 H3 repeated empty text adds no output parts", async () => {
    const script = await runtime();
    expect(completed(script.start('for(let i=0;i<4000;i++) text("");')).parts).toEqual([]);
  }, 20_000);

  test("REQ-11 H3 text beyond the 1024-part cap joins the last part without loss", async () => {
    const script = await runtime();
    const output = completed(script.start('for(let i=0;i<2000;i++) text("x");'));
    expect(output.parts).toHaveLength(1024);
    expect(output.parts.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
      "x".repeat(2000)
    );
  }, 20_000);

  test.each([
    ["repeated small text", 'for(let i=0;i<1025;i++) text("x".repeat(1024));'],
    [
      "tampered slice and apply",
      `
      String.prototype.slice = function(){ return String(this); };
      Reflect.apply = function(){ return "y".repeat(2 * 1024 * 1024); };
      text("x".repeat(2 * 1024 * 1024));
    `,
    ],
  ])(
    "REQ-11 enforces the host output ceiling with %s",
    async (_name, source) => {
      const script = await runtime();
      const text = outputText(script.start(source));
      expect(text.slice(0, MiB)).toBe("x".repeat(MiB));
      const warning = text.slice(MiB);
      expect(warning).toMatch(/Warning:.*output.*limit/i);
      expect(warning.length).toBeLessThan(300);
    },
    20_000
  );

  test("REQ-11 counts text in UTF-16 code units rather than UTF-8 bytes", async () => {
    const script = await runtime({ outputBytes: 8 });
    expect(outputText(script.start('text("éééééééé");'))).toBe("é".repeat(8));
  }, 20_000);
});

describe("T3 runtime isolation and ownership", () => {
  test("REQ-12 makes every ambient I/O and escape-list global undefined", async () => {
    const script = await runtime();
    const globals = JSON.parse(
      outputText(
        script.start(`
      text(JSON.stringify([
        typeof SharedArrayBuffer, typeof Atomics, typeof WeakRef, typeof FinalizationRegistry,
        typeof setTimeout, typeof console, typeof process, typeof require, typeof fetch,
        typeof Bun, typeof Deno, typeof XMLHttpRequest, typeof WebSocket
      ]));
    `)
      )
    );
    expect(globals).toEqual(Array(13).fill("undefined"));
  }, 20_000);

  test("REQ-12 constructor escapes remain inside the guest realm and fs import fails", async () => {
    const script = await runtime();
    expect(
      outputText(
        script.start(`
      text((function(){return this})().constructor.constructor("return typeof process")());
      text(tools.X.constructor("return typeof Bun")());
      try { await import("fs"); text("escaped"); } catch (_) { text("blocked"); }
    `)
      )
    ).toBe("undefinedundefinedblocked");
  }, 20_000);

  test("REQ-12 produces identical random sequences for the same seed, different for another", async () => {
    const source = "text(JSON.stringify(Array.from({length: 8}, () => Math.random())));";
    const a = outputText((await runtime({}, "seed-A")).start(source));
    const b = outputText((await runtime({}, "seed-A")).start(source));
    const c = outputText((await runtime({}, "seed-B")).start(source));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    for (const value of JSON.parse(a)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  }, 20_000);

  test("REQ-13 disposes 1000 suspended three-call scripts without poisoning the module", async () => {
    const module = await loadQuickJSModule();
    if (!module) throw new Error("Sandbox module unavailable");
    for (let i = 0; i < 1000; i++) {
      const script = await runtime();
      expect(
        blocked(
          script.start(`
        await Promise.all([tools.X({}), tools.Y({}), tools.Z({})]);
      `)
        )
      ).toHaveLength(3);
      script.dispose();
      script.dispose();
      expect(script.alive).toBe(false);
      expect(module.liveCount).toBe(0);
    }
    expect(module.poisoned).toBe(false);
    expect(currentQuickJSModule()).toBe(module);
    expect(outputText((await runtime()).start('text("healthy");'))).toBe("healthy");
  }, 20_000);

  test("REQ-28 exposes the documented sandbox policy limits", () => {
    expect(DEFAULT_SANDBOX_LIMITS).toMatchObject({
      memoryBytes: 32 * MiB,
      cpuMs: 2000,
      sourceBytes: 256 * 1024,
      callsPerBatch: 32,
      callsPerScript: 256,
      callInputBytes: 2 * MiB,
      batchInputBytes: 8 * MiB,
      resultBytes: MiB,
      resultBytesPerScript: 8 * MiB,
      outputBytes: MiB,
      outputParts: 1024,
    });
  }, 20_000);
});
