import { describe, expect, test } from "bun:test";
import {
  CustomEndpointComplexSchema,
  CustomEndpointSchema,
  CustomEndpointSimpleSchema,
} from "./config-schema.js";

function invalidCustomEndpointMessage(input: unknown): string {
  const result = CustomEndpointSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) return "";
  return result.error.issues.map((issue) => issue.message).join(" ");
}

describe("CustomEndpointSimpleSchema", () => {
  test("accepts a valid simple endpoint and round-trips through CustomEndpointSchema", () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com/v1",
      format: "openai" as const,
      apiKey: "sk-test-1234",
      modelPrefix: "example/",
      models: ["model-a", "model-b"],
    };

    const parsed = CustomEndpointSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts minimal simple endpoint without optional fields", () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com",
      format: "anthropic" as const,
      apiKey: "key",
    };

    const parsed = CustomEndpointSimpleSchema.parse(input);
    expect(parsed.kind).toBe("simple");
    expect(parsed.modelPrefix).toBeUndefined();
    expect(parsed.models).toBeUndefined();
  });

  test('accepts authScheme "none" without an apiKey', () => {
    const input = {
      kind: "simple" as const,
      url: "https://keyless.example.com/v1",
      format: "openai" as const,
      authScheme: "none" as const,
    };

    expect(CustomEndpointSimpleSchema.parse(input)).toEqual(input);
  });

  test("rejects a non-URL `url`", () => {
    expect(() =>
      CustomEndpointSimpleSchema.parse({
        kind: "simple",
        url: "not-a-url",
        format: "openai",
        apiKey: "sk",
      })
    ).toThrow();
  });

  test('rejects an empty apiKey unless authScheme is "none", with an actionable message', () => {
    const message = invalidCustomEndpointMessage({
      kind: "simple",
      url: "https://api.example.com",
      format: "openai",
      apiKey: "",
    });

    expect(message).toContain("authScheme");
    expect(message).toContain("none");
    expect(message).not.toContain("Too small");
  });

  test('rejects an omitted apiKey unless authScheme is "none", with the same guidance', () => {
    const message = invalidCustomEndpointMessage({
      kind: "simple",
      url: "https://api.example.com",
      format: "openai",
    });

    expect(message).toContain("authScheme");
    expect(message).toContain("none");
  });

  test('rejects a non-empty apiKey when authScheme is "none"', () => {
    const message = invalidCustomEndpointMessage({
      kind: "simple",
      url: "https://api.example.com",
      format: "openai",
      authScheme: "none",
      apiKey: "should-not-be-sent",
    });

    expect(message).toContain("Remove apiKey");
  });

  test('treats a whitespace-only apiKey as empty when authScheme is "none"', () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com",
      format: "openai" as const,
      authScheme: "none" as const,
      apiKey: "   ",
    };

    expect(CustomEndpointSimpleSchema.parse(input)).toEqual(input);
  });
});

describe("CustomEndpointComplexSchema", () => {
  test("accepts a valid complex endpoint and round-trips through CustomEndpointSchema", () => {
    const input = {
      kind: "complex" as const,
      displayName: "My vLLM",
      transport: "openai" as const,
      baseUrl: "https://vllm.example.com",
      apiPath: "/v1/chat/completions",
      apiKey: "key-xyz",
      authScheme: "bearer" as const,
      headers: { "X-Custom": "value" },
      streamFormat: "openai-sse" as const,
      modelPrefix: "vllm/",
      models: ["llama-3"],
    };

    const parsed = CustomEndpointSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts minimal complex endpoint with only required fields", () => {
    const input = {
      kind: "complex" as const,
      displayName: "Minimal",
      transport: "openai" as const,
      baseUrl: "https://example.com",
      apiKey: "k",
    };

    const parsed = CustomEndpointComplexSchema.parse(input);
    expect(parsed.displayName).toBe("Minimal");
    expect(parsed.headers).toBeUndefined();
    expect(parsed.streamFormat).toBeUndefined();
  });

  test('accepts authScheme "none" without an apiKey', () => {
    const input = {
      kind: "complex" as const,
      displayName: "Keyless Gateway",
      transport: "anthropic" as const,
      baseUrl: "https://keyless.example.com",
      authScheme: "none" as const,
    };

    expect(CustomEndpointComplexSchema.parse(input)).toEqual(input);
  });

  test('rejects an omitted apiKey unless authScheme is "none"', () => {
    const message = invalidCustomEndpointMessage({
      kind: "complex",
      displayName: "Missing Credential Declaration",
      transport: "openai",
      baseUrl: "https://api.example.com",
    });

    expect(message).toContain("authScheme");
    expect(message).toContain("none");
  });

  test.each(["bearer", "x-api-key"] as const)(
    "continues to accept %s authentication with a real key",
    (authScheme) => {
      const input = {
        kind: "complex" as const,
        displayName: "Authenticated Gateway",
        transport: "openai" as const,
        baseUrl: "https://authenticated.example.com",
        authScheme,
        apiKey: "real-test-key",
      };

      expect(CustomEndpointComplexSchema.parse(input)).toEqual(input);
    }
  );
});

describe("CustomEndpointSchema (discriminated union)", () => {
  test("rejects an object missing the `kind` field", () => {
    expect(() =>
      CustomEndpointSchema.parse({
        url: "https://api.example.com",
        format: "openai",
        apiKey: "sk",
      })
    ).toThrow();
  });
});

describe("custom endpoint declared wire", () => {
  const wire = {
    tokenParam: "max_tokens",
    reasoning: {
      enable: [{ path: "/chat_template_kwargs/enable_thinking", value: true }],
      disable: [{ path: "/chat_template_kwargs/enable_thinking", value: false }],
      effort: {
        path: "/reasoning_effort",
        values: { low: "small", high: "large" },
        default: "low",
      },
    },
  };
  for (const kind of ["simple", "complex"] as const) {
    const endpoint = (transport: string, declared: unknown): unknown =>
      kind === "simple"
        ? {
            kind,
            url: "https://example.invalid/v1",
            format: transport,
            apiKey: "fake",
            wire: declared,
          }
        : {
            kind,
            displayName: "Test",
            baseUrl: "https://example.invalid",
            transport,
            apiKey: "fake",
            wire: declared,
          };
    test.each(["chat-completions", "responses"])(`${kind} openai accepts %s`, (api) => {
      const input = endpoint("openai", { ...wire, api });
      expect(input).toEqual(CustomEndpointSchema.parse(input));
    });
    test(`${kind} anthropic accepts Messages and none`, () => {
      const input = endpoint("anthropic", { api: "anthropic-messages", tokenParam: "none" });
      expect(input).toEqual(CustomEndpointSchema.parse(input));
    });
    test(`${kind} rejects an API incompatible with its transport`, () => {
      expect(
        CustomEndpointSchema.safeParse(endpoint("openai", { api: "anthropic-messages" })).success
      ).toBe(false);
      expect(
        CustomEndpointSchema.safeParse(endpoint("anthropic", { api: "responses" })).success
      ).toBe(false);
      if (kind === "complex") {
        expect(
          CustomEndpointSchema.safeParse(endpoint("litellm", { api: "responses" })).success
        ).toBe(false);
        expect(
          CustomEndpointSchema.safeParse(endpoint("litellm", { api: "chat-completions" })).success
        ).toBe(true);
      }
    });
    test.each(["enable", "disable", "effort"])(
      `${kind} %s pointer requires a leading slash`,
      (field) => {
        const value =
          field === "effort" ? { path: "reasoning_effort" } : [{ path: "thinking", value: true }];
        expect(
          CustomEndpointSchema.safeParse(endpoint("openai", { reasoning: { [field]: value } }))
            .success
        ).toBe(false);
      }
    );
    test(`${kind} accepts empty wire and identity effort declaration`, () => {
      expect(CustomEndpointSchema.safeParse(endpoint("openai", {})).success).toBe(true);
      expect(
        CustomEndpointSchema.safeParse(
          endpoint("openai", { reasoning: { effort: { path: "/effort" } } })
        ).success
      ).toBe(true);
    });
  }
});
