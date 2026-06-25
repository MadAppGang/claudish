/**
 * Native 1Password integration for claudish.
 *
 * Self-contained, dependency-light module: this is imported by index.ts which
 * runs BEFORE heavy dependencies are loaded. Use ONLY node built-ins (and
 * node:child_process spawnSync, used SOLELY for the optional read-only
 * `op account list` account picker — never for a secret) at module load time.
 * The 1Password SDK is imported DYNAMICALLY (await import) and ONLY when SDK
 * auth is actually available and a secret/field/environment is needed — so a
 * normal claudish run never pulls in the ~10MB SDK + WASM. Do not import zod,
 * hono, the provider registry, or anything else from the proxy stack here.
 *
 * Resolution model (v7.6.0+): SDK-ONLY.
 *  - ALL secret operations — resolving op:// references, discovering an item's
 *    fields for a glob import, and reading 1Password Environments — go through
 *    the official @1password/sdk (beta 0.4.1+, which has the environments API).
 *  - Auth is EITHER a service-account token (OP_SERVICE_ACCOUNT_TOKEN, headless)
 *    OR DesktopAuth using an account name (OP_ACCOUNT / onepasswordAccount config
 *    / a single auto-detected account / an interactively-picked account). The SDK
 *    cannot reuse an interactive `op signin` session, so an `op signin`-only
 *    setup must now set OP_ACCOUNT (DesktopAuth) or a token.
 *  - The ONE remaining `op` binary touch is an OPTIONAL, read-only
 *    `op account list --format=json` used SOLELY to populate the multi-account
 *    picker (it never sees a secret and degrades gracefully when `op` is absent).
 *
 * Entry points (all ASYNC, all SDK-backed):
 *  - resolveSecrets(): batch-resolve { envVar: "op://..." } → { envVar: value }.
 *  - readEnvironment(): read a named 1Password Environment → { name: value }.
 *  - discoverItemFields() / resolveGlobImport(): glob field import (names-first
 *    discovery, then value resolution).
 *  - resolveSdkAuth(): the orchestrated auth resolver (token → OP_ACCOUNT →
 *    config account → single auto-detect → interactive picker → hard-fail).
 *
 * CRITICAL behaviors enforced here:
 *  - Everything stays in-memory. Nothing is written to disk.
 *  - Failures HARD FAIL (the caller calls process.exit(1)) because 1Password
 *    usage here is always explicit opt-in (an `op://` ref or `--op-env`).
 *  - No SDK auth → hard-fail with an actionable error (no `op` CLI fallback).
 */

import { spawnSync } from "node:child_process";
import { VERSION } from "../version.js";

/** Matches a full `op://...` secret reference (no embedded whitespace). */
export const OP_REF_RE = /^op:\/\/[^\s]+$/;

/** True when the given string is a 1Password secret reference. */
export function isOpReference(v: string): boolean {
  return typeof v === "string" && OP_REF_RE.test(v);
}

/** Build the standard actionable auth-failure error. */
export function buildAuthError(detail: string): Error {
  return new Error(
    `${detail}\n` +
      "Set OP_SERVICE_ACCOUNT_TOKEN (service account, headless) or OP_ACCOUNT " +
      "(your 1Password account URL, e.g. my-team.1password.com) for the desktop " +
      "app — or set `onepasswordAccount` in ~/.claudish/config.json."
  );
}

/** Return a masked preview of a secret for safe logging: first 4 chars + "…". */
export function maskSecret(v: string): string {
  if (!v) return "";
  return `${v.slice(0, 4)}…`;
}

// ===========================================================================
// Glob field import (v7.7.0+)
//
// `op://` itself rejects `*` ("invalid character in secret reference"), so a
// glob field import is expanded CLIENT-SIDE: discover field names from ONE
// 1Password item, filter labels/sections by a glob, then resolve only the
// matching fields through the SDK resolve engine. Each matched field's LABEL
// becomes the env var name.
//
// GRAMMAR (segment count after the item determines scope):
//   op://<vault>/<item>/<fieldGlob>               (1 seg)  → match <fieldGlob>
//     against TOP-LEVEL (sectionless) field labels only.
//   op://<vault>/<item>/<sectionGlob>/<fieldGlob> (2 segs) → match fields whose
//     SECTION label matches <sectionGlob>, then filter those by <fieldGlob>.
// A path with NO `*` in the post-item segment(s) is NOT a glob import (the
// single-field op:// path handles it). >2 post-item segments → not supported.
//
// DISCOVERY is now SDK-only (vaults.list → items.list → items.get). The SDK's
// ItemField exposes title/sectionId/fieldType but NO ready-made `reference`, so
// we synthesize each field's op:// reference from the vault/item/section/field
// titles. The SDK decrypts every field value to list field names — that's no
// different from `op item get`, which also decrypts everything in-process. The
// `hasValue` flag we keep records only WHETHER a value is present, never the
// value itself.
// ===========================================================================

/**
 * A discovered 1Password item field — names/metadata + a MASKED value tail.
 *
 * Security note: we deliberately keep NO full value. `valueTail` is only the
 * LAST 4 characters of the value (computed at discovery time, where the SDK has
 * already decrypted everything in-process to list fields) — the standard
 * "•••• 1234" identification pattern (1Password / AWS / Stripe). It lets the
 * user confirm WHICH credential is wired up without exposing the secret. The
 * full value is never stored, returned, or logged.
 */
export interface DiscoveredField {
  /** The field's label, verbatim (may include surrounding whitespace). */
  label: string;
  /** The owning section's label, or null for a top-level (sectionless) field. */
  section: string | null;
  /** The field's full op:// reference (used for value resolution). */
  reference: string;
  /** The field type (CONCEALED, STRING, …). Kept for diagnostics. */
  type: string;
  /** Whether the field has a non-empty value (no value content is kept). */
  hasValue: boolean;
  /** The LAST 4 chars of the value (for "••••1234" display), or "" when none. */
  valueTail: string;
}

/** Last 4 chars of a secret, for masked-tail display (empty for short/empty). */
export function valueTail(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return value.slice(-4);
}

/**
 * True when `opPath` is an `op://...` path AND its post-item segment(s) contain
 * a `*` — i.e. it's a glob field import rather than a single-field reference.
 *
 * Parse: strip `op://`, split on `/` → [vault, item, ...rest]. A glob import has
 * 1 or 2 `rest` segments, at least one of which contains `*`. (>2 rest segments
 * → unsupported → false; the single-field op:// path is left untouched.)
 */
export function isGlobImport(opPath: string): boolean {
  if (typeof opPath !== "string" || !opPath.startsWith("op://")) return false;
  const rest = opPath.slice("op://".length).split("/");
  // rest = [vault, item, ...post]
  if (rest.length < 3) return false; // need at least vault/item/oneSegment
  const post = rest.slice(2);
  if (post.length < 1 || post.length > 2) return false;
  return post.some((seg) => seg.includes("*"));
}

/** Parsed components of a glob field-import path. */
export interface GlobImport {
  vault: string;
  item: string;
  /** null → 1-segment (top-level fields). Non-null → 2-segment section glob. */
  sectionGlob: string | null;
  fieldGlob: string;
  /**
   * true → the whole-item `**` form: match EVERY field regardless of section
   * (sectioned AND sectionless). Purely claudish-side syntax (1Password never
   * sees `*`/`**`), so this is free to define. Set only for a lone single-segment
   * `**`; a 2-segment `**`-on-one-axis is an ordinary glob, not match-all.
   */
  matchAll?: boolean;
}

/**
 * Parse an `op://<vault>/<item>/...` glob path into its components. Assumes
 * isGlobImport(opPath) is true (1 or 2 post-item segments).
 *
 *  - 1 post segment `**` → { sectionGlob: null, fieldGlob: "*", matchAll: true }
 *  - 1 post segment      → { sectionGlob: null, fieldGlob: post[0] }
 *  - 2 post segments     → { sectionGlob: post[0], fieldGlob: post[1] }
 */
export function parseGlobImport(opPath: string): GlobImport {
  const rest = opPath.slice("op://".length).split("/");
  const [vault, item, ...post] = rest;
  if (post.length === 1) {
    if (post[0] === "**") {
      // Whole-item match-all: every field, any section or none.
      return { vault, item, sectionGlob: null, fieldGlob: "*", matchAll: true };
    }
    return { vault, item, sectionGlob: null, fieldGlob: post[0] };
  }
  return { vault, item, sectionGlob: post[0], fieldGlob: post[1] };
}

/**
 * Compile a GLOB (not regex) segment into an anchored, case-sensitive RegExp.
 *  - `*` matches any run of characters (including none).
 *  - Every other regex metacharacter is escaped (treated literally).
 *  - Anchored with ^…$ so the WHOLE segment must match.
 */
export function globToRegExp(glob: string): RegExp {
  // Escape regex metachars EXCEPT `*`, then turn `*` into `.*`.
  let out = "";
  for (const ch of glob) {
    if (ch === "*") {
      out += ".*";
    } else if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Valid POSIX-ish env var name: starts with a letter/underscore, then word chars. */
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Discover all fields of a single 1Password item, returning labels + section
 * labels + synthesized op:// references (NO secret values are kept).
 *
 * SDK path (always used):
 *   vaults.list() → match title===vault → vault ID
 *   items.list(vaultId) → match title===item → item ID
 *   items.get(vaultId, itemId) → fields/sections
 *
 * Duplicate vault/item titles → first match + stderr warning (the SDK gives IDs
 * so the choice is deterministic). The synthesized reference is
 *   op://<vaultTitle>/<itemTitle>/[<sectionTitle>/]<fieldTitle>
 *
 * THROWS (caller hard-fails) when:
 *  - no SDK auth is available
 *  - the vault or item isn't found by title
 *  - the SDK call fails (bad token, expired desktop session, network, …)
 */
export async function discoverItemFields(
  vault: string,
  item: string,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
    /** Override the stderr warn sink (tests capture warnings). */
    warn?: (msg: string) => void;
  } = {}
): Promise<DiscoveredField[]> {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const client = await acquireSdkClient(opts, `1Password item discovery for '${item}'`);

  // 1. Find the vault by title.
  const vaults = await client.vaults.list();
  const vaultMatches = vaults.filter((v) => v.title === vault);
  if (vaultMatches.length === 0) {
    throw new Error(
      `1Password vault '${vault}' not found. ` +
        `Available vaults: ${vaults.map((v) => v.title).join(", ") || "(none)"}.`
    );
  }
  if (vaultMatches.length > 1) {
    warn(
      `[claudish] multiple 1Password vaults titled '${vault}'; using the first ` +
        `(id ${vaultMatches[0].id}).`
    );
  }
  const vaultId = vaultMatches[0].id;

  // 2. Find the item by title within the vault.
  const items = await client.items.list(vaultId);
  const itemMatches = items.filter((i) => i.title === item);
  if (itemMatches.length === 0) {
    throw new Error(
      `1Password item '${item}' not found in vault '${vault}'. ` +
        `Available items: ${items.map((i) => i.title).slice(0, 12).join(", ") || "(none)"}.`
    );
  }
  if (itemMatches.length > 1) {
    warn(
      `[claudish] multiple 1Password items titled '${item}' in vault '${vault}'; ` +
        `using the first (id ${itemMatches[0].id}).`
    );
  }
  const itemId = itemMatches[0].id;

  // 3. Fetch the full item and map fields → DiscoveredField.
  const full = await client.items.get(vaultId, itemId);
  const out: DiscoveredField[] = [];
  for (const field of full.fields) {
    if (typeof field.title !== "string") continue;
    const section = sectionLabel(full, field.sectionId);
    const reference = `op://${vault}/${item}/${section ? `${section}/` : ""}${field.title}`;
    out.push({
      label: field.title,
      section,
      reference,
      type: typeof field.fieldType === "string" ? field.fieldType : String(field.fieldType ?? ""),
      hasValue: !!field.value,
      valueTail: valueTail(field.value),
    });
  }
  return out;
}

/**
 * Like discoverItemFields, but takes the vault/item IDs DIRECTLY — skipping the
 * `vaults.list()` + `items.list()` title-resolution round-trips. The config TUI
 * already has the IDs from its vault/item pickers, so this cuts the field-load
 * from THREE sequential SDK calls to ONE (`items.get`), roughly 3× faster on the
 * desktop-app IPC path. `vaultTitle`/`itemTitle` are only used to synthesize the
 * `op://` reference strings (which are title-based). THROWS on no-auth / failure.
 */
export async function discoverItemFieldsById(
  vaultId: string,
  itemId: string,
  vaultTitle: string,
  itemTitle: string,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<DiscoveredField[]> {
  const client = await acquireSdkClient(opts, `1Password item discovery for '${itemTitle}'`);
  const full = await client.items.get(vaultId, itemId);
  const out: DiscoveredField[] = [];
  for (const field of full.fields) {
    if (typeof field.title !== "string") continue;
    const section = sectionLabel(full, field.sectionId);
    const reference = `op://${vaultTitle}/${itemTitle}/${section ? `${section}/` : ""}${field.title}`;
    out.push({
      label: field.title,
      section,
      reference,
      type: typeof field.fieldType === "string" ? field.fieldType : String(field.fieldType ?? ""),
      hasValue: !!field.value,
      valueTail: valueTail(field.value),
    });
  }
  return out;
}

/**
 * List the user's 1Password vaults (id + title only). Used by the config TUI's
 * vault picker, the first level of the browse-don't-type add-wizard. Mirrors
 * discoverItemFields' acquireSdkClient usage; THROWS on no-auth / SDK failure.
 */
export async function listVaults(
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ id: string; title: string }[]> {
  const client = await acquireSdkClient(opts, "1Password vault listing");
  return client.vaults.list();
}

/**
 * List the items (id + title only) in one vault. Used by the config TUI's item
 * picker (second level). Mirrors discoverItemFields' acquireSdkClient usage;
 * THROWS on no-auth / SDK failure.
 */
export async function listItems(
  vaultId: string,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ id: string; title: string }[]> {
  const client = await acquireSdkClient(opts, "1Password item listing");
  return client.items.list(vaultId);
}

/**
 * Resolve a field's owning section title from its sectionId, or null when the
 * field is top-level (no sectionId) or the section isn't found.
 */
function sectionLabel(
  item: { sections: { id: string; title: string }[] },
  sectionId?: string
): string | null {
  if (!sectionId) return null;
  const match = item.sections.find((s) => s.id === sectionId);
  return match ? match.title : null;
}

/**
 * The outcome of applying a glob's section/field filter + env-name validation
 * to a discovered field. Used by both resolveGlobImport and the preview command.
 */
export interface GlobFieldMatch {
  /** The discovered field this match describes. */
  field: DiscoveredField;
  /** The trimmed env var name this field would become. */
  envName: string;
  /** True when envName is a valid env var name (else the field is skipped). */
  valid: boolean;
}

/**
 * Apply a parsed glob's section + field filter to discovered fields and compute
 * the candidate env var name (trimmed label) + validity for each survivor.
 * Pure — no I/O — so both resolveGlobImport and the preview command share it.
 *
 * A field survives the filter when:
 *  - section scope matches: sectionGlob===null ⇒ field.section===null; else
 *    field.section!==null AND sectionRegex.test(field.section).
 *  - the field's TRIMMED label matches fieldRegex.
 * Each survivor's envName = label.trim(); valid = ENV_VAR_NAME_RE.test(envName).
 */
export function filterGlobFields(fields: DiscoveredField[], glob: GlobImport): GlobFieldMatch[] {
  const sectionRegex = glob.sectionGlob === null ? null : globToRegExp(glob.sectionGlob);
  const fieldRegex = globToRegExp(glob.fieldGlob);

  const matches: GlobFieldMatch[] = [];
  for (const field of fields) {
    // Section scope.
    if (glob.matchAll) {
      // `**` — every field, any section or none. No section check at all.
    } else if (glob.sectionGlob === null) {
      if (field.section !== null) continue;
    } else {
      if (field.section === null) continue;
      if (!sectionRegex!.test(field.section)) continue;
    }
    // Field-label scope (match against the TRIMMED label so a trailing-space
    // label like "GEMINI_API_KEY " still matches a "*_API_KEY" glob).
    const envName = field.label.trim();
    if (!fieldRegex.test(envName)) continue;
    matches.push({ field, envName, valid: ENV_VAR_NAME_RE.test(envName) });
  }
  return matches;
}

/**
 * Resolve a glob field-import path into a `{ envVarName: secretValue }` map.
 *
 * Pipeline:
 *  1. parse → discover all fields of the item (SDK, names only).
 *  2. filter by section + field glob; envName = trimmed label.
 *  3. drop fields whose trimmed label is NOT a valid env var name (warn on
 *     stderr, do NOT sanitize/convert).
 *  4. resolve the surviving fields' op:// references via resolveSecrets
 *     (SDK, batched, in-memory).
 *
 * THROWS when the glob matches NO importable fields (with a hint listing a few
 * available labels), or when discovery / resolution fails.
 */
export async function resolveGlobImport(
  opPath: string,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
    /** Override the stderr warn sink (tests capture warnings). */
    warn?: (msg: string) => void;
  } = {}
): Promise<Record<string, string>> {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const glob = parseGlobImport(opPath);
  const fields = await discoverItemFields(glob.vault, glob.item, {
    sdkFactory: opts.sdkFactory,
    auth: opts.auth,
    env: opts.env,
    warn,
  });
  const matches = filterGlobFields(fields, glob);

  // Build the resolve map from VALID matches; warn+skip invalid ones.
  const refMap: Record<string, string> = {};
  for (const m of matches) {
    if (!m.valid) {
      warn(`[claudish] skipped 1Password field '${m.field.label}' (not a valid env var name)`);
      continue;
    }
    refMap[m.envName] = m.field.reference;
  }

  if (Object.keys(refMap).length === 0) {
    const available = fields
      .map((f) => f.label.trim())
      .filter((l) => l !== "")
      .slice(0, 8);
    throw new Error(
      `1Password glob '${opPath}' matched no importable fields in '${glob.item}'. ` +
        `Available field labels include: ${available.join(", ") || "(none)"}.`
    );
  }

  return resolveSecrets(refMap, {
    sdkFactory: opts.sdkFactory,
    auth: opts.auth,
    env: opts.env,
  });
}

// ===========================================================================
// Config-import collection + --op flag parsing (v7.8.0+)
//
// These are PURE, side-effect-free helpers that index.ts calls. Factored out so
// the routing/parsing logic is unit-testable without process.env or argv games.
// ===========================================================================

/**
 * Derive an env var NAME from a single (non-glob) op:// reference by taking its
 * trailing path segment (the field label) and applying the SAME trim+validate
 * rule that glob imports use for labels. Returns null when the resulting name is
 * not a valid env var name (caller decides whether to warn/error).
 *
 *   op://Jack/My Item/OpenAI/OPENROUTER_API_KEY → "OPENROUTER_API_KEY"
 *   op://Jack/My Item/GOOGLE/GEMINI_API_KEY      → "GEMINI_API_KEY"
 */
export function envNameFromOpRef(opRef: string): string | null {
  if (typeof opRef !== "string" || !opRef.startsWith("op://")) return null;
  const segments = opRef.slice("op://".length).split("/");
  const last = segments[segments.length - 1] ?? "";
  const name = last.trim();
  if (name === "" || !ENV_VAR_NAME_RE.test(name)) return null;
  return name;
}

/**
 * The result of collecting 1Password imports from a config object. `globImports`
 * are full glob paths (resolved later by resolveGlobImport). `opRefs` maps a
 * derived env var name → a single op:// reference (resolved by resolveSecrets).
 */
export interface CollectedConfigImports {
  /** Single op:// references keyed by their derived env var name. */
  opRefs: Record<string, string>;
  /** Glob-import paths (op://.../*) to expand into many env vars. */
  globImports: string[];
  /** Human-readable warnings (e.g. a single ref whose label isn't a valid name). */
  warnings: string[];
}

/**
 * Collect 1Password imports from the typed config. Reads TWO sources:
 *
 *  1. `cfg.apiKeys` — a `{ NAME: value }` map. A single op:// ref VALUE is
 *     collected under its explicit NAME key (the original behavior). Glob VALUES
 *     in apiKeys are NO LONGER specially detected — globs come ONLY from the
 *     dedicated `onepassword` array (a glob sitting in apiKeys is just treated as
 *     a literal value, which the SDK would reject if used).
 *  2. `cfg.onepassword` — a dedicated `string[]` of glob OR single op:// ref
 *     entries. Glob entries → globImports. Single non-glob op:// entries →
 *     resolved with the env name derived from the trailing field label
 *     (envNameFromOpRef); an entry whose label isn't a valid env var name is
 *     skipped with a warning.
 *
 * PURE: reads `cfg` and an optional `env` snapshot (to honor "don't resolve an
 * already-set env var that differs from config"), returns the collected imports.
 * Does NOT mutate process.env or perform any I/O.
 */
export function collectConfigImports(
  cfg: {
    apiKeys?: Record<string, string>;
    onepassword?: string[];
  },
  env: NodeJS.ProcessEnv = process.env
): CollectedConfigImports {
  const opRefs: Record<string, string> = {};
  const globImports: string[] = [];
  const warnings: string[] = [];

  // --- Source 1: apiKeys (explicit NAME → value). Single op:// refs only. ---
  collectApiKeyRefs(cfg.apiKeys, env, opRefs);

  // --- Source 2: the dedicated onepassword array (globs + single refs). ---
  if (Array.isArray(cfg.onepassword)) {
    for (const entry of cfg.onepassword) {
      collectOnepasswordEntry(entry, env, opRefs, globImports, warnings);
    }
  }

  return { opRefs, globImports, warnings };
}

/**
 * Collect single op:// refs from an `apiKeys` map into `opRefs` (keyed by the
 * explicit NAME). The config value seeds process.env only if not already set;
 * then we resolve whatever is current IF it's a single op:// ref. Mirrors the
 * original gap-fill semantics; the caller applies the env mutation.
 */
function collectApiKeyRefs(
  apiKeys: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
  opRefs: Record<string, string>
): void {
  if (!apiKeys) return;
  for (const [envVar, value] of Object.entries(apiKeys)) {
    if (typeof value !== "string") continue;
    const current = env[envVar] ?? value;
    if (isOpReference(current)) {
      opRefs[envVar] = current;
    }
  }
}

/**
 * Classify ONE `onepassword[]` entry: a glob → globImports; a single op:// ref
 * (named by its trailing field label) → opRefs; anything else → a warning.
 */
function collectOnepasswordEntry(
  entry: unknown,
  env: NodeJS.ProcessEnv,
  opRefs: Record<string, string>,
  globImports: string[],
  warnings: string[]
): void {
  if (typeof entry !== "string") return;
  const trimmed = entry.trim();
  if (trimmed === "") return;

  if (isGlobImport(trimmed)) {
    globImports.push(trimmed);
    return;
  }

  // A single op:// ref. We DON'T use isOpReference here (its anchored regex
  // rejects whitespace, but real item/section labels contain spaces). The
  // `op://` prefix is enough; envNameFromOpRef validates the trailing label.
  if (trimmed.startsWith("op://")) {
    const name = envNameFromOpRef(trimmed);
    if (name === null) {
      warnings.push(
        `[claudish] skipped 1Password ref '${trimmed}' from onepassword[] ` +
          "(its trailing field label is not a valid env var name)"
      );
      return;
    }
    // Single refs from onepassword[] DON'T overwrite an already-set env var.
    if (!env[name]) {
      opRefs[name] = trimmed;
    }
    return;
  }

  warnings.push(
    `[claudish] skipped 1Password entry '${trimmed}' from onepassword[] ` +
      "(not a glob import or op:// reference)"
  );
}

/**
 * Parse the `--op <glob>` early-hydration flag out of a raw argv slice. PURE —
 * takes `process.argv.slice(2)`-shaped input and extracts the glob value plus
 * the `--list` modifier. Used by index.ts's `applyOpImport()` (and tested in
 * isolation so the matching/collision rules are pinned).
 *
 * Matching rules (deliberately strict to avoid the `--op-env` collision):
 *  - The flag token is matched by EXACT equality `=== "--op"` (value is the next
 *    argv entry) OR by the `--op=` prefix (`startsWith("--op=")`, inline value).
 *    A naive `startsWith("--op")` would WRONGLY swallow `--op-env`/`--op-list`;
 *    we never use that.
 *  - `--op-env` and any other `--op<suffix>` token is NOT matched as `--op`.
 *  - `--list` is matched as a bare token anywhere in argv (the preview modifier).
 *
 * Returns:
 *  - `glob`: the op:// glob value (verbatim — it may contain spaces because the
 *    shell already delivered it as ONE argv entry), or undefined when `--op` is
 *    absent. When `--op` is present but its value is missing/empty/another flag,
 *    `glob` is undefined and `present` is true so the caller can emit a usage
 *    error.
 *  - `list`: true when a bare `--list` token is present.
 *  - `present`: true when a `--op`/`--op=` token appears at all (lets the caller
 *    distinguish "no --op" from "--op with a bad value").
 */
export interface ParsedOpFlag {
  /** The op:// glob value (verbatim), or undefined when none/invalid. */
  glob: string | undefined;
  /** True when a bare `--list` token is present → preview-and-exit. */
  list: boolean;
  /** True when a `--op`/`--op=` token appears (even with a missing value). */
  present: boolean;
}

export function parseOpFlag(argv: string[]): ParsedOpFlag {
  let glob: string | undefined;
  let present = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // EXACT match — `--op <value>`. Must not match `--op-env`, `--op-list`, etc.
    if (a === "--op") {
      present = true;
      const next = argv[i + 1];
      // A missing value, an empty value, or another flag → invalid (glob stays
      // undefined; caller emits a usage error because `present` is true).
      if (next !== undefined && next !== "" && !next.startsWith("-")) {
        glob = next;
      }
      break;
    }
    // Inline form — `--op=<value>`. `startsWith("--op=")` cannot match `--op-env`
    // (no `=` there) so this is safe.
    if (a.startsWith("--op=")) {
      present = true;
      const v = a.slice("--op=".length);
      if (v !== "") glob = v;
      break;
    }
  }
  const list = argv.includes("--list");
  return { glob, list, present };
}

// ===========================================================================
// SDK layer (v7.6.0+) — SDK-ONLY
//
// Everything below is the ASYNC public surface. The SDK is loaded via a
// DYNAMIC import so a normal run never touches the ~10MB SDK + WASM. The entry
// points — resolveSecrets / readEnvironment / discoverItemFields — require SDK
// auth and hard-fail (no `op` CLI fallback) when none is available.
// ===========================================================================

/**
 * The minimal subset of the @1password/sdk Client we use. Defined locally so
 * tests can inject a fake without importing the real (heavy) SDK, and so the
 * SDK import stays dynamic. The real client structurally satisfies these (the
 * SDK's richer field types — e.g. `fieldType: ItemFieldType` — narrow to our
 * `string` via the `as unknown as SdkClientLike` cast in the default factory).
 */
export interface SdkClientLike {
  secrets: {
    resolve(secretReference: string): Promise<string>;
    resolveAll(secretReferences: string[]): Promise<{
      // Keyed by the secret reference string (the op://... value), NOT our env
      // var name. Each entry has `content` on success and/or `error` on failure.
      individualResponses: Record<string, { content?: { secret: string }; error?: unknown }>;
    }>;
  };
  vaults: {
    list(): Promise<{ id: string; title: string }[]>;
  };
  items: {
    list(vaultId: string): Promise<{ id: string; title: string }[]>;
    get(
      vaultId: string,
      itemId: string
    ): Promise<{
      id: string;
      title: string;
      fields: { id: string; title: string; sectionId?: string; fieldType: string; value: string }[];
      sections: { id: string; title: string }[];
    }>;
  };
  environments: {
    getVariables(
      environmentId: string
    ): Promise<{ variables: { name: string; value: string; masked: boolean }[] }>;
  };
}

/**
 * Auth descriptor for the SDK. Either a service-account token string, or a
 * DesktopAuth-style account name. Mirrors the SDK's `Auth = string | DesktopAuth`.
 */
export type SdkAuth = { kind: "token"; token: string } | { kind: "desktop"; accountName: string };

/**
 * Injectable factory for the SDK client (the test seam). The default
 * implementation dynamically imports @1password/sdk and builds a real client;
 * tests inject a fake that never touches the SDK or a real token.
 */
export type SdkClientFactory = (auth: SdkAuth) => Promise<SdkClientLike>;

/**
 * Process-lifetime cache of built SDK clients, keyed by auth identity. Reusing
 * ONE client across operations avoids a fresh `createClient` (and a new desktop
 * IPC handshake) on every vault/item/field call. Repeated handshakes are what
 * make the desktop app's IPC flaky (errno -4 / "Denied") under the rapid
 * sequence of calls the config TUI makes — one client, reused, is far steadier
 * and faster. Keyed so a multi-account run never crosses clients.
 */
const sdkClientCache = new Map<string, Promise<SdkClientLike>>();

function sdkAuthCacheKey(auth: SdkAuth): string {
  return auth.kind === "token" ? `token:${auth.token}` : `desktop:${auth.accountName}`;
}

/**
 * Default SDK client factory. DYNAMICALLY imports @1password/sdk (so the WASM
 * is only loaded when we actually have auth + a secret to resolve) and builds
 * an authenticated client — then CACHES it per auth identity so subsequent
 * operations reuse the same client (one desktop IPC handshake, not one per call).
 * The cached value is the in-flight Promise so concurrent first calls dedupe.
 */
export const defaultSdkClientFactory: SdkClientFactory = async (auth) => {
  const key = sdkAuthCacheKey(auth);
  const cached = sdkClientCache.get(key);
  if (cached) return cached;

  const build = (async () => {
    const { createClient, DesktopAuth } = await import("@1password/sdk");
    const client = await createClient({
      auth: auth.kind === "token" ? auth.token : new DesktopAuth(auth.accountName),
      integrationName: "claudish",
      integrationVersion: VERSION || "1.0.0",
    });
    // The real Client structurally satisfies SdkClientLike (secrets / vaults /
    // items / environments); narrow via unknown to avoid importing SDK types here.
    return client as unknown as SdkClientLike;
  })();

  // Cache the in-flight promise so concurrent callers share one build; on
  // failure, evict so a later call can retry with a fresh handshake.
  sdkClientCache.set(key, build);
  build.catch(() => sdkClientCache.delete(key));
  return build;
};

/**
 * Evict all cached SDK clients so the next operation rebuilds (a fresh desktop
 * IPC handshake). Call this after a transient IPC failure — a cached client
 * whose desktop connection went bad will keep failing until rebuilt.
 */
export function resetSdkClientCache(): void {
  sdkClientCache.clear();
}

/** True when an error looks like a TRANSIENT desktop-IPC failure (errno -4,
 *  "IPC operation failed", "Denied", broken pipe) worth one rebuild+retry. */
export function isTransientSdkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("ipc operation failed") ||
    msg.includes("ipc operation") ||
    msg.includes("-4") ||
    msg.includes("denied") ||
    msg.includes("broken pipe") ||
    msg.includes("connection") ||
    // Stale DESKTOP SESSION after idle: the cached SDK client's session expires
    // and the next call fails with "invalid client id" / "invalid session" /
    // "session expired". Resetting the cache rebuilds the client (a fresh
    // DesktopAuth handshake), so these are retryable, not hard failures.
    msg.includes("invalid client id") ||
    msg.includes("invalid client") ||
    msg.includes("invalid session") ||
    msg.includes("session expired") ||
    msg.includes("session not found") ||
    msg.includes("unauthorized") ||
    msg.includes("token expired") ||
    msg.includes("not authenticated")
  );
}

/**
 * Process-wide SDK SERIALIZER. The 1Password SDK's WASM↔desktop-app IPC bridge
 * is NOT safe for concurrent calls on a shared client: two operations in flight
 * at once corrupt the channel → "IPC operation failed: -4". The config TUI fires
 * overlapping calls (e.g. a post-save confirm AND the list's glob-expansion at
 * the same moment), which reliably triggers it. We chain every SDK operation
 * onto one promise so AT MOST ONE runs at a time. Calls still complete; they just
 * queue. This is the real fix for -4 (the client cache + retry alone can't help
 * when both concurrent calls fail together).
 */
let sdkQueue: Promise<unknown> = Promise.resolve();
function runSdkExclusive<T>(op: () => Promise<T>): Promise<T> {
  const run = sdkQueue.then(op, op); // run after the prior op settles (ok or not)
  // Keep the chain alive regardless of this op's outcome; swallow here so a
  // rejected op doesn't poison the queue for the next caller.
  sdkQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Sleep helper for the retry backoff (gives the desktop bridge a moment). */
function sdkSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an SDK operation SERIALIZED (never concurrent with another SDK op) and,
 * on a TRANSIENT IPC error, evict the client cache (fresh desktop handshake),
 * pause briefly, and retry — up to 2 retries. Non-transient errors (auth, not
 * found, bad ref) propagate immediately. Serialization is the primary -4 fix;
 * the cache-reset + backoff retries handle a genuinely transient blip.
 */
export async function withSdkRetry<T>(op: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Each attempt runs exclusively — no other SDK call overlaps it.
      return await runSdkExclusive(op);
    } catch (err) {
      lastErr = err;
      if (!isTransientSdkError(err) || attempt === MAX_ATTEMPTS) throw err;
      // Transient: drop the (possibly poisoned) client + back off before retry.
      resetSdkClientCache();
      await sdkSleep(150 * attempt);
    }
  }
  throw lastErr;
}

/**
 * Determine whether SDK auth is available WITHOUT blocking on any interactive
 * prompt or shelling out. Returns the auth descriptor, or undefined if the SDK
 * cannot be used from env alone (callers then run the richer resolveSdkAuth).
 *
 * Priority:
 *  1. OP_SERVICE_ACCOUNT_TOKEN → service-account token auth.
 *  2. OP_ACCOUNT → DesktopAuth(accountName). Only used when no service-account
 *     token is present. We never prompt to discover an account name here.
 *
 * The richer resolution (config account + single-account auto-detect +
 * interactive picker) lives in resolveSdkAuth(), which index.ts callers invoke
 * and then thread the resulting auth into resolveSecrets/discoverItemFields/
 * readEnvironment via opts.auth.
 */
export function detectSdkAuth(env: NodeJS.ProcessEnv = process.env): SdkAuth | undefined {
  const token = env.OP_SERVICE_ACCOUNT_TOKEN?.trim();
  if (token) return { kind: "token", token };
  const account = env.OP_ACCOUNT?.trim();
  if (account) return { kind: "desktop", accountName: account };
  return undefined;
}

/** A 1Password account as reported by `op account list --format=json`. */
export interface AccountInfo {
  /** Account sign-in URL, e.g. `my-team.1password.com`. Unique per account. */
  url: string;
  /** Account email (may collide across two accounts). */
  email: string;
  /** Account UUID. */
  account_uuid: string;
  /** User ID. */
  user_id: string;
}

/**
 * Injectable account lister. Default shells out to the read-only
 * `op account list --format=json`. Returns the parsed accounts, or null when
 * `op` is absent / fails / returns unparseable output. NEVER touches a secret.
 */
export type OpAccountLister = () => AccountInfo[] | null;

/** Default account lister: read-only `op account list --format=json`. */
export const defaultOpAccountLister: OpAccountLister = () => {
  try {
    const res = spawnSync("op", ["account", "list", "--format=json"], { encoding: "utf-8" });
    if (res.error || res.status !== 0) return null;
    const parsed = JSON.parse(res.stdout ?? "");
    if (!Array.isArray(parsed)) return null;
    const accounts: AccountInfo[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Partial<AccountInfo>;
      if (typeof a.url !== "string") continue;
      accounts.push({
        url: a.url,
        email: typeof a.email === "string" ? a.email : "",
        account_uuid: typeof a.account_uuid === "string" ? a.account_uuid : "",
        user_id: typeof a.user_id === "string" ? a.user_id : "",
      });
    }
    return accounts;
  } catch {
    // `op` missing, non-JSON output, or any other failure → no accounts.
    return null;
  }
};

/**
 * The outcome of desktop-account resolution. Either a concrete account name to
 * use with DesktopAuth, an actionable error string, or a request for the caller
 * to run an interactive picker over the listed accounts (and save the choice).
 */
export type DesktopAccountResult =
  | { accountName: string }
  | { error: string }
  | { needsPicker: AccountInfo[] };

/**
 * Resolve the account name for SDK DesktopAuth WITHOUT building a client.
 *
 * Order:
 *  (a) OP_ACCOUNT env → use it (ephemeral per-run override).
 *  (b) opts.configAccount (onepasswordAccount from config) → use it.
 *  (c) opts.opAccountLister() (read-only `op account list`):
 *      - exactly 1 account → use its url (zero-config single-account).
 *      - multiple + interactive TTY → { needsPicker } (caller prompts + saves).
 *      - multiple + non-interactive, OR op absent → { error } (with the account
 *        list when available).
 *
 * This is SYNC: the lister is sync (spawnSync) and there's no SDK/async work.
 * index.ts orchestrates the interactive picker around it.
 */
export function resolveDesktopAccount(
  opts: {
    env?: NodeJS.ProcessEnv;
    configAccount?: string;
    interactive?: boolean;
    opAccountLister?: OpAccountLister;
  } = {}
): DesktopAccountResult {
  const env = opts.env ?? process.env;

  // (a) Explicit env override.
  const envAccount = env.OP_ACCOUNT?.trim();
  if (envAccount) return { accountName: envAccount };

  // (b) Saved config account.
  const configAccount = opts.configAccount?.trim();
  if (configAccount) return { accountName: configAccount };

  // (c) Enumerate accounts (optional, read-only).
  const lister = opts.opAccountLister ?? defaultOpAccountLister;
  const accounts = lister();

  const remediation =
    "Set OP_ACCOUNT to your account URL (e.g. my-team.1password.com) or " +
    "`onepasswordAccount` in ~/.claudish/config.json.";

  if (!accounts || accounts.length === 0) {
    return {
      error:
        "Could not determine which 1Password account to use (no service-account " +
        `token, and \`op account list\` is unavailable). ${remediation}`,
    };
  }

  if (accounts.length === 1) {
    return { accountName: accounts[0].url };
  }

  // Multiple accounts.
  if (opts.interactive) {
    return { needsPicker: accounts };
  }

  const listing = accounts.map((a) => `  - ${a.url}${a.email ? ` (${a.email})` : ""}`).join("\n");
  return {
    error:
      "Multiple 1Password accounts are available and this is a non-interactive " +
      `session, so claudish can't prompt you to pick one. ${remediation}\n` +
      `Accounts:\n${listing}`,
  };
}

/**
 * Orchestrated SDK auth resolution (async, the entry point index.ts callers use).
 *
 * Order:
 *  1. OP_SERVICE_ACCOUNT_TOKEN → token auth (headless).
 *  2. OP_ACCOUNT → DesktopAuth.
 *  3. opts.configAccount (onepasswordAccount) → DesktopAuth.
 *  4. resolveDesktopAccount's lister branch:
 *     - single account → DesktopAuth(url).
 *     - multiple + interactive → opts.onNeedsPicker(accounts) picks one (and the
 *       caller saves it); if no picker is supplied, hard-fail with the listing.
 *     - multiple + non-interactive OR op absent → throw the actionable error.
 *
 * Throws buildAuthError(...) when no usable auth can be resolved.
 */
export async function resolveSdkAuth(
  opts: {
    env?: NodeJS.ProcessEnv;
    configAccount?: string;
    interactive?: boolean;
    opAccountLister?: OpAccountLister;
    /**
     * Invoked when multiple accounts exist in an interactive session. Returns
     * the chosen account URL (the caller is expected to persist it), or
     * undefined/null to abort. Async so the caller can prompt.
     */
    onNeedsPicker?: (accounts: AccountInfo[]) => Promise<string | undefined>;
  } = {}
): Promise<SdkAuth> {
  const env = opts.env ?? process.env;

  // 1. Service-account token wins.
  const token = env.OP_SERVICE_ACCOUNT_TOKEN?.trim();
  if (token) return { kind: "token", token };

  // 2–4. Desktop account resolution.
  const result = resolveDesktopAccount({
    env,
    configAccount: opts.configAccount,
    interactive: opts.interactive,
    opAccountLister: opts.opAccountLister,
  });

  if ("accountName" in result) {
    return { kind: "desktop", accountName: result.accountName };
  }

  if ("needsPicker" in result) {
    if (opts.onNeedsPicker) {
      const chosen = await opts.onNeedsPicker(result.needsPicker);
      if (chosen && chosen.trim()) {
        return { kind: "desktop", accountName: chosen.trim() };
      }
    }
    // No picker supplied, or the user aborted — fall through to an error.
    const listing = result.needsPicker
      .map((a) => `  - ${a.url}${a.email ? ` (${a.email})` : ""}`)
      .join("\n");
    throw buildAuthError(
      "Multiple 1Password accounts are available but none was selected.\n" +
        `Accounts:\n${listing}`
    );
  }

  // result.error
  throw buildAuthError(result.error);
}

/**
 * Acquire an authenticated SDK client. Resolves auth from opts.auth, or falls
 * back to env-only detectSdkAuth (token / OP_ACCOUNT). When no auth is available
 * hard-fails with an actionable error — there is NO `op` CLI fallback.
 *
 * `context` is woven into the error so the user knows which operation needed
 * auth (e.g. "1Password Environment 'env-1'").
 */
export async function acquireSdkClient(
  opts: { sdkFactory?: SdkClientFactory; auth?: SdkAuth; env?: NodeJS.ProcessEnv },
  context: string
): Promise<SdkClientLike> {
  const auth = opts.auth ?? detectSdkAuth(opts.env ?? process.env);
  if (!auth) {
    throw buildAuthError(
      `1Password SDK auth is required for ${context}, but neither ` +
        "OP_SERVICE_ACCOUNT_TOKEN nor a 1Password account (OP_ACCOUNT / " +
        "onepasswordAccount config) is available."
    );
  }
  const sdkFactory = opts.sdkFactory ?? defaultSdkClientFactory;
  return sdkFactory(auth);
}

/**
 * Map the SDK's resolveAll() response (keyed by op:// reference) back into our
 * `{ envVarName: secret }` shape. `refs` is the original `{ envVarName: "op://..." }`
 * map so we can re-associate by reference string.
 *
 * THROWS a combined error if any requested ref failed to resolve or is missing
 * from the response.
 */
function mapSdkResolveAll(
  refs: Record<string, string>,
  response: {
    individualResponses: Record<string, { content?: { secret: string }; error?: unknown }>;
  }
): Record<string, string> {
  const responses = response.individualResponses ?? {};
  const out: Record<string, string> = {};
  const failures: string[] = [];

  for (const [envVar, ref] of Object.entries(refs)) {
    const entry = responses[ref];
    if (entry?.content && typeof entry.content.secret === "string") {
      out[envVar] = entry.content.secret;
      continue;
    }
    if (entry?.error !== undefined) {
      failures.push(`${envVar} (${ref}): ${describeSdkError(entry.error)}`);
      continue;
    }
    failures.push(`${envVar} (${ref}): no value returned`);
  }

  if (failures.length > 0) {
    throw new Error(
      `1Password SDK could not resolve secret reference(s):\n  ${failures.join("\n  ")}`
    );
  }
  return out;
}

/** Best-effort stringification of an SDK ResolveReferenceError variant. */
function describeSdkError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { type?: unknown; message?: unknown };
    const type = typeof e.type === "string" ? e.type : undefined;
    const message = typeof e.message === "string" ? e.message : undefined;
    if (type && message) return `${type}: ${message}`;
    if (type) return type;
    if (message) return message;
  }
  return String(error);
}

/**
 * Batch-resolve `{ envVarName: "op://..." }` refs via the SDK in one call.
 *
 *  - Empty input → `{}` (no SDK touched).
 *  - Otherwise → acquireSdkClient → secrets.resolveAll → mapSdkResolveAll.
 *  - No SDK auth → hard-fail (no `op` CLI fallback).
 *
 * Async because the SDK is async.
 */
export async function resolveSecrets(
  refs: Record<string, string>,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<Record<string, string>> {
  const keys = Object.keys(refs);
  if (keys.length === 0) return {};

  const client = await acquireSdkClient(opts, "resolving 1Password secret reference(s)");
  const response = await client.secrets.resolveAll(keys.map((k) => refs[k]));
  return mapSdkResolveAll(refs, response);
}

/**
 * Read a named 1Password Environment via the SDK and return its variables as a
 * `{ name: value }` map.
 *
 * THROWS (caller hard-fails) when:
 *  - the environment id is empty/invalid (usage error — asserted by tests).
 *  - no SDK auth is available.
 *  - the SDK lacks the environments API (you're on the stable 0.4.0 SDK; install
 *    0.4.1-beta.1).
 *  - the environment resolves to no variables.
 */
export async function readEnvironment(
  environmentId: string,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<Record<string, string>> {
  const id = (environmentId ?? "").trim();
  if (id === "") {
    throw new Error("1Password Environment ID is empty. Usage: --op-env <environmentID>");
  }

  const client = await acquireSdkClient(opts, `1Password Environment '${id}'`);

  if (!client.environments || typeof client.environments.getVariables !== "function") {
    throw new Error(
      "1Password Environments require @1password/sdk 0.4.1-beta.1 or later (the " +
        "stable 0.4.0 has no environments API). Install: " +
        "`bun add @1password/sdk@0.4.1-beta.1`."
    );
  }

  const { variables } = await client.environments.getVariables(id);
  if (!Array.isArray(variables) || variables.length === 0) {
    throw new Error(
      `1Password Environment '${id}' resolved to no variables. ` +
        "Check that the Environment ID is correct and contains entries."
    );
  }

  const out: Record<string, string> = {};
  for (const v of variables) {
    if (v && typeof v.name === "string") out[v.name] = typeof v.value === "string" ? v.value : "";
  }
  return out;
}
