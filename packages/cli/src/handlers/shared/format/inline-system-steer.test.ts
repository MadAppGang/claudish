/**
 * Regression 2026-08-28 — a user's mid-turn message must not be hoisted.
 *
 * Claude Code surfaces a message typed while a turn is running as an inline
 * `role: "system"` message placed alongside the next tool result, and says so in
 * the text itself ("Address the message above as you continue this turn").
 * The proxy used to merge those into the system prompt: on the OpenAI wire the
 * steer survived but lost its position, and on the Codex/Responses wire it was
 * destroyed outright (buildPayload skips role:"system" and rebuilds
 * `instructions` from claudeRequest.system, which never saw the merge).
 *
 * Field measurement that motivated the fix (po-2024, GLM lane): three distinct
 * steers; the one landing at message 114/141 went unaddressed across the next
 * 52 messages until the user re-asked seven minutes later.
 */

import { describe, expect, test } from "bun:test";
import { convertMessagesToOpenAI } from "./openai-messages.js";
import { resolveInlineSystemMessages } from "./inline-system.js";
import { CodexAPIFormat } from "../../../adapters/codex-api-format.js";

const STEER =
  "<system-reminder>\nThe user sent a new message while you were working:\n" +
  "Est-ce que tu peux faire un point sur ton runner CI?\n\n" +
  "Address the message above as you continue this turn.\n</system-reminder>";

const NEEDLE = "point sur ton runner CI";

function claudeRequest() {
  return {
    system: "You are Claude Code. SYSTEM_PROMPT_HEAD",
    messages: [
      { role: "user", content: "mission initiale" },
      {
        role: "assistant",
        // The real wire shape: the steer lands BETWEEN the assistant's
        // tool_calls and the user turn carrying their results (S3 lot 1 made
        // the fixture honest — a text-only assistant made the old third test
        // assert a sequence the wire rejects).
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
      },
      { role: "system", content: STEER },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  };
}

describe("mid-turn user steer keeps its position (OpenAI wire)", () => {
  test("the steer stays in the conversation, not in the system prompt", () => {
    const messages = convertMessagesToOpenAI(claudeRequest(), "glm-5.3");
    expect(String(messages[0].content)).not.toContain(NEEDLE);
    const tail = messages.slice(1);
    expect(JSON.stringify(tail)).toContain(NEEDLE);
  });

  test("it is carried by a user-role message", () => {
    const messages = convertMessagesToOpenAI(claudeRequest(), "glm-5.3");
    const carrier = messages.find((m: any) => JSON.stringify(m.content ?? "").includes(NEEDLE));
    expect(carrier?.role).toBe("user");
  });

  test("it rides with the tool-result turn and never splits the tool round", () => {
    const messages = convertMessagesToOpenAI(claudeRequest(), "glm-5.3");
    const steerAt = messages.findIndex((m: any) =>
      JSON.stringify(m.content ?? "").includes(NEEDLE)
    );
    const toolAt = messages.findIndex((m: any) => m.role === "tool");
    expect(steerAt).toBeGreaterThan(0);
    expect(toolAt).toBeGreaterThan(0);
    // The round stays WHOLE: the tool message directly answers the assistant's
    // tool_calls (no synthetic "no result" — splitting the round on the steer
    // would fabricate one), and the steer lands in the same turn neighborhood,
    // right after the result it accompanied.
    expect(toolAt).toBeLessThan(steerAt);
    expect(messages[toolAt - 1]?.role).toBe("assistant");
    expect(messages[toolAt - 1]?.tool_calls?.[0]?.id).toBe("t1");
    expect(JSON.stringify(messages)).not.toContain("No tool result was provided");
  });
});

describe("mid-turn user steer survives the Codex/Responses conversion", () => {
  test("the steer reaches the final payload (it used to be dropped)", () => {
    const req = claudeRequest();
    const fmt = new CodexAPIFormat("gpt-5.6-sol");
    const payload = fmt.buildPayload(req, fmt.convertMessages(req), []);
    expect(JSON.stringify(payload.input)).toContain(NEEDLE);
  });

  test("an array-shaped system field is flattened into instructions, not [object Object]", () => {
    // Claude Code sends `system` as an array of text blocks. Assigning it raw
    // shipped "[object Object]" as the Codex `instructions`, silently ignored
    // upstream — the sol lane ran with no system prompt at all.
    const req: any = claudeRequest();
    req.system = [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.247" },
      { type: "text", text: "SYSTEM_PROMPT_HEAD" },
    ];
    const fmt = new CodexAPIFormat("gpt-5.6-sol");
    const payload = fmt.buildPayload(req, fmt.convertMessages(req), []);
    expect(typeof payload.instructions).toBe("string");
    expect(payload.instructions).not.toContain("[object Object]");
    expect(payload.instructions).toContain("SYSTEM_PROMPT_HEAD");
    expect(payload.instructions).toContain("cc_version=2.1.247");
  });

  test("instructions still carries the real system prompt", () => {
    const req = claudeRequest();
    const fmt = new CodexAPIFormat("gpt-5.6-sol");
    const payload = fmt.buildPayload(req, fmt.convertMessages(req), []);
    expect(payload.instructions).toContain("SYSTEM_PROMPT_HEAD");
  });
});

describe("resolveInlineSystemMessages (Anthropic wire)", () => {
  test("an inline steer becomes a user message in place", () => {
    const r = resolveInlineSystemMessages(claudeRequest().messages, "SYS");
    expect(r.inlined).toBe(1);
    expect(JSON.stringify(r.system)).not.toContain(NEEDLE);
    const carrier = r.messages.find((m: any) => JSON.stringify(m.content).includes(NEEDLE));
    expect(carrier.role).toBe("user");
  });

  test("no role:\"system\" survives in messages[] (Z.AI/MiniMax reject it)", () => {
    const r = resolveInlineSystemMessages(claudeRequest().messages, "SYS");
    expect(r.messages.some((m: any) => m.role === "system")).toBe(false);
  });

  test("the real traffic shape (user -> steer -> assistant) stays alternating", () => {
    // What Claude Code actually emits: the steer sits between the tool result it
    // was attached to and the assistant turn that follows.
    const msgs = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "system", content: STEER },
      { role: "assistant", content: [{ type: "text", text: "suite" }] },
    ];
    const r = resolveInlineSystemMessages(msgs, "SYS");
    expect(r.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(r.messages[0].content)).toContain(NEEDLE);
    // The tool_result keeps its place ahead of the appended steer text.
    expect(r.messages[0].content[0].type).toBe("tool_result");
  });

  test("a steer between two user turns is preserved (adjacency is inherent to the input)", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "system", content: STEER },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ];
    const r = resolveInlineSystemMessages(msgs, "SYS");
    // Removing the system message puts the two user turns in contact — that was
    // already true before this fix. What matters is that the steer survives, in
    // the turn Claude Code attached it to, and never in the system prompt.
    expect(JSON.stringify(r.messages[0].content)).toContain(NEEDLE);
    expect(JSON.stringify(r.system)).not.toContain(NEEDLE);
  });

  test("our own index-0 injection is still hoisted into the system field", () => {
    const msgs = [
      { role: "system", content: "FALLBACK_NOTICE" },
      { role: "user", content: [{ type: "text", text: "a" }] },
    ];
    const r = resolveInlineSystemMessages(msgs, "SYS");
    expect(r.system).toContain("FALLBACK_NOTICE");
    expect(r.inlined).toBe(0);
    expect(r.messages.some((m: any) => m.role === "system")).toBe(false);
  });

  test("an empty inline system message is dropped, not turned into an empty turn", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "system", content: "" },
    ];
    const r = resolveInlineSystemMessages(msgs, "SYS");
    expect(r.messages).toHaveLength(1);
    expect(r.inlined).toBe(0);
  });
});
