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

/** One running + up to 31 suspended runtimes: ≤ 1 GiB of the 2 GiB wasm ceiling at 32 MiB each. */
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
 * the module is retired so the next script starts in a fresh one.
 */
export const WASM_CEILING_BYTES = 1024 * 1024 * 1024;

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
   * runtime is evicted first. Returns false when no slot can be freed (every
   * live runtime is running), in which case the caller must not create one.
   */
  admit(runtime: LeasedRuntime): boolean {
    while (this.live.size >= MAX_LIVE_RUNTIMES) {
      let oldest: LeasedRuntime | undefined;
      for (const candidate of this.live) {
        if (candidate.running) continue;
        if (!oldest || candidate.lastActive < oldest.lastActive) oldest = candidate;
      }
      if (!oldest) return false;
      this.live.delete(oldest);
      log(
        `[CodeMode] sandbox: ${MAX_LIVE_RUNTIMES} live scripts; evicting the least recently used`
      );
      try {
        oldest.evict();
      } catch (err) {
        this.poison(`evicting a runtime threw: ${err}`);
        return false;
      }
    }
    this.live.add(runtime);
    return true;
  }

  /** A runtime was disposed by its owner. May recycle an idle, oversized module. */
  release(runtime: LeasedRuntime): void {
    this.live.delete(runtime);
    if (this.live.size === 0 && !this.retired && this.wasmBytes() > RECYCLE_WASM_BYTES) {
      this.retired = true;
      dropCurrent(this);
      log("[CodeMode] sandbox: idle module over 256 MiB of wasm memory; dropped for reload");
    }
  }

  /**
   * Stop admitting scripts into this module (its wasm memory is over the
   * ceiling and never shrinks); the scripts already in it finish normally.
   */
  retire(reason: string): void {
    if (this.retired) return;
    this.retired = true;
    dropCurrent(this);
    log(`[CodeMode] sandbox module retired: ${reason}`);
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

let current: QuickJSModuleLease | undefined;
let loading: Promise<QuickJSModuleLease | undefined> | undefined;
/** Set when the packages cannot be imported at all: no retry in this process. */
let unavailable: string | undefined;

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
    return new QuickJSModuleLease(module);
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

/** Whether a sandbox can run in this process (loads the module on first call). */
export async function isSandboxAvailable(): Promise<boolean> {
  return (await loadQuickJSModule()) !== undefined;
}
