import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { CompactionClient } from "./haiku-client.js";
import {
  EmbedTopicDecider,
  type TopicInput,
  cosine,
  decideTopicAction,
  ollamaEmbed,
  parseTopicVerdict,
  topicDeciderFor,
} from "./topic.js";

const FOLLOW_UP: TopicInput = {
  prompt: "add a test for the fix you made earlier",
  summary: "The user asked to fix the parser bug in parse.ts; the fix landed.",
  recent: ["Fix the off-by-one in parse.ts", "Fixed: parse.ts now checks the last index."],
};
const NEW_TOPIC: TopicInput = {
  prompt: "Write me a sourdough bread recipe for a weekend bake",
  summary: FOLLOW_UP.summary,
  recent: FOLLOW_UP.recent,
};

/** A fake embedding: one axis for code work, one for baking. */
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((t) => {
      const code = /pars|fix|test/i.test(t) ? 1 : 0;
      const bake = /bread|recipe|bake/i.test(t) ? 1 : 0;
      return [code, bake, 0.05];
    })
  );
}

describe("cosine", () => {
  test("equal directions are 1, orthogonal 0", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 9);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("parseTopicVerdict", () => {
  test("reads the structured answer", () => {
    const r = parseTopicVerdict('{"topic":"new","confidence":0.92,"reason":"baking, not code"}');
    expect(r).toEqual({
      ok: true,
      verdict: { topic: "new", confidence: 0.92, reason: "baking, not code" },
    });
  });

  test("refuses an answer that is not the schema", () => {
    expect(parseTopicVerdict("new").ok).toBe(false);
    expect(parseTopicVerdict('{"topic":"other","confidence":1,"reason":""}').ok).toBe(false);
    expect(parseTopicVerdict('{"topic":"new","confidence":7,"reason":""}').ok).toBe(false);
  });
});

describe("EmbedTopicDecider", () => {
  test("a follow-up that refers back is related", async () => {
    const r = await new EmbedTopicDecider(fakeEmbed, 0.5).decide(FOLLOW_UP);
    expect(r.ok && r.verdict.topic).toBe("related");
    expect(r.ok && r.verdict.similarity).toBeGreaterThan(0.5);
  });

  test("a clear topic change is new", async () => {
    const r = await new EmbedTopicDecider(fakeEmbed, 0.5).decide(NEW_TOPIC);
    expect(r.ok && r.verdict.topic).toBe("new");
    expect(r.ok && r.verdict.similarity).toBeLessThan(0.5);
  });

  test("an embedder failure is not a verdict", async () => {
    const failing = () => Promise.reject(new Error("connection refused"));
    const r = await new EmbedTopicDecider(failing, 0.5).decide(NEW_TOPIC);
    expect(r).toEqual({ ok: false, reason: "embedding failed: connection refused" });
  });
});

describe("ollamaEmbed", () => {
  test("an unreachable Ollama rejects, naming the URL", async () => {
    // A port that was free a moment ago: nothing listens on it.
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const embed = ollamaEmbed({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "nomic-embed-text",
      timeoutMs: 2000,
      fetchImpl: fetch,
    });
    await expect(embed(["x"])).rejects.toThrow(`Ollama at http://127.0.0.1:${port}`);
  });

  test("posts the texts to /api/embed and returns its embeddings", async () => {
    let body: unknown;
    const embed = ollamaEmbed({
      baseUrl: "http://ollama.test",
      model: "nomic-embed-text",
      timeoutMs: 2000,
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe("http://ollama.test/api/embed");
        body = JSON.parse(String(init.body));
        return Response.json({
          embeddings: [
            [1, 0],
            [0, 1],
          ],
        });
      }) as unknown as typeof fetch,
    });
    expect(await embed(["a", "b"])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(body).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
  });
});

describe("topicDeciderFor", () => {
  const client = {} as unknown as CompactionClient;
  const topic = {
    decider: "haiku" as const,
    floorTokens: 30_000,
    minConfidence: 0.7,
    similarityBelow: 0.5,
    timeoutMs: 5000,
    embedModel: "nomic-embed-text",
  };
  const history = { enabled: true, policy: "topic" as const, precomputeAt: 0.6, applyAt: 0.75 };

  test("haiku and embed build their deciders under the topic policy", () => {
    expect(topicDeciderFor({ ...history, topic }, client, "http://o")?.name).toBe("haiku");
    expect(
      topicDeciderFor({ ...history, topic: { ...topic, decider: "embed" } }, client, "http://o")
        ?.name
    ).toBe("embed");
  });

  test("another policy builds none", () => {
    expect(topicDeciderFor({ ...history, policy: "cost", topic }, client, "http://o")).toBe(
      undefined
    );
  });
});

describe("decideTopicAction", () => {
  const verdict = (topic: "same" | "related" | "new", confidence: number) => ({
    ok: true as const,
    verdict: { topic, confidence, reason: "r" },
  });

  test("a confident new topic with a ready summary swaps", () => {
    const a = decideTopicAction({
      result: verdict("new", 0.9),
      minConfidence: 0.7,
      summaryReady: true,
      coldCache: false,
    });
    expect(a.swap).toBe(true);
  });

  test("a cold cache is reported: the swap's write costs nothing extra", () => {
    const a = decideTopicAction({
      result: verdict("new", 0.9),
      minConfidence: 0.7,
      summaryReady: true,
      coldCache: true,
    });
    expect(a.reason).toContain("cold cache");
  });

  test("same, related, low confidence, no summary and a failure all hold", () => {
    const base = { minConfidence: 0.7, summaryReady: true, coldCache: false };
    expect(decideTopicAction({ ...base, result: verdict("same", 1) }).swap).toBe(false);
    expect(decideTopicAction({ ...base, result: verdict("related", 1) }).swap).toBe(false);
    expect(decideTopicAction({ ...base, result: verdict("new", 0.5) }).swap).toBe(false);
    expect(
      decideTopicAction({ ...base, summaryReady: false, result: verdict("new", 1) }).swap
    ).toBe(false);
    const failed = decideTopicAction({ ...base, result: { ok: false, reason: "Ollama down" } });
    expect(failed.swap).toBe(false);
    expect(failed.reason).toContain("Ollama down");
  });
});
