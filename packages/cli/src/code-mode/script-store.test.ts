import { afterEach, describe, expect, test } from "bun:test";
import type { ExecOutput } from "./output";
import { loadQuickJSModule, resetQuickJSLoaderForTests } from "./sandbox/quickjs-loader";
import { type ScriptRuntime, createScriptRuntime } from "./sandbox/script-runtime";
import {
  DEFAULT_SCRIPT_STORE_LIMITS,
  type ExecEvent,
  type ExecState,
  ScriptStore,
} from "./script-store";
import { ToolNameTable } from "./tool-names";

const stores: ScriptStore[] = [];
const runtimes: ScriptRuntime[] = [];
const accountKey = "T3-account";
const sessionKey = "T3-owner";
let nextId = 0;

function store(options: ConstructorParameters<typeof ScriptStore>[0] = {}) {
  const instance = new ScriptStore(options);
  stores.push(instance);
  return instance;
}

function record(instance: ScriptStore, state: ExecState = "running", source = "x") {
  const id = `T3-exec-${nextId++}`;
  return instance.create({
    accountKey,
    sessionKey,
    execCallId: id,
    originalCallId: id,
    source,
    shape: "classic",
    state,
  });
}

function output(text: string): ExecOutput {
  return { status: "completed", wallMs: 0, parts: [{ type: "text", text }] };
}

afterEach(() => {
  for (const instance of stores.splice(0)) {
    instance.stopReaper();
    instance.clear();
  }
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  resetQuickJSLoaderForTests();
});

const legal: Array<[ExecState, ExecEvent, ExecState]> = [
  ["running", "block", "suspended"],
  ["running", "finish", "completed"],
  ["running", "fail", "failed"],
  ["suspended", "resume", "running"],
  ["suspended", "terminate", "terminated"],
  ["suspended", "abandon", "terminated"],
  ["suspended", "evict", "lost"],
  ["suspended", "expire", "lost"],
  ["lost", "answer", "failed"],
  ["lost", "replay", "running"],
  ["lost", "terminate", "terminated"],
  ["completed", "answer", "completed"],
  ["failed", "answer", "failed"],
  ["terminated", "answer", "terminated"],
];

describe("T3 script store state machine", () => {
  test.each(legal)("REQ-17 REQ-24 transitions %s + %s to %s", (state, event, destination) => {
    const instance = store();
    const item = record(instance, state);

    expect(instance.transition(item, event)).toBe(destination);
    expect(item.state).toBe(destination);
    expect(instance.peek(accountKey, item.execCallId)?.state).toBe(destination);
  });

  test("REQ-18 coerces every illegal state/event pair to lost without throwing", () => {
    const states: ExecState[] = [
      "running",
      "suspended",
      "lost",
      "completed",
      "failed",
      "terminated",
    ];
    const events: ExecEvent[] = [
      "block",
      "finish",
      "fail",
      "resume",
      "terminate",
      "abandon",
      "evict",
      "expire",
      "answer",
      "replay",
    ];
    const instance = store();
    let checked = 0;
    for (const state of states) {
      for (const event of events) {
        if (legal.some(([from, on]) => from === state && on === event)) continue;
        const item = record(instance, state);
        expect(() => instance.transition(item, event)).not.toThrow();
        expect(item.state).toBe("lost");
        checked++;
      }
    }
    expect(checked).toBe(46);
  });

  test("REQ-19 H2 peek sees lost immediately after a real runtime is evicted", async () => {
    const module = await loadQuickJSModule();
    if (!module) throw new Error("Sandbox module unavailable");
    const instance = store();
    const item = record(instance);
    const runtime = createScriptRuntime({
      module,
      seed: "immediate-eviction",
      tools: new ToolNameTable(["X"]),
      onEvicted: () => instance.loseIfRuntimeGone(item),
    });
    runtimes.push(runtime);
    instance.attachRuntime(item, runtime);
    expect(runtime.start("await tools.X({});").kind).toBe("blocked");
    instance.transition(item, "block");

    module.retire("T3 immediate store loss");

    // peek is deliberately used: get/reap must not be needed to notice the eviction.
    expect(instance.peek(accountKey, item.execCallId)?.state).toBe("lost");
    expect(runtime.alive).toBe(false);
    expect(runtime.lost).toBe(true);
    expect(instance.bytes).toBe(item.bytes);
  }, 20_000);

  test("REQ-20 expires suspended state using an injected clock without sleeping", async () => {
    const module = await loadQuickJSModule();
    if (!module) throw new Error("Sandbox module unavailable");
    let now = 100;
    const instance = store({ limits: { suspendedTtlMs: 60 }, now: () => now });
    const item = record(instance);
    const runtime = createScriptRuntime({
      module,
      seed: "ttl",
      tools: new ToolNameTable(["X"]),
    });
    runtimes.push(runtime);
    instance.attachRuntime(item, runtime);
    expect(runtime.start("await tools.X({});").kind).toBe("blocked");
    instance.transition(item, "block");

    now = 159;
    instance.reap();
    expect(instance.peek(accountKey, item.execCallId)?.state).toBe("suspended");
    expect(runtime.alive).toBe(true);
    now = 161;
    instance.reap();
    expect(instance.peek(accountKey, item.execCallId)?.state).toBe("lost");
    expect(runtime.alive).toBe(false);
  }, 20_000);
});

describe("T3 script store capacity and accounting", () => {
  test("REQ-21 evicts settled records by LRU under a small byte cap", () => {
    let now = 0;
    const instance = store({ limits: { maxBytes: 25 }, now: () => now });
    const first = record(instance, "completed", "a".repeat(10));
    now++;
    const second = record(instance, "completed", "b".repeat(10));
    now++;
    expect(instance.get(accountKey, first.execCallId)).toBe(first);
    now++;
    const third = record(instance, "completed", "c".repeat(10));
    instance.reap();

    expect(instance.peek(accountKey, first.execCallId)).toBe(first);
    expect(instance.peek(accountKey, second.execCallId)).toBeUndefined();
    expect(instance.peek(accountKey, third.execCallId)).toBe(third);
    expect(instance.isEvicted(accountKey, second.execCallId)).toBe(true);
    expect(instance.bytes).toBe(20);
    expect(instance.bytes).toBeLessThanOrEqual(25);
  });

  test("REQ-21 enforces the real 32 MiB settled ceiling and preserves a recently touched output", () => {
    let now = 0;
    const instance = store({ now: () => now++ });
    const items = [];
    const answer = output("x".repeat(1024 * 1024));
    for (let i = 0; i < 34; i++) {
      const item = record(instance, "completed");
      items.push(item);
      instance.storeOutput(item, "completion", answer, "run", sessionKey);
      expect(instance.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      if (i === 30) expect(instance.get(accountKey, items[0]!.execCallId)).toBe(items[0]);
    }

    expect(instance.size).toBe(31);
    expect(instance.peek(accountKey, items[0]!.execCallId)).toBe(items[0]);
    expect(instance.isEvicted(accountKey, items[1]!.execCallId)).toBe(true);
    expect(
      instance.lookupOutput(accountKey, items[33]!.execCallId, "completion", sessionKey)?.output
    ).toEqual(answer);
  });

  test("REQ-21 enforces record count separately from bytes and bounds eviction ids", () => {
    let now = 0;
    const instance = store({
      limits: { maxRecords: 1, maxBytes: 1000, maxEvictedIds: 2 },
      now: () => now++,
    });
    const items = Array.from({ length: 5 }, () => record(instance, "completed"));
    instance.reap();

    expect(instance.size).toBe(1);
    expect(instance.peek(accountKey, items[4]!.execCallId)).toBe(items[4]);
    expect(instance.isEvicted(accountKey, items[0]!.execCallId)).toBe(false);
    expect(instance.isEvicted(accountKey, items[2]!.execCallId)).toBe(true);
    expect(instance.isEvicted(accountKey, items[3]!.execCallId)).toBe(true);
  });

  test("REQ-22 counts UTF-8 source/output and 64 bytes per output part", () => {
    const instance = store();
    const item = record(instance, "completed", "é");
    const answer: ExecOutput = {
      status: "completed",
      wallMs: 0,
      parts: [
        { type: "text", text: "é" },
        { type: "text", text: "" },
      ],
    };
    instance.storeOutput(item, "completion", answer, "run", sessionKey);

    expect(item.bytes).toBe(2 + 2 + 2 * 64);
    expect(instance.bytes).toBe(item.bytes);
    instance.clear();
    expect(instance.bytes).toBe(0);
    expect(instance.size).toBe(0);
  });

  test("REQ-22 R2-2 counts repair ids and both 64-character hashes after settlement and answer", () => {
    const instance = store();
    const item = record(instance, "running", "x");
    const repairs = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `nested-${i}`,
        { script: "a".repeat(64), relayed: "b".repeat(64) },
      ])
    );
    item.batches.push({ ids: Object.keys(repairs), repairs });
    const expected =
      1 + Object.keys(repairs).reduce((sum, id) => sum + Buffer.byteLength(id) + 128, 0);

    instance.transition(item, "finish");
    expect(item.bytes).toBe(expected);
    expect(instance.bytes).toBe(expected);
    instance.transition(item, "answer");
    expect(item.bytes).toBe(expected);
    expect(instance.bytes).toBe(expected);
  });

  test("REQ-22 repair bytes can evict a record instead of bypassing the settled byte ceiling", () => {
    const instance = store({ limits: { maxBytes: 200 } });
    const item = record(instance);
    item.batches.push({
      ids: ["nested-0", "nested-1"],
      repairs: {
        "nested-0": { script: "a".repeat(64), relayed: "b".repeat(64) },
        "nested-1": { script: "c".repeat(64), relayed: "d".repeat(64) },
      },
    });

    instance.transition(item, "finish");
    instance.reap();

    expect(instance.peek(accountKey, item.execCallId)).toBeUndefined();
    expect(instance.isEvicted(accountKey, item.execCallId)).toBe(true);
    expect(instance.bytes).toBeLessThanOrEqual(200);
  });

  test("REQ-28 exposes documented script-store limits", () => {
    expect(DEFAULT_SCRIPT_STORE_LIMITS).toEqual({
      maxRecords: 2000,
      maxBytes: 32 * 1024 * 1024,
      suspendedTtlMs: 6 * 60 * 60 * 1000,
      maxEvictedIds: 20_000,
      reapIntervalMs: 60_000,
    });
  });
});

describe("T3 stored output precedence", () => {
  test("REQ-23 never overwrites a run output with a later tombstone", () => {
    const instance = store();
    const item = record(instance, "completed");
    const run = output("run output");
    instance.storeOutput(item, "same-history", run, "run", sessionKey);
    const before = instance.bytes;

    instance.storeOutput(item, "same-history", output("fork lost state"), "tombstone", "T3-fork");

    for (const session of [sessionKey, "T3-fork", "T3-third-session"]) {
      expect(instance.lookupOutput(accountKey, item.execCallId, "same-history", session)).toEqual({
        output: run,
        origin: "run",
        sessionKey,
      });
    }
    expect(instance.bytes).toBe(before);
  });

  test("REQ-23 replaces a tombstone with the eventual run output for every session", () => {
    const instance = store();
    const item = record(instance, "completed");
    const run = output("owner completed");
    instance.storeOutput(item, "same-history", output("fork tombstone"), "tombstone", "T3-fork");
    instance.storeOutput(item, "same-history", run, "run", sessionKey);

    expect(instance.lookupOutput(accountKey, item.execCallId, "same-history", "T3-fork")).toEqual({
      output: run,
      origin: "run",
      sessionKey,
    });
    expect(
      instance.lookupOutput(accountKey, item.execCallId, "same-history", sessionKey)?.output
    ).toEqual(run);
  });

  test("REQ-23 scopes tombstones by session and records by account and completion key", () => {
    const instance = store();
    const item = record(instance, "failed");
    const tombstone = output("lost state");
    instance.storeOutput(item, "completion-A", tombstone, "tombstone", "T3-fork");

    expect(
      instance.lookupOutput(accountKey, item.execCallId, "completion-A", "T3-fork")?.output
    ).toEqual(tombstone);
    expect(
      instance.lookupOutput(accountKey, item.execCallId, "completion-A", sessionKey)
    ).toBeUndefined();
    expect(
      instance.lookupOutput("other-account", item.execCallId, "completion-A", "T3-fork")
    ).toBeUndefined();
    expect(
      instance.lookupOutput(accountKey, item.execCallId, "completion-B", "T3-fork")
    ).toBeUndefined();
  });
});
