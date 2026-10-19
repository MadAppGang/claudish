/**
 * The QuickJS wasm module behind the exec sandbox: loaded lazily, once per
 * process, and only by a code-mode request.
 *
 * Packaging (C3 spike, recorded in the implementation log): the `-singlefile-`
 * sync release variant (`@jitl/quickjs-singlefile-mjs-release-sync`) carries
 * the wasm inlined as base64, so ONE import path works from `src/`, from the
 * bundled `dist/index.js` and from a `bun build --compile` binary, with no
 * wasm asset to copy. Both packages are imported dynamically: a classic
 * provider never evaluates them.
 *
 * One module serves every script; each script gets its own runtime + context
 * (`script-runtime.ts`). The lease enforces two process-wide policies:
 *
 *  - at most `MAX_LIVE_RUNTIMES` runtimes live at once (one running plus
 *    suspended ones waiting on Claude Code); admitting one more evicts the
 *    least recently active suspended runtime, whose record then goes lost;
 *  - when no runtime is live and the module's wasm memory exceeds
 *    `RECYCLE_WASM_BYTES`, the module is dropped and the next script reloads it
 *    (~11 ms), because wasm linear memory never shrinks.
 *
 * A wasm `RuntimeError` or QuickJS assertion anywhere poisons the module: it is
 * dropped, every runtime in it is treated as lost (handles abandoned with the
 * module, never disposed), and the next script loads a fresh one.
 */

import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { log } from "../../logger.js";

/** One running + up to 31 suspended runtimes, process-wide (every runtime lives in the current lease). */
export const MAX_LIVE_RUNTIMES = 32;
/** Wasm memory above which an idle module is dropped. */
export const RECYCLE_WASM_BYTES = 256 * 1024 * 1024;
/**
 * Wasm memory a slice may not grow the module past. QuickJS's per-runtime
 * memory limit does NOT bound the module's linear memory: measured in the C3
 * spike, `a.push("x".repeat(1024) + a.length)` under a 32 MiB runtime limit
 * grew the module to 2048 MiB (the wasm maximum) in 3.8 s before QuickJS
 * reported out of memory, and an object-push loop reached 143 MiB. A slice
 * that grows the module past this ceiling is interrupted as out of memory, and
 * the module is retired so the next script starts in a fresh one. 256 MiB, not
 * more: linear memory never shrinks, so whatever one runaway script reaches
 * stays resident in the proxy until the module is dropped, and orchestration
 * scripts need kilobytes.
 */
export const WASM_CEILING_BYTES = 256 * 1024 * 1024;
/**
 * Wasm memory summed over EVERY module still alive in the process (the
 * current one plus retired ones a running script still holds). A new runtime
 * is refused while the sum is over this, so retired modules can never pile up.
 */
export const PROCESS_WASM_CEILING_BYTES = 2 * WASM_CEILING_BYTES;

/** A runtime the lease tracks for the live cap and LRU eviction. */
export interface LeasedRuntime {
  /** Last time the runtime ran a slice (ms). */
  lastActive: number;
  /** True while a slice is executing (never evicted then). */
  running: boolean;
  /** Dispose the runtime because the cap needs its slot; the owner marks its record lost. */
  evict(): void;
  /** The module was poisoned: drop every handle without disposing. */
  abandon(): void;
}

/** The loaded module plus the process-wide runtime bookkeeping. */
export class QuickJSModuleLease {
  readonly module: QuickJSWASMModule;
  private readonly live = new Set<LeasedRuntime>();
  private poisonedReason: string | undefined;
  private retired = false;

  constructor(module: QuickJSWASMModule) {
    this.module = module;
    liveLeases.add(this);
  }

  /** True once the module failed internally; no new runtime may be created in it. */
  get poisoned(): boolean {
    return this.poisonedReason !== undefined;
  }

  /** True when this lease is no longer the current module (poisoned or recycled). */
  get usable(): boolean {
    return !this.poisoned && !this.retired;
  }

  get liveCount(): number {
    return this.live.size;
  }

  /**
   * Register a new runtime. At the cap, the least recently active suspended
   * runtime is evicted first. Returns why the runtime is refused — the wasm
   * memory of every live module is over `PROCESS_WASM_CEILING_BYTES`, or no
   * slot can be freed (every live runtime is running) — in which case the
   * caller must not create one; undefined when admitted.
   */
  admit(runtime: LeasedRuntime): string | undefined {
    const processBytes = processWasmBytes();
    if (processBytes > PROCESS_WASM_CEILING_BYTES) {
      log(
        `[CodeMode] sandbox: ${processBytes} bytes of wasm memory across ${liveLeases.size} module(s); new script refused`
      );
      return "claudish: the sandbox is over its memory limit while other scripts finish; try again";
    }
    while (this.live.size >= MAX_LIVE_RUNTIMES) {
      let oldest: LeasedRuntime | undefined;
      for (const candidate of this.live) {
        if (candidate.running) continue;
        if (!oldest || candidate.lastActive < oldest.lastActive) oldest = candidate;
      }
      if (!oldest) return SLOTS_BUSY;
      this.live.delete(oldest);
      log(
        `[CodeMode] sandbox: ${MAX_LIVE_RUNTIMES} live scripts; evicting the least recently used`
      );
      try {
        oldest.evict();
      } catch (err) {
        this.poison(`evicting a runtime threw: ${err}`);
        return SLOTS_BUSY;
      }
    }
    this.live.add(runtime);
    return undefined;
  }

  /** A runtime was disposed by its owner. May recycle an idle, oversized module. */
  release(runtime: LeasedRuntime): void {
    this.live.delete(runtime);
    if (this.live.size === 0 && !this.retired && this.wasmBytes() > RECYCLE_WASM_BYTES) {
      this.retired = true;
      dropCurrent(this);
      log("[CodeMode] sandbox: idle module over 256 MiB of wasm memory; dropped for reload");
    }
    if (this.live.size === 0 && !this.usable) liveLeases.delete(this);
  }

  /**
   * Stop admitting scripts into this module (its wasm memory is over the
   * ceiling and never shrinks). Every SUSPENDED runtime in it is evicted at
   * once (its record goes lost; replay re-runs it in the next module): a
   * suspended runtime holds the whole module, and a script can wait on Claude
   * Code for hours. Only the running script, the one that crossed the ceiling,
   * finishes here.
   */
  retire(reason: string): void {
    if (this.retired) return;
    this.retired = true;
    dropCurrent(this);
    log(`[CodeMode] sandbox module retired: ${reason}`);
    for (const runtime of [...this.live]) {
      if (runtime.running) continue;
      this.live.delete(runtime);
      try {
        runtime.evict();
      } catch (err) {
        this.poison(`evicting a runtime of a retired module threw: ${err}`);
        return;
      }
    }
    if (this.live.size === 0) liveLeases.delete(this);
  }

  /**
   * The module failed internally (wasm trap, QuickJS assertion, a library
   * lifetime error). Every live runtime is abandoned and the module dropped.
   */
  poison(reason: string): void {
    if (this.poisonedReason !== undefined) return;
    this.poisonedReason = reason;
    log(`[CodeMode] sandbox module poisoned: ${reason}`);
    const runtimes = [...this.live];
    this.live.clear();
    for (const runtime of runtimes) {
      try {
        runtime.abandon();
      } catch {
        // Abandoning only drops host references; nothing to recover.
      }
    }
    dropCurrent(this);
    liveLeases.delete(this);
  }

  /** Current wasm linear memory size; 0 when the library does not expose it. */
  wasmBytes(): number {
    try {
      const heap = (this.module as unknown as { module?: { HEAPU8?: Uint8Array } }).module?.HEAPU8;
      return heap?.byteLength ?? 0;
    } catch {
      return 0;
    }
  }
}

const SLOTS_BUSY = "claudish: every sandbox slot is running a script; try again";

/**
 * Every lease still alive: the current one, plus a retired one until its last
 * runtime ends. Their wasm memory is summed for admission.
 */
const liveLeases = new Set<QuickJSModuleLease>();

function processWasmBytes(): number {
  let bytes = 0;
  for (const lease of liveLeases) bytes += lease.wasmBytes();
  return bytes;
}

let current: QuickJSModuleLease | undefined;
let loading: Promise<QuickJSModuleLease | undefined> | undefined;
/** Set when the packages cannot be imported at all: no retry in this process. */
let unavailable: string | undefined;
let wasmBytesUnreadableLogged = false;

function dropCurrent(lease: QuickJSModuleLease): void {
  if (current === lease) current = undefined;
}

async function loadModule(): Promise<QuickJSModuleLease | undefined> {
  const started = performance.now();
  try {
    const core = await import("quickjs-emscripten-core");
    const variant = await import("@jitl/quickjs-singlefile-mjs-release-sync");
    const module = await core.newQuickJSWASMModuleFromVariant(variant.default);
    log(`[CodeMode] sandbox module loaded in ${(performance.now() - started).toFixed(1)} ms`);
    const lease = new QuickJSModuleLease(module);
    if (lease.wasmBytes() === 0 && !wasmBytesUnreadableLogged) {
      // `wasmBytes()` reads a private field; a library upgrade that removes it
      // would switch the wasm ceilings off with no other sign.
      wasmBytesUnreadableLogged = true;
      log(
        "[CodeMode] sandbox: the module's wasm memory size is unreadable; the wasm memory ceilings are OFF"
      );
    }
    return lease;
  } catch (err) {
    unavailable = String(err);
    log(`[CodeMode] sandbox unavailable: ${unavailable}`);
    return undefined;
  }
}

/**
 * The current module, loading it on first use (single-flight). Undefined when
 * QuickJS cannot be loaded in this process. Never throws.
 */
export async function loadQuickJSModule(): Promise<QuickJSModuleLease | undefined> {
  if (current?.usable) return current;
  if (unavailable !== undefined) return undefined;
  if (!loading) {
    loading = loadModule().then((lease) => {
      if (lease) current = lease;
      return lease;
    });
    loading.finally(() => {
      loading = undefined;
    });
  }
  return loading;
}

/** The current module when one is loaded and usable; never loads. */
export function currentQuickJSModule(): QuickJSModuleLease | undefined {
  return current?.usable ? current : undefined;
}

/**
 * Forget the loaded module and every latch (tests only): a simulated import
 * failure otherwise latches `unavailable` for the rest of the process.
 * Runtimes still in a dropped lease are left to their owners.
 */
export function resetQuickJSLoaderForTests(): void {
  current = undefined;
  loading = undefined;
  unavailable = undefined;
  wasmBytesUnreadableLogged = false;
  liveLeases.clear();
}

/** Whether a sandbox can run in this process (loads the module on first call). */
export async function isSandboxAvailable(): Promise<boolean> {
  return (await loadQuickJSModule()) !== undefined;
}
