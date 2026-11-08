import { afterEach, expect, test } from "bun:test";
import { getCodeModeStores, peekCodeModeStores, resetCodeModeStores } from "./stores";

afterEach(() => resetCodeModeStores());

test("REQ-27 creates stores lazily, reuses the active set and resets without retaining data", () => {
  resetCodeModeStores();
  expect(peekCodeModeStores()).toBeUndefined();
  const first = getCodeModeStores();
  expect(getCodeModeStores()).toBe(first);
  expect(peekCodeModeStores()).toBe(first);
  first.scripts.pin("T3-session");
  first.scripts.create({
    accountKey: "T3-account",
    sessionKey: "T3-session",
    execCallId: "T3-exec",
    originalCallId: "T3-exec",
    source: "x",
    shape: "classic",
    state: "completed",
  });
  expect(first.turns.put("T3-session", "T3-anchor", [])).toBe(true);

  resetCodeModeStores();

  expect(peekCodeModeStores()).toBeUndefined();
  const second = getCodeModeStores();
  expect(second).not.toBe(first);
  expect(second.scripts.size).toBe(0);
  expect(second.scripts.bytes).toBe(0);
  expect(second.scripts.isPinned("T3-session")).toBe(false);
  expect(second.turns.size).toBe(0);
  expect(second.turns.bytes).toBe(0);
  expect(second.turns.get("T3-session", "T3-anchor")).toBeUndefined();
});
