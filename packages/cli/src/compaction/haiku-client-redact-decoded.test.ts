import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionClient } from "./haiku-client.js";
import { CompactionStore } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

// Installed per file and restored: bun runs every test file in one process.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("Unexpected network access");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const model = "test-compaction-model";
const session = "redact-session";
const KEY = "FAKE-signing-value-zz-0123456789";
const HALF = KEY.length / 2;

/** Every character of `text` as a JSON `\u` escape. */
function escaped(text: string): string {
  return [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-redact-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function client(raw: string, status = 200) {
  return new CompactionClient({
    apiKey: KEY,
    model,
    warn() {},
    record() {},
    fetchImpl: (async () =>
      new Response(raw, {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
}

function okBody(contentJson: string): string {
  return `{"type":"message","role":"assistant","content":${contentJson},"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`;
}

const splitBlocks = okBody(
  JSON.stringify([
    { type: "text", text: `Summary ${KEY.slice(0, HALF)}` },
    { type: "text", text: `${KEY.slice(HALF)} end` },
  ])
);
const escapedText = okBody(`[{"type":"text","text":"Summary ${escaped(KEY)} end"}]`);

const request = { system: "s", user: "u", maxTokens: 10, timeoutMs: 1000, purpose: "test" };

test("the key is redacted from the joined answer when split across two text blocks", async () => {
  const result = await client(splitBlocks).complete(request);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.text).not.toContain(KEY);
});

test("the key is redacted from the answer when written with JSON \\u escapes", async () => {
  const result = await client(escapedText).complete(request);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.text).not.toContain(KEY);
});

test("the key is redacted from a decoded error message", async () => {
  const body = `{"type":"error","error":{"type":"invalid_request_error","message":"bad key ${escaped(KEY)}"}}`;
  const result = await client(body, 400).complete(request);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).not.toContain(KEY);
});

test("no stored record carries the key", async () => {
  const original = "src/a.ts:1 E_FAIL\n".repeat(2000);
  for (const [n, raw] of [splitBlocks, escapedText].entries()) {
    const store = new CompactionStore(root);
    const compactor = new ToolOutputCompactor({
      store,
      client: client(raw),
      settings: { enabled: true, minTokens: 4000, timeoutMs: 1000, maxRatio: 0.6 },
    });
    const id = `t${n}`;
    const p = {
      model,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name: "Bash", input: { command: "x" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: original }] },
      ],
    };
    await compactor.compact(p, session);
    expect(JSON.stringify(p)).not.toContain(KEY);
  }
  const dir = join(root, session);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(2);
  for (const f of files) expect(readFileSync(join(dir, f), "utf8")).not.toContain(KEY);
});
