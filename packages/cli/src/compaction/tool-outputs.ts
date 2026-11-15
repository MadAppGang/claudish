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
 * (characters / 4), and not a result of the advisor tool.
 */

import { createHash } from "node:crypto";
import { ADVISOR_TOOL_NAME } from "../handlers/advisor-decorator.js";
import { log } from "../logger.js";
import type { ToolOutputSettings } from "./config.js";
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
  settings: ToolOutputSettings;
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

    const fresh: Array<Promise<ToolOutputRecord>> = [];
    const freshKeys = new Set<string>();
    for (const [index, message] of messages.entries()) {
      for (const located of this.eligibleBlocks(message, sessionId, tools, minTokens)) {
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

  /** Tool_result blocks of one message that meet every candidate condition. */
  private *eligibleBlocks(
    message: Block,
    sessionId: string,
    tools: Map<string, ToolUse>,
    minTokens: number
  ): Generator<Located> {
    if (!Array.isArray(message.content)) return;
    for (const raw of message.content) {
      const block = raw as Block;
      if (!block || block.type !== "tool_result") continue;
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId !== "string" || toolUseId.length === 0) continue;
      if (block.is_error === true) continue;
      if (tools.get(toolUseId)?.name === ADVISOR_TOOL_NAME) continue;
      const text = toolResultText(block.content);
      if (text === undefined || estimateTokens(text) < minTokens) continue;
      yield { block, toolUseId, text, key: toolOutputKey(sessionId, toolUseId, text) };
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
