/**
 * Shared API key mapping — maps provider IDs to their environment variable names.
 * Used by both the CLI probe command and the probe TUI.
 */
export const API_KEY_MAP: Record<string, { envVar: string; aliases?: string[] }> = {
  litellm: { envVar: "LITELLM_API_KEY" },
  openrouter: { envVar: "OPENROUTER_API_KEY" },
  google: { envVar: "GEMINI_API_KEY" },
  openai: { envVar: "OPENAI_API_KEY" },
  minimax: { envVar: "MINIMAX_API_KEY" },
  "minimax-coding": { envVar: "MINIMAX_CODING_API_KEY" },
  kimi: { envVar: "MOONSHOT_API_KEY", aliases: ["KIMI_API_KEY"] },
  "kimi-coding": { envVar: "KIMI_CODING_API_KEY" },
  glm: { envVar: "ZHIPU_API_KEY", aliases: ["GLM_API_KEY"] },
  "glm-coding": { envVar: "GLM_CODING_API_KEY", aliases: ["ZAI_CODING_API_KEY"] },
  "z-ai": { envVar: "ZAI_API_KEY" },
  deepseek: { envVar: "DEEPSEEK_API_KEY" },
  mistralai: { envVar: "MISTRAL_API_KEY" },
  sakana: { envVar: "SAKANA_API_KEY" },
  // Subscription plan (sc@) — general-purpose, not coding-specific. Its own key,
  // named after Sakana's "subscription" term; SAKANA_CODING_API_KEY kept as a
  // back-compat alias. NO alias to the API-usage SAKANA_API_KEY — Sakana keys
  // are typed at creation ("subscription" vs "API usage"); using the PAYG key
  // bills prepaid credits despite a subscription.
  "sakana-subscription": {
    envVar: "SAKANA_SUBSCRIPTION_API_KEY",
    aliases: ["SAKANA_CODING_API_KEY"],
  },
  // No alias by design: a Qwen Plan key authenticates ONLY against the
  // plan host; the DashScope/PAYG hosts reject it (401/403), so aliasing onto
  // DASHSCOPE_API_KEY / QWEN_API_KEY could only mis-route or mis-bill.
  "qwen-cloud": { envVar: "QWEN_CLOUD_PLAN_API_KEY" },
  // The PAYG sibling is the inverse case: both of these names hold a metered
  // Model Studio key, so they are two spellings of ONE billing mode and may
  // safely alias. Neither may ever alias onto the plan key above.
  "qwen-payg": { envVar: "DASHSCOPE_API_KEY", aliases: ["QWEN_API_KEY"] },
  ollamacloud: { envVar: "OLLAMA_API_KEY" },
  "opencode-zen": { envVar: "OPENCODE_API_KEY" },
  // The Go plan has its OWN key. This entry used to name OPENCODE_API_KEY — the
  // paid Zen tier's key — which contradicted the provider definition
  // (`provider-definitions.ts`, `apiKeyEnvVar: "OPENCODE_GO_API_KEY"`) and its
  // note that a key minted for one tier is rejected by the other with a 401.
  // The practical effect was a `zgo@` request reporting "Missing API key" while
  // OPENCODE_GO_API_KEY was sitting in the environment, and — since routing
  // filters candidates by credential — `opencode-zen-go` being dropped from
  // every chain it appears in. Same shape as the sakana-subscription mismatch
  // above: two tiers, two keys, one table naming the wrong one.
  //
  // NO alias (2026-09-02). The fix above left OPENCODE_API_KEY behind as one,
  // and the definition dropped its matching `apiKeyAliases` on the day the 401
  // claim was measured false. Keeping it HERE would have been worse than never
  // fixing it: this table is what `--probe` uses to decide `hasCredentials`
  // (`cli.ts` buildDirectChainEntry / buildResultLinks), so the probe would have
  // printed a credentialed `zgo@` row for a key the credential authority now
  // refuses to sign with — a row asserting readiness nothing has verified, the
  // same defect as the removed publicKeyFallback.
  "opencode-zen-go": { envVar: "OPENCODE_GO_API_KEY" },
  vertex: { envVar: "VERTEX_API_KEY", aliases: ["VERTEX_PROJECT"] },
  poe: { envVar: "POE_API_KEY" },
};
