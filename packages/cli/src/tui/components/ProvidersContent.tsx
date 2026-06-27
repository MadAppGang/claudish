/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import {
  ProviderDef,
  maskKey,
  providerAuthCapabilities,
  providerAuthSource,
  providerIsReadyForDisplay,
} from "../providers.js";
import type { TestResultsMap } from "../types.js";
import type { ClaudishProfileConfig } from "../../profile-config.js";
import type { LocalLiveness } from "../../providers/local-liveness.js";

interface ProvidersContentProps {
  config: ClaudishProfileConfig;
  displayProviders: ProviderDef[];
  providerIndex: number;
  testResults: TestResultsMap;
  /** Liveness of local servers keyed by catalogName (ollama/lmstudio/...). */
  localLiveness: Record<string, LocalLiveness>;
  contentH: number;
  isInputMode: boolean;
  animTick: number;
}

// Column widths — kept here so headers and rows stay in lockstep.
const COL_NAME = 14;
const COL_STATUS = 9;  // "ready Xms" / "testing" / "not set" / "FAIL"
// AUTH column: icon-based encoding.
//   🔑 = key set       (2 cells)
//   🌐 = oauth set     (2 cells)
//   ·  = supported but not set (1 cell, padded to 2 for alignment)
//   (blank 2 cells) = method not supported by this provider
// Two slots side by side: [key-slot] " " [oauth-slot] → 5 cells total.
const COL_AUTH = 5;
const COL_KEY = 10;    // 8-char mask + a little breathing room
const CODE_CHARS = "01ABCDEFGHJKLMNPQRSTUVWXYZabcdefhijkmnpqrstuvwxyz#@$%*?";

function pad(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + " ".repeat(n - s.length);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function animatedCode(width: number, tick: number, salt: string): string {
  let seed = (tick + 1) * 2654435761 + hashString(salt);
  let out = "";
  for (let i = 0; i < width; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out += CODE_CHARS[seed % CODE_CHARS.length];
  }
  return out;
}

export function ProvidersContent({
  config,
  displayProviders,
  providerIndex,
  testResults,
  localLiveness,
  contentH,
  isInputMode,
  animTick,
}: ProvidersContentProps) {
  // Index of the first unready (not-configured) provider — where the
  // "─ not configured ─" divider belongs. Computed against the FULL list (not
  // the visible window) so windowing can't move it. -1 means every provider is
  // ready (no divider). Index-based, not a mutable "seen one yet" flag, so the
  // divider still renders correctly even when earlier rows are scrolled off.
  const firstUnreadyIdx = displayProviders.findIndex(
    (p) => !providerIsReadyForDisplay(p, config, localLiveness),
  );

  // contentH = total height of the rounded box.
  //   -2 for top/bottom border, -1 for column header, -1 for legend row.
  // The "─ not configured ─" divider is an EXTRA physical line injected inside
  // a row (not one of the provider slots), so when it can appear we reserve one
  // more line. Without this, at short terminal heights the divider + its row
  // overflow the box and OpenTUI overprints them onto a single line.
  const hasDivider = firstUnreadyIdx >= 0;
  const listH = contentH - 4 - (hasDivider ? 1 : 0);

  // Scroll window: derive the first visible row from the cursor so the
  // selected provider is always on-screen. Standard "scroll into view" —
  // the viewport only shifts when the cursor crosses an edge (vim/htop feel),
  // not a centered scroll. Purely a function of providerIndex + listH, so no
  // parent scroll state is needed (can't drift out of sync with the cursor).
  const scrollOffset = (() => {
    if (listH <= 0 || displayProviders.length <= listH) return 0;
    // Cursor above the window → snap top to cursor.
    if (providerIndex < listH) return 0;
    // Cursor at/below the bottom edge → put cursor on the last visible row.
    const maxOffset = displayProviders.length - listH;
    return Math.min(providerIndex - listH + 1, maxOffset);
  })();

  const getRow = (p: ProviderDef, idx: number) => {
    const auth = providerAuthSource(p, config);
    const caps = providerAuthCapabilities(p, config);
    // Display-readiness includes a running local server, so a running-but-not-
    // enabled local gets a filled dot + sorts above the divider (consistent with
    // its "running" status), not a hollow dot under "not configured".
    const isReady = providerIsReadyForDisplay(p, config, localLiveness);
    const isOauthOnly = auth === "oauth";
    const selected = idx === providerIndex;

    // KEY column. For API-key providers, show the masked key. For OAuth-
    // only providers, show "oauth···" placeholder so the column aligns and
    // makes the auth method obvious at a glance. For unauthenticated
    // providers, dashes.
    const tr = testResults[p.name];
    const isTesting = tr?.status === "testing";
    let keyDisplay: string;
    if (isTesting) {
      keyDisplay = animatedCode(8, animTick, p.name);
    } else if (p.isLocal) {
      keyDisplay = "local";
    } else if (isOauthOnly) {
      keyDisplay = "oauth···";
    } else if (auth === "public") {
      // Keyless/free provider (publicKeyFallback) — no user key, but usable.
      keyDisplay = "free";
    } else if (auth === "cfg") {
      keyDisplay = maskKey(config.apiKeys?.[p.apiKeyEnvVar]);
    } else if (auth === "env" || auth === "e+c") {
      keyDisplay = maskKey(process.env[p.apiKeyEnvVar]);
    } else {
      keyDisplay = "────────";
    }

    const isFirstUnready = idx === firstUnreadyIdx;

    // `tr` was already resolved above (for the key scramble); reuse it here.
    let statusFg: string = isReady ? C.green : C.dim;
    let statusText = p.isLocal ? (isReady ? "enabled" : "disabled") : isReady ? "ready" : "not set";
    // Local providers: layer liveness on top of the CONFIG-ENABLED flag (not
    // isReady — that now counts a running server as ready, which would hide the
    // "running but not enabled" distinction). "enabled" alone is misleading (the
    // server may be down); a detected-but-not-enabled server is a nudge to enable.
    if (p.isLocal) {
      const live = localLiveness[p.catalogName];
      const enabled = providerAuthSource(p, config) !== null; // local-enabled in config
      if (enabled) {
        if (live === "running") {
          statusFg = C.green;
          statusText = "running";
        } else if (live === "down") {
          statusFg = C.yellow;
          statusText = "down";
        } // live === undefined/unknown → keep "enabled"
      } else {
        // not config-enabled
        if (live === "running") {
          // Server is up but the user hasn't enabled it — surface it.
          statusFg = C.cyan;
          statusText = "running · off";
        } // down/unknown → keep "disabled"
      }
    }
    if (tr) {
      if (tr.status === "testing") {
        statusFg = C.yellow;
        statusText = "testing";
      } else if (tr.status === "valid") {
        statusFg = C.green;
        const base = tr.ms !== undefined ? `ready ${tr.ms}ms` : "ready";
        statusText = tr.note ? `${base} ${tr.note}` : base;
      } else {
        statusFg = C.red;
        statusText = "FAIL";
      }
    }

    // AUTH column — two capability slots, side by side.
    //   ● = configured/set
    //   ○ = supported, not yet configured
    //  (space) = not supported by this provider
    //
    // Label "key" is green (API-key family), "oauth" is cyan (OAuth path).
    // When not supported, both label and glyph are blank-padded so columns
    // align between rows with different capability sets.
    const keySlot = caps.apiKey;
    const oauthSlot = caps.oauth;
    const keySlotGlyph = !keySlot.supported
      ? "  "
      : keySlot.set
        ? "🔑"
        : "· ";
    const oauthSlotGlyph = !oauthSlot.supported
      ? "  "
      : oauthSlot.set
        ? "🌐"
        : "· ";
    return (
      <box key={p.name} flexDirection="column">
        {isFirstUnready && (
          <box height={1} flexDirection="row" paddingX={1}>
            <text>
              <span fg={C.dim}>{"─ not configured "}</span>
            </text>
            {/* Trailing rule fills the rest of the row via flexbox — the
                box's top border is the line, Yoga sizes it. No width math. */}
            <box flexGrow={1} border={["top"]} borderStyle="single" borderColor={C.dim} />
          </box>
        )}
        {/*
          Row background priority: selected > failed > default.
          - selected uses bgHighlight (blue band so the cursor row stands out)
          - failed uses bgError (faint red band, error message inline)
          flexGrow=1 lets OpenTUI size the row to its parent column
          automatically. overflow="hidden" clips the description/error span
          so a long error message can't bleed past the row's bounding box.
        */}
        <box
          height={1}
          flexGrow={1}
          flexDirection="row"
          overflow="hidden"
          backgroundColor={
            selected
              ? C.bgHighlight
              : tr?.status === "failed"
                ? C.bgError
                : C.bg
          }
        >
          <text>
            <span fg={isTesting ? C.yellow : isReady ? C.green : C.dim}>
              {isTesting ? "◌" : isReady ? "●" : "○"}
            </span>
            <span>{"  "}</span>
            <span
              fg={selected ? C.white : isReady ? C.fgMuted : C.dim}
              attributes={A.boldIf(selected)}
            >
              {pad(p.displayName, COL_NAME)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            <span fg={statusFg} attributes={A.boldIf(tr?.status === "valid" || isReady)}>
              {pad(statusText, COL_STATUS)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {/* AUTH column: emoji icons. Each slot is 2 terminal cells.
                  🔑 / 🌐 = method set
                  ·       = method supported but not set (1 cell + 1 pad)
                  blank   = method not supported (2 cells)
                Legend at the bottom of the panel explains the icons. */}
            <>
              <span fg={keySlot.set ? C.white : C.dim}>{keySlotGlyph}</span>
              <span>{" "}</span>
              <span fg={oauthSlot.set ? C.white : C.dim}>{oauthSlotGlyph}</span>
            </>
            <span fg={C.dim}>{"  "}</span>
            <span
              fg={isTesting ? C.yellow : p.isLocal ? (isReady ? C.green : C.dim) : isOauthOnly ? C.cyan : isReady ? C.cyan : C.dim}
              attributes={A.boldIf(isTesting)}
            >
              {pad(keyDisplay, COL_KEY)}
            </span>
            <span fg={C.dim}>{"  "}</span>
            {/*
              Description column doubles as inline error surface. When a row's
              test failed, replace the static description with the error
              message (collapsed to a single line, clipped to remaining width)
              rendered red so the user can see what went wrong without leaving
              the row. The proxy used to print `[claudish] Error [Provider]:
              ...` to stderr — that's now suppressed in the TUI (see
              tui/index.tsx → setStderrQuiet), and the error data lives in
              testResults[p.name].error instead.
            */}
            {/* Description column doubles as inline error surface when a test
                failed. We collapse whitespace to a single line, but DON'T
                pre-compute truncation width — the row's height={1} + the
                container's overflow="hidden" let OpenTUI clip naturally. */}
            {tr?.status === "failed" && tr.error ? (
              <span fg={C.red}>{tr.error.replace(/\s+/g, " ").trim()}</span>
            ) : (
              <span fg={selected ? C.white : C.dim}>{p.description}</span>
            )}
          </text>
        </box>
      </box>
    );
  };

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={!isInputMode ? C.blue : C.dim}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* Column header — widths match COL_* constants used by getRow. */}
      <text height={1}>
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} attributes={A.bold}>{pad("PROVIDER", COL_NAME)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} attributes={A.bold}>{pad("STATUS", COL_STATUS)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} attributes={A.bold}>{pad("AUTH", COL_AUTH)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} attributes={A.bold}>{pad("KEY", COL_KEY)}</span>
        <span>{"  "}</span>
        <span fg={C.blue} attributes={A.bold}>DESCRIPTION</span>
      </text>
      {/* Rows fill the available space between header and legend. flexGrow
          on this wrapper pushes the legend below to the panel's bottom
          edge regardless of how many providers are shown. */}
      <box flexDirection="column" style={{ flexGrow: 1 }}>
        {/* Render only the scroll window, but pass each row its ORIGINAL index
            (scrollOffset + i) so getRow's `idx === providerIndex` highlight
            comparison stays correct after scrolling. */}
        {displayProviders
          .slice(scrollOffset, scrollOffset + listH)
          .map((p, i) => getRow(p, scrollOffset + i))}
      </box>
      {/* AUTH icon legend — pinned to the bottom of the panel via the
          flex spacer above. Explains 🔑 / 🌐 / · without repeating
          hints per row. */}
      <text height={1}>
        <span fg={C.dim}>{"AUTH:  "}</span>
        <span>{"🔑"}</span>
        <span fg={C.fgMuted}>{" key set  "}</span>
        <span>{"🌐"}</span>
        <span fg={C.fgMuted}>{" oauth set  "}</span>
        <span fg={C.dim}>{"·"}</span>
        <span fg={C.fgMuted}>{" supported, not set  "}</span>
        <span fg={C.dim}>{"(blank) not available"}</span>
      </text>
    </box>
  );
}
