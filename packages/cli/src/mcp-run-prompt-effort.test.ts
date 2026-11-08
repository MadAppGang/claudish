import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const capture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "test-fixtures/effort-recommendations/recommended-2.3.0.json"),
    "utf8"
  )
) as { data: { recommendations: { efforts: Record<string, unknown> } } };
const model = Object.keys(capture.data.recommendations.efforts)[1];
const prompt = "Return the captured answer.";
const system = "Use only the supplied response.";
const responsePath = join(
  import.meta.dir,
  "test-fixtures/sse-responses/minimax-m25-turn1-thinking-text-tool.sse"
);
const expectedText = readFileSync(responsePath, "utf8")
  .split("\n")
  .filter((line) => line.startsWith("data: "))
  .map((line) => JSON.parse(line.slice(6)))
  .filter((event) => event.type === "content_block_delta" && event.delta?.type === "text_delta")
  .map((event) => event.delta.text)
  .join("");

type RequestBody = Record<string, unknown>;
interface CaptureResult {
  requests: Array<{ url: string; method: string; body: RequestBody }>;
  results: Array<{ content: string }>;
  unexpectedFetches: string[];
}
let root: string;
let captured: CaptureResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcp-effort-request-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const claudeConfig = join(root, "claude-config");
  for (const dir of [home, cwd, claudeConfig]) mkdirSync(dir, { recursive: true });

  // The proxy singleton has no public shutdown/reset. Keep its listener and the
  // fetch interception in a child process, never in Bun's shared test registry.
  const source = `
    import { readFileSync } from "node:fs";
    import { homedir } from "node:os";
    const requests = [];
    const results = [];
    const unexpectedFetches = [];
    const response = readFileSync(${JSON.stringify(responsePath)}, "utf8");
    const originalFetch = globalThis.fetch;
    const interceptedFetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
      // Tokenizer WebAssembly is loaded from an in-memory data URI, not the network.
      if (url.protocol === "data:") return originalFetch(input, init);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
          url.pathname !== "/v1/messages" || init?.method !== "POST") {
        unexpectedFetches.push(url.href);
        throw new Error("Unexpected fetch: " + url.href);
      }
      requests.push({ url: url.href, method: init.method, body: JSON.parse(init.body) });
      return new Response(response, { headers: { "Content-Type": "text/event-stream" } });
    };
    interceptedFetch.preconnect = (url) => {
      unexpectedFetches.push("preconnect:" + String(url));
      throw new Error("No network preconnect is permitted");
    };
    globalThis.fetch = interceptedFetch;
    try {
      if (homedir() !== process.env.HOME) throw new Error("HOME was not isolated at startup");
      const { runPromptViaProxy } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "mcp-server.ts")).href)});
      results.push(await runPromptViaProxy(${JSON.stringify(model)}, ${JSON.stringify(prompt)}, ${JSON.stringify(system)}));
      for (const level of ${JSON.stringify(LEVELS)}) {
        results.push(await runPromptViaProxy(${JSON.stringify(model)}, ${JSON.stringify(prompt)}, ${JSON.stringify(system)}, level));
      }
      results.push(await runPromptViaProxy(${JSON.stringify(model)}, ${JSON.stringify(prompt)}));
      await new Promise((resolve) => setTimeout(resolve, 25));
      console.log("EFFORT_CAPTURE=" + JSON.stringify({ requests, results, unexpectedFetches }));
      process.exit(0);
    } catch (error) {
      console.error(error);
      console.error(JSON.stringify({ requests, unexpectedFetches }));
      process.exit(1);
    }
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDE_CONFIG_DIR: claudeConfig,
      ZDOTDIR: home,
      TMPDIR: tmpdir(),
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
      CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const resultLine = stdout.split("\n").find((line) => line.startsWith("EFFORT_CAPTURE="));
    expect(resultLine).toBeDefined();
    captured = JSON.parse(resultLine!.slice("EFFORT_CAPTURE=".length)) as CaptureResult;
    expect(captured.unexpectedFetches).toEqual([]);
    expect(captured.requests).toHaveLength(LEVELS.length + 2);
    expect(expectedText.length).toBeGreaterThan(0);
    expect(captured.results).toHaveLength(captured.requests.length);
    for (const result of captured.results) expect(result.content).toBe(expectedText);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 15_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("runPromptViaProxy request effort at the proxy fetch boundary", () => {
  test("omits the entire output_config key when effort is absent", () => {
    expect(Object.hasOwn(captured.requests[0].body, "output_config")).toBe(false);
    expect(captured.requests[0].body).toEqual({
      model,
      messages: [{ role: "user", content: prompt }],
      system,
      stream: true,
    });
  });

  test.each([...LEVELS])("sends output_config.effort exactly as %s", (level) => {
    const request = captured.requests[LEVELS.indexOf(level) + 1];
    expect(new URL(request.url).pathname).toBe("/v1/messages");
    expect(request.method).toBe("POST");
    expect(request.body).toEqual({
      model,
      messages: [{ role: "user", content: prompt }],
      system,
      stream: true,
      output_config: { effort: level },
    });
  });

  test("does not retain output_config or system from an earlier request", () => {
    expect(captured.requests.at(-1)?.body).toEqual({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });
    expect(Object.hasOwn(captured.requests.at(-1)!.body, "output_config")).toBe(false);
  });
});
