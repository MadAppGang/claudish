/**
 * The text claudish writes into an answer when a provider reports a terminal
 * error inside an HTTP 200 stream (the Responses parser, `responses-turn.ts`).
 * It is sent as an ordinary assistant text block ending `end_turn`, because an
 * error event would make Claude Code retry a request that fails again. Claude
 * Code therefore never flags it `isApiErrorMessage`, so a session classifier
 * that reads only that flag reports the next rule instead: a billing failure
 * (`credit_balance_exhausted`) read as `prompt_not_read` (recommended-effort
 * bench, run12). One definition, so the writer and the reader cannot drift.
 */

/** The in-band text for a terminal in-stream API error. */
export function formatInBandApiError(code: string, message: string): string {
  return `\n\n[API Error: ${code} ${message}]`;
}

/**
 * The error when the WHOLE answer is one in-band marker, else null. A marker
 * inside a longer answer is the model's own text and is never read as an error.
 */
export function parseInBandApiError(answer: string): { code: string; text: string } | null {
  const m = /^\[API Error: (\S+)([\s\S]*)\]$/.exec(answer.trim());
  if (!m) return null;
  return { code: m[1], text: `${m[1]}${m[2]}` };
}
