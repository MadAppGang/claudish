import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  WireMarkerError,
  WireMarkerHandler,
  formatWireMarkers,
  splitWireMarkers,
  wireMarkerContext,
} from "./wire-markers.js";

test.each([
  ["cx@gpt+pro", { spec: "cx@gpt", mode: "pro" }],
  ["cx@gpt#fast", { spec: "cx@gpt", speed: "fast" }],
  ["cx@gpt+pro#fast:3", { spec: "cx@gpt:3", mode: "pro", speed: "fast" }],
  ["cx@gpt#FAST+PRO:3", { spec: "cx@gpt:3", mode: "pro", speed: "fast" }],
  ["cx@gpt+standard", { spec: "cx@gpt", mode: "standard" }],
  ["cx@gpt:3", { spec: "cx@gpt:3" }],
] as const)("splits %s", (input, expected) => {
  expect(splitWireMarkers(input)).toEqual(expected);
  expect(splitWireMarkers(formatWireMarkers(expected))).toEqual(expected);
});
test.each(["x+pro+standard", "x#fast#flex", "x+pro-middle", "x#fast-middle"])(
  "rejects misplaced or duplicate %s",
  (input) => {
    expect(() => splitWireMarkers(input)).toThrow(WireMarkerError);
  }
);
test.each([
  ["x+typo", "modes: +standard, +pro"],
  ["x#typo", "speeds: #standard, #fast, #priority, #flex, #ultrafast"],
])("lists valid values for %s", (input, list) => {
  expect(() => splitWireMarkers(input)).toThrow(list);
});
test("handler scopes markers to the asynchronous request and forwards shutdown", async () => {
  const markers = { spec: "x", mode: "pro" as const, speed: "fast" as const };
  let shutdown = false;
  const handler = new WireMarkerHandler(
    {
      async handle(_c, payload) {
        await Promise.resolve();
        expect(wireMarkerContext.getStore()).toEqual(markers);
        expect(payload).toEqual({ hello: true });
        return new Response("ok");
      },
      async shutdown() {
        shutdown = true;
      },
    },
    markers
  );
  const app = new Hono();
  app.post("/", (c) => handler.handle(c, { hello: true }));
  expect(wireMarkerContext.getStore()).toBeUndefined();
  expect(await (await app.request("/", { method: "POST" })).text()).toBe("ok");
  expect(wireMarkerContext.getStore()).toBeUndefined();
  await handler.shutdown();
  expect(shutdown).toBe(true);
});
