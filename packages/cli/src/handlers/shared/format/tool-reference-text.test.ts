import { describe, expect, test } from "bun:test";
import { toolReferencesAsText } from "./tool-reference-text.js";

const reference = (name: string) => ({ type: "tool_reference", tool_name: name });
const result = (content: unknown, id = "t1") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});
const contentOf = (messages: any[], index = 0) => messages[index].content[0].content;

describe("toolReferencesAsText", () => {
  test("a result that holds only a reference becomes one sentence that names the tool", () => {
    const out = toolReferencesAsText([result([reference("WebFetch")])]);
    expect(contentOf(out)).toEqual([
      { type: "text", text: "Loaded: WebFetch. It is in your tool list now." },
    ]);
  });

  test("several references give one text item each, in order", () => {
    const out = toolReferencesAsText([result([reference("Read"), reference("Edit")])]);
    expect(contentOf(out).map((item: any) => item.text)).toEqual([
      "Loaded: Read. It is in your tool list now.",
      "Loaded: Edit. It is in your tool list now.",
    ]);
  });

  test("text and images beside a reference stay, at their positions", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } };
    const out = toolReferencesAsText([
      result([{ type: "text", text: "before" }, reference("Grep"), image]),
    ]);
    expect(contentOf(out)).toEqual([
      { type: "text", text: "before" },
      { type: "text", text: "Loaded: Grep. It is in your tool list now." },
      image,
    ]);
  });

  test("the sentence uses the name the model sees", () => {
    const nameOf = (name: string) => (name === "Read" ? "read_file" : name);
    const out = toolReferencesAsText([result([reference("Read")])], nameOf);
    expect(contentOf(out)[0].text).toBe("Loaded: read_file. It is in your tool list now.");
  });

  test("the other fields of the tool result stay", () => {
    const message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t9", is_error: false, content: [reference("LS")] },
        { type: "text", text: "after" },
      ],
    };
    const out = toolReferencesAsText([message]);
    expect(out[0].content[0].tool_use_id).toBe("t9");
    expect(out[0].content[0].is_error).toBe(false);
    expect(out[0].content[1]).toEqual({ type: "text", text: "after" });
  });

  test("returns the same array when no result holds a reference", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      result("plain string"),
      result([{ type: "text", text: "text only" }]),
    ];
    expect(toolReferencesAsText(messages)).toBe(messages);
  });

  test("does not mutate the messages it is given", () => {
    const messages = [result([reference("WebFetch")])];
    const copy = structuredClone(messages);
    toolReferencesAsText(messages);
    expect(messages).toEqual(copy);
  });

  test("a reference with no usable name is removed and not turned into a sentence", () => {
    const out = toolReferencesAsText([
      result([{ type: "text", text: "kept" }, { type: "tool_reference" }, reference("")]),
    ]);
    expect(contentOf(out)).toEqual([{ type: "text", text: "kept" }]);
  });

  test("an assistant message is not read", () => {
    const messages = [{ role: "assistant", content: [reference("WebFetch")] }];
    expect(toolReferencesAsText(messages)).toBe(messages);
  });
});
