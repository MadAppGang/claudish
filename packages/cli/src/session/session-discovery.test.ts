import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirNameFor } from "../channel/parent-proof.js";
import {
  ACTIVE_WINDOW_MS,
  type SessionRow,
  isActive,
  projectsDir,
  sessionLabel,
  slugForPath,
  transcriptPathFor,
} from "./session-discovery.js";

const fixtureHome = mkdtempSync(join(tmpdir(), "claudish-session-discovery-"));

afterAll(() => {
  rmSync(fixtureHome, { recursive: true, force: true });
});

function sessionFixture(cwd: string, id: string, mtimeMs: number): void {
  const record = `${JSON.stringify({
    type: "user",
    cwd,
    sessionId: id,
    message: { role: "user", content: "fixture" },
  })}\n`;
  const projectDir = join(fixtureHome, ".claude", "projects", slugForPath(cwd));
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${id}.jsonl`);
  writeFileSync(file, record);
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

function findLatestInFixture(
  cwd: string,
  sinceMs: number,
  envOverride: Record<string, string> = { HOME: fixtureHome }
): string | null {
  const script = `import { findLatestSessionId } from "./src/session/session-discovery.ts";
process.stdout.write(findLatestSessionId(${JSON.stringify(cwd)}, ${sinceMs}) ?? "");`;
  const env: Record<string, string | undefined> = { ...process.env, ...envOverride };
  // An outer CLAUDE_CONFIG_DIR would outrank the fixture HOME.
  if (!("CLAUDE_CONFIG_DIR" in envOverride)) delete env.CLAUDE_CONFIG_DIR;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, "../.."),
    env,
  });
  expect(result.exitCode).toBe(0);
  const id = result.stdout.toString().trim();
  return id || null;
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-id",
    file: "/not/read/by-these-tests/session-id.jsonl",
    mtimeMs: 0,
    sizeBytes: 1,
    ...overrides,
  };
}

describe("session discovery pure helpers", () => {
  test("slugForPath replaces both slashes and dots without collapsing them", () => {
    expect(slugForPath("/a/b")).toBe("-a-b");
    expect(slugForPath("/Users/x/.claude/worktrees/y")).toBe("-Users-x--claude-worktrees-y");
  });

  test("slugForPath replaces EVERY non-alphanumeric character, as Claude Code does", () => {
    // The directory Claude Code 2.1.287 created for a live run whose cwd was
    // `…/research-scratch/fresh_cwd.v1` (research-transcript-and-launch.md §1.1):
    // the `_` became `-` along with `/` and `.`.
    const cwd =
      "/Users/jack/mag/claudish/.claude/worktrees/claudish-mcp-magmux/ai-docs/sessions/dev-feature-mcp-magmux-panes-20261002-a7c3/research-scratch/fresh_cwd.v1";
    expect(slugForPath(cwd)).toBe(
      "-Users-jack-mag-claudish--claude-worktrees-claudish-mcp-magmux-ai-docs-sessions-dev-feature-mcp-magmux-panes-20261002-a7c3-research-scratch-fresh-cwd-v1"
    );
    expect(slugForPath("/tmp/a b@c+d")).toBe("-tmp-a-b-c-d");
  });

  test("projectsDir reads CLAUDE_CONFIG_DIR from the environment it is given", () => {
    expect(projectsDir({ CLAUDE_CONFIG_DIR: "/cfg/claude", HOME: "/home/u" })).toBe(
      "/cfg/claude/projects"
    );
  });

  test("projectsDir falls back to $HOME/.claude when CLAUDE_CONFIG_DIR is unset or empty", () => {
    expect(projectsDir({ HOME: "/home/u" })).toBe("/home/u/.claude/projects");
    expect(projectsDir({ HOME: "/home/u", CLAUDE_CONFIG_DIR: "" })).toBe(
      "/home/u/.claude/projects"
    );
  });

  test("transcriptPathFor joins under the projects directory it is handed", () => {
    const root = projectsDir({ CLAUDE_CONFIG_DIR: "/cfg" });
    expect(transcriptPathFor("/no/such/dir_x", "u-1", root)).toBe(
      "/cfg/projects/-no-such-dir-x/u-1.jsonl"
    );
  });

  test("slugForPath is the parent proof's projectDirNameFor, so the two cannot drift", () => {
    for (const p of ["/a/b_c.d", "/x y/@z", "/Users/x/.claude/worktrees/y"]) {
      expect(slugForPath(p)).toBe(projectDirNameFor(p));
    }
  });

  test("a slug over 200 characters is cut and hashed exactly as Claude Code 2.1.291 named it", () => {
    // A live 2.1.291 run (code-review iteration 1, phase2/runs/cr1-longcwd) in this
    // 259-character cwd wrote its transcript under the directory named below.
    const cwd = `/private/tmp/cc2/cr1-longcwd/cwd/${[
      "a".repeat(60),
      "b-b.b_b".repeat(9),
      "c".repeat(60),
      "dé ü".repeat(10),
    ].join("/")}`;
    const measured =
      "-private-tmp-cc2-cr1-longcwd-cwd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-b-b-b-bb-b-b-bb-b-b-bb-b-b-bb-b-b-bb-b-b-bb-b-b-bb-b-b-bb-b-b-b-cccccccccccccccccccccccccccccccccccccccccc-g32rlu";
    expect(slugForPath(cwd)).toBe(measured);
    expect(transcriptPathFor(cwd, "u-1", "/cfg/projects")).toBe(
      `/cfg/projects/${measured}/u-1.jsonl`
    );
    // exactly 200 slug characters stay as they are
    const at200 = `/${"x".repeat(199)}`;
    expect(slugForPath(at200)).toBe(`-${"x".repeat(199)}`);
    expect(slugForPath(`${at200}y`)).toMatch(/^-x{199}-[0-9a-z]+$/);
  });

  test("isActive respects the explicit recency-window boundary", () => {
    const now = 1_000_000;

    expect(isActive(row({ mtimeMs: now - ACTIVE_WINDOW_MS + 1 }), now)).toBe(true);
    expect(isActive(row({ mtimeMs: now - ACTIVE_WINDOW_MS - 1 }), now)).toBe(false);
  });

  test("sessionLabel prefers title, then first prompt, then id", () => {
    expect(
      sessionLabel(row({ title: "Generated title", firstPrompt: "Opening prompt", id: "fallback" }))
    ).toBe("Generated title");
    expect(sessionLabel(row({ firstPrompt: "Opening prompt", id: "fallback" }))).toBe(
      "Opening prompt"
    );
    expect(sessionLabel(row({ id: "fallback" }))).toBe("fallback");
  });
});

describe("findLatestSessionId", () => {
  test("prefers a transcript born during the window over an older fresher transcript", async () => {
    const cwd = "/tmp/project-with-competing-sessions";
    const outerId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const beforeWindow = Date.now();
    sessionFixture(cwd, outerId, beforeWindow + 3_000);
    await Bun.sleep(10);
    const sinceMs = Date.now();
    await Bun.sleep(10);
    sessionFixture(cwd, childId, beforeWindow + 2_000);

    expect(findLatestInFixture(cwd, sinceMs)).toBe(childId);
  });

  test("falls back to newest-by-mtime when no transcript was born during the window", () => {
    const cwd = "/tmp/project-with-resumed-sessions";
    const olderId = "33333333-3333-4333-8333-333333333333";
    const newerId = "44444444-4444-4444-8444-444444444444";
    const createdAt = Date.now();
    sessionFixture(cwd, olderId, createdAt + 1_000);
    sessionFixture(cwd, newerId, createdAt + 2_000);
    const sinceMs = createdAt + 500;

    expect(findLatestInFixture(cwd, sinceMs)).toBe(newerId);
  });

  test("looks under CLAUDE_CONFIG_DIR, not the home directory, when it is set", () => {
    const cwd = "/tmp/project-under-config-dir";
    const id = "55555555-5555-4555-8555-555555555555";
    const createdAt = Date.now();
    sessionFixture(cwd, id, createdAt + 1_000);
    const emptyHome = join(fixtureHome, "empty-home");
    mkdirSync(emptyHome, { recursive: true });

    expect(
      findLatestInFixture(cwd, createdAt, {
        HOME: emptyHome,
        CLAUDE_CONFIG_DIR: join(fixtureHome, ".claude"),
      })
    ).toBe(id);
  });
});
