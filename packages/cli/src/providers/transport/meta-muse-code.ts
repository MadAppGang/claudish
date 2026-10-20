/**
 * Muse Code subscription transport: OpenAI Responses at
 * `https://api.meta.ai/v1/responses`, signed with a key minted from the Muse
 * Code login (`providers/meta-muse/muse-credentials.ts`).
 *
 * Three things differ from the OpenAI base transport:
 *
 * 1. **Auth per request, from the credential authority** (`refreshAuth`, step
 *    5b): the minted key is short-lived and re-minted on a 30-minute
 *    entitlement TTL, so it cannot be a constructor argument. A failure
 *    throws the core's classified error, which ComposedHandler's one
 *    classifier answers (`handlers/shared/auth-failure.ts`).
 * 2. **401 → re-mint once** (`forceRefreshAuth`), with the rejected request's
 *    key, so a failure that names an already-replaced key re-mints nothing.
 * 3. **The body the Muse Code CLI sends**: `store: false`, encrypted reasoning
 *    included, and `reasoning.summary: "auto"` where reasoning is sent, which
 *    is what Claude Code shows as thinking (muse-wire.md §2.3).
 *
 * The served context window comes from the account's dynamic models catalog,
 * memoized, with a 5-minute backoff after a miss.
 */

import { credentials } from "../../auth/credentials/authority.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import { forceRefreshMuseApiKey, requestPathMayPrompt } from "../meta-muse/muse-credentials.js";
import { MUSE_CODE_BASE_URL } from "../meta-muse/muse-mint.js";
import { discoverContextWindow } from "../model-discovery.js";
import { OpenAIProviderTransport } from "./openai.js";

const WINDOW_RETRY_MS = 5 * 60_000;
const MAX_REMEMBERED_SIGNERS = 8;

/** The bearer token of a header bag, if it carries one. */
function bearerOf(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  const value = headers.Authorization ?? headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

export class MuseCodeTransport extends OpenAIProviderTransport {
  override readonly displayName = "Muse Code";
  private auth?: RequestAuth;
  /** Minted key → the login that minted it (`RequestAuth.signer`), newest last. */
  private readonly signers = new Map<string, string>();
  private window = 0;
  private windowRetryAt = 0;

  /**
   * `/v1/responses` on the fixed Muse Code host, whatever the provider's base
   * URL says: the request carries the minted key and the prompt, and nothing in
   * the environment may redirect them (`MUSE_CODE_BASE_URL` in muse-mint.ts).
   */
  override getEndpoint(): string {
    return `${MUSE_CODE_BASE_URL}/v1/responses`;
  }

  async refreshAuth(): Promise<void> {
    this.auth = this.remember(
      await credentials.getRequestAuth("meta-muse-code", { model: this.modelName })
    );
    if (!this.window && Date.now() >= this.windowRetryAt) {
      this.window = (await discoverContextWindow("meta-muse-code", this.modelName)) ?? 0;
      if (!this.window) this.windowRetryAt = Date.now() + WINDOW_RETRY_MS;
    }
  }

  async getHeaders(): Promise<Record<string, string>> {
    return { ...(this.auth?.headers ?? {}), ...(this.provider.headers ?? {}) };
  }

  async forceRefreshAuth(ctx?: { rejectedHeaders?: Record<string, string> }): Promise<void> {
    await forceRefreshMuseApiKey({
      rejectedKey: bearerOf(ctx?.rejectedHeaders),
      prompt: requestPathMayPrompt(),
    });
    this.auth = this.remember(
      await credentials.getRequestAuth("meta-muse-code", { model: this.modelName })
    );
  }

  /**
   * The source and tier of the login that minted the key a request was SENT
   * with: looked up by that request's own bearer, which no later rotation of
   * `this.auth` can change.
   */
  signingCredential(sentHeaders: Record<string, string>): string | undefined {
    const key = bearerOf(sentHeaders);
    return key ? this.signers.get(key) : undefined;
  }

  /** Remember which login minted this artifact's key, captured with the key itself. */
  private remember(auth: RequestAuth): RequestAuth {
    const key = bearerOf(auth.headers);
    if (key && auth.signer) {
      this.signers.delete(key);
      this.signers.set(key, auth.signer);
      // A bound, not a policy: keys rotate at most every few minutes, so the
      // newest few cover every request still in flight.
      while (this.signers.size > MAX_REMEMBERED_SIGNERS) {
        const oldest = this.signers.keys().next().value;
        if (oldest === undefined) break;
        this.signers.delete(oldest);
      }
    }
    return auth;
  }

  getContextWindow(): number {
    return this.window;
  }

  transformPayload(payload: any): any {
    const next: any = {
      ...payload,
      store: false,
      include: Array.from(new Set([...(payload?.include ?? []), "reasoning.encrypted_content"])),
    };
    const reasoning = next.reasoning;
    if (reasoning && typeof reasoning === "object" && reasoning.summary === undefined) {
      next.reasoning = { ...reasoning, summary: "auto" };
    }
    return next;
  }
}
