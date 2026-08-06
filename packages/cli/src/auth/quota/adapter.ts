/**
 * The quota adapter interface.
 *
 * One adapter per provider feeds BOTH consumers — the `plan` key in the token
 * file that a status line renders, and the ANSI output of `claudish quota`.
 * The previous registry could not do this: its `handler: () => Promise<void>`
 * printed to stdout and called `process.exit()`, so there was no seam to get
 * structured data out of it.
 *
 * ## Three methods, three cost profiles
 *
 * The split exists to make one rule mechanically checkable rather than merely
 * intended: **never spend quota to measure quota.**
 *
 * | method           | cost                        | called from            |
 * | ---------------- | --------------------------- | ---------------------- |
 * | `scrape`         | free — reads a response we   | every session response |
 * |                  | already received             |                        |
 * | `poll`           | free — a metadata call that  | a TTL timer, off the   |
 * |                  | consumes no model quota      | request path           |
 * | `fetchExplicit`  | MAY SPEND QUOTA              | `claudish quota` only  |
 *
 * `fetchExplicit` is the only one permitted to cost the user anything, and it
 * only ever runs because the user typed the command. Codex is the reason this
 * distinction matters: it has no usage endpoint, so the only way to force a
 * fresh reading is to issue a real inference request — spending the plan in
 * order to report on it. That is acceptable on demand and unacceptable in a
 * background loop.
 */

import type { PlanUsage, QuotaCapability } from "./types.js";

/** Optional context a caller can supply to sharpen a reading. */
export interface QuotaPollContext {
  /**
   * The model the session is actually running. Providers that report per-model
   * quota (Antigravity) use it to report the bucket the user is spending
   * rather than an arbitrary one.
   */
  modelId?: string;
}

export interface QuotaAdapter {
  /**
   * Canonical provider id — a `PROVIDER_PROFILES` key such as "openai-codex"
   * or "glm-coding". Keying on this rather than a hand-maintained alias list
   * reuses `getShortcuts()`, which already maps every alias to this id.
   */
  readonly providerId: string;

  /** Human label used for `PlanUsage.label` and CLI headings. */
  readonly label: string;

  /** Whether, and how, this provider can report usage. */
  capability(): QuotaCapability;

  /** True when credentials for this provider are present. */
  isAvailable(): boolean;

  /**
   * Read usage out of a response the session already received.
   *
   * MUST be synchronous and pure. The headers are already buffered, so there
   * is nothing to await — which is what makes the hot-path hook incapable of
   * delaying a turn. It is not a fast path guarded by a timeout; it is a path
   * with no I/O to time out.
   *
   * Returns undefined when this particular response carries no usage.
   * Only meaningful for capability kind "headers".
   */
  scrape?(response: Response): PlanUsage | undefined;

  /**
   * Fetch usage from a free metadata endpoint. Runs on a TTL timer, never on
   * the request path. Only meaningful for capability kind "endpoint".
   */
  poll?(ctx?: QuotaPollContext): Promise<PlanUsage | undefined>;

  /**
   * Serve `claudish quota <provider>`. MAY spend quota. Never called from a
   * session — only from the user-invoked command.
   */
  fetchExplicit?(ctx?: QuotaPollContext): Promise<PlanUsage | undefined>;
}
