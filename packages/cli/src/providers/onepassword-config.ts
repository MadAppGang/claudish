/**
 * Scope-aware 1Password CONFIG persistence — the glue between the TUI / CLI and
 * the `~/.claudish/config.json` (global) + `./.claudish.json` (project) files.
 *
 * This module is config-only: it reads and writes the three 1Password-related
 * config fields and never touches the SDK, a secret, or the `op` binary. The
 * heavy SDK engine (resolve / discover / environments / auth) lives in
 * `onepassword.ts`; keep them separate so importing the persistence helpers
 * (e.g. from the TUI) never risks pulling in the WASM.
 *
 * Fields managed:
 *  - `onepasswordAccount?: string`        — the DesktopAuth account URL.
 *  - `onepassword?: string[]`             — single op:// refs + glob imports.
 *  - `onepasswordEnvironments?: string[]` — 1Password Environment IDs.
 *
 * Scope model:
 *  - "global"  → ~/.claudish/config.json   (all projects).
 *  - "project" → ./.claudish.json          (this project; overrides global on read).
 *
 * Write strategy — RAW read-modify-write for BOTH scopes:
 *  - Each write reads the target JSON file, mutates ONLY the field in question,
 *    and writes it back. Every other key is preserved byte-for-faithful. This is
 *    the same approach index.ts's original project-scope saveOnepasswordAccount
 *    used, generalized to global too. We deliberately do NOT route global writes
 *    through profile-config.ts's loadConfig/saveConfig: that would couple this
 *    module to profile-config's module-level CONFIG_FILE constant (computed from
 *    a CACHED homedir() that ignores $HOME reassignment), making the global path
 *    impossible to test hermetically. A raw merge is just as safe — it never
 *    drops fields — and keeps the whole module synchronous + injectable.
 *
 * NOTE: the `onepasswordEnvironments` field is still added to profile-config's
 * loadConfig allowlist separately, so OTHER consumers that go through
 * loadConfig()→saveConfig() (e.g. the TUI's refreshConfig) preserve it too.
 *
 * Reads use a local-then-global precedence (local wins), matching how index.ts
 * and profile-config resolve 1Password settings at runtime.
 *
 * Test seam: every public function takes an optional `paths` override so tests
 * can point global/project at temp files (homedir() can't be re-pointed at
 * runtime in Bun). Production omits it and uses the real paths.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The scope a 1Password config entry is written to / read from. */
export type OpConfigScope = "global" | "project";

/**
 * Injectable config-file paths. Defaults resolve the real global
 * (~/.claudish/config.json) and project (./.claudish.json) files; tests pass
 * temp paths. `global`/`project` are functions so the project path can stay
 * cwd-relative (re-evaluated per call) in production.
 */
export interface OpConfigPaths {
  global: () => string;
  project: () => string;
}

/** The real-filesystem default paths used in production. */
export const defaultOpConfigPaths: OpConfigPaths = {
  global: () => join(homedir(), ".claudish", "config.json"),
  // cwd-relative, re-evaluated per call. Deterministic at cwd (not walk-up) so a
  // `claudish config` save lands where the user runs it. Walk-up resolution
  // lives in profile-config.ts's getLocalConfigPath for the runtime read side.
  project: () => join(process.cwd(), ".claudish.json"),
};

function pathFor(scope: OpConfigScope, paths: OpConfigPaths): string {
  return scope === "project" ? paths.project() : paths.global();
}

/** Safely parse a JSON config file into an object, or {} on any failure. */
function readRawConfig(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Garbled/unreadable file → treat as empty rather than crash.
    return {};
  }
}

/**
 * Raw read-modify-write of a scope's config file. Preserves every existing key,
 * mutating only via `mutate`, so an account/imports-only file is never pruned.
 */
function mutateConfig(
  scope: OpConfigScope,
  paths: OpConfigPaths,
  mutate: (cfg: Record<string, unknown>) => void
): void {
  const path = pathFor(scope, paths);
  const cfg = readRawConfig(path);
  mutate(cfg);
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
}

// ===========================================================================
// Account (onepasswordAccount)
// ===========================================================================

/**
 * Read the configured 1Password account URL: local `.claudish.json` first, then
 * global `~/.claudish/config.json` (local wins). Returns the trimmed URL, or
 * undefined when neither file sets a non-empty value. Raw fs — no SDK.
 */
export function readOnepasswordAccount(paths: OpConfigPaths = defaultOpConfigPaths): string | undefined {
  for (const scope of ["project", "global"] as const) {
    const cfg = readRawConfig(pathFor(scope, paths));
    const acct = cfg.onepasswordAccount;
    if (typeof acct === "string" && acct.trim()) return acct.trim();
  }
  return undefined;
}

/**
 * Read the 1Password account set at a SPECIFIC scope (no cross-scope fallback).
 * Useful for the TUI to show "global: X / project: Y" independently.
 */
export function readOnepasswordAccountForScope(
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): string | undefined {
  const cfg = readRawConfig(pathFor(scope, paths));
  const acct = cfg.onepasswordAccount;
  return typeof acct === "string" && acct.trim() ? acct.trim() : undefined;
}

/** Persist the 1Password account URL at the given scope. */
export function saveOnepasswordAccount(
  accountUrl: string,
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  const url = accountUrl.trim();
  mutateConfig(scope, paths, (cfg) => {
    cfg.onepasswordAccount = url;
  });
}

/** Remove the 1Password account at the given scope. */
export function clearOnepasswordAccount(
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  mutateConfig(scope, paths, (cfg) => {
    delete cfg.onepasswordAccount;
  });
}

// ===========================================================================
// Generic string[] list helpers (shared by imports + environments)
// ===========================================================================

/** Read a string[] config field at a scope, returning a clean (string) array. */
function readStringList(scope: OpConfigScope, key: string, paths: OpConfigPaths): string[] {
  const cfg = readRawConfig(pathFor(scope, paths));
  const raw = cfg[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Add an entry to a string[] config field at a scope (idempotent — a duplicate
 * value is not added twice). Trims the entry; an empty entry is a no-op.
 */
function addToStringList(scope: OpConfigScope, key: string, entry: string, paths: OpConfigPaths): void {
  const value = entry.trim();
  if (!value) return;
  mutateConfig(scope, paths, (cfg) => {
    const list = Array.isArray(cfg[key])
      ? (cfg[key] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    if (!list.includes(value)) list.push(value);
    cfg[key] = list;
  });
}

/**
 * Remove an entry from a string[] config field at a scope. When the resulting
 * list is empty the key is deleted (keeps the file tidy).
 */
function removeFromStringList(
  scope: OpConfigScope,
  key: string,
  entry: string,
  paths: OpConfigPaths
): void {
  const value = entry.trim();
  mutateConfig(scope, paths, (cfg) => {
    const list = Array.isArray(cfg[key])
      ? (cfg[key] as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const next = list.filter((v) => v !== value);
    if (next.length === 0) delete cfg[key];
    else cfg[key] = next;
  });
}

// ===========================================================================
// Imports (onepassword[]) — single op:// refs + glob imports
// ===========================================================================

/** List the `onepassword[]` entries at a scope (refs + globs, verbatim). */
export function listOnepasswordImports(
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): string[] {
  return readStringList(scope, "onepassword", paths);
}

/** Add an op:// ref or glob to `onepassword[]` at a scope (idempotent). */
export function addOnepasswordImport(
  entry: string,
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  addToStringList(scope, "onepassword", entry, paths);
}

/** Remove an op:// ref or glob from `onepassword[]` at a scope. */
export function removeOnepasswordImport(
  entry: string,
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  removeFromStringList(scope, "onepassword", entry, paths);
}

// ===========================================================================
// Environments (onepasswordEnvironments[])
// ===========================================================================

/** List the `onepasswordEnvironments[]` entries (environment IDs) at a scope. */
export function listOnepasswordEnvironments(
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): string[] {
  return readStringList(scope, "onepasswordEnvironments", paths);
}

/**
 * Read environment IDs from BOTH scopes, deduped, for startup consumption.
 * Project entries are listed first (they take read precedence), then global
 * entries not already present. Used by index.ts to hydrate at launch.
 */
export function readAllOnepasswordEnvironments(
  paths: OpConfigPaths = defaultOpConfigPaths
): string[] {
  const project = listOnepasswordEnvironments("project", paths);
  const global = listOnepasswordEnvironments("global", paths);
  const seen = new Set(project);
  const out = [...project];
  for (const id of global) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Add an Environment ID to `onepasswordEnvironments[]` at a scope (idempotent). */
export function addOnepasswordEnvironment(
  id: string,
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  addToStringList(scope, "onepasswordEnvironments", id, paths);
}

/** Remove an Environment ID from `onepasswordEnvironments[]` at a scope. */
export function removeOnepasswordEnvironment(
  id: string,
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  removeFromStringList(scope, "onepasswordEnvironments", id, paths);
}
