/**
 * DevinProviderTransport — Devin (Cognition/Codeium) subscription over the
 * `ApiServerService/GetChatMessage` Connect-protobuf rpc.
 *
 * ```
 * POST <server>/exa.api_server_pb.ApiServerService/GetChatMessage
 * authorization:            Basic <key>-<key>
 * content-type:             application/connect+proto
 * connect-protocol-version: 1
 * ```
 *
 * Three things about this transport are unlike every other one in claudish, and
 * all three are deliberate.
 *
 * **1. The body is BINARY.** `serializeBody()` is the seam that allows it — an
 * OPTIONAL hook on `ProviderTransport`, so the other ~15 transports leave it
 * undefined and keep `JSON.stringify` + `application/json` byte for byte. The
 * encoder lives on Layer 3 rather than Layer 1 because the body embeds the api
 * key in metadata field `1.3`, and credentials are categorically Layer 3's. The
 * precedent is exact: `transformPayload` (the CodeAssist/Antigravity envelope,
 * which also injects auth-derived state) is already a Layer 3 hook.
 *
 * **2. The reasoning tier is part of the model id.** There is no effort
 * parameter — `claude-opus-5` + effort `high` must become the uid
 * `claude-opus-5-high`. Resolution runs against the LIVE roster
 * (`getServedDevinModels`), never a hardcoded table, so it tracks whatever this
 * subscription is entitled to today.
 *
 * **3. Errors arrive inside HTTP 200.** The status code alone never signals
 * failure, which is why ComposedHandler routes `connect-proto` through
 * `sniffDevinStreamHead` before returning a Response. The served-set-aware
 * rewrite below turns a terminal fault on an unserved uid into an actionable
 * message instead of an opaque backend string.
 */

import type { DevinRequestPayload } from "../../adapters/devin-api-format.js";
import { credentials } from "../../auth/credentials/authority.js";
import { devinAuthHeaders } from "../../auth/credentials/devin-credential.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import { log } from "../../logger.js";
import { readDevinApiKey, readDevinServerUrl } from "../devin/devin-credentials.js";
import { type DevinModelConfig, getServedDevinModels } from "../devin/devin-models.js";
import { describeDevinRequestForLog, encodeDevinRequest } from "../devin/devin-request.js";
import { resolveDevinModelUid } from "../devin/model-id-resolver.js";
import type { ProviderTransport, SerializedBody, StreamFormat } from "./types.js";

/** The streaming rpc. The unary metadata rpcs live in `devin-models.ts`. */
const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

/** Connect streaming content type. The unary rpcs use bare `application/proto`. */
const CHAT_CONTENT_TYPE = "application/connect+proto";

export class DevinProviderTransport implements ProviderTransport {
  readonly name = "devin";
  readonly displayName = "Devin";
  readonly streamFormat: StreamFormat = "connect-proto";

  /** The user-supplied model name (e.g. `claude-opus-5`). */
  private readonly modelName: string;

  /** The delegated per-request auth artifact, populated by refreshAuth(). */
  private cachedAuth: RequestAuth | null = null;

  /** The LIVE roster this subscription serves, refreshed per request (TTL-cached). */
  private served: DevinModelConfig[] = [];

  /** The uid actually sent in field 21, set by serializeBody(). */
  private resolvedUid: string;

  constructor(modelName: string) {
    this.modelName = modelName;
    // Resolved against the live roster once refreshAuth() has run; until then
    // the raw name is a safe placeholder (ComposedHandler always awaits
    // refreshAuth before any request).
    this.resolvedUid = modelName;
  }

  getEndpoint(): string {
    return `${readDevinServerUrl()}${CHAT_PATH}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    if (this.cachedAuth) return { ...this.cachedAuth.headers };
    // Discovery/probe paths may reach here without the authority having been
    // consulted. Mint locally rather than sending an unauthenticated request.
    const apiKey = readDevinApiKey();
    return apiKey ? devinAuthHeaders(apiKey) : {};
  }

  /**
   * Resolve credentials and the live roster before each request.
   *
   * A missing credential throws with `terminal = true`, so ComposedHandler
   * answers HTTP 400 (surfaced inline) rather than 401 — a 401 sends the client
   * into ~11 retries of a condition that cannot self-heal.
   *
   * Roster discovery is fail-soft by contract (`getServedDevinModels` returns
   * `[]` on any error), so a discovery outage degrades resolution to
   * pass-through instead of breaking the turn.
   */
  async refreshAuth(): Promise<void> {
    this.cachedAuth = await credentials.getRequestAuth("devin", { model: this.modelName });
    this.served = await getServedDevinModels();
    log(
      `[Devin] auth refreshed, model: ${this.modelName}, served roster: ${this.served.length} models`
    );
  }

  /**
   * The logical request object → enveloped Connect-protobuf bytes.
   *
   * This is where the uid is finally resolved: `modelUid` + `effort` against the
   * live roster. Effort rides the PAYLOAD rather than the transport because a
   * cached handler serves overlapping turns that may carry different levels.
   */
  serializeBody(payload: any): { body: SerializedBody; contentType: string } {
    const apiKey = readDevinApiKey();
    if (!apiKey) {
      // refreshAuth() runs first and already fails loudly on a missing
      // credential, so reaching here means the credential vanished mid-request.
      const err: Error & { terminal?: boolean } = new Error(
        "No Devin credential available when encoding the request."
      );
      err.terminal = true;
      throw err;
    }

    const request = payload as DevinRequestPayload;
    this.resolvedUid = resolveDevinModelUid(
      request.modelUid || this.modelName,
      request.effort,
      this.served
    );
    const resolved = { ...request, modelUid: this.resolvedUid };

    if (this.resolvedUid !== this.modelName) {
      log(`[Devin] model resolved: ${this.modelName} -> ${this.resolvedUid}`);
    }
    // NEVER log the encoded bytes: metadata field 1.3 carries the api key.
    // describeDevinRequestForLog cannot leak it by construction.
    log(`[Devin] request ${describeDevinRequestForLog(resolved)}`);

    return {
      body: encodeDevinRequest(resolved, { apiKey }),
      contentType: CHAT_CONTENT_TYPE,
    };
  }

  /**
   * The LIVE per-uid context window for this model on THIS subscription.
   *
   * Resolved WITHOUT the effort signal, because ComposedHandler calls this at
   * step 5b — before the payload exists. Every tier of a family shares one
   * window (all `claude-opus-5-*` are 1,000,000), so the tier-free resolution is
   * the right answer for the family; the tier only matters for routing.
   *
   * 0 means "no opinion" and is a no-op upstream, which is the correct
   * degradation when discovery failed.
   */
  getContextWindow(): number {
    if (this.served.length === 0) return 0;
    const uid = resolveDevinModelUid(this.modelName, undefined, this.served);
    return this.served.find((model) => model.uid === uid)?.contextWindow ?? 0;
  }

  /**
   * The uid actually being served, when it differs from what the user typed.
   *
   * Not a fallback in the capacity sense — it is the tier resolution — but it is
   * the same question the status line asks ("which model is really answering?"),
   * so it rides the same hook. Returning undefined when they match keeps the
   * status line quiet in the common case.
   */
  getActiveModelName(): string | undefined {
    return this.resolvedUid !== this.modelName ? this.resolvedUid : undefined;
  }

  /**
   * Pick a probe-friendly model from the live roster.
   *
   * The cloud catalog cannot know a Devin roster — it is per-subscription — so
   * the ranking is a RULE (widest context window first, ties alphabetical) and
   * never a pinned id. `getServedDevinModels` already drops rows with no context
   * window, which is what removes `adaptive`, the server-side router
   * pseudo-model that is not a routable uid.
   */
  async discoverProbeModel(exclude?: ReadonlySet<string>): Promise<{
    model: string | null;
    reason?: string;
  }> {
    if (!readDevinApiKey()) {
      return {
        model: null,
        reason:
          "no Devin credential — sign in with the Devin CLI (`devin login`), or set WINDSURF_API_KEY",
      };
    }
    const served = await getServedDevinModels();
    if (served.length === 0) {
      return { model: null, reason: "Devin reported no models for this subscription" };
    }
    const ranked = [...served].sort((a, b) => {
      const diff = b.contextWindow - a.contextWindow;
      return diff !== 0 ? diff : a.uid.localeCompare(b.uid);
    });
    const candidate = ranked.find((model) => !exclude?.has(model.uid));
    if (!candidate) {
      return { model: null, reason: "every Devin model was already tried in this probe round" };
    }
    return { model: candidate.uid };
  }

  /**
   * Rewrite a TERMINAL in-stream error when the live roster proves the uid is
   * not served. Follows Antigravity's `rewriteModelNotFound` doctrine exactly.
   *
   * Only rewrites when the served set is non-empty AND does not contain the
   * resolved uid. An empty set means discovery failed, and inventing a diagnosis
   * on missing data is worse than passing the backend's own message through.
   *
   * Worth knowing when reading a live failure: an unserved uid comes back as
   * `permission_denied`, not `not_found` (verified — `claude-opus-99` returns
   * exactly that). The upstream text is kept verbatim at the end, because
   * `permission_denied` was ALSO the symptom of the wrong role enum during
   * protocol work, and collapsing the two would hide the more dangerous one.
   */
  rewriteInStreamError(_code: string, message: string): string {
    if (this.served.length === 0) return message;
    if (this.served.some((model) => model.uid === this.resolvedUid)) return message;

    const families = [...new Set(this.served.map((model) => model.family).filter(Boolean))].sort();
    // 167 models span ~40 families, and pasting all of them buries the one line
    // the user needs. Families sharing the request's leading token come first —
    // someone who typed `claude-opus-99` wants the claude-opus rosters, not
    // an alphabetical wall starting at `code-fast`.
    const stem = this.resolvedUid.split("-")[0]?.toLowerCase() ?? "";
    const related = families.filter((f) => f.toLowerCase().startsWith(stem));
    const ordered = [...related, ...families.filter((f) => !related.includes(f))];
    const SHOWN = 12;
    const shown = ordered.slice(0, SHOWN);
    const more = ordered.length - shown.length;
    const familyClause =
      shown.length > 0
        ? ` Available families: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}.`
        : "";
    return (
      `\`${this.resolvedUid}\` is not served by your Devin subscription.${familyClause} ` +
      "Run `claudish models dv@` to list the uids this subscription can call. " +
      `(Upstream said: ${message})`
    );
  }
}
