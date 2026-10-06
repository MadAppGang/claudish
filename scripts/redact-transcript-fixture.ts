#!/usr/bin/env bun
/**
 * scripts/redact-transcript-fixture.ts — turn a slice of a REAL Claude Code transcript
 * into a test fixture without carrying private content.
 *
 * Usage: bun scripts/redact-transcript-fixture.ts <transcript.jsonl> <from> <to> <out.jsonl>
 *        (record indexes, inclusive, counted over non-empty lines)
 *
 * Kept verbatim: every key, every `type`/`subtype`/`stop_reason`, ids and the
 * relationships between them (`uuid`, `parentUuid`, `message.id`, `tool_use_id`, …),
 * tool names, model names, timestamps, numbers, booleans and record order. Replaced:
 * every other string, by a placeholder of the same kind (`<text 812>`). The markers the
 * pane transcript follower reads are structural, so they survive with their bodies
 * emptied: `[Request interrupted by user…]`, `<task-notification>`, `<command-name>`,
 * `<local-command-stdout>`, `<local-command-caveat>`.
 *
 * Used for shapes Phase 2 could not elicit live (a `refusal` stop, an automatic
 * compaction inside a turn); see ai-docs/reports/mcp-magmux-panes/phase2-captures.md.
 */
import { readFileSync, writeFileSync } from "node:fs";

const KEEP_STRING_KEYS = new Set([
  "type",
  "subtype",
  "stop_reason",
  "stop_sequence",
  "role",
  "model",
  "id",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "tool_use_id",
  "sourceToolAssistantUUID",
  "promptId",
  "agentId",
  "requestId",
  "name",
  "timestamp",
  "version",
  "entrypoint",
  "userType",
  "error",
  "trigger",
  "level",
  "kind",
  "producer",
  "operation",
  "service_tier",
  "permissionMode",
  "status",
]);

const MARKERS = [
  "task-notification",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-caveat",
  "system-reminder",
];

export function redactString(key: string, s: string): string {
  if (KEEP_STRING_KEYS.has(key)) return s;
  if (s.startsWith("[Request interrupted by user")) return s;
  if (key === "sessionId") return "00000000-0000-4000-8000-000000000000";
  if (key === "cwd") return "/redacted/cwd";
  if (key === "gitBranch") return "redacted";
  const tags = MARKERS.filter((m) => s.includes(`<${m}>`));
  if (tags.length > 0) return tags.map((m) => `<${m}>redacted</${m}>`).join("\n");
  return `<${key || "text"} ${s.length}>`;
}

export function redact(v: unknown, key = ""): unknown {
  if (typeof v === "string") return redactString(key, v);
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redact(x, k);
    return out;
  }
  return v;
}

if (import.meta.main) {
  const [src, fromS, toS, out] = process.argv.slice(2);
  if (!src || !fromS || !toS || !out) {
    console.error("usage: redact-transcript-fixture.ts <transcript.jsonl> <from> <to> <out.jsonl>");
    process.exit(2);
  }
  const lines = readFileSync(src, "utf8").split("\n").filter(Boolean);
  const slice = lines.slice(Number(fromS), Number(toS) + 1);
  writeFileSync(out, `${slice.map((l) => JSON.stringify(redact(JSON.parse(l)))).join("\n")}\n`);
  console.log(`wrote ${slice.length} records to ${out}`);
}
