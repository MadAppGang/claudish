//===----------------------------------------------------------------------===//
// Every models-index endpoint this build talks to, and the settings that move
// them.
//===----------------------------------------------------------------------===//

/**
 * The models-index service publishes several endpoints under one host, and
 * three modules reach for them: the slim catalog and the plans
 * (`catalog-client.ts`), the recommended/search/top100 views
 * (`model-loader.ts`), and the probe roster (`probe-catalog.ts`).
 *
 * They live here together because `CLAUDISH_CATALOG_URL` is documented as the
 * way to point claudish at a different catalog, and a module holding its own
 * copy of the host answers that setting by ignoring it. The failure is quiet in
 * the worst way: the setting is honoured by the endpoint a user is most likely
 * to test, so the remaining callers keep reaching the default host while the
 * configuration looks applied. Someone debugging that reads their network
 * rather than the code.
 *
 * Each URL resolves PER CALL rather than once at import. A module-level
 * constant freezes whatever the environment held at the instant this file was
 * first imported, which makes the override depend on module evaluation order:
 * it would take effect only when it happened to be set before anything else
 * imported this module. Reading the variable at call time makes the setting
 * mean what it says, at the cost of one property read per request.
 *
 * Node builtins only, deliberately. The catalog client, the model loader and
 * the probe cache all import this, and those already import one another; a
 * single non-builtin import here would thread a cycle through the middle of
 * routing.
 */

/** The published models-index host. */
const DEFAULT_HOST = "https://us-central1-claudish-6da10.cloudfunctions.net";

/**
 * The slim catalog endpoint, query string included.
 *
 * The query is part of the default rather than appended by the caller because
 * it names WHICH catalog is wanted (`status=active&catalog=slim`), and an
 * override that replaces the URL is entitled to replace that choice too.
 */
export const DEFAULT_CATALOG_URL = `${DEFAULT_HOST}/queryModels?status=active&catalog=slim&limit=1000`;

/**
 * The catalog endpoint in effect.
 *
 * `FIREBASE_CATALOG_URL` is the older spelling and stays accepted; the
 * `CLAUDISH_` name is the documented one and wins when both are set.
 */
export function catalogUrl(): string {
  return (
    process.env.CLAUDISH_CATALOG_URL ?? process.env.FIREBASE_CATALOG_URL ?? DEFAULT_CATALOG_URL
  );
}

/**
 * A sibling endpoint on whatever host the catalog URL names.
 *
 * Deriving rather than reading a second variable is what lets one setting move
 * the whole service: point `CLAUDISH_CATALOG_URL` at a staging host and the
 * plans and probe endpoints follow it there. The query string is dropped
 * because it belongs to the catalog request alone.
 *
 * A URL that does not end in `/queryModels` is left as it is, which is the
 * right answer for a catalog served from a plain file: there is no sibling to
 * derive, and each endpoint then wants its own variable.
 */
function siblingEndpoint(pathname: string, fallback: string): string {
  try {
    const url = new URL(catalogUrl());
    url.pathname = url.pathname.replace(/\/queryModels$/, pathname);
    url.search = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

/** The subscription-plans endpoint, derived from the catalog URL unless set. */
export function plansUrl(): string {
  return process.env.CLAUDISH_PLANS_URL ?? siblingEndpoint("/queryPlans", `${DEFAULT_HOST}/queryPlans`);
}

/** The probe-roster endpoint, derived from the catalog URL unless set. */
export function probeModelsUrl(): string {
  return (
    process.env.CLAUDISH_PROBE_MODELS_URL ??
    siblingEndpoint("/probeModels", `${DEFAULT_HOST}/probeModels`)
  );
}

/**
 * `queryModels` with no query string, for callers that append their own view
 * (`?catalog=recommended`, `?search=`, `?catalog=top100`).
 */
export function modelsBaseUrl(): string {
  return siblingEndpoint("/queryModels", `${DEFAULT_HOST}/queryModels`);
}
