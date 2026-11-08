import { afterEach, describe, expect, test } from "bun:test";
import { ToolNameTable } from "../tool-names";
import {
  type LeasedRuntime,
  MAX_LIVE_RUNTIMES,
  type QuickJSModuleLease,
  RECYCLE_WASM_BYTES,
  WASM_CEILING_BYTES,
  currentQuickJSModule,
  loadQuickJSModule,
  resetQuickJSLoaderForTests,
} from "./quickjs-loader";
import { type ScriptRuntime, createScriptRuntime } from "./script-runtime";

const MiB = 1024 * 1024;
const runtimes: ScriptRuntime[] = [];
const participants: Array<{ lease: QuickJSModuleLease; runtime: LeasedRuntime }> = [];

async function lease() {
  const module = await loadQuickJSModule();
  if (!module) throw new Error("The isolated QuickJS module must be available");
  return module;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const item of participants.splice(0)) item.lease.release(item.runtime);
  resetQuickJSLoaderForTests();
});

describe("T3 module leases", () => {
  test("REQ-14 retirement immediately evicts real suspended runtimes and notifies owners", async () => {
    const module = await lease();
    const notifications: number[] = [];
    for (let i = 0; i < 3; i++) {
      const runtime = createScriptRuntime({
        module,
        tools: new ToolNameTable(["X"]),
        seed: `retire-${i}`,
        onEvicted: () => {
          notifications.push(i);
        },
      });
      runtimes.push(runtime);
      expect(runtime.start("await tools.X({});").kind).toBe("blocked");
    }
    expect(module.liveCount).toBe(3);

    module.retire("T3 public lease retirement");

    expect(notifications.sort()).toEqual([0, 1, 2]);
    for (const runtime of runtimes) {
      expect(runtime.alive).toBe(false);
      expect(runtime.lost).toBe(true);
    }
    expect(module.liveCount).toBe(0);
    expect(module.usable).toBe(false);
    const next = await lease();
    expect(next).not.toBe(module);
    expect(next.usable).toBe(true);
    expect(currentQuickJSModule()).toBe(next);
  }, 20_000);

  test("REQ-15 retirement preserves a public participant while it is running", async () => {
    const module = await lease();
    const notifications: string[] = [];
    // A public LeasedRuntime participant, not a fabricated wasm module or private-state probe.
    const running: LeasedRuntime = {
      lastActive: 1,
      running: true,
      evict() {
        notifications.push("running-evicted");
      },
      abandon() {
        notifications.push("running-abandoned");
      },
    };
    participants.push({ lease: module, runtime: running });
    expect(module.admit(running)).toBeUndefined();

    module.retire("T3 retire during a running slice");

    expect(notifications).toEqual([]);
    expect(module.liveCount).toBe(1);
    expect(module.usable).toBe(false);
    running.running = false;
    module.release(running);
    expect(module.liveCount).toBe(0);
  }, 20_000);

  test("REQ-15 refuses admission with a string when all 32 slots are running", async () => {
    const module = await lease();
    const notifications: string[] = [];
    const makeParticipant = (i: number): LeasedRuntime => ({
      lastActive: i,
      running: true,
      evict() {
        notifications.push(`evicted-${i}`);
      },
      abandon() {
        notifications.push(`abandoned-${i}`);
      },
    });
    for (let i = 0; i < 32; i++) {
      const runtime = makeParticipant(i);
      participants.push({ lease: module, runtime });
      expect(module.admit(runtime)).toBeUndefined();
    }

    const refusal = module.admit(makeParticipant(32));

    expect(typeof refusal).toBe("string");
    expect(refusal!.length).toBeGreaterThan(0);
    expect(module.liveCount).toBe(32);
    expect(notifications).toEqual([]);
  }, 20_000);

  test("REQ-14 evicts the least-recently-active suspended runtime at the live cap", async () => {
    const module = await lease();
    let time = 1;
    const notifications: number[] = [];
    for (let i = 0; i < 33; i++) {
      const runtime = createScriptRuntime({
        module,
        tools: new ToolNameTable(["X"]),
        seed: `cap-${i}`,
        now: () => time++,
        onEvicted: () => {
          notifications.push(i);
        },
      });
      runtimes.push(runtime);
      expect(runtime.start("await tools.X({});").kind).toBe("blocked");
    }

    expect(notifications).toEqual([0]);
    expect(runtimes[0]!.lost).toBe(true);
    expect(runtimes[0]!.alive).toBe(false);
    expect(runtimes.slice(1).every((runtime) => runtime.alive)).toBe(true);
    expect(module.liveCount).toBe(32);
  }, 20_000);

  test("REQ-16 R2-3b completes an innocent allocation beside holders at the wasm ceiling", async () => {
    const module = await lease();
    expect(module.wasmBytes()).toBeGreaterThan(0);
    const notifications: number[] = [];
    let holders = 0;
    // No public wasm-ceiling injection exists. Real holders force the real 256 MiB boundary.
    while (module.wasmBytes() < WASM_CEILING_BYTES - 32 * MiB && holders < 31) {
      const id = holders++;
      const runtime = createScriptRuntime({
        module,
        tools: new ToolNameTable(["X"]),
        seed: `holder-${id}`,
        onEvicted: () => {
          notifications.push(id);
        },
      });
      runtimes.push(runtime);
      expect(
        runtime.start(`
        const held = [];
        for (let i=0; i<8; i++) held.push("h".repeat(1024*1024-32) + i);
        await tools.X({});
        text(String(held[0].length));
      `).kind
      ).toBe("blocked");
      expect(module.usable).toBe(true);
    }
    expect(module.wasmBytes()).toBeGreaterThanOrEqual(WASM_CEILING_BYTES - 32 * MiB);
    expect(holders).toBeGreaterThan(1);

    const innocent = createScriptRuntime({
      module,
      tools: new ToolNameTable([]),
      seed: "innocent-allocation",
      limits: { memoryBytes: 64 * MiB },
    });
    runtimes.push(innocent);
    const step = innocent.start(`
      const value = "i".repeat(56 * 1024 * 1024);
      text(String(value.length));
    `);

    expect(step.kind).toBe("done");
    if (step.kind !== "done") throw new Error("The allocation must complete without tools");
    expect(step.output.status).toBe("completed");
    expect(step.output.parts).toEqual([{ type: "text", text: String(56 * MiB) }]);
    expect(step.output.error).toBeUndefined();
    expect(module.wasmBytes()).toBeGreaterThan(WASM_CEILING_BYTES);
    expect(module.usable).toBe(false);
    expect(module.liveCount).toBe(0);
    expect(notifications.sort((a, b) => a - b)).toEqual(
      Array.from({ length: holders }, (_, i) => i)
    );
    const next = await lease();
    expect(next).not.toBe(module);
    expect(next.usable).toBe(true);
  }, 20_000);

  test("REQ-28 exposes the current live cap and wasm retirement limits", () => {
    expect(MAX_LIVE_RUNTIMES).toBe(32);
    expect(WASM_CEILING_BYTES).toBe(256 * MiB);
    expect(RECYCLE_WASM_BYTES).toBe(256 * MiB);
  }, 20_000);
});
