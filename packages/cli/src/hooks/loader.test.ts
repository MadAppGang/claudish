import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "./engine.js";
import { loadUserHooks, moduleName, resetLoaderForTests, resolveModulePath } from "./loader.js";
import { HookRegistry } from "./registry.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-hooks-loader-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetLoaderForTests();
});

/** Write `name` into `dir` and return its absolute path. */
function write(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source);
  return path;
}

async function load(modules: string[], configDir: string, loadTimeoutMs?: number) {
  const warnings: string[] = [];
  const result = await loadUserHooks({
    modules,
    configDir,
    hostMode: "interactive",
    loadTimeoutMs,
    warn: (l) => warnings.push(l),
  });
  return { ...result, warnings };
}

const VALID = `export default { apiVersion: 1, id: "add", on: { request: () => [] } };`;

describe("loadUserHooks — valid modules", () => {
  it("loads a .ts default export and namespaces its id with the module basename", async () => {
    const dir = tempDir();
    const path = write(dir, "add-marker.ts", VALID);
    const r = await load([path], dir);
    expect(r.errors).toEqual([]);
    expect(r.hooks.map((h) => [h.id, h.module, h.moduleIndex, h.exportIndex])).toEqual([
      ["hook:add-marker/add", path, 0, 0],
    ]);
  });

  it("loads a .js default array, in export order", async () => {
    const dir = tempDir();
    const path = write(
      dir,
      "pair.js",
      `export default [
         { apiVersion: 1, id: "one", on: { sessionIdle: () => [] } },
         { apiVersion: 1, id: "two/sub", order: "pre", on: { responseEnd: () => [] } },
       ];`
    );
    const r = await load([path], dir);
    expect(r.hooks.map((h) => [h.id, h.exportIndex])).toEqual([
      ["hook:pair/one", 0],
      ["hook:pair/two/sub", 1],
    ]);
  });

  it("serves claudish/hooks as a value import and erases a type-only import", async () => {
    const dir = tempDir();
    const value = write(
      dir,
      "value.ts",
      `import { defineHook, act, HOOK_API_VERSION } from "claudish/hooks";
       export default defineHook({
         apiVersion: HOOK_API_VERSION,
         id: "v",
         on: { request: () => [act.injectSystemNote("from value import")] },
       });`
    );
    const typed = write(
      dir,
      "typed.ts",
      `import type { HookDefinition } from "claudish/hooks";
       export default { apiVersion: 1, id: "t", on: { request: () => [] } } satisfies HookDefinition;`
    );
    const r = await load([value, typed], dir);
    expect(r.errors).toEqual([]);
    expect(r.hooks.map((h) => h.id)).toEqual(["hook:value/v", "hook:typed/t"]);
    const out = (r.hooks[0]?.def.on?.request as () => unknown)();
    expect(out).toEqual([{ type: "injectSystemNote", text: "from value import" }]);
  });

  it("resolves a relative path against the config directory, not the cwd", async () => {
    const dir = tempDir();
    write(dir, "hooks/rel.ts", VALID);
    const r = await load(["hooks/rel.ts"], dir);
    expect(r.hooks.map((h) => h.module)).toEqual([join(dir, "hooks/rel.ts")]);
  });

  it("defaults a user hook to fix severity", async () => {
    const dir = tempDir();
    const r = await load([write(dir, "sev.ts", VALID)], dir);
    const engine = new HookEngine({
      registry: new HookRegistry([], r.hooks, undefined),
      config: {},
      hostMode: "other",
      journalSink: () => {},
      drainTelemetryOutbox: false,
    });
    const route = { modelId: "m", provider: "p", native: false };
    expect(engine.select("request", { route })[0]?.severity).toBe("fix");
  });
});

describe("loadUserHooks — rejections", () => {
  it("rejects a wrong or missing apiVersion with the exact message", async () => {
    const dir = tempDir();
    const path = write(
      dir,
      "ver.ts",
      `export default [
         { apiVersion: 2, id: "two", on: { request: () => [] } },
         { id: "none", on: { request: () => [] } },
         { apiVersion: 1, id: "ok", on: { request: () => [] } },
       ];`
    );
    const r = await load([path], dir);
    expect(r.hooks.map((h) => h.id)).toEqual(["hook:ver/ok"]);
    expect(r.warnings).toEqual([
      `hook ${path}#two: apiVersion 2 is not supported (this claudish supports 1)`,
      `hook ${path}#none: apiVersion undefined is not supported (this claudish supports 1)`,
    ]);
  });

  it("rejects a missing id, a bad id, no handlers, and raw without unsafe", async () => {
    const dir = tempDir();
    const path = write(
      dir,
      "bad.ts",
      `export default [
         { apiVersion: 1, on: { request: () => [] } },
         { apiVersion: 1, id: "Bad Id", on: { request: () => [] } },
         { apiVersion: 1, id: "${"x".repeat(65)}", on: { request: () => [] } },
         { apiVersion: 1, id: "empty" },
         { apiVersion: 1, id: "raw", raw: { providerRequest: () => {} } },
         { apiVersion: 1, id: "typo", on: { onRequest: () => [] } },
         { apiVersion: 1, id: "tc", on: { toolCall: { handle: () => [] } } },
       ];`
    );
    const r = await load([path], dir);
    expect(r.hooks).toEqual([]);
    const reasons = r.errors.map((e) => e.reason);
    expect(reasons[0]).toBe("#0: id is missing");
    expect(reasons[1]).toContain('id "Bad Id" does not match');
    expect(reasons[2]).toContain("longer than 64");
    expect(reasons[3]).toBe("empty: declares no handler in on or raw");
    expect(reasons[4]).toBe("raw: raw requires unsafe: true");
    expect(reasons[5]).toBe("typo: on.onRequest is not a hook event");
    expect(reasons[6]).toBe("tc: on.toolCall.tools must be a non-empty array of tool names");
  });

  it("rejects a declared async providerChunk at load and keeps its sibling", async () => {
    const dir = tempDir();
    const path = write(
      dir,
      "chunky.ts",
      `export default [
         { apiVersion: 1, id: "async-chunk", unsafe: true, raw: { async providerChunk() {} } },
         { apiVersion: 1, id: "sync-chunk", unsafe: true, raw: { providerChunk() {} } },
       ];`
    );
    const r = await load([path], dir);
    expect(r.hooks.map((h) => h.id)).toEqual(["hook:chunky/sync-chunk"]);
    expect(r.warnings).toContain(
      `hook ${path}#async-chunk: raw.providerChunk must be synchronous (it runs on the parser's loop)`
    );
    expect(r.warnings).toContain(
      "hook hook:chunky/sync-chunk is UNSAFE (raw middleware): it receives live request and response objects"
    );
  });

  it("skips a module that throws on import, and one with no default export", async () => {
    const dir = tempDir();
    const thrower = write(dir, "thrower.ts", `throw new Error("import exploded");`);
    const named = write(dir, "named.ts", `export const hook = { apiVersion: 1, id: "x" };`);
    const ok = write(dir, "ok.ts", VALID);
    const r = await load([thrower, named, ok], dir);
    expect(r.hooks.map((h) => h.id)).toEqual(["hook:ok/add"]);
    expect(r.warnings).toEqual([
      `hook module ${thrower} skipped: import exploded`,
      `hook module ${named} skipped: no default export`,
    ]);
  });

  it("skips a missing file with a warning naming it", async () => {
    const dir = tempDir();
    const missing = join(dir, "nope.ts");
    const r = await load([missing], dir);
    expect(r.hooks).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]?.startsWith(`hook module ${missing} skipped:`)).toBe(true);
  });

  it("times out a module whose top-level await never settles", async () => {
    const dir = tempDir();
    const hung = write(dir, "hung.ts", "await new Promise(() => {}); export default {};");
    const ok = write(dir, "after.ts", VALID);
    const t0 = performance.now();
    const r = await load([hung, ok], dir, 150);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(r.warnings).toEqual([`hook module ${hung} skipped: load timed out after 150 ms`]);
    expect(r.hooks.map((h) => h.id)).toEqual(["hook:after/add"]);
  });

  it("keeps the first of two hooks with the same id in one module", async () => {
    const dir = tempDir();
    const path = write(
      dir,
      "dup.ts",
      `export default [
         { apiVersion: 1, id: "same", description: "first", on: { request: () => [] } },
         { apiVersion: 1, id: "same", description: "second", on: { request: () => [] } },
       ];`
    );
    const r = await load([path], dir);
    expect(r.hooks.map((h) => h.def.description)).toEqual(["first"]);
    expect(r.warnings).toEqual([
      `hook ${path}#same: duplicate id hook:dup/same, keeping the first`,
    ]);
  });

  it("skips the later of two modules sharing a basename, whole", async () => {
    const dir = tempDir();
    const a = write(dir, "a/ping.ts", VALID);
    const b = write(
      dir,
      "b/ping.js",
      `export default [{ apiVersion: 1, id: "other", on: { request: () => [] } }];`
    );
    const r = await load([a, b], dir);
    expect(r.hooks.map((h) => [h.id, h.module])).toEqual([["hook:ping/add", a]]);
    expect(r.warnings).toEqual([
      `hook module ${b} skipped: its name "ping" is already used by ${a}; rename one`,
    ]);
  });
});

describe("paths", () => {
  it("expands ~ and resolves relative paths against the config dir", () => {
    expect(resolveModulePath("~/.claudish/hooks/p.ts", "/cfg")).toBe(
      join(homedir(), ".claudish/hooks/p.ts")
    );
    expect(resolveModulePath("hooks/p.ts", "/cfg")).toBe("/cfg/hooks/p.ts");
    expect(resolveModulePath("/abs/p.ts", "/cfg")).toBe("/abs/p.ts");
  });

  it("names a module by its basename without the extension", () => {
    expect(moduleName("/x/add-marker.ts")).toBe("add-marker");
    expect(moduleName("/x/ping.test.js")).toBe("ping.test");
  });
});

describe("hook output stays off stdout (spawned process)", () => {
  const HELPER = join(import.meta.dir, "test-helpers", "capture-child.ts");
  const NOISY = `
    console.log("IMPORT-LOG");
    process.stdout.write("IMPORT-WRITE\\n");
    setTimeout(() => { console.log("IMPORT-TIMER"); }, 20);
    export default {
      apiVersion: 1,
      id: "noisy",
      on: {
        request: async () => {
          console.log("HANDLER-LOG");
          console.error("HANDLER-ERR");
          setTimeout(() => { process.stdout.write("HANDLER-TIMER\\n"); }, 20);
          await Bun.sleep(5);
          console.info("HANDLER-AFTER-AWAIT");
          return [];
        },
      },
    };`;

  it("routes import-time, handler and timer output to the debug log", async () => {
    const dir = tempDir();
    const mod = write(dir, "noisy.ts", NOISY);
    const proc = Bun.spawn(["bun", HELPER, "interactive", mod], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(stdout).toBe("");
    const report = JSON.parse(stderr.slice(stderr.indexOf("REPORT ") + 7).split("\n")[0] ?? "{}");
    expect(report.hooks).toEqual(["hook:noisy/noisy"]);
    expect(report.statuses).toEqual(["ok"]);
    expect(stderr).not.toContain("HANDLER-ERR");

    const logs = readdirSync(join(dir, "logs"));
    const log = readFileSync(join(dir, "logs", logs[0] as string), "utf8");
    expect(log).toContain(`[hook ${mod}] IMPORT-LOG`);
    expect(log).toContain(`[hook ${mod}] IMPORT-WRITE`);
    expect(log).toContain(`[hook ${mod}] IMPORT-TIMER`);
    expect(log).toContain("[hook hook:noisy/noisy] HANDLER-LOG");
    expect(log).toContain("[hook hook:noisy/noisy] HANDLER-ERR");
    expect(log).toContain("[hook hook:noisy/noisy] HANDLER-TIMER");
    expect(log).toContain("[hook hook:noisy/noisy] HANDLER-AFTER-AWAIT");
  });

  it("positive control: the same module imported without the loader writes to stdout", async () => {
    const dir = tempDir();
    const mod = write(dir, "noisy.ts", NOISY);
    const proc = Bun.spawn(
      ["bun", "-e", `await import(${JSON.stringify(mod)}); await Bun.sleep(100);`],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("IMPORT-LOG");
    expect(stdout).toContain("IMPORT-TIMER");
  });
});
