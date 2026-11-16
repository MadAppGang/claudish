/**
 * The CodeAssist envelope for one Antigravity generation request, in the shape
 * the Antigravity CLI (`agy`) sends it.
 *
 * Recorded from `agy` 1.5.9 through a proxy (2026-11-15), one turn with two
 * tool calls:
 *
 *   {
 *     "project", "requestId", "request": {
 *       "contents", "systemInstruction": { "role": "user", "parts" },
 *       "tools": [ { "functionDeclarations": [one] }, ... ],
 *       "labels", "generationConfig", "sessionId"
 *     },
 *     "model", "userAgent": "antigravity", "requestType": "agent"
 *   }
 *
 * The key order above is the recorded one and is reproduced, because the body
 * is serialized in insertion order. Pure: no I/O, and the clock and the random
 * ids are parameters, so a test names every byte.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type AgyEnvironment,
  agyEnvironment,
  declaresTools,
  withAgySystem,
  withAgyTools,
} from "./antigravity-agy-request.js";
import { agyContents, agyLocalTime, agyWordedTools } from "./antigravity-content.js";

/** What the backend reports about the model a request is sent to. */
export interface AntigravityEnvelopeModelMeta {
  /** `maxOutputTokens` from `fetchAvailableModels`; `agy` sends it as the output cap. */
  maxOutputTokens?: number;
  /** `model` from `fetchAvailableModels` (`MODEL_PLACEHOLDER_M418`); sent as `labels.model_enum`. */
  modelEnum?: string;
  /** `thinkingLevel` from `fetchAvailableModels`: the number behind the level sent beside an effort id. */
  thinkingLevel?: number;
  /** `displayName` from `fetchAvailableModels` (`Gemini 4 Argon (Medium)`); named in the first message. */
  displayName?: string;
}

/** The ids one conversation keeps across its requests. */
export interface AntigravityConversation {
  cascadeId: string;
  trajectoryId: string;
  /** Requests already sent in this conversation; the next request's ordinal. */
  requestCount: number;
  /**
   * The local time each user message and tool result was first sent, by the
   * entry's key. A request repeats the whole history, and a repeated entry
   * must carry the time it carried the first time.
   */
  times?: Map<string, string>;
  /**
   * The model name the first message was first sent with. A retry on another
   * effort variant repeats that message and must not rename the model in it.
   */
  firstModelDisplayName?: string;
}

/**
 * The conversations of one process, found by the harness session they belong
 * to (`scope`) and their first message. A request carries the whole history, so
 * the first content entry is the same on every request of one conversation and
 * differs between the conversations of one session (a subagent opens with its
 * own task); the scope keeps two sessions that open with the same words apart.
 * Bounded: the oldest conversation is dropped first.
 */
export class AntigravityConversations {
  private readonly byFirstMessage = new Map<string, AntigravityConversation>();
  /** Trajectories created and not yet handed out by `takeNewTrajectories`. */
  private readonly newTrajectories = new Set<string>();
  /** One id for the process, as `agy` keeps one across the requests of a run. */
  readonly sessionId: string;

  constructor(
    private readonly limit = 64,
    private readonly newId: () => string = randomUUID,
    sessionId: string = randomSessionId()
  ) {
    this.sessionId = sessionId;
  }

  /** The conversation `inner` belongs to, created on its first request. */
  of(inner: unknown, scope = ""): AntigravityConversation {
    const key = `${scope}\n${firstMessageKey(inner)}`;
    const known = this.byFirstMessage.get(key);
    if (known) {
      // Re-insert so the map's order is least recently used first.
      this.byFirstMessage.delete(key);
      this.byFirstMessage.set(key, known);
      return known;
    }
    const created = { cascadeId: this.newId(), trajectoryId: this.newId(), requestCount: 0 };
    this.byFirstMessage.set(key, created);
    this.newTrajectories.add(created.trajectoryId);
    if (this.byFirstMessage.size > this.limit) {
      const oldest = this.byFirstMessage.keys().next().value;
      if (oldest !== undefined) {
        const dropped = this.byFirstMessage.get(oldest);
        if (dropped) this.newTrajectories.delete(dropped.trajectoryId);
        this.byFirstMessage.delete(oldest);
      }
    }
    return created;
  }

  /**
   * The new trajectory a request body names, handed out once; null when the
   * body's trajectory is not new. Another conversation's stays for its own
   * request.
   */
  takeNewTrajectoryIn(body: string): string | null {
    for (const id of this.newTrajectories) {
      if (!body.includes(id)) continue;
      this.newTrajectories.delete(id);
      return id;
    }
    return null;
  }

  /** Forgets every trajectory not yet handed out. */
  clearNewTrajectories(): void {
    this.newTrajectories.clear();
  }
}

/** A signed 64-bit integer in decimal, the form of the recorded `sessionId`. */
export function randomSessionId(): string {
  return randomBytes(8).readBigInt64BE().toString();
}

function firstMessageKey(inner: unknown): string {
  const contents = (inner as { contents?: unknown[] } | null | undefined)?.contents;
  const first = Array.isArray(contents) && contents.length > 0 ? contents[0] : null;
  return createHash("sha256").update(JSON.stringify(first)).digest("hex");
}

interface Part {
  functionCall?: unknown;
  functionResponse?: unknown;
}
interface Content {
  role?: string;
  parts?: Part[];
}

/**
 * The index of the last step the history holds. The first request of a
 * conversation is step 0. After it, one model turn is one step and each tool
 * result is one step (recorded: a model turn with two tool calls and their two
 * results made the second request's index 3), and a later user message is one
 * step.
 */
export function lastStepIndex(contents: unknown): number {
  if (!Array.isArray(contents)) return 0;
  let steps = 0;
  for (const content of (contents as Content[]).slice(1)) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const results = parts.filter((part) => part?.functionResponse !== undefined).length;
    steps += results > 0 ? results : 1;
  }
  return steps;
}

/**
 * Tool results as the Antigravity CLI sends them: a content entry of their own
 * with role `model`, holding only the `functionResponse` parts. Whatever else
 * the entry carried (the harness's text, a tool result's images) follows in a
 * `user` entry.
 */
function toolResultsAsModelEntries(contents: unknown): unknown {
  if (!Array.isArray(contents)) return contents;
  const out: unknown[] = [];
  for (const content of contents as Content[]) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const results = parts.filter((part) => part?.functionResponse !== undefined);
    if (results.length === 0) {
      out.push(content);
      continue;
    }
    const others = parts.filter((part) => part?.functionResponse === undefined);
    out.push({ ...content, role: "model", parts: results });
    if (others.length > 0) out.push({ ...content, parts: others });
  }
  return out;
}

/** One tool entry per declaration, as recorded, in the declarations' order. */
function oneToolPerDeclaration(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  const out: unknown[] = [];
  for (const entry of tools) {
    const declarations = (entry as { functionDeclarations?: unknown[] } | null)
      ?.functionDeclarations;
    if (!Array.isArray(declarations) || declarations.length <= 1) {
      out.push(entry);
      continue;
    }
    const { functionDeclarations: _all, ...rest } = entry as Record<string, unknown>;
    for (const declaration of declarations) {
      out.push({ ...rest, functionDeclarations: [declaration] });
    }
  }
  return out;
}

function labelsFor(
  model: string,
  meta: AntigravityEnvelopeModelMeta | undefined,
  conversation: AntigravityConversation,
  stepIndex: number
): Record<string, string> {
  const claude = model.startsWith("claude");
  const gemini = model.startsWith("gemini");
  // Alphabetical, the recorded order.
  const labels: Record<string, string> = {
    cascade_id: conversation.cascadeId,
    last_step_index: String(stepIndex),
  };
  if (meta?.modelEnum) labels.model_enum = meta.modelEnum;
  labels.request_id = `${conversation.trajectoryId}-${conversation.requestCount}`;
  labels.root_cascade_id = conversation.cascadeId;
  labels.trajectory_id = conversation.trajectoryId;
  labels.used_claude = String(claude);
  labels.used_claude_conservative = String(claude);
  labels.used_non_gemini_model = String(!gemini);
  return labels;
}

export interface AntigravityEnvelopeInput {
  /** The Gemini-dialect body, already shaped for the model id that is sent. */
  inner: unknown;
  /** The served model id that is sent. */
  model: string;
  projectId: string | null;
  meta?: AntigravityEnvelopeModelMeta;
  conversation: AntigravityConversation;
  sessionId: string;
  /** Epoch milliseconds; a parameter so a test fixes it. */
  now?: number;
  /** What `agy`'s prompt says about this machine; a parameter so a test fixes it. */
  environment?: AgyEnvironment;
}

/**
 * Build the envelope and count the request in its conversation. Never mutates
 * `inner`.
 */
export function buildAntigravityEnvelope(input: AntigravityEnvelopeInput): Record<string, unknown> {
  const { model, meta, conversation } = input;
  const inner = (input.inner ?? {}) as Record<string, unknown>;
  const {
    contents,
    systemInstruction,
    tools,
    generationConfig,
    labels: _labels,
    sessionId: _sessionId,
    ...others
  } = inner;

  const stepIndex = lastStepIndex(contents);
  const now = agyLocalTime(new Date(input.now ?? Date.now()));
  conversation.times ??= new Map();
  const times = conversation.times;
  conversation.firstModelDisplayName ??= meta?.displayName;
  const worded = agyContents(contents, {
    timeOf: (key) => {
      const known = times.get(key);
      if (known !== undefined) return known;
      times.set(key, now);
      return now;
    },
    modelDisplayName: conversation.firstModelDisplayName,
    wordedTools: agyWordedTools(tools),
  });
  const request: Record<string, unknown> = { contents: toolResultsAsModelEntries(worded) };
  // A request that declares tools is an agent request, and carries `agy`'s
  // prompt and declarations ahead of the harness's own.
  const agent = declaresTools(tools);
  const environment = agent ? (input.environment ?? agyEnvironment()) : undefined;
  const system = environment
    ? withAgySystem(systemInstruction, environment, conversation.cascadeId)
    : systemInstruction;
  if (system && typeof system === "object") {
    const { role: _role, ...instruction } = system as Record<string, unknown>;
    request.systemInstruction = { role: "user", ...instruction };
  }
  if (tools !== undefined) {
    request.tools = oneToolPerDeclaration(environment ? withAgyTools(tools, environment) : tools);
  }
  Object.assign(request, others);
  request.labels = labelsFor(model, meta, conversation, stepIndex);
  // `agy` sends no temperature, and sends the output cap the backend reports
  // for the model. The thinking fields are the dialect's and are kept.
  const {
    temperature: _temperature,
    maxOutputTokens,
    ...config
  } = (generationConfig ?? {}) as Record<string, unknown>;
  const cap = meta?.maxOutputTokens ?? maxOutputTokens;
  request.generationConfig = cap === undefined ? config : { maxOutputTokens: cap, ...config };
  request.sessionId = input.sessionId;

  const envelope = {
    project: input.projectId,
    requestId: `agent/${conversation.cascadeId}/${input.now ?? Date.now()}/${conversation.trajectoryId}/${stepIndex + 1}`,
    request,
    model,
    userAgent: "antigravity",
    requestType: "agent",
  };
  conversation.requestCount += 1;
  return envelope;
}

/** The conversations of this process. Every builder of the envelope shares it. */
export const antigravityConversations = new AntigravityConversations();
