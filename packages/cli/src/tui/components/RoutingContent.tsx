import type { ScrollBoxRenderable } from "@opentui/core";
/** @jsxImportSource @opentui/react */
import { useEffect, useRef } from "react";
import {
  type DefaultProviderSource,
  type ResolvedDefaultProvider,
  resolveDefaultProvider,
} from "../../default-provider.js";
import type { ClaudishProfileConfig, RoutingRules } from "../../profile-config.js";
import { hopLabel as candidateHopLabel } from "../../providers/routing-rules.js";
import { DETAIL_H, getChainProviders } from "../constants.js";
import { deriveProbeOutcome } from "../probe-outcome.js";
import { providerIsReady } from "../providers.js";
import { A, C } from "../theme.js";
import type {
  DroppedOutcome,
  MergedRule,
  Mode,
  ProbeEntry,
  ProbeMode,
  ProbeSummary,
} from "../types.js";

/**
 * What a dropped row says removed it. Total over the dropped outcomes, so a new
 * outcome cannot render as nothing.
 */
const DROPPED_TEXT: Record<DroppedOutcome, string> = {
  "no-credential": "no credential",
  "credential-unreadable": "credential could not be read",
  "not-served": "the account does not serve it",
  "excluded-by-membership": "not in the plan's membership",
  "excluded-by-content-use": "contributor id: content-use opt-in, type it exactly to use it",
};

/**
 * How a probe row's status reads: its glyph, its text, and its colour, read from
 * `C` at render time (the palette changes when the theme is detected).
 */
function rowStatusView(entry: ProbeEntry): { icon: string; color: string; text: string } {
  switch (entry.status) {
    case "unverified":
      return { icon: "◐", color: C.cyan, text: "native — not probed" };
    case "success":
      return {
        icon: "●",
        color: C.green,
        text: entry.ms !== undefined ? `${entry.ms}ms` : "success",
      };
    case "failed":
      return { icon: "✗", color: C.red, text: entry.error ?? "failed" };
    case "testing":
      return { icon: "◌", color: C.yellow, text: "testing..." };
    case "dropped":
      return {
        icon: "○",
        // A subscription the user holds whose key could not be read is a
        // warning: the request lands on a different hop.
        color: entry.outcome === "credential-unreadable" ? C.yellow : C.dim,
        text: entry.outcome ? `dropped · ${DROPPED_TEXT[entry.outcome]}` : "dropped",
      };
    case "skipped":
      return { icon: "·", color: C.dim, text: "not reached" };
    case "no_key":
      return { icon: "○", color: C.dim, text: "not configured, skipping" };
    case "pending":
      return { icon: "○", color: C.dim, text: "waiting" };
  }
}

/** A no-route hint, one line per row; the hint is multi-line text. */
function hintLines(hint: string | undefined): { id: string; text: string }[] {
  if (!hint) return [];
  return hint
    .split("\n")
    .filter((text) => text.trim().length > 0)
    .map((text, n) => ({ id: `hint-${n}`, text }));
}

// Format a chain as inline text: "kimi → openrouter"
function chainStr(chain: string[]): string {
  return chain.join(" → ");
}

/**
 * A rule's CHAIN cell, its colour read from `C` at render time. `[]` is a rule
 * too: the user's explicit no-route, which a join would render as nothing.
 */
function ruleChainCell(chain: string[], selected: boolean): { text: string; fg: string } {
  if (chain.length === 0) return { text: "no route", fg: C.yellow };
  return { text: chainStr(chain), fg: selected ? C.cyan : C.fgMuted };
}

/** How a header segment is coloured; {@link toneColor} maps it onto `C` at render time. */
export type HeaderTone = "title" | "value" | "warn" | "muted" | "dim";

/** One run of Routing-tab header text in one tone. */
export interface HeaderSegment {
  text: string;
  tone: HeaderTone;
}

export interface RoutingHeaderInput {
  /** The rules in the global config (or the `--config` file). */
  globalRules: RoutingRules;
  /** The rules in the project's `.claudish.json`. */
  localRules: RoutingRules;
  /** The fallback hop in force, and where it was set. */
  resolved: Pick<ResolvedDefaultProvider, "provider" | "source">;
}

/**
 * The Routing tab's header: the one routing fact that is global rather than per
 * model. Pure, as lines of toned segments the renderer colours.
 *
 * - **A `"*"` rule** decides every model no other rule matches, and a matched
 *   rule is used verbatim: the catalog is not consulted and no fallback hop is
 *   appended (`explainBareName`). The header says so and draws no fallback line,
 *   which would name a hop no request takes. The project file's `"*"` wins over
 *   the global one, because the project file overwrites the global one key by
 *   key (`loadRoutingRules`); a `"*"` whose value is not a list is no rule to the
 *   router, so it is none here either.
 * - **Otherwise** the fallback hop: the provider appended after everything the
 *   catalog maps, or none when it is disabled.
 */
export function routingHeaderLines({
  globalRules,
  localRules,
  resolved,
}: RoutingHeaderInput): HeaderSegment[][] {
  const catchAll = { ...globalRules, ...localRules }["*"];
  if (Array.isArray(catchAll)) {
    const scope = Object.hasOwn(localRules, "*") ? "project" : "global";
    return [
      [
        { text: ' "*" rule:', tone: "title" },
        { text: "  decides every model no other rule matches", tone: "muted" },
      ],
      [
        { text: "  → ", tone: "dim" },
        catchAll.length > 0
          ? { text: chainStr(catchAll), tone: "value" }
          : { text: "no route", tone: "warn" },
        { text: ` (${scope})`, tone: "muted" },
      ],
      [{ text: "  The catalog and the fallback hop are not used.", tone: "dim" }],
    ];
  }
  return fallbackHopLines(resolved);
}

/**
 * Where the header says the fallback hop was set, named as the user sets it.
 * `--default-provider` reaches this process as the env variable (index.ts
 * exports it), so a flag reads as `CLAUDISH_DEFAULT_PROVIDER` here.
 */
const FALLBACK_SOURCE_LABEL: Record<DefaultProviderSource, string> = {
  "cli-flag": "--default-provider",
  "env-var": "CLAUDISH_DEFAULT_PROVIDER",
  "config-file": "config",
  // Both route identically: "no preference" takes openrouter.
  "openrouter-key": "default",
  hardcoded: "default",
};

/** The header without a `"*"` rule: which provider occupies the last position, and why. */
function fallbackHopLines(resolved: RoutingHeaderInput["resolved"]): HeaderSegment[][] {
  const source = ` (${FALLBACK_SOURCE_LABEL[resolved.source]})`;
  const note: HeaderSegment[] = [
    {
      text: "  --default-provider overrides this for one run and the sessions it starts.",
      tone: "dim",
    },
  ];
  // An explicitly EMPTY string disables the hop; unset means "no preference"
  // and takes openrouter. `explainCatalogChain` draws the same line.
  if (resolved.provider === "") {
    return [
      [
        { text: " Fallback hop:", tone: "title" },
        { text: "  (none — a model the catalog maps to no provider gets no route)", tone: "muted" },
      ],
      [
        { text: "  → ", tone: "dim" },
        { text: "disabled", tone: "warn" },
        { text: `, set to ""${source}`, tone: "muted" },
      ],
      note,
    ];
  }
  return [
    [
      { text: " Fallback hop:", tone: "title" },
      { text: "  (tried last, after every provider the catalog maps)", tone: "muted" },
    ],
    [
      { text: "  → ", tone: "dim" },
      { text: resolved.provider, tone: "value" },
      { text: source, tone: "muted" },
    ],
    note,
  ];
}

/**
 * The fallback hop the header shows: `resolveDefaultProvider` over the env and
 * the config, the resolver the proxy and `route()` read, so the header cannot
 * name a hop a request does not take. `CLAUDISH_DEFAULT_PROVIDER=` (empty) beats
 * a config value, as it does for a request. A project `.claudish.json`
 * `defaultProvider` is not read, because no routing path reads it.
 */
export function resolveFallbackHop(
  config: ClaudishProfileConfig,
  env: NodeJS.ProcessEnv = process.env
): Pick<ResolvedDefaultProvider, "provider" | "source"> {
  return resolveDefaultProvider({ config, env });
}

/** A header tone's colour, read from `C` at render time, never snapshotted. */
function toneColor(tone: HeaderTone): string {
  switch (tone) {
    case "title":
      return C.blue;
    case "value":
      return C.cyan;
    case "warn":
      return C.yellow;
    case "muted":
      return C.fgMuted;
    case "dim":
      return C.dim;
  }
}

/** One scope's rules, from the rows the table shows (disk state, both scopes). */
function rulesOfScope(mergedRules: MergedRule[], scope: MergedRule["kind"]): RoutingRules {
  return Object.fromEntries(
    mergedRules.filter((rule) => rule.kind === scope).map((rule) => [rule.pattern, rule.chain])
  );
}

/** The native passthrough's hop label: it has no tier; Claude Code's own auth serves it. */
const NATIVE_HOP_LABEL = "Claude Code's own auth";

/**
 * A probe row's hop label: the native row's own auth, else routing-rules.ts's
 * `hopLabel` — the tier of the provider holding the hop, or "fallback" for the
 * fallback POSITION whichever provider holds it. `--probe` labels its hops with
 * the same function, and `describeRouteExplanation` words its "… first" with it.
 *
 * Derived, never a per-provider table. The map this replaces (19 hand-written
 * reasons) labelled OpenRouter "Fallback" wherever it stood in a chain, and any
 * provider it did not list read as its bare uid; a tier label is right for a
 * provider added tomorrow with no edit here.
 */
export function hopLabel(entry: Pick<ProbeEntry, "status" | "tier" | "position">): string {
  if (entry.status === "unverified") return NATIVE_HOP_LABEL;
  return candidateHopLabel(entry);
}

/**
 * The text of a probe row's second line: the provider's display name, which the
 * first line truncates (the three Alibaba products are the definitions' own
 * names: "Alibaba Coding Plan", "Alibaba Token Plan", "Alibaba PAYG"), then its
 * hop label.
 */
export function probeRowLabel(
  entry: Pick<ProbeEntry, "displayName" | "status" | "tier" | "position">
): string {
  return `${entry.displayName} · ${hopLabel(entry)}`;
}

/** The hop label's colour, read from `C` at render time, never snapshotted. */
function hopLabelColor(entry: ProbeEntry): string {
  if (entry.status === "dropped") return C.dim;
  if (entry.status === "unverified") return C.cyan;
  if (entry.position === "fallback") return C.yellow;
  switch (entry.tier) {
    case "subscription":
    case "dynamic-subscription":
      return C.green;
    case "native":
      return C.cyan;
    case "gateway":
      return C.blue;
    case "fallback":
      return C.yellow;
    default:
      return C.dim;
  }
}

interface RoutingContentProps {
  config: ClaudishProfileConfig;
  probeMode: ProbeMode;
  probeModel: string;
  probeResults: ProbeEntry[];
  /** The decision as a whole, from the same explainRoute call as the rows. */
  probeSummary: ProbeSummary | null;
  mode: Mode;
  routingPattern: string;
  chainSelected: Set<string>;
  chainOrder: string[];
  chainCursor: number;
  // NOTE: shared with the Providers tab. See "Known wart" in
  // ai-docs/app-tsx-split/walkthrough.md — switching tabs preserves the cursor
  // across two unrelated lists. Intentionally not fixed in this refactor.
  providerIndex: number;
  mergedRules: MergedRule[];
  width: number;
  contentH: number;
  isRoutingInput: boolean;
  /** When the picker is open as part of `e` on an existing rule, this is
   *  the rule's current scope ("global" or "project"). Used to label that
   *  option as "(current)" so the user can move scopes deliberately. Null
   *  when adding a new rule or overriding a default (no current scope). */
  editingExistingScope: "global" | "project" | null;
  /** Cursor index for the scope picker menu (0 = global, 1 = project). */
  routingScopeCursor: 0 | 1;
}

export function RoutingContent({
  config,
  probeMode,
  probeModel,
  probeResults,
  probeSummary,
  mode,
  routingPattern,
  chainSelected,
  chainOrder,
  chainCursor,
  providerIndex,
  mergedRules,
  width,
  contentH,
  isRoutingInput,
  editingExistingScope,
  routingScopeCursor,
}: RoutingContentProps) {
  // Refs for the two scrolling lists. We auto-scroll the cursor into view via
  // an effect; the scrollbox itself is unfocused so it doesn't capture our
  // useKeyboard arrow keys (cursor navigation is owned by App.tsx).
  const rulesScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const chainScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Each rule row is height={1}, so the cursor's pixel position == providerIndex.
  // Scroll only when the cursor row would be outside the current viewport, then
  // scroll to keep the row at least one line away from the top/bottom edge.
  useEffect(() => {
    const sb = rulesScrollRef.current;
    if (!sb || mergedRules.length === 0) return;
    const viewportH = sb.viewport.height;
    const top = sb.scrollTop;
    const bottom = top + viewportH;
    if (providerIndex < top) {
      sb.scrollTo({ x: 0, y: providerIndex });
    } else if (providerIndex >= bottom) {
      sb.scrollTo({ x: 0, y: providerIndex - viewportH + 1 });
    }
  }, [providerIndex, mergedRules.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `mode` deliberately re-triggers scroll-into-view on mode change
  useEffect(() => {
    const sb = chainScrollRef.current;
    if (!sb) return;
    const viewportH = sb.viewport.height;
    const top = sb.scrollTop;
    const bottom = top + viewportH;
    if (chainCursor < top) {
      sb.scrollTo({ x: 0, y: chainCursor });
    } else if (chainCursor >= bottom) {
      sb.scrollTo({ x: 0, y: chainCursor - viewportH + 1 });
    }
  }, [chainCursor, mode]);

  // Full-screen probe takes over when not idle
  const probeBoxH = contentH + DETAIL_H + 1; // spans content + detail area

  if (probeMode === "input") {
    return (
      <box
        height={probeBoxH}
        border
        borderStyle="single"
        borderColor={C.focusBorder}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        <text>
          <span fg={C.strong} attributes={A.bold}>
            {"Route Probe"}
          </span>
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>{"Enter a model name to trace its routing chain:"}</span>
        </text>
        <box flexDirection="row" height={1}>
          <text>
            <span fg={C.green} attributes={A.bold}>
              {"> "}
            </span>
            <span fg={C.strong}>{probeModel}</span>
            <span fg={C.cyan}>{"█"}</span>
          </text>
        </box>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>
            {"The probe shows the routing chain a request would use, then tests"}
          </span>
        </text>
        <text>
          <span fg={C.fgMuted}>
            {"each kept hop in order, stopping at the first success. Dropped"}
          </span>
        </text>
        <text>
          <span fg={C.fgMuted}>{"candidates are listed with the reason, never tested."}</span>
        </text>
      </box>
    );
  }

  if (probeMode === "running" || probeMode === "done") {
    const successEntry = probeResults.find((e) => e.status === "success");
    const outcome = deriveProbeOutcome(probeMode, probeResults);
    const allFailed = outcome === "no-route";
    const unverified = outcome === "unverified";
    const totalMs = successEntry?.ms;

    const statusBadge =
      outcome === "running"
        ? { text: "probing...", color: C.yellow }
        : outcome === "routed"
          ? { text: "routed", color: C.green }
          : unverified
            ? { text: "native — not probed", color: C.cyan }
            : { text: "no route", color: C.red };

    return (
      <box
        height={probeBoxH}
        border
        borderStyle="single"
        borderColor={probeMode === "running" ? C.focusBorder : C.blue}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        {/* Title row */}
        <box flexDirection="row" height={1}>
          <text>
            <span fg={C.strong} attributes={A.bold}>
              {probeMode === "done" ? "Probe: " : "Probing: "}
            </span>
            <span fg={C.cyan} attributes={A.bold}>
              {probeModel}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {probeMode === "done" && (
              <span fg={statusBadge.color} attributes={A.bold}>
                {outcome === "routed" ? "● " : unverified ? "◐ " : "✗ "}
                {statusBadge.text}
              </span>
            )}
            {probeMode === "running" && <span fg={C.yellow}>{"◌ probing..."}</span>}
          </text>
        </box>
        <text> </text>
        {/* Where the chain came from: describeRouteExplanation, the line
            --probe prints for the same decision. */}
        <text>
          <span fg={C.fgMuted}>{probeSummary?.line ?? ""}</span>
        </text>
        {probeSummary?.warnings.map((warning) => (
          <text key={`warning:${warning}`}>
            <span fg={C.yellow}>{`! ${warning}`}</span>
          </text>
        ))}
        {probeSummary?.notes.map((note) => (
          <text key={`note:${note}`}>
            <span fg={C.dim}>{note}</span>
          </text>
        ))}
        <text> </text>
        {/* Chain entries — 2 lines each, dropped candidates in place */}
        {probeResults.map((entry, idx) => {
          const isDropped = entry.status === "dropped";
          const isNotReached = entry.status === "skipped";
          const isSelected = entry.status === "success" && probeMode === "done";
          const status = rowStatusView(entry);
          const nameCol = entry.displayName.padEnd(18).substring(0, 18);

          return (
            <box key={`${idx}:${entry.provider}`} flexDirection="column">
              <text>
                <span fg={C.dim}>{`${idx + 1}. `}</span>
                <span
                  fg={isDropped || isNotReached ? C.dim : isSelected ? C.strong : C.fgMuted}
                  attributes={A.boldIf(isSelected)}
                >
                  {nameCol}
                </span>
                <span fg={C.dim}>{"  "}</span>
                <span fg={status.color} attributes={A.boldIf(entry.status === "success")}>
                  {status.icon} {status.text}
                </span>
                {isSelected && (
                  <span fg={C.green} attributes={A.bold}>
                    {" ← routed here"}
                  </span>
                )}
              </text>
              <text>
                {/* probeRowLabel's two parts, the label in its tier colour */}
                <span fg={C.dim}>{"    ↳ "}</span>
                <span fg={isDropped ? C.dim : C.fgMuted}>{entry.displayName}</span>
                <span fg={C.dim}>{" · "}</span>
                <span fg={hopLabelColor(entry)}>{hopLabel(entry)}</span>
              </text>
            </box>
          );
        })}
        {/* Result line */}
        {probeMode === "done" && (
          <>
            <text> </text>
            <text>
              {probeSummary?.noRoute ? (
                <>
                  <span fg={C.red} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.red}>{`✗ No route — ${probeSummary.noRoute.reason}`}</span>
                </>
              ) : allFailed ? (
                <>
                  <span fg={C.red} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.red}>{"✗ No provider could serve this model"}</span>
                </>
              ) : unverified ? (
                <>
                  <span fg={C.cyan} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.fgMuted}>
                    {"◐ Served natively on Claude Code's own auth — not probed here"}
                  </span>
                </>
              ) : (
                <>
                  <span fg={C.green} attributes={A.bold}>
                    {"Result: "}
                  </span>
                  <span fg={C.fgMuted}>{"Routed to "}</span>
                  <span fg={C.cyan} attributes={A.bold}>
                    {successEntry!.displayName}
                  </span>
                  {totalMs !== undefined && <span fg={C.fgMuted}>{` in ${totalMs}ms`}</span>}
                </>
              )}
            </text>
            {hintLines(probeSummary?.noRoute?.hint).map((line) => (
              <text key={line.id}>
                <span fg={C.dim}>{`  ${line.text}`}</span>
              </text>
            ))}
          </>
        )}
      </box>
    );
  }

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={C.blue}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* The one routing fact that is global rather than per model: the user's
          "*" rule when there is one, otherwise the fallback hop appended after
          the chain gathered from the cloud models catalog. There is no built-in
          rule table to compare either against. Each header `<text>` is pinned
          to height={1} so flex layout doesn't collapse them into the scrollbox
          below in tight viewports. */}
      {routingHeaderLines({
        globalRules: rulesOfScope(mergedRules, "global"),
        localRules: rulesOfScope(mergedRules, "project"),
        resolved: resolveFallbackHop(config),
      }).map((line) => (
        <text key={line.map((segment) => segment.text).join("")} height={1}>
          {line.map((segment) => (
            <span
              key={`${segment.tone}:${segment.text}`}
              fg={toneColor(segment.tone)}
              attributes={A.boldIf(segment.tone === "title")}
            >
              {segment.text}
            </span>
          ))}
        </text>
      ))}
      {/* Dashed section divider (" ─" units). Intentionally NOT a border:
          OpenTUI borders are solid, so a border={["top"]} box would render a
          continuous line and lose the dashed look. The count is derived from
          the real terminal width (minus paddingX) divided by 2 cells/unit —
          principled arithmetic, not a magic constant. */}
      <text height={1}>
        <span fg={C.dim}>{" ─".repeat(Math.max(1, Math.floor((width - 6) / 2)))}</span>
      </text>
      {/* Rules table. Header is title + a single dim hint about scope
          discovery. Hotkeys (a / e / d) live in the footer — don't repeat
          them inline. The scope picker shown by `a`/`e` is its own
          explainer, so we only need a discoverability nudge here. */}
      <text height={1}>
        <span fg={C.blue} attributes={A.bold}>
          {" Rules"}
        </span>
        {!isRoutingInput && (
          <>
            <span fg={C.dim}>{"   "}</span>
            <span fg={C.green}>{"global"}</span>
            <span fg={C.dim}>{" / "}</span>
            <span fg={C.cyan}>{"project"}</span>
            <span fg={C.dim}>{" scope chosen on "}</span>
            <span fg={C.green} attributes={A.bold}>
              {"a"}
            </span>
            <span fg={C.dim}>{" or "}</span>
            <span fg={C.green} attributes={A.bold}>
              {"e"}
            </span>
          </>
        )}
      </text>
      {!isRoutingInput && mergedRules.length === 0 && (
        <text height={1}>
          <span fg={C.fgMuted}>{" No rules. Press "}</span>
          <span fg={C.green} attributes={A.bold}>
            a
          </span>
          <span fg={C.fgMuted}>{" to add."}</span>
        </text>
      )}
      {mergedRules.length > 0 && !isRoutingInput && (
        <>
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"  "}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {"PATTERN         "}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {"SCOPE     "}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {"CHAIN"}
            </span>
          </text>
          {/* Native OpenTUI scrollbox. Unfocused: cursor navigation stays in
              App.tsx's useKeyboard handler; we sync scroll position via the
              effect above when providerIndex changes. */}
          <scrollbox
            ref={rulesScrollRef}
            scrollX={false}
            scrollY={true}
            focused={false}
            style={{ flexGrow: 1 }}
          >
            {mergedRules.map((rule, idx) => {
              const sel = idx === providerIndex;
              const isProject = rule.kind === "project";
              // Marker: project (▴ cyan) > global (• green). Every row is one
              // of the user's own rules and owns one scope — no shadowing in
              // the table. The dim "·" built-in row and the yellow "★"
              // override-of-a-default row are both gone, because the shipped
              // rules table they compared against no longer exists.
              const marker = isProject ? "▴" : "•";
              const markerFg = isProject ? C.cyan : C.green;
              // SCOPE column: explicit text, color-coded.
              const scopeText = isProject ? "project " : "global  ";
              const scopeFg = isProject ? C.cyan : C.green;
              const patFg = sel ? C.strong : C.cyan;
              const chainCell = ruleChainCell(rule.chain, sel);
              return (
                <box
                  key={`${rule.kind}-${rule.pattern}`}
                  height={1}
                  flexDirection="row"
                  backgroundColor={sel ? C.bgHighlight : C.bg}
                >
                  <text>
                    <span fg={markerFg} attributes={A.bold}>{` ${marker} `}</span>
                    <span fg={patFg} attributes={A.boldIf(sel)}>
                      {rule.pattern.padEnd(16).substring(0, 16)}
                    </span>
                    <span fg={scopeFg}>{scopeText}</span>
                    <span fg={chainCell.fg}>{chainCell.text}</span>
                  </text>
                </box>
              );
            })}
          </scrollbox>
        </>
      )}

      {/* Scope picker — menu-style navigation matching the chain selector
          and Providers tab. Cursor highlights the active row; ↑↓ moves it,
          Enter selects, Esc cancels. Letter shortcuts (g/p) still work as
          silent accelerators but the visible UI is the menu. */}
      {mode === "pick_routing_scope" && (
        <box flexDirection="column" paddingTop={1} paddingX={1} style={{ flexGrow: 1 }}>
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"Scope for "}
            </span>
            <span fg={C.strong} attributes={A.bold}>
              {routingPattern}
            </span>
            <span fg={C.blue} attributes={A.bold}>
              {":"}
            </span>
          </text>
          <text height={1}>
            <span fg={C.fgMuted}>{"  Choose where to save this rule. Project rules live in "}</span>
            <span fg={C.cyan}>{".claudish.json"}</span>
            <span fg={C.fgMuted}>{" and only apply when"}</span>
          </text>
          <text height={1}>
            <span fg={C.fgMuted}>{"  running claudish from inside this project."}</span>
          </text>
          <text height={1}> </text>
          {/* Menu rows with cursor highlight. Same pattern as
              add_routing_chain's provider rows: backgroundColor on
              the cursor row, bold on selected text. */}
          <box height={1} backgroundColor={routingScopeCursor === 0 ? C.bgHighlight : C.bg}>
            <text>
              <span fg={routingScopeCursor === 0 ? C.green : C.fgMuted} attributes={A.bold}>
                {routingScopeCursor === 0 ? " ▸ " : "   "}
              </span>
              <span fg={C.green} attributes={A.boldIf(routingScopeCursor === 0)}>
                {"global   "}
              </span>
              <span fg={C.fgMuted}>{"~/.claudish/config.json"}</span>
              {editingExistingScope === "global" && <span fg={C.dim}>{"   (current)"}</span>}
            </text>
          </box>
          <box height={1} backgroundColor={routingScopeCursor === 1 ? C.bgHighlight : C.bg}>
            <text>
              <span fg={routingScopeCursor === 1 ? C.cyan : C.fgMuted} attributes={A.bold}>
                {routingScopeCursor === 1 ? " ▸ " : "   "}
              </span>
              <span fg={C.cyan} attributes={A.boldIf(routingScopeCursor === 1)}>
                {"project  "}
              </span>
              <span fg={C.fgMuted}>{".claudish.json (walks up to git root)"}</span>
              {editingExistingScope === "project" && <span fg={C.dim}>{"   (current)"}</span>}
            </text>
          </box>
          <text height={1}> </text>
          <text height={1}>
            <span fg={C.dim}>{"  "}</span>
            <span fg={C.blue} attributes={A.bold}>
              {"↑↓"}
            </span>
            <span fg={C.dim}>{" navigate · "}</span>
            <span fg={C.green} attributes={A.bold}>
              {"Enter"}
            </span>
            <span fg={C.dim}>{" select · "}</span>
            <span fg={C.red} attributes={A.bold}>
              {"Esc"}
            </span>
            <span fg={C.dim}>{" cancel"}</span>
          </text>
        </box>
      )}

      {/* Input fields */}
      {mode === "add_routing_pattern" && (
        <box flexDirection="column">
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"Pattern "}
            </span>
            <span fg={C.dim}>{"(e.g. kimi-*, gpt-4o):"}</span>
          </text>
          <text height={1}>
            <span fg={C.green} attributes={A.bold}>
              {"> "}
            </span>
            <span fg={C.strong}>{routingPattern}</span>
            <span fg={C.cyan}>{"█"}</span>
          </text>
          <text height={1}>
            <span fg={C.green} attributes={A.bold}>
              Enter{" "}
            </span>
            <span fg={C.fgMuted}>to continue · </span>
            <span fg={C.red} attributes={A.bold}>
              Esc{" "}
            </span>
            <span fg={C.fgMuted}>to cancel</span>
          </text>
        </box>
      )}
      {mode === "add_routing_chain" && (
        <box flexDirection="column" style={{ flexGrow: 1 }}>
          <text height={1}>
            <span fg={C.blue} attributes={A.bold}>
              {"Select providers for "}
            </span>
            <span fg={C.strong} attributes={A.bold}>
              {routingPattern}
            </span>
            <span fg={C.dim}>{" (Space=toggle, 1-9=set position, Enter=save)"}</span>
          </text>
          {chainOrder.length > 0 && (
            <text height={1}>
              <span fg={C.fgMuted}>{"  Chain: "}</span>
              <span fg={C.cyan}>{chainOrder.join(" → ")}</span>
            </text>
          )}
          {/* Native OpenTUI scrollbox. Same focused=false pattern as the rules
              table — cursor navigation owned by App.tsx, scroll synced via the
              chainCursor effect above. */}
          <scrollbox
            ref={chainScrollRef}
            scrollX={false}
            scrollY={true}
            focused={false}
            style={{ flexGrow: 1 }}
          >
            {getChainProviders().map((prov, idx) => {
              const isCursor = idx === chainCursor;
              const isOn = chainSelected.has(prov.name);
              const pos = isOn ? chainOrder.indexOf(prov.name) + 1 : 0;
              const ready = providerIsReady(prov, config);
              const label = prov.displayName.padEnd(18).substring(0, 18);
              return (
                <box key={prov.name} height={1} backgroundColor={isCursor ? C.bgHighlight : C.bg}>
                  <text>
                    {isOn ? (
                      <span fg={C.green} attributes={A.bold}>{` [${pos}] `}</span>
                    ) : (
                      <span fg={C.dim}>{" [ ] "}</span>
                    )}
                    <span
                      fg={isCursor ? C.strong : ready ? C.fgMuted : C.dim}
                      attributes={A.boldIf(isCursor)}
                    >
                      {label}
                    </span>
                    {ready ? (
                      <span fg={C.green}>{" ●"}</span>
                    ) : (
                      <span fg={C.dim}>{prov.isLocal ? " ○ disabled" : " ○ no key"}</span>
                    )}
                  </text>
                </box>
              );
            })}
          </scrollbox>
        </box>
      )}
    </box>
  );
}
