import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TeamRunOptions, runModels, setupSession } from "./team-orchestrator.js";
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
const outsideDirs: string[] = [];
const worktreeAnswer = join(import.meta.dir, "../../..", "file-answer.md");
beforeEach(() => {
  t = makePaneTestEnv();
});
afterEach(async () => {
  try {
    const report = await finishPaneTest(t);
    expect(report).toEqual({ processes: [], files: [] });
  } finally {
    for (const dir of outsideDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    expect(existsSync(worktreeAnswer)).toBe(false);
  }
});

describe.skipIf(!MAGMUX)("MTL-229 team file answer", () => {
  async function run(
    scenario: string,
    pattern: string | undefined = "[Bb]lack-box",
    env: Record<string, string> = {},
    contract: TeamRunOptions = {}
  ) {
    const sessionPath = teamDirOf(t);
    setupSession(
      sessionPath,
      [`fake-${scenario}`],
      "Read the task and return the deliverable.\nPreserve its bytes."
    );
    const options = { requirePattern: pattern, ...contract };
    const status = await runModels(
      sessionPath,
      paneRunOptions(t, options, {
        FAKE_WRITE_PATH: join(realpathSync(t.cwd), "file-answer.md"),
        ...env,
      })
    );
    const [slotId, row] = Object.entries(status.models)[0]!;
    return { sessionPath, slotId, row: row as typeof row & { answerSource?: string } };
  }

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("uses a matching written file instead of narration", async () => {
    const { row, sessionPath, slotId } = await run("write_answer");
    const path = join(realpathSync(t.cwd), "file-answer.md");
    const content = readFileSync(path);
    expect(content.toString("utf8")).toBe(
      "## Black-box test contracts\n答え 🍐 — byte-exact deliverable.\n"
    );
    expect(row.state).toBe("COMPLETED");
    expect(row.error?.reason).toBeUndefined();
    expect(row.answerSource).toBe(`file:${path}`);
    expect(row.anomalies).toContain(`answer was written to ${path}, not to the reply`);
    expect(readFileSync(join(sessionPath, `response-${slotId}.md`))).toEqual(content);
    expect(row.outputSize).toBe(content.byteLength);
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("reports a nonmatching written file without claiming nothing was lost", async () => {
    const { row } = await run("write_nonmatching");
    const path = join(realpathSync(t.cwd), "file-answer.md");
    expect(readFileSync(path, "utf8")).toBe("## Notes\nNo requested marker here.\n");
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("shape_mismatch");
    expect(row.error?.detail).toStartWith("No reply text or written file matched /[Bb]lack-box/");
    expect(row.error?.detail).toContain(`${path} (no match)`);
    expect(row.error?.detail).toContain("the reply (");
    expect(row.error?.detail).toContain(
      "B of assistant text after the task was read) does not match"
    );
    expect(row.error?.detail).not.toContain("nothing was lost");
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("reports that a nonmatching turn wrote no file", async () => {
    const { row } = await run("no_shape");
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("shape_mismatch");
    expect(row.error?.detail).toContain("the turn wrote no file");
    expect(row.error?.detail).not.toContain("nothing was lost");
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("skips a matching written file outside the working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "team-outside-answer-"));
    outsideDirs.push(dir);
    const path = join(realpathSync(dir), "answer.md");
    const { row } = await run("write_outside", "[Bb]lack-box", { FAKE_WRITE_PATH: path });
    expect(readFileSync(path, "utf8")).toBe(
      "## Black-box test contracts\n答え 🍐 — byte-exact deliverable.\n"
    );
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("shape_mismatch");
    expect(row.error?.detail).toContain(`${path} (skipped: outside the working directory)`);
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("keeps a size-only contract on the reply", async () => {
    const { row } = await run(
      "write_answer",
      undefined,
      {},
      {
        requirePattern: undefined,
        minOutputBytes: 50,
      }
    );
    const path = join(realpathSync(t.cwd), "file-answer.md");
    expect(Buffer.byteLength("I wrote the deliverable to the requested file.")).toBeLessThan(50);
    expect(readFileSync(path).byteLength).toBeGreaterThan(50);
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("empty_output");
    expect(row.answerSource).toBe("reply");
    expect(row.error?.detail).toContain(path);
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("skips a symlink escape from the answer root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "team-symlink-answer-"));
    outsideDirs.push(dir);
    const target = join(realpathSync(dir), "answer.md");
    const path = join(realpathSync(t.cwd), "file-answer.md");
    symlinkSync(target, path);
    const { row } = await run("write_answer");
    expect(readFileSync(target, "utf8")).toContain("Black-box");
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("shape_mismatch");
    expect(row.error?.detail).toContain(`${path} (skipped: outside the working directory)`);
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("skips a written file larger than 1 MiB", async () => {
    const { row } = await run("write_answer", "[Bb]lack-box", { FAKE_WRITE_SIZE: "1048577" });
    const path = join(realpathSync(t.cwd), "file-answer.md");
    const content = readFileSync(path);
    expect(content.byteLength).toBeGreaterThan(1024 * 1024);
    expect(content.toString("utf8")).toContain("Black-box");
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("shape_mismatch");
    expect(row.error?.detail).toContain(`${path} (skipped: larger than 1 MiB)`);
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("skips a binary written file containing NUL", async () => {
    const { row } = await run("write_answer", "[Bb]lack-box", {
      FAKE_WRITE_CONTENT_KIND: "binary",
    });
    const path = join(realpathSync(t.cwd), "file-answer.md");
    const content = readFileSync(path);
    expect(content.includes(0)).toBe(true);
    expect(content.toString("utf8")).toContain("Black-box");
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("shape_mismatch");
    expect(row.error?.detail).toContain(`${path} (skipped: binary)`);
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("skips a written file deleted before the reply", async () => {
    const { row } = await run("write_answer", "[Bb]lack-box", { FAKE_WRITE_DELETE: "1" });
    const path = join(realpathSync(t.cwd), "file-answer.md");
    expect(existsSync(path)).toBe(false);
    expect(row.state).toBe("EMPTY");
    expect(row.error?.reason).toBe("shape_mismatch");
    expect(row.error?.detail).toContain(`${path} (skipped: missing)`);
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("keeps an in-band API failure over a matching written file", async () => {
    // Same captured whole-answer marker used by team-output-classification.test.ts.
    const marker = readFileSync(
      join(import.meta.dir, "test-fixtures/mcp-model-check/credit-balance-exhausted-20261023.txt"),
      "utf8"
    ).trim();
    const { row } = await run("write_answer", "[Bb]lack-box", { FAKE_WRITE_REPLY: marker });
    const path = join(realpathSync(t.cwd), "file-answer.md");
    expect(readFileSync(path, "utf8")).toContain("Black-box");
    expect(row.state).toBe("FAILED");
    expect(row.error?.reason).toBe("api_error");
    expect(row.answerSource).not.toStartWith("file:");
  }, 30_000);

  // REGRESSION: MTL-229 team slot with a file deliverable reported EMPTY shape_mismatch — Fixed in /dev:fix session dev-fix-20261024-232556-1434416719
  it("marks a reply that passes its own contract as the answer source", async () => {
    const { row } = await run("multibyte", "ANSWER");
    expect(row.state).toBe("COMPLETED");
    expect(row.answerSource).toBe("reply");
  }, 30_000);
});
