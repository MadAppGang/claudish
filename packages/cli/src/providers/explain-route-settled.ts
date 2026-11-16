/**
 * `explainRoute` for a diagnosis somebody is waiting on: `--probe`, the config
 * TUI's probe and MCP `preflight`.
 *
 * Reachability starts `unknown`, and a read made before the backend's first
 * answer sees no catalog at all. A launch waits for that answer before it routes
 * a bare name; these three surfaces wait the same way, so they show the chain a
 * launch would use instead of an empty one.
 */
import { isBareRoute } from "../launcher/catalog-warm.js";
import { readDiskCatalog } from "./all-models-cache.js";
import { ensureCatalogReady, settleCatalogVerdict } from "./catalog-client.js";
import { bundledListEnabled } from "./catalog-reachability.js";
import { nativeRouteFor } from "./native-route.js";
import { type RouteExplanation, explainRoute } from "./routing-rules.js";

/**
 * With no catalog file, wait until the backend's first answer settles whether it
 * can be reached (at most that request's own 8 s timeout), then give a refresh
 * that is running a short time to land. Returns at once for a name that is not
 * routed, when a file exists, and when the bundled recommended list is off.
 */
export async function settleCatalogForBareName(target: string): Promise<void> {
  if (!isBareRoute(target)) return;
  await settleCatalog();
}

async function settleCatalog(): Promise<void> {
  if (readDiskCatalog() !== null || !bundledListEnabled()) return;
  await settleCatalogVerdict();
  await ensureCatalogReady(5000);
}

/**
 * {@link explainRoute}, after {@link settleCatalogForBareName}. With `comparison`,
 * a native target's catalog routes are gathered too, so its catalog is settled
 * the same way.
 */
export async function explainRouteSettled(
  target: string,
  opts: { comparison?: boolean } = {}
): Promise<RouteExplanation> {
  if (opts.comparison && nativeRouteFor(target) !== null) await settleCatalog();
  else await settleCatalogForBareName(target);
  return explainRoute(target, opts.comparison ? { comparison: true } : {});
}
