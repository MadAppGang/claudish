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
import {
  type HooksConfig,
  hooksConfigDir,
  parseHooksConfig,
  reportBehaviorBlock,
  reportProjectHooks,
} from "./config.js";
import { HookEngine } from "./engine.js";
import { loadUserHooks } from "./loader.js";
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

async function buildEngine(hostMode: HostMode): Promise<HookEngine> {
  let raw: { hooks?: unknown; behavior?: unknown } = {};
  try {
    raw = loadConfig();
  } catch (err) {
    log(`[hooks] config unreadable, built-in hooks only: ${errorText(err)}`);
  }

  const config: HooksConfig = parseHooksConfig(raw.hooks);
  reportBehaviorBlock(raw.behavior);
  reportProjectHooks();

  let users: UserHookInput[] = [];
  try {
    const loaded = await loadUserHooks({
      modules: config.modules,
      configDir: hooksConfigDir(),
      hostMode,
    });
    users = loaded.hooks;
  } catch (err) {
    // The loader reports per module and does not throw; this guards the
    // promise contract against anything it did not anticipate.
    log(`[hooks] user hook loading failed, built-in hooks only: ${errorText(err)}`);
  }

  const builtins = builtinHooks(config);
  const engine = new HookEngine({
    registry: new HookRegistry(builtins, users, config.severity),
    config,
    hostMode,
  });
  log(
    `[hooks] engine ready (host ${hostMode}): ${builtins.length} built-in, ${users.length} user hook(s)`
  );
  return engine;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
