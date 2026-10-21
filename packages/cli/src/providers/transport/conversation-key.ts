/**
 * One opaque, stable key per Claude Code conversation, shared by every transport
 * that has to tell an upstream "these requests belong together".
 *
 * Two consumers, one derivation, so they can never diverge:
 *   - OpenAICodexTransport sends it as the Responses API `prompt_cache_key`.
 *   - OpenCodeZenTransport sends it as the `x-opencode-session` header.
 */

import { createHash, randomBytes } from "node:crypto";
import { extractSessionId } from "../../hooks/harness.js";

/**
 * Fallback conversation key, minted once per process.
 *
 * Only reached when the inbound request carries no Claude Code session id —
 * an older client, or a direct API consumer. Process-scoped rather than
 * derived from `cwd`, because two claudish processes in the same directory are
 * two different conversations and must not share a key; a single process
 * serving several conversations (the `serve` gateway) is the residual overlap,
 * and the cost there is a routing hint that is merely less precise.
 */
const FALLBACK_CONVERSATION_KEY = randomBytes(16).toString("hex");

/**
 * A stable, opaque key scoped to ONE conversation.
 *
 * Keyed on Claude Code's own session id (`metadata.user_id` → `session_id`),
 * which is stable for every turn of a session, survives a claudish restart
 * mid-conversation, and cannot collide between two concurrent conversations.
 * Contrast a `cwd`-derived key, which is the same value for two unrelated
 * sessions in one repo and outlives them both.
 *
 * The id is HASHED rather than sent raw. It is not a secret, but it is a
 * local correlation handle that also appears in transcripts and in the
 * behavior journal, and a stable one-way digest serves every consumer exactly
 * as well. `device_id` and `account_uuid` from that same blob are never read
 * at all — see `extractSessionId`.
 *
 * A pure function of the request: callers must pass the request in hand, never
 * a value stashed on a transport, because one transport instance serves
 * overlapping conversations (see `ProviderTransport.getHeaders`).
 */
export function conversationKey(claudeRequest?: unknown): string {
  const sessionId = extractSessionId(claudeRequest);
  if (!sessionId) return `claudish_${FALLBACK_CONVERSATION_KEY}`;
  return `claudish_${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}
