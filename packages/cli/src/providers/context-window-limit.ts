/**
 * The largest context window a launch may use, for providers whose size claudish
 * sets: local models today. `--context-window` and the picker's size dialog both
 * end up in `CLAUDISH_CONTEXT_WINDOW`, so the launch, the load and the status line
 * read one value.
 */

/** The size asked for when nothing else names one. */
export const DEFAULT_LOCAL_CONTEXT_WINDOW = 128_000;

const UNIT_TOKENS: Record<string, number> = { "": 1, k: 1_000, m: 1_000_000 };

/** Reads `128000`, `128k` or `1m`. Answers undefined for anything else. */
export function parseContextWindow(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(text.trim());
  if (!match) return undefined;
  const size = Math.round(Number(match[1]) * (UNIT_TOKENS[match[2].toLowerCase()] ?? 1));
  return size > 0 ? size : undefined;
}

export function contextWindowLimit(): number | undefined {
  return parseContextWindow(process.env.CLAUDISH_CONTEXT_WINDOW ?? "");
}
