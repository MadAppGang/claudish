import { catalogOrigin } from "../providers/catalog-client.js";
import type { ModelHandler } from "./types.js";

/**
 * Reads and writes over a handler cache, remembering which entries were built
 * from the bundled recommended list. Such an entry is dropped at its next lookup
 * once a catalog from disk answers, so the next request builds from that catalog.
 * A request already holding the handler finishes on it.
 */
export interface BundledTaggedCache {
  get(key: string): ModelHandler | undefined;
  /**
   * `originAtStart` is `catalogOrigin()` read before the build began: a build
   * that started with no catalog can end on the bundled list after its wait.
   */
  set(key: string, handler: ModelHandler, originAtStart: ReturnType<typeof catalogOrigin>): void;
}

export function bundledTaggedCache(cache: Map<string, ModelHandler>): BundledTaggedCache {
  const builtFromBundled = new Set<string>();
  return {
    get(key) {
      if (builtFromBundled.has(key) && catalogOrigin() !== "bundled") {
        builtFromBundled.delete(key);
        cache.delete(key);
        return undefined;
      }
      return cache.get(key);
    },
    set(key, handler, originAtStart) {
      cache.set(key, handler);
      if (originAtStart === "bundled" || catalogOrigin() === "bundled") builtFromBundled.add(key);
      else builtFromBundled.delete(key);
    },
  };
}
