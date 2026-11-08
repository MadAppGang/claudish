import { describe, expect, test } from "bun:test";
import { useBlackboxEnv } from "../../test-helpers/blackbox-env.ts";
import { HOOK_API_VERSION, act, defineHook } from "../public.ts";

useBlackboxEnv();

describe("FR-6 / FR-7 public author API (§4.3)", () => {
  const schema = { type: "object" as const, properties: { x: { type: "number" } } };
  const cases: Array<[string, () => unknown, unknown]> = [
    [
      "P-1 injectSystemNote",
      () => act.injectSystemNote("NOTE"),
      { type: "injectSystemNote", text: "NOTE" },
    ],
    [
      "P-2 appendUserText",
      () => act.appendUserText("TAIL"),
      { type: "appendUserText", text: "TAIL" },
    ],
    [
      "P-3 replaceMessageText",
      () =>
        act.replaceMessageText("(a)", "$1!", { regex: true, flags: "gi", roles: ["assistant"] }),
      {
        type: "replaceMessageText",
        find: "(a)",
        replace: "$1!",
        regex: true,
        flags: "gi",
        roles: ["assistant"],
      },
    ],
    [
      "P-4 removeMessageText",
      () => act.removeMessageText("private", { roles: ["user"] }),
      { type: "removeMessageText", find: "private", roles: ["user"] },
    ],
    [
      "P-5 rewriteToolDescription",
      () => act.rewriteToolDescription("Read", "TAIL"),
      { type: "rewriteToolDescription", tool: "Read", append: "TAIL" },
    ],
    [
      "P-6 replaceToolDescription",
      () => act.replaceToolDescription("Read", "NEW"),
      { type: "replaceToolDescription", tool: "Read", description: "NEW" },
    ],
    [
      "P-7 replaceToolSchema",
      () => act.replaceToolSchema("Read", schema),
      { type: "replaceToolSchema", tool: "Read", inputSchema: schema },
    ],
    ["P-8 removeTool", () => act.removeTool("Read"), { type: "removeTool", tool: "Read" }],
    [
      "P-9 repairToolArgs",
      () => act.repairToolArgs({ x: 3 }, "normalise"),
      { type: "repairToolArgs", args: { x: 3 }, reason: "normalise" },
    ],
    ["P-10 appendText", () => act.appendText("END"), { type: "appendText", text: "END" }],
    ["P-11 prependText", () => act.prependText("START"), { type: "prependText", text: "START" }],
    [
      "P-12 replaceText",
      () => act.replaceText("(x)", "$1!", { regex: true, flags: "i" }),
      { type: "replaceText", find: "(x)", replace: "$1!", regex: true, flags: "i" },
    ],
    [
      "P-13 removeText",
      () => act.removeText("x", { regex: true, flags: "g" }),
      { type: "removeText", find: "x", regex: true, flags: "g" },
    ],
    [
      "P-14 injectUserTurn",
      () => act.injectUserTurn("HOOK-PING"),
      { type: "injectUserTurn", text: "HOOK-PING" },
    ],
    [
      "P-15 annotateTurn",
      () => act.annotateTurn("seen", { n: 1 }),
      { type: "annotateTurn", key: "seen", value: { n: 1 } },
    ],
    ["P-16 warn", () => act.warn("advisory"), { type: "warn", message: "advisory" }],
  ];

  for (const [name, call, expected] of cases) {
    test(`${name} returns exactly the closed action data`, () => {
      expect(call()).toEqual(expected);
    });
  }

  test("P-17 defineHook returns the same definition and supports apiVersion 1", () => {
    const h = {
      apiVersion: 1 as const,
      id: "author",
      on: {
        request() {
          return [];
        },
      },
    };
    expect({ identity: defineHook(h) === h, version: HOOK_API_VERSION }).toEqual({
      identity: true,
      version: 1,
    });
  });
});
