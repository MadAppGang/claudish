/** Test-only reflow matching the captured 80- and 120-column Claude Code boxes. */
export function wrapPrompt(text: string, cols: number, history = false): string[] {
  // The history copy is markdown-rendered; the input box contains the raw characters.
  const content = history ? text.replace(/[`*~]/g, "") : text;
  const width = Math.max(1, cols - 2);
  const rows: string[] = [];
  for (const line of content.split("\n")) {
    let remaining = Array.from(line);
    do {
      let cells = 0;
      let end = 0;
      while (end < remaining.length) {
        const next = Bun.stringWidth(remaining[end] as string);
        if (cells + next > width) break;
        cells += next;
        end++;
      }
      if (end === 0 && remaining.length) end = 1;
      if (end < remaining.length) {
        // A space consumed at a word boundary is not drawn on either row.
        let space = end;
        while (space > 0 && !/\s/.test(remaining[space] ?? "")) space--;
        if (space > 0) end = space;
      }
      rows.push(remaining.slice(0, end).join(""));
      const wrapped = end < remaining.length;
      remaining = remaining.slice(end);
      if (wrapped && remaining[0] === " ") remaining.shift();
    } while (remaining.length);
  }
  return rows.map((row, i) => `${i === 0 ? (history ? "❯ " : "❯ ") : "  "}${row}`);
}
