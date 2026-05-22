export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

const GPT5_XHIGH_SUPPORTED_MINORS = new Set([2, 4, 5]);
const GPT5_NEWER_MINOR_XHIGH_FLOOR = 6;
const GPT5_CODEX_XHIGH_SUPPORTED_MINORS = new Set([2, 3]);
const GPT5_CODEX_NEWER_MINOR_XHIGH_FLOOR = 4;

export function getClaudeCodeEffort(claudeRequest: any): ClaudeCodeEffort | undefined {
  return normalizeClaudeCodeEffort(claudeRequest?.output_config?.effort);
}

export function getOpenAIReasoningEffortFromClaudeRequest(
  claudeRequest: any,
  modelId: string
): OpenAIReasoningEffort | undefined {
  const effort = getClaudeCodeEffort(claudeRequest);
  if (effort) return mapClaudeCodeEffortToOpenAIReasoningEffort(effort, modelId);

  const budgetTokens = claudeRequest?.thinking?.budget_tokens;
  if (budgetTokens !== undefined) {
    return mapThinkingBudgetToOpenAIReasoningEffort(budgetTokens, modelId);
  }

  return undefined;
}

export function getCodexReasoningEffortFromClaudeRequest(
  claudeRequest: any,
  modelId: string
): CodexReasoningEffort {
  const effort = getClaudeCodeEffort(claudeRequest);
  if (effort) return mapClaudeCodeEffortToCodexReasoningEffort(effort, modelId);

  const budgetTokens = claudeRequest?.thinking?.budget_tokens;
  if (budgetTokens !== undefined) {
    return mapThinkingBudgetToCodexReasoningEffort(budgetTokens, modelId);
  }

  return "medium";
}

export function isOpenAIReasoningModel(modelId: string): boolean {
  const model = stripProviderPrefix(modelId);
  if (model.includes("chat-latest")) return false;
  return (
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("gpt-5")
  );
}

function mapClaudeCodeEffortToOpenAIReasoningEffort(
  effort: ClaudeCodeEffort,
  modelId: string
): OpenAIReasoningEffort {
  if (effort === "max") {
    return supportsXHighReasoningEffort(modelId) ? "xhigh" : "high";
  }
  if (effort === "xhigh" && !supportsXHighReasoningEffort(modelId)) {
    return "high";
  }
  return effort;
}

function mapClaudeCodeEffortToCodexReasoningEffort(
  effort: ClaudeCodeEffort,
  modelId: string
): CodexReasoningEffort {
  if (effort === "max") {
    return supportsXHighReasoningEffort(modelId) ? "xhigh" : "high";
  }
  if (effort === "xhigh" && !supportsXHighReasoningEffort(modelId)) {
    return "high";
  }
  return effort;
}

function supportsXHighReasoningEffort(modelId: string): boolean {
  const model = stripProviderPrefix(modelId);
  if (model.startsWith("gpt-5.1-codex-max")) return true;

  const codexMatch = model.match(/^gpt-5\.(\d+)-codex(?:-|$)/);
  if (codexMatch) {
    const minor = Number(codexMatch[1]);
    return (
      GPT5_CODEX_XHIGH_SUPPORTED_MINORS.has(minor) ||
      minor >= GPT5_CODEX_NEWER_MINOR_XHIGH_FLOOR
    );
  }

  const gpt5Match = model.match(/^gpt-5\.(\d+)(?:-|$)/);
  if (!gpt5Match) return false;

  const minor = Number(gpt5Match[1]);
  return GPT5_XHIGH_SUPPORTED_MINORS.has(minor) || minor >= GPT5_NEWER_MINOR_XHIGH_FLOOR;
}

function supportsMinimalReasoningEffort(modelId: string | undefined): boolean {
  if (!modelId) return true;

  const model = stripProviderPrefix(modelId);
  const gpt5Match = model.match(/^gpt-5(?:\.(\d+))?(?:-|$)/);
  return !gpt5Match?.[1];
}

function normalizeClaudeCodeEffort(value: unknown): ClaudeCodeEffort | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.toLowerCase().replace(/[-_\s]/g, "");
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    return effort;
  }
  return undefined;
}

function stripProviderPrefix(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("@")) return lower.split("@").pop()!.trim();
  if (lower.includes("/")) return lower.split("/").pop()!.trim();
  return lower.trim();
}

export function mapThinkingBudgetToOpenAIReasoningEffort(
  budgetTokens: unknown,
  modelId?: string
): OpenAIReasoningEffort {
  const budget = Number(budgetTokens);
  if (!Number.isFinite(budget)) return "medium";

  if (budget < 4000) return supportsMinimalReasoningEffort(modelId) ? "minimal" : "low";
  if (budget < 16000) return "low";
  if (budget >= 32000) return "high";
  return "medium";
}

export function mapThinkingBudgetToCodexReasoningEffort(
  budgetTokens: unknown,
  modelId?: string
): CodexReasoningEffort {
  const effort = mapThinkingBudgetToOpenAIReasoningEffort(budgetTokens, modelId);
  return effort === "minimal" ? "low" : effort;
}
