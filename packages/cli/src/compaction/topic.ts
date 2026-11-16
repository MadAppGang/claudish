/**
 * Whether a new human turn changed the conversation's topic, for the history
 * policy `topic`: on a new topic the earlier history is swapped for its ready
 * summary at once, instead of near the limit.
 *
 * Two deciders, `compaction.history.topic.decider`:
 *
 * - `haiku`: one call to the compaction model with the ready summary and the
 *   recent turns (a cached prefix) and the new prompt, answering
 *   `{topic, confidence, reason}` under a JSON schema.
 * - `embed`: a local Ollama embedding model. The prompt's cosine similarity
 *   to the summary and to each recent turn; the highest below the threshold
 *   is a new topic. No API cost.
 *
 * Every failure (a timeout, Ollama unreachable, an answer off the schema) is
 * a result with no verdict, and no verdict never swaps.
 */

import { DEFAULT_TOPIC_SETTINGS, type HistorySettings } from "./config.js";
import type { CompactionClient } from "./haiku-client.js";

/** The decider the settings name, under the `topic` policy only. */
export function topicDeciderFor(
  history: HistorySettings,
  client: CompactionClient,
  ollamaBaseUrl: string
): TopicDecider | undefined {
  if (history.policy !== "topic") return undefined;
  const t = history.topic ?? DEFAULT_TOPIC_SETTINGS;
  if (t.decider === "embed") {
    const embed = ollamaEmbed({
      baseUrl: ollamaBaseUrl,
      model: t.embedModel,
      timeoutMs: t.timeoutMs,
    });
    return new EmbedTopicDecider(embed, t.similarityBelow);
  }
  return new HaikuTopicDecider(client, t.timeoutMs);
}

export type Topic = "same" | "related" | "new";

export interface TopicVerdict {
  topic: Topic;
  /** 0..1. The `embed` decider has no confidence of its own and reports 1. */
  confidence: number;
  /** The `embed` decider's highest cosine similarity. */
  similarity?: number;
  reason: string;
}

export type TopicResult = { ok: true; verdict: TopicVerdict } | { ok: false; reason: string };

export interface TopicInput {
  /** The new human turn's text. */
  prompt: string;
  /** The ready summary of the earlier conversation. */
  summary: string;
  /** The texts of the turns after the summary, oldest first. */
  recent: string[];
}

export interface TopicDecider {
  readonly name: "haiku" | "embed";
  decide(input: TopicInput): Promise<TopicResult>;
}

const TOPICS: readonly Topic[] = ["same", "related", "new"];

export const TOPIC_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    topic: { type: "string", enum: [...TOPICS] },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["topic", "confidence", "reason"],
  additionalProperties: false,
};

export const TOPIC_SYSTEM_PROMPT = [
  "You decide whether a user's new message in a coding session continues the earlier conversation.",
  "You get a summary of the earlier conversation, its most recent turns, and the new message.",
  'Answer "same" when the new message continues the current task,',
  '"related" when it starts a new task that still depends on earlier work, files or decisions',
  '(for example "add a test for the fix you made earlier"),',
  'and "new" only when nothing earlier is needed to do it.',
  "confidence is your certainty from 0 to 1. reason is one short sentence.",
].join(" ");

/** Characters of recent turns sent to the `haiku` decider. */
export const TOPIC_RECENT_MAX_CHARS = 8_000;
/** Characters of one text sent to either decider. */
export const TOPIC_TEXT_MAX_CHARS = 4_000;
export const TOPIC_MAX_TOKENS = 256;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The newest recent turns that fit in `max` characters, oldest first. */
function recentWithin(recent: readonly string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = cut(recent[i] ?? "", TOPIC_TEXT_MAX_CHARS);
    if (used + t.length > max && out.length > 0) break;
    out.unshift(t);
    used += t.length;
  }
  return out;
}

/** Read the `haiku` decider's answer; anything off the schema is no verdict. */
export function parseTopicVerdict(text: string): TopicResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the answer is not JSON" };
  }
  const d = data as { topic?: unknown; confidence?: unknown; reason?: unknown } | null;
  if (!d || typeof d !== "object") return { ok: false, reason: "the answer is not an object" };
  if (!TOPICS.includes(d.topic as Topic)) return { ok: false, reason: "no valid topic" };
  const c = d.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
    return { ok: false, reason: "no valid confidence" };
  }
  return {
    ok: true,
    verdict: {
      topic: d.topic as Topic,
      confidence: c,
      reason: typeof d.reason === "string" ? d.reason : "",
    },
  };
}

export class HaikuTopicDecider implements TopicDecider {
  readonly name = "haiku" as const;
  constructor(
    private readonly client: CompactionClient,
    private readonly timeoutMs: number
  ) {}

  async decide(input: TopicInput): Promise<TopicResult> {
    const context = [
      "Summary of the earlier conversation:",
      input.summary,
      "",
      "Most recent turns:",
      ...recentWithin(input.recent, TOPIC_RECENT_MAX_CHARS).map((t) => `- ${t}`),
    ].join("\n");
    const result = await this.client.complete({
      system: TOPIC_SYSTEM_PROMPT,
      cachedPrefix: context,
      user: `New message:\n${cut(input.prompt, TOPIC_TEXT_MAX_CHARS)}`,
      schema: TOPIC_SCHEMA,
      maxTokens: TOPIC_MAX_TOKENS,
      timeoutMs: this.timeoutMs,
      purpose: "topic decision",
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return parseTopicVerdict(result.text);
  }
}

/** Texts in, one embedding per text out, in order. */
export type Embed = (texts: string[]) => Promise<number[][]>;

/** Embeddings from Ollama's `/api/embed`. Rejects, naming the URL, when Ollama does not answer. */
export function ollamaEmbed(opts: {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Embed {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return async (texts) => {
    const doFetch = opts.fetchImpl ?? fetch;
    let resp: Response;
    try {
      resp = await doFetch(`${base}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, input: texts }),
        signal: AbortSignal.timeout(Math.max(1, opts.timeoutMs)),
      });
    } catch (err) {
      throw new Error(
        `Ollama at ${base} is unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!resp.ok) throw new Error(`Ollama at ${base} answered HTTP ${resp.status}`);
    const data = (await resp.json()) as { embeddings?: unknown };
    const out = data.embeddings;
    if (
      !Array.isArray(out) ||
      out.length !== texts.length ||
      !out.every((v) => Array.isArray(v) && v.every((x) => typeof x === "number"))
    ) {
      throw new Error(`Ollama at ${base} returned no embeddings for ${opts.model}`);
    }
    return out as number[][];
  };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

export class EmbedTopicDecider implements TopicDecider {
  readonly name = "embed" as const;
  constructor(
    private readonly embed: Embed,
    private readonly similarityBelow: number
  ) {}

  async decide(input: TopicInput): Promise<TopicResult> {
    const others = [input.summary, ...recentWithin(input.recent, TOPIC_RECENT_MAX_CHARS)].map((t) =>
      cut(t, TOPIC_TEXT_MAX_CHARS)
    );
    let vectors: number[][];
    try {
      vectors = await this.embed([cut(input.prompt, TOPIC_TEXT_MAX_CHARS), ...others]);
    } catch (err) {
      return {
        ok: false,
        reason: `embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const [prompt, ...rest] = vectors;
    if (!prompt || rest.length === 0) return { ok: false, reason: "embedding failed: no vectors" };
    const similarity = Math.max(...rest.map((v) => cosine(prompt, v)));
    const isNew = similarity < this.similarityBelow;
    return {
      ok: true,
      verdict: {
        topic: isNew ? "new" : "related",
        confidence: 1,
        similarity,
        reason: `similarity ${similarity.toFixed(2)} ${isNew ? "<" : ">="} ${this.similarityBelow}`,
      },
    };
  }
}

export interface TopicActionInput {
  result: TopicResult;
  minConfidence: number;
  /** A ready summary covers the earlier history; history is never dropped without one. */
  summaryReady: boolean;
  /** The gap since the previous request exceeds the cache TTL. */
  coldCache: boolean;
}

/** Swap only on a confident new topic with a ready summary. */
export function decideTopicAction(input: TopicActionInput): { swap: boolean; reason: string } {
  if (!input.result.ok) return { swap: false, reason: `no verdict: ${input.result.reason}` };
  const v = input.result.verdict;
  if (v.topic !== "new") return { swap: false, reason: `topic ${v.topic}: ${v.reason}` };
  if (v.confidence < input.minConfidence) {
    return { swap: false, reason: `confidence ${v.confidence} < ${input.minConfidence}` };
  }
  if (!input.summaryReady) return { swap: false, reason: "no ready summary" };
  const cache = input.coldCache
    ? "cold cache: the swap's write costs nothing extra"
    : "warm cache: the swap rewrites the cached history once";
  return { swap: true, reason: `new topic: ${v.reason}; ${cache}` };
}
