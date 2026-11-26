/**
 * TrustedRouter live model catalog: `GET /v1/models`.
 *
 * TrustedRouter serves an OpenAI-compatible model catalog (`{ data: [...] }`)
 * where each row carries pricing (USD per token), context window, supported
 * parameters, and a `trustedrouter` metadata block with chat/visibility flags
 * (`supports_chat`, `internal_only`, `configuration_hidden`,
 * `synthetic_monitor`), tool capabilities, and `nyte/*` route aliases.
 *
 * - Non-chat and internal/hidden/synthetic rows are excluded.
 * - Remaining chat rows report `reported: "chat"` so every public route
 *   (including routing pools like `trustedrouter/auto`, `trustedrouter/zdr`,
 *   `trustedrouter/e2e`, and vendor ids not in the cloud catalog) survives the
 *   picker and `/model` lineup chat filter.
 * - Pricing is converted from USD/token to USD/1M tokens so both the picker
 *   and dynamic cost estimation display live per-model rates.
 * - Aliases from `trustedrouter.aliases` (such as `nyte/*` routes) are
 *   preserved on each row so availability checks, context-window lookups, and
 *   pricing resolve both canonical ids and aliases.
 */

import { credentials } from "../../auth/credentials/authority.js";
import { VERSION } from "../../version.js";
import type { DiscoveredModel, FetcherResult } from "../model-discovery.js";
import { getEffectiveBaseUrl, getProviderByName } from "../provider-definitions.js";

const FETCH_TIMEOUT_MS = 15_000;
const MIN_CREATED_SECONDS = 946_684_800; // 2000-01-01
const MAX_CREATED_SECONDS = 4_102_444_800; // 2100-01-01

export const TRUSTEDROUTER_BASE_URL = "https://api.trustedrouter.com/v1";
export const TRUSTEDROUTER_MODELS_PATH = "/models";

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface TrustedRouterRowMeta {
  supports_chat?: unknown;
  internal_only?: unknown;
  configuration_hidden?: unknown;
  synthetic_monitor?: unknown;
  aliases?: unknown;
  capabilities?: { tools?: unknown };
  prompt_price_microdollars_per_million_tokens?: unknown;
  completion_price_microdollars_per_million_tokens?: unknown;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function readCreatedDate(raw: unknown): string | undefined {
  const seconds =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds)) return undefined;
  if (seconds < MIN_CREATED_SECONDS || seconds > MAX_CREATED_SECONDS) return undefined;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function readContextWindow(row: Record<string, unknown>): number | undefined {
  const topProvider =
    row.top_provider && typeof row.top_provider === "object"
      ? (row.top_provider as Record<string, unknown>)
      : undefined;
  return (
    positiveNumber(row.context_length) ??
    positiveNumber(topProvider?.context_length) ??
    positiveNumber(row.context_window) ??
    positiveNumber(row.max_context_length)
  );
}

function roundUsdPerMillion(usdPerToken: number): number {
  return Number((usdPerToken * 1_000_000).toPrecision(12));
}

function readPricing(
  row: Record<string, unknown>,
  meta: TrustedRouterRowMeta | undefined
): { input: number; output: number } | undefined {
  if (row.pricing && typeof row.pricing === "object") {
    const pricing = row.pricing as Record<string, unknown>;
    const prompt = nonNegativeNumber(pricing.prompt);
    const completion = nonNegativeNumber(pricing.completion);
    if (prompt !== undefined && completion !== undefined) {
      return {
        input: roundUsdPerMillion(prompt),
        output: roundUsdPerMillion(completion),
      };
    }
  }
  const promptMicro = nonNegativeNumber(meta?.prompt_price_microdollars_per_million_tokens);
  const completionMicro = nonNegativeNumber(meta?.completion_price_microdollars_per_million_tokens);
  if (promptMicro !== undefined && completionMicro !== undefined) {
    return {
      input: Number((promptMicro / 1_000_000).toPrecision(12)),
      output: Number((completionMicro / 1_000_000).toPrecision(12)),
    };
  }
  return undefined;
}

function readAliases(id: string, meta: TrustedRouterRowMeta | undefined): string[] | undefined {
  if (!Array.isArray(meta?.aliases)) return undefined;
  const seen = new Set<string>([id.toLowerCase()]);
  const aliases: string[] = [];
  for (const entry of meta.aliases) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(trimmed);
  }
  return aliases.length > 0 ? aliases : undefined;
}

function readSupportsTools(
  row: Record<string, unknown>,
  meta: TrustedRouterRowMeta | undefined
): boolean | undefined {
  if (typeof meta?.capabilities?.tools === "boolean") {
    return meta.capabilities.tools;
  }
  if (
    Array.isArray(row.supported_parameters) &&
    row.supported_parameters.some((p) => p === "tools")
  ) {
    return true;
  }
  return undefined;
}

function readOutputModalities(row: Record<string, unknown>): string[] | undefined {
  const arch =
    row.architecture && typeof row.architecture === "object"
      ? (row.architecture as Record<string, unknown>)
      : undefined;
  if (!Array.isArray(arch?.output_modalities)) return undefined;
  return arch.output_modalities.filter((v): v is string => typeof v === "string");
}

function isExcludedRow(
  row: Record<string, unknown>,
  meta: TrustedRouterRowMeta | undefined
): boolean {
  return (
    meta?.internal_only === true ||
    meta?.configuration_hidden === true ||
    meta?.synthetic_monitor === true ||
    row.supports_chat === false ||
    meta?.supports_chat === false
  );
}

function readDisplayName(row: Record<string, unknown>): string | undefined {
  if (typeof row.name === "string" && row.name.trim()) return row.name.trim();
  if (typeof row.display_name === "string" && row.display_name.trim()) {
    return row.display_name.trim();
  }
  return undefined;
}

function parseTrustedRouterRow(raw: unknown): DiscoveredModel | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const rawId = row.id;
  if (typeof rawId !== "string" || rawId.trim().length === 0) return null;
  const id = rawId.trim();

  const meta =
    row.trustedrouter && typeof row.trustedrouter === "object"
      ? (row.trustedrouter as TrustedRouterRowMeta)
      : undefined;
  if (isExcludedRow(row, meta)) return null;

  const outputModalities = readOutputModalities(row);
  const reported =
    outputModalities && outputModalities.length > 0 && !outputModalities.includes("text")
      ? ("not-chat" as const)
      : ("chat" as const);

  const displayName = readDisplayName(row);
  const contextWindow = readContextWindow(row);
  const releaseDate = readCreatedDate(row.created);
  const pricing = readPricing(row, meta);
  const aliases = readAliases(id, meta);
  const supportsTools = readSupportsTools(row, meta);

  return {
    id,
    ...(displayName ? { displayName } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    reported,
    ...(supportsTools !== undefined ? { supportsTools } : {}),
    ...(pricing ? { pricing } : {}),
    ...(aliases ? { aliases } : {}),
  };
}

/**
 * Parse a TrustedRouter `/v1/models` body into offered chat rows, or null when
 * the body does not carry a `data` array. Exported for unit testing.
 */
export function parseTrustedRouterModels(body: unknown): DiscoveredModel[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;

  const models: DiscoveredModel[] = [];
  for (const raw of data) {
    const parsed = parseTrustedRouterRow(raw);
    if (parsed) models.push(parsed);
  }
  return models;
}

/** Resolve the effective TrustedRouter `/models` discovery URL. */
export function resolveTrustedRouterModelsEndpoint(): string {
  const def = getProviderByName("trustedrouter");
  const base = (def ? getEffectiveBaseUrl(def) : TRUSTEDROUTER_BASE_URL).replace(/\/+$/, "");
  const path = def?.modelDiscovery?.path ?? TRUSTEDROUTER_MODELS_PATH;
  return `${base}${path}`;
}

/** The `trustedrouter-models` fetcher. Never throws. */
export async function fetchTrustedRouterModelsCatalog(): Promise<FetcherResult> {
  const endpoint = resolveTrustedRouterModelsEndpoint();

  // `GET /v1/models` is public, so missing credentials never block catalog
  // discovery; when a key is configured, forward it so account-scoped routes
  // or invalid keys are honoured by the upstream endpoint.
  let authHeaders: Record<string, string> = {};
  try {
    const auth = await credentials.getRequestAuth("trustedrouter", { model: "" });
    authHeaders = { ...auth.headers };
  } catch {
    // Public catalog endpoint: proceed without Authorization header.
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "User-Agent": `claudish/${VERSION}`,
        ...authHeaders,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: "failed",
      failure: { kind: "unreachable", endpoint, detail: oneLine(String(err)) },
    };
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = oneLine(await response.text());
    } catch {
      /* status alone is still actionable */
    }
    return {
      kind: "failed",
      failure: {
        kind: response.status === 401 || response.status === 403 ? "unauthorized" : "http-error",
        endpoint,
        status: response.status,
        detail,
      },
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", failure: { kind: "malformed", endpoint } };
  }

  const models = parseTrustedRouterModels(body);
  if (!models) {
    return {
      kind: "failed",
      failure: { kind: "malformed", endpoint, detail: "the response carried no `data` array" },
    };
  }

  return { kind: "models", models, endpoint };
}
