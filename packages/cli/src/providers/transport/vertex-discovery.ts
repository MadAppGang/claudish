/**
 * Vertex AI probe-model discovery — the models THIS project can actually call.
 *
 * WHY THIS EXISTS
 *
 * The cloud models catalog marks `vertex/google-cloud`
 * `client_model_selection_required` (measured on generation
 * `g-20260921062451697-f490edba`), by agreement with the backend: what a Vertex
 * caller may invoke depends on the user's project, its enabled APIs, its
 * permissions and its region, so no hosted pick can be right for everyone. That
 * is correct, and it also meant Test All had nothing to try and reported "no
 * probe model: transport does not support discovery" for a working install.
 *
 * So the account decides, which is the whole point: nothing here is a model id.
 *
 * WHAT THE ENDPOINT IS, MEASURED 2026-09-22 against ADC on a real project
 *
 *   GET https://<host>/v1beta1/publishers/google/models
 *       Authorization: Bearer <ADC token>
 *       x-goog-user-project: <project>
 *
 * - `v1beta1` is the ONLY version that answers: `/v1/publishers/google/models`
 *   is 404, as is a project-scoped `/v1beta1/projects/<p>/locations/<l>/…`.
 * - `x-goog-user-project` is REQUIRED for a user ADC credential. Without it the
 *   API answers 403 `SERVICE_DISABLED`: "authenticating by using local
 *   Application Default Credentials. The aiplatform.googleapis.com API requires
 *   a quota project". A request against a project-scoped URL (every generate
 *   call) carries the project in the path instead, which is why the transport
 *   itself never needed the header.
 * - The list is genuinely PER LOCATION, which is why the location comes from
 *   `resolveVertexConfig`: the same credential saw 132 models in `us-central1`,
 *   27 on the `global` host and 13 in `europe-west4`.
 *
 * WHAT IT RETURNS, AND WHY MOST OF IT IS NOT A CHAT MODEL
 *
 * The response is the Model Garden, not a chat menu: `{ publisherModels: [{
 * name, versionId, launchStage?, openSourceCategory?, publisherModelTemplate?,
 * supportedActions? }] }`. Alongside Gemini it lists notebook samples, OSS
 * checkpoints you deploy to your own endpoint, request-access research models
 * and the legacy vision/language APIs. Every filter below reads a field the API
 * itself publishes — there is no name list here, and adding one would be the
 * pinned-id failure this module exists to avoid.
 *
 * AND THE LISTING OVER-REPORTS, WHICH IS WHY THERE IS A SECOND STEP
 *
 * Measured 2026-09-22 on `us-central1`: the listing offers `gemini-3.8-flash`,
 * `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash` and every other
 * 3.x row, and ALL of them answer `404 NOT_FOUND "Publisher model … was not
 * found or your project does not have access to it"` when called there. The
 * same ids answer 200 on `global`. Only the 2.5 family is actually served in
 * `us-central1`. Nothing in the listing distinguishes the two: a per-model
 * `GET …/models/<id>?view=PUBLISHER_MODEL_VIEW_FULL` returns byte-identical
 * field sets for a servable and an unservable model, and no other endpoint
 * reports the project's entitlement per region (`…/endpoints/openapi/models` is 404,
 * `…/locations/<l>/models` is the empty tuned-model registry).
 *
 * So the listing narrows the field and `:countTokens` decides it: measured on
 * the same account, countTokens answers 404 for exactly the models
 * generateContent 404s and 200 for the ones it serves. It bills nothing, it is
 * idempotent, and every candidate is checked in ONE parallel round (~1.6s for
 * five, bounded by the slowest call).
 *
 * The probe pick is therefore a model this PROJECT, in THIS location, answered
 * for — which is the only honest form the claim can take.
 */

import { readFile } from "node:fs/promises";
import { credentials } from "../../auth/credentials/authority.js";
import {
  describeVertexAccessDenied,
  describeVertexProjectSource,
  resolveVertexConfig,
  resolveVertexProjectOrigin,
  vertexApiHost,
} from "../../auth/vertex-auth.js";
import { log } from "../../logger.js";
import { findEntryByModelId } from "../catalog-query.js";
import { type DiscoveredModel, rankDiscoveredModels } from "../model-discovery.js";
import { type DiscoveryOutcome, isChatCapable } from "./probe-discovery.js";
import { VERTEX_DEFAULT_PUBLISHER, parseVertexModel } from "./vertex-oauth.js";

/** Same TTL and timeout as the other discovery helpers (`probe-discovery.ts`). */
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
/** Shorter than the list fetch: a verification round runs many of these at once. */
const VERIFY_TIMEOUT_MS = 6000;
/**
 * How many ranked candidates are verified.
 *
 * A bound rather than a budget: the checks are free and issued in ONE parallel
 * round, so the cost is the slowest call, not the count — but a publisher list
 * is not claudish's to size, and an unbounded fan-out at Test All time (30
 * providers at once) is how the Devin discovery timeout was earned. 24 covers
 * every chat-capable candidate seen on a real project (21 in `us-central1`).
 */
const MAX_VERIFIED_CANDIDATES = 24;

/**
 * The ranked candidate list per project+location, so the probe loop's `exclude`
 * set can walk to the next candidate without re-listing. Keyed by both, because
 * the answer genuinely differs per location (see the header).
 */
const _cache = new Map<string, { ranked: string[]; reason?: string; expiresAt: number }>();

/** Test seam: drop the memo between cases. */
export function _clearVertexDiscoveryCache(): void {
  _cache.clear();
}

/** One row of the `publisherModels` array, in the shape this module reads. */
interface PublisherModel {
  name: string;
  versionId?: string;
  launchStage?: string;
  openSourceCategory?: string;
  publisherModelTemplate?: string;
  supportedActions?: Record<string, unknown>;
}

/**
 * Whether Vertex serves this row as a managed model claudish could call.
 *
 * Each clause quotes the API's own metadata:
 *
 * 1. `publisherModelTemplate` — the `projects/{project}/locations/{location}/
 *    publishers/…/models/<id>@<version>` address the row is served at. A row
 *    without one is not served as a managed model at all (it is a notebook, a
 *    fine-tuning pipeline or a deploy-it-yourself checkpoint), so there is no
 *    endpoint for the probe to call.
 * 2. `openSourceCategory` naming OSS weights — `GOOGLE_OWNED_OSS`,
 *    `THIRD_PARTY_OWNED_OSS`, `*_WITH_GOOGLE_CHECKPOINT` — means "deploy this
 *    yourself". Belt and braces with (1), which it mostly implies, but not
 *    always: `imageclassification-efficientnet` carries a template AND is OSS.
 * 3. `PRIVATE_PREVIEW` is allowlist-only by definition; `GA`,
 *    `PUBLIC_PREVIEW` and `EXPERIMENTAL` are all callable.
 * 4. A `requestAccess` action is the API saying access must be requested first.
 */
function isServedByVertex(m: PublisherModel): boolean {
  if (!m.publisherModelTemplate) return false;
  if (m.openSourceCategory && /OSS/.test(m.openSourceCategory)) return false;
  if (m.launchStage === "PRIVATE_PREVIEW") return false;
  if (m.supportedActions && "requestAccess" in m.supportedActions) return false;
  return true;
}

/** `publishers/google/models/gemini-3.8-flash` → `gemini-3.8-flash`. */
function shortModelId(name: string): string {
  const at = name.lastIndexOf("/");
  return at >= 0 ? name.slice(at + 1) : name;
}

/**
 * The id claudish will send, for the publisher this listing belongs to.
 *
 * `parseVertexModel` defaults a bare id to the `google` publisher, so a google
 * row round-trips bare; anything else is publisher-qualified. Derived from that
 * same default rather than restated, so the two cannot disagree about which
 * publisher a bare id means.
 */
function wireIdFor(publisher: string, modelId: string): string {
  return publisher === VERTEX_DEFAULT_PUBLISHER ? modelId : `${publisher}/${modelId}`;
}

/** A field the API may omit or send as something other than a string. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePublisherModels(body: unknown): PublisherModel[] {
  const rows = (body as { publisherModels?: unknown })?.publisherModels;
  if (!Array.isArray(rows)) return [];
  const out: PublisherModel[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const name = str(row.name);
    if (!name) continue;
    const actions = row.supportedActions;
    out.push({
      name,
      versionId: str(row.versionId),
      launchStage: str(row.launchStage),
      openSourceCategory: str(row.openSourceCategory),
      publisherModelTemplate: str(row.publisherModelTemplate),
      supportedActions:
        actions && typeof actions === "object" ? (actions as Record<string, unknown>) : undefined,
    });
  }
  return out;
}

/**
 * List the publisher models this project can SEE from this location.
 *
 * A dynamic models catalog, NOT an entitlement — the header records the measurement: this
 * endpoint offers `gemini-3.x` rows in `us-central1` that 404 when called there.
 * `discoverVertexProbeModel` narrows it with `:countTokens`; anything else
 * consuming this must do the same rather than treat the list as availability.
 *
 * Exported so a human (or a verification script) can see the raw answer without
 * going through the probe loop. Throws on transport failure; the caller turns
 * that into a `reason`.
 */
export async function listVertexPublisherModels(
  publisher: string = VERTEX_DEFAULT_PUBLISHER
): Promise<{ models: DiscoveredModel[]; endpoint: string; listed: number }> {
  const config = await resolveVertexConfig();
  if (!config) {
    // Not a network failure: nothing has been asked yet. The caller's message
    // names both remedies; inventing a project here would bill someone else's.
    throw new Error("no Google Cloud project resolved");
  }
  const endpoint = `https://${vertexApiHost(config.location)}/v1beta1/publishers/${publisher}/models`;

  // The same credential the transport signs with, via the authority — not a
  // second path to a token. `x-goog-user-project` is added because a LIST is not
  // project-scoped in its URL; see the header note.
  const auth = await credentials.getRequestAuth("vertex", { model: "" });
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { ...auth.headers, "x-goog-user-project": config.projectId },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    log(`[vertex-discovery] HTTP ${response.status} from ${endpoint}`);
    const detail = await response.text().catch(() => "");
    const upstream = upstreamErrorMessage(detail);
    const origin = await resolveVertexProjectOrigin();
    if (response.status === 401 || response.status === 403) {
      let account: string | undefined;
      try {
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credPath) {
          try {
            const credential = JSON.parse(await readFile(credPath, "utf-8")) as {
              client_email?: unknown;
            };
            account = str(credential.client_email);
          } catch {
            // An unreadable credential file must not prevent the tokeninfo lookup.
          }
        }
        if (!account) {
          const token = auth.headers.Authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
          if (token) {
            const tokeninfo = await fetch(
              `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
              { method: "GET", signal: AbortSignal.timeout(3000) }
            );
            if (tokeninfo.ok) {
              account = str(((await tokeninfo.json()) as { email?: unknown }).email);
            }
          }
        }
      } catch {
        // Best-effort account lookup must not hide the upstream refusal or log the token.
      }
      const explanation = describeVertexAccessDenied({
        status: response.status,
        upstream,
        account,
        origin,
        projectId: config.projectId,
      });
      throw new Error(explanation);
    }
    throw new Error(
      [
        `HTTP ${response.status}: ${upstream}`,
        `project ${config.projectId}` +
          (origin ? ` (from ${describeVertexProjectSource(origin)})` : ""),
      ].join(" · ")
    );
  }

  const listed = parsePublisherModels(await response.json());
  const models: DiscoveredModel[] = listed.filter(isServedByVertex).map((m) => {
    const id = shortModelId(m.name);
    return {
      id: wireIdFor(publisher, id),
      // The listing publishes no date and no context window. The catalog's
      // release date is a fact about the MODEL, and `DiscoveredModel.releaseDate`
      // exists for exactly this ordering job; the context window is deliberately
      // left undefined, because nothing here measured what this project may send.
      releaseDate: findEntryByModelId(id)?.releaseDate,
    };
  });
  return { models, endpoint, listed: listed.length };
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function upstreamErrorMessage(detail: string): string {
  try {
    const body = JSON.parse(detail) as { error?: { message?: unknown } } | null;
    const message = str(body?.error?.message);
    if (message) return message;
  } catch {
    // Non-JSON refusals retain the upstream body.
  }
  return oneLine(detail) || "(no message)";
}

/** What one `:countTokens` check established about one candidate. */
interface VerifiedCandidate {
  id: string;
  /** False ONLY when the API said the model is not there; see `verifyServed`. */
  served: boolean;
  /** The upstream sentence for a refusal, for the failure message. */
  detail?: string;
}

/**
 * Ask the project, in its own location, which of these candidates it will serve.
 *
 * `:countTokens` is the question: it is free, idempotent, needs no generation
 * config, and — measured — answers 404 for exactly the models `generateContent`
 * 404s. One parallel round, so the wall time is the slowest check.
 *
 * The asymmetry is deliberate. A 404 DENIES a candidate, because that is the
 * API saying the model is not there. Every other outcome — 403, 429, 5xx, a
 * timeout, a transport error — KEEPS it: an inconclusive check must not delete a
 * model from the list, or a rate limit during Test All would report an empty
 * Vertex and the user would go looking for a missing permission that does not
 * exist.
 */
async function verifyServed(
  ids: string[],
  config: { projectId: string; location: string },
  headers: Record<string, string>
): Promise<VerifiedCandidate[]> {
  const base =
    `https://${vertexApiHost(config.location)}/v1/` +
    `projects/${config.projectId}/locations/${config.location}/publishers`;
  return Promise.all(
    ids.map(async (id): Promise<VerifiedCandidate> => {
      const parsed = parseVertexModel(id);
      const url = `${base}/${parsed.publisher}/models/${parsed.model}:countTokens`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          // The shortest legal prompt: this measures existence, not the model.
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "." }] }] }),
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });
        if (res.ok) return { id, served: true };
        const detail = oneLine(await res.text().catch(() => ""), 160);
        if (res.status === 404) return { id, served: false, detail };
        return { id, served: true, detail: `HTTP ${res.status} ${detail}` };
      } catch (e: unknown) {
        return { id, served: true, detail: e instanceof Error ? e.message : String(e) };
      }
    })
  );
}

/**
 * Pick a probe model from the project's own publisher models.
 *
 * Ranked by the SHARED `rankDiscoveredModels` — the comparator the picker and
 * every other provider's discovery already use — so Vertex orders newest-first
 * like everything else rather than by a second rule invented here. Filtered by
 * the SHARED `isChatCapable`, so an embedding, image, TTS or video model is
 * never offered. Then narrowed to what the project answers for in its own
 * location (see the header), and only then does `exclude` choose, so the Test
 * All retry loop gets the NEXT candidate rather than the same one again.
 */
export async function discoverVertexProbeModel(
  exclude?: ReadonlySet<string>
): Promise<DiscoveryOutcome> {
  const config = await resolveVertexConfig();
  const cacheKey = config ? `vertex:${config.projectId}:${config.location}` : "vertex:unresolved";
  const hit = _cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return pickFrom(hit.ranked, hit.reason, exclude);
  }

  const fail = (reason: string): DiscoveryOutcome => {
    log(`[vertex-discovery] ${reason}`);
    _cache.set(cacheKey, { ranked: [], reason, expiresAt: Date.now() + CACHE_TTL_MS });
    return { model: null, reason };
  };

  let listing: Awaited<ReturnType<typeof listVertexPublisherModels>>;
  try {
    listing = await listVertexPublisherModels();
  } catch (e: unknown) {
    return fail(`Vertex AI model list failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const ranked = rankDiscoveredModels(listing.models)
    .map((m) => m.id)
    .filter(isChatCapable);
  if (ranked.length === 0) {
    return fail(
      listing.listed === 0
        ? `${listing.endpoint} listed no models for this project`
        : `no chat-capable model among the ${listing.listed} that ${listing.endpoint} listed for this project`
    );
  }
  if (!config) {
    // Unreachable: the listing above needs the project too. Narrowing only.
    return fail("no Google Cloud project resolved");
  }

  const auth = await credentials.getRequestAuth("vertex", { model: "" });
  const checked = await verifyServed(
    ranked.slice(0, MAX_VERIFIED_CANDIDATES),
    config,
    auth.headers
  );
  const served = checked.filter((c) => c.served).map((c) => c.id);
  log(
    `[vertex-discovery] ${listing.listed} listed → ${ranked.length} chat-capable → ` +
      `${served.length} served in ${config.location}: ` +
      `${served.slice(0, 5).join(", ")}${served.length > 5 ? ", …" : ""}`
  );
  if (served.length === 0) {
    // Every candidate was refused by name. Quote one upstream sentence: it names
    // the project and the location, which is what makes this actionable.
    const example = checked.find((c) => c.detail);
    return fail(
      `${config.projectId} lists ${ranked.length} chat model(s) but serves none of them in ` +
        `${config.location} — another location may (VERTEX_LOCATION)` +
        (example ? `. ${example.id}: ${example.detail}` : "")
    );
  }
  _cache.set(cacheKey, { ranked: served, expiresAt: Date.now() + CACHE_TTL_MS });
  return pickFrom(served, undefined, exclude);
}

function pickFrom(
  ranked: string[],
  reason: string | undefined,
  exclude?: ReadonlySet<string>
): DiscoveryOutcome {
  if (ranked.length === 0) return { model: null, reason };
  const pick = ranked.find((m) => !exclude?.has(m));
  if (!pick) {
    return { model: null, reason: `all ${ranked.length} candidate model(s) already tried` };
  }
  // The contract the probe depends on: whatever is returned has to parse back
  // into the publisher + model the endpoint builder expects. Cheap, and it fails
  // loudly here rather than as a 404 three layers down.
  parseVertexModel(pick);
  return { model: pick };
}
