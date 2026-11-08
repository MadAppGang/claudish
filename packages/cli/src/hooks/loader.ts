/**
 * User hook module loading.
 *
 * Resolves each `hooks.modules` path, imports it with a load timeout inside the
 * hook output scope, checks the default export's shape, and returns the hooks
 * with namespaced ids. Everything here is non-fatal: a module that fails to
 * import, times out, has the wrong shape or throws produces one stderr warning
 * naming the module and the reason, and is skipped. claudish always starts —
 * least of all should a broken hook stop it when the user is starting it in
 * order to fix that hook.
 *
 * Before the first user import, the `claudish/hooks` virtual module is
 * registered as a Bun runtime plugin answering with the HOST's own public
 * exports, so `import { defineHook, act } from "claudish/hooks"` needs nothing
 * installed. It must come first: under plain `bun` (the npm route) an
 * unresolved bare import would otherwise trigger npm auto-install (measured in
 * P1), and once claudish exports `./hooks` on npm it would resolve to a copy
 * other than the host's. `import type` needs no runtime resolution at all.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logStderr } from "../logger.js";
import type { WarnSink } from "./config.js";
import { protocolIsolation, runImportInScope } from "./output-capture.js";
import * as publicApi from "./public.js";
import type { HookDefinition, HostMode } from "./public.js";
import type { UserHookInput } from "./registry.js";

/** How long one module import may take. */
export const LOAD_TIMEOUT_MS = 10_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)*$/;
const MAX_ID_LENGTH = 64;

const ON_FUNCTION_KEYS = [
  "request",
  "responseEnd",
  "sessionStart",
  "sessionIdle",
  "sessionBlocked",
  "sessionEnd",
] as const;
const ON_KEYS = new Set<string>([...ON_FUNCTION_KEYS, "toolCall", "responseRewrite"]);
const RAW_KEYS = new Set(["providerRequest", "providerChunk", "providerStreamEnd", "response"]);
const SEVERITIES = new Set(["off", "warn", "fix"]);
const ORDERS = new Set(["pre", "normal", "post"]);
const ROUTES = new Set(["foreign", "native", "all"]);

export const MCP_NO_ISOLATION_LINE =
  "hook modules not loaded by the MCP server: this platform cannot keep hook output off the MCP protocol stream";

export interface LoadError {
  /** The module path as configured. */
  module: string;
  reason: string;
}

export interface LoadResult {
  hooks: UserHookInput[];
  errors: LoadError[];
}

export interface LoadOptions {
  /** `hooks.modules`, in order. */
  modules: ReadonlyArray<string> | undefined;
  /** Directory relative paths resolve against: the active config file's. */
  configDir: string;
  hostMode: HostMode;
  /** Defaults to LOAD_TIMEOUT_MS; tests shorten it. */
  loadTimeoutMs?: number;
  /** Defaults to stderr through `logStderr`. */
  warn?: WarnSink;
}

/* ───────────── virtual module ───────────── */

let virtualModuleRegistered = false;

/**
 * Register `claudish/hooks` → the host's own public exports. Idempotent; runs
 * before the first user import.
 */
export function registerHooksVirtualModule(): void {
  if (virtualModuleRegistered) return;
  virtualModuleRegistered = true;
  const exports = {
    HOOK_API_VERSION: publicApi.HOOK_API_VERSION,
    defineHook: publicApi.defineHook,
    act: publicApi.act,
  };
  Bun.plugin({
    name: "claudish-hooks-virtual-module",
    setup(build) {
      build.module("claudish/hooks", () => ({ exports, loader: "object" }));
    },
  });
}

/* ───────────── paths ───────────── */

/** Absolute, `~` / `~/…`, or relative to the config file's directory. */
export function resolveModulePath(raw: string, configDir: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(configDir, raw);
}

/** A module's name in hook ids: its basename without the extension. */
export function moduleName(absPath: string): string {
  const base = basename(absPath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/* ───────────── shape check ───────────── */

function isFn(v: unknown): v is (...a: unknown[]) => unknown {
  return typeof v === "function";
}

function isAsyncFunction(v: unknown): boolean {
  return (
    isFn(v) && (v as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction"
  );
}

/**
 * Check one exported definition. Returns the reason it is rejected, or null.
 * The apiVersion check comes first and has its own exact message.
 */
function definitionProblem(def: Record<string, unknown>): string | null {
  if (typeof def.id !== "string" || def.id.length === 0) return "id is missing";
  if (def.id.length > MAX_ID_LENGTH) return `id is longer than ${MAX_ID_LENGTH} characters`;
  if (!ID_PATTERN.test(def.id)) return `id "${def.id}" does not match ${ID_PATTERN.source}`;
  if (def.description !== undefined && typeof def.description !== "string") {
    return "description must be a string";
  }
  if (def.defaultSeverity !== undefined && !SEVERITIES.has(def.defaultSeverity as string)) {
    return 'defaultSeverity must be "off", "warn" or "fix"';
  }
  if (def.order !== undefined && !ORDERS.has(def.order as string)) {
    return 'order must be "pre", "normal" or "post"';
  }
  if (def.routes !== undefined && !ROUTES.has(def.routes as string)) {
    return 'routes must be "foreign", "native" or "all"';
  }
  if (def.models !== undefined) {
    const ok =
      (typeof def.models === "string" && def.models.length > 0) ||
      (Array.isArray(def.models) &&
        def.models.length > 0 &&
        def.models.every((m) => typeof m === "string" && m.length > 0));
    if (!ok) return "models must be a glob string or a non-empty array of glob strings";
  }
  if (
    def.timeoutMs !== undefined &&
    (typeof def.timeoutMs !== "number" || !Number.isFinite(def.timeoutMs) || def.timeoutMs <= 0)
  ) {
    return "timeoutMs must be a positive number";
  }

  let handlers = 0;
  if (def.on !== undefined) {
    if (!def.on || typeof def.on !== "object" || Array.isArray(def.on)) {
      return "on must be an object";
    }
    const on = def.on as Record<string, unknown>;
    for (const key of Object.keys(on)) {
      if (on[key] === undefined) continue;
      if (!ON_KEYS.has(key)) return `on.${key} is not a hook event`;
      handlers++;
    }
    for (const key of ON_FUNCTION_KEYS) {
      if (on[key] !== undefined && !isFn(on[key])) return `on.${key} must be a function`;
    }
    if (on.toolCall !== undefined) {
      const tc = on.toolCall as Record<string, unknown>;
      if (!tc || typeof tc !== "object") return "on.toolCall must be an object";
      if (
        !Array.isArray(tc.tools) ||
        tc.tools.length === 0 ||
        !tc.tools.every((t) => typeof t === "string" && t.length > 0)
      ) {
        return "on.toolCall.tools must be a non-empty array of tool names";
      }
      if (!isFn(tc.handle)) return "on.toolCall.handle must be a function";
      if (tc.armed !== undefined && !isFn(tc.armed)) return "on.toolCall.armed must be a function";
      if (tc.observe !== undefined && typeof tc.observe !== "boolean") {
        return "on.toolCall.observe must be a boolean";
      }
    }
    if (on.responseRewrite !== undefined) {
      const rr = on.responseRewrite as Record<string, unknown>;
      if (!rr || typeof rr !== "object") return "on.responseRewrite must be an object";
      if (!isFn(rr.handle)) return "on.responseRewrite.handle must be a function";
      if (rr.claims !== undefined && !isFn(rr.claims)) {
        return "on.responseRewrite.claims must be a function";
      }
    }
  }

  if (def.raw !== undefined) {
    if (def.unsafe !== true) return "raw requires unsafe: true";
    if (!def.raw || typeof def.raw !== "object" || Array.isArray(def.raw)) {
      return "raw must be an object";
    }
    const raw = def.raw as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (raw[key] === undefined) continue;
      if (!RAW_KEYS.has(key)) return `raw.${key} is not a raw stage`;
      if (!isFn(raw[key])) return `raw.${key} must be a function`;
      handlers++;
    }
    if (isAsyncFunction(raw.providerChunk)) {
      return "raw.providerChunk must be synchronous (it runs on the parser's loop)";
    }
  } else if (def.unsafe !== undefined && def.unsafe !== true) {
    return "unsafe must be true or absent";
  }

  if (handlers === 0) return "declares no handler in on or raw";
  return null;
}

/* ───────────── loading ───────────── */

let mcpRefusalPrinted = false;

/** Race an import against the load timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`load timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load every configured user module, in order.
 *
 * In host mode `mcp`, user modules load only when `isolateProtocolStdout()` is
 * active: without descriptor isolation, nothing can keep a hook's output off
 * the JSON-RPC stream, so the MCP server runs built-in hooks only and says so
 * once per process.
 */
export async function loadUserHooks(opts: LoadOptions): Promise<LoadResult> {
  const warn = opts.warn ?? ((line: string) => logStderr(line));
  const modules = opts.modules ?? [];
  const result: LoadResult = { hooks: [], errors: [] };
  if (modules.length === 0) return result;

  if (opts.hostMode === "mcp" && protocolIsolation()?.active !== true) {
    if (!mcpRefusalPrinted) {
      mcpRefusalPrinted = true;
      warn(MCP_NO_ISOLATION_LINE);
    }
    return result;
  }

  registerHooksVirtualModule();
  const timeoutMs = opts.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
  const byName = new Map<string, string>();

  for (const [moduleIndex, configured] of modules.entries()) {
    const abs = resolveModulePath(configured, opts.configDir);
    const name = moduleName(abs);
    const fail = (reason: string, line: string) => {
      result.errors.push({ module: configured, reason });
      warn(line);
    };

    const earlier = byName.get(name);
    if (earlier !== undefined) {
      fail(
        `its name "${name}" is already used by ${earlier}`,
        `hook module ${configured} skipped: its name "${name}" is already used by ${earlier}; rename one`
      );
      continue;
    }
    byName.set(name, configured);

    let mod: Record<string, unknown>;
    try {
      mod = (await runImportInScope(configured, () =>
        withTimeout(import(pathToFileURL(abs).href), timeoutMs)
      )) as Record<string, unknown>;
    } catch (err) {
      const reason = errorText(err);
      fail(reason, `hook module ${configured} skipped: ${reason}`);
      continue;
    }

    const exported = mod?.default;
    if (exported === undefined) {
      fail("no default export", `hook module ${configured} skipped: no default export`);
      continue;
    }
    const defs = Array.isArray(exported) ? exported : [exported];
    const seen = new Set<string>();

    for (const [exportIndex, candidate] of defs.entries()) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        fail(
          `export #${exportIndex} is not a hook definition`,
          `hook module ${configured} skipped export #${exportIndex}: not a hook definition`
        );
        continue;
      }
      const def = candidate as Record<string, unknown>;
      const label = typeof def.id === "string" && def.id.length > 0 ? def.id : `#${exportIndex}`;
      const reject = (reason: string) =>
        fail(`${label}: ${reason}`, `hook ${configured}#${label}: ${reason}`);

      if (def.apiVersion !== publicApi.HOOK_API_VERSION) {
        reject(
          `apiVersion ${String(def.apiVersion)} is not supported (this claudish supports ${publicApi.HOOK_API_VERSION})`
        );
        continue;
      }
      const problem = definitionProblem(def);
      if (problem) {
        reject(problem);
        continue;
      }

      const id = `hook:${name}/${def.id as string}`;
      if (seen.has(id)) {
        warn(`hook ${configured}#${label}: duplicate id ${id}, keeping the first`);
        result.errors.push({ module: configured, reason: `${label}: duplicate id ${id}` });
        continue;
      }
      seen.add(id);

      if (def.unsafe === true) {
        warn(
          `hook ${id} is UNSAFE (raw middleware): it receives live request and response objects`
        );
      }
      result.hooks.push({
        id,
        module: abs,
        moduleIndex,
        exportIndex,
        def: candidate as unknown as HookDefinition,
      });
    }
  }
  return result;
}

/** Test seam: let the once-per-process `mcp` refusal line print again. */
export function resetLoaderForTests(): void {
  mcpRefusalPrinted = false;
}
