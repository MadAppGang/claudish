/**
 * The Muse Code account's dynamic models catalog: `GET /muse-code/models`.
 *
 * Captured 2026-10-15 (muse-wire.md §4): an OpenAI-style list whose rows carry
 * `metadata["muse-code"]` — `name`, `release_date`, `is_hidden`,
 * `modalities{input,output}`, `limit{context,output}` and the effort
 * `variants`. That metadata is why this is its own format rather than
 * `openai-models-list`: `GET /v1/models` lists ids only, with `created: 0`.
 *
 * - Hidden rows (`is_hidden: true`, e.g. `muse-image-1.0`) are not offered.
 * - `reported` is the provider's own statement: `chat` when text is among both
 *   its input and output modalities, `not-chat` when text is not among its
 *   outputs, silent otherwise.
 * - Contributor ids (`-contributor`) are kept here; the discovery choke point
 *   (`discoverProviderModelsCatalog`, `content-use.ts`) moves them out of
 *   everything that offers or picks a model.
 *
 * Signed with a key from the Muse Code credential (`muse-credentials.ts`), via
 * the credential authority, so this process's prompt role decides whether the
 * Keychain may be asked. A login that cannot be used here is
 * `no-credentials` with the reason, never an empty list.
 */

import { credentials } from "../../auth/credentials/authority.js";
import { VERSION } from "../../version.js";
import type { DiscoveredModel, FetcherResult } from "../model-discovery.js";
import { MUSE_CODE_DEFAULT_BASE_URL } from "./muse-mint.js";

const FETCH_TIMEOUT_MS = 15_000;

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The models endpoint for the configured base host. */
export function museModelsUrl(env: Record<string, string | undefined> = process.env): string {
  const base = (env.MUSE_CODE_BASE_URL?.trim() || MUSE_CODE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/muse-code/models`;
}

interface MuseModelMetadata {
  name?: unknown;
  release_date?: unknown;
  is_hidden?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/**
 * The response body → offered rows, or null when the body is not the list
 * shape at all. Exported so the parse is checkable on a captured body alone.
 */
export function parseMuseModels(body: unknown): DiscoveredModel[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const models: DiscoveredModel[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const meta = ((row as { metadata?: Record<string, unknown> }).metadata?.["muse-code"] ??
      {}) as MuseModelMetadata;
    if (meta.is_hidden === true) continue;
    const input = stringList(meta.modalities?.input);
    const output = stringList(meta.modalities?.output);
    const reported =
      output && !output.includes("text")
        ? ("not-chat" as const)
        : input?.includes("text") && output?.includes("text")
          ? ("chat" as const)
          : undefined;
    const context = meta.limit?.context;
    const release = meta.release_date;
    models.push({
      id,
      ...(typeof meta.name === "string" && meta.name ? { displayName: meta.name } : {}),
      ...(typeof context === "number" && context > 0 ? { contextWindow: context } : {}),
      ...(typeof release === "string" && /^\d{4}-\d{2}-\d{2}/.test(release)
        ? { releaseDate: release.slice(0, 10) }
        : {}),
      ...(reported ? { reported } : {}),
    });
  }
  return models;
}

/** The `muse-code-models` fetcher. Never throws. */
export async function fetchMuseCodeModelsCatalog(): Promise<FetcherResult> {
  const endpoint = museModelsUrl();
  let headers: Record<string, string>;
  try {
    const auth = await credentials.getRequestAuth("meta-muse-code", { model: "" });
    headers = { ...auth.headers };
  } catch (err) {
    return {
      kind: "failed",
      failure: {
        kind: "no-credentials",
        endpoint,
        detail: `Muse Code login not available in this process: ${oneLine((err as Error)?.message ?? String(err))}`,
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { ...headers, "User-Agent": `claudish/${VERSION}` },
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
      /* the status alone is still actionable */
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
  const models = parseMuseModels(body);
  if (!models) {
    return {
      kind: "failed",
      failure: { kind: "malformed", endpoint, detail: "the response carried no `data` array" },
    };
  }
  return { kind: "models", models, endpoint };
}
