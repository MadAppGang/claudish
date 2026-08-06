/**
 * The LIVE Devin model roster — capability ∩ entitlement.
 *
 * No model roster, context window, family name, or reasoning tier is ever
 * written into claudish source: which models a subscription serves is
 * per-account and drifts, so it is discovered from the backend's own metadata
 * rpcs and cached briefly. The only literals here are endpoint paths, field
 * numbers, and the client identity strings — protocol, not data.
 *
 * Two rpcs, both **unary**:
 *
 * | rpc | answers |
 * |---|---|
 * | `GetCliModelConfigs` | capability — every model the backend knows, with its live context window, max output, and family |
 * | `GetCliTeamSettings` | entitlement — `allowed_model_uids`, the subset this subscription may actually call |
 *
 * They genuinely differ (measured live: 167 configs vs 148 allowed uids), so
 * the intersection is not a no-op.
 *
 * ## Wire shape — BARE, not enveloped
 *
 * Unary rpcs send `content-type: application/proto` and a bare protobuf body
 * (`msg(bytes(1, metadata))`) with NO `[flags][len]` envelope. Only the
 * streaming `GetChatMessage` is enveloped. Responses are bare too.
 *
 * ## Metadata — field 7 is REQUIRED
 *
 * Bisected against the live endpoint:
 *
 * ```
 * 1,2,3        -> HTTP 400 invalid_argument
 * 1,2,3,4,5    -> HTTP 400 invalid_argument
 * 1,2,3,4,5,7  -> HTTP 200          <-- minimum
 * ```
 *
 * Field 7 (the version, again) is the one that matters. Note field 1 is
 * `"chisel"` here, where `GetChatMessage` sends `"devin-cli"` — the two shapes
 * are NOT interchangeable, which is why `devin-request.ts` builds its own.
 *
 * The fully-captured request also carries metadata fields 30/31 (a blob and a
 * hex digest) and returns a few more configs (173 vs 167). Those are NOT
 * synthesised: an unexplained digest is not something to fake, and the six-field
 * minimum is a superset of what the intersection needs.
 *
 * Fail-soft everywhere: every error path returns `[]` (or the last good cache).
 * Discovery failing must degrade the picker, never break a turn.
 */

import { log } from "../../logger.js";
import { readDevinApiKey, readDevinServerUrl } from "./devin-credentials.js";
import { DEVIN_CLI_VERSION } from "./devin-request.js";
import { type TLV, bytes, msg, parseTLV, readString, readVarintValue } from "./proto-codec.js";

/** Capability rpc — every model the backend knows about. */
const MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

/** Entitlement rpc — note the DIFFERENT service, not ApiServerService. */
const TEAM_SETTINGS_PATH = "/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings";

/** Roster TTL. The served set moves on a daily cadence, not per request. */
const ROSTER_TTL_MS = 5 * 60 * 1000;

/** Metadata rpcs are small and on interactive paths (picker, probe). */
const UNARY_TIMEOUT_MS = 10_000;

/** One row of the live roster. */
export interface DevinModelConfig {
  /** Routing key — request field 21 (e.g. `claude-opus-5-high`). */
  uid: string;
  /** Human label from the backend (e.g. `"Claude Opus 5 XHigh"`). */
  displayName: string;
  /** Live context window for THIS uid on THIS backend. */
  contextWindow: number;
  /** Live max output tokens. */
  maxOutput: number;
  /** Bare family name (e.g. `claude-opus-5`, `glm-5.2`) — dotted, unlike uids. */
  family: string;
}

/**
 * Metadata for the UNARY rpcs. Distinct from `GetChatMessage`'s — see the
 * module header. All six fields are required; dropping 7 returns HTTP 400.
 */
function unaryMetadata(apiKey: string): Uint8Array {
  return msg(
    bytes(1, "chisel"),
    bytes(2, DEVIN_CLI_VERSION),
    bytes(3, apiKey),
    bytes(4, "en"),
    bytes(5, process.platform),
    bytes(7, DEVIN_CLI_VERSION)
  );
}

/** POST a bare-protobuf unary rpc. Returns the raw body, or null on any failure. */
async function postUnary(path: string, apiKey: string): Promise<Uint8Array | null> {
  const url = `${readDevinServerUrl()}${path}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        // The key doubled with a `-` separator is the literal scheme the CLI uses.
        authorization: `Basic ${apiKey}-${apiKey}`,
        "content-type": "application/proto",
        "connect-protocol-version": "1",
      },
      body: msg(bytes(1, unaryMetadata(apiKey))),
      signal: AbortSignal.timeout(UNARY_TIMEOUT_MS),
    });
    if (!response.ok) {
      log(`[Devin] ${path} failed: HTTP ${response.status}`);
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    log(`[Devin] ${path} error: ${err}`);
    return null;
  }
}

/** The nested capability sub-message (field 23): `13` max output, `23` family. */
function decodeModelDetails(payload: Uint8Array): { maxOutput: number; family: string } {
  let maxOutput = 0;
  let family = "";
  for (const sub of parseTLV(payload)) {
    if (sub.no === 13 && sub.wire === 0) maxOutput = readVarintValue(sub);
    else if (sub.no === 23 && sub.wire === 2) family = readString(sub);
  }
  return { maxOutput, family };
}

/**
 * Decode one model config.
 *
 * Field map (verified): `22` uid · `1` display name · `18` context window ·
 * `23.13` max output · `23.23` family. Unknown fields are ignored, so the
 * backend can add any it likes. A row without a uid is not routable — drop it.
 */
function decodeModelConfig(payload: Uint8Array): DevinModelConfig | null {
  let uid = "";
  let displayName = "";
  let contextWindow = 0;
  let details = { maxOutput: 0, family: "" };

  for (const field of parseTLV(payload)) {
    if (field.no === 22 && field.wire === 2) uid = readString(field);
    else if (field.no === 1 && field.wire === 2) displayName = readString(field);
    else if (field.no === 18 && field.wire === 0) contextWindow = readVarintValue(field);
    else if (field.no === 23 && field.wire === 2) details = decodeModelDetails(field.payload);
  }

  if (!uid) return null;
  return { uid, displayName: displayName || uid, contextWindow, ...details };
}

/** Top-level fields with the given number and wire type 2. */
function topLevelDelimited(body: Uint8Array, fieldNumber: number): TLV[] {
  return parseTLV(body).filter((field) => field.no === fieldNumber && field.wire === 2);
}

/**
 * CAPABILITY — every model config the backend knows. `[]` on any failure.
 *
 * The response's top-level repeated field 1 carries one config per entry.
 */
export async function fetchDevinModelConfigs(apiKey: string): Promise<DevinModelConfig[]> {
  const body = await postUnary(MODEL_CONFIGS_PATH, apiKey);
  if (!body) return [];

  const configs: DevinModelConfig[] = [];
  for (const field of topLevelDelimited(body, 1)) {
    const config = decodeModelConfig(field.payload);
    if (config) configs.push(config);
  }
  log(`[Devin] GetCliModelConfigs: ${configs.length} configs`);
  return configs;
}

/**
 * ENTITLEMENT — `allowed_model_uids`, top-level repeated field 7. `[]` on any
 * failure, which the caller reads as "entitlement unknown" and treats the
 * capability list as a superset rather than hiding models the user has.
 */
export async function fetchDevinAllowedUids(apiKey: string): Promise<string[]> {
  const body = await postUnary(TEAM_SETTINGS_PATH, apiKey);
  if (!body) return [];

  const uids: string[] = [];
  for (const field of topLevelDelimited(body, 7)) {
    const uid = readString(field).trim();
    if (uid) uids.push(uid);
  }
  log(`[Devin] GetCliTeamSettings: ${uids.length} allowed uids`);
  return uids;
}

let rosterCache: DevinModelConfig[] | null = null;
let rosterCacheAt = 0;

/**
 * The models this subscription can actually run: configs ∩ allowed uids, minus
 * rows with no context window.
 *
 * That last filter drops `adaptive` (ctx 0), a server-side router pseudo-model
 * that is not a routable uid — it must never reach the picker or a probe.
 *
 * Cached for {@link ROSTER_TTL_MS}. Never throws: a stale cache beats an empty
 * one, and an empty one beats a failed turn.
 */
export async function getServedDevinModels(opts?: {
  /** Bypass the TTL. */
  force?: boolean;
  /** Explicit credential (defaults to {@link readDevinApiKey}). */
  apiKey?: string;
}): Promise<DevinModelConfig[]> {
  const now = Date.now();
  if (!opts?.force && rosterCache && now - rosterCacheAt < ROSTER_TTL_MS) return rosterCache;

  const apiKey = opts?.apiKey ?? readDevinApiKey();
  if (!apiKey) return rosterCache ?? [];

  try {
    const [configs, allowed] = await Promise.all([
      fetchDevinModelConfigs(apiKey),
      fetchDevinAllowedUids(apiKey),
    ]);
    if (configs.length === 0) return rosterCache ?? [];

    const entitled = new Set(allowed);
    const served = configs.filter(
      (config) => config.contextWindow > 0 && (entitled.size === 0 || entitled.has(config.uid))
    );
    if (entitled.size === 0) {
      log("[Devin] entitlement unknown — using the full config list (superset)");
    }

    rosterCache = served;
    rosterCacheAt = now;
    return served;
  } catch (err) {
    log(`[Devin] served-model discovery error: ${err}`);
    return rosterCache ?? [];
  }
}

/** Test seam: drop the cached roster. */
export function _resetDevinModelCache(): void {
  rosterCache = null;
  rosterCacheAt = 0;
}
