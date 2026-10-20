/**
 * The hook engine of this process: loaded once, from the global config.
 *
 * `loadHooksOnce()` is one memoised promise per process. It reads `hooks` from
 * the global config, reports a pre-hook-system `behavior` block and a project
 * `hooks` key (both ignored), loads the user modules, and builds the registry
 * (built-ins first) and the engine. Every failure degrades — a broken hook
 * module or a malformed `hooks` block warns and is skipped; the promise never
 * rejects, because claudish must always start.
 *
 * The host mode of the FIRST call wins: one process is one host. Callers:
 * `createProxyServer` (awaited before any handler is built, so no handler sees a
 * half-loaded registry) and the MCP server entry (started in the background
 * right after protocol stdout is isolated).
 */

import { log } from "../logger.js";
import { loadConfig } from "../profile-config.js";
import { builtinHooks } from "./builtins/index.js";
import { type HooksConfig, type WarnSink, hooksConfigDir, readHooksConfig } from "./config.js";
import { HookEngine } from "./engine.js";
import { type LoadError, loadUserHooks } from "./loader.js";
import type { HostMode } from "./public.js";
import { HookRegistry, type UserHookInput } from "./registry.js";

let enginePromise: Promise<HookEngine> | null = null;
let loadedEngine: HookEngine | null = null;

export interface LoadHooksOptions {
  /** This process's host. Default `"other"`. Only the first call's value is used. */
  hostMode?: HostMode;
}

/** The process's hook engine, loaded on first call. Never rejects. */
export function loadHooksOnce(opts: LoadHooksOptions = {}): Promise<HookEngine> {
  if (!enginePromise) {
    enginePromise = buildEngine(opts.hostMode ?? "other").then((engine) => {
      loadedEngine = engine;
      return engine;
    });
  }
  return enginePromise;
}

/** The engine once `loadHooksOnce()` has resolved; null before. */
export function getHookEngine(): HookEngine | null {
  return loadedEngine;
}

/** Test seam: forget the memoised engine so the next call loads again. */
export function resetHookEngineForTests(): void {
  enginePromise = null;
  loadedEngine = null;
}

/** What one load of the hook configuration produced, before an engine is built on it. */
export interface HookSet {
  config: HooksConfig;
  registry: HookRegistry;
  /** Modules or exports that were skipped, and why. */
  errors: LoadError[];
  /** A pre-hook-system `behavior` block is present in the global config. */
  behaviorConfigFound: boolean;
}

export interface LoadHookSetOptions {
  hostMode: HostMode;
  /** Where the config-load reporters write (`readHooksConfig`). Default: stderr. */
  warn?: WarnSink;
  /**
   * Where per-module load warnings go. Default: `warn`. `claudish hooks list` drops
   * them, because each one is also in `errors`, which it prints.
   */
  moduleWarn?: WarnSink;
}

/**
 * Read the global config's `hooks`, report what is no longer read, load the user
 * modules and build the registry (built-ins first). Never throws.
 */
export async function loadHookSet(opts: LoadHookSetOptions): Promise<HookSet> {
  let raw: { hooks?: unknown; behavior?: unknown } = {};
  try {
    raw = loadConfig();
  } catch (err) {
    log(`[hooks] config unreadable, built-in hooks only: ${errorText(err)}`);
  }

  const config: HooksConfig = readHooksConfig(raw, opts.warn);

  let users: UserHookInput[] = [];
  let errors: LoadError[] = [];
  try {
    const loaded = await loadUserHooks({
      modules: config.modules,
      configDir: hooksConfigDir(),
      hostMode: opts.hostMode,
      warn: opts.moduleWarn ?? opts.warn,
    });
    users = loaded.hooks;
    errors = loaded.errors;
  } catch (err) {
    // The loader reports per module and does not throw; this guards the
    // promise contract against anything it did not anticipate.
    log(`[hooks] user hook loading failed, built-in hooks only: ${errorText(err)}`);
  }

  return {
    config,
    registry: new HookRegistry(builtinHooks(config), users, config.severity),
    errors,
    behaviorConfigFound: raw.behavior !== undefined && raw.behavior !== null,
  };
}

async function buildEngine(hostMode: HostMode): Promise<HookEngine> {
  const set = await loadHookSet({ hostMode });
  const engine = new HookEngine({ registry: set.registry, config: set.config, hostMode });
  const users = set.registry.hooks.filter((h) => h.source === "user").length;
  log(
    `[hooks] engine ready (host ${hostMode}): ${set.registry.hooks.length - users} built-in, ${users} user hook(s)`
  );
  return engine;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
