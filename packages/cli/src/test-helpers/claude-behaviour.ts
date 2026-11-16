import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudishConfig } from "../types.js";

// Contract §3.1 and B-23/B-35/B-61 specify sparse configuration inputs.
// Preserve absent fields: CLI defaults would change the scenarios under test.
export function contractConfig(value: Partial<ClaudishConfig> = {}): ClaudishConfig {
  return value as unknown as ClaudishConfig;
}

// Contract §3.7 names "never"; the declared network union disagrees.
// Keep the contracted input rather than substituting another network policy.
type RouteOptions = NonNullable<
  Parameters<typeof import("../providers/routing-rules.js").explainRoute>[1]
>;
export const CONTRACT_OFFLINE_NETWORK = "never" as unknown as NonNullable<RouteOptions["network"]>;

export const MODEL = "claude-haiku-5-5";
export const KEY = "sk-ant-test-fake-0000000000";
export const LOGIN = "sk-ant-oat01-fake-0000000000";

export function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
export function temp(): string {
  return mkdtempSync(join(tmpdir(), "claude-behaviour-"));
}
export function cleanEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_DISABLE_BUNDLED_LIST: "1",
    CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
  };
}
/** Module-load paths and credential singletons belong to a disposable process. */
export async function isolatedFile(meta: ImportMeta, define: () => Promise<void>): Promise<void> {
  if (process.env.T_CLAUDE_BEHAVIOUR_FILE === meta.path) {
    await define();
    return;
  }
  test("isolated public-contract behaviour suite", async () => {
    const home = temp();
    try {
      const child = Bun.spawn([process.execPath, "--no-env-file", "test", meta.path], {
        cwd: process.cwd(),
        env: { ...cleanEnv(home), T_CLAUDE_BEHAVIOUR_FILE: meta.path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, out + err).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
}
export function connection(
  routeId: string,
  routeProfileId: string,
  externalModelId = MODEL,
  pricing?: unknown
) {
  return {
    sourceProviderId: routeId,
    sourceCollectorId: "test-data",
    confidence: "api_official",
    routeStatus: "mapped",
    route: { routeId, routeProfileId },
    externalModelId,
    ...(pricing === undefined ? {} : { pricing }),
  };
}
export function catalog(
  entries = [
    {
      modelId: MODEL,
      aliases: [],
      provider: "anthropic",
      contextWindow: 200000,
      aggregators: [
        connection("anthropic", "direct-api"),
        connection("anthropic", "claude-code-subscription"),
        connection("openrouter", "gateway", "anthropic/" + MODEL),
      ],
    },
  ]
) {
  return {
    version: 3 as const,
    lastUpdated: new Date().toISOString(),
    entries,
    models: entries.map((e) => ({ id: e.modelId })),
    plans: [],
    catalogGenerationId: "behaviour-test-data",
  };
}
export const CLI = join(import.meta.dir, "..", "index.ts");
export async function cli(home: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
    cwd: home,
    env: { ...cleanEnv(home), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
/** A fake Claude Code records its launch and optionally makes one proxy request. */
export function standIn(home: string): Record<string, string> {
  const path = join(home, "fake-claude");
  put(
    path,
    `#!${process.execPath}
import {writeFileSync, readFileSync, existsSync} from "node:fs";
const args = process.argv.slice(2);
const i = args.indexOf("--settings");
let settings = {};
if(i >= 0) {
  const value = args[i+1];
  settings = JSON.parse(existsSync(value) ? readFileSync(value, "utf8") : value);
}
writeFileSync(process.env.T_CHILD_RECORD, JSON.stringify({env: process.env, args, settings}));
if(process.env.T_SEND_REQUEST) {
  const headers = {"content-type":"application/json"};
  if(process.env.T_REQUEST_AUTH) headers.authorization = process.env.T_REQUEST_AUTH;
  if(process.env.T_REQUEST_KEY) headers["x-api-key"] = process.env.T_REQUEST_KEY;
  const r = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method:"POST", headers, body:JSON.stringify({model: process.env.ANTHROPIC_MODEL, max_tokens:1, messages:[{role:"user",content:"hi"}]})
  });
  writeFileSync(process.env.T_REQUEST_RECORD, JSON.stringify({status:r.status,body:await r.text()}));
}
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"fake reply",usage:{input_tokens:1,output_tokens:1}}));
`
  );
  // chmod is applied only to our newly created stand-in.
  Bun.spawnSync(["chmod", "700", path], { env: cleanEnv(home) });
  return {
    CLAUDE_PATH: path,
    CLAUDISH_BIN: path,
    T_CHILD_RECORD: join(home, "child.json"),
    T_REQUEST_RECORD: join(home, "request.json"),
  };
}
export function childRecord(home: string) {
  return JSON.parse(readFileSync(join(home, "child.json"), "utf8"));
}
