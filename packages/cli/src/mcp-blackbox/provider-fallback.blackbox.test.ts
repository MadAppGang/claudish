import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RECOMMENDED_MODELS_CACHE_PATH,
  type RecommendationCatalogSnapshot,
  type RecommendationsWire,
  projectRecommendations,
} from "../model-loader.js";
import { ALL_MODELS_CACHE_PATH, writeAllModelsCache } from "../providers/all-models-cache.js";
import { writeEffortRecommendations } from "../providers/effort-recommendations.js";
import {
  MAGMUX_AVAILABLE,
  PANE_FAKE_CHILD,
  paneOrphans,
  paneRootOf,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";

const sourceDir = join(import.meta.dir, "..");
const dataDir = join(sourceDir, "test-fixtures");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const liveDir = join(sourceDir, "fixtures/recommendation-tiers/live");
const slim = readJson<{ generationId: string; models: RecommendationCatalogSnapshot["entries"] }>(
  join(liveDir, "slim.json")
);
const plans = readJson<{ plans: RecommendationCatalogSnapshot["plans"] }>(
  join(liveDir, "plans.json")
);
const recommended = readJson<{ data: { recommendations: RecommendationsWire } }>(
  join(liveDir, "recommended.json")
);
type Efforts = Record<string, Record<string, { effort: string }>>;
const efforts = readJson<{ generationId: string; data: { recommendations: { efforts: Efforts } } }>(
  join(dataDir, "effort-recommendations/recommended-2.3.0.json")
);
const rows = readJson<{ entries: Array<{ modelId: string }> }>(
  join(dataDir, "catalog-v3/rows-g-20260919013346169.json")
);
const model = rows.entries[0].modelId;
const otherModel = rows.entries.at(-1)!.modelId;
const explicit = `kc@${model}`;
const effortRows = efforts.data.recommendations.efforts;
const noRow = rows.entries.find((entry) => !effortRows[entry.modelId])!.modelId;
const native = Object.keys(effortRows).find((id) => id.startsWith("claude-"))!;
const printFake = join(sourceDir, "test-helpers/fake-print-claudish.ts");
const responsePath = join(dataDir, "sse-responses/minimax-m25-turn1-thinking-text-tool.sse");

type Rpc = { jsonrpc: string; id?: number; method?: string; result?: unknown; error?: unknown };
type ToolAnswer = { content: Array<{ type: string; text: string }>; isError?: boolean };

// The shared client ignores non-JSON stdout lines. This client retains every byte
// and parses every nonempty line, so logging cannot silently corrupt the protocol.
class StrictMcp {
  readonly child;
  private readonly reader;
  private readonly stderr;
  private buffer = "";
  private nextId = 1;
  stdout = "";

  constructor(env: Record<string, string>, cwd: string, source: string) {
    this.child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      env,
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.reader = this.child.stdout.getReader();
    this.stderr = new Response(this.child.stderr).text();
  }

  private write(message: unknown): void {
    this.child.stdin.write(JSON.stringify(message) + "\n");
    this.child.stdin.flush();
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 60_000);
    try {
      for (;;) {
        const at = this.buffer.indexOf("\n");
        if (at < 0) {
          const chunk = await this.reader.read();
          if (chunk.done) throw new Error("MCP exited: " + (await this.stderr));
          const text = new TextDecoder().decode(chunk.value);
          this.stdout += text;
          this.buffer += text;
          continue;
        }
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Rpc;
        expect(message.jsonrpc).toBe("2.0");
        if (message.method && message.id !== undefined) {
          this.write({ jsonrpc: "2.0", id: message.id, result: {} });
        } else if (message.id === id) {
          expect(message.error).toBeUndefined();
          return message.result;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "provider-fallback-test", version: "1.0.0" },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
    return (await this.request("tools/call", { name, arguments: args })) as ToolAnswer;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 15_000);
    try {
      for (;;) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        this.stdout += new TextDecoder().decode(chunk.value);
      }
      await this.child.exited;
      expect(this.child.exitCode).toBe(0);
      for (const line of this.stdout.split("\n").filter((line) => line.trim())) {
        expect((JSON.parse(line) as Rpc).jsonrpc).toBe("2.0");
      }
    } finally {
      clearTimeout(timer);
      this.reader.releaseLock();
      await this.stderr;
    }
  }
}

let layout: TempLayout;
let server: StrictMcp | undefined;
let config: string;
let fetches: string;
let requests: string;
let argvDir: string;

beforeEach(() => {
  layout = makeTempLayout("provider-fallback");
  config = join(layout.home, ".claudish");
  fetches = join(layout.root, "blocked-fetches.jsonl");
  requests = join(layout.root, "proxy-requests.jsonl");
  argvDir = join(layout.root, "argv");
  mkdirSync(config, { recursive: true });
  mkdirSync(argvDir);
  copyFileSync(
    join(dataDir, "catalog-v3/wire-g-20261012101007285-7770c36e.json"),
    join(config, basename(ALL_MODELS_CACHE_PATH))
  );
  writeEffortRecommendations(
    efforts.generationId,
    efforts.data.recommendations.efforts,
    join(config, "cloud-models-catalog-v3.efforts.json")
  );
  server = undefined;
});

afterEach(async () => {
  try {
    await server?.close();
    expect(await paneOrphans(layout)).toEqual({ processes: [], files: [] });
  } finally {
    layout.cleanup();
  }
}, 30_000);

async function start(): Promise<StrictMcp> {
  const wrapper = join(layout.root, "pane-child.ts");
  writeFileSync(
    wrapper,
    `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const args = process.argv.slice(2);
    if (args.includes("-p")) {
      writeFileSync(${JSON.stringify(join(layout.root, "native-argv.json"))}, JSON.stringify(args));
      process.argv[process.argv.indexOf("--model") + 1] = "claude-fake-ok";
      await import(${JSON.stringify(pathToFileURL(printFake).href)});
      process.exit(0);
    }
    const id = args[args.indexOf("--session-id") + 1];
    writeFileSync(join(${JSON.stringify(argvDir)}, id + ".json"), JSON.stringify(args));
    await import(${JSON.stringify(pathToFileURL(PANE_FAKE_CHILD).href)});
  `
  );
  const source = `
    import { appendFileSync, readFileSync } from "node:fs";
    import { homedir } from "node:os";
    if (homedir() !== process.env.HOME) throw new Error("HOME is not isolated");
    const originalFetch = globalThis.fetch;
    const blocked = (url) => {
      appendFileSync(${JSON.stringify(fetches)}, JSON.stringify(String(url)) + "\\n");
      throw new Error("Network blocked by test: " + url);
    };
    const intercepted = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
      if (url.protocol === "data:") return originalFetch(input, init);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" &&
          url.pathname === "/v1/messages" && init?.method === "POST") {
        appendFileSync(${JSON.stringify(requests)}, init.body + "\\n");
        return new Response(readFileSync(${JSON.stringify(responsePath)}, "utf8"),
          { headers: { "Content-Type": "text/event-stream" } });
      }
      return blocked(url.href);
    };
    intercepted.preconnect = blocked;
    globalThis.fetch = intercepted;
    const { startMcpServer } = await import(${JSON.stringify(pathToFileURL(join(sourceDir, "mcp-server.ts")).href)});
    startMcpServer();
  `;
  server = new StrictMcp(
    serverEnv(layout, {
      CLAUDISH_BIN: wrapper,
      FAKE_PRINT_RECORD: join(layout.root, "native-print-record.json"),
    }),
    layout.cwd,
    source
  );
  await server.initialize();
  return server;
}

const textOf = (answer: ToolAnswer): string => answer.content.map((part) => part.text).join("\n");
const capturedArgv = (): string[][] =>
  readdirSync(argvDir).map((file) => readJson<string[]>(join(argvDir, file)));
const modelOf = (argv: string[]): string => argv[argv.indexOf("--model") + 1];

function seedListing(stale: boolean): ReturnType<typeof projectRecommendations> {
  const doc = projectRecommendations(
    recommended.data.recommendations,
    { catalogGenerationId: slim.generationId, entries: slim.models, plans: plans.plans },
    [],
    stale ? new Date(0) : new Date()
  );
  writeFileSync(join(config, basename(RECOMMENDED_MODELS_CACHE_PATH)), JSON.stringify(doc));
  return doc;
}

function logs(): string {
  return readdirSync(join(config, "logs"))
    .filter((name) => name.startsWith("claudish-mcp_"))
    .map((name) => readFileSync(join(config, "logs", name), "utf8"))
    .join("\n");
}

describe("list_models fallback over isolated JSON-RPC", () => {
  test("failed fetch uses an expired different-generation listing, adds efforts and logs only to file", async () => {
    const doc = seedListing(true);
    const mcp = await start();
    const answer = await mcp.tool("list_models");
    expect(answer.isError).not.toBe(true);
    const text = textOf(answer);
    expect(text).toStartWith(
      "_The live catalog could not be read; this list is from generation " + doc.generationId
    );
    expect(text).toContain(doc.models[0].id);
    expect(text).not.toContain("**Access**");
    expect(text).not.toContain("@");
    expect(text).toContain("Pass each model by its bare id");
    expect(text).toContain("Recommended effort by task type");
    expect(text).toContain("implementation");
    expect(text).toContain("claude-opus-5-5");
    expect(readFileSync(fetches, "utf8")).toContain("catalog=recommended");
    await waitFor(() => logs().includes("[mcp] list_models:"), { what: "fallback log flush" });
    expect(logs()).toContain("[mcp] list_models: Unable to load v3 recommended models:");
    expect(logs()).toContain("answered from stored generation " + doc.generationId);
    expect(mcp.stdout).not.toContain("\n[mcp]");
  }, 15_000);

  test("efforts are appended even when there is no listing", async () => {
    const mcp = await start();
    const text = textOf(await mcp.tool("list_models"));
    expect(text).toStartWith("No recommended models found. Try search_models instead.");
    expect(text).toContain("Recommended effort by task type");
    expect(text).toContain("implementation");
  }, 15_000);

  test("a current cached listing also includes the efforts table without a fallback note", async () => {
    const doc = seedListing(false);
    writeAllModelsCache(
      {
        version: 3,
        catalogGenerationId: slim.generationId,
        lastUpdated: new Date().toISOString(),
        entries: slim.models,
        plans: plans.plans,
        models: slim.models.map((entry) => ({ id: entry.modelId })),
      },
      join(config, basename(ALL_MODELS_CACHE_PATH))
    );
    const mcp = await start();
    const text = textOf(await mcp.tool("list_models"));
    expect(text).toContain(doc.models[0].id);
    expect(text).not.toContain("**Access**");
    expect(text).not.toContain("@");
    expect(text).toContain("Pass each model by its bare id");
    expect(text).not.toContain("_The live catalog could not be read;");
    expect(text).toContain("Recommended effort by task type");
  }, 15_000);
});

function assertNothingStarted(teamPath?: string): void {
  if (teamPath) expect(existsSync(teamPath)).toBe(false);
  expect(readdirSync(layout.sessionsDir)).toEqual([]);
  expect(capturedArgv()).toEqual([]);
  expect(existsSync(requests)).toBe(false);
  expect(existsSync(join(layout.root, "native-argv.json"))).toBe(false);
  const paneRoot = paneRootOf(layout);
  expect(existsSync(paneRoot) ? readdirSync(paneRoot, { recursive: true }) : []).toEqual([]);
}

function expectedEfforts(spec: string, id = model): Record<string, Record<string, string>> {
  return {
    [spec]: Object.fromEntries(
      Object.entries(effortRows[id]).map(([task, cell]) => [task, cell.effort])
    ),
  };
}

function expectNeedsEffort(
  answer: ToolAnswer,
  expected: Record<string, Record<string, string>>
): void {
  expect(answer.isError).toBe(true);
  expect(textOf(answer)).toStartWith("needs_effort:");
  expect(JSON.parse(textOf(answer).split("Recommended levels: ")[1])).toEqual(expected);
}

describe("needs_effort over isolated JSON-RPC", () => {
  test.each([model, explicit])(
    "run_prompt needs_effort starts nothing for %s",
    async (spec) => {
      const mcp = await start();
      const answer = await mcp.tool("run_prompt", { model: spec, prompt: "Answer this input." });
      assertNothingStarted();
      expectNeedsEffort(answer, expectedEfforts(spec));
    },
    15_000
  );

  test.skipIf(!MAGMUX_AVAILABLE).each([model, explicit])(
    "create_session needs_effort starts nothing for %s",
    async (spec) => {
      const mcp = await start();
      const answer = await mcp.tool("create_session", {
        model: spec,
        prompt: "Answer this input.",
      });
      assertNothingStarted();
      expectNeedsEffort(answer, expectedEfforts(spec));
    },
    15_000
  );

  test.each(["run", "run-and-judge"])(
    "team %s needs_effort starts nothing with caller-spelled keys",
    async (mode) => {
      const mcp = await start();
      const path = join(layout.cwd, "must-not-exist");
      const answer = await mcp.tool("team", {
        mode,
        path,
        models: [explicit, model, noRow, native],
        judges: [explicit, model],
        input: "Answer this input.",
      });
      assertNothingStarted(path);
      expectNeedsEffort(answer, { ...expectedEfforts(explicit), ...expectedEfforts(model) });
    },
    15_000
  );

  test("run_prompt default runs without output_config", async () => {
    const mcp = await start();
    const answer = await mcp.tool("run_prompt", {
      model: explicit,
      prompt: "Answer this input.",
      effort: "default",
    });
    expect(answer.isError).not.toBe(true);
    const bodies = readFileSync(requests, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model).toBe(model);
    expect(Object.hasOwn(bodies[0], "output_config")).toBe(false);
    expect(capturedArgv()).toEqual([]);
  }, 15_000);

  test("a model with no row runs run_prompt without clarification or output_config", async () => {
    expect(effortRows[noRow]).toBeUndefined();
    const mcp = await start();
    const answer = await mcp.tool("run_prompt", { model: noRow, prompt: "Answer this input." });
    expect(answer.isError).not.toBe(true);
    const body = JSON.parse(readFileSync(requests, "utf8").trim());
    expect(body.model).toBe(noRow);
    expect(Object.hasOwn(body, "output_config")).toBe(false);
  }, 15_000);

  test("a native name with a row runs the fake print child without clarification", async () => {
    expect(effortRows[native]).toBeDefined();
    const mcp = await start();
    const answer = await mcp.tool("run_prompt", { model: native, prompt: "Answer this input." });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer)).toContain("7723");
    const argv = readJson<string[]>(join(layout.root, "native-argv.json"));
    expect(modelOf(argv)).toBe(native);
    expect(argv).not.toContain("--effort-override");
    expect(existsSync(requests)).toBe(false);
  }, 15_000);

  test("a newer empty sidecar generation does not reuse an older model row", async () => {
    const path = join(config, "cloud-models-catalog-v3.efforts.json");
    const sidecar = readJson<{
      contractVersion: number;
      format: number;
      generations: Record<string, { writtenAt: number; efforts: unknown }>;
    }>(path);
    expect(slim.generationId).not.toBe(efforts.generationId);
    sidecar.generations[efforts.generationId].writtenAt = 1;
    sidecar.generations[slim.generationId] = { writtenAt: 2, efforts: {} };
    writeFileSync(path, JSON.stringify(sidecar));
    const mcp = await start();
    const answer = await mcp.tool("run_prompt", { model, prompt: "Answer this input." });
    expect(answer.isError).not.toBe(true);
    const body = JSON.parse(readFileSync(requests, "utf8").trim());
    expect(body.model).toBe(model);
    expect(Object.hasOwn(body, "output_config")).toBe(false);
  }, 15_000);

  test("MCP startup retains 500 logs for its own name", async () => {
    const dir = join(config, "logs");
    mkdirSync(dir);
    const originals = Array.from(
      { length: 502 },
      (_, i) => `claudish-mcp_2000-${String(i).padStart(4, "0")}_1.log`
    );
    for (const name of originals) writeFileSync(join(dir, name), "old mcp log");
    const other = "claudish_2000-01-01_1.log";
    writeFileSync(join(dir, other), "session log");
    await start();
    const names = readdirSync(dir).sort();
    const mcp = names.filter((name) => name.startsWith("claudish-mcp_"));
    expect(mcp).toHaveLength(500);
    expect(mcp.slice(0, -1)).toEqual(originals.slice(3));
    expect(readFileSync(join(dir, other), "utf8")).toBe("session log");
  }, 15_000);
});

describe.skipIf(!MAGMUX_AVAILABLE)("effort opt-outs and exempt pane models", () => {
  test("create_session default starts without an effort override", async () => {
    const mcp = await start();
    const answer = await mcp.tool("create_session", {
      model: explicit,
      prompt: "Answer this input.",
      effort: "default",
    });
    expect(answer.isError).not.toBe(true);
    const args = await waitFor(() => capturedArgv()[0], { what: "default session argv" });
    expect(modelOf(args)).toBe(model);
    expect(args).not.toContain("--effort-override");
  }, 30_000);

  test.each(["run", "run-and-judge"])(
    "team %s with efforts {} starts every slot without an override",
    async (mode) => {
      const mcp = await start();
      const answer = await mcp.tool("team", {
        mode,
        path: join(layout.cwd, "keep-effort"),
        models: [explicit, model],
        judges: [explicit, model],
        input: "Answer this input.",
        efforts: {},
      });
      expect(answer.isError).not.toBe(true);
      const count = mode === "run" ? 2 : 4;
      const args = await waitFor(() => capturedArgv().length === count && capturedArgv(), {
        what: "all default-effort team children",
      });
      expect(args).toHaveLength(count);
      for (const argv of args) expect(argv).not.toContain("--effort-override");
    },
    90_000
  );

  test.each([noRow, native])(
    "create_session exempts %s without effort",
    async (spec) => {
      const mcp = await start();
      const answer = await mcp.tool("create_session", {
        model: spec,
        prompt: "Answer this input.",
      });
      expect(answer.isError).not.toBe(true);
      const args = await waitFor(() => capturedArgv()[0], { what: "exempt session argv" });
      expect(modelOf(args)).toBe(spec);
      expect(args).not.toContain("--effort-override");
    },
    30_000
  );

  test("team without any matching foreign row starts as before", async () => {
    const mcp = await start();
    const answer = await mcp.tool("team", {
      mode: "run",
      path: join(layout.cwd, "exempt-models"),
      models: [noRow, native],
      input: "Answer this input.",
    });
    expect(answer.isError).not.toBe(true);
    const args = await waitFor(() => capturedArgv().length === 2 && capturedArgv(), {
      what: "exempt team children",
    });
    expect(args.map(modelOf).sort()).toEqual([noRow, native].sort());
    for (const argv of args) expect(argv).not.toContain("--effort-override");
  }, 45_000);
});

describe("run_prompt provider intent over isolated JSON-RPC", () => {
  test("strips an unrequested provider but preserves a required provider in the actual proxy body", async () => {
    const mcp = await start();
    for (const required of [undefined, false, true]) {
      const answer = await mcp.tool("run_prompt", {
        model: explicit,
        prompt: "Return the captured answer.",
        effort: "default",
        ...(required === undefined ? {} : { user_required_provider: required }),
      });
      expect(answer.isError).not.toBe(true);
      expect(textOf(answer).includes("Provider removed so claudish routing decides:")).toBe(
        required !== true
      );
    }
    const bodies = readFileSync(requests, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { model: string });
    expect(bodies.map((body) => body.model)).toEqual([model, model, explicit]);
  }, 20_000);

  test("compare_models is not subject to provider stripping", async () => {
    const mcp = await start();
    const answer = await mcp.tool("compare_models", {
      models: [explicit, `openrouter@${otherModel}`],
      prompt: "Return the captured answer.",
    });
    expect(answer.isError).not.toBe(true);
    const bodies = readFileSync(requests, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { model: string });
    expect(bodies.map((body) => body.model).sort()).toEqual(
      [explicit, `openrouter@${otherModel}`].sort()
    );
  }, 20_000);
});

describe.skipIf(!MAGMUX_AVAILABLE)(
  "provider intent in real panes with captured fake-child behaviour",
  () => {
    test("create_session strips by default and keeps an explicitly required provider", async () => {
      const mcp = await start();
      for (const required of [false, true]) {
        const answer = await mcp.tool("create_session", {
          model: explicit,
          prompt: "Answer this input.",
          effort: "default",
          user_required_provider: required,
        });
        expect(answer.isError).not.toBe(true);
        const body = JSON.parse(textOf(answer)) as {
          session_id: string;
          model?: string;
          note?: string;
        };
        const record = readJson<{ model: string }>(
          join(layout.sessionsDir, body.session_id, "spawn.json")
        );
        expect(record.model).toBe(required ? explicit : model);
        expect(body.note?.includes("Provider removed")).toBe(required ? undefined : true);
        const expectedModel = required ? explicit : model;
        const argv = await waitFor(
          () => capturedArgv().find((args) => modelOf(args) === expectedModel),
          { what: "session child argv" }
        );
        expect(modelOf(argv)).toBe(expectedModel);
      }
    }, 30_000);

    test("team keeps caller-spelled efforts mapped to stripped slots and preserves required providers", async () => {
      const mcp = await start();
      const judge = `openrouter@${otherModel}`;
      const path = join(layout.cwd, "team");
      const answer = await mcp.tool("team", {
        mode: "run",
        path,
        models: [explicit, judge],
        input: "Answer this input.",
        user_required_provider: [judge],
        efforts: { [explicit]: "low", [judge]: "high" },
      });
      expect(answer.isError).not.toBe(true);
      expect(textOf(answer)).toContain(`${explicit} -> ${model}`);
      expect(textOf(answer)).not.toContain(`${judge} ->`);
      const args = await waitFor(() => capturedArgv().length >= 2 && capturedArgv(), {
        what: "two team children",
      });
      const byModel = new Map(args.map((argv) => [modelOf(argv), argv]));
      expect([...byModel.keys()].sort()).toEqual([model, judge].sort());
      expect(byModel.get(model)?.slice(-2)).toEqual(["--effort-override", "low"]);
      expect(byModel.get(judge)?.slice(-2)).toEqual(["--effort-override", "high"]);
    }, 45_000);

    test("team preserves colliding provider specs and their independent effort levels", async () => {
      const mcp = await start();
      const comparison = `or@${model}`;
      const answer = await mcp.tool("team", {
        mode: "run",
        path: join(layout.cwd, "provider-comparison"),
        models: [comparison, explicit],
        input: "Answer this input.",
        efforts: { [comparison]: "low", [explicit]: "high" },
      });
      expect(answer.isError).not.toBe(true);
      expect(textOf(answer)).not.toContain("Provider removed");
      const args = await waitFor(() => capturedArgv().length === 2 && capturedArgv(), {
        what: "two provider-comparison children",
      });
      const byModel = new Map(args.map((argv) => [modelOf(argv), argv]));
      expect([...byModel.keys()].sort()).toEqual([comparison, explicit].sort());
      expect(byModel.get(comparison)?.slice(-2)).toEqual(["--effort-override", "low"]);
      expect(byModel.get(explicit)?.slice(-2)).toEqual(["--effort-override", "high"]);
    }, 45_000);

    test("team judges use the same provider-intent set as models", async () => {
      const mcp = await start();
      const firstJudge = `openrouter@${model}`;
      const secondJudge = `openrouter@${otherModel}`;
      const answer = await mcp.tool("team", {
        mode: "run-and-judge",
        path: join(layout.cwd, "judged"),
        models: [explicit, `kc@${otherModel}`],
        judges: [firstJudge, secondJudge],
        efforts: {},
        user_required_provider: [secondJudge],
        input: "Answer this input.",
      });
      expect(answer.isError).not.toBe(true);
      const args = capturedArgv();
      expect(args.map(modelOf).sort()).toEqual([model, otherModel, model, secondJudge].sort());
      expect(textOf(answer)).toContain(`${firstJudge} -> ${model}`);
      expect(textOf(answer)).not.toContain(`${secondJudge} ->`);
    }, 90_000);
  }
);
