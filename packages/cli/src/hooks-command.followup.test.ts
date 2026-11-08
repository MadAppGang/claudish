/**
 * F4.1: `claudish hooks list` describes the selection that actually applies to
 * `gemini/thought-signature`.
 *
 * Contract (spec F4.1 and the selection rule pinned in hooks/raw.test.ts): with a catalog
 * connection the built-in is selected by the connection's wire (`gemini`) or vendor
 * (`google`); without one, by the model-name globs (`*gemini*`, `*google/*`). The listing
 * must say both, because either can be what applies on a given route.
 *
 * Blind to the exact wording and JSON key names: the assertions look for the facts
 * (the words wire and vendor, the values gemini and google, and the name globs), not a layout.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "index.ts");
const root = mkdtempSync(join(tmpdir(), "claudish-hooks-list-followup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function list(extra: string[] = []) {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({}));
  const proc = Bun.spawnSync(["bun", "--no-env-file", ENTRY, "hooks", "list", ...extra], {
    cwd: join(import.meta.dir, ".."),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      CLAUDISH_CONFIG: configPath,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      NO_COLOR: "1",
    },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** The text of the gemini/thought-signature entry, up to the next hook id. */
function geminiSection(text: string): string {
  const start = text.indexOf("gemini/thought-signature");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + "gemini/thought-signature".length);
  const next = rest.search(/plan-mode\/plan-file-path|session-context\/|observer\/divergence/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("F4.1 hooks list describes the gemini built-in's real selection", () => {
  it("F4.1-a text listing names the catalog selection (wire gemini, vendor google) and the name globs", () => {
    const r = list();
    expect(r.code).toBe(0);
    const section = geminiSection(r.stdout);
    expect(section).toMatch(/wire/i);
    expect(section).toMatch(/vendor/i);
    expect(section).toContain("gemini");
    expect(section).toContain("google");
    expect(section).toContain("*gemini*");
    expect(section).toContain("*google/*");
  });

  it("F4.1-b --json: the entry still carries the name globs and also exposes wire and vendor", () => {
    const r = list(["--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    const entry = out.hooks.find((h: { id: string }) => h.id === "gemini/thought-signature");
    expect(entry).toBeDefined();
    expect(entry.models).toEqual(expect.arrayContaining(["*gemini*", "*google/*"]));
    const serialized = JSON.stringify(entry);
    expect(serialized).toMatch(/wire/i);
    expect(serialized).toMatch(/vendor/i);
    expect(serialized).toContain("google");
  });

  it("F4.1-c a hook selected by name only (plan-mode) is not described with wire or vendor", () => {
    const r = list(["--json"]);
    const out = JSON.parse(r.stdout);
    const entry = out.hooks.find((h: { id: string }) => h.id === "plan-mode/plan-file-path");
    expect(JSON.stringify(entry)).not.toMatch(/vendor/i);
  });
});
