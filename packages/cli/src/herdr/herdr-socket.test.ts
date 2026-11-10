import { describe, expect, test } from "bun:test";
import { lineReader } from "./herdr-socket.js";

function reader(max: number) {
  const objects: Record<string, unknown>[] = [];
  let overflows = 0;
  const feed = lineReader(
    (o) => objects.push(o),
    () => {
      overflows += 1;
    },
    max
  );
  return { feed, objects, overflows: () => overflows };
}

describe("HerdrSocket line reader", () => {
  test("one chunk of many short lines, longer than the cap in total, is read whole", () => {
    const r = reader(1_000);
    r.feed('{"a":1}\n'.repeat(200));
    expect(r.overflows()).toBe(0);
    expect(r.objects).toHaveLength(200);
  });

  test("the cap counts bytes: an unterminated line of two-byte characters over it overflows", () => {
    const r = reader(1_000);
    r.feed(`{"t":"${"é".repeat(600)}`);
    expect(r.overflows()).toBe(1);
  });

  test("a line split across chunks under the cap is read", () => {
    const r = reader(1_000);
    r.feed('{"t":"');
    r.feed('x"}\n');
    expect(r.objects).toEqual([{ t: "x" }]);
  });
});
