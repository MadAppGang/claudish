/**
 * Replay a lost exec script from history (architecture §5.12).
 *
 * A suspended script whose runtime was evicted (the 32-runtime live cap, the
 * 6 h idle TTL, a retired or poisoned module) still has its record and its
 * SOURCE. When Claude Code's answer to its pending batch arrives, the script is
 * re-run from the start in a fresh runtime and each batch it blocks on is
 * answered from history: batch k must be exactly the k-th round the request
 * carries — the same nested ids, and for each the same tool name and the same
 * canonical input. Only then are that round's tool_results fed in. A script is
 * deterministic enough for this: `Math.random` is seeded by its exec call id;
 * `Date` is not, and a script that branches on it mismatches. Any mismatch, or
 * no loaded sandbox module (this step is synchronous and never loads one),
 * leaves the record lost and the caller takes the lost path.
 *
 * The record is only ever replayed by its OWNER session (the caller checks).
 */

import { log } from "../logger.js";
import { type ClaudeToolLike, renderExecTool } from "./exec-tool.js";
import {
  type BatchResultEntry,
  batchHash,
  canonicalJson,
  completionKey,
  inputHash,
} from "./hashes.js";
import { decodeNestedId, encodeNestedId } from "./ids.js";
import type { ExecOutput } from "./output.js";
import { nestedBlocksFor, settleDone, suspendBlocked } from "./relay.js";
import { type QuickJSModuleLease, currentQuickJSModule } from "./sandbox/quickjs-loader.js";
import {
  type NestedCall,
  type NestedResult,
  type ScriptRuntime,
  type ScriptStep,
  createScriptRuntime,
} from "./sandbox/script-runtime.js";
import type { ExecBatch, ExecRecord, ExecState, ScriptStore } from "./script-store.js";
import { nestedResultFromToolResult } from "./tool-results.js";
import type { ClaudeContentBlock, NestedToolUse } from "./types.js";

/** One round of the exec in the request's history: its nested tool_use blocks, in order. */
export interface HistoryRound {
  ids: string[];
  blocks: ClaudeContentBlock[];
}

export interface ReplayInput {
  scripts: ScriptStore;
  /** A `lost` record that still has its source and the batches it relayed. */
  record: ExecRecord;
  /** The exec's rounds in this request, ending with the round this request answers. */
  rounds: HistoryRound[];
  /** tool_use id → tool_result across the request. */
  results: ReadonlyMap<string, ClaudeContentBlock>;
  /** Claude Code's tools in this request (the identifiers the script calls). */
  tools: readonly ClaudeToolLike[];
  sessionKey: string;
  /**
   * The user interrupted (Esc) beside the last round's results: the script is
   * re-run up to that round and ENDED there, never fed its results, so it can
   * emit no further tool call — as the live path terminates on the same marker.
   */
  interrupted?: boolean;
  /** Test seam; default the loaded module, if any. */
  module?: QuickJSModuleLease;
}

export type ReplayResult =
  | { kind: "reply"; blocks: [NestedToolUse, ...NestedToolUse[]] }
  | { kind: "done" }
  /**
   * Interrupted at the last round: `output` is what the script produced before
   * it (the runtime is disposed, the record still `lost`); `key` is the
   * completion key through that round. The caller adds the results and stores it.
   */
  | { kind: "interrupted"; output: ExecOutput; key: string }
  | undefined;

function entriesOf(
  ids: readonly string[],
  results: ReadonlyMap<string, ClaudeContentBlock>
): BatchResultEntry[] {
  return ids.map((id) => {
    const result = results.get(id);
    return result
      ? {
          toolUseId: id,
          result: { isError: result.is_error === true, content: result.content ?? "" },
        }
      : { toolUseId: id };
  });
}

/**
 * The batch the script blocked on is exactly this history round: the same
 * ids and names, and each input either equal to history's or the one Layer 4
 * repaired into history's (`repairs`, recorded when the batch was relayed).
 */
function matchesRound(
  execKey: string,
  calls: readonly NestedCall[],
  round: HistoryRound,
  repairs: ExecBatch["repairs"]
): boolean {
  if (calls.length !== round.blocks.length) return false;
  return calls.every((call) => {
    const id = encodeNestedId(execKey, call.seq);
    const block = round.blocks.find((b) => b.id === id);
    if (block === undefined || block.name !== call.name) return false;
    if (canonicalJson(block.input ?? {}) === canonicalJson(call.input)) return true;
    const repair = repairs?.[id];
    return (
      repair !== undefined &&
      repair.script === inputHash(call.input) &&
      repair.relayed === inputHash(block.input)
    );
  });
}

function resultsFor(
  round: HistoryRound,
  results: ReadonlyMap<string, ClaudeContentBlock>
): NestedResult[] {
  const out: NestedResult[] = [];
  for (const id of round.ids) {
    const seq = decodeNestedId(id)?.seq;
    const block = results.get(id);
    if (seq !== undefined && block) out.push(nestedResultFromToolResult(seq, block));
  }
  return out;
}

/**
 * Feed history's rounds to a freshly started script, checking each batch it
 * blocks on against the round. `stopped` is a divergence (undefined) or an
 * interrupt at the last round; otherwise the step after the last round.
 */
function runRounds(
  runtime: ScriptRuntime,
  input: ReplayInput
): { kind: "ran"; step: ScriptStep; hashes: string[] } | { kind: "stopped"; result: ReplayResult } {
  const { record, rounds, results } = input;
  let step = runtime.start(record.source);
  const hashes: string[] = [];
  for (const [k, round] of rounds.entries()) {
    const repairs = record.batches[k]?.repairs;
    if (step.kind !== "blocked" || !matchesRound(record.execCallId, step.calls, round, repairs)) {
      log(`[CodeMode] exec ${record.originalCallId}: replay diverged from history; script lost`);
      runtime.dispose();
      return { kind: "stopped", result: undefined };
    }
    hashes.push(batchHash(entriesOf(round.ids, results)));
    if (input.interrupted && k === rounds.length - 1) {
      const output = runtime.terminate("");
      log(`[CodeMode] exec ${record.originalCallId}: replayed to the interrupt; terminated`);
      return {
        kind: "stopped",
        result: { kind: "interrupted", output, key: completionKey(hashes) },
      };
    }
    step = runtime.resume(resultsFor(round, results));
  }
  return { kind: "ran", step, hashes };
}

/**
 * Re-run `record`'s script against history. A blocked step past the last
 * round is the script's next batch (reply); a finished one is stored. Undefined
 * when the script is not replayable or diverged: the record stays lost.
 */
export function replayLostScript(input: ReplayInput): ReplayResult {
  const { record, rounds, scripts } = input;
  if (record.state !== "lost" || record.batches.length === 0 || !record.source) return undefined;
  if (rounds.length === 0) return undefined;
  const lease = input.module ?? currentQuickJSModule();
  if (!lease) return undefined;
  let runtime: ScriptRuntime | undefined;
  try {
    const rendered = renderExecTool(input.tools);
    runtime = createScriptRuntime({
      tools: rendered.names,
      allTools: rendered.allTools,
      seed: record.originalCallId,
      module: lease,
      onEvicted: () => scripts.loseIfRuntimeGone(record),
    });
    const ran = runRounds(runtime, input);
    if (ran.kind !== "ran") return ran.result;
    const { step, hashes } = ran;
    scripts.transition(record, "replay");
    scripts.attachRuntime(record, runtime);
    record.batches = rounds.map((round, k) => ({
      ids: round.ids,
      batchHash: hashes[k],
      repairs: record.batches[k]?.repairs,
    }));
    if (step.kind === "blocked") {
      const blocks = nestedBlocksFor(record.execCallId, step.calls);
      suspendBlocked(scripts, record, blocks);
      log(`[CodeMode] exec ${record.originalCallId}: replayed from history; blocked again`);
      return { kind: "reply", blocks };
    }
    settleDone(scripts, record, step.output, completionKey(hashes), input.sessionKey);
    log(`[CodeMode] exec ${record.originalCallId}: replayed from history; ${step.output.status}`);
    return { kind: "done" };
  } catch (err) {
    log(`[CodeMode] exec ${record.originalCallId}: replay failed; script lost: ${err}`);
    try {
      runtime?.dispose();
      // The replay transition may already have run before the throw.
      const state: ExecState = (record as ExecRecord).state;
      if (state === "running") scripts.transition(record, "fail");
    } catch {
      // The runtime is gone either way.
    }
    return undefined;
  }
}
