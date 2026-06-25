/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { A, C } from "../theme.js";
import {
  type AccountInfo,
  type DiscoveredField,
} from "../../providers/onepassword.js";
import type { Mode } from "../types.js";

/**
 * Centered modal dialog for the 1Password add-wizard. Rendered as an
 * absolute-positioned overlay (NOT in the fixed bottom detail strip) so the
 * active step is a real popup floating over the content, with a dimmed
 * full-screen backdrop.
 *
 * NEW FLOW (browse, don't type):
 *   1. scope   — global / project (FIRST).
 *   2. account — only when there's genuine multi-account ambiguity (auto-skipped
 *                otherwise). Surfaced by resolveSdkAuth's onNeedsPicker too.
 *   3. kind    — "API key from an item" / "Environment" (with descriptions ON).
 *   4. value   — per kind:
 *        · API key  → vault picker → item picker → field/glob picker (no typing).
 *        · Environment → typed ID with a two-Enter NAME preview (SDK can't list).
 *
 * The host (App.tsx) owns Enter/Esc via useKeyboard; the focused <input>/<select>
 * inside owns character entry / ↑↓ and reports the cursor via on*Change. This
 * matches the Providers <input> + Profiles <select> coexistence model.
 */

/** The modal modes this dialog renders for. */
export type OpModalMode =
  | "input_op_account"
  | "input_op_env"
  | "pick_op_scope"
  | "pick_op_account"
  | "pick_op_kind"
  | "pick_op_vault"
  | "pick_op_item"
  | "pick_op_field";

/** True when the given Mode is one the 1Password modal should render. */
export function isOpModalMode(mode: Mode): mode is OpModalMode {
  return (
    mode === "input_op_account" ||
    mode === "input_op_env" ||
    mode === "pick_op_scope" ||
    mode === "pick_op_account" ||
    mode === "pick_op_kind" ||
    mode === "pick_op_vault" ||
    mode === "pick_op_item" ||
    mode === "pick_op_field"
  );
}

/**
 * Case-insensitive subsequence fuzzy match: every char of `query` must appear in
 * `text` in order (not necessarily adjacent). Empty query matches everything.
 * e.g. "dhg" matches "Docker Hub Github credentials".
 */
export function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Filter a list of {title}-bearing rows by fuzzy-matching `filter` against title. */
export function fuzzyFilterByTitle<T extends { title: string }>(rows: T[], filter: string): T[] {
  if (filter.trim() === "") return rows;
  return rows.filter((r) => fuzzyMatch(filter, r.title));
}

/**
 * The visual role of a field-picker row, driving color + layout in
 * renderFieldPicker. `everything`/`section-glob` are the dynamic globs;
 * `field` is a concrete ref; `collapsed` is a single-field section shown as
 * "Section → ENVNAME"; `header` is a non-selectable group anchor; `blank` is a
 * spacer line between groups.
 */
export type FieldRowRole =
  | "everything-all" // whole-item `**` glob (★ All keys in this item)
  | "everything" // sectionless `*` glob (★ All top-level keys)
  | "section-glob"
  | "field"
  | "collapsed"
  | "header"
  | "blank";

/**
 * A field-picker row. Selectable options build an op:// path (`value`); headers
 * and blanks are visual-only. `left`/`right` carry the two-column display parts
 * (e.g. left="OpenAI", right="OPENAI_API_KEY") so renderFieldPicker can align
 * the env-var-name column.
 */
export interface FieldPickerOption {
  /** Display label (full, single-column fallback). */
  name: string;
  /** The op:// path (selectable rows) or "" (headers/blanks). Shown in footer. */
  description: string;
  /** The op:// path this option builds (single ref or glob); "" for non-rows. */
  value: string;
  /** False → header/blank: the cursor skips it and Enter ignores it. */
  selectable: boolean;
  /** Visual role for coloring/layout. */
  role: FieldRowRole;
  /** Left column text (the field/section label or glob caption). */
  left: string;
  /** Right column text (the resulting env-var name), or "" when N/A. */
  right: string;
  /** Indent depth (0 = top/header, 1 = nested under a section). */
  indent: number;
}

interface OnepasswordModalProps {
  mode: OpModalMode;
  inputValue: string;
  setInputValue: (v: string) => void;
  scopeCursor: 0 | 1;
  kindCursor: number;
  accountCursor: number;
  // ── op:// browse levels — already FUZZY-FILTERED by App (App owns ↑↓+filter) ──
  accounts: AccountInfo[];
  vaults: { id: string; title: string }[];
  items: { id: string; title: string }[];
  /** Pre-built + filtered field-picker options (glob + section + concrete). */
  fieldOptions: FieldPickerOption[];
  /** The current inline filter string (shown in a filter header above the list). */
  filter: string;
  vaultCursor: number;
  itemCursor: number;
  fieldCursor: number;
  /** Already-picked vault/item titles, shown as breadcrumb context. */
  pickedVault: string | null;
  pickedItem: string | null;
  /** True while an async vault/item/field load is in flight. */
  busy: boolean;
  /** Environment variable NAMES previewed after the first Enter (null = no preview yet). */
  envPreview: string[] | null;
  onScopeChange: (i: number) => void;
  /** Full terminal dimensions — used to center + size the dialog. */
  width: number;
  height: number;
}

/**
 * Kind options for the manually-rendered kind step. Each has a bold `title` and
 * a multi-line muted `desc` (rendered as separate dim lines under the title) so
 * the choice reads clearly — the native <select> can only do one short line.
 */
interface KindOption {
  title: string;
  desc: string[];
}
const KIND_OPTIONS: KindOption[] = [
  {
    title: "API key — one or many fields from a single item",
    desc: [
      "Browse a vault → item → field. Import a single field as one",
      "env var, or import every field at once with a glob (*).",
    ],
  },
  {
    title: "Environment — a whole 1Password Environment",
    desc: [
      "Load all variables from a named 1Password Environment.",
      "Type its ID; the variable names are previewed before saving.",
    ],
  },
];

const SCOPE_OPTIONS = [
  { name: "global   (~/.claudish/config.json)", description: "", value: "global" },
  { name: "project  (./.claudish.json)", description: "", value: "project" },
];

/** A valid POSIX-ish env var name (matches the resolver's ENV_VAR_NAME_RE). */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * A field is IMPORTABLE only if it's a concealed (secret) field whose label is a
 * valid env-var name — i.e. something that actually becomes an env var at import.
 * Non-concealed fields (notes/username/url) and badly-named fields ("credential")
 * are hidden so the picker shows only real keys. (The SDK's fieldType enum value
 * is "Concealed"; match case-insensitively to be safe.)
 */
function isImportableField(f: DiscoveredField): boolean {
  const name = f.label.trim();
  if (!ENV_NAME_RE.test(name)) return false;
  return String(f.type).toLowerCase() === "concealed";
}

/**
 * Build the field-picker option list from discovered fields.
 *
 * Only IMPORTABLE fields (concealed + valid env-var name) are shown; everything
 * else is hidden. Layout:
 *  - `★ Import everything (N keys)` glob at top (N = importable count).
 * FLAT LIST (uniform — no headers/gaps): one selectable "key" row per importable
 * field, shown as `ENVNAME  ·  section` (the section is dim context). After a
 * MULTI-key section's keys, one "↳ all of <section>" glob row (dynamic). Plus a
 * trailing "★ All top-level keys" glob ONLY when there are importable sectionless
 * keys (an item-level `op://Item/*` glob matches sectionless fields only — the
 * grammar can't span sections). Order: by section (first-seen), keys then the
 * section's "all of" glob; sectionless keys last; ★ at the very end.
 */
export function buildFieldOptions(
  vaultTitle: string,
  itemTitle: string,
  fields: DiscoveredField[]
): FieldPickerOption[] {
  const opts: FieldPickerOption[] = [];

  // Keep only importable fields, preserving order.
  const importable = fields.filter(isImportableField);

  // Group by section (first-seen order); sectionless → topLevel.
  const sectionOrder: string[] = [];
  const bySection = new Map<string, DiscoveredField[]>();
  const topLevel: DiscoveredField[] = [];
  for (const f of importable) {
    if (f.section) {
      if (!bySection.has(f.section)) {
        bySection.set(f.section, []);
        sectionOrder.push(f.section);
      }
      bySection.get(f.section)!.push(f);
    } else {
      topLevel.push(f);
    }
  }

  const hasSections = sectionOrder.length > 0;

  // A single "key" row: ENVNAME (left, green) + section tag (right, dim context).
  const keyRow = (f: DiscoveredField, section: string | null): FieldPickerOption => {
    const env = f.label.trim() || f.label;
    return {
      name: `${env}  ·  ${section ?? ""}`,
      description: f.reference,
      value: f.reference,
      selectable: true,
      role: "field",
      left: env,
      right: section ?? "",
      indent: 0,
    };
  };

  // ★ All keys in this item — the WHOLE-item glob (`**`): every importable field
  // regardless of section. Shown FIRST whenever the item has any importable key.
  // One config entry covers every shape (no-sections / all-sectioned / mixed).
  if (importable.length > 0) {
    opts.push({
      name: `★ All keys in this item (${importable.length}, auto-updates)`,
      description: `op://${vaultTitle}/${itemTitle}/**`,
      value: `op://${vaultTitle}/${itemTitle}/**`,
      selectable: true,
      role: "everything-all",
      left: `★ All keys in this item`,
      right: `${importable.length}, auto-updates`,
      indent: 0,
    });
  }

  // Section keys, then (for multi-key sections) one "↳ all of <section>" glob.
  for (const section of sectionOrder) {
    const inSection = bySection.get(section)!;
    for (const f of inSection) opts.push(keyRow(f, section));
    if (inSection.length >= 2) {
      opts.push({
        name: `↳ all of ${section} (${inSection.length}, auto-updates)`,
        description: `op://${vaultTitle}/${itemTitle}/${section}/*`,
        value: `op://${vaultTitle}/${itemTitle}/${section}/*`,
        selectable: true,
        role: "section-glob",
        left: `↳ all of ${section}`,
        right: `${inSection.length}, auto-updates`,
        indent: 0,
      });
    }
  }

  // Sectionless keys (no tag).
  for (const f of topLevel) opts.push(keyRow(f, null));

  // ★ All top-level keys — the sectionless-only glob (`*`). Shown ONLY for a
  // MIXED item (has sections AND top-level keys), as a narrower pick distinct
  // from "All keys in this item". For a no-sections item, `**` already equals
  // `*`, so this would be a redundant second star — suppress it there.
  if (topLevel.length > 0 && hasSections) {
    opts.push({
      name: `★ All top-level keys (${topLevel.length}, auto-updates)`,
      description: `op://${vaultTitle}/${itemTitle}/*`,
      value: `op://${vaultTitle}/${itemTitle}/*`,
      selectable: true,
      role: "everything",
      left: `★ All top-level keys`,
      right: `${topLevel.length}, auto-updates`,
      indent: 0,
    });
  }

  return opts;
}

/**
 * Width-aware middle-truncate. Keeps the start and (biased) the tail visible so a
 * long op:// path still shows its disambiguating `/<field>` or `/*` suffix. e.g.
 * "op://Jack/AI LLM models API keys 10xlabs/GOOGLE_GEMINI_API_KEY/*" → "op://Jac…API_KEY/*".
 */
export function midTruncate(s: string, w: number): string {
  if (w <= 1 || s.length <= w) return s;
  const keepEnd = Math.ceil((w - 1) * 0.6); // bias toward the tail (field / *)
  const keepStart = w - 1 - keepEnd;
  return s.slice(0, keepStart) + "…" + s.slice(s.length - keepEnd);
}

/** Per-step wizard metadata: title, step number, and short help line. */
function stepMeta(mode: OpModalMode): { title: string; step: string; help: string } {
  switch (mode) {
    case "pick_op_scope":
      return {
        title: " Add 1Password import ",
        step: "Step 1 of 4 — where to save",
        help: "Global applies everywhere; project = this dir.",
      };
    case "pick_op_account":
      return {
        title: " Pick 1Password account ",
        step: "Step 2 of 4 — account",
        help: "Multiple accounts found — select which to use.",
      };
    case "pick_op_kind":
      return {
        title: " Add 1Password import ",
        step: "Step 3 of 4 — what to add",
        help: "Choose what kind of import to create.",
      };
    case "pick_op_vault":
      return {
        title: " Pick a vault ",
        step: "Step 4 of 4 — vault → item → field",
        help: "Choose the vault that holds the secret.",
      };
    case "pick_op_item":
      return {
        title: " Pick an item ",
        step: "Step 4 of 4 — vault → item → field",
        help: "Choose the item inside the vault.",
      };
    case "pick_op_field":
      return {
        title: " Pick a field ",
        step: "Step 4 of 4 — vault → item → field",
        help: "Pick a key's field, or import a whole section / everything (★).",
      };
    case "input_op_env":
      return {
        title: " Add Environment ",
        step: "Step 4 of 4 — Environment ID",
        help: "Type the ID, Enter to preview its variable names, Enter again to save.",
      };
    case "input_op_account":
      return {
        title: " 1Password account ",
        step: "Set account URL",
        help: "e.g. my-team.1password.com",
      };
  }
}

export function OnepasswordModal({
  mode,
  inputValue,
  setInputValue,
  scopeCursor,
  kindCursor,
  accountCursor,
  accounts,
  vaults,
  items,
  fieldOptions,
  filter,
  vaultCursor,
  itemCursor,
  fieldCursor,
  pickedVault,
  pickedItem,
  busy,
  envPreview,
  onScopeChange,
  width,
  height,
}: OnepasswordModalProps) {
  const meta = stepMeta(mode);

  // Dialog size: comfortably wide, clamped to the terminal. Centered via an
  // absolute full-screen flex container (justify/align center).
  const dialogW = Math.min(72, Math.max(40, width - 8));

  // Breadcrumb context for the browse levels (vault › item).
  let breadcrumb: ReactNode = null;
  if (mode === "pick_op_item" || mode === "pick_op_field") {
    breadcrumb = (
      <text>
        <span fg={C.fgMuted}>{"vault: "}</span>
        <span fg={C.cyan} attributes={A.bold}>
          {pickedVault ?? "?"}
        </span>
        {mode === "pick_op_field" && (
          <>
            <span fg={C.fgMuted}>{"  ›  item: "}</span>
            <span fg={C.cyan} attributes={A.bold}>
              {pickedItem ?? "?"}
            </span>
          </>
        )}
      </text>
    );
  }

  const accountRows = accounts.map((a) => (a.email ? `${a.url}  (${a.email})` : a.url));
  const vaultRows = vaults.map((v) => v.title);
  const itemRows = items.map((i) => i.title);

  /**
   * A manually-rendered, fuzzy-filterable list picker. App owns ↑↓ + the filter
   * string (so it stays in sync with what Enter selects); this just renders a
   * filter header line, a scroll-windowed list, and a "no matches" state.
   *  - `rows`: the display strings (already filtered by App).
   *  - `cursor`: selected index into `rows`.
   *  - `selectableFlags`: optional per-row flag. `false` → a section HEADER:
   *    rendered plain (no ▶ marker, never highlighted). The cursor never lands on
   *    a header (App's nav skips them), so this is mostly defensive styling.
   */
  const renderListPicker = (
    rows: string[],
    cursor: number,
    selectableFlags?: boolean[]
  ): ReactNode => {
    const VISIBLE = 8; // rows shown at once before scrolling
    // Scroll window: keep the cursor in view.
    let start = 0;
    if (rows.length > VISIBLE) {
      if (cursor >= VISIBLE) start = Math.min(cursor - VISIBLE + 1, rows.length - VISIBLE);
    }
    const slice = rows.slice(start, start + VISIBLE);
    return (
      <box flexDirection="column">
        {/* Filter header — shows what's typed and the match count. */}
        <text>
          <span fg={C.fgMuted}>{"filter: "}</span>
          {filter ? (
            <span fg={C.white} attributes={A.bold}>
              {filter}
            </span>
          ) : (
            <span fg={C.dim}>{"(type to filter)"}</span>
          )}
          <span fg={C.dim}>{`   ${rows.length} match${rows.length === 1 ? "" : "es"}`}</span>
        </text>
        {rows.length === 0 ? (
          <text>
            <span fg={C.fgMuted}>{"  no matches"}</span>
          </text>
        ) : (
          slice.map((row, i) => {
            const idx = start + i;
            const isHeader = selectableFlags ? selectableFlags[idx] === false : false;
            const selected = !isHeader && idx === cursor;
            if (isHeader) {
              // Section header — a group anchor (the user's key name). No marker,
              // never highlighted, slightly brighter than the dim sub-rows.
              return (
                <box key={`${idx}-${row}`} flexDirection="row" backgroundColor={C.bg}>
                  <text>
                    <span fg={C.fgMuted} attributes={A.bold}>
                      {row}
                    </span>
                  </text>
                </box>
              );
            }
            return (
              <box
                key={`${idx}-${row}`}
                flexDirection="row"
                backgroundColor={selected ? C.bgHighlight : C.bg}
              >
                <text>
                  <span fg={selected ? C.cyan : C.dim} attributes={A.bold}>
                    {selected ? "▶ " : "  "}
                  </span>
                  <span fg={selected ? C.white : C.fgMuted} attributes={A.boldIf(selected)}>
                    {row}
                  </span>
                </text>
              </box>
            );
          })
        )}
      </box>
    );
  };

  /**
   * Dedicated renderer for the FIELD step: structured, two-column, muted colors.
   * `opts` are already filtered by App; `cursor` is the selected index.
   * Layout per row, by role:
   * FLAT, uniform list (no headers/gaps). Row roles:
   *  - field        : ENVNAME (green) + aligned "· section" tag (dim context)
   *  - section-glob : "↳ all of <section>" (blue) + count caption (dim)
   *  - everything   : "★ All top-level keys" (yellow) + count caption (dim)
   * The "· section" tag is aligned into a second column so the tags line up.
   */
  const renderFieldPicker = (opts: FieldPickerOption[], cursor: number): ReactNode => {
    const VISIBLE = 8;
    let start = 0;
    if (opts.length > VISIBLE && cursor >= VISIBLE) {
      start = Math.min(cursor - VISIBLE + 1, opts.length - VISIBLE);
    }
    const slice = opts.slice(start, start + VISIBLE);
    const hiddenAbove = start;
    const hiddenBelow = Math.max(0, opts.length - (start + VISIBLE));
    const keyCount = opts.filter((o) => o.selectable).length;
    // Align the "· section" tag column across visible key rows (cap the width so
    // a very long env-var name doesn't push the tag off-screen).
    const keyLeftW = Math.min(
      28,
      Math.max(0, ...slice.filter((o) => o.role === "field" && o.right).map((o) => o.left.length))
    );

    /** One row's inner spans (no bg) — the selected wrapper adds the highlight. */
    const rowSpans = (o: FieldPickerOption, selected: boolean): ReactNode => {
      const marker = selected ? "▶ " : "  ";
      if (o.role === "everything-all" || o.role === "everything") {
        return (
          <>
            <span fg={selected ? C.cyan : C.yellow} attributes={A.bold}>{marker}</span>
            <span fg={selected ? C.cyan : C.yellow} attributes={A.bold}>{o.left}</span>
            <span fg={C.dim}>{`  ${o.right}`}</span>
          </>
        );
      }
      if (o.role === "section-glob") {
        return (
          <>
            <span fg={selected ? C.cyan : C.dim} attributes={A.bold}>{marker}</span>
            <span fg={selected ? C.blue : C.dim}>{o.left}</span>
            <span fg={C.dim}>{`  ${o.right}`}</span>
          </>
        );
      }
      // role === "field": ENVNAME (green) + "· section" tag (dim, aligned).
      return (
        <>
          <span fg={selected ? C.cyan : C.dim} attributes={A.bold}>{marker}</span>
          <span fg={C.green} attributes={A.boldIf(selected)}>{o.left.padEnd(keyLeftW)}</span>
          {o.right && <span fg={C.dim}>{`  · ${o.right}`}</span>}
        </>
      );
    };

    return (
      <box flexDirection="column">
        {/* Filter header. */}
        <text>
          <span fg={C.fgMuted}>{"filter: "}</span>
          {filter ? (
            <span fg={C.white} attributes={A.bold}>
              {filter}
            </span>
          ) : (
            <span fg={C.dim}>{"(type to filter)"}</span>
          )}
          <span fg={C.dim}>{`   ${keyCount} key${keyCount === 1 ? "" : "s"}`}</span>
        </text>

        {/* Bordered, contained scroll region so the list reads as a distinct
            panel (not blending into the modal) and overflow is obvious. */}
        <box
          border
          borderStyle="single"
          borderColor={C.border}
          backgroundColor={C.bg}
          flexDirection="column"
          paddingX={1}
        >
          {/* ▲ more above */}
          <text>
            {hiddenAbove > 0 ? (
              <span fg={C.cyan}>{`  ▲ ${hiddenAbove} more above`}</span>
            ) : (
              <span fg={C.dim}>{" "}</span>
            )}
          </text>

          {opts.length === 0 ? (
            <text>
              <span fg={C.fgMuted}>{"  no matches"}</span>
            </text>
          ) : (
            slice.map((o, i) => {
              const idx = start + i;
              const selected = o.selectable && idx === cursor;
              // Selected row: a highlighted full-width box. Non-selected rows are
              // bare <text> (transparent → inherits the panel bg, no dark strips).
              if (selected) {
                return (
                  <box key={`r-${idx}`} backgroundColor={C.bgHighlight} flexDirection="row">
                    <text>{rowSpans(o, true)}</text>
                  </box>
                );
              }
              return <text key={`r-${idx}`}>{rowSpans(o, false)}</text>;
            })
          )}

          {/* ▼ more below */}
          <text>
            {hiddenBelow > 0 ? (
              <span fg={C.cyan}>{`  ▼ ${hiddenBelow} more below`}</span>
            ) : (
              <span fg={C.dim}>{" "}</span>
            )}
          </text>
        </box>
      </box>
    );
  };

  /** A "Loading…" placeholder for an empty-but-loading picker level. */
  const loadingBody = (
    <text>
      <span fg={C.yellow} attributes={A.bold}>
        {"◌ Loading…"}
      </span>
    </text>
  );

  /** An "empty list" placeholder when a load finished with no rows. */
  const emptyBody = (label: string): ReactNode => (
    <text>
      <span fg={C.fgMuted}>{label}</span>
    </text>
  );

  // Body for the active step.
  let body: ReactNode;
  if (mode === "input_op_account" || mode === "input_op_env") {
    body = (
      <box flexDirection="column">
        <box flexDirection="row">
          <text>
            <span fg={C.green} attributes={A.bold}>
              {"> "}
            </span>
          </text>
          <input
            value={inputValue}
            onInput={setInputValue}
            onChange={setInputValue}
            focused={true}
            width={dialogW - 6}
            backgroundColor={C.bgHighlight}
            textColor={C.white}
          />
        </box>
        {/* Env: two-Enter NAME preview. Before preview, hint to press Enter.
            After preview, list the variable names (NO values). */}
        {mode === "input_op_env" && envPreview === null && (
          <text>
            <span fg={C.dim}>{"Press Enter to preview this Environment's variable names."}</span>
          </text>
        )}
        {mode === "input_op_env" && envPreview !== null && (
          <box flexDirection="column" paddingTop={1}>
            <text>
              <span fg={C.green} attributes={A.bold}>
                {`${envPreview.length} variable${envPreview.length === 1 ? "" : "s"} (names only): `}
              </span>
            </text>
            <text>
              <span fg={C.cyan}>{envPreview.join(", ")}</span>
            </text>
            <text>
              <span fg={C.dim}>{"Press Enter again to save this Environment."}</span>
            </text>
          </box>
        )}
      </box>
    );
  } else if (mode === "pick_op_kind") {
    // Manual render (not <select>): bold title line + muted multi-line
    // description per option, selected row highlighted. App owns ↑↓ here.
    body = (
      <box flexDirection="column">
        {KIND_OPTIONS.map((opt, i) => {
          const selected = i === kindCursor;
          return (
            <box
              key={opt.title}
              flexDirection="column"
              backgroundColor={selected ? C.bgHighlight : C.bg}
              paddingX={1}
              marginTop={i > 0 ? 1 : 0}
            >
              {/* Title — bold, with a ▶ marker on the selected row. */}
              <text>
                <span fg={selected ? C.cyan : C.dim} attributes={A.bold}>
                  {selected ? "▶ " : "  "}
                </span>
                <span fg={selected ? C.white : C.fgMuted} attributes={A.bold}>
                  {opt.title}
                </span>
              </text>
              {/* Description — muted, multi-line, indented under the title. */}
              {opt.desc.map((line, j) => (
                <text key={j}>
                  <span fg={C.dim}>{`    ${line}`}</span>
                </text>
              ))}
            </box>
          );
        })}
      </box>
    );
  } else if (mode === "pick_op_scope") {
    body = (
      <select
        options={SCOPE_OPTIONS}
        focused={true}
        showDescription={false}
        wrapSelection={true}
        selectedIndex={scopeCursor}
        onChange={onScopeChange}
        backgroundColor={C.bg}
        textColor={C.fgMuted}
        selectedBackgroundColor={C.bgHighlight}
        selectedTextColor={C.white}
        height={SCOPE_OPTIONS.length}
      />
    );
  } else if (mode === "pick_op_account") {
    // Account list is loaded synchronously (op account list), so no busy state.
    body =
      accounts.length === 0 && filter.trim() === ""
        ? emptyBody("No accounts available.")
        : renderListPicker(accountRows, accountCursor);
  } else if (mode === "pick_op_vault") {
    body =
      vaults.length === 0 && filter.trim() === ""
        ? busy
          ? loadingBody
          : emptyBody("No vaults found.")
        : renderListPicker(vaultRows, vaultCursor);
  } else if (mode === "pick_op_item") {
    body =
      items.length === 0 && filter.trim() === ""
        ? busy
          ? loadingBody
          : emptyBody("No items in this vault.")
        : renderListPicker(itemRows, itemCursor);
  } else {
    // pick_op_field — structured, two-column, color-coded grouped list. The
    // selected option's full op:// path is shown on a fixed footer line below.
    body =
      fieldOptions.length === 0 && filter.trim() === ""
        ? busy
          ? loadingBody
          : emptyBody("No importable keys in this item.")
        : renderFieldPicker(fieldOptions, fieldCursor);
  }

  // pick_op_field: the selected option's full op:// path, on ONE fixed line
  // (truncated to fit), so the user always sees exactly what Enter will save.
  const fieldPathLine: ReactNode =
    mode === "pick_op_field" && fieldOptions.length > 0 ? (
      <box marginTop={1}>
        <text>
          <span fg={C.fgMuted}>{"saves: "}</span>
          <span fg={C.dim}>{midTruncate(fieldOptions[fieldCursor]?.value ?? "", dialogW - 16)}</span>
        </text>
      </box>
    ) : null;

  // Footer hint: inputs vs. pickers differ on the first chip.
  const footerHint: ReactNode = (() => {
    if (mode === "input_op_account") {
      return (
        <>
          <span fg={C.green} attributes={A.bold}>
            {"Enter "}
          </span>
          <span fg={C.fgMuted}>{"save · "}</span>
        </>
      );
    }
    if (mode === "input_op_env") {
      return (
        <>
          <span fg={C.green} attributes={A.bold}>
            {"Enter "}
          </span>
          <span fg={C.fgMuted}>{envPreview === null ? "preview · " : "save · "}</span>
        </>
      );
    }
    // The vault/item/field/account list pickers support inline fuzzy filtering —
    // advertise "type to filter". Kind/scope are short menus (no filter).
    const filterable =
      mode === "pick_op_vault" ||
      mode === "pick_op_item" ||
      mode === "pick_op_field" ||
      mode === "pick_op_account";
    return (
      <>
        <span fg={C.fgMuted}>{"↑↓ move · "}</span>
        <span fg={C.green} attributes={A.bold}>
          {"Enter "}
        </span>
        <span fg={C.fgMuted}>{"select · "}</span>
        {filterable && <span fg={C.fgMuted}>{"type to filter · "}</span>}
      </>
    );
  })();

  // Backdrop: full-screen absolute overlay that dims the content and centers
  // the dialog. zIndex lifts it above the normal column flow.
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={width}
      height={height}
      zIndex={100}
      backgroundColor={C.bg}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <box
        width={dialogW}
        border
        borderStyle="rounded"
        borderColor={C.focusBorder}
        title={meta.title}
        titleAlignment="left"
        backgroundColor={C.bgAlt}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
      >
        {/* Step header */}
        <text>
          <span fg={C.cyan} attributes={A.bold}>
            {meta.step}
          </span>
        </text>
        <text>
          <span fg={C.dim}>{meta.help}</span>
        </text>
        {breadcrumb}
        <text>{" "}</text>

        {/* Active step body */}
        {body}

        {/* pick_op_field: fixed "saves: op://…" line (never wraps). */}
        {fieldPathLine}

        {/* Footer hint inside the dialog */}
        <text>{" "}</text>
        <text>
          {footerHint}
          <span fg={C.red} attributes={A.bold}>
            {"Esc "}
          </span>
          <span fg={C.fgMuted}>{"back"}</span>
        </text>
      </box>
    </box>
  );
}
