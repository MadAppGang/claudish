/**
 * The rtk example in `docs/advanced/hooks.md`, run with a stand-in `Bun.spawn`.
 *
 * The guide promises that a crash is a failure the journal records and the
 * five-failure limit counts. The engine counts a failure only when the hook
 * throws, so the example must throw on an exit code that is not one of rtk's
 * documented codes, and must return nothing on the documented no-rewrite codes.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOC = join(import.meta.dir, "..", "..", "..", "docs", "advanced", "hooks.md");
const PUBLIC = join(import.meta.dir, "hooks", "public.ts");

const root = mkdtempSync(join(tmpdir(), "claudish-rtk-example-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let spawnSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
});

interface ToolCallHandler {
  handle(ctx: unknown): Promise<unknown[] | undefined>;
}

let loaded: Promise<ToolCallHandler> | undefined;
function loadExample(): Promise<ToolCallHandler> {
  loaded ??= importExample();
  return loaded;
}

async function importExample(): Promise<ToolCallHandler> {
  const block = [...readFileSync(DOC, "utf8").matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? "")
    .find((b) => b.includes('id: "rtk-bash-rewrite"'));
  if (!block) throw new Error("The guide has no rtk-bash-rewrite example");
  const file = join(root, "rtk-bash-rewrite.ts");
  writeFileSync(file, block.replace('from "claudish/hooks"', `from ${JSON.stringify(PUBLIC)}`));
  const mod = (await import(file)) as { default: { on: { toolCall: ToolCallHandler } } };
  return mod.default.on.toolCall;
}

function fakeRtk(code: number, stdout = "") {
  spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => ({
    stdout: new Response(stdout).body,
    exited: Promise.resolve(code),
  })) as unknown as typeof Bun.spawn);
}

const COMMAND = "git status --porcelain";

function ctx() {
  return {
    tool: { name: "Bash", args: { command: COMMAND } },
    signal: new AbortController().signal,
  };
}

describe("rtk example exit codes", () => {
  for (const code of [1, 2]) {
    test(`exit ${code} is no rewrite and not a failure`, async () => {
      const handler = await loadExample();
      fakeRtk(code);
      expect(await handler.handle(ctx())).toBeUndefined();
    });
  }

  test("exit 3 with output repairs the command", async () => {
    const handler = await loadExample();
    fakeRtk(3, "rtk git status --porcelain\n");
    const actions = await handler.handle(ctx());
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions)).toContain("rtk git status --porcelain");
  });

  for (const code of [139, 127, -1]) {
    test(`exit ${code} throws, without the command in the error`, async () => {
      const handler = await loadExample();
      fakeRtk(code);
      const error = await handler.handle(ctx()).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(COMMAND);
    });
  }
});
