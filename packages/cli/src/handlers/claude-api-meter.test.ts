import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as stats from "../stats.js";
import { createClaudeApiMeter } from "./claude-api-meter.js";

type Event = Parameters<typeof stats.recordStats>[0];

describe("createClaudeApiMeter running input", () => {
  const events: Event[] = [];
  let dir: string;
  let previous: string | undefined;
  let restore: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-api-meter-"));
    previous = process.env.CLAUDISH_TOKEN_FILE;
    process.env.CLAUDISH_TOKEN_FILE = join(dir, "tokens.json");
    events.length = 0;
    const spy = spyOn(stats, "recordStats").mockImplementation((event) => {
      events.push(event);
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => {
    restore?.();
    if (previous === undefined) delete process.env.CLAUDISH_TOKEN_FILE;
    else process.env.CLAUDISH_TOKEN_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const meter = () =>
    createClaudeApiMeter({ port: 47311, mainModel: "claude-meter-test", contextWindow: 200000 });

  test("an output-only usage keeps the model's last reported input", () => {
    const m = meter();
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 100 },
    });
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      cancelled: true,
      usage: { output_tokens: 5 },
    });
    expect(events[1]).toMatchObject({ input_tokens: 100, output_tokens: 5 });
  });

  test("a later reported input replaces the earlier one", () => {
    const m = meter();
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 100 },
    });
    m.record({
      model: "claude-meter-test",
      status: 200,
      latencyMs: 1,
      usage: { input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 1 },
    });
    expect(events[1]).toMatchObject({ input_tokens: 50, output_tokens: 1 });
  });
});
