/**
 * Output tokens of a Gemini `usageMetadata` record.
 *
 * Reasoning is billed as output, but the record reports it apart from the
 * answer: `candidatesTokenCount` is the answer, `thoughtsTokenCount` the
 * reasoning, and `totalTokenCount` their sum with the prompt (recorded on
 * Antigravity: 11145 + 37 + 27 = 11209). A backend whose answer count already
 * holds the reasoning shows a total with no room for it, and then nothing is
 * added, so the reasoning is never counted twice.
 */
export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export function geminiOutputTokens(usage: GeminiUsage | null | undefined): number {
  const answer = usage?.candidatesTokenCount || 0;
  const thoughts = usage?.thoughtsTokenCount || 0;
  if (thoughts === 0) return answer;
  const total = usage?.totalTokenCount;
  if (typeof total !== "number") return answer + thoughts;
  const prompt = usage?.promptTokenCount || 0;
  return prompt + answer + thoughts <= total ? answer + thoughts : answer;
}
