import { describe, expect, test } from "bun:test";
import {
  type BatchResultEntry,
  batchHash,
  canonicalJson,
  completionKey,
  inputHash,
  withoutCacheMarkers,
} from "./hashes.js";

const ids = [0, 1, 2].map((seq) => `toolu_cx_c0d07fd9ccd84fe29372c0e72ed12869_${seq}`);
const entry = (seq: number, text: string): BatchResultEntry => ({
  toolUseId: ids[seq]!,
  result: { isError: false, content: [{ type: "text", text }] },
});

describe("code-mode result hashes", () => {
  test("batchHash is independent of entry order and distinguishes missing/error/content", () => {
    const entries = [entry(0, "first"), entry(1, "second"), { toolUseId: ids[2]! }];
    expect(batchHash(entries)).toBe(batchHash([entries[2]!, entries[0]!, entries[1]!]));
    expect(batchHash(entries)).not.toBe(batchHash([entry(0, "changed"), ...entries.slice(1)]));
    expect(batchHash([entry(0, "first")])).not.toBe(
      batchHash([
        {
          toolUseId: ids[0]!,
          result: { isError: true, content: [{ type: "text", text: "first" }] },
        },
      ])
    );
    expect(batchHash([{ toolUseId: ids[0]! }])).not.toBe(batchHash([entry(0, "")]));
  });

  test("a changed batch-0 result changes a three-batch completionKey", () => {
    const hashes = [
      batchHash([entry(0, "zero")]),
      batchHash([entry(1, "one")]),
      batchHash([entry(2, "two")]),
    ];
    const changed = [batchHash([entry(0, "zero changed")]), hashes[1]!, hashes[2]!];
    expect(completionKey(hashes)).not.toBe(completionKey(changed));
    expect(completionKey(hashes)).not.toBe(completionKey([...hashes].reverse()));
    expect(completionKey(hashes)).toBe(completionKey([...hashes]));
  });

  test("transport cache markers on result content blocks do not change a batch hash", () => {
    const original = entry(0, "read result");
    const marked: BatchResultEntry = {
      toolUseId: ids[0]!,
      result: {
        isError: false,
        content: [{ type: "text", text: "read result", cache_control: { type: "ephemeral" } }],
      },
    };
    expect(batchHash([marked])).toBe(batchHash([original]));
  });
});

describe("cache marker boundaries", () => {
  // Structural Claude Code messages from architecture.md §5.10, using Read from
  // code-mode/claude-code-request-body.json. Config is application data, not a marker.
  const clean = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: ids[0],
          name: "Read",
          input: { config: { cache_control: "public" } },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: ids[0], content: [{ type: "text", text: "result" }] },
      ],
    },
  ];

  test("strips message and recursively nested content-block markers only [M]", () => {
    const marked = structuredClone(clean);
    Object.assign(marked[0]!, { cache_control: { type: "ephemeral" } });
    Object.assign(marked[0]!.content[0]!, { cache_control: { type: "ephemeral" } });
    Object.assign(marked[1]!.content[0]!, { cache_control: { type: "ephemeral" } });
    const resultBlock = marked[1]!.content[0] as { content: unknown[] };
    Object.assign(resultBlock.content[0] as object, { cache_control: { type: "ephemeral" } });
    expect(withoutCacheMarkers(marked)).toEqual(clean);
  });

  test("canonicalJson and inputHash preserve application cache_control keys [M]", () => {
    const publicConfig = { config: { cache_control: "public", size: 2 } };
    const privateConfig = { config: { cache_control: "no-store", size: 2 } };
    expect(canonicalJson(publicConfig)).toContain('"cache_control":"public"');
    expect(canonicalJson(publicConfig)).not.toBe(canonicalJson(privateConfig));
    expect(inputHash(publicConfig)).not.toBe(inputHash(privateConfig));
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      canonicalJson({ a: { b: 3, y: 2 }, z: 1 })
    );
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
  });

  test("stripping markers never walks into tool inputs [M]", () => {
    const changed = structuredClone(clean);
    const use = changed[0]!.content[0] as { input: { config: { cache_control: string } } };
    use.input.config.cache_control = "no-store";
    expect(canonicalJson(withoutCacheMarkers(clean))).not.toBe(
      canonicalJson(withoutCacheMarkers(changed))
    );
    expect(inputHash(withoutCacheMarkers(clean))).not.toBe(inputHash(withoutCacheMarkers(changed)));
  });
});
