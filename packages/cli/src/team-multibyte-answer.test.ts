/**
 * A CJK + emoji answer reaches `response-<id>.md` byte-exact, and `outputSize` counts its
 * UTF-8 bytes. The answer is read from the transcript (JSON lines), so no pipe chunk
 * boundary can split a code point any more; this pins the end-to-end bytes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runModels, setupSession } from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
  teamDirOf,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

let t: PaneTestEnv;

beforeEach(() => {
  t = makePaneTestEnv();
});

afterEach(async () => {
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

describe.skipIf(!MAGMUX)("team multibyte answer capture", () => {
  it("writes a CJK and emoji answer byte-exact", async () => {
    const prompt = "Return the answer.";
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-multibyte"], prompt);

    const status = await runModels(sessionPath, paneRunOptions(t));
    const [slotId, model] = Object.entries(status.models)[0] ?? [];
    const response = readFileSync(join(sessionPath, `response-${slotId}.md`), "utf-8");
    const sha8 = createHash("sha1").update(prompt).digest("hex").slice(0, 8);
    const expected = `答え 🍐 ANSWER fake-multibyte ${sha8} — 東京 ✓`;

    expect(model?.state).toBe("COMPLETED");
    expect(response).not.toContain("�");
    expect(response).toBe(expected);
    expect(model?.outputSize).toBe(Buffer.byteLength(expected, "utf8"));
  }, 30_000);
});
