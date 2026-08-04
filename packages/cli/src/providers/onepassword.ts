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
import { realValue } from "../env-placeholder.js";
import { addSpanMeta, beginQueuedSpan, setStartupAuthKind, traceSpan } from "../startup-trace.js";
import { VERSION } from "../version.js";
import { withHandshakeLock } from "./onepassword-handshake-lock.js";

/** Matches a full `op://...` secret reference (no embedded whitespace). */
export const OP_REF_RE = /^op:\/\/[^\s]+$/;

/** True when the given string is a 1Password secret reference. */
export function isOpReference(v: string): boolean {
  return typeof v === "string" && OP_REF_RE.test(v);
}

/**
 * Provenance registry for 1Password-hydrated env vars.
 *
 * 1Password keys are resolved at startup and written into `process.env` (see
 * index.ts hydration points). Once there, an op://-sourced key is
 * indistinguishable from a genuine shell env var by `process.env` inspection
 * alone — which made the config TUI mislabel 1Password keys as "From: env".
 *
 * Each hydration site records the env-var names it sourced from 1Password via
 * `recordOpHydratedVars`; UI/provenance code reads `isOpHydratedVar` to show the
 * true source. In-memory is sufficient because both consumers (`claudish config`
 * and `--probe`) run hydration in the SAME process before rendering.
 */
const opHydratedVars = new Set<string>();

/** Record env-var names whose values were hydrated from 1Password. */
export function recordOpHydratedVars(names: Iterable<string>): void {
  for (const n of names) {
    if (typeof n === "string" && n.length > 0) opHydratedVars.add(n);
  }
}

/** True when this env var's value was hydrated from 1Password this run. */
export function isOpHydratedVar(name: string | undefined): boolean {
  return !!name && opHydratedVars.has(name);
}

/**
 * Run-scoped record of 1Password sources that FAILED this run — the negative
 * counterpart to `opHydratedVars`, with the same in-memory rationale (resolution
 * and error rendering happen in one process).
 *
 * Why this exists: every op-source failure is deliberately NON-FATAL (a broken
 * import must never lock the user out — see op-source.ts). It warns and moves
 * on. But the downstream missing-key error is built from the provider
 * resolution alone, so it had no way to know 1Password had been consulted and
 * denied — and told the user to `export` a key they already store in 1Password.
 * Recording the failure here lets `getMissingKeyError` name the real cause.
 *
 * The record is deliberately COARSE (run-scoped, not per-env-var): an
 * Environment fetch is all-or-nothing, so when it fails we cannot know which
 * variables it would have supplied. "1Password failed this run" is the honest
 * claim; attributing it to a specific key would be a guess.
 */
export interface OpSourceFailure {
  /** Which kind of op source failed. */
  kind: "auth" | "environment" | "import" | "reference";
  /** Identifier for the source — an environment id or op:// path. NEVER a value. */
  source?: string;
  /** The underlying SDK/auth error message. */
  message: string;
}

const opSourceFailures: OpSourceFailure[] = [];

/** Record a non-fatal 1Password source failure for later error rendering. */
export function recordOpFailure(failure: OpSourceFailure): void {
  const dup = opSourceFailures.some(
    (f) => f.kind === failure.kind && f.source === failure.source && f.message === failure.message
  );
  if (!dup) opSourceFailures.push(failure);
}

/** All 1Password source failures recorded this run (empty when none). */
export function getOpFailures(): readonly OpSourceFailure[] {
  return opSourceFailures;
}

/** Test seam: clear the run-scoped failure record. */
export function resetOpFailures(): void {
  opSourceFailures.length = 0;
}

/**
 * True when a recorded failure is the user (or a locked Mac) declining the
 * 1Password desktop authorization prompt, as opposed to a missing token,
 * unreachable app, or bad reference. This distinction drives the remediation:
 * a denial means the credential is reachable and just needs approval.
 */
export function wasOpAuthorizationDenied(): boolean {
  return opSourceFailures.some((f) => /denied authorization/i.test(f.message));
}

/**
 * Render the "1Password was consulted and failed" block for a missing-key
 * error. Returns [] when 1Password played no part this run, so the caller can
 * splice unconditionally and non-op users see no change.
 *
 * Placed ABOVE the generic `export FOO=...` remediation by the caller: when a
 * key lives in 1Password, "approve the prompt" is the fix and exporting a
 * literal is the bypass — showing them in the other order taught the wrong
 * lesson (this is the bug from the locked-Mac SSH report).
 */
export function renderOpFailureNotice(envVar: string): string[] {
  return renderOpFailureBlock(`for ${envVar} this run`);
}

/**
 * The same block with a caller-supplied subject phrase.
 *
 * The MCP server needs this without an env-var name. When a tool routes a model
 * and 1Password fails, the only report today is `warnOnce` on STDERR — which an
 * MCP host captures and never shows the user. That is precisely why this whole
 * class of failure presented as silence: claudish was explaining itself into a
 * stream nobody reads. Returning the lines lets the tool RESULT carry them.
 */
export function renderOpFailureBlock(subject: string): string[] {
  if (opSourceFailures.length === 0) return [];

  const lines: string[] = [`1Password was consulted ${subject} and failed:`];
  for (const f of opSourceFailures) {
    const where = f.source ? `${f.kind} ${f.source}` : f.kind;
    lines.push(`  ${where} — ${f.message.split("\n")[0]}`);
  }
  lines.push("");

  if (wasOpAuthorizationDenied()) {
    // Name the SPECIFIC cause when a probe can still see it. A denial has four
    // causes with four different fixes, and "the app declined" sends the user
    // hunting for a prompt that, in the app-locked case, was never shown.
    //
    // Precedence comes from currentLockCause() so this message and the retry
    // classifier can never disagree about which lock to name.
    const cause = currentLockCause();
    if (cause === "screen") {
      lines.push("  Your Mac is locked, so the 1Password approval prompt cannot be shown.");
      lines.push("");
      lines.push("  Fix: unlock the Mac, approve the prompt, and re-run.");
    } else if (cause === "app") {
      lines.push("  The 1Password app is LOCKED. With shared lock state (the default) a locked");
      lines.push("  app refuses the SDK outright — no approval prompt is ever shown, which is");
      lines.push("  why nothing appeared on screen.");
      lines.push("");
      lines.push("  Fix: unlock 1Password (Touch ID is enough) and re-run.");
      lines.push("  To stop it re-locking mid-session, raise Settings → Security → auto-lock.");
    } else {
      lines.push("  The 1Password desktop app declined to release secrets. The approval prompt");
      lines.push("  was most likely dismissed.");
      lines.push("");
      lines.push("  Fix: re-run and approve the 1Password prompt.");
    }
    lines.push("  Headless (no desktop app): export OP_SERVICE_ACCOUNT_TOKEN='ops_...'");
  } else {
    lines.push("  Fix: check the reference resolves — claudish config → 1Password tab.");
    lines.push("  Headless (no desktop app): export OP_SERVICE_ACCOUNT_TOKEN='ops_...'");
  }

  return lines;
}

/** Build the standard actionable auth-failure error. */
export function buildAuthError(detail: string): Error {
  return new Error(
    `${detail}\nSet OP_SERVICE_ACCOUNT_TOKEN (service account, headless) or OP_ACCOUNT (your 1Password account URL, e.g. my-team.1password.com) for the desktop app — or set \`onepasswordAccount\` in ~/.claudish/config.json.`
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
  /**
   * The FULL decrypted value — populated ONLY when discovery is called with
   * `captureValues: true` (the glob-IMPORT path, which needs the value anyway
   * and already pays the in-process decrypt). It is `undefined` on every
   * display/preview call, preserving the "keep no full value" posture there.
   *
   * Why this exists: the SDK returns each field's decrypted `value` during
   * discovery. Re-resolving a synthesized title-based `op://Vault/Item/Section/
   * Title` reference through `secrets.resolveAll()` afterwards is ambiguous —
   * 1Password matches the reference BY TITLE, so a title that recurs across the
   * item fails with `tooManyMatchingFields` and the key is silently skipped.
   * Carrying the value the SDK already decrypted removes that second round-trip
   * and the whole class of title-collision failures.
   */
  value?: string;
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
    /**
     * Populate `DiscoveredField.value` with the full decrypted value the SDK
     * already returns. ONLY the glob-import path sets this — display/preview
     * callers leave it false so no full value is retained. See DiscoveredField.
     */
    captureValues?: boolean;
  } = {}
): Promise<DiscoveredField[]> {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  const client = await acquireSdkClient(opts, `1Password item discovery for '${item}'`);

  // 1. Find the vault by title.
  const vaults = await traceSpan("op:vaults.list", () => client.vaults.list());
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
  const items = await traceSpan("op:items.list", () => client.items.list(vaultId), { vault });
  const itemMatches = items.filter((i) => i.title === item);
  if (itemMatches.length === 0) {
    throw new Error(
      `1Password item '${item}' not found in vault '${vault}'. ` +
        `Available items: ${
          items
            .map((i) => i.title)
            .slice(0, 12)
            .join(", ") || "(none)"
        }.`
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
  // (Item TITLES are fine in trace meta — they already appear in stderr warns.)
  const full = await traceSpan("op:items.get", () => client.items.get(vaultId, itemId), {
    vault,
    item,
  });
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
      value: opts.captureValues && typeof field.value === "string" ? field.value : undefined,
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
  const full = await traceSpan("op:items.get", () => client.items.get(vaultId, itemId), {
    vault: vaultTitle,
    item: itemTitle,
  });
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
  return traceSpan("op:vaults.list", () => client.vaults.list());
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
  return traceSpan("op:items.list", () => client.items.list(vaultId));
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
  // captureValues: read each field's already-decrypted value from discovery so
  // we never re-resolve the synthesized title-based reference (which is
  // ambiguous for items with recurring field titles → `tooManyMatchingFields`).
  const fields = await discoverItemFields(glob.vault, glob.item, {
    sdkFactory: opts.sdkFactory,
    auth: opts.auth,
    env: opts.env,
    warn,
    captureValues: true,
  });
  const matches = filterGlobFields(fields, glob);

  // Build the result directly from the discovered values; warn+skip invalid
  // names. A valid-name field with no value is skipped (nothing to import).
  const resolved: Record<string, string> = {};
  let importable = 0;
  for (const m of matches) {
    if (!m.valid) {
      warn(`[claudish] skipped 1Password field '${m.field.label}' (not a valid env var name)`);
      continue;
    }
    importable++;
    if (typeof m.field.value === "string") resolved[m.envName] = m.field.value;
  }

  if (importable === 0) {
    const available = fields
      .map((f) => f.label.trim())
      .filter((l) => l !== "")
      .slice(0, 8);
    throw new Error(
      `1Password glob '${opPath}' matched no importable fields in '${glob.item}'. ` +
        `Available field labels include: ${available.join(", ") || "(none)"}.`
    );
  }

  return resolved;
}

/**
 * Resolve a glob field-import path into ALL its valid `{ envVarName: value }`
 * pairs — the FULL-glob variant used by op-source's shared per-glob resolution.
 *
 * Same pipeline as resolveGlobImport (discover ONCE → filter → read values)
 * but NON-THROWING on zero matches: `{}` is a legitimate, memoizable outcome
 * for the lazy credential path (the old per-credential
 * resolveGlobImportForEnvVars also returned `{}` silently there — a throw here
 * would turn every "glob currently matches nothing" launch into a retry storm,
 * re-running discovery once per provider). Invalid env-var names are skipped
 * silently (callers pass a quiet warn on this path).
 *
 * VALUES COME FROM DISCOVERY (captureValues): each matched field's value is the
 * one the SDK already decrypted while listing the item — NOT a second
 * `secrets.resolveAll()` pass on a synthesized title-based reference. That
 * second pass matched fields BY TITLE and failed with `tooManyMatchingFields`
 * on any item whose field titles recur (observed in real items), silently
 * dropping the key. Reading the discovered value removes that whole failure
 * class. A matched field with no value is skipped; whole-batch failures (no
 * auth, discovery/IPC error) still propagate — those must NOT be memoized.
 */
export async function resolveGlobImportAll(
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
  // captureValues: use the values discovery already decrypted (one SDK call)
  // rather than a second title-based resolveAll pass, which fails with
  // `tooManyMatchingFields` on any item whose field titles recur.
  const fields = await discoverItemFields(glob.vault, glob.item, {
    sdkFactory: opts.sdkFactory,
    auth: opts.auth,
    env: opts.env,
    warn,
    captureValues: true,
  });
  const matches = filterGlobFields(fields, glob);

  const resolved: Record<string, string> = {};
  for (const m of matches) {
    if (!m.valid) continue;
    // A valid-name field with no captured value is silently skipped — matches
    // the previous partial-resolve semantics (one empty field ≠ batch failure).
    if (typeof m.field.value === "string") resolved[m.envName] = m.field.value;
  }

  // Zero importable matches → {} (memoizable, non-throwing — see docblock).
  return resolved;
}

/**
 * Resolve a glob field-import path but SEEK ONLY the env var names in `envNames`.
 *
 * This is the per-credential variant of resolveGlobImport, used by the lazy
 * hydration path: when claudish routes a model that needs a specific (missing)
 * env-var API key, it resolves the op:// glob looking ONLY for THAT key — never
 * decrypting/advertising every field of the item. A glob like
 * `op://Vault/Item/**` therefore resolves to find just the wanted env var(s).
 *
 * Pipeline (mirrors resolveGlobImport, but with a wanted-name filter):
 *  1. parse → discover all fields of the item (SDK, names only).
 *  2. filter by section + field glob; envName = trimmed label.
 *  3. KEEP only valid matches whose envName ∈ `envNames`.
 *  4. resolve the surviving fields' op:// references via resolveSecrets.
 *
 * Returns `{}` when nothing wanted matches (NON-THROWING — unlike
 * resolveGlobImport, an empty result is expected here: a routed model may need a
 * key this particular glob simply doesn't contain). Discovery / resolution
 * failures still propagate.
 */
export async function resolveGlobImportForEnvVars(
  opPath: string,
  envNames: Iterable<string>,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
    /** Override the stderr warn sink (tests capture warnings). */
    warn?: (msg: string) => void;
  } = {}
): Promise<Record<string, string>> {
  const wanted = new Set(envNames);
  if (wanted.size === 0) return {};

  const warn = opts.warn ?? ((m: string) => console.error(m));
  const glob = parseGlobImport(opPath);
  // captureValues: the seeking filter runs against the values discovery already
  // decrypted — never a second title-based resolve (ambiguous → tooManyMatchingFields).
  const fields = await discoverItemFields(glob.vault, glob.item, {
    sdkFactory: opts.sdkFactory,
    auth: opts.auth,
    env: opts.env,
    warn,
    captureValues: true,
  });
  const matches = filterGlobFields(fields, glob);

  // Keep ONLY valid matches whose env name is one we're seeking.
  const resolved: Record<string, string> = {};
  for (const m of matches) {
    if (!m.valid) continue;
    if (!wanted.has(m.envName)) continue;
    if (typeof m.field.value === "string") resolved[m.envName] = m.field.value;
  }

  // Nothing wanted matched → return empty (this glob doesn't hold the key).
  return resolved;
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
        `[claudish] skipped 1Password ref '${trimmed}' from onepassword[] (its trailing field label is not a valid env var name)`
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
    `[claudish] skipped 1Password entry '${trimmed}' from onepassword[] (not a glob import or op:// reference)`
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
    // Ensure the SDK's core_bg.wasm is loadable BEFORE importing the SDK. In a
    // compiled binary the bundled loader points at a stale build-machine path;
    // this installs a readFileSync redirect (and, cold-cache, downloads the
    // pinned WASM from the official npm registry). Zero network on npm installs
    // and on warm caches. See providers/onepassword-wasm.ts.
    // Startup-trace: the dynamic SDK import is the ~10MB WASM load — one of the
    // dominant cold-start costs, so it gets its own span.
    const { createClient, DesktopAuth } = await traceSpan("op:sdk-wasm-import", async () => {
      const { ensureOpWasmAvailable } = await import("./onepassword-wasm.js");
      await ensureOpWasmAvailable();
      return import("@1password/sdk");
    });
    // Startup-trace: the DesktopAuth handshake can block on the USER clicking
    // "Authorize" in the 1Password app — hence mayIncludeUserPrompt.
    //
    // DesktopAuth ONLY: 1Password arbitrates this handshake across the whole
    // machine and denies every concurrent peer, so sibling claudish processes
    // must take turns — see onepassword-handshake-lock.ts for the measurements.
    // A service-account TOKEN is authorized by the value alone, with no desktop
    // app in the loop and nothing to arbitrate, so it never pays for the lock.
    const build = () =>
      createClient({
        auth: auth.kind === "token" ? auth.token : new DesktopAuth(auth.accountName),
        integrationName: "claudish",
        integrationVersion: VERSION || "1.0.0",
      });
    const client = await traceSpan(
      "op:client-handshake",
      () => (auth.kind === "token" ? build() : withHandshakeLock(build)),
      { mayIncludeUserPrompt: true, authKind: auth.kind }
    );
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
 *  "IPC operation failed", broken pipe, stale session) worth one rebuild+retry.
 *  A user DECLINING the desktop prompt ("Denied authorization for SDK client")
 *  is NOT transient — see the terminal guard below — because retrying it just
 *  re-opens the dialog they just cancelled. */
export function isTransientSdkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // TERMINAL: the user cancelled the 1Password desktop authorization prompt.
  // That is a deliberate decision, not a transient blip — retrying re-prompts
  // them right after they clicked Cancel (the "second dialog" bug). Never retry.
  if (msg.includes("denied authorization")) return false;
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
function runSdkExclusive<T>(
  op: () => Promise<T>,
  label = "op:sdk-op",
  meta?: Record<string, string | number | boolean>
): Promise<T> {
  // Startup-trace: one span per queued op recording BOTH the queue wait
  // (enqueue → start, i.e. time spent behind other serialized SDK ops) and the
  // execution (start → finish). A slow launch caused by queue PILE-UP shows a
  // big waitMs; one slow IPC call shows a big execMs.
  const span = beginQueuedSpan(label, meta);
  const timedOp = () => {
    span.start();
    return op();
  };
  const run = sdkQueue.then(timedOp, timedOp); // run after the prior op settles (ok or not)
  run.then(
    () => span.end(),
    (err) => span.end({ error: true, errorMsg: String(err).split("\n")[0].slice(0, 120) })
  );
  // Keep the chain alive regardless of this op's outcome; swallow here so a
  // rejected op doesn't poison the queue for the next caller.
  sdkQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Sleep helper for the retry backoff (gives the desktop bridge a moment). */
function sdkSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Locked-screen denial recovery ───────────────────────────────────────────
// 1Password returns the SAME error ("Denied authorization for SDK client") for
// two very different situations:
//   (a) the user was shown the approval dialog and clicked Cancel — a decision;
//   (b) the Mac was LOCKED, so the dialog could not be shown at all and
//       1Password auto-denied — an environmental condition.
// The error alone cannot distinguish them, which is why the denial is pinned
// TERMINAL in isTransientSdkError (retrying (a) re-opens a dialog the user just
// dismissed — the "second dialog" bug). Probing the screen-lock state resolves
// the ambiguity from the OUTSIDE: if the screen is locked, nobody could have
// clicked Cancel, so a retry is legitimate and we wait for the user to unlock.

/** How many unlock countdowns (and therefore retries) a locked denial gets. */
const LOCK_RETRY_ROUNDS = 3;
/** Seconds per countdown — 3 × 10s ≈ 30s total to unlock and approve. */
const LOCK_RETRY_SECONDS = 10;

// The countdown is deliberately human-paced, which makes the full 3-round path
// a 30-second wall-clock event — unacceptable inside a test suite. This seam
// lets tests compress the clock without weakening what they cover: rounds and
// per-round seconds stay independent, so the round COUNT is still asserted
// against the real constant while the seconds shrink to milliseconds.
let lockRetrySeconds = LOCK_RETRY_SECONDS;
let lockTickMs = 1000;

/** Test seam: compress the unlock countdown. Call with no args to restore. */
export function setLockRetryTiming(opts?: { seconds?: number; tickMs?: number }): void {
  lockRetrySeconds = opts?.seconds ?? LOCK_RETRY_SECONDS;
  lockTickMs = opts?.tickMs ?? 1000;
}

// Styling is applied ONLY when stderr is a real terminal. Under an MCP host or
// a channel session stderr is a captured pipe, where raw escape codes turn a
// helpful message into noise in the log.
const styled = (code: string, s: string): string =>
  process.stderr.isTTY === true ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = (s: string): string => styled("1", s);
const dim = (s: string): string => styled("2", s);

/** Probe returning true when the macOS screen is locked. Injectable for tests. */
export type ScreenLockProbe = () => boolean;

/**
 * macOS screen-lock probe. `ioreg -n Root -d1 -a` renders the console session
 * as an XML plist; `CGSSessionScreenIsLocked` is present ONLY while the screen
 * is locked (absent entirely when unlocked). ~15ms, no dependencies, and it
 * only ever runs on the denial path — zero cost on a normal run.
 *
 * Non-darwin returns false: DesktopAuth exists on other platforms, but there is
 * no equivalent probe, so those users keep today's terminal behavior.
 */
export const defaultScreenLockProbe: ScreenLockProbe = () => {
  if (process.platform !== "darwin") return false;
  try {
    const res = spawnSync("ioreg", ["-n", "Root", "-d1", "-a"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (res.status !== 0 || typeof res.stdout !== "string") return false;
    return /CGSSessionScreenIsLocked<\/key>\s*(?:<true\/>|<integer>1<\/integer>)/.test(res.stdout);
  } catch {
    // Probe failure must never invent a lock — fall back to terminal behavior.
    return false;
  }
};

let screenLockProbe: ScreenLockProbe = defaultScreenLockProbe;

/** Test seam: swap the screen-lock probe. Pass undefined to restore the default. */
export function setScreenLockProbe(probe: ScreenLockProbe | undefined): void {
  screenLockProbe = probe ?? defaultScreenLockProbe;
}

/** True when the macOS screen is currently locked. */
export function isScreenLocked(): boolean {
  return screenLockProbe();
}

// ─── 1Password APP lock (a FOURTH denial cause) ──────────────────────────────
//
// `Denied authorization for SDK client` has a fourth cause, distinct from the
// three above (Cancel / screen locked / concurrent spawn): the 1Password APP
// itself is locked.
//
// When `developers.sdkSharedLockState.enabled` is on — it is by default — the SDK
// is authorized only while the app is unlocked. Once the app auto-locks, the SDK
// is denied IMMEDIATELY and NO dialog is shown, so:
//   · the screen-lock probe stays silent (the screen is unlocked)
//   · it is not a Cancel (nobody was asked)
//   · so the denial was classified terminal, and the user got
//     "GLM/Zhipu API Key is required — export ZHIPU_API_KEY" for a key that
//     is sitting in 1Password.
//
// Measured 2026-07-30: app unlocked 09:29:59, askUnlockAfter 480s, probed at
// 10:35 after 65 min idle → locked; screen unlocked; no 1Password window on
// screen; the SDK call failed in well under the time a human prompt would take.
//
// This is the CHEAPEST of the probes — a single JSON read, no subprocess — and
// like the others it only ever runs on the denial path.

/** Probe returning true when the 1Password app is locked. Injectable for tests. */
export type AppLockProbe = () => boolean;

/**
 * The lock decision, as a PURE function of the settings object and the clock.
 *
 * ⚠️ FALSIFIED — retained only as documentation of an approach that does NOT work.
 * `defaultAppLockProbe` no longer calls this. See its comment for the evidence.
 *
 * Split out from the file read so the rule is testable without touching the
 * developer's real 1Password settings — reading those would make the result
 * depend on whether the machine's app happened to be locked when the suite ran.
 */
export function appLockedFromSettings(settings: unknown, nowSeconds: number): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const s = settings as Record<string, unknown>;

  // If the SDK does NOT share the app's lock state, app lock cannot be the cause
  // of an SDK denial — say so rather than sending the user to unlock something
  // irrelevant.
  if (s["developers.sdkSharedLockState.enabled"] !== true) return false;

  const last = s["security.authenticatedUnlock.deviceBasedUnlock.lastUnlock"];
  const after = s["security.authenticatedUnlock.deviceBasedUnlock.askUnlockAfter"];
  if (typeof last !== "number" || typeof after !== "number") return false;

  return nowSeconds - last > after;
}

/**
 * INERT: always reports "not locked". App-lock detection is unimplemented.
 *
 * A first attempt derived it from the desktop app's settings.json, computing
 * `now - security.authenticatedUnlock.deviceBasedUnlock.lastUnlock >
 * ...askUnlockAfter`. Direct observation falsified it on 2026-07-30:
 *
 *   · settings.json's mtime was 09:29:59 and `lastUnlock` read 09:29:59 — the file
 *     is not rewritten on unlock, so the timestamp is frozen at the last settings
 *     SAVE, not the last unlock. It is not a live signal at all.
 *   · At 13:04 the same app served every secret through the user's op-backed
 *     .env pipe while that formula computed "locked, 13006s idle".
 *   · `askUnlockAfter` (480s) is the device-unlock re-prompt grace, NOT the app
 *     auto-lock — that is `security.autolock.minutes` (60). Two different things.
 *
 * A probe must never INVENT a lock: a false positive relabels an unrelated denial
 * as "go unlock 1Password" and adds a ~30s countdown the user cannot resolve that
 * way, which is worse than the plain error. So this returns false until a signal
 * is verified, and the `LockCause`/countdown/messaging plumbing around it stays
 * ready for one to drop in via `setAppLockProbe`.
 *
 * Candidates not yet validated: `op whoami` behaviour while
 * `developers.cliSharedLockState.enabled` is on (it did report "account is not
 * signed in" during a denial, but that needs the `op` binary and may itself
 * prompt); the agent socket; or timing — a denial returned faster than any human
 * could answer a dialog implies nobody was asked.
 *
 * NOTE the underlying denial was real; only this attribution of its cause was not.
 */
export const defaultAppLockProbe: AppLockProbe = () => false;

let appLockProbe: AppLockProbe = defaultAppLockProbe;

/** Test seam: swap the app-lock probe. Pass undefined to restore the default. */
export function setAppLockProbe(probe: AppLockProbe | undefined): void {
  appLockProbe = probe ?? defaultAppLockProbe;
}

/** True when the 1Password app is locked AND that gates the SDK. */
export function isAppLocked(): boolean {
  return appLockProbe();
}

/** Which recoverable lock caused a denial, or null when it is terminal. */
export type LockCause = "screen" | "app";

/**
 * Which lock is currently blocking, in the order the user must clear them.
 *
 * SINGLE source of the precedence rule — both the retry classifier and the error
 * notice call this, so they cannot drift. They already had: an earlier version
 * checked screen-first for retries and app-first for the message, which told a
 * user with a locked Mac to "unlock 1Password", a step they cannot take until
 * the Mac is open.
 *
 * Screen first is the correct order: a locked Mac makes the app unreachable
 * regardless of the app's own state, so the Mac is the actionable blocker.
 */
export function currentLockCause(): LockCause | null {
  if (isScreenLocked()) return "screen";
  if (isAppLocked()) return "app";
  return null;
}

/**
 * Classify a denial into the lock the user can still clear, or null if none.
 *
 * A service-account token short-circuits everything: token auth never shows a
 * desktop prompt, so a denial under a token means something else entirely
 * (revoked token, vault access) and waiting for an unlock would be theatre.
 */
export function classifyLockedDenial(
  err: unknown,
  env: NodeJS.ProcessEnv = process.env
): LockCause | null {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg.includes("denied authorization")) return null;
  if (env.OP_SERVICE_ACCOUNT_TOKEN) return null;
  return currentLockCause();
}

/**
 * True when an error is a denial the user could plausibly still approve.
 *
 * Retained as the boolean form of `classifyLockedDenial` — callers that only ask
 * "is this worth waiting on?" keep working unchanged.
 */
export function isLockedDenial(err: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return classifyLockedDenial(err, env) !== null;
}

/**
 * Explain the locked denial, then count down before retrying — giving the user
 * time to walk over, unlock, and approve. Returns "cancel" if they bail out.
 *
 * Cancellation degrades by capability rather than by mode (interactive and
 * non-interactive must behave identically): with a TTY stdin, Esc/q/Ctrl-C
 * cancel; without one (e.g. `--stdin < file`), Ctrl-C still works via SIGINT.
 * The countdown itself always renders, so a piped run shows the same story.
 *
 * The live `\r` redraw is used ONLY when stderr is a TTY. Under an MCP host or
 * a channel session stderr is a captured pipe, where carriage returns produce
 * an unreadable log — those get one static line per round instead.
 */
async function countdownForUnlock(
  round: number,
  rounds: number,
  cause: LockCause
): Promise<"retry" | "cancel"> {
  const ttyOut = process.stderr.isTTY === true;
  const ttyIn = process.stdin.isTTY === true;
  let cancelled = false;

  // The explanation prints ONCE, on the first round. Rounds 2 and 3 get only
  // the countdown line — re-explaining the same situation every 10 seconds
  // reads as nagging, and the user is (hopefully) already walking to their Mac.
  //
  // The two causes need DIFFERENT instructions. Telling someone to "approve the
  // popup" when the app is locked is wrong twice over: there is no popup (a
  // locked app denies silently), and the action they need is to unlock 1Password.
  if (round === 1) {
    const explain =
      cause === "screen"
        ? `${bold("🔐 1Password needs your OK — but your Mac is locked, so it can't ask.")}\n   Unlock your Mac and approve the popup. Claudish picks it up from there.`
        : `${bold("🔐 1Password is locked, so it turned claudish away without asking you.")}\n   Unlock 1Password (Touch ID is enough). Claudish retries on its own —\n   no popup will appear until it's unlocked.`;
    process.stderr.write(`\n${explain}\n\n`);
  }

  // Wait on the lock that actually caused this denial. Polling the wrong one
  // would either never clear or clear while the real blocker remains.
  const stillLocked = () => (cause === "screen" ? isScreenLocked() : isAppLocked());

  let restoreInput = () => {};
  if (ttyIn) {
    const onKey = (buf: Buffer) => {
      const k = buf.toString();
      // Esc, q, or Ctrl-C — Ctrl-C is handled here too so raw mode can't eat it.
      if (k === "\x1b" || k === "q" || k === "\x03") cancelled = true;
    };
    const wasRaw = process.stdin.isRaw === true;
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onKey);
      restoreInput = () => {
        process.stdin.off("data", onKey);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
      };
    } catch {
      restoreInput = () => {};
    }
  }

  const stop = ttyIn ? "Esc to stop waiting" : "Ctrl-C to stop waiting";
  const line = (secs: number) => dim(`   waiting ${secs}s · try ${round} of ${rounds} · ${stop}`);
  if (!ttyOut) process.stderr.write(`${line(lockRetrySeconds)}\n`);

  try {
    for (let remaining = lockRetrySeconds; remaining > 0; remaining--) {
      if (cancelled) break;
      // Unlocked early? Don't make the user wait out the clock — retry now, so
      // approving is immediately followed by the prompt they expect.
      if (!stillLocked()) break;
      if (ttyOut) process.stderr.write(`\r\x1b[2K${line(remaining)}`);
      await sdkSleep(lockTickMs);
    }
  } finally {
    restoreInput();
    if (ttyOut) process.stderr.write("\r\x1b[2K");
  }

  if (cancelled) {
    process.stderr.write("   OK, not waiting. You can unlock and re-run any time.\n");
    return "cancel";
  }
  return "retry";
}

/**
 * Run an SDK operation SERIALIZED (never concurrent with another SDK op) and,
 * on a TRANSIENT IPC error, evict the client cache (fresh desktop handshake),
 * pause briefly, and retry — up to 2 retries. Non-transient errors (auth, not
 * found, bad ref) propagate immediately. Serialization is the primary -4 fix;
 * the cache-reset + backoff retries handle a genuinely transient blip.
 *
 * `label` names the op in the startup trace (e.g. "tui:load-fields"). Each
 * attempt records its own queued span ({ attempt, waitMs, execMs }); when the
 * loop retried, the LAST attempt's span additionally gets
 * { attempts, retried, cacheReset } so a retry storm is visible in the metrics.
 */
export async function withSdkRetry<T>(op: () => Promise<T>, label = "op:sdk-op"): Promise<T> {
  // OUTER loop: locked-screen denial recovery. Wrapping (rather than folding
  // into the transient loop) keeps the two concerns separate — the inner loop
  // still owns millisecond-scale IPC blips, while this one owns the
  // human-scale "go unlock your Mac" wait. Every non-locked-denial error
  // propagates from the inner loop completely unchanged.
  for (let round = 1; ; round++) {
    try {
      return await withSdkTransientRetry(op, label);
    } catch (err) {
      // Re-classified every round: the user may unlock the Mac and leave
      // 1Password itself locked, which turns a "screen" round into an "app"
      // round. Pinning the cause once would then wait on a lock that already
      // cleared while the real blocker stayed put.
      const cause = classifyLockedDenial(err);
      if (round > LOCK_RETRY_ROUNDS || cause === null) throw err;
      if ((await countdownForUnlock(round, LOCK_RETRY_ROUNDS, cause)) === "cancel") throw err;
      // Fresh handshake for the retry — the denied client is spent.
      resetSdkClientCache();
    }
  }
}

/** The transient-IPC retry loop (see withSdkRetry for the full contract). */
async function withSdkTransientRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Each attempt runs exclusively — no other SDK call overlaps it.
      const result = await runSdkExclusive(op, label, { attempt });
      if (attempt > 1) addSpanMeta(label, { attempts: attempt, retried: true, cacheReset: true });
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientSdkError(err) || attempt === MAX_ATTEMPTS) {
        if (attempt > 1) addSpanMeta(label, { attempts: attempt, retried: true, cacheReset: true });
        throw err;
      }
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
 * Reads `op`'s OWN notion of the current account — the one a bare `op read` or
 * `op run` would use. Returns its account uuid, or null when `op` is absent,
 * signed out, or answers with anything unexpected.
 *
 * Read-only and never throws, exactly like `defaultOpAccountLister`. Kept
 * separate from it because they answer different questions: `list` enumerates
 * what EXISTS, `get` names which one is CURRENT.
 */
export type OpDefaultAccountProbe = () => string | null;

export const defaultOpDefaultAccountProbe: OpDefaultAccountProbe = () => {
  try {
    const res = spawnSync("op", ["account", "get", "--format=json"], { encoding: "utf-8" });
    if (res.error || res.status !== 0) return null;
    const parsed = JSON.parse(res.stdout ?? "") as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id ? parsed.id : null;
  } catch {
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
    opDefaultAccountProbe?: OpDefaultAccountProbe;
  } = {}
): DesktopAccountResult {
  const env = opts.env ?? process.env;

  // (a) Explicit env override.
  //
  // realValue() drops an unexpanded `${OP_ACCOUNT}` — the literal string a host
  // passes through when the referenced shell variable is unset. This is not
  // hypothetical: the obvious way to configure an account for the MCP server is
  // `"OP_ACCOUNT": "${OP_ACCOUNT}"` in the plugin's .mcp.json, and Claude Code
  // hands that string over verbatim when the variable is missing. Taken at face
  // value it becomes a DesktopAuth account name that cannot exist, so the
  // handshake fails and retries — measured at 4 wasted handshakes, and 4
  // possible 1Password prompts, from one malformed value. Treating it as absent
  // lets resolution fall through to the config account and the `op` default,
  // which is what the user meant.
  const envAccount = realValue(env.OP_ACCOUNT)?.trim();
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
      error: `Could not determine which 1Password account to use (no service-account token, and \`op account list\` is unavailable). ${remediation}`,
    };
  }

  if (accounts.length === 1) {
    return { accountName: accounts[0].url };
  }

  // Multiple accounts.
  if (opts.interactive) {
    return { needsPicker: accounts };
  }

  // (d) Non-interactive with several accounts. Ask `op` which one IT would use.
  //
  // This is the case that made 1Password unusable from every non-TTY caller —
  // the MCP server, --stdin children, team spawns, channel sessions, serve. The
  // old code hard-failed here, which meant `createClient()` was never reached;
  // since the desktop approval dialog is raised BY that call, no dialog could
  // ever appear and the failure looked like silence rather than an error.
  //
  // `op account get` names the account a bare `op read` / `op run` resolves to,
  // so deferring to it makes claudish agree with the tool the user already
  // configured rather than inventing its own policy. It is a read-only probe and
  // costs one fast spawn only on this branch — the single-account, OP_ACCOUNT,
  // and saved-config paths never reach it.
  //
  // The probe returns an account UUID; DesktopAuth wants the account URL, so the
  // uuid is matched back against the enumerated list. A probe that fails, or
  // names an account not in the list, falls through to the original error — this
  // can only turn a guaranteed failure into a success, never the reverse.
  const probe = opts.opDefaultAccountProbe ?? defaultOpDefaultAccountProbe;
  const defaultUuid = probe();
  if (defaultUuid) {
    const match = accounts.find((a) => a.account_uuid === defaultUuid);
    if (match) return { accountName: match.url };
  }

  const listing = accounts.map((a) => `  - ${a.url}${a.email ? ` (${a.email})` : ""}`).join("\n");
  return {
    error: `Multiple 1Password accounts are available, this is a non-interactive session, and \`op\` could not name a default account. ${remediation}\nAccounts:\n${listing}`,
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
    opDefaultAccountProbe?: OpDefaultAccountProbe;
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
    opDefaultAccountProbe: opts.opDefaultAccountProbe,
  });

  if ("accountName" in result) {
    return { kind: "desktop", accountName: result.accountName };
  }

  if ("needsPicker" in result) {
    if (opts.onNeedsPicker) {
      const chosen = await opts.onNeedsPicker(result.needsPicker);
      if (chosen?.trim()) {
        return { kind: "desktop", accountName: chosen.trim() };
      }
    }
    // No picker supplied, or the user aborted — fall through to an error.
    const listing = result.needsPicker
      .map((a) => `  - ${a.url}${a.email ? ` (${a.email})` : ""}`)
      .join("\n");
    throw buildAuthError(
      `Multiple 1Password accounts are available but none was selected.\nAccounts:\n${listing}`
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
      `1Password SDK auth is required for ${context}, but neither OP_SERVICE_ACCOUNT_TOKEN nor a 1Password account (OP_ACCOUNT / onepasswordAccount config) is available.`
    );
  }
  // Startup-trace: every SDK client passes through here, so this is the single
  // point that knows the auth kind for the metrics line ("desktop" | "token").
  setStartupAuthKind(auth.kind);
  const sdkFactory = opts.sdkFactory ?? defaultSdkClientFactory;
  return sdkFactory(auth);
}

/**
 * Map the SDK's resolveAll() response (keyed by op:// reference) back into our
 * `{ envVarName: secret }` shape WITHOUT throwing: per-ref failures are
 * collected alongside the successes. `refs` is the original
 * `{ envVarName: "op://..." }` map so we can re-associate by reference string.
 */
function mapSdkResolveAllPartial(
  refs: Record<string, string>,
  response: {
    individualResponses: Record<string, { content?: { secret: string }; error?: unknown }>;
  }
): { resolved: Record<string, string>; failures: string[] } {
  const responses = response.individualResponses ?? {};
  const resolved: Record<string, string> = {};
  const failures: string[] = [];

  for (const [envVar, ref] of Object.entries(refs)) {
    const entry = responses[ref];
    if (entry?.content && typeof entry.content.secret === "string") {
      resolved[envVar] = entry.content.secret;
      continue;
    }
    if (entry?.error !== undefined) {
      failures.push(`${envVar} (${ref}): ${describeSdkError(entry.error)}`);
      continue;
    }
    failures.push(`${envVar} (${ref}): no value returned`);
  }

  return { resolved, failures };
}

/**
 * All-or-nothing wrapper over mapSdkResolveAllPartial: THROWS a combined error
 * if any requested ref failed to resolve or is missing from the response.
 * (Explicit single-ref callers want loud failure; the full-glob path uses the
 * partial variant instead — one broken field must not sink the whole item.)
 */
function mapSdkResolveAll(
  refs: Record<string, string>,
  response: {
    individualResponses: Record<string, { content?: { secret: string }; error?: unknown }>;
  }
): Record<string, string> {
  const { resolved, failures } = mapSdkResolveAllPartial(refs, response);
  if (failures.length > 0) {
    throw new Error(
      `1Password SDK could not resolve secret reference(s):\n  ${failures.join("\n  ")}`
    );
  }
  return resolved;
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
  const response = await traceSpan(
    "op:secrets.resolveAll",
    () => client.secrets.resolveAll(keys.map((k) => refs[k])),
    { refs: keys.length }
  );
  return mapSdkResolveAll(refs, response);
}

/**
 * Like resolveSecrets, but tolerant of INDIVIDUAL reference failures: the batch
 * result is `{ resolved, failures }` instead of all-or-nothing. Used by the
 * full-glob path (resolveGlobImportAll), where one unresolvable field — e.g. a
 * `tooManyMatchingFields` duplicate label inside a section — must not sink the
 * item's other keys. The whole-BATCH failures (no auth, SDK/IPC error) still
 * throw; only per-ref resolution errors are collected.
 */
export async function resolveSecretsPartial(
  refs: Record<string, string>,
  opts: {
    sdkFactory?: SdkClientFactory;
    auth?: SdkAuth;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ resolved: Record<string, string>; failures: string[] }> {
  const keys = Object.keys(refs);
  if (keys.length === 0) return { resolved: {}, failures: [] };

  const client = await acquireSdkClient(opts, "resolving 1Password secret reference(s)");
  const response = await traceSpan(
    "op:secrets.resolveAll",
    () => client.secrets.resolveAll(keys.map((k) => refs[k])),
    { refs: keys.length }
  );
  return mapSdkResolveAllPartial(refs, response);
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

  const { variables } = await traceSpan("op:environments.getVariables", () =>
    client.environments.getVariables(id)
  );
  if (!Array.isArray(variables) || variables.length === 0) {
    throw new Error(
      `1Password Environment '${id}' resolved to no variables. Check that the Environment ID is correct and contains entries.`
    );
  }

  const out: Record<string, string> = {};
  for (const v of variables) {
    if (v && typeof v.name === "string") out[v.name] = typeof v.value === "string" ? v.value : "";
  }
  return out;
}
