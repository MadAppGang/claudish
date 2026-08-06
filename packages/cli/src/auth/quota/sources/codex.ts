/**
 * Codex (ChatGPT Plus/Pro) quota adapter.
 *
 * Codex has no usage endpoint. What it has instead is better for our purposes:
 * it stamps the current plan state onto the headers of **every** inference
 * response. So the session's own traffic carries the numbers, and reading them
 * costs nothing and adds no latency.
 *
 * That is the whole reason `scrape` exists. The pre-existing
 * `codexQuotaHandler` gets the same figures by firing a real inference request
 * purely to read its response headers — it spends the plan in order to report
 * on the plan. Tolerable when a user explicitly types `claudish quota`;
 * indefensible on a background timer. Here the two live behind different
 * methods so the difference is structural rather than a convention someone has
 * to remember.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../../logger.js";
import type { QuotaAdapter, QuotaPollContext } from "../adapter.js";
import {
  type PlanUsage,
  type QuotaCapability,
  type QuotaWindow,
  epochSecondsToIso,
  toUsedPct,
} from "../types.js";

/** Headers Codex stamps on every response. */
const H_PLAN = "x-codex-plan-type";

/**
 * Codex exposes two window slots, each with a used-percent, a reset time, and
 * — crucially — its own DURATION in minutes.
 *
 * That duration is why nothing here hardcodes "5h"/"7d". Measured on a Pro
 * account 2026-08-05, `primary` reported `window-minutes: 10080` (seven days)
 * while `secondary` reported `0`. So on that plan the primary slot is the
 * WEEKLY window and the secondary slot is unused — the exact opposite of the
 * long-standing assumption in `quota-command.ts`, which labels primary as
 * "5h window" and secondary as "Weekly" and therefore renders both a
 * mislabelled bar and a phantom one.
 *
 * Slot names are positions, not durations. Read the duration.
 */
const WINDOW_SLOTS = [
  {
    pct: "x-codex-primary-used-percent",
    reset: "x-codex-primary-reset-at",
    minutes: "x-codex-primary-window-minutes",
    fallbackId: "primary",
  },
  {
    pct: "x-codex-secondary-used-percent",
    reset: "x-codex-secondary-reset-at",
    minutes: "x-codex-secondary-window-minutes",
    fallbackId: "secondary",
  },
] as const;

/**
 * Render a window duration the way a status line should show it: "5h", "7d".
 * Falls back to minutes when the value divides into nothing tidy.
 */
export function formatWindowMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes < 60) return `${minutes}m`;
  // Not a whole number of hours: render both parts rather than rounding. An
  // earlier version rounded, which turned a 90-minute window into "2h" — a
  // label that misstates the user's actual limit.
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Where `claudish login codex` stores its OAuth credentials. */
function credentialsPath(): string {
  return join(homedir(), ".claudish", "codex-oauth.json");
}

function planLabel(planType: string | null): string {
  if (!planType) return "Codex";
  const pretty = planType.charAt(0).toUpperCase() + planType.slice(1);
  return `Codex ${pretty}`;
}

/**
 * Build a window from one Codex slot.
 *
 * Returns undefined when the slot reports no percent, or when its duration is
 * zero — a zero-length window is a slot the plan does not use, and rendering
 * it produces a permanent "0%" bar for a limit that does not exist.
 */
function windowFrom(
  headers: Headers,
  slot: (typeof WINDOW_SLOTS)[number]
): QuotaWindow | undefined {
  const raw = headers.get(slot.pct);
  if (raw === null) return undefined;

  const pct = toUsedPct(Number.parseFloat(raw));
  if (pct === undefined) return undefined;

  // Duration decides both whether the slot is real and what to call it.
  const minutesRaw = headers.get(slot.minutes);
  let id: string = slot.fallbackId;
  if (minutesRaw !== null) {
    const minutes = Number.parseInt(minutesRaw, 10);
    if (Number.isFinite(minutes) && minutes <= 0) return undefined; // slot unused
    const formatted = formatWindowMinutes(minutes);
    if (formatted) id = formatted;
  }

  const window: QuotaWindow = { id, used_pct: pct };

  // Codex reports resets as epoch SECONDS — not milliseconds, not ISO.
  const resetRaw = headers.get(slot.reset);
  if (resetRaw !== null) {
    const iso = epochSecondsToIso(Number.parseInt(resetRaw, 10));
    if (iso) window.resets_at = iso;
  }
  return window;
}

/** Pull plan usage out of any Codex response. Pure, synchronous, never throws. */
export function scrapeCodexHeaders(headers: Headers): PlanUsage | undefined {
  const windows: QuotaWindow[] = [];
  for (const slot of WINDOW_SLOTS) {
    const w = windowFrom(headers, slot);
    if (w) windows.push(w);
  }

  // No usable window means this response carried nothing — an error response,
  // or a proxy that stripped the headers. Report absence, don't invent a zero.
  if (windows.length === 0) return undefined;

  return {
    label: planLabel(headers.get(H_PLAN)),
    windows,
    source: "provider",
    observed_at: new Date().toISOString(),
  };
}

/**
 * Pick a model that actually exists on this account, from the Codex CLI's own
 * cache of the roster it was served.
 *
 * This matters more than it looks: a stale model id is rejected with a 400,
 * and a 400 carries NO `x-codex-*` headers at all — so a wrong id here is
 * indistinguishable from "this provider does not report quota". Discovering
 * the id rather than pinning one keeps a roster change from silently
 * presenting as a missing feature.
 */
function resolveProbeModel(): string | undefined {
  try {
    const cachePath = join(homedir(), ".codex", "models_cache.json");
    if (!existsSync(cachePath)) return undefined;
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    for (const m of cache.models ?? []) {
      const slug = m?.slug ?? m?.id;
      if (typeof slug === "string" && slug.length > 0) return slug;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

function readCodexCredentials(): { access_token: string; account_id?: string } | undefined {
  try {
    const path = credentialsPath();
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

export const codexQuotaAdapter: QuotaAdapter = {
  providerId: "openai-codex",
  label: "Codex",

  capability(): QuotaCapability {
    return { kind: "headers" };
  },

  isAvailable(): boolean {
    // Sync on purpose: called from the CLI's provider list and from registry
    // lookups, neither of which can await.
    try {
      return existsSync(credentialsPath());
    } catch {
      return false;
    }
  },

  scrape(response: Response): PlanUsage | undefined {
    return scrapeCodexHeaders(response.headers);
  },

  /**
   * Force a fresh reading by issuing a real inference request and reading the
   * headers off it. THIS SPENDS QUOTA — it is reachable only from
   * `claudish quota`, never from a session. Kept minimal (one token, no
   * storage) so the cost of asking is as small as it can be.
   */
  async fetchExplicit(_ctx?: QuotaPollContext): Promise<PlanUsage | undefined> {
    const creds = readCodexCredentials();
    if (!creds?.access_token) return undefined;

    const model = resolveProbeModel();
    if (!model) {
      log("[quota:codex] no model available to probe with — is the Codex CLI signed in?");
      return undefined;
    }

    try {
      const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.access_token}`,
          "chatgpt-account-id": creds.account_id || "",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          originator: "codex",
          "OpenAI-Beta": "responses",
        },
        body: JSON.stringify({
          model,
          instructions: "Reply with just: ok",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
          stream: true,
          store: false,
        }),
      });

      const plan = scrapeCodexHeaders(res.headers);

      // Drain the body so the connection is not left dangling.
      try {
        await res.text();
      } catch {
        /* the headers are what we came for */
      }
      return plan;
    } catch (err) {
      log(`[quota:codex] explicit fetch failed: ${err}`);
      return undefined;
    }
  },
};
