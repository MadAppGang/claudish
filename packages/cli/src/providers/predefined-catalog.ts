/**
 * The bundled predefined-endpoint catalog — pure data, no imports beyond its
 * own type.
 *
 * This is a `.ts` module rather than a JSON file for one reason that matters:
 * `bun build --compile` embeds the MODULE GRAPH in the executable, so an array
 * reached by a static import is literally bytes inside the binary. There is no
 * run-time lookup and therefore nothing that can fail to resolve on a Homebrew
 * install, where the artifact is a bare executable with no sidecar files. A
 * `readFileSync(join(import.meta.dir, …))` does not survive that, and its
 * failure mode is the worst possible one: the catalog silently does not exist.
 * (Proof, not assertion: `validation/compiled-run.md` in this feature's session
 * directory records the compiled binary printing this array from a scrubbed env
 * in an unrelated working directory.)
 *
 * The second reason is that a typo in a field name is a BUILD error here and a
 * silent run-time skip in JSON — and this is the one artifact whose correctness
 * cannot be established by running it.
 *
 * "But a `.ts` file isn't data." It is, in the way that matters: adding vendor
 * N+1 is appending one object literal. No function is written, no branch added,
 * no other file changed.
 *
 * Rows carry env var NAMES, never secrets. Excluded vendors are not silently
 * missing — each is recorded with its measured reason in the session's
 * `research.md`, so the catalog's gaps are legible rather than looking like an
 * oversight.
 */

import type { PredefinedEndpoint } from "./predefined-endpoint-schema.js";

export const PREDEFINED_ENDPOINTS: readonly PredefinedEndpoint[] = [
  {
    name: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "GROQ_API_KEY",
    apiKeyUrl: "https://console.groq.com/keys",
    description: "Groq LPU inference (groq@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "cerebras",
    displayName: "Cerebras",
    baseUrl: "https://api.cerebras.ai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "CEREBRAS_API_KEY",
    apiKeyUrl: "https://cloud.cerebras.ai",
    description: "Cerebras Inference wafer-scale hosting (cerebras@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    // NOT models-index's `together-ai` aggregator vendor id — that is a catalog
    // label for models Together HOSTS, whereas this row is the direct API. A
    // model listed under `together-ai` there is reachable here as `together@`.
    name: "together",
    displayName: "Together AI",
    baseUrl: "https://api.together.xyz",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "TOGETHER_API_KEY",
    apiKeyUrl: "https://api.together.xyz/settings/api-keys",
    description:
      "Together AI direct inference API (together@) — distinct from the 'together-ai' vendor id models-index uses as an aggregator label",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "FIREWORKS_API_KEY",
    apiKeyUrl: "https://fireworks.ai/account/api-keys",
    description: "Fireworks AI serverless inference (fireworks@)",
    evidence: {
      tier: "probe",
      verdict: "model-gate",
      status: 404,
      measuredAt: "2026-08-14",
      note: "404 rejecting the fake model ('Model not found, inaccessible, and/or not deployed'); the bogus sibling path answered 'Path not found', so the route resolved",
    },
  },
  {
    // apiPath does NOT start with /v1 — the version segment is in baseUrl.
    name: "deepinfra",
    displayName: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiPath: "/chat/completions",
    format: "openai",
    apiKeyEnvVar: "DEEPINFRA_API_KEY",
    apiKeyUrl: "https://deepinfra.com/dash/api_keys",
    description: "DeepInfra hosted open models (deepinfra@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "nebius",
    displayName: "Nebius AI Studio",
    baseUrl: "https://api.studio.nebius.com",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "NEBIUS_API_KEY",
    apiKeyUrl: "https://studio.nebius.com",
    description: "Nebius AI Studio hosted open models (nebius@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "hyperbolic",
    displayName: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "HYPERBOLIC_API_KEY",
    apiKeyUrl: "https://app.hyperbolic.xyz",
    description: "Hyperbolic decentralized GPU inference (hyperbolic@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "sambanova",
    displayName: "SambaNova Cloud",
    baseUrl: "https://api.sambanova.ai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "SAMBANOVA_API_KEY",
    apiKeyUrl: "https://cloud.sambanova.ai",
    description: "SambaNova Cloud RDU inference (sambanova@)",
    evidence: {
      tier: "probe",
      verdict: "model-gate",
      status: 404,
      measuredAt: "2026-08-14",
      note: "404 naming our fake model ('The model `probe-nonexistent-model-zzz` does not exist'), i.e. the route resolved and the model was rejected before auth",
    },
  },
  {
    // apiPath does NOT start with /v1 — the version segment is in baseUrl.
    name: "novita",
    displayName: "Novita AI",
    baseUrl: "https://api.novita.ai/v3/openai",
    apiPath: "/chat/completions",
    format: "openai",
    apiKeyEnvVar: "NOVITA_API_KEY",
    apiKeyUrl: "https://novita.ai/settings",
    description: "Novita AI hosted open models (novita@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "baseten",
    displayName: "Baseten",
    baseUrl: "https://inference.baseten.co",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "BASETEN_API_KEY",
    apiKeyUrl: "https://app.baseten.co",
    description: "Baseten model APIs (baseten@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 403, measuredAt: "2026-08-14" },
  },
  {
    // No /v1 anywhere — Perplexity's chat route is at the host root.
    name: "perplexity",
    displayName: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    apiPath: "/chat/completions",
    format: "openai",
    apiKeyEnvVar: "PERPLEXITY_API_KEY",
    apiKeyUrl: "https://www.perplexity.ai/settings/api",
    description: "Perplexity Sonar search-grounded models (perplexity@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "venice",
    displayName: "Venice AI",
    baseUrl: "https://api.venice.ai/api",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "VENICE_API_KEY",
    apiKeyUrl: "https://venice.ai/settings/api",
    description: "Venice AI privacy-focused open models (venice@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "chutes",
    displayName: "Chutes",
    baseUrl: "https://llm.chutes.ai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "CHUTES_API_KEY",
    description: "Chutes decentralized inference on Bittensor (chutes@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "featherless",
    displayName: "Featherless AI",
    baseUrl: "https://api.featherless.ai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "FEATHERLESS_API_KEY",
    description: "Featherless AI serverless HuggingFace model hosting (featherless@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "parasail",
    displayName: "Parasail",
    baseUrl: "https://api.parasail.io",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "PARASAIL_API_KEY",
    description: "Parasail on-demand GPU inference (parasail@)",
    evidence: {
      tier: "probe",
      verdict: "auth-realm",
      status: 401,
      measuredAt: "2026-08-14",
      note: "non-OpenAI error shape: plain text 'Unauthorized. Invalid token.' under content-type application/json;charset=ISO-8859-1. Classified terminal on the 401 status, so no retry is burned; see validation/error-shape-probe.md",
    },
  },
  {
    name: "inference-net",
    displayName: "Inference.net",
    baseUrl: "https://api.inference.net",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "INFERENCE_NET_API_KEY",
    description: "Inference.net distributed open-model inference (inference-net@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "aimlapi",
    displayName: "AI/ML API",
    baseUrl: "https://api.aimlapi.com",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "AIMLAPI_API_KEY",
    description: "AI/ML API multi-vendor aggregator (aimlapi@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "requesty",
    displayName: "Requesty",
    baseUrl: "https://router.requesty.ai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "REQUESTY_API_KEY",
    description: "Requesty LLM router (requesty@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 403, measuredAt: "2026-08-14" },
  },
  {
    name: "nanogpt",
    displayName: "NanoGPT",
    baseUrl: "https://nano-gpt.com/api",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "NANOGPT_API_KEY",
    description: "NanoGPT pay-per-prompt multi-vendor aggregator (nanogpt@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    // The OpenAI-COMPATIBILITY surface (`/compatibility/v1`), not Cohere's own
    // native `/v2/chat` API — the compatibility path is the only one the openai
    // transport can speak.
    name: "cohere",
    displayName: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "COHERE_API_KEY",
    apiKeyUrl: "https://dashboard.cohere.com/api-keys",
    description: "Cohere Command models via their OpenAI-compatibility layer (cohere@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "scaleway",
    displayName: "Scaleway Generative APIs",
    baseUrl: "https://api.scaleway.ai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "SCALEWAY_API_KEY",
    apiKeyUrl: "https://console.scaleway.com",
    description: "Scaleway Generative APIs, EU-hosted open models (scaleway@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 403, measuredAt: "2026-08-14" },
  },
  {
    name: "upstage",
    displayName: "Upstage",
    baseUrl: "https://api.upstage.ai",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "UPSTAGE_API_KEY",
    apiKeyUrl: "https://console.upstage.ai",
    description: "Upstage Solar models (upstage@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "writer",
    displayName: "Writer",
    baseUrl: "https://api.writer.com",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "WRITER_API_KEY",
    description: "Writer Palmyra models (writer@)",
    evidence: {
      tier: "probe",
      verdict: "auth-realm",
      status: 401,
      measuredAt: "2026-08-14",
      note: 'non-OpenAI error shape: {"tpe":"fail.auth","errors":[{"description":…}]} with no top-level `error` object. Classified terminal on the 401 status, so no retry is burned; see validation/error-shape-probe.md',
    },
  },
  {
    // The CHINA-REGION Moonshot product (api.moonshot.cn), which is a different
    // service from the builtin `kimi` provider — `kimi@` / `moon@` /
    // `moonshot@` are that builtin's shortcuts and reach the international
    // Kimi endpoint on a different credential. Both can be configured at once;
    // they do not share keys, model lists, or billing.
    name: "moonshot-cn",
    displayName: "Moonshot AI (China)",
    baseUrl: "https://api.moonshot.cn",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "MOONSHOT_CN_API_KEY",
    apiKeyUrl: "https://platform.moonshot.cn",
    description:
      "Moonshot AI China-region endpoint (moonshot-cn@) — a separate product from the builtin Kimi provider reached by moonshot@/kimi@",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    // Contributed by @cerebrixos in PR #136, which proposed this vendor as a
    // full builtin (definition + profile + transport). It ships here as one
    // data row instead: same reachability for the user, none of the two-table
    // coupling. `TUNING_ENGINES_BASE_URL` is that PR's variable, kept because
    // this is a self-hostable enterprise gateway — the public hostname is not
    // where a deployed instance lives, and without the override those users
    // cannot use the bundled row at all.
    name: "tuningengines",
    displayName: "Tuning Engines",
    baseUrl: "https://api.tuningengines.com",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "TUNING_ENGINES_API_KEY",
    baseUrlEnvVars: ["TUNING_ENGINES_BASE_URL"],
    description:
      "Tuning Engines enterprise LLM gateway (tuningengines@); self-hosted instances point TUNING_ENGINES_BASE_URL at their own host",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-08-14" },
  },
  {
    name: "cheaperinference",
    displayName: "Cheaper Inference",
    baseUrl: "https://api.cheaperinference.com",
    apiPath: "/v1/chat/completions",
    format: "openai",
    apiKeyEnvVar: "CHEAPER_INFERENCE_API_KEY",
    apiKeyUrl: "https://cheaperinference.com/signup",
    description: "Cheaper Inference OpenAI-compatible LLM gateway (cheaperinference@)",
    evidence: { tier: "probe", verdict: "auth-realm", status: 401, measuredAt: "2026-10-22" },
  },
];
