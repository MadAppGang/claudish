/**
 * #83 — negotiated capability vocabulary.
 *
 * INERT by design in this grain: nothing in the pipeline imports this module yet.
 * Wiring (condensation-rail injection + outbound lift) is the next grain and starts
 * only on coordinator arbitration of docs/reference/capability-vocabulary.md.
 * The gate `CLAUDISH_CAPABILITY_VOCAB` defaults to off, so even wired, an operator
 * must opt in per machine.
 *
 * Doctrine 2026-08-23 applies to everything emitted here: the query states facts
 * about routing and offers a declaration channel. It never instructs the agent on
 * risk posture, scope of work, or prior decisions, and a declaration is advisory
 * input only — routing policy stays proxy-side.
 */

/** Fenced-block info string — the stable marker for a declaration. */
export const CAPABILITY_VOCAB_FENCE = "claudish-needs";

/** Cap on how many condensations the query is appended to while the session
 * stays undeclared (silence after this many asks means "nothing to declare"). */
export const CAPABILITY_QUERY_MAX_ASKS = 3;

export interface CapabilityDeclaration {
  v: 1;
  /** Session reads or emits images — prefer a vision-capable step. */
  vision?: boolean;
  /** Lower bound on usable context window — feeds the #79 pre-flight. */
  context_tokens_min?: number;
  /** Licenses thinking-policy flips on the next step. */
  reasoning_depth?: "low" | "medium" | "high";
  /** Tool-heavy loops block on some lanes — prefer a lane that handles them. */
  tool_call_density?: "low" | "medium" | "high";
  /** `budget` = stay on subscription lanes; `any` = PAYG tail acceptable. */
  cost_class?: "budget" | "any";
}

type Depth = "low" | "medium" | "high";

const DEPTHS: readonly Depth[] = ["low", "medium", "high"];

/**
 * The factual query block appended to a condensation. Same shape/separator as the
 * failover notice so the two compose under one `[claudish]` origin.
 */
export function buildCapabilityQuery(): string {
  return [
    "",
    "---",
    "",
    "**[claudish] Capability query — optional routing input.** This proxy routes by role and provider health alone. If this session has needs the router should weigh, you may state them in your next message as a fenced code block tagged `" +
      CAPABILITY_VOCAB_FENCE +
      "` containing a JSON object with any subset of: `\"vision\": true|false`, `\"context_tokens_min\": <number>`, `\"reasoning_depth\": \"low\"|\"medium\"|\"high\"`, `\"tool_call_density\": \"low\"|\"medium\"|\"high\"`, `\"cost_class\": \"budget\"|\"any\"`. Declarations are advisory inputs to routing only: they never override proxy-side policy, and omitting or malforming them changes nothing about how requests are served.",
  ].join("\n");
}

const FENCE_RE = new RegExp("```" + CAPABILITY_VOCAB_FENCE + "[^\\n]*\\n([\\s\\S]*?)```", "g");

/**
 * Lift a declaration from assistant text. Strict, never throws:
 * - takes the LAST complete fenced block (a re-emitted declaration in a summary
 *   is the newest statement of the session's needs);
 * - unknown fields are dropped, mistyped or out-of-enum fields are dropped;
 * - absent marker, malformed JSON, wrong `v`, or a block where nothing valid
 *   survives → null (the session is simply undeclared).
 */
export function parseCapabilityDeclaration(text: string): CapabilityDeclaration | null {
  try {
    if (typeof text !== "string") return null;
    let match: RegExpExecArray | null = null;
    let last: RegExpExecArray | null = null;
    FENCE_RE.lastIndex = 0;
    while ((match = FENCE_RE.exec(text)) !== null) last = match;
    if (!last) return null;

    const raw = JSON.parse(last[1]);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.v !== undefined && raw.v !== 1) return null;

    const decl: CapabilityDeclaration = { v: 1 };
    if (typeof raw.vision === "boolean") decl.vision = raw.vision;
    if (typeof raw.context_tokens_min === "number" && Number.isFinite(raw.context_tokens_min) && raw.context_tokens_min >= 0) {
      decl.context_tokens_min = Math.floor(raw.context_tokens_min);
    }
    if (typeof raw.reasoning_depth === "string" && (DEPTHS as readonly string[]).includes(raw.reasoning_depth)) {
      decl.reasoning_depth = raw.reasoning_depth as Depth;
    }
    if (typeof raw.tool_call_density === "string" && (DEPTHS as readonly string[]).includes(raw.tool_call_density)) {
      decl.tool_call_density = raw.tool_call_density as Depth;
    }
    if (raw.cost_class === "budget" || raw.cost_class === "any") {
      decl.cost_class = raw.cost_class;
    }
    // The block must carry at least one recognized field — a fence holding only
    // junk is noise, not a declaration.
    const hasAny =
      decl.vision !== undefined ||
      decl.context_tokens_min !== undefined ||
      decl.reasoning_depth !== undefined ||
      decl.tool_call_density !== undefined ||
      decl.cost_class !== undefined;
    return hasAny ? decl : null;
  } catch {
    return null;
  }
}

/** `CLAUDISH_CAPABILITY_VOCAB` gate — default off; re-read per request when wired,
 * same rationale as the thinking knobs (fleet flips mid-crunch, no restart). */
export function isCapabilityVocabEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test((env.CLAUDISH_CAPABILITY_VOCAB ?? "").trim());
}

/**
 * Ask cap as an env knob (arbitration 18/09): `CLAUDISH_CAPABILITY_QUERY_MAX_ASKS`,
 * default 3, re-read per call like the gate. 0 disables asking (lift stays active).
 */
export function capabilityQueryMaxAsks(env: NodeJS.ProcessEnv): number {
  const raw = (env.CLAUDISH_CAPABILITY_QUERY_MAX_ASKS ?? "").trim();
  if (raw === "") return CAPABILITY_QUERY_MAX_ASKS; // Number("") === 0 would zero the cap
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CAPABILITY_QUERY_MAX_ASKS;
}

// --- Grain 2 (wiring): the per-session channel state --------------------------------
//
// One state entry per extractSessionKey identity (the #91 p4 dwell seam — a single
// definition of session identity, no parallel key scheme). The declaration is
// lifted ONCE (first successful parse registers and short-circuits every later
// scan); the query is appended to at most `maxAsks` condensations while the
// session stays undeclared, and stops the moment a declaration lands.

interface CapabilitySessionState {
  declaration: CapabilityDeclaration | null;
  asks: number;
}

const sessions = new Map<string, CapabilitySessionState>();
const SESSION_CAP = 512;

function ensureState(sessionKey: string): CapabilitySessionState {
  const existing = sessions.get(sessionKey);
  if (existing) {
    // LRU touch — delete + reinsert moves the entry to the tail. Without this,
    // eviction below is FIFO and a long-lived ACTIVE session is evicted while
    // it still talks: its asks counter resets (re-asked past MAX_ASKS) and a
    // registered declaration is lost. Review of #135, reproduced on dfbe576.
    sessions.delete(sessionKey);
    sessions.set(sessionKey, existing);
    return existing;
  }
  const state: CapabilitySessionState = { declaration: null, asks: 0 };
  sessions.set(sessionKey, state);
  if (sessions.size > SESSION_CAP) {
    // Map preserves insertion order and every access reinserts, so the head is
    // the least-recently-USED entry — an evicted session is an idle one.
    sessions.delete(sessions.keys().next().value as string);
  }
  return state;
}

/** How many trailing assistant messages the lift scans. Bounded per request;
 * a declaration survives in history until compaction drops it, and a summary
 * that re-emits it is the newest statement (parseCapabilityDeclaration takes
 * the last fence within one text). */
const LIFT_SCAN_DEPTH = 6;

function assistantText(msg: any): string | null {
  if (msg?.role !== "assistant") return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return null;
}

/**
 * Lift the session's declaration from the trailing assistant history of an
 * Anthropic request payload, once per session. Returns the registration (old or
 * new) or null. Never throws — a malformed or degenerate history is simply
 * undeclared (the K3 echo-loop lesson: degenerate text must arm nothing).
 * Callers gate on `isCapabilityVocabEnabled` first; this helper is pure state.
 */
export function liftCapabilityDeclaration(
  sessionKey: string | null,
  payload: any
): CapabilityDeclaration | null {
  try {
    if (!sessionKey) return null;
    const state = ensureState(sessionKey);
    if (state.declaration) return state.declaration;

    const messages = payload?.messages;
    if (!Array.isArray(messages)) return null;
    let scanned = 0;
    for (let i = messages.length - 1; i >= 0 && scanned < LIFT_SCAN_DEPTH; i--) {
      const text = assistantText(messages[i]);
      if (text === null) continue;
      scanned++;
      const decl = parseCapabilityDeclaration(text);
      if (decl) {
        state.declaration = decl;
        return decl;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append the capability query to a collected (non-streaming) message — the
 * condensation rail, same append shape as the failover notice. Returns whether
 * the query was appended: false once the session has declared, once the ask cap
 * is reached, or while the gate is off. Never throws.
 */
export function appendCapabilityQueryToMessage(
  message: any,
  sessionKey: string | null,
  env: NodeJS.ProcessEnv
): boolean {
  try {
    if (!isCapabilityVocabEnabled(env)) return false;
    if (!sessionKey) return false;
    const state = ensureState(sessionKey);
    if (state.declaration) return false;
    if (state.asks >= capabilityQueryMaxAsks(env)) return false;
    state.asks++;

    const query = buildCapabilityQuery();
    if (!message || !Array.isArray(message.content)) return true; // ask consumed, nowhere to append
    for (let i = message.content.length - 1; i >= 0; i--) {
      const block = message.content[i];
      if (block?.type === "text" && typeof block.text === "string") {
        block.text += query;
        return true;
      }
    }
    message.content.push({ type: "text", text: query.replace(/^\n+/, "") });
    return true;
  } catch {
    return false;
  }
}

/** Test seam: drop the session channel state. */
export function resetCapabilityVocabForTests(): void {
  sessions.clear();
}

