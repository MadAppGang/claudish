import { afterEach, describe, expect, test } from "bun:test";
import { FakeHerdr } from "../pane/test-helpers/fake-herdr.js";
import { HerdrSocket, lineReader } from "./herdr-socket.js";

describe("HerdrSocket against herdr's one-reply connections", () => {
  let fake: FakeHerdr | null = null;
  let client: HerdrSocket | null = null;
  afterEach(async () => {
    client?.close();
    await fake?.stop();
    fake = null;
    client = null;
  });

  test("a request right after an answered one gets its own answer", async () => {
    fake = await FakeHerdr.start();
    fake.addWorkspace("w1");
    client = new HerdrSocket(fake.path);
    const first = await client.request<{ tabs: unknown[] }>("tab.list", { workspace_id: "w1" });
    const second = await client.request<{ tabs: unknown[] }>("tab.list", { workspace_id: "w1" });
    expect(first.tabs).toHaveLength(1);
    expect(second.tabs).toHaveLength(1);
  });

  test("requests sent together are all answered", async () => {
    fake = await FakeHerdr.start();
    fake.addWorkspace("w1");
    client = new HerdrSocket(fake.path);
    const answers = await Promise.all(
      [1, 2, 3].map(() => client?.request("tab.list", { workspace_id: "w1" }))
    );
    expect(answers).toHaveLength(3);
    expect(fake.callsOf("tab.list")).toHaveLength(3);
  });
});

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
