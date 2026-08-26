/**
 * Transcript line → HarnessEvent translation.
 *
 * Pure and total: never throws. Lines that aren't recognizable harness
 * events return null; recognizable-but-unmapped attachment types return
 * `{ kind: "unknown" }` so future event types flow through the bus without
 * a translator change.
 */

import type { EffortScope, HarnessEvent } from "./types.js";

/**
 * Matches the `/effort` local-command stdout Claude Code echoes into the
 * transcript, e.g. "Set effort level to ultracode (this session only): …"
 * or "Set effort level to high (saved as your default for new sessions): …".
 */
const EFFORT_STDOUT_RE = /Set effort level to (\S+) \((this session only|saved as your default)/;

/** Translate one raw transcript line into a HarnessEvent, or null if not one. */
export function translateLine(line: string): HarnessEvent | null {
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (record === null || typeof record !== "object") return null;
  const at = typeof record.timestamp === "string" ? record.timestamp : undefined;

  if (record.type === "attachment") {
    const attachmentType = record.attachment?.type;
    if (attachmentType === "ultra_effort_enter") return { kind: "ultra_effort_enter", at };
    if (attachmentType === "ultra_effort_exit") return { kind: "ultra_effort_exit", at };
    return {
      kind: "unknown",
      attachmentType: typeof attachmentType === "string" ? attachmentType : undefined,
      at,
    };
  }

  if (record.type === "user") {
    const content = record.message?.content;
    if (typeof content === "string" && content.includes("<local-command-stdout>")) {
      const match = content.match(EFFORT_STDOUT_RE);
      if (match) {
        const scope: EffortScope = match[2] === "this session only" ? "session" : "default";
        return { kind: "effort_changed", level: match[1], scope, at };
      }
    }
  }

  return null;
}
