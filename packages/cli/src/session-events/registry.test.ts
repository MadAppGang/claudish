import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionEventRegistry } from "./index.js";
import { FIXTURE_SESSION_ID, FIXTURE_ULTRA_EFFORT_ENTER } from "./test-fixtures.js";

let home: string;
let registry: SessionEventRegistry | undefined;

afterEach(() => {
  registry?.disposeAll();
  registry = undefined;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

describe("SessionEventRegistry", () => {
  test("finds the transcript via the projects/* glob fallback and seeds from settings.json", () => {
    home = mkdtempSync(join(tmpdir(), "claudish-sev-"));
    // Deliberately NOT slugFromCwd(process.cwd()) — forces the glob fallback.
    const projectDir = join(home, "projects", "-some-other-cwd");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${FIXTURE_SESSION_ID}.jsonl`),
      `${FIXTURE_ULTRA_EFFORT_ENTER}\n`
    );
    writeFileSync(join(home, "settings.json"), JSON.stringify({ effortLevel: "high" }));

    registry = new SessionEventRegistry({ claudeHome: home, pollIntervalMs: 60_000 });
    registry.ensureSession(FIXTURE_SESSION_ID);
    registry.sync(FIXTURE_SESSION_ID);

    const state = registry.getState(FIXTURE_SESSION_ID);
    expect(state?.ultracodeActive).toBe(true);
    expect(state?.defaultEffort).toBe("high"); // seeded from settings.json effortLevel
    expect(state?.seededFrom).toBe("settings");
  });

  test("unknown session → getState undefined (no injection), ensureSession never throws", () => {
    home = mkdtempSync(join(tmpdir(), "claudish-sev-"));
    registry = new SessionEventRegistry({ claudeHome: home });
    const sid = "00000000-0000-0000-0000-000000000000";
    registry.ensureSession(sid); // no projects dir at all — records a miss
    registry.sync(sid);
    expect(registry.getState(sid)).toBeUndefined();
  });
});

describe("extractSessionId — real captured shape", () => {
  // Verbatim user_id value from the [RequestMeta] trace in
  // logs/claudish_2026-07-13_13-30-48.log (real Claude Code session).
  const REAL_USER_ID =
    '{"device_id":"073c3e365d9be8e8227e5e8c550ec03388f7643998e13abf2c306e6d2ace43c2","account_uuid":"","session_id":"4365c8f1-eb14-42b5-9d60-e69ad47e5fb3"}';

  test("parses the JSON-encoded user_id Claude Code actually sends", async () => {
    const { extractSessionId } = await import("./index.js");
    expect(extractSessionId({ user_id: REAL_USER_ID })).toBe(
      "4365c8f1-eb14-42b5-9d60-e69ad47e5fb3"
    );
  });
});
