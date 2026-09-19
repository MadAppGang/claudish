/**
 * OpenCode Zen ProviderTransport (both tiers: `opencode-zen-go` and `opencode-zen`).
 *
 * The OpenAI transport plus one header. Zen Go began rejecting every request that
 * lacks `x-opencode-session` — measured 2026-09-12, a 400 with error type
 * `MissingSessionID`, which claudish's fallback chain then silently stepped past.
 * OpenCode's docs state the contract: "Send a stable session ID in
 * x-opencode-session for each conversation".
 *
 * The value is `conversationKey()` — Claude Code's session id, hashed, the same
 * derivation Codex uses for `prompt_cache_key`. Hashed because the raw id is a
 * local correlation handle with no reason to leave the machine; the upstream only
 * needs it stable per conversation.
 *
 * The metered `opencode-zen` tier sends it too, on the same docs sentence, but that
 * is UNVERIFIED live: there is no OPENCODE_API_KEY on the machine that measured Go.
 *
 * The same docs paragraph asks a client to "identify itself with its own user agent
 * … rather than a generic SDK or HTTP-library name", and this relay enforces that
 * on its other route: `model-discovery.ts:465-481` records that a UA-less roster
 * request to Zen Go answers `403 error code: 1010` — Cloudflare's browser-integrity
 * block — while the identical request carrying one returns 200. The chat path sits
 * behind the same edge, so it sends the same `claudish/<version>` string. Credit to
 * @oudivad, who reported both headers together in PR #249; this file took the
 * session id first and the UA second.
 */

import { VERSION } from "../../version.js";
import { AnthropicProviderTransport } from "./anthropic-compat.js";
import { conversationKey } from "./conversation-key.js";
import { OpenAIProviderTransport } from "./openai.js";

export class OpenCodeZenTransport extends OpenAIProviderTransport {
  /**
   * Both headers are written BEFORE the base transport's, so auth and any
   * provider-declared `headers` still win — the precedence `model-discovery.ts`
   * uses for the roster request on this same relay. No builtin declares either
   * key today, so nothing changes in practice; it means a custom endpoint that
   * pins its own value keeps it.
   *
   * The two are not equally inert, though. For the User-Agent, losing to a
   * pinned value is harmless — it is an identity string either way. For
   * `x-opencode-session` it is a REVERSAL: this header used to be spread after
   * the base headers and always won. A custom endpoint that pins a static
   * session id now collapses every conversation onto one upstream routing
   * identity, silently. That is the right default (an explicit config should
   * beat a derived value) but it is a real trade, not a no-op.
   *
   * The session id is derived from `claudeRequest` on every call, never cached
   * on the instance: one transport is shared by every request for a model, so
   * an instance field would leak one conversation's id into the next.
   */
  override async getHeaders(claudeRequest?: unknown): Promise<Record<string, string>> {
    return {
      "User-Agent": `claudish/${VERSION}`,
      "x-opencode-session": conversationKey(claudeRequest),
      ...(await super.getHeaders()),
    };
  }
}

/** OpenCode's Messages endpoint uses Bearer authentication and a session header. */
export class OpenCodeZenMessagesTransport extends AnthropicProviderTransport {
  override async getHeaders(claudeRequest?: unknown): Promise<Record<string, string>> {
    return {
      "User-Agent": `claudish/${VERSION}`,
      "x-opencode-session": conversationKey(claudeRequest),
      ...(await super.getHeaders()),
    };
  }
}
