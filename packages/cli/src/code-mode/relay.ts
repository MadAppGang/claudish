/**
 * The code-mode side of a Responses turn: what happens when the model's exec
 * call reaches claudish (architecture §5.11). The turn driver
 * (`responses-turn.ts`) reaches this only through `CodeModeTurnHooks`, so a
 * classic provider never loads it.
 *
 *   onExecCall: an ExecRecord is created (keyed `(accountKey, exec key)`, owned
 *     by this session) and the session is pinned to code mode. The script runs
 *     in a fresh QuickJS runtime:
 *       blocked on N nested calls → the runtime is kept on the suspended record,
 *         the batch is recorded, and the driver relays N tool_use blocks
 *         `toolu_cx_<hex>_<seq>` (Claude Code's own tool names);
 *       finished without blocking → its output is stored and the driver
 *         continues the turn with the exec call + output appended.
 *     An input cut by `response.incomplete` is never run: `Script failed`, so
 *     the model can retry smaller.
 *   onTurnEnd: the message's Responses items go to the turn records.
 *   onTurnAbandoned: Claude Code never saw the batch; the script is terminated.
 *
 * Script errors are data (`Script failed`, returned to the model). A store or
 * sandbox failure is the lost path, never a throw out of the handler.
 */

import { type CachedReasoningItem, rememberReasoningForCall } from "../adapters/reasoning-cache.js";
import { log } from "../logger.js";
import { EXEC_TOOL_NAME, type ExecToolMeta } from "./exec-tool.js";
import { completionKey } from "./hashes.js";
import { encodeNestedId, execKeyFor } from "./ids.js";
import {
  type ExecOutput,
  clampExecOutputTokens,
  formatExecOutput,
  parseExecPragma,
} from "./output.js";
import { type QuickJSModuleLease, loadQuickJSModule } from "./sandbox/quickjs-loader.js";
import {
  type NestedCall,
  type SandboxLimits,
  type ScriptStep,
  createScriptRuntime,
  describeStep,
} from "./sandbox/script-runtime.js";
import type { ExecRecord, ScriptStore } from "./script-store.js";
import type { CodeModeStores } from "./stores.js";
import type { ToolNameTable } from "./tool-names.js";
import { turnAnchorFor } from "./turn-records.js";
import type {
  ClaudeMessage,
  CodeModeTurnHooks,
  ExecTurnStep,
  NestedToolUse,
  ResponsesItem,
} from "./types.js";

/** The failure text of an exec whose input `response.incomplete` cut. */
export const TRUNCATED_EXEC_ERROR =
  "exec input was truncated by max_output_tokens; it was not run. Send a shorter script.";

/** The failure text when the sandbox cannot run a script at all. */
export const SANDBOX_UNAVAILABLE_ERROR =
  "claudish's script sandbox is unavailable in this process; the script was not run";

export interface CodeModeTurnContext {
  stores: CodeModeStores;
  accountKey: string;
  sessionKey: string;
  /** The shape this request was sent in, read at exec time (the lite fallback may change it). */
  shape: () => "lite" | "classic";
  /** The exec tool's identifier table (`renderExecTool`). */
  names: ToolNameTable;
  allTools: readonly ExecToolMeta[];
  /** Output budget of an exec with no pragma (discovery's truncation limit). */
  defaultMaxOutputTokens: number;
  /** The request's last message: what a text-only message answered (its anchor). */
  previousMessage: ClaudeMessage | undefined;
  /** Test seam: the sandbox module. Default `loadQuickJSModule`. */
  loadModule?: () => Promise<QuickJSModuleLease | undefined>;
  /** Test seam: sandbox limits. */
  limits?: Partial<SandboxLimits>;
}

/** The tool_use blocks for a blocked step's calls. */
export function nestedBlocksFor(
  execKey: string,
  calls: [NestedCall, ...NestedCall[]]
): [NestedToolUse, ...NestedToolUse[]] {
  const [first, ...rest] = calls.map((call) => ({
    id: encodeNestedId(execKey, call.seq),
    name: call.name,
    input: call.input,
  }));
  return [first, ...rest];
}

/** The two items that carry a finished exec back to the model. */
export function execItems(
  callId: string,
  source: string,
  output: ExecOutput,
  maxOutputTokens: number
): ResponsesItem[] {
  return [
    { type: "custom_tool_call", call_id: callId, name: EXEC_TOOL_NAME, input: source },
    {
      type: "custom_tool_call_output",
      call_id: callId,
      output: formatExecOutput(output, { maxOutputTokens }),
    },
  ];
}

/**
 * Settle a record on a `done` step: `finish` or `fail`, and store the output
 * under `key` as a `run` output.
 */
export function settleDone(
  scripts: ScriptStore,
  record: ExecRecord,
  output: ExecOutput,
  key: string,
  sessionKey: string
): void {
  scripts.storeOutput(record, key, output, "run", sessionKey);
  if (record.state === "running") {
    scripts.transition(record, output.status === "completed" ? "finish" : "fail");
  }
}

/**
 * Keep a blocked step: the runtime stays on the suspended record and the
 * batch is recorded (with its blocks, for a duplicate request's replay).
 */
export function suspendBlocked(
  scripts: ScriptStore,
  record: ExecRecord,
  blocks: NestedToolUse[]
): void {
  scripts.transition(record, "block");
  record.batches.push({ ids: blocks.map((b) => b.id), blocks });
}

function reasoningOf(items: ResponsesItem[]): ResponsesItem[] {
  return items.filter((item) => item.type === "reasoning");
}

class CodeModeTurn implements CodeModeTurnHooks {
  constructor(private readonly ctx: CodeModeTurnContext) {}

  private get scripts(): ScriptStore {
    return this.ctx.stores.scripts;
  }

  async onExecCall(call: {
    callId: string;
    input: string;
    precedingItems: ResponsesItem[];
    truncated: boolean;
  }): Promise<ExecTurnStep> {
    const { callId, input } = call;
    const pragma = parseExecPragma(input);
    const maxOutputTokens = clampExecOutputTokens(
      pragma.maxOutputTokens ?? this.ctx.defaultMaxOutputTokens
    );
    const failed = (error: string): ExecTurnStep => ({
      kind: "continue",
      appendItems: execItems(
        callId,
        input,
        { status: "failed", wallMs: 0, parts: [], error },
        maxOutputTokens
      ),
    });

    let record: ExecRecord;
    try {
      const reasoning = reasoningOf(call.precedingItems);
      record = this.scripts.create({
        accountKey: this.ctx.accountKey,
        sessionKey: this.ctx.sessionKey,
        execCallId: execKeyFor(callId),
        originalCallId: callId,
        source: input,
        shape: this.ctx.shape(),
        reasoningItems: reasoning.length > 0 ? reasoning : undefined,
        maxOutputTokens,
      });
      // This session relayed an exec: a later discovery failure cannot flip it back.
      this.scripts.pin(this.ctx.sessionKey);
    } catch (err) {
      log(`[CodeMode] exec ${callId}: the script store failed: ${err}`);
      return failed(`claudish could not keep this script's state: ${err}`);
    }

    try {
      return await this.run(record, call.truncated);
    } catch (err) {
      log(`[CodeMode] exec ${callId}: claudish failed running it: ${err}`);
      try {
        if (record.state === "running" || record.state === "suspended") {
          this.scripts.transition(record, record.state === "running" ? "fail" : "evict");
        }
      } catch {
        // The record is lost either way.
      }
      return failed("claudish's sandbox failed internally; this script's state is lost");
    }
  }

  /** Run the record's script (never when its input was truncated). */
  private async run(record: ExecRecord, truncated: boolean): Promise<ExecTurnStep> {
    const notRun = (error: string): ExecTurnStep =>
      this.finished(record, { status: "failed", wallMs: 0, parts: [], error });
    if (truncated) return notRun(TRUNCATED_EXEC_ERROR);
    const lease = await (this.ctx.loadModule ?? loadQuickJSModule)();
    if (!lease) return notRun(SANDBOX_UNAVAILABLE_ERROR);
    const runtime = createScriptRuntime({
      tools: this.ctx.names,
      allTools: this.ctx.allTools,
      limits: this.ctx.limits,
      seed: record.originalCallId,
      module: lease,
    });
    const step: ScriptStep = runtime.start(record.source);
    log(`[CodeMode] exec ${record.originalCallId}: ${describeStep(step)}`);
    if (step.kind === "done") return this.finished(record, step.output);
    this.scripts.attachRuntime(record, runtime);
    const blocks = nestedBlocksFor(record.execCallId, step.calls);
    suspendBlocked(this.scripts, record, blocks);
    // A later non-code-mode render replays the exec's reasoning once, before
    // the first nested call (the A3 `_p0` rule).
    if (record.reasoningItems) {
      rememberReasoningForCall(
        blocks[0].id,
        record.reasoningItems as unknown as CachedReasoningItem[]
      );
    }
    return { kind: "emit-tool-uses", blocks };
  }

  /** A script that finished without blocking: store its output, continue the turn. */
  private finished(record: ExecRecord, output: ExecOutput): ExecTurnStep {
    settleDone(this.scripts, record, output, completionKey([]), this.ctx.sessionKey);
    return {
      kind: "continue",
      appendItems: execItems(
        record.originalCallId,
        record.source,
        output,
        record.maxOutputTokens ?? this.ctx.defaultMaxOutputTokens
      ),
    };
  }

  onTurnEnd(turn: { anchor?: string; items: ResponsesItem[]; texts: string[] }): void {
    if (turn.items.length === 0) return;
    const anchor =
      turn.anchor ??
      turnAnchorFor(
        this.ctx.sessionKey,
        { role: "assistant", content: turn.texts.map((text) => ({ type: "text", text })) },
        this.ctx.previousMessage
      );
    this.ctx.stores.turns.put(this.ctx.sessionKey, anchor, turn.items);
  }

  onTurnAbandoned(callId: string): void {
    const record = this.scripts.peek(this.ctx.accountKey, execKeyFor(callId));
    if (record?.state === "suspended") {
      log(`[CodeMode] exec ${callId}: the client left before the batch arrived; terminated`);
      this.scripts.transition(record, "abandon");
    }
  }
}

/** The hooks for one code-mode Responses turn. */
export function createCodeModeTurnHooks(ctx: CodeModeTurnContext): CodeModeTurnHooks {
  return new CodeModeTurn(ctx);
}
