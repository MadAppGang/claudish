import { describe, expect, it } from "bun:test";

import { extractToolCallsFromText, hasExtractableFunctionTag } from "./tool-call-recovery.js";

describe("extractToolCallsFromText tool-name validation", () => {
  it("rejects a swallowed argument value without breaking Qwen-style recovery", () => {
    const malformed =
      '<function=web_search_query_listOpposed["macos security add-generic-password -X hex password flag"]>';

    expect(extractToolCallsFromText(malformed)).toEqual([]);

    const recovered = extractToolCallsFromText('<function=web_search><parameter=query_list>["x"]');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      name: "web_search",
      arguments: { query_list: '["x"]' },
    });
  });

  it("drops well-shaped unadvertised names only when an allowlist is supplied", () => {
    const text = "<function=Unadvertised><parameter=value>x";

    expect(extractToolCallsFromText(text, ["Read"])).toEqual([]);
    expect(extractToolCallsFromText(text)).toEqual([
      {
        name: "Unadvertised",
        arguments: { value: "x" },
        source: "xml_text",
      },
    ]);
  });

  it("canonicalizes an advertised tool name case-insensitively", () => {
    expect(extractToolCallsFromText("<function=read>", ["Read"])).toEqual([
      {
        name: "Read",
        arguments: {},
        source: "xml_text",
      },
    ]);
  });

  it("rejects tool names longer than 64 characters", () => {
    const tooLong = `A${"a".repeat(64)}`;

    expect(extractToolCallsFromText(`<function=${tooLong}>`)).toEqual([]);
  });

  it("detects exactly the function tags that Pattern 0 can extract", () => {
    const valid = "<function=Read>";
    const invalid = "<function=not a name!>";

    expect(hasExtractableFunctionTag(valid)).toBe(true);
    expect(extractToolCallsFromText(valid)).toHaveLength(1);
    expect(hasExtractableFunctionTag(invalid)).toBe(false);
    expect(extractToolCallsFromText(invalid)).toEqual([]);
  });
});
