import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { DEFAULT_COMPACTION_SETTINGS, type ToolOutputSettings } from "./config.js";
import { isFilePrintCommand } from "./file-print.js";
import { CompactionClient } from "./haiku-client.js";
import { CompactionStore, toolOutputKey } from "./store.js";
import { ToolOutputCompactor } from "./tool-outputs.js";

const session = "file-print-session";
const model = "test-compaction-model";
const fileText = "export function nativeRouteFor(model: string) {\n  return model;\n}\n".repeat(
  300
);
const testOutput = "src/worker.test.ts:\n(pass) worker > retries [1.20ms]\n".repeat(400);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-file-print-"));
  startLogCapture();
});
afterEach(() => {
  stopLogCapture();
  rmSync(dir, { recursive: true, force: true });
});

function rig() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "2 pass, 0 fail" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as unknown as typeof fetch;
  const client = new CompactionClient({
    apiKey: "FAKE_FILE_PRINT_0000",
    model,
    fetchImpl,
    warn() {},
    record() {},
  });
  const store = new CompactionStore(join(dir, "store"));
  const settings: ToolOutputSettings = {
    ...DEFAULT_COMPACTION_SETTINGS.toolOutputs,
    skipTools: [...DEFAULT_COMPACTION_SETTINGS.toolOutputs.skipTools],
    timeoutMs: 1000,
  };
  const compactor = new ToolOutputCompactor({ store, client, settings });
  return { store, compactor, calls: () => calls };
}

function bashPayload(command: string, output: string) {
  return {
    model,
    messages: [
      { role: "user", content: "Refactor nativeRouteFor" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: output }],
      },
    ],
  };
}

describe("a Bash output that only prints files", () => {
  test("is passed through byte-identical, not recorded, and logged", async () => {
    const r = rig();
    const command =
      'grep -rn "nativeRouteFor" packages/cli/src | head -20; cat packages/cli/src/providers/native-route.ts';
    const p = bashPayload(command, fileText);
    const before = JSON.stringify(p);

    await r.compactor.compact(p, session);

    expect(r.calls()).toBe(0);
    expect(JSON.stringify(p)).toBe(before);
    expect(r.store.get(session, toolOutputKey(session, "tool-1", fileText))).toBeUndefined();
    const lines = (await capturedLines()).filter((l) => l.includes("file print"));
    expect(lines).toEqual([
      expect.stringContaining(`[compaction] session ${session}: file print tool-1`),
    ]);
  });

  test("`bun test` output over the threshold is still compressed", async () => {
    const r = rig();
    const p = bashPayload("cd packages/cli && bun test src/adapters 2>&1 | tail -200", testOutput);

    await r.compactor.compact(p, session);

    expect(r.calls()).toBe(1);
    expect(r.store.get(session, toolOutputKey(session, "tool-1", testOutput))).toMatchObject({
      form: "compressed",
    });
    expect((await capturedLines()).filter((l) => l.includes("file print"))).toEqual([]);
  });
});

describe("isFilePrintCommand", () => {
  const prints = [
    "cat packages/cli/src/providers/native-route.ts",
    "cat a.ts b.ts",
    "cat -n src/a.ts",
    "cat src/a.ts 2>/dev/null",
    'grep -rn "nativeRouteFor" src && cat src/providers/native-route.ts',
    'grep -rn "a|b;c" src | head -5; cat src/a.ts',
    "grep -rln nativeRouteFor src\ncat src/providers/native-route.ts",
    "cd packages/cli && cat -n src/providers/native-route.ts",
    "nl -ba src/a.ts | sed -n '1,200p'",
    "sed -n '1,400p' src/a.ts",
    "sed -n 1,400p src/a.ts",
    "head -n 300 src/a.ts",
    "tail -n +100 src/a.ts",
    "bat --plain src/a.ts",
    "less src/a.ts",
    'echo "---"; wc -l src/a.ts; cat src/a.ts',
    "ls src/providers && cat src/providers/native-route.ts | head -400",
    "rg -n nativeRouteFor src; cat src/a.ts",
    // Sent by Claude Code in the bench's refactor case.
    'cd packages/cli && grep -rn "nativeRouteFor" src; echo ---; cat src/providers/native-route.ts',
    'cd packages/cli && grep -rn "nativeRouteFor" src; cat src/providers/native-route.ts',
    'cd packages/cli 2>/dev/null || cd /private/var/folders/ch/T/madbench-1975076630/work/packages/cli; pwd; grep -rn "nativeRouteFor" src; echo; cat src/providers/native-route.ts',
    "cd packages/cli && sed -n 160,180p src/providers/native-route.ts; sed -n 1,30p src/providers/native-route.ts | grep -n import; cat src/providers/native-route.test.ts | head -60",
    'cd packages/cli && grep -n "nativeRouteFor\\|native-route" src/grammar.behaviour.test.ts src/providers/provider-definitions.ts; sed -n 1,12p src/providers/native-route.ts',
  ];
  for (const command of prints) {
    test(`prints a file: ${JSON.stringify(command)}`, () => {
      expect(isFilePrintCommand(command)).toBe(true);
    });
  }

  const notPrints = [
    "bun test",
    "bun test src/adapters 2>&1 | tail -50",
    "cd packages/cli && bun test",
    "bun run build && cat dist/report.txt",
    "bun run typecheck",
    "npx tsc --noEmit",
    'grep -rn "nativeRouteFor" src',
    "ls -la src",
    "cat",
    "cat | head",
    "cat a.ts > b.ts",
    "cat <<EOF\nhello\nEOF",
    "cat $(git ls-files)",
    "cat `git ls-files`",
    "sed -i 's/a/b/' src/a.ts",
    "sed 's/a/b/' src/a.ts",
    "sed -n 's/a/b/' src/a.ts",
    "cat src/a.ts | grep foo",
    "git show HEAD:src/a.ts",
    "find src -name '*.ts' -exec cat {} \\;",
    "cat src/a.ts &",
    "tail -f logs/server.log",
    "",
    // Sent by Claude Code in the bench's refactor case: searches only, no file printed whole.
    'cd packages/cli && grep -n -B8 "nativeRouteFor" src/providers/native-route.ts | head -80; grep -rn "nativeRouteFor" src | grep -v "^src/providers/native-route.ts" | cut -c1-220',
    'cd packages/cli/src && for f in a.ts:1:9; do IFS=: read p a b <<<"$f"; echo "== $p"; sed -n "${a},${b}p" $p; done',
  ];
  for (const command of notPrints) {
    test(`not a file print: ${JSON.stringify(command)}`, () => {
      expect(isFilePrintCommand(command)).toBe(false);
    });
  }
});
