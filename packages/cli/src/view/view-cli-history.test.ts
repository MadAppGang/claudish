/**
 * `claudish view --list --json --include-finished`: the live servers' items plus the newest runs
 * from their records, so a reader keeps a finished or failed run after its server evicted it,
 * exited or restarted. `--transcript` reads an evicted session's transcript from its records.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionItem } from "../herdr/test-helpers/placer-harness.js";
import { ContractErrorException } from "../pane/contract.js";
import { makeViewRoot } from "./test-helpers/fake-view-endpoint.js";
import { ViewClaims } from "./view-claims.js";
import { collectListing, parseListArgs, transcriptOf } from "./view-cli.js";
import { ViewDirectory } from "./view-directory.js";
import { ViewFeed } from "./view-feed.js";
import { ViewServer } from "./view-server.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});

const absent = (): never => {
  throw new ContractErrorException("unknown_session", "no such session");
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function emptyRoot(): string {
  const root = `/tmp/vch-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function serverHolding(sessionIds: string[]): Promise<string> {
  const root = emptyRoot();
  const feed = new ViewFeed({ debounceMs: 5 });
  const claims = new ViewClaims({ notify: (t) => feed.changed(t, true) });
  const directory = new ViewDirectory({
    sessions: {
      sessionRow: () => null,
      viewDetail: () => ({
        prompt_summary: null,
        prompts_sent: 0,
        pending_inputs: 0,
        subagents: [],
        magmux: null,
      }),
      listSessionRows: () => sessionIds.map((id) => sessionItem(id) as never),
      captureSession: absent,
      transcriptSession: absent,
      resizeSession: async () => absent(),
    },
    team: {
      listSlots: () => [],
      slot: () => null,
      capture: absent,
      transcript: absent,
      resize: async () => absent(),
    },
    replays: { list: () => [], capture: absent, resize: async () => absent() },
    claims,
  });
  feed.setBuilder((t) => directory.item(t));
  const server = await ViewServer.start({ root, directory, claims, feed, version: "test" });
  if (!server) throw new Error("test server failed to bind");
  cleanups.push(() => server.close());
  return root;
}

/** A session record as the session manager writes it: failed before its first turn. */
function failedSession(sessionsDir: string, id: string, ageS: number, extra = {}): string {
  const dir = join(sessionsDir, id);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date(Date.now() - 600_000).toISOString();
  writeFileSync(
    join(dir, "spawn.json"),
    JSON.stringify({ schema: 1, kind: "session", sessionId: id, startedAt, model: "gpt-6-luna" })
  );
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      sessionId: id,
      model: "gpt-6-luna",
      status: "failed",
      state: "FAILED",
      terminalReason: "child_exited",
      detail: "pane child exited with code 1",
      startedAt,
      completedAt: new Date(Date.now() - 300_000).toISOString(),
      turnsCompleted: 0,
      toolCallCount: 0,
      ...extra,
    })
  );
  const t = new Date(Date.now() - ageS * 1000);
  utimesSync(dir, t, t);
  return dir;
}

describe("claudish view --list --include-finished", () => {
  test("the flags: --json and --include-finished, nothing else", () => {
    expect(parseListArgs(["--list"])).toEqual({ json: false, includeFinished: false });
    expect(parseListArgs(["--list", "--json", "--include-finished"])).toEqual({
      json: true,
      includeFinished: true,
    });
    expect(parseListArgs(["--list", "--bogus"])).toEqual({ error: "unknown option --bogus" });
  });

  test("with no server running, the failed run still lists from its record", async () => {
    const sessionsDir = tempDir("vch-sessions-");
    failedSession(sessionsDir, "f3517773", 10, { taskType: "explain" });
    const listing = await collectListing(emptyRoot(), { includeFinished: true, sessionsDir });
    expect(listing.servers).toEqual([]);
    expect(listing.items).toEqual([]);
    expect(listing.history?.map((i) => i.target)).toEqual(["s:f3517773"]);
    expect(listing.history?.[0]).toMatchObject({
      state: "FAILED",
      reason: "child_exited",
      task_type: "explain",
    });
  });

  test("a run a live server holds is listed once, from the server", async () => {
    const sessionsDir = tempDir("vch-sessions-");
    failedSession(sessionsDir, "aaaa1111", 10);
    failedSession(sessionsDir, "bbbb2222", 20);
    const root = await serverHolding(["aaaa1111"]);
    const listing = await collectListing(root, { includeFinished: true, sessionsDir });
    expect(listing.items.map((i) => i.target)).toEqual(["s:aaaa1111"]);
    expect(listing.history?.map((i) => i.target)).toEqual(["s:bbbb2222"]);
  });

  test("without the flag the listing is what the servers hold, as before", async () => {
    const sessionsDir = tempDir("vch-sessions-");
    failedSession(sessionsDir, "aaaa1111", 10);
    const listing = await collectListing(emptyRoot(), { sessionsDir });
    expect(listing).toEqual({ servers: [], items: [] });
  });
});

describe("claudish view --transcript after the server let the session go", () => {
  test("reads the transcript from the session's records", async () => {
    const sessionsDir = tempDir("vch-sessions-");
    const configDir = tempDir("vch-claude-");
    const uuid = "9f534017-d718-4dab-a070-5194334c6f83";
    mkdirSync(join(configDir, "projects", "-work"), { recursive: true });
    const transcript = join(configDir, "projects", "-work", `${uuid}.jsonl`);
    writeFileSync(
      transcript,
      `${[
        { type: "user", uuid: "u1", message: { role: "user", content: "Explain the claims" } },
        {
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            id: "m1",
            content: [{ type: "text", text: "One holder." }],
          },
        },
      ]
        .map((r) => JSON.stringify({ ...r, sessionId: uuid }))
        .join("\n")}\n`
    );
    const old = new Date(Date.now() - 600_000);
    utimesSync(transcript, old, old);
    failedSession(sessionsDir, "dddd4444", 5, {
      state: "COMPLETED",
      status: "completed",
      terminalReason: null,
      claudeSessionId: uuid,
      transcriptPath: transcript,
    });
    const out = await transcriptOf(emptyRoot(), "s:dddd4444", undefined, {
      sessionsDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.lines.map((l) => l.text)).toEqual(["Explain the claims", "One holder."]);
    expect(out.result.final).toBe(true);
  });

  test("a target in neither a server nor the records keeps the server's answer", async () => {
    const sessionsDir = tempDir("vch-sessions-");
    expect(await transcriptOf(emptyRoot(), "s:eeee5555", undefined, { sessionsDir })).toEqual({
      ok: false,
      error: { code: "server_gone", message: "no claudish MCP server is running" },
    });
  });
});
