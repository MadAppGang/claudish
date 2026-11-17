import { describe, expect, test } from "bun:test";
import { parseModelSpec } from "./model-parser.js";

describe("parseModelSpec: :N is concurrency on a local provider only", () => {
  test("a local provider's :N is its concurrency", () => {
    expect(parseModelSpec("ollama@llama3.2:3")).toMatchObject({
      provider: "ollama",
      model: "llama3.2",
      concurrency: 3,
    });
    expect(parseModelSpec("lmstudio@qwen-test:0")).toMatchObject({
      provider: "lmstudio",
      model: "qwen-test",
      concurrency: 0,
    });
  });

  test("a non-local provider keeps :<digits> in the model id", () => {
    // An Ollama Cloud wire id ends in a date-like :<digits>; it is the model, not a cap.
    const cloud = parseModelSpec("ollamacloud@deepseek-v4-pro:0813");
    expect(cloud.model).toBe("deepseek-v4-pro:0813");
    expect(cloud.concurrency).toBeUndefined();
    const glm = parseModelSpec("glm@glm-5-turbo:1");
    expect(glm.model).toBe("glm-5-turbo:1");
    expect(glm.concurrency).toBeUndefined();
  });
});
