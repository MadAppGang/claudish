/**
 * A `ViewItem` as a terminal front end shows it: herdr's agent state, display name, title, state
 * labels and sidebar tokens. Pure and front-end neutral, so the Herdr.app mod can bundle it too.
 *
 * herdr takes four states from a reporter (`idle`, `working`, `blocked`, `unknown`) and derives
 * `done` itself: idle after working, until the pane is seen. So a finished turn reports `idle`.
 */

import type { ViewItem } from "../pane/view-contract.js";

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

/** herdr caps title, display name, labels and token values at 80 characters after trimming. */
export const HERDR_TEXT_MAX = 80;
/** a report may name at most 16 token keys */
export const HERDR_TOKEN_KEYS_MAX = 16;

export interface HerdrMetadata {
  display_agent: string;
  title: string;
  state_labels: Partial<Record<"idle" | "working" | "blocked" | "done" | "unknown", string>>;
  /** a key with null clears it on the pane */
  tokens: Record<string, string | null>;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
  "TIMEOUT",
  "CANCELLED",
  "EMPTY",
]);

/** One line, no control characters, at most `max` characters. */
export function clipText(s: string, max: number = HERDR_TEXT_MAX): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  if ([...out].length <= max) return out;
  return `${[...out].slice(0, max - 1).join("")}…`;
}

export function herdrAgentState(item: ViewItem): HerdrAgentState {
  if (item.kind === "replay") return "idle";
  if (item.state === "STARTING" || item.state === "RUNNING") return "working";
  if (item.state === "AWAITING_PERMISSION") return "blocked";
  if (item.state === "AWAITING_INPUT")
    return item.activity === "AskUserQuestion" ? "blocked" : "idle";
  if (TERMINAL_STATES.has(item.state)) return "idle";
  return "unknown";
}

/** `openai-codex@gpt-6.1-sol` → `gpt-6.1-sol`: the part a narrow label can afford. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "claudish";
  const at = model.lastIndexOf("@");
  return at >= 0 && at < model.length - 1 ? model.slice(at + 1) : model;
}

function compactCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function tokensText(tokensIn: number | null, tokensOut: number | null): string | null {
  if (tokensIn === null && tokensOut === null) return null;
  return `in ${compactCount(tokensIn ?? 0)} / out ${compactCount(tokensOut ?? 0)}`;
}

function stateLabels(item: ViewItem): HerdrMetadata["state_labels"] {
  if (item.kind === "replay") return { idle: item.final ? "replay ended" : "replay" };
  const labels: HerdrMetadata["state_labels"] = {};
  if (item.state === "STARTING") labels.working = "starting";
  else if (item.activity) labels.working = clipText(item.activity);
  if (item.state === "AWAITING_PERMISSION")
    labels.blocked = clipText(item.activity ? `permission: ${item.activity}` : "permission");
  else if (item.activity === "AskUserQuestion") labels.blocked = "question";
  if (TERMINAL_STATES.has(item.state)) {
    labels.idle = clipText(item.reason ? `${item.state} (${item.reason})` : item.state);
    labels.done = labels.idle;
  } else if (item.state === "AWAITING_INPUT") labels.idle = "awaiting input";
  return labels;
}

/**
 * Display name `claudish · <model>`, the title (the prompt summary, or the model when
 * `titleMode` is "model"), state labels, and tokens for `$name` sidebar rows.
 * Every token key is always named, so a value that went away is cleared on the pane.
 */
export function herdrMetadata(
  item: ViewItem,
  options: { titleMode?: "summary" | "model" } = {}
): HerdrMetadata {
  const model = shortModel(item.model);
  const summary = item.kind === "replay" ? null : item.prompt_summary;
  const title =
    options.titleMode === "model" || !summary ? model : clipText(summary, HERDR_TEXT_MAX);
  const tokens: Record<string, string | null> = {
    model: clipText(model),
    activity: null,
    tokens: null,
    cost: null,
    turns: null,
    slot: null,
    run: null,
    subagents: null,
  };
  if (item.kind !== "replay") {
    tokens.activity = item.activity ? clipText(item.activity) : null;
    tokens.tokens = tokensText(item.tokens_in, item.tokens_out);
    tokens.cost = item.cost_usd === null ? null : `$${item.cost_usd.toFixed(2)}`;
    tokens.turns = String(item.turns_completed);
    const running = item.subagents.filter((s) => s.state === "running").length;
    tokens.subagents = running > 0 ? String(running) : null;
    if (item.kind === "team_slot") {
      tokens.slot = clipText(item.slot);
      tokens.run = clipText(item.run_id, 32);
    }
  }
  return {
    display_agent: clipText(`claudish · ${model}`),
    title: clipText(title),
    state_labels: stateLabels(item),
    tokens,
  };
}

/**
 * herdr-core's status words. Unlike herdr terminal, hc takes `done` and `error` from the program
 * itself, so a finished session says so instead of reading idle.
 */
export type HcState = "idle" | "working" | "done" | "blocked" | "error";

export interface HcStatus {
  state: HcState;
  kind?: "permission" | "question";
  /** the prompt summary, or the model (`titleMode: "model"`) */
  title: string;
  /** the label of the current state: the tool in use, what it waits for, how it ended */
  msg: string;
}

const HC_ERROR_STATES: ReadonlySet<string> = new Set(["FAILED", "TIMEOUT"]);

function hcState(item: ViewItem): Pick<HcStatus, "state" | "kind"> {
  if (item.kind === "replay") return { state: "idle" };
  if (HC_ERROR_STATES.has(item.state)) return { state: "error" };
  if (TERMINAL_STATES.has(item.state)) return { state: "done" };
  const herdr = herdrAgentState(item);
  if (herdr === "blocked")
    return {
      state: "blocked",
      kind: item.state === "AWAITING_PERMISSION" ? "permission" : "question",
    };
  if (herdr === "working") return { state: "working" };
  return { state: "idle" };
}

/** A `ViewItem` as an hc status report (OSC 7501) and as the Herdr.app mod's row status. */
export function hcStatus(
  item: ViewItem,
  options: { titleMode?: "summary" | "model" } = {}
): HcStatus {
  const meta = herdrMetadata(item, options);
  const { state, kind } = hcState(item);
  // a terminal state's label sits under `done` (and `idle`) in herdr's labels
  const labelKey = state === "error" ? "done" : state;
  const msg = meta.state_labels[labelKey] ?? "";
  return { state, ...(kind ? { kind } : {}), title: meta.title, msg };
}

/** The tokens `claudish herdr rows` puts into the sidebar rows; each is a `$name` above. */
export const SIDEBAR_TOKENS = ["model", "activity", "tokens"] as const;
