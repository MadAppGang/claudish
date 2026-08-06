/**
 * The quota adapter registry.
 *
 * Keyed on the canonical provider id — a `PROVIDER_PROFILES` key such as
 * "openai-codex" — because that is what `ProviderTransport.name` and
 * `TokenTrackerConfig.providerName` already carry, so a lookup needs no
 * translation on the hot path.
 *
 * Note that this is NOT the same vocabulary a user types. `getShortcuts()`
 * covers routing prefixes only: "gpt", "chatgpt" and "openai" are not
 * shortcuts at all, and "gemini" routes to the pay-per-use direct API rather
 * than the subscription. `quota-command.ts` therefore keeps a small
 * FRIENDLY_NAMES map for the command surface — see the comment there.
 *
 * ## Why the unsupported providers are listed
 *
 * Six of the eight subscription providers claudish supports expose no usage
 * surface at all — no endpoint, no headers. They are registered anyway, with
 * `capability(): {kind: "none"}` carrying the probe evidence.
 *
 * Leaving them out would be less code, but a missing entry makes
 * `claudish quota glm-coding` answer "Unknown provider" — which reads as a
 * typo or an unimplemented feature, when the truth is a researched dead end.
 * It also guarantees the research gets repeated: the verdict lives next to the
 * decision, dated, with what was tried attached, so the next person can judge
 * how stale it is instead of re-probing to find out.
 */

import type { QuotaAdapter } from "./adapter.js";
import { antigravityQuotaAdapter } from "./sources/antigravity.js";
import { codexQuotaAdapter } from "./sources/codex.js";
import type { ProbeRecord, QuotaCapability } from "./types.js";

/**
 * Build a registry entry for a provider proven to have no usage surface.
 * These have no credentials to check and nothing to fetch — the entry exists
 * so the CLI can answer honestly and cite its evidence.
 */
function unsupported(providerId: string, label: string, evidence: ProbeRecord): QuotaAdapter {
  return {
    providerId,
    label,
    capability(): QuotaCapability {
      return { kind: "none", evidence };
    },
    // An unsupported provider is never "available" for quota purposes, whether
    // or not the user holds a credential for it.
    isAvailable: () => false,
  };
}

/**
 * Date the probes below were run. Re-runnable scripts live under
 * `ai-docs/sessions/dev-arch-quota-adapters-20260805-191338-d2cd6fe9/`.
 */
const PROBED_ON = "2026-08-05";

const NO_SURFACE: Array<{ id: string; label: string; evidence: ProbeRecord }> = [
  {
    id: "glm-coding",
    label: "GLM Coding Plan",
    evidence: {
      researched_at: PROBED_ON,
      probed: [
        {
          what: "10 candidate usage endpoints under api.z.ai",
          result: "404, or HTTP 200 wrapping an error envelope",
        },
        {
          what: "/api/biz/customer/{usage,info,quota,package,subscription,balance}",
          result:
            'all six return an identical {"code":500,"msg":"系统异常"} under HTTP 200 — a catch-all handler, not six routes',
        },
        {
          what: "POST /api/coding/paas/v4/chat/completions (200)",
          result: "11 response headers, none quota-related",
        },
      ],
      conclusion: "no-surface",
      recheck_if:
        "Z.AI opens the biz/customer prefix to API keys — it exists but appears to require a portal session token",
    },
  },
  {
    id: "kimi-coding",
    label: "Kimi Coding Plan",
    evidence: {
      researched_at: PROBED_ON,
      probed: [
        {
          what: "18 candidate paths on api.kimi.com and api.moonshot.ai",
          result: "404 except /coding/v1/me",
        },
        {
          what: "GET /coding/v1/me (200)",
          result:
            'profile only — carries a plan LABEL (user_level_name, e.g. "Vivace") but no usage numbers',
        },
        {
          what: "POST /coding/v1/messages (200)",
          result: "11 response headers, none quota-related",
        },
        {
          what: "POST /coding/v1/messages once the plan was exhausted (403)",
          result:
            'the error BODY reports exhaustion — "You\'ve reached your usage limit for this billing cycle" — so the binary exhausted/not-exhausted state is observable, but no percentage and no reset timestamp is ever exposed',
        },
      ],
      conclusion: "no-surface",
      recheck_if: "Moonshot adds a usage endpoint beside the working /coding/v1/me",
    },
  },
  {
    id: "minimax-coding",
    label: "MiniMax Coding Plan",
    evidence: {
      researched_at: PROBED_ON,
      probed: [
        {
          what: "7 candidate usage endpoints on api.minimax.io",
          result: "404 page not found (plain text — a router miss)",
        },
        {
          what: "POST /anthropic/v1/messages (200)",
          result: "15 response headers, all transport/tracing",
        },
      ],
      conclusion: "no-surface",
      recheck_if:
        "re-probe with MINIMAX_CODING_API_KEY — the 2026-08-05 run fell back to MINIMAX_API_KEY, though a 404 is a routing verdict rather than an auth one",
    },
  },
  {
    id: "opencode-zen-go",
    label: "OpenCode Zen Go",
    evidence: {
      researched_at: PROBED_ON,
      probed: [
        {
          what: "6 candidate usage endpoints under opencode.ai/zen",
          result: "the marketing site's HTML 404 — no API route exists there",
        },
        {
          what: "POST /zen/go/v1/chat/completions (200)",
          result: "8 response headers, all Cloudflare/transport",
        },
      ],
      conclusion: "no-surface",
    },
  },
  {
    id: "sakana-subscription",
    label: "Sakana Fugu Subscription",
    evidence: {
      researched_at: PROBED_ON,
      probed: [
        {
          what: "5 candidate usage endpoints on api.sakana.ai",
          result: "clean OpenAI-style JSON 404s",
        },
        {
          what: "POST /v1/chat/completions (200, max_tokens=16)",
          result:
            "6 response headers, none quota-related — re-run after a max_tokens=1 attempt was rejected with 400",
        },
      ],
      conclusion: "no-surface",
    },
  },
  {
    id: "qwen-cloud",
    label: "Qwen Plan",
    evidence: {
      researched_at: "2026-08-03",
      probed: [
        {
          what: "8 candidate usage endpoints on token-plan.ap-southeast-1.maas.aliyuncs.com",
          result: "all 404",
        },
        {
          what: "POST /v1/messages (200)",
          result: "no x-ratelimit-* headers — only x-envoy-upstream-service-time and x-request-id",
        },
      ],
      conclusion: "no-surface",
      recheck_if: "Alibaba Model Studio ships a usage surface, or a console/portal API is found",
    },
  },
];

const ADAPTERS: QuotaAdapter[] = [
  codexQuotaAdapter,
  antigravityQuotaAdapter,
  ...NO_SURFACE.map((p) => unsupported(p.id, p.label, p.evidence)),
];

const BY_ID = new Map<string, QuotaAdapter>(ADAPTERS.map((a) => [a.providerId, a]));

/** Look up the adapter for a canonical provider id. */
export function resolveQuotaAdapter(providerId: string | undefined): QuotaAdapter | undefined {
  if (!providerId) return undefined;
  return BY_ID.get(providerId);
}

/** Every registered adapter, in declaration order. */
export function allQuotaAdapters(): readonly QuotaAdapter[] {
  return ADAPTERS;
}

/** Adapters that can actually report usage — for the CLI's picker. */
export function reportableQuotaAdapters(): QuotaAdapter[] {
  return ADAPTERS.filter((a) => a.capability().kind !== "none");
}
