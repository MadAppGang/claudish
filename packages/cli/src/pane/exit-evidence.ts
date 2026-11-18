/**
 * The line(s) that say why a pane child exited, picked from the text it left behind.
 *
 * `errorSources` are searched in order for the first line that starts with `Error:` once its
 * leading whitespace is trimmed; that line alone is returned. With none, the last `tailCount`
 * non-empty lines of the first `tailSources` entry that has any are returned, joined with
 * ` | ` so they stay on one line. An empty string means there is nothing to show.
 */
export function childExitEvidence(
  errorSources: readonly string[],
  tailSources: readonly string[],
  tailCount = 5
): string {
  for (const text of errorSources) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Error:")) return trimmed;
    }
  }
  for (const text of tailSources) {
    const lines = text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim());
    if (lines.length) return lines.slice(-tailCount).join(" | ");
  }
  return "";
}
