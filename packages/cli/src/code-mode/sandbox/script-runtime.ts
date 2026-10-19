/**
 * One exec script in its own QuickJS runtime + context, suspended across
 * Claude Code round trips.
 *
 * `tools.X(args)` returns a deferred QuickJS promise and records a nested call;
 * after a slice (`start` or `resume`, then the job queue drained) every call
 * created in that slice IS the batch of tool_use blocks for the downstream
 * message, so `Promise.all` lands all of its calls in one batch with no extra
 * logic. Claude Code's tool_results come back on a later request and are fed in
 * by `resume`: a result resolves its call with the result text, an `is_error`
 * result REJECTS it with a plain string (as Codex rejects nested tool errors),
 * so `Promise.allSettled` sees `{status:"rejected", reason:"…"}`.
 *
 * Settlement order after every slice (architecture §5.6):
 *  1. the top-level promise's state is read FIRST: fulfilled, or rejected with
 *     the `exit()` sentinel → completed, and every call still outstanding is
 *     discarded (it never runs — unlike Codex, where an unawaited call may
 *     already have run); rejected otherwise → failed;
 *  2. pending with ≥ 1 call created in this slice → blocked(calls);
 *  3. pending with none → failed: the script awaits something that can never
 *     settle;
 *  4. CPU budget or memory exhausted → failed.
 *
 * Handle ownership (pinned by the C3 spike): a host function's RETURNED handle
 * is consumed by the library (it dups the value for QuickJS and disposes the
 * handle at scope end), so a deferred's `handle` is dead once returned and this
 * runtime owns only each deferred's resolve/reject functions. `dispose()` is
 * idempotent and runs on every terminal transition: unsettled deferreds, the
 * top-level promise handle, the trusted helper handles, the context, the
 * runtime — in that order. A wasm trap or library lifetime error anywhere
 * poisons the module (`quickjs-loader.ts`); the script is then lost.
 *
 * The interrupt handler can only TERMINATE a slice, never yield it (R2 §2), so
 * the CPU budget is cumulative across slices and also the longest one slice can
 * block the event loop.
 */

import { createHash } from "node:crypto";
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
} from "quickjs-emscripten-core";
import type { ExecToolMeta } from "../exec-tool.js";
import {
  type ExecOutput,
  type ImageRef,
  type OutputPart,
  mapScriptStack,
  parseExecPragma,
} from "../output.js";
import type { ToolNameTable } from "../tool-names.js";
import { PRELUDE_SOURCE } from "./prelude.js";
import {
  type LeasedRuntime,
  type QuickJSModuleLease,
  WASM_CEILING_BYTES,
} from "./quickjs-loader.js";

export type { ExecOutput, ImageRef, OutputPart } from "../output.js";

/** One nested tool call a script made: `seq` orders it within the script. */
export type NestedCall = {
  seq: number;
  ident: string;
  name: string;
  input: Record<string, unknown>;
};

/** Claude Code's answer to one nested call. `ok: false` rejects it with `text`. */
export type NestedResult = { seq: number; ok: boolean; text: string; images?: ImageRef[] };

export type ScriptStep =
  | { kind: "blocked"; calls: [NestedCall, ...NestedCall[]] }
  | { kind: "done"; output: ExecOutput };

export interface ScriptRuntime {
  start(source: string): ScriptStep;
  resume(results: NestedResult[]): ScriptStep;
  dispose(): void;
  /**
   * End a suspended script from outside (interrupt, conversation moved on):
   * a `terminated` output carrying what it produced so far plus `note`.
   */
  terminate(note: string): ExecOutput;
  /** False after dispose, eviction or a poisoned module: the script state is gone. */
  readonly alive: boolean;
  /** True when the module was poisoned or the runtime evicted (its record goes lost). */
  readonly lost: boolean;
}

/** claudish policy; model-independent. */
export interface SandboxLimits {
  memoryBytes: number;
  maxStackBytes: number;
  cpuMs: number;
  sourceBytes: number;
  callsPerBatch: number;
  callsPerScript: number;
  callInputBytes: number;
  batchInputBytes: number;
  resultBytes: number;
  resultBytesPerScript: number;
  outputBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
  cpuMs: 2_000,
  sourceBytes: 256 * 1024,
  callsPerBatch: 32,
  callsPerScript: 256,
  callInputBytes: 2 * 1024 * 1024,
  batchInputBytes: 8 * 1024 * 1024,
  resultBytes: 1024 * 1024,
  resultBytesPerScript: 8 * 1024 * 1024,
  outputBytes: 1024 * 1024,
};

export interface CreateScriptRuntimeOptions {
  tools: ToolNameTable;
  /** `ALL_TOOLS` entries; default: names only. */
  allTools?: readonly ExecToolMeta[];
  limits?: Partial<SandboxLimits>;
  /** Seeds `Math.random` (the exec call id). */
  seed: string;
  module: QuickJSModuleLease;
  /** Called when the lease evicts this runtime for the live cap (its record goes lost). */
  onEvicted?: () => void;
  /** Test seam: default `performance.now`. */
  now?: () => number;
}

interface PendingCall {
  call: NestedCall;
  deferred: QuickJSDeferredPromise;
}

const RESULT_TRUNCATED_MARKER = "\n[claudish: tool result truncated at 1 MiB]";

function seedNumber(seed: string): number {
  return createHash("sha256").update(seed).digest().readUInt32BE(0);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** `1 MiB` for whole MiB, else `<n>-byte`. */
function describeBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? `${mib} MiB` : `${bytes}-byte`;
}

/** An Error-shaped value as `Name: message` plus its stack, lines mapped to the input. */
function describeErrorObject(v: { name?: unknown; message: string; stack?: unknown }): string {
  const head = typeof v.name === "string" && v.name ? `${v.name}: ${v.message}` : v.message;
  const stack = typeof v.stack === "string" ? v.stack.trimEnd() : "";
  return stack ? `${head}\n${mapScriptStack(stack)}` : head;
}

/** Codex's rendering of a thrown value: a string as-is, an Error with its stack. */
function describeGuestError(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value);
  const v = value as { message?: unknown };
  if (typeof v.message === "string") {
    return describeErrorObject(value as { message: string });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A failure that is the guest's (memory, a thrown value), not the library's. */
class GuestFault extends Error {}

class QuickJSScriptRuntime implements ScriptRuntime, LeasedRuntime {
  lastActive = 0;
  running = false;

  private readonly limits: SandboxLimits;
  private readonly now: () => number;
  private readonly lease: QuickJSModuleLease;
  private readonly tools: ToolNameTable;
  private readonly allTools: readonly ExecToolMeta[];
  private readonly seed: string;
  private readonly onEvicted?: () => void;

  private rt: QuickJSRuntime | undefined;
  private ctx: QuickJSContext | undefined;
  private topHandle: QuickJSHandle | undefined;
  private cutHandle: QuickJSHandle | undefined;
  private exitHandle: QuickJSHandle | undefined;

  private readonly pending = new Map<number, PendingCall>();
  private sliceCalls: NestedCall[] = [];
  private sliceInputBytes = 0;
  private seq = 0;
  private callCount = 0;
  private resultBytes = 0;

  private readonly parts: OutputPart[] = [];
  private outputUsed = 0;
  private outputDropped = 0;

  private cpuUsed = 0;
  private sliceStart = -1;
  private interrupted = false;
  private wasmExceeded = false;
  private sliceWasmBytes = 0;
  private startedAt: number | undefined;
  private disposed = false;
  private wasLost = false;

  constructor(opts: CreateScriptRuntimeOptions) {
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...opts.limits };
    this.now = opts.now ?? (() => performance.now());
    this.lease = opts.module;
    this.tools = opts.tools;
    this.allTools =
      opts.allTools ??
      opts.tools.entries().map((e) => ({ name: e.ident, description: "", inputSchema: {} }));
    this.seed = opts.seed;
    this.onEvicted = opts.onEvicted;
  }

  get alive(): boolean {
    return !this.disposed;
  }

  get lost(): boolean {
    return this.wasLost;
  }

  // ─── lifecycle ──────────────────────────────────────────────────────

  start(input: string): ScriptStep {
    this.startedAt = this.now();
    if (this.rt || this.disposed) return this.fail("claudish: this script was already started");
    if (utf8Bytes(input) > this.limits.sourceBytes) {
      return this.fail(
        `claudish: the script is ${utf8Bytes(input)} bytes; the limit is ${this.limits.sourceBytes}`
      );
    }
    const pragma = parseExecPragma(input);
    if (pragma.error) return this.fail(pragma.error);
    if (!this.lease.usable) return this.lose("the sandbox module is unavailable");
    return this.guard(() => {
      this.createContext();
      return this.slice(() => {
        const ctx = this.requireCtx();
        const result = ctx.evalCode(`(async () => {\n${pragma.source}\n})()`, "exec.js");
        if (result.error) {
          throw new GuestFault(this.consumeError(result.error));
        }
        this.topHandle = result.value;
      });
    });
  }

  resume(results: NestedResult[]): ScriptStep {
    if (this.disposed || !this.ctx || !this.topHandle) {
      return this.lose("the script is no longer running");
    }
    return this.guard(() =>
      this.slice(() => {
        const bySeq = new Map<number, NestedResult>();
        for (const result of results) bySeq.set(result.seq, result);
        const outstanding = [...this.pending.values()];
        this.pending.clear();
        for (const { call, deferred } of outstanding) {
          const result = bySeq.get(call.seq);
          if (!result) {
            this.settle(deferred, false, "no tool_result returned");
            continue;
          }
          this.deliver(deferred, result);
        }
      })
    );
  }

  terminate(note: string): ExecOutput {
    const parts = [...this.parts];
    if (note) parts.push({ type: "text", text: note });
    const output: ExecOutput = { status: "terminated", wallMs: this.wallMs(), parts };
    this.dispose();
    return output;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      for (const { deferred } of this.pending.values()) {
        if (deferred.alive) deferred.dispose();
      }
      this.pending.clear();
      for (const handle of [this.topHandle, this.cutHandle, this.exitHandle]) {
        if (handle?.alive) handle.dispose();
      }
      this.topHandle = this.cutHandle = this.exitHandle = undefined;
      this.ctx?.dispose();
      this.rt?.dispose();
    } catch (err) {
      this.lease.poison(`disposing a script runtime threw: ${err}`);
      this.wasLost = true;
    } finally {
      this.ctx = undefined;
      this.rt = undefined;
      this.lease.release(this);
    }
  }

  /** LeasedRuntime: the live cap needs this slot. */
  evict(): void {
    this.wasLost = true;
    this.dispose();
    this.onEvicted?.();
  }

  /** LeasedRuntime: the module is poisoned; drop handles without touching wasm. */
  abandon(): void {
    this.wasLost = true;
    this.disposed = true;
    this.pending.clear();
    this.topHandle = this.cutHandle = this.exitHandle = undefined;
    this.ctx = undefined;
    this.rt = undefined;
    this.onEvicted?.();
  }

  // ─── context setup ──────────────────────────────────────────────────

  private createContext(): void {
    if (!this.lease.admit(this)) {
      throw new GuestFault("claudish: every sandbox slot is running a script; try again");
    }
    const rt = this.lease.module.newRuntime();
    this.rt = rt;
    rt.setMemoryLimit(this.limits.memoryBytes);
    rt.setMaxStackSize(this.limits.maxStackBytes);
    rt.setInterruptHandler(() => {
      if (this.sliceStart < 0) return false;
      if (this.cpuUsed + (this.now() - this.sliceStart) > this.limits.cpuMs) {
        this.interrupted = true;
        return true;
      }
      // The runtime's memory limit does not bound the module's linear memory
      // (see WASM_CEILING_BYTES); a slice that grows it past the ceiling stops.
      const wasm = this.lease.wasmBytes();
      if (wasm > WASM_CEILING_BYTES && wasm > this.sliceWasmBytes) {
        this.wasmExceeded = true;
        return true;
      }
      return false;
    });
    const ctx = rt.newContext();
    this.ctx = ctx;

    const bridge = ctx.newObject();
    const call = ctx.newFunction("call", (identH, argsH) => this.onCall(identH, argsH));
    const text = ctx.newFunction("text", (valueH) => this.onText(valueH));
    const register = ctx.newFunction("register", (cutH, exitH) => {
      this.cutHandle = cutH.dup();
      this.exitHandle = exitH.dup();
    });
    ctx.setProp(bridge, "call", call);
    ctx.setProp(bridge, "text", text);
    ctx.setProp(bridge, "register", register);
    call.dispose();
    text.dispose();
    register.dispose();

    const prelude = ctx.evalCode(PRELUDE_SOURCE, "prelude.js");
    if (prelude.error) {
      bridge.dispose();
      throw new Error(`prelude failed: ${this.consumeError(prelude.error)}`);
    }
    const seed = ctx.newNumber(seedNumber(this.seed));
    const idents = ctx.newString(JSON.stringify(this.tools.entries().map((e) => e.ident)));
    const allTools = ctx.newString(JSON.stringify(this.allTools));
    const applied = ctx.callFunction(prelude.value, ctx.undefined, bridge, seed, idents, allTools);
    for (const h of [prelude.value, bridge, seed, idents, allTools]) h.dispose();
    if (applied.error) {
      throw new Error(`prelude failed: ${this.consumeError(applied.error)}`);
    }
    applied.value.dispose();
    if (!this.cutHandle || !this.exitHandle) throw new Error("prelude did not register");
  }

  // ─── host functions ─────────────────────────────────────────────────

  private onCall(identH: QuickJSHandle, argsH: QuickJSHandle): QuickJSHandle {
    const ctx = this.requireCtx();
    const ident = ctx.typeof(identH) === "string" ? ctx.getString(identH) : "";
    const name = this.tools.nameFor(ident);
    if (!name) return this.rejected(`claudish: tools.${ident} is not a tool; see ALL_TOOLS`);
    if (this.sliceCalls.length >= this.limits.callsPerBatch) {
      return this.rejected(
        `claudish: more than ${this.limits.callsPerBatch} tool calls in one batch; this call was not run`
      );
    }
    if (this.callCount >= this.limits.callsPerScript) {
      return this.rejected(
        `claudish: more than ${this.limits.callsPerScript} tool calls in one script; this call was not run`
      );
    }
    if (ctx.typeof(argsH) !== "object") {
      return this.rejected(
        `claudish: tools.${ident} takes an object as its argument; this call was not run`
      );
    }
    const input = ctx.dump(argsH) as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return this.rejected(
        `claudish: tools.${ident} takes an object as its argument; this call was not run`
      );
    }
    const bytes = utf8Bytes(JSON.stringify(input));
    if (bytes > this.limits.callInputBytes) {
      return this.rejected(
        `claudish: the input to tools.${ident} is ${bytes} bytes; the limit is ${this.limits.callInputBytes}; this call was not run`
      );
    }
    if (this.sliceInputBytes + bytes > this.limits.batchInputBytes) {
      return this.rejected(
        `claudish: this batch's tool inputs exceed ${this.limits.batchInputBytes} bytes; this call was not run`
      );
    }
    this.sliceInputBytes += bytes;
    this.callCount++;
    const call: NestedCall = {
      seq: this.seq++,
      ident,
      name,
      input: input as Record<string, unknown>,
    };
    const deferred = ctx.newPromise();
    this.pending.set(call.seq, { call, deferred });
    this.sliceCalls.push(call);
    // The library consumes the returned handle; the deferred keeps its resolvers.
    return deferred.handle;
  }

  private onText(valueH: QuickJSHandle): void {
    const ctx = this.requireCtx();
    if (ctx.typeof(valueH) !== "string") {
      throw new TypeError("claudish: text() bridge expects a string");
    }
    const lengthH = ctx.getProp(valueH, "length");
    const length = ctx.getNumber(lengthH);
    lengthH.dispose();
    const remaining = this.limits.outputBytes - this.outputUsed;
    if (!(length > 0)) {
      this.parts.push({ type: "text", text: "" });
      return;
    }
    if (remaining <= 0) {
      this.outputDropped += length;
      return;
    }
    let received: string;
    if (length <= remaining) {
      received = ctx.getString(valueH);
    } else {
      const limitH = ctx.newNumber(remaining);
      const cut = ctx.callFunction(
        this.requireHandle(this.cutHandle),
        ctx.undefined,
        valueH,
        limitH
      );
      limitH.dispose();
      if (cut.error) {
        cut.error.dispose();
        received = "";
      } else {
        received = ctx.typeof(cut.value) === "string" ? ctx.getString(cut.value) : "";
        cut.value.dispose();
      }
    }
    // Never trust the guest's cut: bound what is kept here.
    const kept = received.length > remaining ? received.slice(0, remaining) : received;
    this.outputDropped += Math.max(0, length - kept.length);
    this.outputUsed += kept.length;
    this.parts.push({ type: "text", text: kept });
  }

  // ─── slices and settlement ──────────────────────────────────────────

  /**
   * Run `body` as one CPU-budgeted slice, drain the job queue, then settle.
   *
   * Settlement runs INSIDE the slice, with the deadline still armed: rendering
   * a rejection dumps the guest value, and QuickJS's dump JSON-stringifies it,
   * which runs the guest's `toJSON()`, getters and Proxy traps. Disarmed, a
   * `throw {toJSON(){while(true){}}}` blocked the event loop forever.
   */
  private slice(body: () => void): ScriptStep {
    const rt = this.requireRt();
    this.sliceCalls = [];
    this.sliceInputBytes = 0;
    this.running = true;
    this.sliceWasmBytes = this.lease.wasmBytes();
    this.sliceStart = this.now();
    try {
      body();
      const jobs = rt.executePendingJobs();
      if (jobs.error) throw new GuestFault(this.consumeError(jobs.error));
      return this.settleTop();
    } finally {
      this.cpuUsed += this.now() - this.sliceStart;
      this.sliceStart = -1;
      this.running = false;
      this.lastActive = Date.now();
    }
  }

  private settleTop(): ScriptStep {
    if (this.interrupted || this.wasmExceeded) return this.cpuExceeded();
    const ctx = this.requireCtx();
    const top = this.requireHandle(this.topHandle);
    const state = ctx.getPromiseState(top);
    if (state.type === "fulfilled") {
      if (!state.notAPromise) state.value.dispose();
      return this.finish("completed");
    }
    if (state.type === "rejected") {
      const isExit = this.exitHandle !== undefined && ctx.sameValue(state.error, this.exitHandle);
      if (isExit) {
        state.error.dispose();
        return this.finish("completed");
      }
      const error = this.consumeError(state.error);
      // The dump ran guest code under the deadline; an interrupt there is the budget's.
      if (this.interrupted || this.wasmExceeded) return this.cpuExceeded();
      return this.finish("failed", error);
    }
    const [first, ...rest] = this.sliceCalls;
    if (first) return { kind: "blocked", calls: [first, ...rest] };
    return this.finish(
      "failed",
      "deadlocked: the script awaits a promise that can never settle (no tool calls are pending)"
    );
  }

  /** The slice was interrupted: CPU budget, or the module's wasm ceiling. */
  private cpuExceeded(): ScriptStep {
    if (this.wasmExceeded) {
      this.lease.retire("a script grew its wasm memory past the ceiling");
      return this.finish(
        "failed",
        "out of memory: the script grew the sandbox's memory past claudish's limit"
      );
    }
    return this.finish(
      "failed",
      `interrupted: exceeded the ${this.limits.cpuMs / 1000} s CPU budget`
    );
  }

  /** A terminal step: the output so far (+ the drop warning), then dispose. */
  private finish(status: "completed" | "failed", error?: string): ScriptStep {
    const parts = [...this.parts];
    if (this.outputDropped > 0) {
      parts.push({
        type: "text",
        text: `Warning: output exceeded claudish's ${describeBytes(this.limits.outputBytes)} limit; ${this.outputDropped} bytes dropped`,
      });
    }
    const output: ExecOutput = { status, wallMs: this.wallMs(), parts };
    if (error !== undefined) output.error = error;
    this.dispose();
    return { kind: "done", output };
  }

  private fail(error: string): ScriptStep {
    return this.finish("failed", error);
  }

  /** The script state is gone (poisoned module, eviction). */
  private lose(reason: string): ScriptStep {
    this.wasLost = true;
    return this.finish("failed", `claudish lost this script's state (${reason})`);
  }

  /**
   * Run `fn`, mapping a guest fault to a failed script and any other throw (a
   * wasm trap, a library lifetime error) to a poisoned module.
   */
  private guard(fn: () => ScriptStep): ScriptStep {
    try {
      return fn();
    } catch (err) {
      if (err instanceof GuestFault) {
        if (this.interrupted || this.wasmExceeded) return this.cpuExceeded();
        return this.fail(err.message);
      }
      this.lease.poison(String(err));
      this.wasLost = true;
      this.abandonAfterPoison();
      return {
        kind: "done",
        output: {
          status: "failed",
          wallMs: this.wallMs(),
          parts: [...this.parts],
          error: "claudish's sandbox failed internally; this script's state is lost",
        },
      };
    }
  }

  private abandonAfterPoison(): void {
    if (this.disposed) return;
    this.abandon();
  }

  // ─── result delivery ────────────────────────────────────────────────

  private deliver(deferred: QuickJSDeferredPromise, result: NestedResult): void {
    for (const ref of result.images ?? []) this.parts.push({ type: "image", ref });
    let text = typeof result.text === "string" ? result.text : String(result.text);
    if (utf8Bytes(text) > this.limits.resultBytes) {
      const cut = Buffer.from(text, "utf8")
        .subarray(0, this.limits.resultBytes)
        .toString("utf8")
        .replace(/�$/, "");
      text = `${cut}${RESULT_TRUNCATED_MARKER}`;
    }
    const bytes = utf8Bytes(text);
    if (this.resultBytes + bytes > this.limits.resultBytesPerScript) {
      this.settle(
        deferred,
        false,
        `claudish: this script's tool results exceed ${this.limits.resultBytesPerScript} bytes; this result was not delivered`
      );
      return;
    }
    this.resultBytes += bytes;
    this.settle(deferred, result.ok, text);
  }

  private settle(deferred: QuickJSDeferredPromise, ok: boolean, text: string): void {
    const ctx = this.requireCtx();
    const value = ctx.newString(text);
    if (ok) deferred.resolve(value);
    else deferred.reject(value);
    value.dispose();
    deferred.dispose();
  }

  /** A promise handle already rejected with `message` (consumed by the library on return). */
  private rejected(message: string): QuickJSHandle {
    const ctx = this.requireCtx();
    const deferred = ctx.newPromise();
    const value = ctx.newString(message);
    deferred.reject(value);
    value.dispose();
    return deferred.handle;
  }

  // ─── helpers ────────────────────────────────────────────────────────

  private consumeError(handle: QuickJSHandle): string {
    const ctx = this.requireCtx();
    let value: unknown;
    try {
      value = ctx.dump(handle);
    } finally {
      if (handle.alive) handle.dispose();
    }
    const text = describeGuestError(value);
    if (/out of memory/i.test(text)) return "out of memory: the script exceeded its 32 MiB heap";
    return text;
  }

  private wallMs(): number | undefined {
    return this.startedAt === undefined ? undefined : Math.max(0, this.now() - this.startedAt);
  }

  private requireCtx(): QuickJSContext {
    if (!this.ctx) throw new Error("script context is gone");
    return this.ctx;
  }

  private requireRt(): QuickJSRuntime {
    if (!this.rt) throw new Error("script runtime is gone");
    return this.rt;
  }

  private requireHandle(handle: QuickJSHandle | undefined): QuickJSHandle {
    if (!handle?.alive) throw new Error("script handle is gone");
    return handle;
  }
}

/**
 * A runtime for one exec script in `module`. Synchronous: the module must
 * already be loaded (`loadQuickJSModule`). The runtime and context are created
 * by `start`.
 */
export function createScriptRuntime(opts: CreateScriptRuntimeOptions): ScriptRuntime {
  return new QuickJSScriptRuntime(opts);
}

/** For logs: a step in one line. */
export function describeStep(step: ScriptStep): string {
  if (step.kind === "blocked") return `blocked on ${step.calls.length} call(s)`;
  return `${step.output.status}${step.output.error ? ` (${step.output.error.split("\n")[0]})` : ""}`;
}
