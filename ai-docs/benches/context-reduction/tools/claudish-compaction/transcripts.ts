// Reads every Claude Code transcript of the run (main thread and subagents)
// and prints two facts about it:
//   - large_tool_outputs: tool results of at least 16,000 characters, the
//     size at which claudish compaction compresses a tool output;
//   - config_reads: tool calls whose input names the run's claudish config
//     (~/.claudish/config.json) or CLAUDISH_CONFIG. The input is matched,
//     never the result, because claudish's own source mentions both.
// Prints counts only, never text from the transcripts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LARGE = 16000;
const home = process.env.HOME ?? "";
const root = join(home, ".claude", "projects");

function files(dir: string): string[] {
  let out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (n.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce(
      (n: number, b: { type?: string; text?: unknown }) =>
        n + (b?.type === "text" && typeof b.text === "string" ? b.text.length : 0),
      0
    );
  }
  return 0;
}

const configPattern = /\.claudish\/config\.json|CLAUDISH_CONFIG/;
let transcripts = 0;
let results = 0;
let large = 0;
let largest = 0;
let configReads = 0;
for (const f of files(root)) {
  transcripts++;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let e: { message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<{ type?: string; content?: unknown; input?: unknown }>) {
      if (b?.type === "tool_result") {
        results++;
        const len = textLength(b.content);
        if (len > largest) largest = len;
        if (len >= LARGE) large++;
      } else if (b?.type === "tool_use") {
        if (configPattern.test(JSON.stringify(b.input ?? ""))) configReads++;
      }
    }
  }
}
console.log(`transcripts=${transcripts}`);
console.log(`tool_results=${results} large_tool_outputs=${large} largest_chars=${largest}`);
console.log(`config_reads=${configReads}`);
