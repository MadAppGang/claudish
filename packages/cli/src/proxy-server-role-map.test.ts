import { describe, expect, test } from "bun:test";
import { resolveRoleMappedModel } from "./proxy-server.js";

const modelMap = {
  opus: "claude-opus-5",
  sonnet: "glm@glm-5.3",
  haiku: "mmc@MiniMax-M3",
  fable: "cx@gpt-6-astra",
};

describe("resolveRoleMappedModel", () => {
  test("maps every Fable version to the configured role target", () => {
    expect(resolveRoleMappedModel("claude-fable-5", modelMap)).toBe("cx@gpt-6-astra");
    expect(resolveRoleMappedModel("claude-fable-5-1", modelMap)).toBe("cx@gpt-6-astra");
    expect(resolveRoleMappedModel("claude-fable-6", modelMap)).toBe("cx@gpt-6-astra");
  });

  test("preserves existing role mappings", () => {
    expect(resolveRoleMappedModel("claude-opus-5", modelMap)).toBe("claude-opus-5");
    expect(resolveRoleMappedModel("claude-sonnet-5", modelMap)).toBe("glm@glm-5.3");
    expect(resolveRoleMappedModel("claude-haiku-4-5", modelMap)).toBe("mmc@MiniMax-M3");
  });

  test("does not map unrelated models", () => {
    expect(resolveRoleMappedModel("gpt-6-astra", modelMap)).toBeUndefined();
    expect(resolveRoleMappedModel("claude-fable-5-1", { ...modelMap, fable: undefined })).toBeUndefined();
  });
});
