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
import {
  type TLV,
  bytes,
  msg,
  parseTLV,
  readFloat32LE,
  readString,
  readVarintValue,
} from "./proto-codec.js";

/** Capability rpc — every model the backend knows about. */
const MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

/** Entitlement rpc — note the DIFFERENT service, not ApiServerService. */
const TEAM_SETTINGS_PATH = "/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings";

/** Roster TTL. The served set moves on a daily cadence, not per request. */
const ROSTER_TTL_MS = 5 * 60 * 1000;

/** Metadata rpcs are small and on interactive paths (picker, probe). */
const UNARY_TIMEOUT_MS = 10_000;

/** A time-boxed promotional price on one uid (field 19 `promo_status`). */
export interface DevinPromo {
  /** Unix SECONDS. Compare against the clock at render — two live promos expire within days. */
  expiresAt: number;
}

/**
 * One knob the backend declares for a uid (`model_family_metadata.entries[]`).
 *
 * Devin STATES what each uid is instead of leaving it to be parsed out of the
 * name, so this is the authority wherever it is present. Measured against a
 * real roster:
 *
 * - `label` on the effort axis agrees with the uid suffix on all 130 uids that
 *   carry both, and additionally expresses `Minimal`, which no suffix rule does.
 * - `enabled` on `Fast Mode` is true for `-fast` AND `-priority` uids — i.e. it
 *   means "a speed premium is engaged", which is the property that actually
 *   matters (those cost ~2x). A `-fast`-only spelling rule misses 32 uids.
 * - `enabled` on `1M Context` means "the 1M upgrade is applied", NOT "the window
 *   is 1M": it is absent on natively-1M models. Context therefore comes from
 *   `contextWindow`, never from this axis.
 */
export interface DevinAxis {
  /** The vendor's own name for the knob: `Effort`, `1M Context`, `Fast Mode`, … */
  key: string;
  /** The value THIS uid sits at on that axis: `High`, `Max`, `No Thinking`, … */
  label?: string;
  /** Whether this uid has the axis engaged. */
  enabled: boolean;
}

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
  /**
   * Devin's OWN row label for the picker (`model_family_label`, field 30.1) —
   * e.g. `"GLM-5.2"`, `"Claude Opus 4.8"`. Absent on a handful of uids (legacy
   * `MODEL_*` names, internal review models), which fall back to `family`.
   */
  groupLabel?: string;
  /**
   * The knobs Devin declares for this uid (`model_family_metadata.entries`,
   * field 30.2), with the value this uid sits at on each.
   *
   * This is why nothing is inferred from uid SPELLING where Devin speaks: the
   * backend states what each variant IS, so the resolver reads it. Spelling is
   * the fallback for the 12 uids that declare no effort axis.
   */
  axes: DevinAxis[];
  /** Relative credit cost (`credit_multiplier`, field 3). Spans ×0.5 … ×400. */
  creditMultiplier?: number;
  /** Coarse vendor cost band (`model_cost_tier`, field 24). Orders the default fallback. */
  costTier?: number;
  /**
   * Devin designates this uid as its family's default (`is_default_model_in_family`,
   * field 31). Measured well-formed: of 39 groups, 20 carry exactly one and NONE
   * carries two — so this is the default, not a heuristic.
   */
  isFamilyDefault: boolean;
  /** Devin marks this uid as recommended (`is_recommended`, field 11). */
  isRecommended: boolean;
  /** Live promotional pricing, when the backend advertises one. */
  promo?: DevinPromo;
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
 * `model_family_metadata` (field 30): the backend's OWN picker model.
 *
 * ```
 * 30 { 1: "GLM-5.2"                            <- model_family_label (the row)
 *      2: { 1: "Effort",     2: {…} }          <- entries[] — one per AXIS
 *      2: { 1: "1M Context", 2: {…} } }
 * ```
 *
 * Field names come from the `devin` binary's own serde strings, so these are
 * the vendor's names, not guesses.
 */
function decodeFamilyMetadata(payload: Uint8Array): { groupLabel?: string; axes: DevinAxis[] } {
  let groupLabel: string | undefined;
  const axes: DevinAxis[] = [];
  for (const sub of parseTLV(payload)) {
    if (sub.no === 1 && sub.wire === 2) {
      groupLabel = readString(sub) || undefined;
      continue;
    }
    if (sub.no !== 2 || sub.wire !== 2) continue;

    // entry: { 1: key, 2: value { 1: enabled, 2: label, 3: order } }
    const axis: DevinAxis = { key: "", enabled: false };
    for (const entry of parseTLV(sub.payload)) {
      if (entry.no === 1 && entry.wire === 2) axis.key = readString(entry);
      else if (entry.no === 2 && entry.wire === 2) {
        for (const value of parseTLV(entry.payload)) {
          if (value.no === 1 && value.wire === 0) axis.enabled = readVarintValue(value) === 1;
          else if (value.no === 2 && value.wire === 2) axis.label = readString(value) || undefined;
        }
      }
    }
    if (axis.key) axes.push(axis);
  }
  return { groupLabel, axes };
}

/** `promo_status` (field 19): `{ 1: kind, 2: { 1: expiry_unix_seconds } }`. */
function decodePromo(payload: Uint8Array): DevinPromo | undefined {
  for (const sub of parseTLV(payload)) {
    if (sub.wire !== 2) continue;
    for (const inner of parseTLV(sub.payload)) {
      if (inner.no === 1 && inner.wire === 0) {
        const expiresAt = readVarintValue(inner);
        if (expiresAt > 0) return { expiresAt };
      }
    }
  }
  return undefined;
}

/**
 * Decode one model config.
 *
 * Field map — names taken from `ClientModelConfig`'s serde strings in the devin
 * binary, values verified against a real capture:
 *
 * | field | name | |
 * |---|---|---|
 * | 1 | `label` | display name |
 * | 3 | `credit_multiplier` | f32 **little**-endian |
 * | 11 | `is_recommended` | |
 * | 18 | `max_tokens` | the context window |
 * | 19 | `promo_status` | promo + expiry |
 * | 22 | `model_uid` | the routing key |
 * | 23 | `model_info` | `.13` max output, `.23` family |
 * | 24 | `model_cost_tier` | |
 * | 30 | `model_family_metadata` | `.1` label, `.2` axes |
 * | 31 | `is_default_model_in_family` | |
 *
 * Unknown fields are ignored, so the backend can add any it likes. A row
 * without a uid is not routable — drop it.
 */
function decodeModelConfig(payload: Uint8Array): DevinModelConfig | null {
  let uid = "";
  let displayName = "";
  let contextWindow = 0;
  let details = { maxOutput: 0, family: "" };
  let family: { groupLabel?: string; axes: DevinAxis[] } = { axes: [] };
  let creditMultiplier: number | undefined;
  let costTier: number | undefined;
  let isFamilyDefault = false;
  let isRecommended = false;
  let promo: DevinPromo | undefined;

  for (const field of parseTLV(payload)) {
    if (field.no === 22 && field.wire === 2) uid = readString(field);
    else if (field.no === 1 && field.wire === 2) displayName = readString(field);
    else if (field.no === 18 && field.wire === 0) contextWindow = readVarintValue(field);
    else if (field.no === 23 && field.wire === 2) details = decodeModelDetails(field.payload);
    else if (field.no === 30 && field.wire === 2) family = decodeFamilyMetadata(field.payload);
    else if (field.no === 3 && field.wire === 5) creditMultiplier = readFloat32LE(field);
    else if (field.no === 24 && field.wire === 0) costTier = readVarintValue(field);
    else if (field.no === 31 && field.wire === 0) isFamilyDefault = readVarintValue(field) === 1;
    else if (field.no === 11 && field.wire === 0) isRecommended = readVarintValue(field) === 1;
    else if (field.no === 19 && field.wire === 2) promo = decodePromo(field.payload);
  }

  if (!uid) return null;
  return {
    uid,
    displayName: displayName || uid,
    contextWindow,
    ...details,
    groupLabel: family.groupLabel,
    axes: family.axes,
    creditMultiplier,
    costTier,
    isFamilyDefault,
    isRecommended,
    promo,
  };
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

  const configs = decodeModelConfigs(body);
  log(`[Devin] GetCliModelConfigs: ${configs.length} configs`);
  return configs;
}

/**
 * Pure decode of a `GetCliModelConfigs` response body.
 *
 * Split out from the fetch so the roster decode can be replayed against a
 * captured response byte-for-byte — the fixture is real wire data, never
 * hand-written.
 */
export function decodeModelConfigs(body: Uint8Array): DevinModelConfig[] {
  const configs: DevinModelConfig[] = [];
  for (const field of topLevelDelimited(body, 1)) {
    const config = decodeModelConfig(field.payload);
    if (config) configs.push(config);
  }
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
