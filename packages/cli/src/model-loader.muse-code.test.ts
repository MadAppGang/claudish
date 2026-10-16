import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const children: ReturnType<typeof Bun.spawn>[] = [];

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("G2c: old recommended projection is rejected without returning an opt-in command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudish-g2c-"));
  temporaryDirectories.push(directory);
  const home = join(directory, "home");
  mkdirSync(home);
  const scriptPath = join(directory, "scenario.ts");
  // Absolute imports resolve beside the test in the final repository. HOME must
  // be set at process START, before os.homedir() or any singleton is evaluated.
  const loaderPath = resolve(import.meta.dir, "model-loader.js");
  const cachePath = resolve(import.meta.dir, "providers/all-models-cache.js");
  writeFileSync(
    scriptPath,
    `
import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const realExit = process.exit.bind(process);
try {
const home = process.env.HOME!;
assert.equal(homedir(), home);
const outsideHomeWrites: string[] = [];
function inside(path: unknown) {
  const name = path instanceof URL ? fileURLToPath(path) : String(path);
  const rel = relative(home, resolve(name));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"));
}
function guard(path: unknown) {
  if (!inside(path)) {
    outsideHomeWrites.push(String(path));
    throw new Error("Write outside temporary HOME: " + String(path));
  }
}
// Observe and reject filesystem mutations, including cache writes during
// imports. Patch before imports and update named node:fs imports as well.
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "rmSync", "rmdirSync", "chmodSync",
  "writeFile", "appendFile", "mkdir", "unlink", "rm", "rmdir", "chmod"]) {
  const original = (fs as any)[name];
  (fs as any)[name] = function(path: unknown, ...args: unknown[]) {
    guard(path);
    return original.call(this, path, ...args);
  };
}
for (const name of ["renameSync", "copyFileSync", "rename", "copyFile"]) {
  const original = (fs as any)[name];
  (fs as any)[name] = function(from: unknown, to: unknown, ...args: unknown[]) {
    guard(from); guard(to);
    return original.call(this, from, to, ...args);
  };
}
for (const name of ["writeFile", "appendFile", "mkdir", "unlink", "rm", "rmdir", "chmod", "rename", "copyFile"]) {
  const original = (fs.promises as any)[name];
  (fs.promises as any)[name] = function(path: unknown, ...args: unknown[]) {
    guard(path);
    if (name === "rename" || name === "copyFile") guard(args[0]);
    return original.call(this, path, ...args);
  };
}
for (const name of ["openSync", "open", "createWriteStream"]) {
  const original = (fs as any)[name];
  (fs as any)[name] = function(path: unknown, ...args: unknown[]) {
    // Reads may inspect repository modules; every write-open stays in HOME.
    if (name === "createWriteStream" || (args[0] !== undefined && args[0] !== "r" && args[0] !== 0)) guard(path);
    return original.call(this, path, ...args);
  };
}
const originalPromiseOpen = fs.promises.open;
(fs.promises as any).open = function(path: unknown, flags: unknown, ...args: unknown[]) {
  if (flags !== undefined && flags !== "r" && flags !== 0) guard(path);
  return (originalPromiseOpen as any).call(this, path, flags, ...args);
};
const originalBunWrite = Bun.write;
(Bun as any).write = function(path: unknown, ...args: unknown[]) {
  guard(path);
  return (originalBunWrite as any).call(this, path, ...args);
};
syncBuiltinESMExports();
let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== "http:" && url.protocol !== "https:") return realFetch(input, init);
  requests++;
  throw new Error("G2c forbids network requests");
}, { preconnect: () => {} });
const loader = await import(${JSON.stringify(loaderPath)});
const cache = await import(${JSON.stringify(cachePath)});
assert.ok(inside(loader.RECOMMENDED_MODELS_CACHE_PATH));
assert.ok(inside(cache.ALL_MODELS_CACHE_PATH));
const generation = "g-run3-old-projection";
const stamp = new Date().toISOString();
fs.mkdirSync(dirname(cache.ALL_MODELS_CACHE_PATH), { recursive: true });
fs.mkdirSync(dirname(loader.RECOMMENDED_MODELS_CACHE_PATH), { recursive: true });
cache.writeAllModelsCache({ version: 3, lastUpdated: stamp, catalogGenerationId: generation,
  entries: [{ contractVersion: 3, modelId: "muse-spark-1.3", provider: "meta", aliases: [], aggregators: [] }],
  models: [{ id: "muse-spark-1.3" }], plans: [] });
const obsolete = { contractVersion: 3, generationId: generation,
  projectionVersion: loader.RECOMMENDED_PROJECTION_VERSION - 1, version: "3", lastUpdated: stamp,
  models: [{ id: "muse-spark-1.3", name: "Muse Spark", description: "Cloud models catalog test seed",
    provider: "meta", category: "flagship", priority: 1, context: "1M",
    pricing: { input: "0", output: "0", average: "0" },
    subscription: { prefix: "zgo", plan: "Go", command: "zgo@muse-spark-1.3-contributor" } }] };
fs.writeFileSync(loader.RECOMMENDED_MODELS_CACHE_PATH, JSON.stringify(obsolete));
let message = "";
let returned = false;
try { await loader.getRecommendedModels(); returned = true; }
catch (error) { message = error instanceof Error ? error.message : String(error); }
assert.equal(returned, false);
assert.match(message, /Unable to load v3 recommended models/);
assert.ok(!message.includes("-contributor"));
assert.ok(requests > 0);
assert.deepEqual(outsideHomeWrites, []);
console.log(JSON.stringify({ message, returned, requests, outsideHomeWrites,
  recommendedExists: fs.existsSync(loader.RECOMMENDED_MODELS_CACHE_PATH),
  catalogExists: fs.existsSync(cache.ALL_MODELS_CACHE_PATH) }));
realExit(0);
} catch (error) { console.error(error); realExit(1); }
`
  );
  const child = Bun.spawn([process.execPath, scriptPath], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  // Preserve diagnostics when a child assertion fails, without requiring quiet logs.
  if (exitCode !== 0) throw new Error(stderr);
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const result = JSON.parse(lines[0]!);
  expect(result.returned).toBe(false);
  expect(result.message).toMatch(/Unable to load v3 recommended models/);
  expect(result.message).not.toContain("-contributor");
  expect(result.requests).toBeGreaterThan(0);
  expect(result.catalogExists).toBe(true);
  expect(result.outsideHomeWrites).toEqual([]);
  expect(readdirSync(directory).sort()).toEqual(["home", "scenario.ts"]);
});

// HOME isolation is available; the remaining blocker is the unspecified HTTP
// payload T of CatalogV3Envelope<T> for single-model/search/page/top100 requests.
test.skip("G2c BLOCKED: ModelDoc fetch/search/provider/top100 HTTP data/pagination payloads are undeclared", () => {});
