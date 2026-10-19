/**
 * Claude Code tool names as JavaScript identifiers on the exec tool's `tools`
 * object.
 *
 * The official Codex client normalises a nested tool's name by replacing every
 * character outside `[A-Za-z0-9_$]` with `_` (a leading digit too), and when two
 * names collide the LATER one is skipped (R1 §1c,
 * `code-mode-protocol/src/description.rs`). claudish applies the same rule to
 * Claude Code's own tool names, so `mcp__my-server__run` is called as
 * `tools.mcp__my_server__run`, and keeps the table both ways: the identifier a
 * script calls, and the name the tool_use block must carry.
 */

import { log } from "../logger.js";

/** `name` as a JavaScript identifier: `[A-Za-z0-9_$]` kept, the rest `_`, no leading digit. */
export function normalizeToolIdent(name: string): string {
  let ident = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (ident === "") ident = "_";
  if (/^[0-9]/.test(ident)) ident = `_${ident.slice(1)}`;
  return ident;
}

/** One nested tool: the identifier a script calls and Claude Code's own name. */
export interface ToolNameEntry {
  ident: string;
  name: string;
}

/**
 * The identifier ↔ original-name table for one request's tool list, in Claude
 * Code's order. Built once per request from `claudeRequest.tools`.
 */
export class ToolNameTable {
  private readonly byIdent = new Map<string, ToolNameEntry>();
  private readonly byName = new Map<string, ToolNameEntry>();
  /** Names dropped because their identifier was already taken. */
  readonly skipped: string[] = [];

  constructor(names: readonly string[]) {
    for (const name of names) {
      if (typeof name !== "string" || name === "") continue;
      if (this.byName.has(name)) continue;
      const ident = normalizeToolIdent(name);
      const taken = this.byIdent.get(ident);
      if (taken) {
        this.skipped.push(name);
        log(
          `[CodeMode] tool ${JSON.stringify(name)} skipped: its identifier ${ident} is already ` +
            `taken by ${JSON.stringify(taken.name)}`
        );
        continue;
      }
      const entry: ToolNameEntry = { ident, name };
      this.byIdent.set(ident, entry);
      this.byName.set(name, entry);
    }
  }

  /** Every kept entry, in Claude Code's order. */
  entries(): ToolNameEntry[] {
    return [...this.byIdent.values()];
  }

  /** The identifier a script calls for Claude Code's `name`, or undefined (unknown or skipped). */
  identFor(name: string): string | undefined {
    return this.byName.get(name)?.ident;
  }

  /** Claude Code's name for the identifier `ident`, or undefined. */
  nameFor(ident: string): string | undefined {
    return this.byIdent.get(ident)?.name;
  }

  has(ident: string): boolean {
    return this.byIdent.has(ident);
  }

  get size(): number {
    return this.byIdent.size;
  }
}
