/**
 * Tests for the tokenizer loader used by the cache min-size gate.
 *
 * Run: bun test packages/cli/src/handlers/shared/anthropic-tokenizer.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenizerSourceFor } from "./anthropic-cache.js";
import { countTokensViaTokenizer } from "./anthropic-tokenizer.js";

// A minimal whitespace WordLevel tokenizer: one id per space-separated word.
const MINI = JSON.stringify({
  version: "1.0",
  model: { type: "WordLevel", vocab: { hello: 0, world: 1, "[UNK]": 2 }, unk_token: "[UNK]" },
  pre_tokenizer: { type: "Whitespace" },
});

describe("countTokensViaTokenizer", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("counts tokens from a local file source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-tok-"));
    const path = join(dir, "tokenizer.json");
    writeFileSync(path, MINI);
    try {
      expect(await countTokensViaTokenizer({ kind: "file", path }, "hello world hello")).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fetches a url source, then counts", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(MINI, { headers: { "Content-Type": "application/json" } }),
    });
    const url = `http://localhost:${server.port}/tokenizer.json`;
    expect(await countTokensViaTokenizer({ kind: "url", url }, "world world")).toBe(2);
  });

  test("returns undefined when the tokenizer cannot load (caller uses the estimate)", async () => {
    expect(
      await countTokensViaTokenizer({ kind: "file", path: "/no/such/tokenizer.json" }, "x")
    ).toBeUndefined();
  });
});

describe("tokenizerSourceFor", () => {
  const map = {
    "glm-4.6": { kind: "hub" as const, repo: "zai-org/GLM-4.6" },
    "kimi-*": { kind: "file" as const, path: "/k.json" },
  };

  test("exact match wins", () => {
    expect(tokenizerSourceFor("glm-4.6", map)).toEqual({ kind: "hub", repo: "zai-org/GLM-4.6" });
  });

  test("glob match", () => {
    expect(tokenizerSourceFor("kimi-k2.5", map)).toEqual({ kind: "file", path: "/k.json" });
  });

  test("no match, or no map, is undefined", () => {
    expect(tokenizerSourceFor("gpt-5", map)).toBeUndefined();
    expect(tokenizerSourceFor("anything", undefined)).toBeUndefined();
  });
});
