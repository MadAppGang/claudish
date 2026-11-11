/**
 * The fetch and the parse of a gateway's public models list. No caching here:
 * each caller keeps what it needs for as long as it needs it.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** The rows of the `{ data: [...] }` a models list answers. Throws on a non-2xx. */
export async function fetchGatewayModels(
  url: string,
  opts: { signal?: AbortSignal } = {}
): Promise<unknown[]> {
  const response = await fetch(url, opts.signal ? { signal: opts.signal } : undefined);
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  return Array.isArray(body.data) ? body.data : [];
}

/** Every `id` of a models list, exactly as the gateway spells it. */
export async function fetchGatewayModelIds(
  url: string,
  opts: { signal?: AbortSignal } = {}
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const row of await fetchGatewayModels(url, opts)) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return ids;
}
