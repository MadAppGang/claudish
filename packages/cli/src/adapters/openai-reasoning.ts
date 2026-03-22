export type OpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

interface OpenAIReasoningProfile {
  supported: OpenAIReasoningEffort[];
  transport: "chat" | "responses";
}

const REASONING_ORDER: OpenAIReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const GPT5_REASONING_PROFILES: Record<string, OpenAIReasoningProfile> = {
  "gpt-5": { supported: ["minimal", "low", "medium", "high"], transport: "chat" },
  "gpt-5-mini": { supported: ["low", "medium", "high"], transport: "chat" },
  "gpt-5-nano": { supported: [], transport: "chat" },
  "gpt-5-pro": { supported: ["high"], transport: "responses" },
  "gpt-5-codex": { supported: ["low", "medium", "high"], transport: "responses" },
  "gpt-5.1": { supported: ["none", "low", "medium", "high"], transport: "chat" },
  "gpt-5.1-codex": { supported: ["none", "low", "medium", "high"], transport: "responses" },
  "gpt-5.1-codex-mini": {
    supported: ["none", "low", "medium", "high"],
    transport: "responses",
  },
  "gpt-5.1-codex-max": {
    supported: ["none", "low", "medium", "high", "xhigh"],
    transport: "responses",
  },
  "gpt-5.2": { supported: ["none", "low", "medium", "high", "xhigh"], transport: "chat" },
  "gpt-5.2-pro": { supported: ["medium", "high", "xhigh"], transport: "responses" },
  "gpt-5.2-codex": { supported: ["low", "medium", "high", "xhigh"], transport: "responses" },
  "gpt-5.3-codex": { supported: ["low", "medium", "high", "xhigh"], transport: "responses" },
  "gpt-5.4": { supported: ["none", "low", "medium", "high", "xhigh"], transport: "chat" },
  "gpt-5.4-pro": { supported: ["medium", "high", "xhigh"], transport: "responses" },
  "gpt-5.4-mini": { supported: ["none", "low", "medium", "high"], transport: "chat" },
  "gpt-5.4-nano": { supported: [], transport: "chat" },
};

function normalizeModelId(modelId: string): string {
  const lower = modelId.toLowerCase();
  const bare = lower.split("/").pop() || lower;

  const knownModelIds = [
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2-pro",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex",
    "gpt-5.1",
    "gpt-5-codex",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-5",
  ];

  return knownModelIds.find((id) => bare === id || bare.startsWith(`${id}-`)) || bare;
}

function getReasoningProfile(modelId: string): OpenAIReasoningProfile | null {
  return GPT5_REASONING_PROFILES[normalizeModelId(modelId)] || null;
}

function clampReasoningEffortUpward(
  desired: OpenAIReasoningEffort,
  supported: OpenAIReasoningEffort[]
): OpenAIReasoningEffort | null {
  if (supported.length === 0) return null;

  const startIndex = REASONING_ORDER.indexOf(desired);
  for (let index = startIndex; index < REASONING_ORDER.length; index++) {
    const candidate = REASONING_ORDER[index];
    if (supported.includes(candidate)) return candidate;
  }

  if (supported.includes("high")) return "high";
  return supported[supported.length - 1] || null;
}

export function mapBudgetTokensToReasoningEffort(budgetTokens: number): OpenAIReasoningEffort {
  let effort: OpenAIReasoningEffort = "medium";
  if (budgetTokens < 4000) effort = "minimal";
  else if (budgetTokens < 16000) effort = "low";
  else if (budgetTokens >= 32000) effort = "high";
  return effort;
}

export function isOpenAIChatModel(modelId: string): boolean {
  return getReasoningProfile(modelId)?.transport === "chat";
}

export function isOpenAIResponsesModel(modelId: string): boolean {
  return getReasoningProfile(modelId)?.transport === "responses";
}

export function resolveOpenAIReasoningEffort(
  modelId: string,
  claudeRequest: any
): { effort: OpenAIReasoningEffort; source: string } | null {
  const profile = getReasoningProfile(modelId);
  if (!profile || profile.supported.length === 0) return null;

  if (claudeRequest?.thinking?.type === "disabled") {
    const effort = clampReasoningEffortUpward("none", profile.supported);
    return effort ? { effort, source: 'thinking.type="disabled"' } : null;
  }

  const effortParam = claudeRequest?.output_config?.effort;
  if (effortParam === "low" || effortParam === "medium" || effortParam === "high") {
    const effort = clampReasoningEffortUpward(effortParam, profile.supported);
    return effort ? { effort, source: `output_config.effort=${effortParam}` } : null;
  }

  if (effortParam === "max") {
    const effort = clampReasoningEffortUpward("xhigh", profile.supported);
    return effort ? { effort, source: "output_config.effort=max" } : null;
  }

  const budgetTokens = claudeRequest?.thinking?.budget_tokens;
  if (typeof budgetTokens === "number") {
    const desired = mapBudgetTokensToReasoningEffort(budgetTokens);
    const effort = clampReasoningEffortUpward(desired, profile.supported);
    return effort ? { effort, source: `thinking.budget_tokens=${budgetTokens}` } : null;
  }

  if (claudeRequest?.thinking?.type === "adaptive") {
    const effort = clampReasoningEffortUpward("high", profile.supported);
    return effort ? { effort, source: 'thinking.type="adaptive"' } : null;
  }

  return null;
}
