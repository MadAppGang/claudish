import { describe, expect, test } from "bun:test";
import { inlineSystemAsUserText } from "./inline-system.js";
import { convertMessagesToOpenAI } from "./openai-messages.js";

const NOTICE =
  "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nTask done.\n</system-reminder>";
const toolUse = {
  role: "assistant",
  content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
};
const toolResult = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }],
};

describe("inlineSystemAsUserText", () => {
  test("returns the array given when there is no system message", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(inlineSystemAsUserText(messages)).toBe(messages);
  });

  test("a notification after a tool result joins that user message, after the result", () => {
    // The shape of a captured request: tool_use, tool_result, then the notice.
    const out = inlineSystemAsUserText([
      { role: "user", content: "start" },
      toolUse,
      toolResult,
      { role: "system", content: [{ type: "text", text: NOTICE }] },
      { role: "assistant", content: [{ type: "text", text: "next" }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(out[2].content).toEqual([toolResult.content[0], { type: "text", text: NOTICE }]);
  });

  test("everything before the notification is unchanged, so a cached prefix still matches", () => {
    const before = [{ role: "user", content: "start" }, toolUse];
    const out = inlineSystemAsUserText([
      ...before,
      toolResult,
      { role: "system", content: NOTICE },
    ]);
    expect(out.slice(0, 2)).toEqual(before);
    expect(out[0]).toBe(before[0]);
  });

  const call = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} });
  const result = (id: string) => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: `REAL_${id.toUpperCase()}` }],
  });
  const system = (text: string) => ({ role: "system", content: text });
  const start = [
    { role: "user", content: "start" },
    { role: "assistant", content: [call("a"), call("b"), call("c")] },
  ];
  /** Each tool call's result on the Chat Completions wire; every notice must be sent. */
  const onWire = (messages: any[], notices: string[]) => {
    const wire = convertMessagesToOpenAI({ messages: inlineSystemAsUserText(messages) }, "test");
    const text = JSON.stringify(wire);
    for (const notice of notices) expect(text).toContain(notice);
    return wire.filter((m: any) => m.role === "tool").map((m: any) => [m.tool_call_id, m.content]);
  };
  const REAL = [
    ["a", "REAL_A"],
    ["b", "REAL_B"],
    ["c", "REAL_C"],
  ];

  test("a notification at each gap of three parallel results: every call keeps its real result", () => {
    const messages = [...start, result("a"), system("N1"), result("b"), system("N2"), result("c")];
    expect(onWire(messages, ["N1", "N2"])).toEqual(REAL);
    // Both notices follow the round's last result, in order.
    const out = inlineSystemAsUserText(messages);
    const lastUser = out[out.length - 1];
    expect(lastUser.content.map((b: any) => b.type)).toEqual(["tool_result", "text", "text"]);
  });

  test("a notification before the first result waits for the round's last result", () => {
    const messages = [...start, system("N"), result("a"), result("b"), result("c")];
    expect(onWire(messages, ["N"])).toEqual(REAL);
  });

  test("a notification between a call and its one result goes after the result", () => {
    const messages = [
      { role: "user", content: "start" },
      { role: "assistant", content: [call("a")] },
      system("N"),
      result("a"),
    ];
    const out = inlineSystemAsUserText(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[2].content.map((b: any) => b.type)).toEqual(["tool_result", "text"]);
  });

  test("a round left open by an interrupted call does not hold the text back", () => {
    const messages = [...start, result("a"), system("N"), { role: "user", content: "never mind" }];
    const out = inlineSystemAsUserText(messages);
    expect(out.some((m) => m.role === "system")).toBe(false);
    // The notice follows the one result that arrived, before the user's new turn.
    expect(out[2].content.map((b: any) => b.type)).toEqual(["tool_result", "text"]);
    expect(out[3]).toEqual({ role: "user", content: "never mind" });
  });

  test("the wire form of earlier messages is the same on the next request", () => {
    // The notice is last in request 1 and has a user message after it in request 2.
    const first = [{ role: "user", content: "OLD" }, system("NOTICE")];
    const second = [...first, { role: "user", content: "NEW" }];
    const a = inlineSystemAsUserText(first);
    const b = inlineSystemAsUserText(second);
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b[a.length]).toEqual({ role: "user", content: "NEW" });
  });

  test("a notice after an assistant message: the user's next turn joins it, after the notice", () => {
    const first = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      system("NOTICE"),
    ];
    const second = [...first, { role: "user", content: "NEW" }];
    const a = inlineSystemAsUserText(first);
    const b = inlineSystemAsUserText(second);
    expect(b.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // Request 1's last message is a prefix of request 2's: it only grew at its end.
    expect(b[2].content.slice(0, a[2].content.length)).toEqual(a[2].content);
    expect(b[2].content[b[2].content.length - 1]).toEqual({ type: "text", text: "NEW" });
  });

  test("system messages that open the conversation go before the first user text", () => {
    const out = inlineSystemAsUserText([
      { role: "system", content: "SKILLS" },
      { role: "system", content: [{ type: "text", text: "MCP" }] },
      { role: "user", content: "hello" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content.map((b: any) => b.text)).toEqual([
      "<system-reminder>\nSKILLS\n</system-reminder>",
      "<system-reminder>\nMCP\n</system-reminder>",
      "hello",
    ]);
  });

  test("a call's results in a later message than the notice: text goes after them", () => {
    const toolUseOne = { role: "assistant", content: [call("t1")] };
    const out = inlineSystemAsUserText([toolUseOne, system("N"), result("t1")]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(out[1].content.map((b: any) => b.type)).toEqual(["tool_result", "text"]);
  });

  test("with no user message beside it, the text becomes a user message of its own", () => {
    const out = inlineSystemAsUserText([
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "system", content: "N" },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(out[1].content[0].text).toContain("N");
  });

  test("text that Claude Code already wrapped is not wrapped again", () => {
    const out = inlineSystemAsUserText([
      { role: "user", content: "x" },
      { role: "system", content: NOTICE },
    ]);
    expect(out[0].content[1].text).toBe(NOTICE);
  });

  test("a system message with no text is dropped, and nothing else changes", () => {
    const out = inlineSystemAsUserText([
      { role: "user", content: "x" },
      { role: "system", content: [{ type: "tool_addition", tool: { definition: {} } }] },
    ]);
    expect(out).toEqual([{ role: "user", content: "x" }]);
  });

  test("does not mutate the messages it is given", () => {
    const messages = [
      { role: "user", content: "x" },
      { role: "system", content: "N" },
    ];
    const copy = structuredClone(messages);
    inlineSystemAsUserText(messages);
    expect(messages).toEqual(copy);
  });
});
