/**
 * The pure candidate ↔ request mappings (architecture §1.2, R18) that
 * `pool.ts`, `simulate` and `sim/` all call, so the simulator can never drift
 * from production through a local copy of the mapping (§5 case 40).
 *
 * - `candidatesToChooseRequest`: the pool's eligible `AccountCandidate`s →
 *   `ChooseRequest` (`overThreshold` from the real `isOverThreshold`, each
 *   snapshot through `readingsFromSnapshot`).
 * - `viewsToCandidates`: account views → `AccountCandidate`s, so the `sticky`
 *   strategy runs the REAL `selectAccount` over the simulated world.
 * - `threadKeyOf`: the in-memory stickiness key of one harness thread (§2.2).
 */

import { type AccountCandidate, type SelectOptions, isOverThreshold } from "../policy.js";
import type { AccountProvider, UsageWindow } from "../types.js";
import { usable, windowBlocks } from "./capacity.js";
import { DEFAULT_ALLOWANCE_CONFIG } from "./constants.js";
import { fnvHex } from "./prng.js";
import { readingsFromSnapshot } from "./readings.js";
import type {
  AccountId,
  AccountView,
  AllowanceConfig,
  ChooseRequest,
  DecisionInput,
  EligibleAccount,
  Ms,
  SessionKey,
  ThreadKey,
} from "./types.js";

/** What the shell knows about the thread a request belongs to (§2.2). */
export interface ThreadHint {
  session: SessionKey | null;
  thread: ThreadKey | null;
  threadAccount: AccountId | null;
  lastSwitchAt: Ms | null;
  contextTokens: number | null;
}

/** The text of a `system` field or a message's `content`: every text block, in order. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * `sessionId:fnv1a32(system + "\0" + the WHOLE first user message)`, 8 hex
 * digits (§2.2). The whole text, never a prefix: Claude Code opens the first
 * user message of the main thread and of every subagent with the same
 * `<system-reminder>` block, which is far longer than any fixed prefix, so a
 * prefix hash gives every thread of a session one key. Null without a session
 * id. Two threads with a byte-identical system prompt AND first user message
 * still share a key; they then share only a stickiness preference, because the
 * switch is priced from each request's own `contextTokens`.
 */
export function threadKeyOf(
  sessionId: string | null,
  request: { system?: unknown; messages?: unknown }
): ThreadKey | null {
  if (!sessionId) return null;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const first = messages.find(
    (m): m is { role: "user"; content?: unknown } =>
      m !== null && typeof m === "object" && (m as { role?: unknown }).role === "user"
  );
  const text = `${textOf(request.system)}\u0000${textOf(first?.content)}`;
  return `${sessionId}:${fnvHex(text)}`;
}

/** The ranker's input: the candidates `selectAccount` found eligible, mapped once. */
export function candidatesToChooseRequest(
  eligible: readonly AccountCandidate[],
  opts: SelectOptions,
  hint: ThreadHint,
  quantumCodex: number = DEFAULT_ALLOWANCE_CONFIG.QUANTUM_CODEX
): ChooseRequest {
  return {
    now: opts.now,
    session: hint.session,
    thread: hint.thread,
    threadAccount: hint.threadAccount,
    lastSwitchAt: hint.lastSwitchAt,
    poolActive: eligible.find((c) => c.isActive)?.ref.id ?? null,
    eligible: eligible.map((c) => ({
      id: c.ref.id,
      order: c.order,
      usageFailed: c.usageFailed,
      overThreshold: isOverThreshold(c, opts.now, opts),
      snapshot: readingsFromSnapshot(c.ref.provider, c.usage, quantumCodex),
      snapshotAt: c.usage?.observedAt ?? null,
    })),
    contextTokens: hint.contextTokens,
  };
}

/** The claudish provider whose `AccountRef`s a simulated candidate carries. */
export function accountProviderOf(cfg: Pick<AllowanceConfig, "provider">): AccountProvider {
  return cfg.provider === "anthropic" ? "native-anthropic" : "openai-codex";
}

/**
 * Views → candidates for the real `selectAccount`. A window's used fraction is
 * `1 − remaining`; an unread window says nothing. An account that is not
 * usable is marked exhausted until its latest blocking reset, as a 429 marks
 * it in production. `isActive` is a0: the thread's account, else the pool's.
 */
export function viewsToCandidates(
  views: readonly AccountView[],
  input: Pick<DecisionInput, "now" | "thread" | "poolActive" | "eligible">,
  provider: AccountProvider
): AccountCandidate[] {
  const a0 = input.thread.account ?? input.poolActive;
  return views.map((view) => {
    const windows: UsageWindow[] = [];
    for (const w of view.windows) {
      if (w.remaining === null) continue;
      windows.push({
        slot: w.slot,
        displayId: w.key,
        ...(w.lengthMinutes !== null ? { lengthMinutes: w.lengthMinutes } : {}),
        usedFraction: Math.max(0, Math.min(1, 1 - w.remaining)),
        ...(w.resetAt !== null ? { resetAt: w.resetAt } : {}),
        ...(w.rejected ? { rejected: true } : {}),
      });
    }
    const eligible: EligibleAccount | undefined = input.eligible.find((e) => e.id === view.account);
    let exhaustedUntil: number | undefined;
    if (!usable(view)) {
      const resets = view.windows
        .filter(windowBlocks)
        .map((w) => w.resetAt ?? Number.POSITIVE_INFINITY);
      exhaustedUntil = Math.max(input.now + 1, ...resets);
    }
    return {
      ref: { provider, id: view.account, label: view.account },
      order: view.order,
      enabled: true,
      usage: windows.length > 0 ? { windows, observedAt: view.observedAt ?? input.now } : null,
      usageFailed: eligible?.usageFailed ?? false,
      isActive: a0 !== null && view.account === a0,
      ...(exhaustedUntil !== undefined ? { exhaustedUntil } : {}),
    };
  });
}

/** A simulated eligible entry for a view: no fresh snapshot, `overThreshold` at `threshold`. */
export function eligibleOfView(view: AccountView, threshold: number): EligibleAccount {
  return {
    id: view.account,
    order: view.order,
    usageFailed: false,
    overThreshold: view.windows.some((w) => w.remaining !== null && 1 - w.remaining >= threshold),
    snapshot: null,
    snapshotAt: null,
  };
}
