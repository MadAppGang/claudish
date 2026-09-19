import type { ScrollBoxRenderable } from "@opentui/core";
/** @jsxImportSource @opentui/react */
import { useEffect, useRef } from "react";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import { DEFAULT_ROUTING_RULES } from "../../providers/default-routing-rules.js";
import { DETAIL_H, getChainProviders } from "../constants.js";
import { deriveProbeOutcome } from "../probe-outcome.js";
import { providerIsReady } from "../providers.js";
import { A, C } from "../theme.js";
import type { MergedRule, Mode, ProbeEntry, ProbeMode } from "../types.js";

// Format a chain as inline text: "kimi → openrouter"
function chainStr(chain: string[]): string {
  return chain.join(" → ");
}

// Reasons shown beneath each probe entry
const PROVIDER_REASONS: Record<string, string> = {
  litellm: "LiteLLM proxy",
  "opencode-zen": "Free tier (OpenCode Zen)",
  "opencode-zen-go": "Zen Go plan",
  kimi: "Native Kimi API",
  "kimi-coding": "Kimi Coding Plan",
  minimax: "Native MiniMax API",
  "minimax-coding": "MiniMax Coding Plan",
  glm: "Native GLM API",
  "glm-coding": "GLM Coding Plan",
  "qwen-token-plan": "Alibaba Token Plan",
  google: "Direct Gemini API",
  openai: "Direct OpenAI API",
  "openai-codex": "OpenAI Codex (Responses API)",
  zai: "Z.AI API",
  ollamacloud: "Cloud Ollama",
  vertex: "Vertex AI Express",
  openrouter: "Fallback: 580+ models",
};

interface RoutingContentProps {
  config: ClaudishProfileConfig;
  probeMode: ProbeMode;
  probeModel: string;
  probeResults: ProbeEntry[];
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
          <span fg={C.dim}>{"Examples: kimi-k2  deepseek-r1  gemini-2.0-flash  gpt-4o"}</span>
        </text>
        <text> </text>
        <text>
          <span fg={C.fgMuted}>
            {"The probe resolves the fallback chain and tests each provider's"}
          </span>
        </text>
        <text>
          <span fg={C.fgMuted}>{"API key in order, stopping at the first success."}</span>
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
        {/* Route source */}
        <text>
          <span fg={C.fgMuted}>
            {probeResults[0]?.reason ?? `Chain (${probeResults.length} providers):`}
          </span>
        </text>
        <text> </text>
        {/* Chain entries — 2 lines each */}
        {probeResults.map((entry, idx) => {
          const isNoKey = entry.status === "no_key";
          const isNotReached = entry.status === "skipped";
          const isSelected = entry.status === "success" && probeMode === "done";

          const statusIcon =
            entry.status === "unverified"
              ? "◐"
              : entry.status === "success"
                ? "●"
                : entry.status === "failed"
                  ? "✗"
                  : entry.status === "testing"
                    ? "◌"
                    : isNoKey
                      ? "○"
                      : isNotReached
                        ? "·"
                        : "○";

          const statusColor =
            entry.status === "unverified"
              ? C.cyan
              : entry.status === "success"
                ? C.green
                : entry.status === "failed"
                  ? C.red
                  : entry.status === "testing"
                    ? C.yellow
                    : C.dim;

          const nameCol = entry.displayName.padEnd(18).substring(0, 18);

          const statusText =
            entry.status === "unverified"
              ? "native — not probed"
              : entry.status === "success"
                ? entry.ms !== undefined
                  ? `${entry.ms}ms`
                  : "success"
                : entry.status === "failed"
                  ? (entry.error ?? "failed")
                  : entry.status === "testing"
                    ? "testing..."
                    : isNoKey
                      ? "not configured, skipping"
                      : isNotReached
                        ? "not reached"
                        : "waiting";

          const reason = PROVIDER_REASONS[entry.provider] ?? entry.provider;

          return (
            <box key={entry.provider} flexDirection="column">
              <text>
                <span fg={C.dim}>{`${idx + 1}. `}</span>
                <span
                  fg={isNoKey ? C.dim : isSelected ? C.strong : isNotReached ? C.dim : C.fgMuted}
                  attributes={A.boldIf(isSelected)}
                >
                  {nameCol}
                </span>
                <span fg={C.dim}>{"  "}</span>
                <span fg={statusColor} attributes={A.boldIf(entry.status === "success")}>
                  {statusIcon} {statusText}
                </span>
                {isSelected && (
                  <span fg={C.green} attributes={A.bold}>
                    {" ← routed here"}
                  </span>
                )}
              </text>
              <text>
                <span fg={C.dim}>{"    ↳ "}</span>
                <span fg={isNoKey ? C.dim : C.fgMuted}>{reason}</span>
              </text>
            </box>
          );
        })}
        {/* Result line */}
        {probeMode === "done" && (
          <>
            <text> </text>
            <text>
              {allFailed ? (
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
      {/* Catch-all default — the only "global" default that actually exists.
          Per-pattern defaults (gpt-* → codex/openai/openrouter, etc.) are
          visible in the rule table below alongside any user overrides.
          Each header `<text>` is pinned to height={1} so flex layout doesn't
          collapse them into the scrollbox below in tight viewports. */}
      <text height={1}>
        <span fg={C.blue} attributes={A.bold}>
          {" Catch-all default:"}
        </span>
        <span fg={C.fgMuted}>{"  (used for any model not matched by a rule)"}</span>
      </text>
      <text height={1}>
        <span fg={C.dim}>{"  * "}</span>
        <span fg={C.dim}>{"→ "}</span>
        <span fg={C.cyan}>
          {config.defaultProvider && config.defaultProvider.length > 0
            ? config.defaultProvider
            : (DEFAULT_ROUTING_RULES["*"]?.[0] ?? "openrouter")}
        </span>
        {(() => {
          const builtIn = DEFAULT_ROUTING_RULES["*"]?.[0] ?? "openrouter";
          const override = config.defaultProvider;
          const hasOverride = !!(override && override.length > 0);
          const overridesBuiltIn = hasOverride && override !== builtIn;
          return overridesBuiltIn ? (
            <span fg={C.fgMuted}>{`  (defaultProvider — overrides built-in '${builtIn}')`}</span>
          ) : (
            <span fg={C.fgMuted}>{"  (built-in)"}</span>
          );
        })()}
      </text>
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
              const isDefault = rule.kind === "default";
              const isProject = rule.kind === "project";
              // Marker priority: project (▴ cyan) > override (★ yellow) >
              // user (• green) > default (· dim). Each row owns one scope
              // — no shadowing in the table — so override + project never
              // collide on the same row.
              let marker: string;
              let markerFg: string;
              if (isDefault) {
                marker = "·";
                markerFg = C.dim;
              } else if (isProject) {
                marker = "▴";
                markerFg = C.cyan;
              } else if (rule.overridesDefault) {
                marker = "★";
                markerFg = C.yellow;
              } else {
                marker = "•";
                markerFg = C.green;
              }
              // SCOPE column: explicit text, color-coded.
              //   default → "—" (dim)
              //   global  → "global" (green)
              //   project → "project" (cyan)
              let scopeText: string;
              let scopeFg: string;
              if (isDefault) {
                scopeText = "—       ";
                scopeFg = C.dim;
              } else if (isProject) {
                scopeText = "project ";
                scopeFg = C.cyan;
              } else {
                scopeText = "global  ";
                scopeFg = C.green;
              }
              // Pattern column: white when selected, cyan when user, dim when default.
              const patFg = sel ? C.strong : isDefault ? C.fgMuted : C.cyan;
              // Chain column: cyan when selected, fgMuted when user, dim when default.
              const chainFg = sel ? C.cyan : isDefault ? C.dim : C.fgMuted;
              return (
                <box
                  key={`${rule.kind}-${rule.pattern}`}
                  height={1}
                  flexDirection="row"
                  backgroundColor={sel ? C.bgHighlight : C.bg}
                >
                  <text>
                    <span fg={markerFg} attributes={A.boldIf(!isDefault)}>{` ${marker} `}</span>
                    <span fg={patFg} attributes={A.boldIf(sel)}>
                      {rule.pattern.padEnd(16).substring(0, 16)}
                    </span>
                    <span fg={scopeFg}>{scopeText}</span>
                    <span fg={chainFg}>{chainStr(rule.chain)}</span>
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
