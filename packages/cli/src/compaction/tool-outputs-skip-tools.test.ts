import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { loadConfig, saveConfig } from "../profile-config.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  type ToolOutputSettings,
  readCompactionBlock,
} from "./config.js";
import { CompactionClient } from "./haiku-client.js";
import { CompactionStore, toolOutputKey } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

const session = "skip-tools-session";
const model = "test-compaction-model";
const original = "src/worker.ts:42 E_FAIL command=bun test count=123\n".repeat(400);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-skip-tools-"));
});
afterEach(() => {
  setConfigFileOverride(null);
  rmSync(dir, { recursive: true, force: true });
});

function rig(settings: ToolOutputSettings) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "src/worker.ts:42 E_FAIL" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as unknown as typeof fetch;
  const client = new CompactionClient({
    apiKey: "FAKE_SKIP_TOOLS_0000",
    model,
    fetchImpl,
    warn() {},
    record() {},
  });
  const store = new CompactionStore(join(dir, "store"));
  const compactor = new ToolOutputCompactor({ store, client, settings });
  return { store, compactor, calls: () => calls };
}

function payload(name: string, input: Record<string, unknown>) {
  return {
    model,
    messages: [
      { role: "user", content: "Look" },
      { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name, input }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: original }],
      },
    ],
  };
}

const defaults = (): ToolOutputSettings => ({
  ...DEFAULT_COMPACTION_SETTINGS.toolOutputs,
  skipTools: [...DEFAULT_COMPACTION_SETTINGS.toolOutputs.skipTools],
  timeoutMs: 1000,
});

describe("toolOutputs.skipTools", () => {
  test("defaults to Read", () => {
    expect(DEFAULT_COMPACTION_SETTINGS.toolOutputs.skipTools).toEqual(["Read"]);
    expect(readCompactionBlock(undefined).settings.toolOutputs.skipTools).toEqual(["Read"]);
    expect(readCompactionBlock({ enabled: true }).settings.toolOutputs.skipTools).toEqual(["Read"]);
  });

  test("a Read output is not compressed nor recorded under the default settings", async () => {
    const r = rig(defaults());
    const p = payload("Read", { file_path: "/work/src/big.ts" });
    const untouched = structuredClone(p);

    await r.compactor.compact(p, session);

    expect(r.calls()).toBe(0);
    expect(p).toEqual(untouched);
    expect(r.store.get(session, toolOutputKey(session, "tool-1", original))).toBeUndefined();
  });

  test("a tool not in the list is still compressed", async () => {
    const r = rig(defaults());
    const p = payload("Bash", { command: "bun test" });

    await r.compactor.compact(p, session);

    expect(r.calls()).toBe(1);
    expect(r.store.get(session, toolOutputKey(session, "tool-1", original))).toMatchObject({
      kind: "tool-output",
      form: "compressed",
    });
  });

  test("a listed tool is skipped whatever its name", async () => {
    const r = rig({ ...defaults(), skipTools: ["Bash"] });
    await r.compactor.compact(payload("Bash", { command: "bun test" }), session);
    expect(r.calls()).toBe(0);
  });

  test("skipTools [] compresses Read", async () => {
    const r = rig({ ...defaults(), skipTools: [] });
    await r.compactor.compact(payload("Read", { file_path: "/work/src/big.ts" }), session);
    expect(r.calls()).toBe(1);
  });

  test("a valid skipTools is read from the block", () => {
    const reading = readCompactionBlock({ toolOutputs: { skipTools: ["Read", "Grep"] } });
    expect(reading.warning).toBeUndefined();
    expect(reading.settings.toolOutputs.skipTools).toEqual(["Read", "Grep"]);
    expect(
      readCompactionBlock({ toolOutputs: { skipTools: [] } }).settings.toolOutputs.skipTools
    ).toEqual([]);
  });

  for (const skipTools of ["Read", [""], [1], null]) {
    test(`an invalid skipTools ${JSON.stringify(skipTools)} ignores the block with a warning`, () => {
      const reading = readCompactionBlock({ enabled: true, toolOutputs: { skipTools } });
      expect(reading.warning).toContain("compaction.toolOutputs.skipTools");
      expect(reading.enabled).toBeUndefined();
      expect(reading.settings.toolOutputs.skipTools).toEqual(["Read"]);
    });
  }

  test("skipTools survives loadConfig and saveConfig", () => {
    const file = join(dir, "config.json");
    setConfigFileOverride(file);
    const block = { enabled: true, toolOutputs: { skipTools: ["Read", "Grep"] } };
    writeFileSync(file, JSON.stringify({ compaction: block }));

    for (let cycle = 0; cycle < 3; cycle++) saveConfig(loadConfig());

    expect(loadConfig().compaction).toEqual(block);
    expect(JSON.parse(readFileSync(file, "utf8")).compaction).toEqual(block);
  });
});
