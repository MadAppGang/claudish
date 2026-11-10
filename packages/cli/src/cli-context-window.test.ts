import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parseArgs } from "./cli.js";

describe("parseArgs --context-window", () => {
  afterEach(() => {
    delete process.env.CLAUDISH_CONTEXT_WINDOW;
  });

  test("takes a size with a unit", async () => {
    const config = await parseArgs(["--context-window", "128k", "--model", "lms@a", "hi"]);

    expect(config.contextWindow).toBe(128_000);
  });

  test("is absent when the flag is not given", async () => {
    const config = await parseArgs(["--model", "lms@a", "hi"]);

    expect(config.contextWindow).toBeUndefined();
  });

  test("refuses a value that is not a size", async () => {
    const exit = spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(parseArgs(["--context-window", "lots", "hi"])).rejects.toThrow("exit 1");
      expect(String(error.mock.calls[0]?.[0])).toContain("--context-window");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});
