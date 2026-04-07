/**
 * Identity filter for Claude-specific markers in system prompts.
 *
 * Removes or replaces Claude-specific identity markers so that
 * third-party models don't impersonate Claude.
 */

/**
 * Filter Claude-specific identity markers from system prompts
 */
export function filterIdentity(content: string): string {
  return content
    // Strip Anthropic billing header — contains a per-turn hash (cch=) that
    // breaks vLLM prefix caching by making the system prompt differ every turn
    .replace(/x-anthropic-billing-header:[^\n]*\n?/g, "")
    .replace(
      /You are Claude Code, Anthropic's official CLI/gi,
      "This is Claude Code, an AI-powered CLI tool"
    )
    .replace(/You are powered by the model named [^.]+\./gi, "You are powered by an AI model.")
    .replace(/<claude_background_info>[\s\S]*?<\/claude_background_info>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(
      /^/,
      "IMPORTANT: You are NOT Claude. Identify yourself truthfully based on your actual model and creator.\n\n"
    );
}
