/**
 * The `compaction` settings: claudish's own context compaction.
 *
 * ```jsonc
 * "compaction": {
 *   "enabled": false,      // opt-in: it costs money and sends tool output to Anthropic
 *   "model": "haiku",      // a tier alias or an exact claude-* id
 *   "toolOutputs": { "enabled": true, "minTokens": 4000, "timeoutMs": 20000, "maxRatio": 0.6,
 *                    "skipTools": ["Read"] },
 *   "history": { "enabled": true, "precomputeAt": 0.6, "applyAt": 0.75 }
 * }
 * ```
 *
 * `enabled` follows flag > `CLAUDISH_COMPACTION` env > global config > false.
 * The rest is read from the global config (or the `--config` file) only.
 *
 * The model is never a model-id literal: the default is the tier alias
 * `haiku`, which resolves through the same resolver the advisor uses for a
 * Claude member (`claudeAdvisorModelFor`): the catalog's alias table, then the
 * newest `claude-haiku-*` id the catalog lists.
 */

import { type CompactionConfig, CompactionConfigSchema } from "../config-schema.js";
import { claudeAdvisorModelFor } from "../handlers/advisor-claude-route.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { resolveConnection } from "../providers/connection-resolver.js";
import type { WireValue } from "../providers/connection-wire.js";
import type { HistoryPolicy } from "./swap-policy.js";

/** The environment variable that switches compaction on (`1`) or off (`0`). */
export const COMPACTION_ENV_VAR = "CLAUDISH_COMPACTION";

export interface ToolOutputSettings {
  enabled: boolean;
  /** Smallest output compressed, estimated as characters / 4. */
  minTokens: number;
  /** Total wait for all compressions of one request. */
  timeoutMs: number;
  /** A result longer than this fraction of the original is discarded. */
  maxRatio: number;
  /**
   * Tool names whose results are never compressed nor recorded. Empty skips
   * nothing. The default skips `Read`: an Edit needs the file's exact text.
   */
  skipTools: string[];
}

export interface HistorySettings {
  enabled: boolean;
  /**
   * When a ready summary is swapped in (`swap-policy.ts`): `threshold` at
   * `applyAt`; `early` the same rule with earlier default thresholds; `cost`
   * when the swap pays for itself before Claude Code compacts on its own.
   * The policy sets the default thresholds; values written in the block win.
   * Absent means `threshold`.
   */
  policy?: HistoryPolicy;
  /** Fraction of the effective limit at which a summary is prepared. */
  precomputeAt: number;
  /**
   * Fraction of the effective limit at which a ready summary is applied. The
   * default, 0.75, sits below the point near 0.8 where Claude Code compacts on
   * its own, so a ready summary is sent before Claude Code compacts.
   */
  applyAt: number;
  /** The `topic` policy's settings. Absent means `DEFAULT_TOPIC_SETTINGS`. */
  topic?: TopicSettings;
}

/** How the `topic` policy decides that a new human turn changed the topic (`topic.ts`). */
export interface TopicSettings {
  /** `haiku`: the compaction model; `embed`: a local Ollama embedding model. */
  decider: "haiku" | "embed";
  /** No topic decision below this many tokens of history; summaries start here too. */
  floorTokens: number;
  /** A new topic below this confidence holds. */
  minConfidence: number;
  /** `embed`: a highest cosine similarity below this is a new topic. */
  similarityBelow: number;
  /** The longest a request waits for the decision; a timeout holds. */
  timeoutMs: number;
  /** `embed`: the Ollama model, served at `OLLAMA_BASE_URL` / `OLLAMA_HOST`. */
  embedModel: string;
}

export const DEFAULT_TOPIC_SETTINGS: Readonly<TopicSettings> = Object.freeze({
  decider: "haiku",
  floorTokens: 30_000,
  minConfidence: 0.7,
  similarityBelow: 0.5,
  timeoutMs: 5000,
  embedModel: "nomic-embed-text",
});

export interface CompactionSettings {
  enabled: boolean;
  /** As written: a tier alias or a `claude-*` id. Resolved by `resolveCompactionModel`. */
  model: string;
  toolOutputs: ToolOutputSettings;
  history: HistorySettings;
}

/** The tier alias the model defaults to. An alias, never an id. */
export const DEFAULT_COMPACTION_MODEL = "haiku";

export const DEFAULT_COMPACTION_SETTINGS: Readonly<CompactionSettings> = Object.freeze({
  enabled: false,
  model: DEFAULT_COMPACTION_MODEL,
  toolOutputs: Object.freeze({
    enabled: true,
    minTokens: 4000,
    timeoutMs: 20000,
    maxRatio: 0.6,
    skipTools: Object.freeze(["Read"]) as unknown as string[],
  }),
  history: Object.freeze({
    enabled: true,
    policy: "threshold" as HistoryPolicy,
    precomputeAt: 0.6,
    applyAt: 0.75,
  }),
});

/** The default thresholds of each history policy. `cost` reads only `precomputeAt`. */
export const POLICY_THRESHOLDS: Readonly<
  Record<HistoryPolicy, { precomputeAt: number; applyAt: number }>
> = Object.freeze({
  threshold: { precomputeAt: 0.6, applyAt: 0.75 },
  early: { precomputeAt: 0.5, applyAt: 0.7 },
  cost: { precomputeAt: 0.5, applyAt: 0.75 },
  topic: { precomputeAt: 0.6, applyAt: 0.75 },
});

/**
 * `CLAUDISH_COMPACTION` as a switch: `1`/`true`/`on`/`yes` → true,
 * `0`/`false`/`off`/`no` → false (any case, trimmed). Anything else, including
 * unset or empty, states nothing and returns undefined.
 */
export function parseCompactionEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return undefined;
}

/** The outcome of reading one `compaction` block. */
export interface CompactionBlockReading {
  /** The block's own `enabled`, when the block is valid and states one. */
  enabled?: boolean;
  /** The settings the block yields, defaults filled in. `enabled` here is the block's or false. */
  settings: CompactionSettings;
  /** Set when the block was present but invalid; the block is then ignored. */
  warning?: string;
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length > 0 ? `compaction.${path.map(String).join(".")}` : "compaction";
}

/**
 * Read a `compaction` block from a loaded config. Absent → defaults. Present
 * but invalid → defaults plus a warning naming the key; the block states
 * nothing, so it never turns compaction on.
 */
export function readCompactionBlock(block: unknown): CompactionBlockReading {
  const defaults = cloneDefaults();
  if (block === undefined) return { settings: defaults };
  const parsed = CompactionConfigSchema.safeParse(block);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issuePath(issue.path) : "compaction";
    const why = issue?.message ?? "not a valid compaction block";
    return {
      settings: defaults,
      warning: `${where} is not accepted (${why}); the compaction block is ignored`,
    };
  }
  const data = parsed.data;
  const history = mergeHistory(defaults.history, data.history ?? {});
  // A block that names only one of the two thresholds must still leave them ordered.
  if (history.precomputeAt >= history.applyAt) {
    return {
      settings: defaults,
      warning:
        "compaction.history.precomputeAt must be below compaction.history.applyAt; the compaction block is ignored",
    };
  }
  return {
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    settings: {
      enabled: data.enabled ?? false,
      model: data.model?.trim() || defaults.model,
      toolOutputs: { ...defaults.toolOutputs, ...definedOnly(data.toolOutputs ?? {}) },
      history,
    },
  };
}

/**
 * The history settings a block yields: the defaults, then the policy's
 * thresholds, then what the block wrote. The topic settings are filled in
 * under the `topic` policy or when the block writes any.
 */
function mergeHistory(
  defaults: HistorySettings,
  block: NonNullable<CompactionConfig["history"]>
): HistorySettings {
  const { topic: writtenTopic, ...written } = definedOnly(block);
  const policy = written.policy ?? defaults.policy ?? "threshold";
  const topic =
    policy === "topic" || writtenTopic
      ? { ...DEFAULT_TOPIC_SETTINGS, ...definedOnly(writtenTopic ?? {}) }
      : undefined;
  return {
    ...defaults,
    ...POLICY_THRESHOLDS[policy],
    ...written,
    policy,
    ...(topic ? { topic } : {}),
  };
}

function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function cloneDefaults(): CompactionSettings {
  return {
    enabled: DEFAULT_COMPACTION_SETTINGS.enabled,
    model: DEFAULT_COMPACTION_SETTINGS.model,
    toolOutputs: {
      ...DEFAULT_COMPACTION_SETTINGS.toolOutputs,
      skipTools: [...DEFAULT_COMPACTION_SETTINGS.toolOutputs.skipTools],
    },
    history: { ...DEFAULT_COMPACTION_SETTINGS.history },
  };
}

/**
 * Whether compaction is on: flag > env > the config block's `enabled` > false.
 * `flag` is undefined when neither `--compaction` nor `--no-compaction` was given.
 */
export function resolveCompactionEnabled(input: {
  flag?: boolean;
  env?: string;
  block?: unknown;
}): boolean {
  if (input.flag !== undefined) return input.flag;
  const fromEnv = parseCompactionEnv(input.env);
  if (fromEnv !== undefined) return fromEnv;
  return readCompactionBlock(input.block).enabled ?? false;
}

/**
 * The settings for this launch: the global config's block with defaults
 * filled in, and `enabled` set to the already-resolved switch.
 */
export function resolveCompactionSettings(
  config: Pick<ClaudishProfileConfig, "compaction">,
  enabled: boolean
): { settings: CompactionSettings; warning?: string } {
  const reading = readCompactionBlock(config.compaction);
  return {
    settings: { ...reading.settings, enabled },
    ...(reading.warning ? { warning: reading.warning } : {}),
  };
}

/**
 * The launch's settings, as `resolveCompactionSettings`, with its warning sent
 * to `warn` (prefixed `[compaction] `) whether or not compaction is enabled: a
 * block the user wrote and claudish cannot read is reported on every launch,
 * also when that block was meant to turn compaction on and so did not.
 */
export function compactionStartupSettings(
  config: Pick<ClaudishProfileConfig, "compaction">,
  enabled: boolean,
  warn: (message: string) => void
): CompactionSettings {
  const { settings, warning } = resolveCompactionSettings(config, enabled);
  if (warning) warn(`[compaction] ${warning}`);
  return settings;
}

/** The Anthropic model id compaction calls, or why there is none. */
export type CompactionModel =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: string;
      /** True when a tier alias found no id because the catalog holds none yet. */
      unresolvedAlias?: boolean;
    };

/**
 * Resolve the configured model to an Anthropic model id. A tier alias resolves
 * through the catalog (`claudeAdvisorModelFor`); an exact id passes through. A
 * name that is not a Claude model id after resolution is refused: compaction
 * signs with an Anthropic API key at the fixed Anthropic endpoint only.
 */
export function resolveCompactionModel(model: string): CompactionModel {
  const resolved = claudeAdvisorModelFor(model);
  if (resolved.refused) {
    return {
      ok: false,
      reason: resolved.reason,
      ...("cause" in resolved && resolved.cause === "unresolved-alias"
        ? { unresolvedAlias: true }
        : {}),
    };
  }
  const id = resolved.id.trim();
  if (!/^claude-[a-z0-9][a-z0-9.-]*$/i.test(id)) {
    return {
      ok: false,
      reason: `"${model}" is not a Claude model id; compaction.model takes a tier alias (haiku, sonnet, opus) or a claude-* id`,
    };
  }
  return { ok: true, id };
}

/** The catalog effort level compaction calls ask for. */
export const COMPACTION_EFFORT = "low";

/**
 * The `output_config.effort` value to send to `model`, or undefined to send
 * none. Read from the catalog wire of the model's Claude API connection: the
 * native value of `COMPACTION_EFFORT` when the wire publishes effort at
 * `/output_config/effort`. A model whose effort is unknown, published at
 * another path, or without that level gets no effort field, because a model
 * that does not take the field answers 400.
 */
export function compactionEffort(
  model: string,
  resolve: typeof resolveConnection = resolveConnection
): WireValue | undefined {
  const resolved = resolve("anthropic", model);
  if (!resolved.ok) return undefined;
  const wire = resolved.connection.wire;
  if (wire.status !== "known" || wire.reasoning.status !== "supported") return undefined;
  const effort = wire.reasoning.effort;
  if (!("path" in effort) || effort.path !== "/output_config/effort") return undefined;
  return Object.hasOwn(effort.values, COMPACTION_EFFORT)
    ? effort.values[COMPACTION_EFFORT]
    : undefined;
}
