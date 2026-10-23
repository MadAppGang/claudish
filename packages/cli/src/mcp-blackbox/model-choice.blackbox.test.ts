import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RecommendedModelsDoc } from "../model-loader.js";
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
  const [matches, choices] = answer.text
    .split("Matching recommended ids: ")[1]
    .split("\nRecommended models: ");
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
