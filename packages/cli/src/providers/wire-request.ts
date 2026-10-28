/**
 * Shape a request body from a connection's `wire` (catalog 3.7.0).
 *
 * The adapters convert messages and tools: that is protocol work and stays
 * theirs. Everything a connection decides — the output-limit field, the
 * reasoning encoding, the request mode and the speed tier — is written HERE,
 * from the wire alone, after every adapter and dialect has run. First every
 * field any of them may have emitted for those decisions is removed, so nothing
 * a name rule or a model-level field chose can survive onto the wire.
 *
 * Pure: no I/O, no catalog reads. The caller passes the resolved wire and the
 * user's choices, and logs the returned notes.
 */
import type {
  KnownWire,
  WireAssignment,
  WireControl,
  WireHeader,
  WireReasoningWarning,
  WireValue,
} from "./connection-wire.js";

/** Catalog effort names, lowest to highest. */
export const WIRE_EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type WireSpeed = "standard" | "fast" | "priority" | "flex" | "ultrafast";
export const WIRE_SPEEDS: readonly WireSpeed[] = [
  "standard",
  "fast",
  "priority",
  "flex",
  "ultrafast",
];
export type WireMode = "standard" | "pro";

export interface WireChoices {
  /** The catalog effort name the user asked for (request signal or `--effort`), if any. */
  effort?: string;
  /** The user turned reasoning off (`thinking.type: "disabled"`, effort `none`). */
  reasoningOff?: boolean;
  /** The request carries function tools. */
  hasTools?: boolean;
  /** The output limit to write at `wire.tokenParam`. */
  maxTokens?: number;
  /**
   * The catalog's `maxOutputTokens` for the connection's model. Written ONLY
   * when `maxTokens` is absent and the API requires a limit (the Messages API
   * requires `max_tokens`); every other API is left to the upstream's default.
   */
  catalogMaxOutputTokens?: number;
  /** `+pro` on the model spec, or pro turned on by `proOnUltracode`. */
  mode?: { value: WireMode; explicit: boolean };
  /**
   * `#<speed>` on the model spec (explicit), or Claude Code's `/fast` toggle,
   * which arrives as `speed: "fast"` in the request body (not explicit: a
   * connection without the tier answers at standard speed, with a note).
   */
  speed?: { value: WireSpeed; explicit: boolean };
  /** The user accepted a `served_model_changes` warning for this connection. */
  acceptServedModelChange?: boolean;
}

export interface WireShapeResult {
  /** Headers the wire requires alongside a field it wrote (append-comma merged by the caller). */
  headers: WireHeader[];
  /** One line per decision worth logging. */
  notes: string[];
  /** Set when an explicit user choice cannot be honoured on this connection: do not send. */
  refusal?: string;
  /** The effort name actually sent, after clamping. */
  sentEffort?: string;
  /**
   * Pointers written from the OWNER's connection because this connection's own
   * value is unknown (try in turn). A 400 that names one of them is answered by
   * resending without them; nothing else may be dropped on that basis.
   */
  borrowed: string[];
}

// ─── RFC 6901 JSON Pointer ─────────────────────────────────────────────────

function pointerTokens(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`invalid JSON pointer "${path}"`);
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Write `value` at `path` in `body`, creating intermediate objects and
 * overwriting whatever is at the target (or in the way of it).
 */
export function setPointer(body: Record<string, unknown>, path: string, value: unknown): void {
  const tokens = pointerTokens(path);
  if (tokens.length === 0) throw new Error("cannot replace the body root");
  let node: Record<string, unknown> = body;
  for (const token of tokens.slice(0, -1)) {
    const next = node[token];
    if (next === null || typeof next !== "object" || Array.isArray(next)) node[token] = {};
    node = node[token] as Record<string, unknown>;
  }
  node[tokens[tokens.length - 1]] = value;
}

/** Remove the value at `path`, then any objects left empty above it. */
export function deletePointer(body: Record<string, unknown>, path: string): void {
  const tokens = pointerTokens(path);
  const trail: Array<Record<string, unknown>> = [body];
  let node: unknown = body;
  for (const token of tokens.slice(0, -1)) {
    if (node === null || typeof node !== "object") return;
    node = (node as Record<string, unknown>)[token];
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    trail.push(node as Record<string, unknown>);
  }
  delete trail[trail.length - 1][tokens[tokens.length - 1]];
  for (let i = trail.length - 1; i > 0; i--) {
    if (Object.keys(trail[i]).length > 0) break;
    delete trail[i - 1][tokens[i - 1]];
  }
}

// ─── Stripping ─────────────────────────────────────────────────────────────

const TOKEN_LIMIT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

/**
 * Every field an adapter or dialect may emit for reasoning, mode or speed, on
 * any of the four APIs. Removed before the wire writes its own, so a value a
 * name rule chose never reaches the upstream.
 */
const DECISION_POINTERS = [
  "/reasoning_effort",
  "/reasoning",
  "/thinking",
  "/enable_thinking",
  "/thinking_budget",
  "/include_reasoning",
  "/output_config/effort",
  "/text/verbosity",
  "/generationConfig/thinkingConfig",
  "/service_tier",
  "/speed",
];

export function stripWireDecisions(body: Record<string, unknown>, api: KnownWire["api"]): void {
  if (api !== "gemini") for (const field of TOKEN_LIMIT_FIELDS) delete body[field];
  for (const path of DECISION_POINTERS) deletePointer(body, path);
}

// ─── Effort ────────────────────────────────────────────────────────────────

function effortRank(name: string): number {
  return (WIRE_EFFORT_ORDER as readonly string[]).indexOf(name);
}

/**
 * The published effort name nearest to `requested` (Jack's C2: clamp, never
 * refuse). Ties go to the higher level. A name outside the catalog vocabulary
 * is not clamped: it is returned only if published verbatim.
 */
export function clampEffort(requested: string, published: string[]): string | undefined {
  if (published.includes(requested)) return requested;
  const target = effortRank(requested);
  if (target < 0) return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of published) {
    const rank = effortRank(candidate);
    if (rank < 0) continue;
    const distance = Math.abs(rank - target);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && rank > effortRank(best))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// ─── Controls ──────────────────────────────────────────────────────────────

function applyControl(
  body: Record<string, unknown>,
  control: WireControl,
  requested: string,
  label: string,
  explicit: boolean,
  result: WireShapeResult
): void {
  if (control.status !== "supported") {
    const message = `${label} "${requested}" is not available on this connection (${control.status})`;
    if (explicit && requested !== "standard") result.refusal = message;
    else result.notes.push(message);
    return;
  }
  if (requested === "standard" && control.values.standard === undefined) {
    // "Standard means the default": leave the field out.
    result.notes.push(`${label} standard: field omitted (connection default)`);
    return;
  }
  const native = control.values[requested];
  if (native === undefined) {
    const offered = Object.keys(control.values).join(", ");
    const message = `${label} "${requested}" is not offered on this connection (offered: ${offered || "none"})`;
    if (explicit) result.refusal = message;
    else result.notes.push(message);
    return;
  }
  setPointer(body, control.path, native);
  result.headers.push(...control.headers);
  result.notes.push(
    `${label} ${requested}: ${control.path} = ${JSON.stringify(native)}${control.access !== "open" ? ` (access: ${control.access})` : ""}`
  );
}

// ─── Reasoning ─────────────────────────────────────────────────────────────

/** Writes into the body, recording each pointer when the values are borrowed. */
type PointerWriter = (path: string, value: unknown) => void;

function writeAssignments(put: PointerWriter, assignments: WireAssignment[]): void {
  for (const assignment of assignments) put(assignment.path, assignment.value);
}

function warningFor(
  warnings: WireReasoningWarning[] | undefined,
  part: "enable" | "disable"
): WireReasoningWarning | undefined {
  return warnings?.find((warning) => warning.part === part);
}

function applyReasoning(
  put: PointerWriter,
  reasoning: KnownWire["reasoning"],
  toolsWithReasoning: KnownWire["toolsWithReasoning"],
  choices: WireChoices,
  result: WireShapeResult
): void {
  if (reasoning.status !== "supported") {
    result.notes.push(`reasoning ${reasoning.status}: no reasoning field sent`);
    return;
  }

  // Tools plus reasoning on a Chat connection that serves them together only
  // over Responses: send the request without reasoning rather than switch APIs,
  // because the other API's fields are not part of this wire.
  if (choices.hasTools && toolsWithReasoning === "requires-responses") {
    result.notes.push(
      "tools with reasoning require Responses on this connection: reasoning not sent"
    );
    return;
  }

  let off = choices.reasoningOff === true;
  if (off) {
    if (Array.isArray(reasoning.disable)) {
      const warning = warningFor(reasoning.warnings, "disable");
      if (warning && !choices.acceptServedModelChange) {
        result.notes.push(
          `turning reasoning off is served by ${warning.servedModel} on this connection; reasoning kept on (${warning.code}; --accept-served-model allows it)`
        );
        off = false;
      } else {
        writeAssignments(put, reasoning.disable);
        result.notes.push(
          warning
            ? `reasoning off: served by ${warning.servedModel} (${warning.code}, accepted)`
            : "reasoning off"
        );
        return;
      }
    } else {
      result.notes.push(
        `reasoning cannot be turned off on this connection (disable ${reasoning.disable.status})`
      );
      off = false;
    }
  }

  if (Array.isArray(reasoning.enable)) {
    const warning = warningFor(reasoning.warnings, "enable");
    if (warning && !choices.acceptServedModelChange) {
      result.notes.push(
        `enabling reasoning is served by ${warning.servedModel} on this connection; enable not sent (${warning.code})`
      );
    } else {
      writeAssignments(put, reasoning.enable);
    }
  }

  const effort = reasoning.effort;
  if (!("path" in effort)) return;
  const published = Object.keys(effort.values);
  let name: string | undefined;
  if (choices.hasTools && toolsWithReasoning === "requires-effort-none") {
    name = published.includes("none") ? "none" : undefined;
    if (!name) {
      result.notes.push(
        "tools require effort none on this connection, which publishes none: effort omitted"
      );
      return;
    }
  } else if (choices.reasoningOff) {
    // Reasoning could not be turned off: the least published effort is the
    // closest honest answer to "off".
    name = clampEffort("none", published);
  } else if (choices.effort) {
    name = clampEffort(choices.effort, published);
    if (name !== choices.effort) {
      result.notes.push(
        `effort ${choices.effort} → ${name ?? "omitted"} (published: ${published.join(", ")})`
      );
    }
  } else if (typeof effort.default === "string") {
    name = effort.default;
  }
  if (!name) return;
  put(effort.path, effort.values[name] as WireValue);
  result.sentEffort = name;
}

// ─── The user's choices, read from Claude Code's request ──────────────────

/**
 * The catalog effort name and on/off intent Claude Code's request carries.
 *
 * `--effort` (pinned) wins. Then `output_config.effort`, the level Claude Code
 * sends. A legacy `thinking.budget_tokens` is translated into a catalog effort
 * name — the only use a budget ladder may still have; it never picks a wire
 * field. `thinking.type: "disabled"` or effort `none` means reasoning off.
 * `speed: "fast"` is Claude Code's `/fast` toggle; it is a request, never an
 * explicit choice, so a `#<speed>` marker still overrides it.
 */
export function wireChoicesFromClaudeRequest(
  claudeRequest: any,
  pinnedEffort?: string
): Pick<WireChoices, "effort" | "reasoningOff" | "hasTools" | "maxTokens" | "speed"> {
  let effort: string | undefined = pinnedEffort;
  if (!effort) {
    const level = claudeRequest?.output_config?.effort;
    if (typeof level === "string" && effortRank(level.toLowerCase()) >= 0)
      effort = level.toLowerCase();
  }
  if (!effort) {
    const budget = claudeRequest?.thinking?.budget_tokens;
    if (typeof budget === "number") {
      effort =
        budget <= 0
          ? "none"
          : budget < 4000
            ? "low"
            : budget < 16000
              ? "medium"
              : budget < 32000
                ? "high"
                : "xhigh";
    }
  }
  const reasoningOff = claudeRequest?.thinking?.type === "disabled" || effort === "none";
  return {
    effort: effort === "none" ? undefined : effort,
    reasoningOff,
    hasTools: Array.isArray(claudeRequest?.tools) && claudeRequest.tools.length > 0,
    maxTokens: typeof claudeRequest?.max_tokens === "number" ? claudeRequest.max_tokens : undefined,
    ...(claudeRequest?.speed === "fast" && { speed: { value: "fast", explicit: false } }),
  };
}

// ─── Output limit ──────────────────────────────────────────────────────────

/** APIs that reject a request with no output limit. */
const LIMIT_REQUIRED_APIS: ReadonlySet<KnownWire["api"]> = new Set(["anthropic-messages"]);

/**
 * The output limit to write: the request's own when it has one, unchanged.
 * Otherwise, only on an API that requires a limit, the catalog's
 * `maxOutputTokens` for this model. With no published ceiling nothing is
 * written: an unknown value is never replaced by a pinned number.
 */
function outputLimitToSend(
  wire: KnownWire,
  choices: WireChoices,
  result: WireShapeResult
): number | undefined {
  if (typeof choices.maxTokens === "number") return choices.maxTokens;
  if (!LIMIT_REQUIRED_APIS.has(wire.api)) return undefined;
  const ceiling = choices.catalogMaxOutputTokens;
  if (typeof ceiling === "number" && ceiling > 0) {
    result.notes.push(`request has no output limit: sent the catalog's maxOutputTokens ${ceiling}`);
    return ceiling;
  }
  result.notes.push(
    "request has no output limit and the catalog publishes no maxOutputTokens: none sent"
  );
  return undefined;
}

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Shape `body` from `wire`.
 *
 * `owner` is the wire of the model owner's own direct connection, when the
 * catalog knows it. It fills ONLY a sub-field this connection publishes as
 * `unknown`, ONLY on the same API (a different API's fields mean nothing here),
 * and never mode or speed, which carry entitlement and price. Every pointer so
 * written is returned in `borrowed`, so a 400 naming it is retried without it:
 * try in turn, never a silent guess (Jack's decision B1).
 */
export function shapeRequestFromWire(
  body: Record<string, unknown>,
  wire: KnownWire,
  choices: WireChoices,
  owner?: KnownWire
): WireShapeResult {
  const result: WireShapeResult = { headers: [], notes: [], borrowed: [] };
  stripWireDecisions(body, wire.api);
  const own: PointerWriter = (path, value) => setPointer(body, path, value);
  const borrow: PointerWriter = (path, value) => {
    setPointer(body, path, value);
    if (!result.borrowed.includes(path)) result.borrowed.push(path);
  };
  const sameApiOwner = owner && owner !== wire && owner.api === wire.api ? owner : undefined;

  const maxTokens = outputLimitToSend(wire, choices, result);
  if (typeof wire.tokenParam === "string") {
    if (typeof maxTokens === "number") body[wire.tokenParam] = maxTokens;
  } else if (wire.api !== "gemini") {
    // Only an UNKNOWN field is tried from the owner; `not_applicable` is an
    // answer (this connection takes no limit field), not a gap.
    if (
      wire.tokenParam.status === "unknown" &&
      sameApiOwner &&
      typeof sameApiOwner.tokenParam === "string" &&
      typeof maxTokens === "number"
    ) {
      borrow(`/${sameApiOwner.tokenParam}`, maxTokens);
      result.notes.push(
        `tokenParam ${wire.tokenParam.status}: trying the owner's ${sameApiOwner.tokenParam}`
      );
    } else {
      result.notes.push(`tokenParam ${wire.tokenParam.status}: no output limit sent`);
    }
  }

  if (wire.reasoning.status === "unknown" && sameApiOwner?.reasoning.status === "supported") {
    result.notes.push("reasoning unknown: trying the owner's encoding");
    const toolsWithReasoning =
      typeof wire.toolsWithReasoning === "string"
        ? wire.toolsWithReasoning
        : sameApiOwner.toolsWithReasoning;
    applyReasoning(borrow, sameApiOwner.reasoning, toolsWithReasoning, choices, result);
  } else {
    applyReasoning(own, wire.reasoning, wire.toolsWithReasoning, choices, result);
  }

  if (choices.mode) {
    const control = wire.reasoning.status === "supported" ? wire.reasoning.mode : wire.reasoning;
    applyControl(body, control, choices.mode.value, "mode", choices.mode.explicit, result);
  }
  if (choices.speed) {
    applyControl(body, wire.speed, choices.speed.value, "speed", choices.speed.explicit, result);
  }
  return result;
}

/**
 * The resend for a 4xx when the request carried fields borrowed from the
 * owner's connection: without the borrowed fields the error names (by the
 * pointer's last segment, e.g. `reasoning_effort`, `max_completion_tokens`),
 * or without all of them when a 400 rejects a parameter without naming which.
 * `null` when nothing was borrowed or the error is not about a parameter.
 * Returns a new payload; the original is not mutated.
 */
export function recoverBorrowedWireFields(
  payload: Record<string, unknown>,
  borrowed: string[],
  errorText: string
): { payload: Record<string, unknown>; note: string } | null {
  if (borrowed.length === 0 || !errorText) return null;
  // A field is named only as a whole identifier: `max_tokens` in "Unknown
  // parameter: 'max_tokens'", never `x` inside "exceeded".
  const named = borrowed.filter((path) =>
    pointerTokens(path).some((token) =>
      new RegExp(
        `(^|[^A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_])`
      ).test(errorText)
    )
  );
  const generic =
    /unknown|unrecognized|unsupported|not supported|not allowed|not permitted|extra (inputs|fields)|invalid (param|field|argument)/i.test(
      errorText
    );
  const drop = named.length > 0 ? named : generic ? borrowed : [];
  if (drop.length === 0) return null;
  const next = structuredClone(payload);
  for (const path of drop) deletePointer(next, path);
  return {
    payload: next,
    note: `dropped ${drop.join(", ")} (borrowed from the owner's connection; this connection's value is unknown)`,
  };
}

/**
 * Merge wire headers into a header map: each value is appended to an existing
 * comma-separated header, never duplicated, never replacing what is there
 * (Anthropic fast mode's beta token sits next to the OAuth beta).
 */
export function mergeWireHeaders(headers: Record<string, string>, extra: WireHeader[]): void {
  for (const header of extra) {
    const key =
      Object.keys(headers).find((name) => name.toLowerCase() === header.name.toLowerCase()) ??
      header.name;
    const existing = headers[key];
    if (!existing) {
      headers[key] = header.value;
      continue;
    }
    const tokens = existing.split(",").map((token) => token.trim());
    if (!tokens.includes(header.value)) headers[key] = `${existing},${header.value}`;
  }
}
