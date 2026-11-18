/** A trimmed error line: `Error:` or `Fatal error:`, optionally after claudish's own prefix. */
const ERROR_LINE = /^(\[claudish\]\s+)?(Fatal error|Error):/;

/**
 * The line(s) that say why a pane child exited, picked from the text it left behind.
 *
 * `errorSources` are searched in order for the first line matching `ERROR_LINE` once trimmed.
 * That trimmed line alone is returned, so a later `[claudish] Stack: Error: …` or `at …` frame
 * never outranks it. With none, the last `tailCount` non-empty lines of the first
 * `tailSources` entry that has any are returned, joined with ` | ` so they stay on one line.
 * An empty string means there is nothing to show.
 */
export function childExitEvidence(
  errorSources: readonly string[],
  tailSources: readonly string[],
  tailCount = 5
): string {
  for (const text of errorSources) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (ERROR_LINE.test(trimmed)) return trimmed;
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
