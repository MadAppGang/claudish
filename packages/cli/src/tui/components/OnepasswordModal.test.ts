/**
 * Tests for buildFieldOptions — the pure field-picker option builder in
 * OnepasswordModal.tsx. These exercise the GROUPING + the two ★ rows across the
 * three item shapes (no-sections / all-sectioned / mixed). No secrets here: the
 * DiscoveredField inputs are field METADATA (labels/sections/types) — no secret
 * values — so structural fixtures are appropriate (the no-handcraft rule targets
 * secret-like fixtures, which these aren't).
 *
 * buildFieldOptions is a plain function (no JSX), so importing it from the
 * OpenTUI component module is safe — the @jsxImportSource pragma only affects JSX.
 */

import { describe, expect, test } from "bun:test";
import { buildFieldOptions } from "./OnepasswordModal.js";
import type { DiscoveredField } from "../../providers/onepassword.js";

const V = "Vault";
const I = "Item";

/** A concealed, valid-env-name (importable) field, optionally in a section. */
function key(label: string, section: string | null): DiscoveredField {
  return {
    label,
    section,
    reference: `op://${V}/${I}/${section ? `${section}/` : ""}${label}`,
    type: "Concealed",
    hasValue: true,
    valueTail: "1234",
  };
}

/** A non-importable field (wrong type or invalid env-var name). */
function noise(label: string, section: string | null): DiscoveredField {
  return {
    label,
    section,
    reference: `op://${V}/${I}/${section ? `${section}/` : ""}${label}`,
    type: "STRING",
    hasValue: true,
    valueTail: "",
  };
}

/** Star rows (the "everything*" roles) as `${left} → ${value}`. */
function stars(fields: DiscoveredField[]): string[] {
  return buildFieldOptions(V, I, fields)
    .filter((o) => o.role === "everything-all" || o.role === "everything")
    .map((o) => `${o.left} → ${o.value}`);
}

describe("buildFieldOptions — ★ all-keys rows per item shape", () => {
  test("no-sections item → ONE star: All keys in this item (**), no top-level star", () => {
    const fields = [key("FOO_API_KEY", null), key("BAR_API_KEY", null), noise("notes", null)];
    expect(stars(fields)).toEqual([`★ All keys in this item → op://${V}/${I}/**`]);
  });

  test("all-sectioned item → ONE star: All keys in this item (**)", () => {
    const fields = [
      key("OPENAI_API_KEY", "OpenAI"),
      key("MOONSHOT_API_KEY", "Moonshot Kimi"),
      key("KIMI_CODING_API_KEY", "Moonshot Kimi"),
    ];
    expect(stars(fields)).toEqual([`★ All keys in this item → op://${V}/${I}/**`]);
  });

  test("MIXED item → TWO distinct stars: ** (all) AND * (top-level only)", () => {
    const fields = [key("OPENAI_API_KEY", "OpenAI"), key("TOPLEVEL_API_KEY", null)];
    expect(stars(fields)).toEqual([
      `★ All keys in this item → op://${V}/${I}/**`,
      `★ All top-level keys → op://${V}/${I}/*`,
    ]);
  });

  test("no importable fields → NO star rows", () => {
    const fields = [noise("notes", null), noise("username", "Login")];
    expect(stars(fields)).toEqual([]);
  });

  test("★ All keys count reflects ONLY importable fields", () => {
    const fields = [
      key("OPENAI_API_KEY", "OpenAI"),
      key("GEMINI_API_KEY", "Google"),
      noise("credential", "OpenAI"), // wrong type → not counted
      noise("not a name", null), // invalid env name → not counted
    ];
    const all = buildFieldOptions(V, I, fields).find((o) => o.role === "everything-all");
    expect(all?.name).toContain("(2,");
  });
});

describe("buildFieldOptions — key rows + per-section globs", () => {
  test("each importable field becomes a 'field' row tagged with its section", () => {
    const fields = [key("OPENAI_API_KEY", "OpenAI"), key("TOPLEVEL_API_KEY", null)];
    const rows = buildFieldOptions(V, I, fields).filter((o) => o.role === "field");
    const byLeft = Object.fromEntries(rows.map((r) => [r.left, r.right]));
    expect(byLeft["OPENAI_API_KEY"]).toBe("OpenAI");
    expect(byLeft["TOPLEVEL_API_KEY"]).toBe(""); // sectionless → no tag
  });

  test("a multi-key section gets one '↳ all of <section>' glob; single-key sections do not", () => {
    const fields = [
      key("OPENAI_API_KEY", "OpenAI"), // single-key section
      key("MOONSHOT_API_KEY", "Moonshot Kimi"), // multi-key section
      key("KIMI_CODING_API_KEY", "Moonshot Kimi"),
    ];
    const sectionGlobs = buildFieldOptions(V, I, fields)
      .filter((o) => o.role === "section-glob")
      .map((o) => o.value);
    expect(sectionGlobs).toEqual([`op://${V}/${I}/Moonshot Kimi/*`]);
  });

  test("non-importable fields are hidden entirely", () => {
    const fields = [key("OPENAI_API_KEY", "OpenAI"), noise("credential", "OpenAI")];
    const keyRows = buildFieldOptions(V, I, fields)
      .filter((o) => o.role === "field")
      .map((o) => o.left);
    expect(keyRows).toEqual(["OPENAI_API_KEY"]);
  });
});
