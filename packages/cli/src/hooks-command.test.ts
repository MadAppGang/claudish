/**
 * `claudish hooks list|check|init|telemetry` (§4.9), spawned as the real CLI
 * entry with a generated HOME and a `CLAUDISH_CONFIG` override, so the
 * developer's config is never read or written.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ROOT = join(import.meta.dir, "..");
const ENTRY = join(import.meta.dir, "index.ts");
const root = mkdtempSync(join(tmpdir(), "claudish-hooks-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function sandbox(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(root, `s${++seq}-`));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { dir, configPath };
}

function run(args: string[], configPath: string, cwd = CLI_ROOT) {
  const proc = Bun.spawnSync(["bun", "--no-env-file", ENTRY, "hooks", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(root, "home"),
      CLAUDISH_CONFIG: configPath,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      NO_COLOR: "1",
    },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe("claudish hooks list --json", () => {
  it("prints every hook in effective order, then load errors and the behavior flag", () => {
    const { dir, configPath } = sandbox({});
    const good = writeModule(
      dir,
      "marker.ts",
      `export default { apiVersion: 1, id: "add", on: { responseEnd: () => [] } };`
    );
    const bad = writeModule(dir, "broken.ts", `export default { apiVersion: 2, id: "x" };`);
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: { modules: [good, bad], severity: { "hook:marker/*": "warn" } },
        behavior: { rules: {} },
      })
    );

    const r = run(["list", "--json"], configPath);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.apiVersion).toBe(1);
    expect(out.configFile).toBe(configPath);
    expect(out.hooks.map((h: any) => h.id)).toEqual([
      "gemini/thought-signature",
      "plan-mode/plan-file-path",
      "session-context/no-harness-echo",
      "observer/divergence",
      "hook:marker/add",
    ]);
    expect(out.hooks[0]).toEqual({
      id: "gemini/thought-signature",
      source: "builtin",
      events: ["raw.providerRequest", "raw.providerChunk", "raw.providerStreamEnd"],
      defaultSeverity: "fix",
      severity: "fix",
      routes: "all",
      models: ["*gemini*", "*google/*"],
      catalogSelection: { wireApis: ["gemini"], vendors: ["google"] },
      order: "pre",
      unsafe: true,
    });
    expect(out.hooks[1]).toMatchObject({
      id: "plan-mode/plan-file-path",
      events: ["request", "toolCall"],
      routes: "foreign",
      unsafe: false,
    });
    expect(out.hooks[4]).toMatchObject({
      id: "hook:marker/add",
      source: "user",
      defaultSeverity: "fix",
      severity: "warn",
    });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].module).toBe(bad);
    expect(out.errors[0].reason).toContain("apiVersion 2 is not supported");
    expect(out.behaviorConfigFound).toBe(true);
  });
});

describe("claudish hooks check", () => {
  it("exits 0 for a valid module", () => {
    const { dir, configPath } = sandbox({});
    const path = writeModule(
      dir,
      "ok.ts",
      `export default { apiVersion: 1, id: "ok", on: { request: () => [] } };`
    );
    const r = run(["check", path, "--json"], configPath);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.valid).toBe(true);
    expect(out.hooks.map((h: any) => h.id)).toEqual(["hook:ok/ok"]);
  });

  it("X-3: exits 1 and names the rule for a declared async providerChunk", () => {
    const { dir, configPath } = sandbox({});
    const path = writeModule(
      dir,
      "twohooks.ts",
      `export default [
        { apiVersion: 1, id: "async-one", unsafe: true, raw: { async providerChunk() {} } },
        { apiVersion: 1, id: "sync-one", unsafe: true, raw: { providerChunk() {} } },
      ];`
    );
    const r = run(["check", path], configPath);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("raw.providerChunk must be synchronous");
  });

  it("exits 1 for a missing file argument", () => {
    const { configPath } = sandbox({});
    expect(run(["check"], configPath).code).toBe(1);
  });
});

describe("claudish hooks init", () => {
  it("writes the example and the ambient types, refuses to overwrite, and the example checks", () => {
    const { dir, configPath } = sandbox({});
    const target = join(dir, "hooks");
    const first = run(["init", target], configPath);
    expect(first.code).toBe(0);
    expect(existsSync(join(target, "example-hook.ts"))).toBe(true);
    const dts = readFileSync(join(target, "claudish-hooks.d.ts"), "utf8");
    expect(dts).toContain('declare module "claudish/hooks"');
    expect(dts).toContain("export const HOOK_API_VERSION = 1;");

    const again = run(["init", target], configPath);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists");

    expect(run(["check", join(target, "example-hook.ts")], configPath).code).toBe(0);
  });

  it("the ambient declaration type-checks the example with nothing installed", () => {
    const { dir, configPath } = sandbox({});
    const target = join(dir, "typed");
    expect(run(["init", target], configPath).code).toBe(0);
    // A project of its own, with no ambient types at all: only the reference
    // to claudish-hooks.d.ts can satisfy `import type … from "claudish/hooks"`.
    writeFileSync(
      join(target, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          types: [],
        },
        files: ["example-hook.ts"],
      })
    );
    const tsc = join(CLI_ROOT, "node_modules", ".bin", "tsc");
    const proc = Bun.spawnSync([tsc, "-p", join(target, "tsconfig.json")], { cwd: target });
    expect(proc.stdout.toString() + proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });
});

describe("claudish hooks telemetry", () => {
  it("--enable writes hooks.telemetry.enabled into the active config and keeps other keys", () => {
    const { configPath } = sandbox({ defaultProvider: "openrouter", hooks: { modules: [] } });
    const r = run(["telemetry", "--enable", "--json"], configPath);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).enabled).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved).toEqual({
      defaultProvider: "openrouter",
      hooks: { modules: [], telemetry: { enabled: true } },
    });

    const off = run(["telemetry", "--disable", "--json"], configPath);
    expect(JSON.parse(off.stdout).enabled).toBe(false);
  });
});

describe("generated ambient declaration", () => {
  it("src/hooks/ambient-dts.generated.ts matches public.ts", () => {
    const proc = Bun.spawnSync(["bun", "run", "scripts/generate-hooks-dts.ts", "--check"], {
      cwd: CLI_ROOT,
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });
});
