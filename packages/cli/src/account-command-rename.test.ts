import { expect, test } from "bun:test";
import { ACCOUNT_HELP, parseAccountMutation } from "./account-command.js";

test("REQ-7 add permits the absent label and explicit override", () => {
  expect(parseAccountMutation(["add", "codex"])).toEqual({ verb: "add", label: undefined });
  expect(parseAccountMutation(["add", "codex", "--label", "jack+x@example.com"])).toEqual({
    verb: "add",
    label: "jack+x@example.com",
  });
});

test("REQ-7 rename parses label and email selectors or an explicit id", () => {
  expect(parseAccountMutation(["rename", "codex", "work", "jack@example.com"])).toEqual({
    verb: "rename",
    selector: "work",
    id: undefined,
    newLabel: "jack@example.com",
  });
  expect(
    parseAccountMutation(["rename", "codex", "jack@example.com", "--id", "aaaaaaaaaaaa"])
  ).toEqual({
    verb: "rename",
    selector: undefined,
    id: "aaaaaaaaaaaa",
    newLabel: "jack@example.com",
  });
});

for (const verb of ["login", "enable", "disable"] as const) {
  test(`REQ-4 REQ-7 ${verb} preserves the email selector and optional id`, () => {
    expect(parseAccountMutation([verb, "codex", "o'brien@x.com"])).toEqual({
      verb,
      selector: "o'brien@x.com",
      id: undefined,
    });
    expect(parseAccountMutation([verb, "codex", "--id", "aaaaaaaaaaaa"])).toEqual({
      verb,
      selector: undefined,
      id: "aaaaaaaaaaaa",
    });
  });
}

test("REQ-7 remove preserves confirmation and file deletion flags", () => {
  expect(parseAccountMutation(["remove", "codex", "work", "--yes", "--delete-file"])).toEqual({
    verb: "remove",
    selector: "work",
    id: undefined,
    yes: true,
    deleteFile: true,
  });
});

const bad = [
  ["rename", "codex", "work"],
  ["rename", "codex"],
  ["rename", "codex", "a", "b", "c"],
  ["rename", "codex", "a", "b", "--label", "x"],
  ["rename", "codex", "a", "b", "--unknown"],
  ["rename", "codex", "b", "--id"],
  ["rename", "codex", "b", "--id", "aaaaaaaaaaaa", "--id", "bbbbbbbbbbbb"],
  ["add", "codex", "positional"],
  ["add", "codex", "--id", "aaaaaaaaaaaa"],
  ["add", "codex", "--label", "a", "--label", "b"],
  ["add", "codex", "--label"],
  ["unknown", "codex"],
  ["use", "codex", "a"],
  ["import", "codex", "a"],
  ["rename", "claude", "a", "b"],
];
for (const args of bad) {
  test(`REQ-7 invalid arguments end their error with help: ${JSON.stringify(args)}`, () => {
    let message = "";
    try {
      parseAccountMutation(args);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message.endsWith(ACCOUNT_HELP)).toBe(true);
  });
}

test("REQ-7 parser preserves an id value for management validation", () => {
  expect(parseAccountMutation(["rename", "codex", "b", "--id", "../invalid"])).toEqual({
    verb: "rename",
    selector: undefined,
    id: "../invalid",
    newLabel: "b",
  });
});

test("REQ-7 help documents rename, optional add label and email selectors", () => {
  expect(ACCOUNT_HELP).toMatch(/rename/);
  expect(ACCOUNT_HELP).toMatch(/\[.*--label.*\]|--label[^\n]*optional|optional[^\n]*--label/i);
  expect(ACCOUNT_HELP).toMatch(/email/i);
});
