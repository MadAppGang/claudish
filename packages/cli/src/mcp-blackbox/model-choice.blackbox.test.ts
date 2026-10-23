import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RecommendedModelsDoc } from "../model-loader.js";
import type { CachedEffortRecommendations } from "../providers/effort-recommendations.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  type ToolResult,
  paneOrphans,
  paneRootOf,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "../test-helpers/contract-records.js";

const sourceDir = join(import.meta.dir, "..");
const dataDir = join(sourceDir, "test-fixtures");
const listingPath = join(dataDir, "mcp-model-check/recommended-20261023.json");
const listing = JSON.parse(readFileSync(listingPath, "utf8")) as RecommendedModelsDoc;
const gptIds = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"];
const effortPath = join(dataDir, "mcp-model-check/efforts-20261023.json");
const capturedEfforts = JSON.parse(readFileSync(effortPath, "utf8")) as CachedEffortRecommendations;
const effortHeading = "Recommended effort for those ids, by task type";
const responsePath = join(dataDir, "sse-responses/minimax-m25-turn1-thinking-text-tool.sse");

let layout: TempLayout;
let server: McpServer | undefined;
let fetches: string;

beforeEach(() => {
  layout = makeTempLayout("model-choice");
  const config = join(layout.home, ".claudish");
  mkdirSync(config, { recursive: true });
  mkdirSync(join(layout.root, "tmp"));
  copyFileSync(listingPath, join(config, "recommended-models-cache-v2.json"));
  copyFileSync(
    join(dataDir, "stage5-explain-route-catalog.json"),
    join(config, "cloud-models-catalog-v3.json")
  );
  const openrouter = JSON.parse(
    readFileSync(join(dataDir, "mcp-model-check/openrouter-20261023.json"), "utf8")
  );
  writeFileSync(
    join(config, "openrouter-models.json"),
    JSON.stringify({ ...openrouter, lastUpdated: new Date().toISOString() })
  );
  fetches = join(layout.root, "fetches.jsonl");
  server = undefined;
});

afterEach(async () => {
  try {
    await server?.close();
    if (server) expect(server.proc.exitCode).toBe(0);
    expect(await paneOrphans(layout)).toEqual({ processes: [], files: [] });
  } finally {
    layout.cleanup();
  }
}, 30_000);

async function start(): Promise<McpServer> {
  // As in provider-fallback.blackbox: keep the actual stdio server, replace only
  // its upstream fetch. Even an accidental gate bypass cannot call a live model.
  const source = `
    import { appendFileSync, readFileSync } from "node:fs";
    import { homedir } from "node:os";
    if (homedir() !== process.env.HOME) throw new Error("HOME is not isolated");
    const originalFetch = globalThis.fetch;
    const intercepted = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
      if (url.protocol === "data:") return originalFetch(input, init);
      appendFileSync(${JSON.stringify(fetches)}, JSON.stringify(url.href) + "\\n");
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" &&
          url.pathname === "/v1/messages" && init?.method === "POST") {
        return new Response(readFileSync(${JSON.stringify(responsePath)}, "utf8"),
          { headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error("Network blocked by model-choice test");
    };
    intercepted.preconnect = () => {};
    globalThis.fetch = intercepted;
    const { startMcpServer } = await import(${JSON.stringify(pathToFileURL(join(sourceDir, "mcp-server.ts")).href)});
    startMcpServer();
  `;
  server = await McpServer.start({
    env: serverEnv(layout, { TMPDIR: join(layout.root, "tmp") }),
    cwd: layout.cwd,
    command: [process.execPath, "--no-env-file", "-e", source],
  });
  return server;
}

function assertNothingStarted(teamPath?: string): void {
  if (teamPath) expect(existsSync(teamPath)).toBe(false);
  expect(readdirSync(layout.sessionsDir)).toEqual([]);
  const paneRoot = paneRootOf(layout);
  expect(existsSync(paneRoot) ? readdirSync(paneRoot, { recursive: true }) : []).toEqual([]);
  expect(existsSync(fetches) ? readFileSync(fetches, "utf8").trim().split("\n") : []).toEqual([]);
}

function expectModelChoice(
  answer: ToolResult,
  kind: "unknown_model" | "not_recommended",
  matching: Record<string, string[]>
): void {
  expect((answer.raw as { error?: unknown }).error).toBeUndefined();
  expect(answer.isError).toBe(true);
  expect(answer.text).toStartWith(kind + ":");
  const [matchingAndEfforts, choices] = answer.text
    .split("Matching recommended ids: ")[1]
    .split("\nRecommended models: ");
  const [matches] = matchingAndEfforts.split(`\n${effortHeading}`);
  expect(JSON.parse(matches)).toEqual(matching);
  const rows = JSON.parse(choices) as Array<{
    id: string;
    vendor: string;
    tiers: string[];
    released?: string;
  }>;
  expect(rows.map((row) => row.id)).toEqual([...new Set(listing.models.map((row) => row.id))]);
  expect(rows.find((row) => row.id === gptIds[0])).toEqual({
    id: gptIds[0],
    vendor: "openai",
    tiers: ["flagship", "cost_efficient"],
    released: "2026-09-29",
  });
}

describe("MCP required string arguments over isolated stdio", () => {
  test.each([
    { tool: "get_diagnostics", args: {}, error: "Error: 'session_id' is required" },
    { tool: "get_output", args: {}, error: "Error: 'session_id' is required" },
    {
      tool: "send_input",
      args: { session_id: "x" },
      error: "Error: 'text' is required",
    },
    {
      tool: "get_diagnostics",
      args: { session_id: "" },
      error: "Error: 'session_id' must be a non-empty string",
    },
  ])(
    "$tool $args returns $error",
    async ({ tool, args, error }) => {
      const mcp = await start();
      const answer = await mcp.callTool(tool, args);
      expect((answer.raw as { error?: unknown }).error).toBeUndefined();
      expect(answer.isError).toBe(true);
      expect(answer.text).toBe(error);
      expect(answer.text).not.toContain("paths[1]");
      assertNothingStarted();
    },
    15_000
  );
});

describe("search_models recommendations over isolated stdio", () => {
  test("puts recommended GPT ids before the OpenRouter listing and suggests only the first", async () => {
    const mcp = await start();
    const answer = await mcp.callTool("search_models", { query: "openai gpt" });
    expect(answer.isError).toBe(false);
    const recommendedHeading = "## Recommended models (pass one of these)";
    const listingHeading = "## OpenRouter listing";
    expect(answer.text).toContain(recommendedHeading);
    expect(answer.text).toContain(listingHeading);
    expect(answer.text.indexOf(recommendedHeading)).toBeLessThan(
      answer.text.indexOf(listingHeading)
    );
    const section = answer.text.split(recommendedHeading)[1].split(listingHeading)[0];
    const ids = [...section.matchAll(/^\| (gpt-[^ |]+) \|/gm)].map((m) => m[1]);
    expect(ids).toEqual(gptIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(answer.text).toContain("| openai/gpt-5 |");
    expect(answer.text.trimEnd().split("\n").at(-1)).toBe(
      `Use with: run_prompt(model="${gptIds[0]}", prompt="your prompt")`
    );
    assertNothingStarted();
  }, 15_000);

  test("a listing match with no recommended match tells the caller to use list_models", async () => {
    const mcp = await start();
    const answer = await mcp.callTool("search_models", { query: "vision" });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("## OpenRouter listing");
    expect(answer.text).toContain("| deepseek/deepseek-v4-flash-vision-exp |");
    expect(answer.text).not.toContain("## Recommended models (pass one of these)");
    expect(answer.text).not.toContain("Use with:");
    expect(answer.text.trimEnd().split("\n").at(-1)).toBe(
      "No recommended model matches this query: call `list_models` for the recommended set."
    );
    assertNothingStarted();
  }, 15_000);
});

describe("MCP model-choice refusals over isolated stdio", () => {
  test.each([
    { mode: "run", models: ["gpt", "minimax"] },
    { mode: "judge", judges: ["gpt", "minimax"] },
    { mode: "run-and-judge", models: ["gpt"], judges: ["minimax"] },
  ])(
    "team $mode rejects unknown runners or judges before writing anything",
    async (args) => {
      const mcp = await start();
      const path = join(layout.cwd, "must-not-exist");
      const answer = await mcp.callTool("team", { ...args, path, input: "Answer this input." });
      expectModelChoice(answer, "unknown_model", { gpt: gptIds, minimax: ["minimax-m3"] });
      assertNothingStarted(path);
    },
    15_000
  );

  test.each(["run", "judge", "run-and-judge"])(
    "team %s rejects a non-recommended judge or runner",
    async (mode) => {
      const mcp = await start();
      const path = join(layout.cwd, "must-not-exist");
      const answer = await mcp.callTool("team", {
        mode,
        path,
        models: mode === "judge" ? undefined : ["gpt-6.1-sol"],
        judges: mode === "run" ? undefined : ["gpt-5"],
        ...(mode === "run" ? { models: ["gpt-5"] } : {}),
        input: "Answer this input.",
      });
      expectModelChoice(answer, "not_recommended", { "gpt-5": gptIds });
      assertNothingStarted(path);
    },
    15_000
  );

  test("team user_required_model exempts only the named entry", async () => {
    const mcp = await start();
    const path = join(layout.cwd, "must-not-exist");
    const answer = await mcp.callTool("team", {
      mode: "run",
      path,
      models: ["gpt", "minimax"],
      user_required_model: ["gpt"],
      input: "Answer this input.",
    });
    expectModelChoice(answer, "unknown_model", { minimax: ["minimax-m3"] });
    assertNothingStarted(path);
  }, 15_000);

  test.each(["gpt", "minimax"])(
    "run_prompt refuses unknown model %s",
    async (model) => {
      const mcp = await start();
      const answer = await mcp.callTool("run_prompt", { model, prompt: "Answer this input." });
      expectModelChoice(answer, "unknown_model", {
        [model]: model === "gpt" ? gptIds : ["minimax-m3"],
      });
      assertNothingStarted();
    },
    15_000
  );

  test.each(["gpt-5", "oai@gpt-5"])(
    "run_prompt refuses %s after stripping an unrequested provider",
    async (model) => {
      const mcp = await start();
      const answer = await mcp.callTool("run_prompt", { model, prompt: "Answer this input." });
      expectModelChoice(answer, "not_recommended", { [model]: gptIds });
      assertNothingStarted();
    },
    15_000
  );

  test("run_prompt gpt-5 includes matching effort rows and omits an id without a row", async () => {
    const sidecar = structuredClone(capturedEfforts);
    for (const generation of Object.values(sidecar.generations)) {
      delete (generation.efforts as Record<string, unknown>)[gptIds[2]];
    }
    writeFileSync(
      join(layout.home, ".claudish/cloud-models-catalog-v3.efforts.json"),
      JSON.stringify(sidecar)
    );
    const mcp = await start();
    const answer = await mcp.callTool("run_prompt", {
      model: "gpt-5",
      prompt: "Answer this input.",
    });
    expectModelChoice(answer, "not_recommended", { "gpt-5": gptIds });
    expect(answer.text).toContain(`\n${effortHeading}`);
    const section = answer.text.split(`\n${effortHeading}`)[1].split("\nRecommended models: ")[0];
    const rows = JSON.parse(section.slice(section.indexOf("{")));
    const captured = Object.values(capturedEfforts.generations)[0].efforts;
    const expected = Object.fromEntries(
      gptIds
        .slice(0, 2)
        .map((id) => [
          id,
          Object.fromEntries(
            Object.entries(captured[id]).map(([task, cell]) => [task, cell.effort])
          ),
        ])
    );
    expect(Object.keys(rows)).toEqual(gptIds.slice(0, 2));
    expect(rows).toEqual(expected);
    expect(rows).not.toHaveProperty(gptIds[2]);
    assertNothingStarted();
  }, 15_000);

  test("team minimax omits the effort line when no matching id has a row", async () => {
    copyFileSync(effortPath, join(layout.home, ".claudish/cloud-models-catalog-v3.efforts.json"));
    const mcp = await start();
    const path = join(layout.cwd, "must-not-exist");
    const answer = await mcp.callTool("team", {
      mode: "run",
      path,
      models: ["minimax"],
      input: "Answer this input.",
    });
    expectModelChoice(answer, "unknown_model", { minimax: ["minimax-m3"] });
    expect(answer.text).not.toContain(effortHeading);
    assertNothingStarted(path);
  }, 15_000);

  test("run_prompt user_required_model true passes the model check for gpt-5", async () => {
    const mcp = await start();
    const answer = await mcp.callTool("run_prompt", {
      model: "gpt-5",
      prompt: "Answer this input.",
      user_required_model: true,
    });
    expect((answer.raw as { error?: unknown }).error).toBeUndefined();
    expect(answer.text.length).toBeGreaterThan(0);
    expect(answer.text).not.toStartWith("not_recommended:");
  }, 15_000);

  test.skipIf(!MAGMUX_AVAILABLE).each([
    { model: "gpt", kind: "unknown_model" as const },
    { model: "gpt-5", kind: "not_recommended" as const },
  ])(
    "create_session refuses $model without creating a pane or record",
    async ({ model, kind }) => {
      const mcp = await start();
      const answer = await mcp.callTool("create_session", { model, prompt: "Answer this input." });
      expectModelChoice(answer, kind, { [model]: gptIds });
      assertNothingStarted();
    },
    15_000
  );
});
