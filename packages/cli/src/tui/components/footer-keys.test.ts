// REGRESSION: Vertex config TUI showed oauth but offered only "set key" and an unexplained 403 — Fixed in /dev:fix session dev-fix-20261020-235500-vtx01
import { describe, expect, test } from "bun:test";
import * as footer from "./Footer.js";

const baseCaps = {
  apiKey: true,
  oauth: false,
  endpoint: false,
  local: false,
  localEnabled: false,
};

function keyLabels(caps: Parameters<typeof footer.providerFooterKeys>[0]): string[][] {
  return footer.providerFooterKeys(caps).map(([, key, label]) => [key, label]);
}

describe("Providers-tab footer keys", () => {
  test('setLabel "project" shows s set project instead of s set key', () => {
    const keys = keyLabels({ ...baseCaps, setLabel: "project" });

    expect(keys).toContainEqual(["s", "set project"]);
    expect(keys).not.toContainEqual(["s", "set key"]);
  });

  test("an absent setLabel keeps s set key", () => {
    expect(keyLabels(baseCaps)).toContainEqual(["s", "set key"]);
  });

  test('setLabel "key" keeps s set key', () => {
    expect(keyLabels({ ...baseCaps, setLabel: "key" })).toContainEqual(["s", "set key"]);
  });

  test("OAuth login support shows l login", () => {
    expect(keyLabels({ ...baseCaps, oauth: true })).toContainEqual(["l", "login"]);
  });

  test("no OAuth login support omits the l chip", () => {
    expect(keyLabels({ ...baseCaps, oauth: false }).some(([key]) => key === "l")).toBe(false);
  });

  test("undefined capabilities keep the default set-key and login chips", () => {
    const keys = keyLabels(undefined);

    expect(keys).toContainEqual(["s", "set key"]);
    expect(keys).toContainEqual(["l", "login"]);
  });
});
