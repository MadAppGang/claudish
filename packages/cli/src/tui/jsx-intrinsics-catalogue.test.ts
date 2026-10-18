import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { getComponentCatalogue } from "@opentui/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard: every lowercase (intrinsic) JSX tag under src/tui (.tsx files, recursive)
 * must be a key of the opentui runtime component catalogue — the same lookup the
 * reconciler does before
 * throwing `Unknown component type`, which kills the whole TUI render.
 *
 * tsc cannot catch this class: an unknown lowercase JSX tag is typed `any`
 * (TS2322 fires on unknown *props*, never on an unknown lowercase tag name).
 * This guard exists because the first bold-conversion attempt (#511, initial push)
 * wrote `<sb>`/`</sb>` on 83 sites — typecheck-clean, build-clean, blank TUI.
 */
describe("TUI JSX intrinsics are in the opentui catalogue", () => {
  test("every lowercase JSX tag used in src/tui resolves in getComponentCatalogue()", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);

    // tag -> { file -> count }
    const used = new Map<string, Map<string, number>>();
    for (const f of files) {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: unknown): void => {
        if (!n || typeof (n as ts.Node).kind !== "number") return;
        const node = n as ts.Node;
        // TS 5.9: JsxElement carries tagName on its openingElement, not directly.
        const el = ts.isJsxElement(node)
          ? node.openingElement?.tagName
          : ts.isJsxSelfClosingElement(node)
            ? node.tagName
            : null;
        if (el && ts.isIdentifier(el) && !/^[A-Z]/.test(el.text)) {
          const perFile = used.get(el.text) ?? new Map<string, number>();
          perFile.set(f, (perFile.get(f) ?? 0) + 1);
          used.set(el.text, perFile);
        }
        ts.forEachChild(node, visit as ts.Visitor);
      };
      visit(sf);
    }

    const catalogue = new Set(Object.keys(getComponentCatalogue()));
    const unknown = [...used.entries()].filter(([tag]) => !catalogue.has(tag));
    if (unknown.length > 0) {
      const detail = unknown
        .map(([tag, perFile]) => {
          const sites = [...perFile.entries()].map(([f, c]) => `${f} ×${c}`).join(", ");
          return `<${tag}> (${[...perFile.values()].reduce((a, b) => a + b, 0)} sites: ${sites})`;
        })
        .join("; ");
      throw new Error(
        `Lowercase JSX tags outside the opentui component catalogue (reconciler would throw "Unknown component type", blank TUI): ${detail}. Catalogue: ${[...catalogue].sort().join(" ")}.`,
      );
    }
  });
});
