/**
 * Provider definitions for the claudish config TUI.
 * Shared between the TUI panels and config-command.ts.
 */

export interface ProviderDef {
  name: string;
  displayName: string;
  apiKeyEnvVar: string;
  description: string;
  keyUrl: string;
  endpointEnvVar?: string;
  defaultEndpoint?: string;
  aliases?: string[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    name: "openrouter",
    displayName: "OpenRouter",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    description: "580+ models, default backend",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    name: "gemini",
    displayName: "Google Gemini",
    apiKeyEnvVar: "GEMINI_API_KEY",
    description: "Direct Gemini API (g@, google@)",
    keyUrl: "https://aistudio.google.com/app/apikey",
    endpointEnvVar: "GEMINI_BASE_URL",
    defaultEndpoint: "https://generativelanguage.googleapis.com",
  },
  {
    name: "openai",
    displayName: "OpenAI",
    apiKeyEnvVar: "OPENAI_API_KEY",
    description: "Direct OpenAI API (oai@)",
    keyUrl: "https://platform.openai.com/api-keys",
    endpointEnvVar: "OPENAI_BASE_URL",
    defaultEndpoint: "https://api.openai.com",
  },
  {
    name: "minimax",
    displayName: "MiniMax",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    description: "MiniMax API (mm@, mmax@)",
    keyUrl: "https://www.minimaxi.com/",
    endpointEnvVar: "MINIMAX_BASE_URL",
    defaultEndpoint: "https://api.minimax.io",
  },
  {
    name: "kimi",
    displayName: "Kimi / Moonshot",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    description: "Kimi API (kimi@, moon@)",
    keyUrl: "https://platform.moonshot.cn/",
    aliases: ["KIMI_API_KEY"],
    endpointEnvVar: "MOONSHOT_BASE_URL",
    defaultEndpoint: "https://api.moonshot.ai",
  },
  {
    name: "glm",
    displayName: "GLM / Zhipu",
    apiKeyEnvVar: "ZHIPU_API_KEY",
    description: "GLM API (glm@, zhipu@)",
    keyUrl: "https://open.bigmodel.cn/",
    aliases: ["GLM_API_KEY"],
    endpointEnvVar: "ZHIPU_BASE_URL",
    defaultEndpoint: "https://open.bigmodel.cn",
  },
  {
    name: "zai",
    displayName: "Z.AI",
    apiKeyEnvVar: "ZAI_API_KEY",
    description: "Z.AI API (zai@)",
    keyUrl: "https://z.ai/",
    endpointEnvVar: "ZAI_BASE_URL",
    defaultEndpoint: "https://api.z.ai",
  },
  {
    name: "ollamacloud",
    displayName: "OllamaCloud",
    apiKeyEnvVar: "OLLAMA_API_KEY",
    description: "Cloud Ollama (oc@, llama@)",
    keyUrl: "https://ollama.com/account",
    endpointEnvVar: "OLLAMACLOUD_BASE_URL",
    defaultEndpoint: "https://ollama.com",
  },
  {
    name: "opencode",
    displayName: "OpenCode Zen",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    description: "OpenCode Zen (zen@) — optional for free models",
    keyUrl: "https://opencode.ai/",
    endpointEnvVar: "OPENCODE_BASE_URL",
    defaultEndpoint: "https://opencode.ai/zen",
  },
  {
    name: "litellm",
    displayName: "LiteLLM",
    apiKeyEnvVar: "LITELLM_API_KEY",
    description: "LiteLLM proxy (ll@, litellm@)",
    keyUrl: "https://docs.litellm.ai/",
    endpointEnvVar: "LITELLM_BASE_URL",
  },
  {
    name: "vertex",
    displayName: "Vertex AI",
    apiKeyEnvVar: "VERTEX_API_KEY",
    description: "Vertex AI Express (v@, vertex@)",
    keyUrl: "https://console.cloud.google.com/vertex-ai",
  },
  {
    name: "poe",
    displayName: "Poe",
    apiKeyEnvVar: "POE_API_KEY",
    description: "Poe API (poe@)",
    keyUrl: "https://poe.com/",
  },
];

/**
 * Fixed 8-character visually dense key mask.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "────────";
  if (key.length < 8) return "****    ";
  return `${key.slice(0, 3)}••${key.slice(-3)}`;
}
