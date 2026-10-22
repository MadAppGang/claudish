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
 * Write strategy — RAW read-modify-write for BOTH scopes (the global one inside
 * `withRawConfigTransaction`, the lock account management writes under):
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
import { withRawConfigTransaction } from "../auth/accounts/config-lock.js";
import { activeOpConfigPaths } from "../config-override.js";
import {
  type OpEntryValueKey,
  type OpSourceEntry,
  dedupeOpSourceEntries,
  parseOpSourceEntries,
  serializeOpSourceEntry,
} from "./op-source-entry.js";

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

/** The real-filesystem paths (no override applied). */
const realOpConfigPaths: OpConfigPaths = {
  global: () => join(homedir(), ".claudish", "config.json"),
  // cwd-relative, re-evaluated per call. Deterministic at cwd (not walk-up) so a
  // `claudish config` save lands where the user runs it. Walk-up resolution
  // lives in profile-config.ts's getLocalConfigPath for the runtime read side.
  project: () => join(process.cwd(), ".claudish.json"),
};

/**
 * The default paths used in production, wrapped so an active `--config` override
 * replaces BOTH scopes: global → the override file, project → suppressed. With
 * no override active this is byte-for-byte the real paths above, so every normal
 * run is unaffected. This makes EVERY reader that uses the defaults —
 * `readAllOnepasswordEnvironments` (env hydration + the hasOpSources sniff) and
 * `readOnepasswordAccount` (DesktopAuth account resolution) — honor the override
 * with no per-call-site threading. Tests pass explicit `paths` and bypass this.
 */
export const defaultOpConfigPaths: OpConfigPaths = {
  global: () => activeOpConfigPaths(realOpConfigPaths).global(),
  project: () => activeOpConfigPaths(realOpConfigPaths).project(),
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
  // Under a `--config` override the project scope is suppressed (empty path).
  // Raise the intent instead of letting writeFileSync("") surface a bare ENOENT
  // in the TUI — the override IS the config, so there is no project file to
  // write to.
  if (path === "") {
    throw new Error(
      "Cannot save to project scope while --config/CLAUDISH_CONFIG is active — " +
        "the override file is the only config for this run. Save to global scope " +
        "(which writes to the override file), or re-run without --config."
    );
  }
  if (scope === "global") {
    // The global file also holds `subscriptionAccounts`, which account
    // management rewrites under the config lock. A raw write here could restore
    // a removed account (or lose an added one), and turned a garbled file into
    // `{}`; the transaction re-reads under the lock, refuses a garbled file and
    // writes atomically.
    withRawConfigTransaction(path, (raw) => {
      mutate(raw);
      return { config: raw, result: undefined };
    });
    return;
  }
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
export function readOnepasswordAccount(
  paths: OpConfigPaths = defaultOpConfigPaths
): string | undefined {
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
  // Entries may be bare strings or `{ id|ref, account }` objects. Both yield the
  // same VALUE here, so declaring an account cannot make an entry disappear from
  // callers that only care about the value — which is most of them.
  const valueKey: OpEntryValueKey = key === "onepassword" ? "ref" : "id";
  return parseOpSourceEntries(cfg[key], valueKey).map((e) => e.value);
}

/**
 * Add an entry to a string[] config field at a scope (idempotent — a duplicate
 * value is not added twice). Trims the entry; an empty entry is a no-op.
 */
function addToStringList(
  scope: OpConfigScope,
  key: string,
  entry: string,
  paths: OpConfigPaths,
  account?: string
): void {
  const value = entry.trim();
  if (!value) return;
  const valueKey: OpEntryValueKey = key === "onepassword" ? "ref" : "id";
  const declared = account?.trim();
  mutateConfig(scope, paths, (cfg) => {
    // Read through the entry parser so existing OBJECT entries survive an add.
    // The old string-only filter silently dropped them, which would have deleted
    // every account declaration the moment the user added one more source.
    const existing = parseOpSourceEntries(cfg[key], valueKey);
    const match = existing.find((e) => e.value === value);
    if (match) {
      // Idempotent, but a later add carrying an account UPGRADES an entry that
      // had none — that is how a legacy bare entry acquires its account without
      // the user hand-editing config.
      if (declared && !match.account) match.account = declared;
    } else {
      existing.push(declared ? { value, account: declared } : { value });
    }
    cfg[key] = existing.map((e) => serializeOpSourceEntry(e, valueKey));
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
  if (!value) return;
  const valueKey: OpEntryValueKey = key === "onepassword" ? "ref" : "id";
  mutateConfig(scope, paths, (cfg) => {
    // Parser-based for the same reason as the add path: a string-only filter
    // would delete every object entry as a side effect of removing one item.
    const kept = parseOpSourceEntries(cfg[key], valueKey).filter((e) => e.value !== value);
    // Emptying the list DELETES the key rather than leaving `[]` behind, so
    // removing the last entry restores the config to the shape it had before
    // the feature was ever used. Pinned by an existing test, which is what
    // caught this when the entry-aware rewrite first dropped the behaviour.
    if (kept.length === 0) delete cfg[key];
    else cfg[key] = kept.map((e) => serializeOpSourceEntry(e, valueKey));
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
  paths: OpConfigPaths = defaultOpConfigPaths,
  account?: string
): void {
  addToStringList(scope, "onepassword", entry, paths, account);
}

/** Remove an op:// ref or glob from `onepassword[]` at a scope. */
export function removeOnepasswordImport(
  entry: string,
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  removeFromStringList(scope, "onepassword", entry, paths);
}

// ───────────────────────────────────────────────────────────────────────────
// Entry-aware readers (account per source)
//
// The string readers above are kept verbatim: every existing caller that only
// wants the value keeps working, and adding an account to one entry cannot
// change what those callers see. The readers below expose the account too.
// ───────────────────────────────────────────────────────────────────────────

function readEntryList(
  scope: OpConfigScope,
  key: string,
  valueKey: OpEntryValueKey,
  paths: OpConfigPaths
): OpSourceEntry[] {
  const cfg = readRawConfig(pathFor(scope, paths));
  return parseOpSourceEntries(cfg[key], valueKey);
}

/** `onepassword[]` at a scope, with any declared account. */
export function listOnepasswordImportEntries(
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): OpSourceEntry[] {
  return readEntryList(scope, "onepassword", "ref", paths);
}

/** `onepasswordEnvironments[]` at a scope, with any declared account. */
export function listOnepasswordEnvironmentEntries(
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): OpSourceEntry[] {
  return readEntryList(scope, "onepasswordEnvironments", "id", paths);
}

/**
 * Both scopes, deduped by value, project first — the entry-aware counterpart of
 * `readAllOnepasswordEnvironments`. Project precedence means a project entry can
 * re-point an environment at a different account than the global config says.
 */
export function readAllOnepasswordEnvironmentEntries(
  paths: OpConfigPaths = defaultOpConfigPaths
): OpSourceEntry[] {
  return dedupeOpSourceEntries([
    ...listOnepasswordEnvironmentEntries("project", paths),
    ...listOnepasswordEnvironmentEntries("global", paths),
  ]);
}

/** Both scopes, deduped by value, project first. */
export function readAllOnepasswordImportEntries(
  paths: OpConfigPaths = defaultOpConfigPaths
): OpSourceEntry[] {
  return dedupeOpSourceEntries([
    ...listOnepasswordImportEntries("project", paths),
    ...listOnepasswordImportEntries("global", paths),
  ]);
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
  paths: OpConfigPaths = defaultOpConfigPaths,
  account?: string
): void {
  addToStringList(scope, "onepasswordEnvironments", id, paths, account);
}

/** Remove an Environment ID from `onepasswordEnvironments[]` at a scope. */
export function removeOnepasswordEnvironment(
  id: string,
  scope: OpConfigScope,
  paths: OpConfigPaths = defaultOpConfigPaths
): void {
  removeFromStringList(scope, "onepasswordEnvironments", id, paths);
}
