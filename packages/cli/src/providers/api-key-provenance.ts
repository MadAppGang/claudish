/**
 * API Key Provenance — traces where an API key comes from across all resolution layers.
 *
 * Resolution order (first non-empty wins):
 *   1. process.env (shell profile, e.g. ~/.config/env-keys.sh sourced by .zshenv)
 *   2. .env file in CWD (loaded at startup through the allowlist in dotenv-allowlist.ts,
 *      does NOT override existing env vars; read here through the same allowlist)
 *   3. ~/.claudish/config.json apiKeys (loaded at startup, does NOT override existing env vars)
 *
 * Since dotenv and config.json never override, the value in process.env at runtime
 * always comes from whichever source set it first. This module inspects all three
 * sources independently so the user can see what WOULD have been used from each layer.
 *
 * Layer 3 follows the `--config <file>` override (config-override.ts): provenance
 * must read the SAME file the credential authority resolves from, and the layer is
 * labeled with the override's real path so the UI names the file actually in play.
 *
 * VAULT-HYDRATED VALUES: the macOS Keychain and 1Password both deliver their keys
 * by write-through into process.env, so by the time this inspects layer 3 they are
 * indistinguishable from a shell export. Neither can be re-read here cheaply (and
 * re-reading 1Password could prompt), so origin is recovered from the run-scoped
 * records the authority keeps — `isKeychainHydratedVar` / `isOpHydratedVar` — and
 * reported by name rather than as "shell environment".
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isKeychainHydratedVar } from "../auth/credentials/keychain-source.js";
import {
  VERTEX_NO_PROJECT_REMEDY,
  VERTEX_PROJECT_ENV_VARS,
  adcCredentialsPath,
  describeVertexProjectSource,
  peekVertexAdcProject,
  peekVertexProjectOrigin,
} from "../auth/vertex-auth.js";
import { activeGlobalConfigFile, getConfigFileOverride } from "../config-override.js";
import { readAllowedDotenv } from "../dotenv-allowlist.js";
import { isOpHydratedVar } from "./onepassword.js";

/**
 * The global config file this run actually reads. Under a `--config` override
 * that is the override file, NOT the machine one — provenance must inspect the
 * same file the credential authority resolves from, or it mislabels an override
 * key as "shell environment".
 */
function activeConfigPath(): string {
  return activeGlobalConfigFile(join(homedir(), ".claudish", "config.json"));
}

/** Display label for the config layer: the real path when overridden, else the tilde form. */
function configLayerLabel(): string {
  return getConfigFileOverride() ? activeConfigPath() : "~/.claudish/config.json";
}

/**
 * A single resolution layer.
 *
 * SECURITY: `maskedValue` is the ONLY value-derived field. A raw secret must
 * never be stored here — `KeyLayer` is embedded in `KeyProvenance`, which is
 * serialized wholesale by `--probe --json`.
 */
export interface KeyLayer {
  source: string;
  maskedValue: string | null;
  isActive: boolean;
}

/**
 * Where an API key comes from — a REPORTING record, not a credential carrier.
 *
 * SECURITY: this object is serialized wholesale (`--probe --json` prints it via
 * `JSON.stringify`), so it must NEVER hold plaintext key material. It carries
 * presence (`hasValue`), a display mask (`effectiveMasked`), the env-var NAME,
 * and the source label — nothing else. Callers that genuinely need the secret
 * must read it from the credential authority (`auth/credentials/`) directly;
 * do not reintroduce a value field here under any name.
 */
export interface KeyProvenance {
  envVar: string;
  /** True when a key resolved from some layer. Presence only — never the value. */
  hasValue: boolean;
  effectiveMasked: string | null;
  effectiveSource: string;
  layers: KeyLayer[];
  /**
   * What to print INSTEAD of `$envVar` when the credential did not come from an
   * environment variable at all.
   *
   * Undefined for every provider whose credential is an env-var API key — which
   * is all but one — so their lines are unchanged. It exists because Vertex has
   * no API key: it authenticates with Application Default Credentials and
   * addresses a Google Cloud project that may come from the ADC file or
   * `gcloud config`, and a row reading `$VERTEX_PROJECT (not set)` about a
   * working install is worse than no row at all.
   *
   * SECURITY: display-safe by construction, like `effectiveMasked`. A builder
   * that sets it must put no key material in it. Vertex's is a GCP project id,
   * which is an identifier rather than a secret — it appears in every Vertex
   * request URL and in the proxy's own handler log line — so it is shown whole:
   * masking it would hide the one fact the row exists to report, WHICH project
   * this machine will bill.
   */
  effectiveLabel?: string;
}

function maskKey(key: string | undefined | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "***";
  return `${key.substring(0, 8)}...`;
}

/**
 * Resolve the provenance of an API key by checking all possible sources.
 *
 * @param envVar - Primary env var name (e.g. "GEMINI_API_KEY")
 * @param aliases - Alternative env var names to check
 */
export function resolveApiKeyProvenance(envVar: string, aliases?: string[]): KeyProvenance {
  const layers: KeyLayer[] = [];
  let effectiveSource = "not set";

  // Check all env var names (primary + aliases)
  const allVars = [envVar, ...(aliases || [])];

  // Layer 1: .env file in CWD
  const dotenvValue = readDotenvKey(allVars);
  layers.push({
    source: `.env (${resolve(".env")})`,
    maskedValue: maskKey(dotenvValue),
    isActive: false, // determined below
  });

  // Layer 2: the active global config (the --config override file when set)
  const configValue = readConfigKey(envVar);
  layers.push({
    source: configLayerLabel(),
    maskedValue: maskKey(configValue),
    isActive: false,
  });

  // Layer 3: process.env (final runtime value — includes shell profile, dotenv, config.json)
  // Check aliases too
  let runtimeVar = envVar;
  let runtimeValue = process.env[envVar] || null;
  if (!runtimeValue && aliases) {
    for (const alias of aliases) {
      if (process.env[alias]) {
        runtimeVar = alias;
        runtimeValue = process.env[alias]!;
        break;
      }
    }
  }

  layers.push({
    source: `process.env[${runtimeVar}]`,
    maskedValue: maskKey(runtimeValue),
    isActive: !!runtimeValue,
  });

  // Determine which source is active
  if (runtimeValue) {
    if (dotenvValue && dotenvValue === runtimeValue) {
      effectiveSource = ".env";
      layers[0].isActive = true;
      layers[2].isActive = false;
    } else if (configValue && configValue === runtimeValue) {
      effectiveSource = configLayerLabel();
      layers[1].isActive = true;
      layers[2].isActive = false;
    } else if (isKeychainHydratedVar(runtimeVar)) {
      // In process.env, but put there by the keychain step of the credential
      // authority (or the TUI's startup hydration) — not a genuine shell export.
      // Checked BEFORE the 1Password branch because the keychain is resolved
      // first, so a variable both stores could supply was supplied by this one.
      effectiveSource = "macOS Keychain";
      layers[2].source = `process.env[${runtimeVar}] (from macOS Keychain)`;
    } else if (isOpHydratedVar(runtimeVar)) {
      // The value sits in process.env, but it was hydrated from 1Password at
      // startup (op:// ref, glob import, or Environment) — not a genuine shell
      // env var. Report the true origin so the UI doesn't mislabel it "env".
      effectiveSource = "1Password";
      layers[2].source = `process.env[${runtimeVar}] (from 1Password)`;
      // layers[2] already marked active
    } else {
      effectiveSource = "shell environment";
      // layers[2] already marked active
    }
  }

  // NOTE: `runtimeValue` stays local. It is deliberately NOT placed on the
  // returned record — see the KeyProvenance doc comment.
  return {
    envVar: runtimeVar,
    hasValue: !!runtimeValue,
    effectiveMasked: maskKey(runtimeValue),
    effectiveSource,
    layers,
  };
}

/**
 * Provenance for ONE provider's credential — the entry point every display
 * surface should call.
 *
 * Identical to {@link resolveApiKeyProvenance} for every provider whose
 * credential is an env-var API key. It exists for the one that is not: Vertex
 * resolves a PROJECT (not a key) from the environment, the ADC file's
 * `quota_project_id`, or `gcloud config`, so the env/config layers alone report
 * "not set" about an install that works perfectly.
 *
 * The branch lives here, in the module that owns provenance, rather than in each
 * of the four call sites (`--probe`'s three chain builders and the handler log).
 * Four copies of one provider rule is the second-table coupling this codebase
 * keeps paying for.
 */
export function resolveCredentialProvenance(
  provider: string,
  envVar: string,
  aliases?: string[]
): KeyProvenance {
  if (provider === "vertex") return vertexProjectProvenance(envVar, aliases);
  return resolveApiKeyProvenance(envVar, aliases);
}

/**
 * Vertex's provenance: the env/config layers, PLUS the two tiers
 * `resolveVertexConfig` consults that no environment inspection can see.
 *
 * `GOOGLE_CLOUD_PROJECT` is passed as an alias because `resolveVertexConfig`
 * reads it — not because `API_KEY_MAP` lists it. The variable list comes from
 * `VERTEX_PROJECT_ENV_VARS`, the same constant the resolution uses, so this
 * cannot drift from what actually decides the project.
 *
 * The non-env tiers are read through `peekVertexProjectOrigin`, which is sync
 * and never shells out; a project that only `gcloud config` knows therefore
 * shows up here once anything async (the credential authority, a probe, a real
 * request) has resolved it. Until then this reports the honest "no project yet"
 * with both remedies, never a missing API key.
 */
function vertexProjectProvenance(envVar: string, aliases?: string[]): KeyProvenance {
  const envNames = [...new Set([envVar, ...(aliases ?? []), ...VERTEX_PROJECT_ENV_VARS])];
  const base = resolveApiKeyProvenance(envNames[0], envNames.slice(1));
  const origin = peekVertexProjectOrigin();
  // Always shown, value included when known, so a project the ADC file holds is
  // visible even while an env var shadows it — the same "(shadowed)" honesty the
  // config layer already gets.
  const adc = peekVertexAdcProject();
  const adcLayer: KeyLayer = {
    source: `${adcCredentialsPath()} (quota_project_id)`,
    maskedValue: adc?.projectId ?? null,
    isActive: origin?.source === "adc-file",
  };
  const gcloudLayer: KeyLayer = {
    source: "`gcloud config get project`",
    maskedValue: origin?.source === "gcloud-config" ? origin.projectId : null,
    isActive: origin?.source === "gcloud-config",
  };

  if (!origin) {
    return {
      ...base,
      hasValue: false,
      effectiveMasked: null,
      effectiveLabel: "no project",
      effectiveSource: VERTEX_NO_PROJECT_REMEDY,
      layers: [...base.layers, adcLayer, gcloudLayer],
    };
  }
  if (origin.source === "env") {
    // The env tiers are exactly what `resolveApiKeyProvenance` already models —
    // including .env and the config file, which reach Vertex the same way they
    // reach any other provider. Only the two extra layers are appended.
    return { ...base, layers: [...base.layers, adcLayer, gcloudLayer] };
  }
  return {
    ...base,
    hasValue: true,
    // The project id, whole and unmasked — see `KeyProvenance.effectiveLabel`.
    effectiveMasked: origin.projectId,
    effectiveLabel: `project ${origin.projectId}`,
    effectiveSource: describeVertexProjectSource(origin),
    // Nothing in the environment supplied the value, so no env layer is active.
    layers: [...base.layers.map((l) => ({ ...l, isActive: false })), adcLayer, gcloudLayer],
  };
}

/**
 * Format provenance for debug log output (single line).
 */
export function formatProvenanceLog(p: KeyProvenance): string {
  if (!p.hasValue) {
    return p.effectiveLabel ? `${p.effectiveLabel}: ${p.effectiveSource}` : `${p.envVar}=(not set)`;
  }
  if (p.effectiveLabel) {
    return `${p.effectiveLabel} [from: ${p.effectiveSource}]`;
  }
  return `${p.envVar}=${p.effectiveMasked} [from: ${p.effectiveSource}]`;
}

/**
 * Format provenance for --probe TUI output (multi-line with all layers).
 */
export function formatProvenanceProbe(p: KeyProvenance, indent = "    "): string[] {
  const lines: string[] = [];

  if (!p.hasValue) {
    // `effectiveLabel` carries the remedy for a provider with no env-var key at
    // all (Vertex), where "VERTEX_PROJECT: not set" is the wrong instruction.
    lines.push(
      p.effectiveLabel
        ? `${indent}${p.effectiveLabel}: ${p.effectiveSource}`
        : `${indent}${p.envVar}: not set`
    );
    return lines;
  }

  lines.push(
    p.effectiveLabel
      ? `${indent}${p.effectiveLabel}  [from: ${p.effectiveSource}]`
      : `${indent}${p.envVar} = ${p.effectiveMasked}  [from: ${p.effectiveSource}]`
  );

  for (const layer of p.layers) {
    const marker = layer.isActive ? ">>>" : "   ";
    const value = layer.maskedValue || "(not set)";
    lines.push(`${indent}  ${marker} ${layer.source}: ${value}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readDotenvKey(envVars: string[]): string | null {
  try {
    const dotenvPath = resolve(".env");
    if (!existsSync(dotenvPath)) return null;
    const parsed = readAllowedDotenv(readFileSync(dotenvPath, "utf-8"));
    for (const v of envVars) {
      if (parsed[v]) return parsed[v];
    }
    return null;
  } catch {
    return null;
  }
}

function readConfigKey(envVar: string): string | null {
  try {
    const configPath = activeConfigPath();
    if (!existsSync(configPath)) return null;
    const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as {
      apiKeys?: Record<string, string>;
    };
    return cfg.apiKeys?.[envVar] || null;
  } catch {
    return null;
  }
}
