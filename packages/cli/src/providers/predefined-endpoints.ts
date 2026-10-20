/**
 * Activation for the BUNDLED endpoint catalog.
 *
 * A catalog row is compiled into exactly the `CustomEndpointComplex` object a
 * user would have hand-written and handed to `registerEndpoint()` — the same
 * validate → definition → profile → register×3 sequence user config travels. So
 * there is no new request path here, no new transport, no new
 * `PROVIDER_PROFILES` entry, and nothing that can silently mis-route. What this
 * module owns is only the four questions the loader cannot answer for itself:
 * may this row register at all, should it, where does its key come from, and
 * where does it point.
 *
 * ── The activation predicate, and why it is ordered the way it is ───────────
 *
 * A row registers iff:
 *
 *     NOT globally disabled          (config `enabled: false`, or
 *                                     CLAUDISH_NO_PREDEFINED_ENDPOINTS=1)
 *  AND NOT a duplicate of an earlier row
 *  AND NOT colliding with a builtin name/shortcut/legacy prefix or picker alias
 *  AND NOT already registered at run time
 *  AND NOT replaced by a user `customEndpoints` entry of the same name
 *  AND NOT individually disabled
 *  AND (a locally-present credential OR an explicit `enable` entry)
 *  AND its base URL resolves
 *
 * REFUSALS come before PERMISSIONS. A user may opt IN to a vendor they have no
 * key for; a user may not opt in to shadowing a builtin, because the thing the
 * collision check prevents is not an inconvenience to them — it is one
 * provider quietly answering in another's namespace, which is this project's
 * worst documented failure class.
 *
 * The base-URL check is the one refusal placed AFTER the permission gate, and
 * deliberately: it is scoped to rows that would otherwise activate, so a stray
 * `*_BASE_URL` belonging to a vendor the user has no key for produces silence
 * rather than a warning about a provider they never asked for.
 *
 * ── Why registration itself is what gets gated ──────────────────────────────
 *
 * There is no "registered but hidden" state: `buildProviderDefinition` sets
 * `shortcuts: [name]`, and both the picker's provider list (`isPickableProvider`) and
 * the `@prefix` alias table are DERIVED from that. The picker's own list is
 * credential-filtered, but `getProviderFilterAliases()` is not — so registering
 * every bundled vendor unconditionally would pollute the `@prefix` namespace
 * and its partial-match resolver with vendors that cannot serve a request, and
 * would cost one async credential resolution per row per picker open, each able
 * to open a 1Password handshake on a machine where concurrent handshakes are
 * arbitrated globally.
 *
 * Which is why the credential question is asked with `hasLocalApiKey()` — env →
 * aliases → `config.apiKeys`, and SYNCHRONOUS, which is the whole guarantee:
 * the 1Password SDK sits behind an `await` inside the authority's async
 * `resolveKey`, so a path that cannot await cannot reach it. Note that this is
 * sync-ness, NOT import-graph isolation — `op-source` and `@1password/sdk` are
 * in this module's static import closure via `custom-endpoints-loader` →
 * `authority` → `api-key-credential`, so an `await` added anywhere on the
 * registration path would re-open the door without changing a signature.
 * `hasLocalApiKey` is used and NOT `credentials.isAvailable()`: a bundled row
 * is not in the authority's map until `registerEndpoint` puts it there, so that
 * call answers `false` for every row and the catalog would never activate at all.
 *
 * Consequence, stated plainly: a key that lives ONLY behind an `op://`
 * reference cannot activate a row, because activation is sync and 1Password is
 * async. Once a row IS active its op:// key resolves through the normal
 * authority path with no special-casing (the compiled entry carries
 * `apiKey: "${VENDOR_API_KEY}"`, so the declared-key step returns `undefined`
 * when the var is unset and the async step runs). The escape hatches are
 * `predefinedEndpoints.enable`, or exporting the variable.
 *
 * Everything here is NON-FATAL: warn to stderr, skip the row, continue. There
 * is no `process.exit` in this feature, on the precedent that a bad import must
 * never lock a user out of `claudish config`.
 */

import { keychainHasAnyOf } from "../auth/credentials/keychain-source.js";
import { hasLocalApiKey } from "../auth/credentials/local-api-key.js";
import {
  type CustomEndpointComplex,
  type PredefinedEndpointsConfig,
  PredefinedEndpointsConfigSchema,
} from "../config-schema.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import {
  type EndpointDefinitionOverrides,
  classifyEndpointBaseUrl,
  describeBadBaseUrlOverride,
  registerEndpoint,
} from "./custom-endpoints-loader.js";
import { recordEndpointUnavailable } from "./endpoint-diagnostics.js";
import { customEndpointKeyEnvVar } from "./endpoint-key-env.js";
import { PREDEFINED_ENDPOINTS } from "./predefined-catalog.js";
import type { PredefinedEndpoint } from "./predefined-endpoint-schema.js";
// The reserved-namespace guard is SHARED with the user-authored customEndpoints
// path (see #191) — one definition so the two halves cannot disagree about
// which names a builtin already owns.
import { reservedNamespace } from "./reserved-namespace.js";
import { getRuntimeProviders } from "./runtime-providers.js";

/** Env kill switch, mirroring `CLAUDISH_DISABLE_OP` / `CLAUDISH_NO_OP_HANDSHAKE_LOCK`. */
const KILL_SWITCH_ENV = "CLAUDISH_NO_PREDEFINED_ENDPOINTS";

export interface PredefinedLoadResult {
  /** Names registered by this call, in catalog order. */
  registered: string[];
  /** Names deliberately not registered, with the reason (for diagnostics/tests). */
  skipped: Array<{ name: string; reason: string }>;
}

// ── Warn-once ───────────────────────────────────────────────────────────────
// `ensureEndpointsRegistered()` is called from six sites and re-runnable on
// demand, so an un-deduplicated warning becomes a wall. Same shape as
// `op-source.ts`'s warnOnce, deliberately: keyed on the rendered message, so
// two different collisions still both print.

const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.error(message);
}

/**
 * Names THIS module registered, so a re-evaluation can tell its own previous
 * work from a foreign registration.
 *
 * Without it, the config TUI's forced re-run (a 1Password key imported without
 * a restart) sees every row it registered a moment ago sitting in the runtime
 * registry and reports each as "a provider of that name is already registered"
 * — a warning about itself, naming a conflict that does not exist. Membership
 * is only trusted while the runtime registry still holds the name, so a cleared
 * registry falls back to the ordinary path.
 */
const ownRegistrations = new Set<string>();

/** Test-only: forget emitted warnings and prior registrations. */
export function __resetPredefinedStateForTests(): void {
  warnedMessages.clear();
  ownRegistrations.clear();
}

// ── Catalog seam ────────────────────────────────────────────────────────────

let catalogOverride: readonly PredefinedEndpoint[] | null = null;

/**
 * Test-only: replace the shipped catalog (pass `null` to restore it).
 *
 * Activation behaviour has to be provable against rows chosen for the case
 * under test — a collision row, a duplicate pair, a row with a base-URL
 * override — and pinning those tests to whichever vendors happen to ship would
 * make the shipped catalog un-editable without breaking them.
 */
export function __setPredefinedCatalogForTests(rows: readonly PredefinedEndpoint[] | null): void {
  catalogOverride = rows;
}

function activeCatalog(): readonly PredefinedEndpoint[] {
  return catalogOverride ?? PREDEFINED_ENDPOINTS;
}

// ── Opt-out config (R5) ─────────────────────────────────────────────────────

interface OptOut {
  /** The whole catalog is off. */
  disabled: boolean;
  /** Lowercased names the user opted OUT of. */
  disable: Set<string>;
  /** Lowercased names the user opted IN to regardless of credential. */
  enable: Set<string>;
}

/**
 * Read `config.predefinedEndpoints` plus the env kill switch.
 *
 * An invalid block warns once and is treated as ABSENT rather than as "off":
 * a typo in an opt-out section must not silently remove providers the user is
 * relying on, and it must never be fatal.
 */
function readOptOut(config: ClaudishProfileConfig | undefined): OptOut {
  const off: OptOut = { disabled: true, disable: new Set(), enable: new Set() };
  if (process.env[KILL_SWITCH_ENV] === "1") return off;

  const raw = config?.predefinedEndpoints;
  let parsed: PredefinedEndpointsConfig = {};
  if (raw !== undefined) {
    const result = PredefinedEndpointsConfigSchema.safeParse(raw);
    if (result.success) {
      parsed = result.data;
    } else {
      warnOnce(
        "[claudish] config 'predefinedEndpoints' is not valid and was ignored: " +
          result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join(", ")
      );
    }
  }

  return {
    disabled: parsed.enabled === false,
    disable: new Set((parsed.disable ?? []).map((n) => n.trim().toLowerCase())),
    // `disable` beats `enable`, so a name in both is simply never permitted.
    enable: new Set((parsed.enable ?? []).map((n) => n.trim().toLowerCase())),
  };
}

// ── Compilation ─────────────────────────────────────────────────────────────

/**
 * A catalog row as the `CustomEndpointComplex` a user would have written.
 *
 * `kind: "complex"` ALWAYS — `buildSimpleHandler` hardcodes
 * `apiPath: "/chat/completions"`, and rows whose vendor does not use
 * `/v1/chat/completions` are precisely the ones a bundled catalog exists to
 * save people from getting wrong.
 *
 * `apiKey: "${VENDOR_API_KEY}"` is the small trick that makes the whole feature
 * reuse existing code rather than adding a key path: `resolveCustomEndpointApiKey`
 * expands it, `resolveDeclaredEndpointKey` returns `undefined` when the var is
 * unset (so the async op:// step still runs at REQUEST time), and `realValue()`
 * drops it if the placeholder never expands.
 */
function compileToCustomEndpoint(entry: PredefinedEndpoint): CustomEndpointComplex {
  return {
    kind: "complex",
    displayName: entry.displayName,
    transport: entry.format,
    baseUrl: entry.baseUrl,
    apiPath: entry.apiPath,
    apiKey: `\${${entry.apiKeyEnvVar}}`,
    authScheme: entry.authScheme,
    headers: entry.headers,
    modelPrefix: entry.modelPrefix,
  };
}

/**
 * The credential env vars a row answers to, primary first.
 *
 * `CUSTOM_<NAME>_KEY` is appended as an ALIAS, never as the primary: the
 * missing-key error, the config TUI and the sign-time header all name the
 * primary, and naming a synthesized variable the vendor's own docs never
 * mention would invert the reason the row carries a conventional name at all.
 * The sanctioned way to OVERRIDE a bundled row is a `customEndpoints` entry —
 * one mechanism for overriding, not two.
 */
function credentialEnvVars(entry: PredefinedEndpoint): { envVar: string; aliases: string[] } {
  return {
    envVar: entry.apiKeyEnvVar,
    aliases: [...(entry.apiKeyAliases ?? []), customEndpointKeyEnvVar(entry.name)],
  };
}

function overridesFor(entry: PredefinedEndpoint): EndpointDefinitionOverrides {
  const { envVar, aliases } = credentialEnvVars(entry);
  return {
    apiKeyEnvVar: envVar,
    apiKeyAliases: aliases,
    baseUrlEnvVars: entry.baseUrlEnvVars,
    apiKeyUrl: entry.apiKeyUrl ?? "",
    apiKeyDescription: `${entry.displayName} (${envVar})`,
    description: entry.description ?? `${entry.displayName} (bundled endpoint)`,
  };
}

// ── The loader ──────────────────────────────────────────────────────────────

/**
 * Register every bundled endpoint the activation predicate admits.
 *
 * `config` MUST be the same object the user-endpoint half reads. That is not
 * stylistic: the suppression set (R4) is `Object.keys(config.customEndpoints)`,
 * and if it were built from a WIDER config scope than `loadCustomEndpoints`
 * reads, a project-scoped `customEndpoints.groq` would suppress the bundled row
 * while its replacement — loaded from global config only — never registers, and
 * `groq@` would become an unknown provider for a vendor the user had just
 * configured. `ensureEndpointsRegistered()` reads `loadConfig()` ONCE and hands
 * the same object to both halves, which is what makes that impossible rather
 * than merely unlikely.
 *
 * Idempotent: the runtime registry is a Map keyed on name, warnings are
 * deduplicated, and re-running with the same inputs produces the same registry.
 */
export function loadPredefinedEndpoints(
  config: ClaudishProfileConfig | undefined,
  opts: { catalog?: readonly PredefinedEndpoint[] } = {}
): PredefinedLoadResult {
  const result: PredefinedLoadResult = { registered: [], skipped: [] };
  const optOut = readOptOut(config);
  const catalog = opts.catalog ?? activeCatalog();
  const runtime = getRuntimeProviders();

  /**
   * Skip a row that THIS process previously registered.
   *
   * Re-evaluation only ADDS — `registerRuntimeProvider` is a `Map.set` with no
   * removal, and the same name is also live in the credential authority, the
   * derived `@prefix` alias table and any handler cache built since. So a user
   * who disables a vendor in the config TUI (or whose key stops resolving)
   * keeps `groq@` answering for the rest of the process.
   *
   * De-registration was considered and NOT built: its only consumer is a config
   * edit made mid-session, and a partial removal — definition gone, credential
   * or cached handler still present — is a worse failure than a stale provider,
   * because it produces a provider that half-exists. What was missing is that
   * the user had no way to know, so "I turned it off and it kept answering"
   * read as a bug rather than as a restart requirement. Now it says so.
   */
  const noteStale = (entry: PredefinedEndpoint, name: string, reason: string) => {
    if (!ownRegistrations.has(name) || !runtime.has(entry.name)) return;
    warnOnce(
      `[claudish] predefined endpoint '${entry.name}' is no longer eligible (${reason}) but stays ` +
        "registered for the rest of this process — runtime provider registration cannot be " +
        "undone. Restart claudish to apply the change."
    );
  };

  if (optOut.disabled) {
    for (const entry of catalog) {
      result.skipped.push({ name: entry.name, reason: "catalog off" });
      noteStale(entry, entry.name.toLowerCase(), "catalog off");
    }
    return result;
  }

  const reserved = reservedNamespace();
  const userEndpoints = new Set(
    Object.keys(config?.customEndpoints ?? {}).map((n) => n.toLowerCase())
  );
  const seen = new Set<string>();

  for (const entry of catalog) {
    const name = entry.name.toLowerCase();
    const skip = (reason: string) => result.skipped.push({ name: entry.name, reason });
    // For the refusals that can only follow a PRIOR successful registration by
    // this module. Deliberately not applied to "duplicate row" (where
    // `ownRegistrations` legitimately holds the name from the FIRST row of the
    // same name, so a uniform hook would warn about a row that is working
    // correctly), nor to "collides with builtin" / "already registered", which
    // can never have registered in the first place.
    const skipStale = (reason: string) => {
      skip(reason);
      noteStale(entry, name, reason);
    };

    // ── refusals ────────────────────────────────────────────────────────────

    // Edge case 2: first row wins, deterministically, because array order is
    // stable data. The second is a maintainer error, so it is loud.
    if (seen.has(name)) {
      warnOnce(
        `[claudish] predefined endpoint '${entry.name}' appears more than once in the bundled ` +
          "catalog. The first row wins; the later one is ignored."
      );
      skip("duplicate row");
      continue;
    }
    seen.add(name);

    const owner = reserved.get(name);
    if (owner) {
      const reason =
        `'${entry.name}' is already claimed by builtin provider '${owner}' ` +
        "(as its name, a shortcut, or a legacy prefix)";
      warnOnce(
        `[claudish] predefined endpoint '${entry.name}' skipped: ${reason}. ` +
          "The builtin wins; the bundled entry is inactive."
      );
      recordEndpointUnavailable(entry.name, `bundled endpoint was skipped because ${reason}`);
      skip("collides with builtin");
      continue;
    }

    if (runtime.has(entry.name) && !ownRegistrations.has(name)) {
      // Not necessarily an error — a user endpoint registered first is the
      // documented replacement path — but it IS worth naming, because a bundled
      // row silently not applying is otherwise indistinguishable from absence.
      warnOnce(
        `[claudish] predefined endpoint '${entry.name}' skipped: a provider named ` +
          `'${entry.name}' is already registered for this process.`
      );
      skip("already registered");
      continue;
    }

    // R4: a user's own entry REPLACES the bundled one entirely — not a merge.
    // The user entry is registered by `loadCustomEndpoints` at its own call
    // site, so all that is needed here is to stand aside. Suppression rather
    // than write-order because `ensureEndpointsRegistered` runs from six sites
    // and "whoever registers last wins" is a guarantee a future reordering
    // would silently flip.
    if (userEndpoints.has(name)) {
      // Announced ONLY when the vendor's own variable is actually set, because
      // that is exactly when the replacement surprises: the user's entry gets
      // `CUSTOM_<NAME>_KEY`, so a perfectly good VENDOR_API_KEY sitting in the
      // environment is now ignored — silently, and from neither file's point of
      // view. With no such key there is nothing to be surprised by, and an
      // unconditional line would print on every launch of a correct config,
      // into a stderr that during an interactive session is Claude Code's own
      // TTY.
      if (hasLocalApiKey({ envVar: entry.apiKeyEnvVar })) {
        warnOnce(
          `[claudish] customEndpoints['${entry.name}'] replaces the bundled entry entirely; ` +
            `${entry.apiKeyEnvVar} no longer applies to it. Add ` +
            `"apiKey": "\${${entry.apiKeyEnvVar}}" to that entry to keep using it.`
        );
      }
      skipStale("replaced by customEndpoints");
      continue;
    }

    if (optOut.disable.has(name)) {
      skipStale("disabled in config");
      continue;
    }

    // ── permissions ─────────────────────────────────────────────────────────

    const { envVar, aliases } = credentialEnvVars(entry);
    // The keychain is OR-ed in as a PRESENCE check only. Registration cannot
    // await, and a per-variable keychain value read costs ~17ms — but
    // `keychainHasAnyOf` answers for every vendor from ONE enumerate call, so
    // the gate stays affordable. Deliberately not folded into
    // `hasLocalApiKey`: that function IS the authority's value-resolution step
    // (see local-api-key.ts), and widening it would change what every provider
    // in claudish signs requests with, which is not an endpoints decision.
    const permitted =
      optOut.enable.has(name) ||
      hasLocalApiKey({ envVar, aliases }) ||
      keychainHasAnyOf([envVar, ...(aliases ?? [])]);
    if (!permitted) {
      skipStale("no local credential");
      continue;
    }

    // ── the base URL has to exist before anything is registered ─────────────
    //
    // Checked at the gate as well as at handler build: at the gate so a
    // malformed override never produces a provider that cannot serve, and at
    // handler build so a URL exported AFTER startup is checked too.
    const resolvedUrl = classifyEndpointBaseUrl(entry.baseUrl, entry.baseUrlEnvVars);
    if (!resolvedUrl.ok) {
      const detail = describeBadBaseUrlOverride(resolvedUrl, entry.baseUrl);
      warnOnce(`[claudish] predefined endpoint '${entry.name}' skipped: ${detail}`);
      recordEndpointUnavailable(entry.name, detail);
      skipStale("invalid base URL override");
      continue;
    }

    try {
      registerEndpoint(entry.name, compileToCustomEndpoint(entry), overridesFor(entry));
      ownRegistrations.add(name);
      result.registered.push(entry.name);
    } catch (err) {
      // A malformed row fails exactly where a malformed USER row fails — same
      // Zod schema, same non-fatal warn-and-skip. It should be impossible (the
      // catalog is type-checked and CI-validated), which is precisely why it
      // must not be able to take startup down when it happens anyway.
      warnOnce(
        `[claudish] predefined endpoint '${entry.name}' skipped: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      skip("invalid catalog row");
    }
  }

  return result;
}
