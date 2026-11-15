import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.COMPACTION_BLIND_FILE !== import.meta.path) {
  test("runs compaction contract cases with an isolated HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "compaction-blind-home-"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(ANTHROPIC|CLAUDE|CLAUDISH|OPENAI|OP_|XDG_)/.test(key)) delete env[key];
    }
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: home,
      env: {
        ...env,
        HOME: home,
        COMPACTION_BLIND_FILE: import.meta.path,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_NO_PREDEFINED_ENDPOINTS: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const watchdog = setTimeout(() => child.kill(), 50_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally {
      clearTimeout(watchdog);
      child.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
} else {
  globalThis.fetch = (() => {
    throw new Error("Unexpected network access in blind tests");
  }) as unknown as typeof fetch;

  const { createHash } = await import("node:crypto");
  const { mkdirSync, writeFileSync, utimesSync, existsSync, statSync } = await import("node:fs");
  const { prepareCompactionLaunch } = await import("./launch.js");
  const {
    CompactionStore,
    toolOutputKey,
    historyRecordKey,
    isSafeSessionId,
    purgeExpiredSessions,
    COMPACTION_RETENTION_MS,
  } = await import("./store.js");
  const uuid = "1a530299-13b3-4f99-86ef-dc43bea3d47d";
  const minted = "a2bc9d87-d61e-4786-98b6-f4127d3fa911";
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "compaction-launch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const args of [
    ["--session-id", uuid],
    ["--resume", uuid],
    ["-r", uuid],
    ["--fork-session", "--session-id", uuid],
  ]) {
    test("REQ-16: known id adds only its own session folder: " + args.join(" "), () => {
      const plan = prepareCompactionLaunch(args, root, () => minted);
      expect(plan.sessionId).toBe(uuid);
      expect(plan.leadingArgs).toEqual(["--add-dir", join(root, uuid)]);
      expect(plan.dir).toBe(join(root, uuid));
      expect(statSync(plan.dir!).mode & 0o777).toBe(0o700);
      expect(plan.leadingArgs).not.toContain(root);
    });
  }
  test("REQ-16: a new launch mints one id and grants only its folder", () => {
    const args = ["--model", "claude-sonnet-5-5"];
    const original = [...args];
    const plan = prepareCompactionLaunch(args, root, () => minted);
    expect(plan.leadingArgs).toEqual(["--session-id", minted, "--add-dir", join(root, minted)]);
    expect(plan.sessionId).toBe(minted);
    expect(plan.dir).toBe(join(root, minted));
    expect(statSync(plan.dir!).mode & 0o777).toBe(0o700);
    expect(args).toEqual(original);
  });
  for (const args of [
    ["--continue"],
    ["-c"],
    ["--resume"],
    ["-r"],
    ["--resume", "search words"],
    ["--fork-session"],
    ["--resume", uuid, "--fork-session"],
    ["--session-id", "../unsafe"],
  ]) {
    test("REQ-16: unknown session adds neither session id nor directory: " + args.join(" "), () => {
      const plan = prepareCompactionLaunch(args, root, () => minted);
      expect(plan.leadingArgs).toEqual([]);
      expect(plan.dir == null).toBe(true);
      expect(existsSync(join(root, minted))).toBe(false);
    });
  }
  test("REQ-6: tool key uses NUL-separated sha256 of session, id and original text", () => {
    const expected = createHash("sha256").update("session\0tool\0original").digest("hex");
    expect(toolOutputKey("session", "tool", "original")).toBe(expected);
    expect(toolOutputKey("ab", "c", "d")).not.toBe(toolOutputKey("a", "bc", "d"));
    expect(historyRecordKey("history-summary", "session", "prefix")).toBe(
      createHash("sha256").update("history-summary\0session\0prefix").digest("hex")
    );
  });
  test("REQ-5: safe session ids have exactly the documented alphabet and length", () => {
    for (const id of ["a", uuid, "A_0-z", "x".repeat(128)]) expect(isSafeSessionId(id)).toBe(true);
    for (const id of ["", ".", "..", "../x", "/absolute", "a/b", "a\\b", "a b", "x".repeat(129)]) {
      expect(isSafeSessionId(id)).toBe(false);
    }
  });

  test("REQ-8: first persisted decision wins over a later different decision", () => {
    const store = new CompactionStore(root);
    const key = toolOutputKey("session", "tool", "original");
    const first = {
      kind: "tool-output" as const,
      form: "original" as const,
      reason: "first",
      decidedAt: new Date(1).toISOString(),
    };
    store.put("session", key, first);
    store.put("session", key, { ...first, reason: "second", decidedAt: new Date(2).toISOString() });
    expect(new CompactionStore(root).get("session", key)).toEqual(first);
    expect(statSync(join(root, "session")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "session", key + ".json")).mode & 0o777).toBe(0o600);
  });

  test("REQ-17: expiry uses newest file write, seven days, and the explicit keep set", () => {
    const now = Date.UTC(2030, 0, 15);
    expect(COMPACTION_RETENTION_MS).toBe(7 * 86400000);
    const old = now - COMPACTION_RETENTION_MS - 1000;
    const recent = now - COMPACTION_RETENTION_MS + 1000;
    function file(id: string, name: string, time: number) {
      mkdirSync(join(root, id), { recursive: true });
      const path = join(root, id, name);
      writeFileSync(path, "test data");
      utimesSync(path, new Date(time), new Date(time));
    }
    file("expired", "one.json", old);
    file("active", "one.json", old);
    file("active", "two.txt", recent);
    file("resumed", "one.json", old);
    file("at-boundary", "one.json", now - COMPACTION_RETENTION_MS);
    const deleted = purgeExpiredSessions(root, { now, keep: new Set(["resumed"]) });
    expect(deleted).toHaveLength(1);
    expect(existsSync(join(root, "expired"))).toBe(false);
    expect(existsSync(join(root, "active", "two.txt"))).toBe(true);
    expect(existsSync(join(root, "resumed", "one.json"))).toBe(true);
    expect(existsSync(join(root, "at-boundary", "one.json"))).toBe(true);
  });
}
