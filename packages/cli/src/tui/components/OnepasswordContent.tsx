/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { A, C } from "../theme.js";
import type { OpEntry, OpTestResultsMap, Tab } from "../types.js";

/** One resolved key in a set's expansion: its env-var NAME + a masked value tail
 *  (last 4 chars, for "••••1234" display — never the full value). */
export interface OpExpandedKey {
  name: string;
  tail: string;
}

/** A glob's expansion state: its resolved keys (name + masked tail), or status. */
export type OpExpansion =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; keys: OpExpandedKey[] };

interface OnepasswordContentProps {
  activeTab: Tab;
  /** Merged list of keys / sets / environments (+ optional account rows). */
  entries: OpEntry[];
  /** Selected row index into `entries`. */
  opIndex: number;
  /** Account URL by source, for the auth status card. */
  account: { global?: string; project?: string; env?: string };
  /** True when op auth is available (env/token OR a configured account). */
  authConfigured: boolean;
  /** Per-entry test results, keyed `${scope}:${kind}:${value}`. */
  testResults: OpTestResultsMap;
  /** Per-set (glob) resolved key-name expansions, keyed by the glob's op:// value. */
  expansions: Record<string, OpExpansion>;
  contentH: number;
}

/** Scope marker glyph + color: project ▴ (cyan), global • (green), env · (dim). */
function scopeMarker(scope: OpEntry["scope"]): { glyph: string; color: string } {
  if (scope === "project") return { glyph: "▴", color: C.cyan };
  if (scope === "global") return { glyph: "•", color: C.green };
  return { glyph: "·", color: C.dim };
}

/**
 * User-facing label per entry kind (no engineering jargon): a single ref is a
 * "key", a glob is a "set" (a set of keys), an environment is "env".
 */
function kindLabel(kind: OpEntry["kind"]): string {
  switch (kind) {
    case "account":
      return "account";
    case "ref":
      return "key";
    case "glob":
      return "set";
    case "environment":
      return "env";
  }
}

/** Color per kind label so the KIND column reads at a glance. */
function kindColor(kind: OpEntry["kind"]): string {
  switch (kind) {
    case "glob":
      return C.yellow; // a set (many keys)
    case "environment":
      return C.cyan;
    default:
      return C.blue; // a single key
  }
}

/** Stable key for an entry's test result (must match App's keying). */
function entryKey(e: OpEntry): string {
  return `${e.scope}:${e.kind}:${e.value}`;
}

export function OnepasswordContent({
  activeTab,
  entries,
  opIndex,
  account,
  authConfigured,
  testResults,
  expansions,
  contentH,
}: OnepasswordContentProps) {
  const keyCount = entries.filter((e) => e.kind === "ref").length;
  const setCount = entries.filter((e) => e.kind === "glob").length;
  const envCount = entries.filter((e) => e.kind === "environment").length;

  // ── Auth status card (top, 3 rows of content inside a bordered box) ────────
  // Modeled on PrivacyContent's card: a single bordered box with a title and a
  // few <text> rows. Border turns blue when this tab is focused, dim otherwise.
  const cardH = 4;

  // ── Merged list (below the card) — fills the remaining height. ─────────────
  // The list box claims the rest of the content height; OpenTUI clips overflow.
  // Entries are short in practice (a handful of keys/sets); set sub-rows expand
  // inline. We render all lines and let the box height bound them.
  const listBoxH = Math.max(4, contentH - cardH);

  // Render one entry as one OR MORE lines: the entry row, plus (for a "set"/glob)
  // its resolved key-name sub-rows. Non-selected rows are bare <text> (transparent
  // → inherit the panel bg, NO dark/blue strips); only the selected row gets a
  // height-1 highlight box (no flexGrow, so it can't paint the whole area).
  const getRowLines = (e: OpEntry, idx: number): ReactNode[] => {
    const selected = idx === opIndex;
    const marker = scopeMarker(e.scope);
    const tr = testResults[entryKey(e)];

    // Trailing annotation: test status (refs show their → envName separately).
    let resultNode: ReactNode = null;
    if (tr) {
      if (tr.status === "testing") {
        resultNode = <span fg={C.yellow} attributes={A.bold}>{"  ◌ testing"}</span>;
      } else if (tr.status === "valid") {
        resultNode = (
          <>
            <span fg={C.green} attributes={A.bold}>{"  ● ok"}</span>
            {tr.note && <span fg={C.fgMuted}>{`  ${tr.note}`}</span>}
          </>
        );
      } else {
        resultNode = <span fg={C.red} attributes={A.bold}>{"  ✗ failed"}</span>;
      }
    }

    const rowSpans = (
      <>
        <span fg={marker.color} attributes={A.boldIf(selected)}>{marker.glyph}</span>
        <span fg={C.dim}>{"  "}</span>
        <span fg={kindColor(e.kind)} attributes={A.boldIf(selected)}>
          {kindLabel(e.kind).padEnd(5)}
        </span>
        <span fg={C.dim}>{"  "}</span>
        <span fg={selected ? C.white : C.fgMuted} attributes={A.boldIf(selected)}>
          {e.value}
        </span>
        {e.kind === "ref" && e.envName && <span fg={C.dim}>{`  → ${e.envName}`}</span>}
        {resultNode}
      </>
    );

    const lines: ReactNode[] = [
      selected ? (
        <box key={`${entryKey(e)}-${idx}`} height={1} flexDirection="row" backgroundColor={C.bgHighlight}>
          <text>{rowSpans}</text>
        </box>
      ) : (
        <text key={`${entryKey(e)}-${idx}`}>{rowSpans}</text>
      ),
    ];

    // For a "set" (glob): nest its resolved key NAMES (no values) as dim sub-rows.
    if (e.kind === "glob") {
      const exp = expansions[e.value];
      if (!exp || exp.status === "loading") {
        lines.push(
          <text key={`${entryKey(e)}-${idx}-load`}>
            <span fg={C.dim}>{"        ◌ resolving keys…"}</span>
          </text>,
        );
      } else if (exp.status === "error") {
        lines.push(
          <text key={`${entryKey(e)}-${idx}-err`}>
            <span fg={C.red}>{`        ✗ ${exp.message}`}</span>
          </text>,
        );
      } else {
        // Align the masked tail into a column so the ••••XXXX line up.
        const nameW = Math.min(28, Math.max(0, ...exp.keys.map((k) => k.name.length)));
        for (const k of exp.keys) {
          lines.push(
            <text key={`${entryKey(e)}-${idx}-${k.name}`}>
              <span fg={C.dim}>{"        ↳ "}</span>
              <span fg={C.green}>{k.name.padEnd(nameW)}</span>
              {k.tail && <span fg={C.dim}>{`   ••••${k.tail}`}</span>}
            </text>,
          );
        }
      }
    }

    return lines;
  };

  return (
    <box height={contentH} flexDirection="column" backgroundColor={C.bg} paddingX={1}>
      {/* Auth status card */}
      <box
        height={cardH}
        border
        borderStyle="single"
        borderColor={activeTab === "onepassword" ? C.blue : C.dim}
        title=" 1Password Auth "
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        {/* Row 1: resolved account source. env/token first, then config scopes. */}
        <text>
          <span fg={C.blue} attributes={A.bold}>
            {"Account: "}
          </span>
          {account.env ? (
            <>
              <span fg={C.dim}>{"· "}</span>
              <span fg={C.fgMuted}>{`env (${account.env})`}</span>
            </>
          ) : account.project ? (
            <>
              <span fg={C.cyan} attributes={A.bold}>
                {"▴ "}
              </span>
              <span fg={C.white}>{`project: ${account.project}`}</span>
            </>
          ) : account.global ? (
            <>
              <span fg={C.green} attributes={A.bold}>
                {"• "}
              </span>
              <span fg={C.white}>{`global: ${account.global}`}</span>
            </>
          ) : (
            <span fg={C.fgMuted}>{"○ Not configured"}</span>
          )}
        </text>
        {/* Row 2: key / set / env summary. */}
        <text>
          <span fg={C.white} attributes={A.bold}>{String(keyCount)}</span>
          <span fg={C.fgMuted}>{` key${keyCount === 1 ? "" : "s"}`}</span>
          <span fg={C.dim}>{"   "}</span>
          <span fg={C.white} attributes={A.bold}>{String(setCount)}</span>
          <span fg={C.fgMuted}>{` set${setCount === 1 ? "" : "s"}`}</span>
          <span fg={C.dim}>{"   "}</span>
          <span fg={C.white} attributes={A.bold}>{String(envCount)}</span>
          <span fg={C.fgMuted}>{` environment${envCount === 1 ? "" : "s"}`}</span>
        </text>
      </box>

      {/* Merged list */}
      <box
        height={listBoxH}
        border
        borderStyle="single"
        borderColor={activeTab === "onepassword" ? C.blue : C.dim}
        backgroundColor={C.bg}
        flexDirection="column"
        paddingX={1}
      >
        {/* Column header */}
        <text height={1}>
          <span fg={C.dim}>{"   "}</span>
          <span fg={C.blue} attributes={A.bold}>
            {"KIND"}
          </span>
          <span fg={C.dim}>{"     "}</span>
          <span fg={C.blue} attributes={A.bold}>
            {"VALUE"}
          </span>
        </text>
        {entries.length === 0 ? (
          <box flexDirection="column">
            <text>
              <span fg={C.fgMuted}>
                {"No 1Password imports yet. Press ["}
              </span>
              <span fg={C.green} attributes={A.bold}>
                {"a"}
              </span>
              <span fg={C.fgMuted}>{"] to add."}</span>
            </text>
            {!authConfigured && (
              <text>
                <span fg={C.dim}>
                  {"Auth resolves on first add (set account via [o] or OP_ACCOUNT)."}
                </span>
              </text>
            )}
          </box>
        ) : (
          <box flexDirection="column">
            {entries.flatMap((e, i) => getRowLines(e, i))}
          </box>
        )}
      </box>
    </box>
  );
}
