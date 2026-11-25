import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeTokenFile, seedTokenFileWindow } from "./claude-runner.js";
import { readTokenStats, statsDir, tokenFileFor } from "./team-stats.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-seed-window-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("seedTokenFileWindow", () => {
  test("a fresh token file gets the launch window", () => {
    const path = join(dir, "fresh.json");
    initializeTokenFile(path);

    seedTokenFileWindow(path, 128_000);

    expect(read(path)).toMatchObject({ context_window: 128_000, context_left_percent: 100 });
  });

  test("a file the proxy already wrote is left alone", () => {
    const path = join(dir, "answered.json");
    const answered = { input_tokens: 34_000, context_window: 64_000, context_left_percent: 47 };
    writeFileSync(path, JSON.stringify(answered));

    seedTokenFileWindow(path, 128_000);

    expect(read(path)).toEqual(answered);
  });

  test("an unknown window leaves the file unknown", () => {
    const path = join(dir, "unknown.json");
    initializeTokenFile(path);

    seedTokenFileWindow(path, null);

    expect(read(path).context_window).toBe("unknown");
  });

  test("a file in a missing folder stays missing", () => {
    const path = join(dir, "no-such-folder", "missing.json");

    seedTokenFileWindow(path, 128_000);

    expect(() => readFileSync(path)).toThrow();
  });

  test("a team slot's assigned file, in the stats folder the team path made, gets the window", () => {
    // A team slot's CLAUDISH_TOKEN_FILE is assigned, so the runner never blanks it: the
    // folder exists (startModels makes it before any slot spawns) and the file does not.
    const session = join(dir, "team-session");
    mkdirSync(statsDir(session), { recursive: true });
    const path = tokenFileFor(session, "01");

    seedTokenFileWindow(path, 128_000);

    expect(read(path)).toMatchObject({ context_window: 128_000, context_left_percent: 100 });
    // No token counts yet: the team's readers still see a slot that has not answered.
    expect(read(path).input_tokens).toBeUndefined();
    expect(readTokenStats(session, "01")).toBeNull();
  });
});
