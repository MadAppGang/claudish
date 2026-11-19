import { describe, expect, test } from "bun:test";
import { decideClaudeLaunch } from "../launcher/claude-launch.js";
import type { ClaudishConfig } from "../types.js";
import { concurrencySuffixRefusal, parseModelSpec } from "./model-parser.js";

const unknownIds = () => false;
const SUPPORTED = "ollama@, lmstudio@, vllm@, mlx@";

describe("concurrencySuffixRefusal", () => {
  test("a bare name with :N is refused, naming the spec and the providers that honour it", () => {
    const refusal = concurrencySuffixRefusal("glm-5-turbo:1", unknownIds);
    expect(refusal).toContain("glm-5-turbo:1");
    expect(refusal).toContain(SUPPORTED);
  });

  test("a non-local provider with :N is refused", () => {
    const refusal = concurrencySuffixRefusal("glm@glm-5-turbo:1", unknownIds);
    expect(refusal).toContain("glm@glm-5-turbo:1");
    expect(refusal).toContain(SUPPORTED);
  });

  test("a local provider's :N is kept", () => {
    expect(concurrencySuffixRefusal("ollama@llama3.2:3", unknownIds)).toBeNull();
    expect(concurrencySuffixRefusal("ollama/llama3.2:3", unknownIds)).toBeNull();
  });

  test("a :<digits> the catalog knows as a model id is the model, not a suffix", () => {
    const knows = (id: string) => id === "deepseek-v4-pro:0813";
    expect(concurrencySuffixRefusal("ollamacloud@deepseek-v4-pro:0813", knows)).toBeNull();
  });

  test("a spec with no :N is never refused", () => {
    for (const spec of ["glm@glm-5-turbo", "glm-5-turbo", "or@vendor/model:free"])
      expect(concurrencySuffixRefusal(spec, unknownIds)).toBeNull();
  });
});

describe("decideClaudeLaunch refuses an unsupported :N before any routing", () => {
  const decide = (config: Partial<ClaudishConfig>) =>
    decideClaudeLaunch(config as ClaudishConfig, {
      paneChild: false,
      shadowedEndpointRefusal: () => null,
      knowsModelId: unknownIds,
    });

  test("the main model, a chain hop and a tier are each checked", () => {
    for (const config of [
      { model: "glm-5-turbo:1" },
      { model: "glm@glm-5-turbo:1" },
      { model: "ollama@llama3.2", modelChain: ["ollama@llama3.2", "glm@glm-5-turbo:1"] },
      { model: "ollama@llama3.2", modelSonnet: "glm@glm-5-turbo:1" },
    ]) {
      const out = decide(config);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toContain(SUPPORTED);
    }
  });

  test("a local :N launches", () => {
    expect(decide({ model: "ollama@llama3.2:3" })).toEqual({ ok: true });
    expect(parseModelSpec("ollama@llama3.2:3").concurrency).toBe(3);
  });

  test("a chain pinned by a parent claudish is not re-checked", () => {
    expect(
      decide({
        model: "oc@vendor-model:1",
        modelChain: ["oc@vendor-model:1", "or@vendor/model"],
        modelPinned: true,
      })
    ).toEqual({ ok: true });
  });
});

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
