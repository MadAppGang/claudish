import { heapStats } from "bun:jsc";
import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSearch, layoutRows } from "./conversation-reader.js";
import { type ReaderTurn, readConversation, wrapOffsets } from "./conversation.js";

const tempDir = mkdtempSync(join(tmpdir(), "claudish-conversation-test-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function transcriptFile(name: string, records: Record<string, unknown>[]): string {
  const file = join(tempDir, name);
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

function userRecord(
  content: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    message: { role: "user", content },
    ...overrides,
  };
}

function assistantRecord(
  content: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    message: { role: "assistant", content },
    ...overrides,
  };
}

describe("conversation transcript reader", () => {
  // Transcript extraction tests.
  test("keeps only main-conversation prose and strips inline reminders", () => {
    const file = transcriptFile("turn-filter.jsonl", [
      userRecord(
        "Please keep my own words.\n\n<system-reminder>internal harness context</system-reminder>\n\nThey survive after the reminder."
      ),
      userRecord("<task-notification>background task finished</task-notification>"),
      userRecord("subagent-only traffic", { isSidechain: true }),
      userRecord("metadata-only traffic", { isMeta: true }),
      userRecord([
        { type: "text", text: "text beside a tool response" },
        { type: "tool_result", tool_use_id: "tool-1", content: "tool output" },
      ]),
      assistantRecord([
        { type: "tool_use", id: "tool-1", name: "Write", input: { text: "tool-only" } },
      ]),
      { type: "ai-title", aiTitle: "Generated title, not a turn" },
      assistantRecord([{ type: "text", text: "I will keep the human text." }]),
    ]);

    const conversation = readConversation(file, { chunkBytes: 37 });

    expect(conversation.turns).toEqual([
      {
        role: "user",
        text: "Please keep my own words.\n\nThey survive after the reminder.",
        elided: false,
      },
      { role: "assistant", text: "I will keep the human text.", elided: false },
    ]);

    const retained = conversation.turns.map((turn) => turn.text).join("\n");
    for (const excluded of [
      "background task finished",
      "subagent-only traffic",
      "metadata-only traffic",
      "text beside a tool response",
      "tool-only",
      "Generated title, not a turn",
      "internal harness context",
    ]) {
      expect(retained).not.toContain(excluded);
    }
  });

  test("does not reject assistant prose that quotes structural marker strings", () => {
    const prose = 'These are quoted JSON markers: "isSidechain":true and "type":"tool_result".';
    const line = JSON.stringify(assistantRecord([{ type: "text", text: prose }]));
    const file = join(tempDir, "quoted-markers.jsonl");
    writeFileSync(file, `${line}\n`);

    expect(line).toContain('\\"isSidechain\\":true');
    expect(line).toContain('\\"type\\":\\"tool_result\\"');
    expect(readConversation(file).turns).toEqual([
      { role: "assistant", text: prose, elided: false },
    ]);
  });

  test("keeps newest turns under the total cap and reports per-turn elision", () => {
    const totalFile = transcriptFile("total-cap.jsonl", [
      userRecord("oldest-1"),
      assistantRecord([{ type: "text", text: "middle-2" }]),
      userRecord("newest-3"),
    ]);
    const totalCapped = readConversation(totalFile, { maxTotalChars: 12 });

    expect(totalCapped.turns).toEqual([{ role: "user", text: "newest-3", elided: false }]);
    expect(totalCapped.dropped).toBe(2);

    const turnFile = transcriptFile("turn-cap.jsonl", [
      assistantRecord([{ type: "text", text: "abcdefghij" }]),
    ]);
    const turnCapped = readConversation(turnFile, { maxTurnChars: 5 });

    expect(turnCapped.anyElided).toBe(true);
    expect(turnCapped.turns).toHaveLength(1);
    expect(turnCapped.turns[0]?.elided).toBe(true);
    expect(turnCapped.turns[0]?.text).toStartWith("abcde\n\n… turn truncated at 5 characters");
  });
});

describe("conversation layout and search", () => {
  test("counts every case-insensitive substring occurrence across turns", () => {
    const turns: ReaderTurn[] = [
      { role: "user", text: "Needle NEEDLE needLe", elided: false },
      { role: "assistant", text: "needlework has another needle", elided: false },
    ];
    const { rows, turnStart, turnEnd } = layoutRows(turns, 80);
    const search = buildSearch(turns, rows, turnStart, turnEnd, "nEeDlE");

    expect(search.hits).toHaveLength(5);
    expect([...search.ranges.values()].flat()).toHaveLength(5);
  });

  test("counts a match across a wrap once and highlights both rows", () => {
    const text = "prefixABCDsuffix";
    expect(wrapOffsets(text, 8)).toEqual([
      { start: 0, end: 8 },
      { start: 8, end: 16 },
    ]);

    const turns: ReaderTurn[] = [{ role: "user", text, elided: false }];
    const { rows, turnStart, turnEnd } = layoutRows(turns, 8);
    const search = buildSearch(turns, rows, turnStart, turnEnd, "ABCD");

    expect(search.hits).toEqual([0]);
    expect(search.ranges.get(0)).toEqual([{ s: 6, e: 8, hit: 0 }]);
    expect(search.ranges.get(1)).toEqual([{ s: 0, e: 2, hit: 0 }]);
  });

  test("returns no search hits for empty or absent queries", () => {
    const turns: ReaderTurn[] = [{ role: "assistant", text: "some prose", elided: false }];
    const layout = layoutRows(turns, 20);
    expect(buildSearch(turns, layout.rows, layout.turnStart, layout.turnEnd, "").hits).toEqual([]);
    expect(
      buildSearch(turns, layout.rows, layout.turnStart, layout.turnEnd, "missing").hits
    ).toEqual([]);
  });

  test("wrapOffsets stays bounded, honors newlines, and hard-breaks long words", () => {
    const text = "short\nsupercalifragilistic end";
    const slices = wrapOffsets(text, 5);
    expect(slices).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 11, end: 16 },
      { start: 16, end: 21 },
      { start: 21, end: 26 },
      { start: 27, end: 30 },
    ]);

    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]!;
      expect(slice.start).toBeGreaterThanOrEqual(0);
      expect(slice.start).toBeLessThanOrEqual(slice.end);
      expect(slice.end).toBeLessThanOrEqual(text.length);
      if (i > 0) {
        expect(slice.start).toBeGreaterThanOrEqual(slices[i - 1]!.start);
        expect(slice.end).toBeGreaterThanOrEqual(slices[i - 1]!.end);
      }
    }
    expect(slices[1]?.start).toBe(text.indexOf("\n") + 1);

    expect(slices.slice(1, 5).map(({ start, end }) => text.slice(start, end))).toEqual([
      "super",
      "calif",
      "ragil",
      "istic",
    ]);
  });
});

describe("large conversation streaming", () => {
  test("does not retain file-sized prose or heap", () => {
    const file = join(tempDir, "large-streamed.jsonl");
    writeFileSync(file, "");
    const expected: ReaderTurn[] = [
      { role: "user", text: "first real turn", elided: false },
      { role: "assistant", text: "second real turn", elided: false },
      { role: "user", text: "third real turn", elided: false },
      { role: "assistant", text: "fourth real turn", elided: false },
      { role: "user", text: "fifth real turn", elided: false },
    ];

    const realAt = new Map([
      [0, expected[0]!],
      [40, expected[1]!],
      [80, expected[2]!],
      [120, expected[3]!],
      [159, expected[4]!],
    ]);
    const toolResultLine = `${JSON.stringify(
      userRecord([
        {
          type: "tool_result",
          tool_use_id: "large-output",
          content: "x".repeat(256 * 1024),
        },
      ])
    )}\n`;

    const fd = openSync(file, "a");
    try {
      for (let i = 0; i < 160; i++) {
        writeSync(fd, toolResultLine);
        const turn = realAt.get(i);
        if (turn) {
          const record =
            turn.role === "user"
              ? userRecord(turn.text)
              : assistantRecord([{ type: "text", text: turn.text }]);
          writeSync(fd, `${JSON.stringify(record)}\n`);
        }
      }
    } finally {
      closeSync(fd);
    }

    const fileSize = statSync(file).size;
    expect(fileSize).toBeGreaterThan(39 * 1024 * 1024);
    // The live heap after a full collection, from `heapStats().heapSize`. Bun 1.3's
    // `process.memoryUsage().heapUsed` is the size recorded at the last EDEN collection:
    // `Bun.gc(true)` does not update it, and an eden collection counts every promoted dead
    // chunk as live. An eden collection in the middle of this read made it report 30 MB
    // that nothing held.
    Bun.gc(true);
    const heapBefore = heapStats().heapSize;
    const conversation = readConversation(file);
    Bun.gc(true);
    const heapAfter = heapStats().heapSize;
    const heapDelta = Math.max(0, heapAfter - heapBefore);

    expect(conversation.turns).toEqual(expected);
    expect(conversation.chars).toBe(expected.reduce((sum, turn) => sum + turn.text.length, 0));
    expect(conversation.chars).toBeLessThan(fileSize * 0.01);
    expect(heapDelta).toBeLessThan(fileSize * 0.25);
  }, 30_000);
});
