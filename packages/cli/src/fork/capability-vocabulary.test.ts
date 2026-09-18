import { describe, expect, test } from "bun:test";
import {
  appendCapabilityQueryToMessage,
  buildCapabilityQuery,
  isCapabilityVocabEnabled,
  liftCapabilityDeclaration,
  parseCapabilityDeclaration,
  resetCapabilityVocabForTests,
  CAPABILITY_VOCAB_FENCE,
} from "./capability-vocabulary";

function fence(json: string): string {
  return "```" + CAPABILITY_VOCAB_FENCE + "\n" + json + "\n```";
}

describe("capability vocabulary — parseCapabilityDeclaration (#83)", () => {
  test("no marker in text → null", () => {
    expect(parseCapabilityDeclaration("plain assistant prose, no fence at all")).toBeNull();
    expect(parseCapabilityDeclaration("```json\n{\"v\":1,\"vision\":true}\n```")).toBeNull();
  });

  test("full valid declaration parses with every field", () => {
    const decl = parseCapabilityDeclaration(
      'Working on it.\n' + fence('{"v":1,"vision":true,"context_tokens_min":200000,"reasoning_depth":"high","tool_call_density":"low","cost_class":"budget"}')
    );
    expect(decl).toEqual({
      v: 1,
      vision: true,
      context_tokens_min: 200000,
      reasoning_depth: "high",
      tool_call_density: "low",
      cost_class: "budget",
    });
  });

  test("subset declaration parses; unknown fields are dropped", () => {
    const decl = parseCapabilityDeclaration(fence('{"v":1,"vision":false,"jailbreak":"please","extra":{"nested":1}}'));
    expect(decl).toEqual({ v: 1, vision: false });
  });

  test("v may be omitted; wrong v is rejected outright", () => {
    expect(parseCapabilityDeclaration(fence('{"vision":true}'))).toEqual({ v: 1, vision: true });
    expect(parseCapabilityDeclaration(fence('{"v":2,"vision":true}'))).toBeNull();
  });

  test("mistyped and out-of-enum fields are dropped, not fatal", () => {
    const decl = parseCapabilityDeclaration(
      fence('{"vision":"true","context_tokens_min":-5,"reasoning_depth":"extreme","cost_class":"free","tool_call_density":"high"}')
    );
    expect(decl).toEqual({ v: 1, tool_call_density: "high" });
  });

  test("float context floor is floored; non-finite rejected", () => {
    expect(parseCapabilityDeclaration(fence('{"context_tokens_min":123.9}'))).toEqual({ v: 1, context_tokens_min: 123 });
    expect(parseCapabilityDeclaration(fence('{"context_tokens_min":Infinity}'))).toBeNull();
  });

  test("last complete block wins (a re-emitted declaration is the newest statement)", () => {
    const text = fence('{"vision":true}') + "\nsummary text\n" + fence('{"vision":false,"cost_class":"any"}');
    expect(parseCapabilityDeclaration(text)).toEqual({ v: 1, vision: false, cost_class: "any" });
  });

  test("unclosed fence does not parse", () => {
    expect(parseCapabilityDeclaration("```" + CAPABILITY_VOCAB_FENCE + '\n{"vision":true}')).toBeNull();
  });

  test("malformed JSON → null", () => {
    expect(parseCapabilityDeclaration(fence('{"vision":'))).toBeNull();
    expect(parseCapabilityDeclaration(fence("not json at all"))).toBeNull();
  });

  test("block holding only unrecognized fields → null (noise, not a declaration)", () => {
    expect(parseCapabilityDeclaration(fence('{"v":1,"mood":"optimistic"}'))).toBeNull();
  });

  test("non-object payloads → null", () => {
    expect(parseCapabilityDeclaration(fence("[1,2,3]"))).toBeNull();
    expect(parseCapabilityDeclaration(fence('"a string"'))).toBeNull();
    expect(parseCapabilityDeclaration(fence("null"))).toBeNull();
  });

  test("non-string input → null, never throws", () => {
    expect(parseCapabilityDeclaration(null as unknown as string)).toBeNull();
    expect(parseCapabilityDeclaration(undefined as unknown as string)).toBeNull();
  });
});

describe("capability vocabulary — buildCapabilityQuery (#83)", () => {
  test("states the [claudish] origin and the fence marker", () => {
    const q = buildCapabilityQuery();
    expect(q).toContain("**[claudish] Capability query");
    expect(q).toContain("`" + CAPABILITY_VOCAB_FENCE + "`");
  });

  test("names every vocabulary field so the channel is self-describing", () => {
    const q = buildCapabilityQuery();
    for (const field of ["vision", "context_tokens_min", "reasoning_depth", "tool_call_density", "cost_class"]) {
      expect(q).toContain('"' + field + '"');
    }
  });

  test("advisory-only contract is stated — doctrine 2026-08-23, no behavioral instruction", () => {
    const q = buildCapabilityQuery();
    expect(q).toContain("advisory inputs to routing only");
    expect(q).toContain("never override proxy-side policy");
    expect(q).not.toContain("risk");
    expect(q).not.toMatch(/resume|undo|revert|clean up/i);
  });

  test("separator shape composes with the failover notice rail", () => {
    const q = buildCapabilityQuery();
    expect(q.startsWith("\n---\n")).toBe(true);
  });

  test("round trip: a declaration written per the query's instruction parses back", () => {
    const q = buildCapabilityQuery();
    // The instruction the query gives, followed to the letter for one field set.
    const declaration = "```" + CAPABILITY_VOCAB_FENCE + '\n{"v":1,"context_tokens_min":200000,"cost_class":"budget"}\n```';
    expect(q).toContain("fenced code block tagged");
    expect(parseCapabilityDeclaration(declaration)).toEqual({ v: 1, context_tokens_min: 200000, cost_class: "budget" });
  });
});

describe("capability vocabulary — isCapabilityVocabEnabled (#83)", () => {
  test("default off — unset or empty is inert", () => {
    expect(isCapabilityVocabEnabled({})).toBe(false);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "" })).toBe(false);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "0" })).toBe(false);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "off" })).toBe(false);
  });

  test("explicit opt-in, case-insensitive, whitespace-tolerant", () => {
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "1" })).toBe(true);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "true" })).toBe(true);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: "YES" })).toBe(true);
    expect(isCapabilityVocabEnabled({ CLAUDISH_CAPABILITY_VOCAB: " on " })).toBe(true);
  });
});

describe("capability vocabulary — wiring: the session channel (grain 2, #83)", () => {
  const ENV_ON = { CLAUDISH_CAPABILITY_VOCAB: "1" } as NodeJS.ProcessEnv;

  function assistantMsg(text: string): any {
    return { role: "assistant", content: [{ type: "text", text }] };
  }
  function payloadWith(...messages: any[]): any {
    return { model: "claude-sonnet-5", stream: false, messages: [...messages] };
  }
  function collectedMessage(): any {
    return { type: "message", role: "assistant", content: [{ type: "text", text: "Condensed summary." }] };
  }

  test("lift registers once per session — the second call short-circuits without rescanning", () => {
    resetCapabilityVocabForTests();
    const key = "sess-once";
    const declared = liftCapabilityDeclaration(
      key,
      payloadWith(assistantMsg("Working.\n" + fence('{"v":1,"vision":true}')))
    );
    expect(declared).toEqual({ v: 1, vision: true });
    // Same session, history now empty (e.g. post-compaction fresh turn): the
    // registry answers from state — no rescan, same declaration.
    const again = liftCapabilityDeclaration(key, payloadWith());
    expect(again).toEqual({ v: 1, vision: true });
    // A DIFFERENT session with the same history is independent.
    expect(liftCapabilityDeclaration("sess-other", payloadWith())).toBeNull();
  });

  test("lift scans trailing assistant history and takes the newest declaration", () => {
    resetCapabilityVocabForTests();
    const key = "sess-scan";
    const decl = liftCapabilityDeclaration(
      key,
      payloadWith(
        assistantMsg("old turn\n" + fence('{"v":1,"cost_class":"any"}')),
        { role: "user", content: "next" },
        assistantMsg("new turn\n" + fence('{"v":1,"reasoning_depth":"high"}'))
      )
    );
    expect(decl).toEqual({ v: 1, reasoning_depth: "high" });
  });

  test("append asks at most the cap times, then goes silent", () => {
    resetCapabilityVocabForTests();
    const key = "sess-cap";
    const results: boolean[] = [];
    const messages: any[] = [];
    for (let i = 0; i < 5; i++) {
      const msg = collectedMessage();
      messages.push(msg);
      results.push(appendCapabilityQueryToMessage(msg, key, ENV_ON));
    }
    expect(results).toEqual([true, true, true, false, false]);
    // Each appended message carries the query exactly once; past the cap, untouched.
    expect((messages[0].content[0] as any).text.includes("claudish-needs")).toBe(true);
    expect((messages[2].content[0] as any).text.includes("claudish-needs")).toBe(true);
    expect((messages[3].content[0] as any).text).toBe("Condensed summary.");
  });

  test("a registered declaration stops the asks", () => {
    resetCapabilityVocabForTests();
    const key = "sess-decl-stops";
    liftCapabilityDeclaration(key, payloadWith(assistantMsg(fence('{"v":1,"vision":true}'))));
    const msg = collectedMessage();
    expect(appendCapabilityQueryToMessage(msg, key, ENV_ON)).toBe(false);
    expect((msg.content[0] as any).text).toBe("Condensed summary.");
  });

  test("gate off (default) → append is a no-op", () => {
    resetCapabilityVocabForTests();
    const msg = collectedMessage();
    expect(appendCapabilityQueryToMessage(msg, "sess-gate", {})).toBe(false);
    expect((msg.content[0] as any).text).toBe("Condensed summary.");
  });

  test("max-asks env knob: 0 disables asking, 1 asks once", () => {
    resetCapabilityVocabForTests();
    expect(appendCapabilityQueryToMessage(collectedMessage(), "sess-k0", { CLAUDISH_CAPABILITY_VOCAB: "1", CLAUDISH_CAPABILITY_QUERY_MAX_ASKS: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(appendCapabilityQueryToMessage(collectedMessage(), "sess-k1a", { CLAUDISH_CAPABILITY_VOCAB: "1", CLAUDISH_CAPABILITY_QUERY_MAX_ASKS: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(appendCapabilityQueryToMessage(collectedMessage(), "sess-k1a", { CLAUDISH_CAPABILITY_VOCAB: "1", CLAUDISH_CAPABILITY_QUERY_MAX_ASKS: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  test("null session key → lift null, append false (no state created)", () => {
    resetCapabilityVocabForTests();
    expect(liftCapabilityDeclaration(null, payloadWith(assistantMsg(fence('{"v":1,"vision":true}'))))).toBeNull();
    expect(appendCapabilityQueryToMessage(collectedMessage(), null, ENV_ON)).toBe(false);
  });

  test("message without a text block gets the query pushed as a new text block (mirror of the failover notice append)", () => {
    resetCapabilityVocabForTests();
    const msg = { type: "message", role: "assistant", content: [{ type: "thinking", thinking: "…" }] };
    expect(appendCapabilityQueryToMessage(msg, "sess-shape", ENV_ON)).toBe(true);
    expect(msg.content.length).toBe(2);
    expect(msg.content[1].type).toBe("text");
  });

  // The arbitration's added requirement (18/09): the K3 degeneration lesson —
  // echo-loop text carrying a MALFORMED claudish-needs fence must arm nothing
  // and never throw, and the session must remain eligible for later asks.
  test("REGRESSION: degenerate echo-loop text with a malformed fence arms nothing, throws nothing", () => {
    resetCapabilityVocabForTests();
    const key = "sess-k3";
    const degenerate = [
      "I will now check the bash marker to verify the tool state.",
      "Bash marker / IN / OUT",
      "Bash marker / IN / OUT",
      "Let me check the bash marker again to verify the tool state.",
      "Bash marker / IN / OUT",
      "```claudish-needs",
      '{"v":1,"vision":true,,,,,"context_tokens_min":"not-a-number","reasoning_depth":"MAXIMUM"', // broken JSON, never closed properly
      "```",
      "Bash marker / IN / OUT",
      "I will now check the bash marker to verify the tool state.",
    ].join("\n");
    const other = [
      "```claudish-needs",
      "{this is not json at all",
      "```",
    ].join("\n");

    let threw = false;
    try {
      expect(liftCapabilityDeclaration(key, payloadWith(assistantMsg(degenerate)))).toBeNull();
      expect(liftCapabilityDeclaration(key, payloadWith(assistantMsg(other)))).toBeNull();
      // Also as NON-string content shapes and empty payloads — every path stays null.
      expect(liftCapabilityDeclaration(key, { messages: "not-an-array" })).toBeNull();
      expect(liftCapabilityDeclaration(key, {})).toBeNull();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Nothing armed: the session is still undeclared, so asks continue normally.
    expect(appendCapabilityQueryToMessage(collectedMessage(), key, ENV_ON)).toBe(true);
    // And a VALID declaration later in the same session still registers.
    expect(
      liftCapabilityDeclaration(key, payloadWith(assistantMsg("Recovered.\n" + fence('{"v":1,"cost_class":"budget"}'))))
    ).toEqual({ v: 1, cost_class: "budget" });
  });
});
