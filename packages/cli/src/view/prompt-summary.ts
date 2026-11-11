import { redactSecrets } from "../redact.js";

export const PROMPT_SUMMARY_MAX_CHARS = 100;

/** The first non-blank line of a prompt, credentials masked, at most 100 characters. */
export function promptSummaryOf(prompt: string): string | null {
  const first = prompt.split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return null;
  return redactSecrets(first.trim()).slice(0, PROMPT_SUMMARY_MAX_CHARS);
}
