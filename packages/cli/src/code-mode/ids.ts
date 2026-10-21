/**
 * Identity keys for `openai-codex` requests.
 *
 * `accountKey` names the ChatGPT account ONE request signs with. It is read
 * from that request's own auth binding (the artifact `refreshAuth` returned),
 * never from the `CodexOAuth` singleton or the transport's shared artifact,
 * because the login can change in-process (`reloadCredentials`) between two
 * requests, and a value read from shared state could name another request's
 * account.
 */

import { createHash } from "node:crypto";
import type { AuthBinding } from "../providers/transport/types.js";

/** The header the Codex OAuth artifact carries when the login has an account id. */
const ACCOUNT_ID_HEADER = "chatgpt-account-id";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * `sha256("openai-codex\0" + chatgpt-account-id)` from the binding's headers.
 *
 * Defined only when the binding's arm is `"oauth"` and the account-id header
 * is present (`codex-credential.ts` sets it only when the login has an account
 * id). Undefined otherwise: an api-key request, a legacy transport with no
 * binding, or a login without an account id.
 */
export function accountKeyFromBinding(binding: AuthBinding | undefined): string | undefined {
  const auth = binding?.auth;
  if (!auth || auth.arm !== "oauth") return undefined;
  let accountId: string | undefined;
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (name.toLowerCase() === ACCOUNT_ID_HEADER && typeof value === "string" && value) {
      accountId = value;
      break;
    }
  }
  if (!accountId) return undefined;
  return sha256Hex(`openai-codex\0${accountId}`);
}

/**
 * `sha256(session id + "\0" + accountKey)`: the key of one Claude Code
 * session on one account. Undefined when the request carries no Claude Code
 * session id — the process-wide `conversationKey()` fallback is a cache hint
 * and must never key stateful execution — or when there is no account key.
 */
export function sessionKeyFor(
  sessionId: string | undefined,
  accountKey: string | undefined
): string | undefined {
  if (!sessionId || !accountKey) return undefined;
  return sha256Hex(`${sessionId}\0${accountKey}`);
}

const CALL_ID_HEX = /^call_([0-9a-f]{32})$/;
const NESTED_ID = /^toolu_cx_([0-9a-f]{32})_(\d{1,4})$/;

const EXEC_KEY = /^[0-9a-f]{32}$/;

/**
 * The 32-hex key of an exec call: the suffix of a `call_<32 hex>` id (the
 * Codex shape), else the first 32 hex of `sha256(callId)`. Records are keyed
 * by it and keep the original id beside it. Idempotent: a key maps to itself.
 */
export function execKeyFor(callId: string): string {
  if (EXEC_KEY.test(callId)) return callId;
  const match = CALL_ID_HEX.exec(callId);
  return match ? match[1] : sha256Hex(callId).slice(0, 32);
}

/** The tool_use id of nested call `seq` of exec `execCallId`: `toolu_cx_<hex>_<seq>`. */
export function encodeNestedId(execCallId: string, seq: number): string {
  return `toolu_cx_${execKeyFor(execCallId)}_${seq}`;
}

/**
 * `{execKey, seq}` for a nested tool_use id, matching
 * `^toolu_cx_([0-9a-f]{32})_(\d{1,4})$` exactly. Every other id — classic
 * Claude ids, the parallel-wrapper `toolu_<id>_p<k>` ids — decodes to
 * undefined, so history grouping never depends on the store.
 */
export function decodeNestedId(id: string): { execKey: string; seq: number } | undefined {
  const match = NESTED_ID.exec(id);
  if (!match) return undefined;
  return { execKey: match[1], seq: Number(match[2]) };
}

/**
 * RFC 4122 version-5 UUID of `name` in the namespace derived from `namespace`
 * (any string; its sha256 supplies the 16 namespace bytes). Stable for stable
 * inputs, which keeps the lite `additional_tools` item id a stable prompt-cache
 * prefix.
 */
export function uuidV5(namespace: string, name: string): string {
  const ns = createHash("sha256").update(namespace).digest().subarray(0, 16);
  const hash = createHash("sha1").update(ns).update(name).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
