import { expect, test } from "bun:test";
import { serveCompactionWarning } from "../serve-command.js";

test("serve warns once when the environment or the config enables compaction", () => {
  for (const [env, block] of [
    ["1", undefined],
    ["on", { enabled: false }],
    [undefined, { enabled: true }],
  ] as const) {
    const warning = serveCompactionWarning(env, block);
    expect(warning).toBeString();
    expect(warning).toContain("serve does not run compaction");
  }
});

test("serve says nothing when compaction is not enabled", () => {
  for (const [env, block] of [
    [undefined, undefined],
    ["0", { enabled: true }],
    [undefined, { enabled: false }],
    ["", undefined],
  ] as const) {
    expect(serveCompactionWarning(env, block)).toBeUndefined();
  }
});
