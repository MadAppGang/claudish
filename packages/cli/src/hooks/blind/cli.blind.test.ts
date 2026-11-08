import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace, hook } from "./support.ts";

const workspaces: Workspace[] = [];
function workspace() {
  const ws = new Workspace();
  workspaces.push(ws);
  ws.save({ hooks: {} });
  return ws;
}
afterEach(async () => {
  for (const ws of workspaces.splice(0)) await ws.close();
});

interface ListedHook {
  id: string;
  source: string;
  events: string[];
  defaultSeverity: string;
  severity: string;
  routes: string;
  models: string[];
  order: string;
  unsafe: boolean;
}
interface Listed {
  apiVersion: number;
  configFile: string;
  hooks: ListedHook[];
  errors: Array<{ module: string; reason: string }>;
  behaviorConfigFound: boolean;
}
async function list(ws: Workspace): Promise<Listed> {
  const result = await ws.cli(["hooks", "list", "--json"]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as Listed;
  expect(Object.keys(parsed).sort()).toEqual([
    "apiVersion",
    "behaviorConfigFound",
    "configFile",
    "errors",
    "hooks",
  ]);
  expect({ apiVersion: parsed.apiVersion, configFile: parsed.configFile }).toEqual({
    apiVersion: 1,
    configFile: ws.configFile,
  });
  return parsed;
}

describe("FR-1 / FR-7 / FR-10 CLI and module loading (§4.1–4.3, §4.9)", () => {
  for (const extension of ["ts", "js"]) {
    test(`L-1/L-2 ${extension} default hook loads with exact metadata and valid check exit`, async () => {
      const ws = workspace();
      const file = ws.module(`sample.${extension}`, hook("request() { return []; }"));
      ws.save({ hooks: { modules: [file] } });
      const result = await list(ws);
      expect(result.hooks.filter((h) => h.id.startsWith("hook:"))).toEqual([
        {
          id: "hook:sample/test",
          source: expect.any(String),
          events: ["request"],
          defaultSeverity: "fix",
          severity: "fix",
          routes: "all",
          models: ["*"],
          order: "normal",
          unsafe: false,
        },
      ]);
      expect(result.errors).toEqual([]);
      expect(result.behaviorConfigFound).toBe(false);
      expect((await ws.cli(["hooks", "check", file])).code).toBe(0);
    }, 20000);
  }

  test("L-3 default array preserves export order and built-in hook ids", async () => {
    const ws = workspace();
    const file = ws.module(
      "array.ts",
      `export default [
      {apiVersion:1,id:"first",on:{request(){return []}}},
      {apiVersion:1,id:"second",on:{responseEnd(){return []}}}
    ];`
    );
    ws.save({ hooks: { modules: [file] } });
    const result = await list(ws);
    expect(result.hooks.filter((h) => h.id.startsWith("hook:")).map((h) => h.id)).toEqual([
      "hook:array/first",
      "hook:array/second",
    ]);
    for (const id of [
      "plan-mode/plan-file-path",
      "session-context/no-harness-echo",
      "gemini/thought-signature",
      "observer/divergence",
    ]) {
      expect(result.hooks.find((h) => h.id === id)?.source).toBe("builtin");
    }
  }, 20000);

  test("L-4 author value imports resolve without installing a separate hooks module", async () => {
    const ws = workspace();
    const file = ws.module(
      "author.ts",
      `import {act,defineHook} from "claudish/hooks";
      const action = act.injectSystemNote("VALUE-IMPORT");
      if (action.type !== "injectSystemNote" || action.text !== "VALUE-IMPORT") throw new Error("bad action constructor");
      export default defineHook({apiVersion:1,id:"author",on:{request(){return [action]}}});`
    );
    expect((await ws.cli(["hooks", "check", file, "--json"])).code).toBe(0);
    ws.save({ hooks: { modules: [file] } });
    expect((await list(ws)).hooks.filter((h) => h.id.startsWith("hook:")).map((h) => h.id)).toEqual(
      ["hook:author/author"]
    );
  }, 20000);

  const invalid = [
    ["L-5 missing apiVersion", `export default {id:"test",on:{request(){}}};`, "apiVersion"],
    [
      "L-5 wrong apiVersion",
      `export default {apiVersion:2,id:"test",on:{request(){}}};`,
      "apiVersion 2 is not supported",
    ],
    ["L-6 missing id", "export default {apiVersion:1,on:{request(){}}};", "id"],
    ["L-6 uppercase id", `export default {apiVersion:1,id:"Upper",on:{request(){}}};`, "id"],
    [
      "L-6 id exceeds 64 chars",
      `export default {apiVersion:1,id:"${"a".repeat(65)}",on:{request(){}}};`,
      "id",
    ],
    [
      "L-7 raw without unsafe",
      `export default {apiVersion:1,id:"test",raw:{providerChunk(){}}};`,
      "unsafe",
    ],
    [
      "L-8/X-3 async providerChunk",
      `export default {apiVersion:1,id:"test",unsafe:true,raw:{async providerChunk(){}}};`,
      "raw.providerChunk must be synchronous",
    ],
    [
      "L-9 no default export",
      `export const named = {apiVersion:1,id:"test",on:{request(){}}};`,
      "default",
    ],
    ["L-9 primitive export", `export default "not a hook";`, "hook"],
    [
      "L-10 unknown old event",
      `export default {apiVersion:1,id:"test",on:{onRequest(){}}};`,
      "onRequest",
    ],
    ["L-10 no handler", `export default {apiVersion:1,id:"test"};`, "handler"],
    ["L-11 throwing import", `throw new Error("IMPORT-FAIL"); export default {};`, "IMPORT-FAIL"],
  ];
  for (const [scenario, code, diagnostic] of invalid) {
    test(`${scenario} exits check 1, reports the cause, and does not block a valid sibling`, async () => {
      const ws = workspace();
      const bad = ws.module("bad.ts", code!);
      const good = ws.module("good.ts", hook("request(){return []}"));
      const check = await ws.cli(["hooks", "check", bad]);
      expect(check.code).toBe(1);
      expect(check.stdout + check.stderr).toContain(diagnostic!);
      ws.save({ hooks: { modules: [bad, good] } });
      const result = await list(ws);
      expect(result.hooks.filter((h) => h.id.startsWith("hook:")).map((h) => h.id)).toEqual([
        "hook:good/test",
      ]);
      expect(result.errors.some((e) => e.module === bad && e.reason.includes(diagnostic!))).toBe(
        true
      );
    }, 30000);
  }

  test("L-12 nonexistent module is reported but hooks list still exits zero", async () => {
    const ws = workspace();
    const missing = join(ws.layout.tmp, "does-not-exist.ts");
    ws.save({ hooks: { modules: [missing] } });
    const result = await list(ws);
    expect(result.errors.map((e) => e.module)).toEqual([missing]);
    expect(result.hooks.filter((h) => h.id.startsWith("hook:"))).toEqual([]);
  }, 20000);

  test("L-13 duplicate effective id keeps only the first hook", async () => {
    const ws = workspace();
    const file = ws.module(
      "dup.ts",
      `export default [
      {apiVersion:1,id:"same",on:{request(){}}},
      {apiVersion:1,id:"same",on:{responseEnd(){}}}
    ];`
    );
    ws.save({ hooks: { modules: [file] } });
    const p = await ws.cli(["hooks", "list", "--json"]);
    const result = JSON.parse(p.stdout) as Listed;
    expect(p.code).toBe(0);
    expect(result.hooks.filter((h) => h.id === "hook:dup/same").map((h) => h.events)).toEqual([
      ["request"],
    ]);
    // L-13: §4.9 — `hooks list` reports load problems in `errors`; the duplicate is named there.
    expect(result.errors.map((e) => e.module)).toEqual([file]);
  }, 20000);

  test("L-14 basename collision skips the later module whole and names both paths", async () => {
    const ws = workspace();
    const earlier = ws.module("a/ping.ts", hook("request(){}"));
    const later = ws.module(
      "b/ping.js",
      `export default [{apiVersion:1,id:"different",on:{responseEnd(){}}}];`
    );
    ws.save({ hooks: { modules: [earlier, later] } });
    const result = await list(ws);
    expect(result.hooks.filter((h) => h.id.startsWith("hook:")).map((h) => h.id)).toEqual([
      "hook:ping/test",
    ]);
    expect(result.errors).toEqual([
      { module: later, reason: expect.stringContaining("already used") },
    ]);
    expect(result.errors[0]!.reason).toContain(earlier);
  }, 20000);

  test("L-15 relative module path resolves against config directory rather than cwd", async () => {
    const ws = workspace();
    ws.file("config/hooks/relative.ts", hook("request(){}"));
    ws.save({ hooks: { modules: ["hooks/relative.ts"] } });
    const result = await list(ws);
    expect(result.hooks.filter((h) => h.id === "hook:relative/test").map((h) => h.events)).toEqual([
      ["request"],
    ]);
    expect(result.errors).toEqual([]);
  }, 20000);

  test("L-16 a hook: severity key is unscoped and exact id beats shorter globs", async () => {
    const ws = workspace();
    const file = ws.module("sample.ts", hook("request(){}"));
    ws.save({
      hooks: {
        modules: [file],
        severity: { "*": "off", "hook:sample/*": "warn", "hook:sample/test": "fix" },
      },
    });
    expect((await list(ws)).hooks.find((h) => h.id === "hook:sample/test")?.severity).toBe("fix");
  }, 20000);

  for (const badHooks of [
    { modules: [123] },
    { modules: [], severity: { "*": "enforce" } },
    { modules: [], injection: { maxConsecutive: 0 } },
    { modules: [], injection: { maxConsecutive: 21 } },
    { modules: [], observer: { enabled: true, mode: "enforce" } },
  ]) {
    test(`L-17 invalid hooks ${JSON.stringify(badHooks)} warns and runs defaults`, async () => {
      const ws = workspace();
      ws.save({ hooks: badHooks });
      const result = await ws.cli(["hooks", "list", "--json"]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("[claudish] hooks config:");
      const parsed = JSON.parse(result.stdout) as Listed;
      expect(parsed.hooks.filter((h) => h.id.startsWith("hook:"))).toEqual([]);
      expect(parsed.hooks.find((h) => h.id === "plan-mode/plan-file-path")?.severity).toBe("fix");
    }, 20000);
  }

  test("L-18 old behavior is reported once, not executed, and not rewritten on read", async () => {
    const ws = workspace();
    const executed = join(ws.layout.tmp, "old-imported");
    const old = ws.module(
      "old.ts",
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(executed)}, "WRONG"); export default {};`
    );
    ws.save({
      behavior: {
        rules: { "*": "off" },
        hooks: [old],
        observer: { enabled: true },
        telemetry: { enabled: true },
        preset: "old",
      },
      hooks: {},
    });
    const before = readFileSync(ws.configFile, "utf8");
    const result = await ws.cli(["hooks", "list", "--json"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as Listed).behaviorConfigFound).toBe(true);
    expect(existsSync(executed)).toBe(false);
    expect(
      (result.stderr.match(/the "behavior" config block is no longer read/g) ?? []).length
    ).toBe(1);
    for (const key of [
      "behavior.rules",
      "hooks.severity",
      "behavior.hooks",
      "hooks.modules",
      "apiVersion: 1",
      "behavior.observer",
      "hooks.observer",
      "behavior.telemetry",
      "hooks.telemetry",
      "behavior.preset",
    ])
      expect(result.stderr).toContain(key);
    expect(readFileSync(ws.configFile, "utf8")).toBe(before);
  }, 20000);

  test("L-19 init writes a loadable example and declaration, then preserves both on refusal", async () => {
    const ws = workspace();
    const dir = join(ws.layout.tmp, "author-hooks");
    expect((await ws.cli(["hooks", "init", dir])).code).toBe(0);
    const example = join(dir, "example-hook.ts");
    const types = join(dir, "claudish-hooks.d.ts");
    const before = [readFileSync(example, "utf8"), readFileSync(types, "utf8")];
    expect(before[0]).toContain("apiVersion: 1");
    expect(before[1]).toContain("HookDefinition");
    expect((await ws.cli(["hooks", "check", example])).code).toBe(0);
    expect((await ws.cli(["hooks", "init", dir])).code).toBe(1);
    expect([readFileSync(example, "utf8"), readFileSync(types, "utf8")]).toEqual(before);
  }, 30000);

  for (const filename of ["example-hook.ts", "claudish-hooks.d.ts"]) {
    test(`L-20 init refuses when only ${filename} exists and preserves its bytes`, async () => {
      const ws = workspace();
      const dir = join(ws.layout.tmp, "existing-hooks");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, filename);
      writeFileSync(file, "DO-NOT-OVERWRITE\n");
      expect((await ws.cli(["hooks", "init", dir])).code).toBe(1);
      expect(readFileSync(file, "utf8")).toBe("DO-NOT-OVERWRITE\n");
    }, 20000);
  }

  test("L-21 telemetry requires explicit new consent and preserves old block on save", async () => {
    const ws = workspace();
    const behavior = { telemetry: { enabled: true } };
    ws.save({ behavior, hooks: { modules: [], severity: { "*": "off" } } });
    const before = readFileSync(ws.configFile, "utf8");
    expect((await ws.cli(["hooks", "telemetry"])).code).toBe(0);
    expect(readFileSync(ws.configFile, "utf8")).toBe(before);
    expect((await ws.cli(["hooks", "telemetry", "--enable"])).code).toBe(0);
    const enabled = JSON.parse(readFileSync(ws.configFile, "utf8"));
    expect({
      consent: enabled.hooks.telemetry.enabled,
      old: enabled.behavior,
      severity: enabled.hooks.severity,
    }).toEqual({ consent: true, old: behavior, severity: { "*": "off" } });
    expect((await ws.cli(["hooks", "telemetry", "--disable"])).code).toBe(0);
    expect(JSON.parse(readFileSync(ws.configFile, "utf8")).hooks.telemetry.enabled).toBe(false);
  }, 30000);

  test("L-22 project hooks are ignored and reported without importing repository code", async () => {
    const ws = workspace();
    const marker = join(ws.layout.tmp, "project-hook-executed");
    const mod = ws.module(
      "project.ts",
      `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)}, "BAD");${hook("request(){}")}`
    );
    writeFileSync(join(ws.layout.home, ".claudish", "config.json"), JSON.stringify({ hooks: {} }));
    const project = join(ws.layout.cwd, ".claudish.json");
    writeFileSync(project, JSON.stringify({ hooks: { modules: [mod] } }));
    const p = ws.spawn(["hooks", "list", "--json"]);
    expect(await p.finish()).toBe(0);
    expect(p.stderr).toContain(
      `[claudish] hooks in ${project} ignored: hooks are read from the global config only`
    );
    expect((JSON.parse(p.stdout) as Listed).hooks.filter((h) => h.id.startsWith("hook:"))).toEqual(
      []
    );
    expect(existsSync(marker)).toBe(false);
  }, 20000);

  test("L-23 cwd .env cannot select the hooks config, while explicit --config can", async () => {
    const ws = workspace();
    const mod = ws.module("repo.ts", hook("request(){}"));
    ws.save({ hooks: { modules: [mod] } });
    writeFileSync(join(ws.layout.home, ".claudish", "config.json"), JSON.stringify({ hooks: {} }));
    writeFileSync(join(ws.layout.cwd, ".env"), `CLAUDISH_CONFIG=${ws.configFile}\n`);
    // L-23: start Bun with --no-env-file, as the launcher does, so claudish's own .env handling is
    // under test rather than Bun's autoload.
    const p = ws.spawn(["hooks", "list", "--json"]);
    expect(await p.finish()).toBe(0);
    expect(p.stderr).toContain(
      "[claudish] ignoring CLAUDISH_CONFIG in .env: a repository's .env may set only provider API keys and claudish model settings. Set it in your shell, or pass --config."
    );
    expect((JSON.parse(p.stdout) as Listed).hooks.filter((h) => h.id.startsWith("hook:"))).toEqual(
      []
    );
    expect((await list(ws)).hooks.filter((h) => h.id.startsWith("hook:")).map((h) => h.id)).toEqual(
      ["hook:repo/test"]
    );
  }, 30000);

  test("L-24 top-level hook output cannot enter CLI JSON stdout", async () => {
    const ws = workspace();
    const mod = ws.module(
      "chatty.ts",
      `console.log("IMPORT-CHATTER");process.stdout.write("IMPORT-WRITE\\n");${hook("request(){}")}`
    );
    ws.save({ hooks: { modules: [mod] } });
    const result = await list(ws);
    expect(result.hooks.filter((h) => h.id.startsWith("hook:")).map((h) => h.id)).toEqual([
      "hook:chatty/test",
    ]);
  }, 20000);
});
