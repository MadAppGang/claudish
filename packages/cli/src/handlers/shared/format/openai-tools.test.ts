import { describe, expect, it } from "bun:test";
import {
  convertToolsToOpenAI,
  isPortablePattern,
  sanitizeSchemaForOpenAI,
} from "./openai-tools.js";

const artifactFieldPattern = String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`;
const lookaheadPattern = String.raw`^(?!reserved$)[a-z]+$`;

function serializedParameters(inputSchema: unknown, summarize: boolean): unknown {
  const tool: Record<string, unknown> = {
    name: "test_tool",
    description: "A test tool.",
  };
  if (inputSchema !== undefined) {
    tool.input_schema = inputSchema;
  }

  const serialized = JSON.stringify(convertToolsToOpenAI({ tools: [tool] }, summarize));
  expect(serialized).toContain('"parameters":');

  const parsed = JSON.parse(serialized);
  expect(Object.hasOwn(parsed[0].function, "parameters")).toBe(true);
  return parsed[0].function.parameters;
}

describe("convertToolsToOpenAI", () => {
  it.each([
    { name: "missing", inputSchema: undefined },
    { name: "null", inputSchema: null },
    { name: "non-object", inputSchema: "not-a-schema" },
  ])("serializes object parameters for a $name input_schema", ({ inputSchema }) => {
    const parameters = serializedParameters(inputSchema, false);

    expect(parameters).toEqual({ type: "object", properties: {} });
  });

  it.each([
    { name: "missing", inputSchema: undefined },
    { name: "null", inputSchema: null },
    { name: "non-object", inputSchema: 42 },
  ])("serializes object parameters for a $name input_schema when summarized", ({ inputSchema }) => {
    const parameters = serializedParameters(inputSchema, true);

    expect(parameters).toEqual({ type: "object", properties: {} });
  });

  it("round-trips a normal object schema unchanged", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "integer" },
      },
      required: ["query"],
    };

    expect(serializedParameters(schema, false)).toEqual(schema);
  });
});

describe("sanitizeSchemaForOpenAI", () => {
  it("drops the Artifact field pattern while preserving its property schema", () => {
    const schema = {
      type: "object",
      properties: {
        field: {
          type: "string",
          description: "The field name.",
          minLength: 1,
          maxLength: 200,
          pattern: artifactFieldPattern,
        },
      },
      required: ["field"],
    };

    expect(sanitizeSchemaForOpenAI(schema)).toEqual({
      type: "object",
      properties: {
        field: {
          type: "string",
          description: "The field name.",
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ["field"],
    });
  });

  it("keeps a portable negative lookahead pattern byte-identical", () => {
    const sanitized = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        value: { type: "string", pattern: lookaheadPattern },
      },
    });

    expect(sanitized.properties.value.pattern).toBe(lookaheadPattern);
  });

  it("drops an unportable pattern nested inside array items", () => {
    const sanitized = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "string", minLength: 1, pattern: artifactFieldPattern },
        },
      },
    });

    expect(sanitized.properties.fields.items).toEqual({ type: "string", minLength: 1 });
  });

  it("drops an unportable pattern inside $defs", () => {
    const sanitized = sanitizeSchemaForOpenAI({
      type: "object",
      properties: {},
      $defs: {
        field: { type: "string", minLength: 1, pattern: artifactFieldPattern },
      },
    });

    expect(sanitized.$defs.field).toEqual({ type: "string", minLength: 1 });
  });

  it('preserves a property literally named "pattern"', () => {
    const patternProperty = {
      type: "string",
      description: "A property whose name is a schema keyword.",
    };

    const sanitized = sanitizeSchemaForOpenAI({
      type: "object",
      properties: { pattern: patternProperty },
    });

    expect(sanitized.properties.pattern).toEqual(patternProperty);
  });
});

describe("isPortablePattern", () => {
  it.each([
    { pattern: artifactFieldPattern, portable: false },
    { pattern: lookaheadPattern, portable: true },
    { pattern: String.raw`^a\\pb$`, portable: true },
    { pattern: "(?<name>a)", portable: false },
    { pattern: "(?<=a)b", portable: true },
  ])("returns $portable for $pattern", ({ pattern, portable }) => {
    expect(isPortablePattern(pattern)).toBe(portable);
  });
});
