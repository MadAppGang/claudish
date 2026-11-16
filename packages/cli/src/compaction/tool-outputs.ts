/**
 * Tool-output compression, cache-stable.
 *
 * The prompt cache and the thinking signatures both bind to the exact history
 * the model already saw. So a tool_result may change only BEFORE the model sees
 * it the first time, and must then look the same on every later request:
 *
 * 1. Decide once. A tool_result's form is decided on its first sighting, in the
 *    request's last message, keyed by `toolOutputKey(session, tool_use_id, text)`.
 * 2. Never compress what the model saw. An eligible tool_result found anywhere
 *    else with no record is recorded `original`.
 * 3. Replay, never regenerate. Every later request sends the recorded form,
 *    from the persisted store.
 * 4. A failure is final. A timeout, a refusal, any error status, an empty or
 *    incomplete answer, or a result above `maxRatio` records `original`, never
 *    retried.
 * 5. Content, not formatting. The replacement is set on the parsed body; the
 *    forward re-serialises it, and identical content serialises identically.
 *
 * Candidates are tool_result blocks of the last message whose content is a
 * string or text blocks only, with no `is_error`, at least `minTokens`
 * (characters / 4), not a result of the advisor tool or of a tool named in
 * `skipTools` (default `Read`: an Edit needs the file's exact text), and not a read of this
 * session's own recovery files (a tool_use input `file_path` inside the
 * session's folder): compressing that read again would hand the model one more
 * footer and never the full original. A Bash command that only prints files
 * (`isFilePrintCommand`) is skipped for the same reason as Read.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ADVISOR_TOOL_NAME } from "../handlers/advisor-decorator.js";
import { log } from "../logger.js";
import { DEFAULT_COMPACTION_SETTINGS, type ToolOutputSettings } from "./config.js";
import { isFilePrintCommand } from "./file-print.js";
import type { CompactionCallResult, CompactionClient } from "./haiku-client.js";
import { type CompactionStore, type ToolOutputRecord, toolOutputKey } from "./store.js";

/** The tool input sent to the model is cut to this many characters. */
export const TOOL_INPUT_MAX_CHARS = 2000;

/** `max_tokens` of one tool-output compression. */
export const TOOL_OUTPUT_MAX_TOKENS = 4096;

/** claudish's own system prompt for a tool-output compression. */
export const TOOL_OUTPUT_SYSTEM_PROMPT = [
  "You compress the output of one tool call made by a coding agent.",
  "The agent reads your text instead of the full output, so keep everything it may need to act on.",
  "Keep verbatim: every error and warning line, file path, line number, identifier, command, URL, number, version and exit status.",
  "Drop repeated lines (say how many were dropped), boilerplate, progress output, and lines that only report success.",
  "Write only the compressed output: no preamble, no commentary, no advice.",
].join("\n");

/**
 * The fixed last line of a compressed output. `N` and `M` are character counts
 * of the original and of the compressed text; `path` is the recovery file.
 */
export function compressionFooter(
  originalChars: number,
  compressedChars: number,
  path: string
): string {
  return `[claudish compressed this output from ${originalChars} to ${compressedChars} characters. Full output: ${path}. Read it if you need anything that is not here.]`;
}

/** The replacement text: the compressed text, a blank line, the footer. */
export function compressedReplacement(
  compressed: string,
  originalChars: number,
  path: string
): string {
  return `${compressed}\n\n${compressionFooter(originalChars, compressed.length, path)}`;
}

/** Estimated tokens of a text: characters / 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type Block = Record<string, unknown>;

/**
 * The text of a tool_result's content when it is a string, or a non-empty
 * array of text blocks only (joined with newlines). Anything else (an image, a
 * document, an empty array) is undefined.
 */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return undefined;
    const b = part as Block;
    if (b.type !== "text" || typeof b.text !== "string") return undefined;
    parts.push(b.text);
  }
  return parts.join("\n");
}

/** What one request's pass did. */
export interface ToolOutputPassSummary {
  /** Tool_results replaced with a compressed form (fresh and replayed). */
  replaced: number;
  /** Fresh compressions this request ran that ended `compressed`. */
  compressed: number;
  /** Fresh decisions this request recorded as `original`. */
  keptOriginal: number;
}

interface Located {
  block: Block;
  toolUseId: string;
  text: string;
  key: string;
}

export interface ToolOutputCompactorDeps {
  store: CompactionStore;
  client: CompactionClient;
  /** An absent `skipTools` takes the default list. */
  settings: Omit<ToolOutputSettings, "skipTools"> & Partial<Pick<ToolOutputSettings, "skipTools">>;
}

export class ToolOutputCompactor {
  /** Decisions in progress, by session and key, so concurrent requests share one call. */
  private readonly inFlight = new Map<string, Promise<ToolOutputRecord>>();

  constructor(private readonly deps: ToolOutputCompactorDeps) {}

  /**
   * Decide every new candidate of the last message, record every eligible
   * block seen elsewhere, then apply all recorded forms to `payload` in place.
   * Never rejects.
   */
  async compact(payload: unknown, sessionId: string): Promise<ToolOutputPassSummary> {
    const summary: ToolOutputPassSummary = { replaced: 0, compressed: 0, keptOriginal: 0 };
    const messages = messagesOf(payload);
    if (!messages) return summary;
    const { minTokens } = this.deps.settings;
    const tools = toolUsesOf(messages);
    const lastIndex = messages.length - 1;
    const folders = this.sessionFolders(sessionId);
    const skipTools = new Set(
      this.deps.settings.skipTools ?? DEFAULT_COMPACTION_SETTINGS.toolOutputs.skipTools
    );

    const fresh: Array<Promise<ToolOutputRecord>> = [];
    const freshKeys = new Set<string>();
    for (const [index, message] of messages.entries()) {
      const isLast = index === lastIndex;
      const scan = { sessionId, tools, minTokens, folders, skipTools, isLast };
      for (const located of this.eligibleBlocks(message, scan)) {
        if (this.deps.store.get(sessionId, located.key)) continue;
        if (index === lastIndex && message.role === "user") {
          if (freshKeys.has(located.key)) continue;
          freshKeys.add(located.key);
          fresh.push(this.decide(sessionId, located, tools.get(located.toolUseId)));
        } else {
          this.record(sessionId, located.key, {
            kind: "tool-output",
            form: "original",
            reason: "first seen outside the last message",
            decidedAt: new Date().toISOString(),
          });
        }
      }
    }

    for (const record of await Promise.all(fresh)) {
      if (record.form === "compressed") summary.compressed += 1;
      else summary.keptOriginal += 1;
    }
    summary.replaced = this.replay(payload, sessionId);
    return summary;
  }

  /**
   * Apply recorded `compressed` forms to `payload` in place, deciding nothing.
   * Returns the number of tool_results replaced. For `count_tokens`.
   */
  replay(payload: unknown, sessionId: string): number {
    const messages = messagesOf(payload);
    if (!messages) return 0;
    let replaced = 0;
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const raw of message.content) {
        const block = raw as Block;
        if (!block || block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
          continue;
        }
        const text = toolResultText(block.content);
        if (text === undefined) continue;
        const key = toolOutputKey(sessionId, block.tool_use_id, text);
        const record = this.deps.store.get(sessionId, key);
        if (record?.kind !== "tool-output") continue;
        const sent = record.form === "compressed" ? record.text : text;
        log(
          `[compaction] session ${sessionId}: tool_result ${block.tool_use_id} key=${key.slice(0, 12)} sent=${record.form} sha256=${createHash("sha256").update(sent).digest("hex").slice(0, 16)} chars=${sent.length}`
        );
        if (record.form !== "compressed") continue;
        replaceContent(block, record.text);
        replaced += 1;
      }
    }
    return replaced;
  }

  /**
   * The session's folder as built, plus its real path when it exists and
   * differs (the store root may sit behind a symlink). Empty for an id the
   * store refuses.
   */
  private sessionFolders(sessionId: string): string[] {
    let dir: string;
    try {
      dir = resolve(this.deps.store.sessionDir(sessionId));
    } catch {
      return [];
    }
    const folders = [dir];
    try {
      const real = realpathSync(dir);
      if (real !== dir) folders.push(real);
    } catch {
      // Not created yet: no recovery file can be read from it.
    }
    return folders;
  }

  /** Tool_result blocks of one message that meet every candidate condition. */
  private *eligibleBlocks(message: Block, scan: BlockScan): Generator<Located> {
    if (!Array.isArray(message.content)) return;
    for (const raw of message.content) {
      const block = raw as Block;
      if (!block || block.type !== "tool_result") continue;
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId !== "string" || toolUseId.length === 0) continue;
      const text = candidateText(block, toolUseId, scan);
      if (text === undefined) continue;
      yield { block, toolUseId, text, key: toolOutputKey(scan.sessionId, toolUseId, text) };
    }
  }

  /** One decision per key, shared by every request that reaches it while it runs. */
  private decide(
    sessionId: string,
    located: Located,
    tool: ToolUse | undefined
  ): Promise<ToolOutputRecord> {
    const flightKey = `${sessionId}\n${located.key}`;
    const running = this.inFlight.get(flightKey);
    if (running) return running;
    const promise = this.runDecision(sessionId, located, tool).finally(() => {
      this.inFlight.delete(flightKey);
    });
    this.inFlight.set(flightKey, promise);
    return promise;
  }

  private async runDecision(
    sessionId: string,
    located: Located,
    tool: ToolUse | undefined
  ): Promise<ToolOutputRecord> {
    const original = (reason: string): ToolOutputRecord =>
      this.record(sessionId, located.key, {
        kind: "tool-output",
        form: "original",
        reason,
        decidedAt: new Date().toISOString(),
      });

    if (this.deps.client.disabled) return original("compaction is off for this launch");

    let result: CompactionCallResult;
    try {
      result = await this.deps.client.complete({
        system: TOOL_OUTPUT_SYSTEM_PROMPT,
        user: compressionRequestText(tool, located.text),
        maxTokens: TOOL_OUTPUT_MAX_TOKENS,
        timeoutMs: this.deps.settings.timeoutMs,
        purpose: `tool output ${located.toolUseId} (${tool?.name ?? "unknown tool"}, ${located.text.length} chars)`,
      });
    } catch (err) {
      return original(`compression threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!result.ok && result.cancelled) {
      // Shutdown, not a decision: sent as it is, and nothing is recorded.
      return {
        kind: "tool-output",
        form: "original",
        reason: result.reason,
        decidedAt: new Date().toISOString(),
      };
    }
    if (!result.ok) return original(result.reason);

    let path: string;
    try {
      path = this.deps.store.writeRecovery(sessionId, located.key, located.text);
    } catch (err) {
      return original(
        `the recovery file could not be written: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const text = compressedReplacement(result.text, located.text.length, path);
    if (text.length > this.deps.settings.maxRatio * located.text.length) {
      return original(
        `the result is ${text.length} of ${located.text.length} characters, above maxRatio ${this.deps.settings.maxRatio}`
      );
    }
    const record: ToolOutputRecord = {
      kind: "tool-output",
      form: "compressed",
      text,
      originalChars: located.text.length,
      compressedChars: result.text.length,
      decidedAt: new Date().toISOString(),
    };
    try {
      const stored = this.deps.store.put(sessionId, located.key, record);
      log(
        `[compaction] tool output ${located.toolUseId}: ${located.text.length} -> ${result.text.length} characters`
      );
      return stored as ToolOutputRecord;
    } catch (err) {
      // A compressed form that is not on disk could not be replayed after a
      // restart, so it is never sent.
      return original(
        `the record could not be written: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Persist a decision; when the disk refuses, hold it in memory. Never throws. */
  private record(sessionId: string, key: string, record: ToolOutputRecord): ToolOutputRecord {
    try {
      return this.deps.store.put(sessionId, key, record) as ToolOutputRecord;
    } catch (err) {
      log(
        `[compaction] could not write a record (${err instanceof Error ? err.message : String(err)}); held in memory`
      );
      return this.deps.store.remember(sessionId, key, record) as ToolOutputRecord;
    }
  }
}

/** The user message of one compression: tool name, truncated input, output. */
export function compressionRequestText(tool: ToolUse | undefined, output: string): string {
  let input = "";
  try {
    input = JSON.stringify(tool?.input ?? {}) ?? "";
  } catch {
    input = "";
  }
  if (input.length > TOOL_INPUT_MAX_CHARS) input = `${input.slice(0, TOOL_INPUT_MAX_CHARS)}…`;
  return [
    `Tool: ${tool?.name ?? "unknown"}`,
    `Tool input (JSON, at most ${TOOL_INPUT_MAX_CHARS} characters):`,
    input,
    "",
    `Tool output (${output.length} characters):`,
    "<tool_output>",
    output,
    "</tool_output>",
  ].join("\n");
}

interface ToolUse {
  name: string;
  input: unknown;
}

interface BlockScan {
  sessionId: string;
  tools: Map<string, ToolUse>;
  minTokens: number;
  /** `sessionFolders` of the session. */
  folders: string[];
  /** Tool names whose results are never compressed (`toolOutputs.skipTools`). */
  skipTools: ReadonlySet<string>;
  /** Whether the message is the request's last one. */
  isLast: boolean;
}

/**
 * The resolved path when the tool_use's input `file_path` lies inside one of
 * `folders`, else undefined. Decided by the input path, whatever the tool.
 */
function recoveryFileRead(tool: ToolUse | undefined, folders: string[]): string | undefined {
  const filePath = (tool?.input as { file_path?: unknown } | null | undefined)?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return undefined;
  const target = resolve(filePath);
  for (const folder of folders) {
    const rel = relative(folder, target);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (rel.length > 0 && !outside) return target;
  }
  return undefined;
}

/** Whether the tool_use's result is never compressed, whatever its size. */
function isExcludedTool(tool: ToolUse | undefined, scan: BlockScan): boolean {
  if (tool?.name === ADVISOR_TOOL_NAME) return true;
  // Before the name list, so a recovery read is logged also when its tool is listed.
  if (isRecoveryRead(tool, scan)) return true;
  return tool !== undefined && scan.skipTools.has(tool.name);
}

/**
 * Whether the tool_use reads one of the session's recovery files. A fresh
 * sighting (the block is in the last message) is logged.
 */
function isRecoveryRead(tool: ToolUse | undefined, scan: BlockScan): boolean {
  const recoveryFile = recoveryFileRead(tool, scan.folders);
  if (recoveryFile === undefined) return false;
  if (scan.isLast) {
    log(`[compaction] session ${scan.sessionId}: recovery read ${recoveryKeyOf(recoveryFile)}`);
  }
  return true;
}

/**
 * The text of a tool_result block that may be compressed, else undefined: not
 * an error, not an excluded tool, at least `minTokens`, and not a file print.
 */
function candidateText(block: Block, toolUseId: string, scan: BlockScan): string | undefined {
  if (block.is_error === true) return undefined;
  const tool = scan.tools.get(toolUseId);
  if (isExcludedTool(tool, scan)) return undefined;
  const text = toolResultText(block.content);
  if (text === undefined || estimateTokens(text) < scan.minTokens) return undefined;
  if (isFilePrint(tool, toolUseId, scan)) return undefined;
  return text;
}

/**
 * Whether the tool_use is a Bash command that only prints files
 * (`isFilePrintCommand`). A fresh sighting is logged.
 */
function isFilePrint(tool: ToolUse | undefined, toolUseId: string, scan: BlockScan): boolean {
  if (tool?.name !== "Bash") return false;
  const command = (tool.input as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string" || !isFilePrintCommand(command)) return false;
  if (scan.isLast) {
    log(`[compaction] session ${scan.sessionId}: file print ${toolUseId} not compressed`);
  }
  return true;
}

/** A recovery file's record key (its name without `.txt`), else its basename. */
function recoveryKeyOf(path: string): string {
  const name = basename(path);
  const match = /^([0-9a-f]{64})\.txt$/.exec(name);
  return match ? match[1]! : name;
}

function messagesOf(payload: unknown): Block[] | undefined {
  const messages = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return messages.filter((m): m is Block => !!m && typeof m === "object");
}

/** Every tool_use block of the conversation, by id. */
function toolUsesOf(messages: Block[]): Map<string, ToolUse> {
  const tools = new Map<string, ToolUse>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const raw of message.content) {
      const block = raw as Block;
      if (!block || block.type !== "tool_use" || typeof block.id !== "string") continue;
      tools.set(block.id, {
        name: typeof block.name === "string" ? block.name : "unknown",
        input: block.input,
      });
    }
  }
  return tools;
}

/**
 * Replace a tool_result's content with `text`, keeping its shape: a string
 * stays a string, a text-block array becomes one text block that keeps the
 * last block's `cache_control`.
 */
function replaceContent(block: Block, text: string): void {
  if (typeof block.content === "string") {
    block.content = text;
    return;
  }
  const parts = block.content as Block[];
  const cacheControl = parts[parts.length - 1]?.cache_control;
  block.content = [
    { type: "text", text, ...(cacheControl !== undefined ? { cache_control: cacheControl } : {}) },
  ];
}
