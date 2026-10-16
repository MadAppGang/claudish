/**
 * Provider hint information for credential-missing error messages.
 *
 * Sibling of `routing-rules.ts` — extracted from `auto-route.ts` so the
 * routing engine can build no-route hints without depending on the legacy
 * file. Kept tiny and pure.
 *
 * Migration plan §B.4 — Commit 4 of the model-catalog and routing redesign.
 */

interface ProviderHintInfo {
  /** Subcommand args to trigger OAuth login, if available (e.g. "login kimi"). */
  loginFlag?: string;
  /** Primary API key environment variable name. */
  apiKeyEnvVar?: string;
  /**
   * A free-text remediation line, for providers whose credential comes from
   * somewhere claudish does not own. `loginFlag` renders as "Run: claudish …",
   * which would be an actionably WRONG instruction when the login lives in a
   * different CLI entirely — the user would type a command that does not exist.
   */
  note?: string;
}

const PROVIDER_HINT_MAP: Record<string, ProviderHintInfo> = {
  "kimi-coding": { loginFlag: "login kimi", apiKeyEnvVar: "KIMI_CODING_API_KEY" },
  kimi: { loginFlag: "login kimi", apiKeyEnvVar: "MOONSHOT_API_KEY" },
  google: { loginFlag: "login gemini", apiKeyEnvVar: "GEMINI_API_KEY" },
  // Antigravity auth is OAuth-only (shared keychain token) — no API key env var.
  antigravity: { loginFlag: "login antigravity" },
  // There is no `claudish login devin`: the token is minted by the Devin CLI's
  // own login and read verbatim from its credentials file.
  devin: {
    note: "Sign in with the Devin CLI (`devin login`) — claudish reads ~/.local/share/devin/credentials.toml",
    apiKeyEnvVar: "WINDSURF_API_KEY",
  },
  openai: { apiKeyEnvVar: "OPENAI_API_KEY" },
  "openai-codex": { loginFlag: "login codex", apiKeyEnvVar: "OPENAI_CODEX_API_KEY" },
  minimax: { apiKeyEnvVar: "MINIMAX_API_KEY" },
  "minimax-coding": { apiKeyEnvVar: "MINIMAX_CODING_API_KEY" },
  glm: { apiKeyEnvVar: "ZHIPU_API_KEY" },
  "glm-coding": { apiKeyEnvVar: "GLM_CODING_API_KEY" },
  deepseek: { apiKeyEnvVar: "DEEPSEEK_API_KEY" },
  meta: { apiKeyEnvVar: "META_API_KEY" },
  mistralai: { apiKeyEnvVar: "MISTRAL_API_KEY" },
  sakana: { apiKeyEnvVar: "SAKANA_API_KEY" },
  "sakana-subscription": { apiKeyEnvVar: "SAKANA_SUBSCRIPTION_API_KEY" },
  // One row per Alibaba silo. Each product has exactly one variable, and the
  // name says which product it opens — a hint that names a vendor rather than a
  // product is how a subscription key ends up filed against a metered silo.
  "qwen-token-plan": { apiKeyEnvVar: "QWEN_TOKEN_PLAN_API_KEY" },
  "qwen-coding": { apiKeyEnvVar: "QWEN_CODING_PLAN_API_KEY" },
  "qwen-payg": { apiKeyEnvVar: "DASHSCOPE_API_KEY" },
  ollamacloud: { apiKeyEnvVar: "OLLAMA_API_KEY" },
  "native-anthropic": { apiKeyEnvVar: "ANTHROPIC_API_KEY" },
  openrouter: { apiKeyEnvVar: "OPENROUTER_API_KEY" },
  "x-ai": { apiKeyEnvVar: "XAI_API_KEY" },
  "z-ai": { apiKeyEnvVar: "ZAI_API_KEY" },
  "opencode-zen": { apiKeyEnvVar: "OPENCODE_API_KEY" },
  // Added 2026-09-02 with the removal of `opencode-zen-go`'s OPENCODE_API_KEY
  // alias. `opencode-zen-go` is a subscription: for every model the cloud models
  // catalog maps an OpenCode Go connection for, it is gathered in the
  // subscription tier, ahead of native APIs and gateways. It had no entry here
  // at all, so a bare `deepseek-v4-pro` with no credentials listed
  // DEEPSEEK_API_KEY and OpenRouter and never mentioned the plan ahead of both.
  // Before the removal a Zen key papered over that; now the omission is what a
  // `zgo@` user would actually hit, and the remedy has to be nameable.
  "opencode-zen-go": { apiKeyEnvVar: "OPENCODE_GO_API_KEY" },
};

/**
 * Build a multi-line hint listing the credentials the user could set to make
 * a chain succeed.
 *
 * @param modelName    Bare model name the user asked for.
 * @param providers    Canonical provider names that would have been tried but
 *                     lacked credentials. Order is preserved in the output.
 * @param options.suggestOpenRouter  `false` drops the `or@<model>` line. For a
 *                     caller that knows the catalog denies OpenRouter the model,
 *                     where that line would send the user to a hop nobody
 *                     published. Defaults to `true`.
 * @returns Hint string, or null if no provider in the chain has a known hint.
 */
export function buildCredentialHint(
  modelName: string,
  providers: string[],
  options: { suggestOpenRouter?: boolean } = {}
): string | null {
  const seen = new Set<string>();
  const lines: string[] = [`No credentials found for "${modelName}". Options:`];
  let hasOption = false;

  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);

    const hint = PROVIDER_HINT_MAP[provider];
    if (!hint) continue;

    if (hint.loginFlag) {
      lines.push(`  Run:  claudish ${hint.loginFlag}  (authenticate via OAuth)`);
      hasOption = true;
    }
    if (hint.note) {
      lines.push(`  ${hint.note}`);
      hasOption = true;
    }
    if (hint.apiKeyEnvVar) {
      lines.push(`  Set:  export ${hint.apiKeyEnvVar}=your-key  (for ${provider})`);
      hasOption = true;
    }
  }

  // Suggest OpenRouter as the catch-all unless OpenRouter itself was already in
  // the failed chain (which means OPENROUTER_API_KEY is missing), or the caller
  // knows the catalog denies OpenRouter this model.
  if (!seen.has("openrouter") && options.suggestOpenRouter !== false) {
    lines.push(`  Use:  claudish --model or@${modelName}  (route via OpenRouter)`);
    hasOption = true;
  }

  if (!hasOption) return null;
  return lines.join("\n");
}

/**
 * Get the env var name a provider uses for credentials. Used by callers that
 * want to surface a single env var hint (rather than a full multi-line message).
 */
export function getProviderApiKeyEnv(provider: string): string | undefined {
  return PROVIDER_HINT_MAP[provider]?.apiKeyEnvVar;
}
