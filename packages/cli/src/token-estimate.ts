/**
 * The proxy's local token count of a request body: its JSON length / 4,
 * rounded up. `count_tokens` answers with it when no upstream count is
 * available, and compaction measures a request against its limit with it, so
 * both read the same number.
 */
export function localTokenEstimate(body: unknown): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    text = undefined;
  }
  return Math.ceil((text ?? "").length / 4);
}
