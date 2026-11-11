/**
 * The subagents of one Claude Code session, as `SubagentRow`s (architecture §3, "Subagent lifecycle").
 *
 * Pure: the transcript follower feeds it records and files, and it reads nothing itself.
 *
 * What Claude Code writes (measured on 2.1.302 to 2.1.322; spike S8 in the implementation log):
 *   - `subagents/agent-<id>.meta.json` `{agentType, description, toolUseId, requestShape, ...}` is
 *     written when the subagent launches, before its `agent-<id>.jsonl`, and replaced at the end with
 *     `finished: true`. Its `toolUseId` names the parent's `Agent`/`Task` call: 2,483 of 2,483 metas
 *     whose call is in the main chain agree with the call's own description and type and with the
 *     result's `agentId`, none disagree. Nested subagents put their meta in the same directory with
 *     the `toolUseId` of a call made inside another subagent file.
 *   - the parent's `tool_result` carries `toolUseResult.agentId`: at once for a background call
 *     (`isAsync: true`, `status: "async_launched"`), at the end for a foreground one;
 *   - a `<task-notification>` carries `<task-id>` (the agent id) and `<tool-use-id>` when a background
 *     subagent ends;
 *   - parallel calls do not create their files in call order (13 of 279 corpus groups did not).
 *
 * So a row is linked to its call only by evidence. The three sources above are authoritative. Where
 * none has arrived yet, a subagent whose first user record equals exactly one unlinked call's prompt
 * is linked PROVISIONALLY (2,434 of 2,483 corpus first records equal the prompt; the rest only
 * contain it and stay unlinked). An authoritative link always replaces a provisional one, and the
 * row that lost its call goes back to unlinked and may match again. Order is never evidence.
 *
 * Folding the same record twice changes nothing: calls and links are keyed by id, a row's state
 * only moves `running → done`, and counts come from the subagent file, whose offsets only grow. A
 * re-fold of the main chain after `rewindTo` therefore leaves the ledger as it was.
 */

import { createHash } from "node:crypto";
import { redactSecrets } from "../redact.js";
import type { SubagentRow } from "./view-contract.js";

/** Rows kept per session; the newest (by `started_at`) stay. */
export const SUBAGENT_ROW_LIMIT = 20;
/** Agent/Task calls whose metadata is kept for linking. */
export const SUBAGENT_CALL_LIMIT = 64;
export const SUBAGENT_DESCRIPTION_MAX = 100;

// biome-ignore lint/suspicious/noExplicitAny: raw JSON records, narrowed field by field
type Rec = Record<string, any>;

type Link = "authoritative" | "provisional";

interface CallMeta {
  description: string | null;
  subagentType: string | null;
  /** digest of the call's prompt; the prompt itself is never kept */
  promptKey: string | null;
  at: string | null;
}

interface AgentEntry {
  id: string;
  seq: number;
  startedAt: string;
  call: { id: string; link: Link } | null;
  /** from the agent's own meta file: wins over the call's input */
  metaDescription: string | null;
  metaType: string | null;
  mode: SubagentRow["mode"];
  state: SubagentRow["state"];
  toolCalls: number;
  outByMessage: Map<string, number>;
  /** digest of the first user record of the agent file; null until read */
  firstUserKey: string | null;
  firstUserSeen: boolean;
}

export interface MetaFile {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
  requestShape?: unknown;
  finished?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A description as shown: credentials masked, at most 100 characters, one line. */
export function subagentDescription(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const line = redactSecrets(s.replace(/\s+/g, " ").trim());
  return line ? line.slice(0, SUBAGENT_DESCRIPTION_MAX) : null;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("base64");
}

function userText(r: Rec): string | null {
  const c = r.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return null;
  if (c.some((b) => b?.type === "tool_result")) return null;
  return c
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function tagOf(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return m ? (m[1] ?? "").trim() || null : null;
}

export class SubagentLedger {
  private agents = new Map<string, AgentEntry>();
  /** ids that fell out of the newest 20: never re-created */
  private evicted = new Set<string>();
  private calls = new Map<string, CallMeta>();
  /** call id → agent id holding it */
  private holders = new Map<string, string>();
  private seq = 0;
  private versionValue = 0;
  private cache: SubagentRow[] | null = null;

  /** Moves whenever `rows()` would answer something different. */
  get version(): number {
    return this.versionValue;
  }

  /** At most 20 rows, oldest first. */
  rows(): SubagentRow[] {
    if (this.cache) return this.cache;
    this.cache = this.ordered().map((a) => this.rowOf(a));
    return this.cache;
  }

  /** True when the agent's meta file still has something to say (not evicted, not finished). */
  wantsMeta(agentId: string): boolean {
    if (this.evicted.has(agentId)) return false;
    const a = this.agents.get(agentId);
    return !a || a.state === "running" || a.metaDescription === null;
  }

  /* ─────────────── main chain ─────────────── */

  /** One main-chain record: Agent/Task calls, their results, task notifications. */
  foldMain(r: Rec, nowIso: string): void {
    if (r.isSidechain) return;
    if (r.type === "assistant") {
      for (const b of r.message?.content ?? []) this.noteCall(b, r.timestamp);
      return;
    }
    if (r.type === "user") {
      this.foldUser(r, nowIso);
      return;
    }
    // a notification absorbed into a turn still running
    const a = r.type === "attachment" ? r.attachment : null;
    if (a?.type === "queued_command" && typeof a.prompt === "string")
      if (a.prompt.startsWith("<task-notification>")) this.foldNotification(a.prompt, nowIso);
  }

  private foldUser(r: Rec, nowIso: string): void {
    const c = r.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) {
      this.foldResults(r, c as Rec[], nowIso);
      return;
    }
    // a human prompt that quotes a notification is not one
    if (r.origin !== undefined && r.origin?.kind !== "task-notification") return;
    const text = userText(r);
    if (text?.startsWith("<task-notification>")) this.foldNotification(text, nowIso);
  }

  /** An Agent/Task `tool_use` in a subagent file: a nested call, linked through its own meta. */
  foldSubCall(b: Rec, at: unknown): void {
    this.noteCall(b, at);
  }

  private noteCall(b: Rec, at: unknown): void {
    if (b?.type !== "tool_use" || typeof b.id !== "string") return;
    if (b.name !== "Agent" && b.name !== "Task") return;
    if (this.calls.has(b.id)) return;
    const prompt = str(b.input?.prompt);
    this.calls.set(b.id, {
      description: subagentDescription(b.input?.description),
      subagentType: str(b.input?.subagent_type),
      promptKey: prompt === null ? null : digest(prompt),
      at: str(at),
    });
    this.trimCalls();
    // a subagent whose file was read before its call was folded can match now
    for (const a of this.agents.values()) if (!a.call) this.tryProvisional(a);
  }

  private trimCalls(): void {
    while (this.calls.size > SUBAGENT_CALL_LIMIT) {
      const oldest = this.calls.keys().next().value as string;
      this.calls.delete(oldest);
      this.holders.delete(oldest);
    }
  }

  private foldResults(r: Rec, blocks: Rec[], nowIso: string): void {
    const tur = r.toolUseResult && typeof r.toolUseResult === "object" ? r.toolUseResult : null;
    const agentId = str(tur?.agentId);
    if (!agentId) return;
    for (const b of blocks) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const a = this.ensure(
        agentId,
        str(r.timestamp) ?? this.calls.get(b.tool_use_id)?.at ?? nowIso
      );
      if (!a) return;
      this.linkAuthoritative(a, b.tool_use_id);
      if (tur?.isAsync === true) this.setMode(a, "background");
      else {
        // a foreground call answers only when its subagent has finished
        this.setMode(a, "foreground");
        this.markDone(a);
      }
    }
  }

  private foldNotification(text: string, nowIso: string): void {
    const taskId = tagOf(text, "task-id");
    if (!taskId) return;
    const toolUseId = tagOf(text, "tool-use-id");
    // a background shell's notification has a task id too: only a known agent or call counts
    if (!this.agents.has(taskId) && !(toolUseId && this.calls.has(toolUseId))) return;
    const a = this.ensure(taskId, nowIso);
    if (!a) return;
    if (toolUseId) this.linkAuthoritative(a, toolUseId);
    this.setMode(a, "background");
    this.markDone(a);
  }

  /* ─────────────── subagent files ─────────────── */

  /** One record of `agent-<id>.jsonl`, read once (the file's offsets only grow). */
  foldSubRecord(agentId: string, r: Rec, nowIso: string): void {
    const a = this.ensure(agentId, str(r.timestamp) ?? nowIso);
    if (!a) return;
    if (r.type === "user") this.noteFirstUser(a, r);
    else if (r.type === "assistant") this.foldSubAssistant(a, r);
  }

  private noteFirstUser(a: AgentEntry, r: Rec): void {
    if (a.firstUserSeen) return;
    const text = userText(r);
    if (text === null) return;
    a.firstUserSeen = true;
    a.firstUserKey = digest(text);
    if (!a.call) this.tryProvisional(a);
  }

  private foldSubAssistant(a: AgentEntry, r: Rec): void {
    const m = r.message ?? {};
    let calls = 0;
    for (const b of m.content ?? []) {
      if (b?.type !== "tool_use") continue;
      calls++;
      this.foldSubCall(b, r.timestamp);
    }
    if (calls > 0) {
      a.toolCalls += calls;
      this.touch();
    }
    const id = str(m.id);
    const out = m.usage?.output_tokens;
    if (id && typeof out === "number" && Number.isFinite(out) && a.outByMessage.get(id) !== out) {
      a.outByMessage.set(id, out);
      this.touch();
    }
  }

  /** The agent's meta file as read now (it is replaced at the end with `finished: true`). */
  foldMeta(agentId: string, meta: MetaFile, nowIso: string): void {
    const a = this.ensure(agentId, nowIso);
    if (!a) return;
    const desc = subagentDescription(meta.description);
    if (desc !== null && desc !== a.metaDescription) {
      a.metaDescription = desc;
      this.touch();
    }
    const type = str(meta.agentType);
    if (type !== null && type !== a.metaType) {
      a.metaType = type;
      this.touch();
    }
    const call = str(meta.toolUseId);
    if (call) this.linkAuthoritative(a, call);
    if (meta.requestShape === "background" || meta.requestShape === "foreground")
      if (a.mode === null) this.setMode(a, meta.requestShape);
    if (meta.finished === true) this.markDone(a);
  }

  /* ─────────────── linking ─────────────── */

  private linkAuthoritative(a: AgentEntry, callId: string): void {
    if (a.call?.id === callId && a.call.link === "authoritative") return;
    const freed: AgentEntry[] = [];
    // the call's provisional holder was wrong
    const holderId = this.holders.get(callId);
    const holder = holderId && holderId !== a.id ? this.agents.get(holderId) : undefined;
    if (holder) {
      holder.call = null;
      freed.push(holder);
    }
    // this agent's own provisional call was wrong
    if (a.call && a.call.id !== callId) {
      this.holders.delete(a.call.id);
    }
    a.call = { id: callId, link: "authoritative" };
    this.holders.set(callId, a.id);
    this.touch();
    for (const f of freed) this.tryProvisional(f);
    // a call this agent let go of may now be the only match of another unlinked agent
    for (const other of this.agents.values()) if (!other.call) this.tryProvisional(other);
  }

  /** Link `a` to the one unlinked call whose prompt equals its first user record, if exactly one. */
  private tryProvisional(a: AgentEntry): void {
    if (a.call || a.firstUserKey === null) return;
    let match: string | null = null;
    for (const [id, c] of this.calls) {
      if (c.promptKey !== a.firstUserKey || this.holders.has(id)) continue;
      if (match !== null) return; // two calls with the same prompt: wait for evidence
      match = id;
    }
    if (match === null) return;
    a.call = { id: match, link: "provisional" };
    this.holders.set(match, a.id);
    this.touch();
  }

  /* ─────────────── rows ─────────────── */

  private ensure(agentId: string, startedAt: string): AgentEntry | null {
    if (this.evicted.has(agentId)) return null;
    const known = this.agents.get(agentId);
    if (known) return known;
    const a: AgentEntry = {
      id: agentId,
      seq: this.seq++,
      startedAt,
      call: null,
      metaDescription: null,
      metaType: null,
      mode: null,
      state: "running",
      toolCalls: 0,
      outByMessage: new Map(),
      firstUserKey: null,
      firstUserSeen: false,
    };
    this.agents.set(agentId, a);
    this.touch();
    this.evict();
    return this.agents.has(agentId) ? a : null;
  }

  private evict(): void {
    while (this.agents.size > SUBAGENT_ROW_LIMIT) {
      const oldest = this.ordered()[0];
      if (!oldest) return;
      this.agents.delete(oldest.id);
      this.evicted.add(oldest.id);
      if (oldest.call && this.holders.get(oldest.call.id) === oldest.id)
        this.holders.delete(oldest.call.id);
    }
  }

  private ordered(): AgentEntry[] {
    return [...this.agents.values()].sort((x, y) =>
      x.startedAt === y.startedAt ? x.seq - y.seq : x.startedAt < y.startedAt ? -1 : 1
    );
  }

  private setMode(a: AgentEntry, mode: "foreground" | "background"): void {
    if (a.mode === mode) return;
    a.mode = mode;
    this.touch();
  }

  private markDone(a: AgentEntry): void {
    if (a.state === "done") return;
    a.state = "done";
    this.touch();
  }

  private touch(): void {
    this.versionValue++;
    this.cache = null;
  }

  private rowOf(a: AgentEntry): SubagentRow {
    const call = a.call ? this.calls.get(a.call.id) : undefined;
    let out: number | null = null;
    for (const n of a.outByMessage.values()) out = (out ?? 0) + n;
    return {
      id: a.id,
      description: a.metaDescription ?? call?.description ?? null,
      subagent_type: a.metaType ?? call?.subagentType ?? null,
      mode: a.mode,
      state: a.state,
      started_at: a.startedAt,
      tool_calls: a.toolCalls,
      tokens_out: out,
    };
  }
}
