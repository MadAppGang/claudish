import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { isolatedFile } from "../test-helpers/claude-behaviour.js";
import {
  childEnv,
  json,
  networkGuard,
  put,
  runChild,
  useSandbox,
  waitForFile,
} from "../test-helpers/model-lineup-blind.js";
import type { OriginalModel, RestoreDeps } from "./model-setting-restore.js";

await isolatedFile(import.meta, async () => {
  const sandbox = useSandbox();
  const {
    beginModelSettingWatch,
    sweepModelSettingLedger,
    restoreDecision,
    restoreSettingsFile,
    canonicalSettingsPath,
    realRestoreFs,
  } = await import("./model-setting-restore.js");
  const moduleUrl = new URL("./model-setting-restore.js", import.meta.url).href;

  function dependencies(lines: string[], extra: RestoreDeps = {}): RestoreDeps {
    const { home, settingsFile, ledgerPath } = sandbox();
    return {
      settingsFile,
      ledgerPath,
      env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") },
      cwd: home,
      report: (line) => {
        lines.push(line);
      },
      ...extra,
    };
  }
  function entry(original: OriginalModel = { present: true, value: "opus" }) {
    return { original, listed: ["or@a", "or@b"] };
  }
  function fileStat(path: string) {
    const stat = statSync(path);
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    };
  }
  function abandoned() {
    const { settingsFile, ledgerPath } = sandbox();
    put(ledgerPath, {
      version: 1,
      entries: { [canonicalSettingsPath(settingsFile)]: { ...entry(), sessions: [] } },
    });
  }

  // REQ-32
  const decisions: Array<{
    current: unknown;
    original: OriginalModel;
    listed: string[];
    expected: ReturnType<typeof restoreDecision>;
  }> = [
    {
      current: "or@a",
      original: { present: true, value: "opus" },
      listed: ["or@a"],
      expected: { action: "set", value: "opus" },
    },
    {
      current: "or@a",
      original: { present: false },
      listed: ["or@a"],
      expected: { action: "delete" },
    },
    {
      current: "sonnet",
      original: { present: true, value: "opus" },
      listed: ["or@a"],
      expected: { action: "leave" },
    },
    {
      current: undefined,
      original: { present: true, value: "opus" },
      listed: ["or@a"],
      expected: { action: "leave" },
    },
    {
      current: "or@a",
      original: { present: true, value: "or@a" },
      listed: ["or@a"],
      expected: { action: "leave" },
    },
    {
      current: "or@a",
      original: { present: true, value: 7 },
      listed: ["or@a"],
      expected: { action: "set", value: 7 },
    },
  ];
  test.each(decisions)(
    "TEST-46 conditional restore decision for current $current and original $original",
    (row) => {
      expect(restoreDecision(row.current, { original: row.original, listed: row.listed })).toEqual(
        row.expected
      );
    }
  );

  test("TEST-47 equal listed original leaves escaped JSON bytes and stat unchanged", () => {
    const path = sandbox().settingsFile;
    const bytes = '{"model":"or@a","note":"\\u00e9","number":1.0}\n';
    put(path, bytes);
    const before = fileStat(path);

    expect(
      restoreSettingsFile(canonicalSettingsPath(path), {
        original: { present: true, value: "or@a" },
        listed: ["or@a"],
      })
    ).toBe("left");

    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(fileStat(path)).toEqual(before);
  });

  // REQ-34: escapes may normalize; parsed unrelated values may not change.
  test.each([true, false])(
    "TEST-48 restoring present=%s preserves other values, indentation, newline and mode",
    (present) => {
      const path = sandbox().settingsFile;
      put(
        path,
        '{\n    "model": "or@a",\n    "note": "\\u00e9",\n    "nested": {"keep": [1, true]},\n    "number": 1.0\n}\n'
      );
      chmodSync(path, 0o600);
      const original: OriginalModel = present
        ? { present: true, value: "opus" }
        : { present: false };
      expect(restoreSettingsFile(canonicalSettingsPath(path), entry(original))).toBe("restored");
      const restored = json(path);
      expect(restored).toEqual({
        ...(present ? { model: "opus" } : {}),
        note: "é",
        nested: { keep: [1, true] },
        number: 1,
      });
      const bytes = readFileSync(path, "utf8");
      expect(bytes.split("\n")[1]).toMatch(/^ {4}"/);
      expect(bytes.endsWith("\n")).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  );

  // REQ-33, REQ-34
  test("TEST-49 canonical paths unify directory/file symlinks and nonexistent descendants", () => {
    const { home, settingsFile } = sandbox();
    const directoryLink = join(home, "claude-link");
    const fileLink = join(home, "settings-link.json");
    symlinkSync(join(home, ".claude"), directoryLink);
    symlinkSync(settingsFile, fileLink);
    expect(canonicalSettingsPath(join(directoryLink, "settings.json"))).toBe(
      canonicalSettingsPath(settingsFile)
    );
    expect(canonicalSettingsPath(join(home, ".claude", "..", ".claude", "settings.json"))).toBe(
      canonicalSettingsPath(settingsFile)
    );
    expect(canonicalSettingsPath(join(directoryLink, "future", "settings.json"))).toBe(
      canonicalSettingsPath(join(home, ".claude", "future", "settings.json"))
    );

    put(settingsFile, { model: "or@a", keep: true });
    expect(restoreSettingsFile(canonicalSettingsPath(fileLink), entry())).toBe("restored");
    expect(lstatSync(fileLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(fileLink)).toBe(realpathSync(settingsFile));
    expect(json<{ model: string; keep: boolean }>(settingsFile)).toEqual({
      model: "opus",
      keep: true,
    });
  });

  test.each(["other-key", "new-model"] as const)(
    "TEST-50 CAS re-reads concurrent %s changes before restore",
    (change) => {
      const path = sandbox().settingsFile;
      put(path, { model: "or@a", keep: "old" });
      let changed = false;
      const outcome = restoreSettingsFile(canonicalSettingsPath(path), entry(), {
        ...realRestoreFs,
        beforeRename: () => {
          if (changed) return;
          changed = true;
          put(path, {
            model: change === "new-model" ? "new-user-default" : "or@a",
            keep: "concurrent",
          });
        },
      });
      expect(outcome).toBe(change === "new-model" ? "left" : "restored");
      expect(json<{ model: string; keep: string }>(path)).toEqual({
        model: change === "new-model" ? "new-user-default" : "opus",
        keep: "concurrent",
      });
    }
  );

  test("TEST-51 repeated concurrent writes exhaust three CAS rounds without losing the writer", () => {
    const path = sandbox().settingsFile;
    put(path, { model: "or@a", edition: 0 });
    const outcome = restoreSettingsFile(canonicalSettingsPath(path), entry(), {
      ...realRestoreFs,
      beforeRename: () => {
        const current = json<{ model: string; edition: number }>(path);
        put(path, { ...current, edition: current.edition + 1 });
      },
    });
    expect(outcome).toBe("changed-under-us");
    expect(json<{ model: string; edition: number }>(path)).toEqual({ model: "or@a", edition: 3 });
  });

  // REQ-32, REQ-33, REQ-38
  test.each([true, false])(
    "TEST-52 registered watch silently restores original presence=%s",
    async (present) => {
      const { settingsFile, ledgerPath } = sandbox();
      const lines: string[] = [];
      put(settingsFile, { ...(present ? { model: "opus" } : {}), keep: true });
      const watch = await beginModelSettingWatch(["or@a"], dependencies(lines));
      try {
        expect(watch.registered).toBe(true);
        expect(lines).toEqual([]);
        put(settingsFile, { model: "or@a", keep: true });
      } finally {
        await watch.end();
      }
      expect(json<{ model?: string; keep: boolean }>(settingsFile)).toEqual({
        ...(present ? { model: "opus" } : {}),
        keep: true,
      });
      expect(existsSync(ledgerPath)).toBe(false);
    }
  );

  test("TEST-53 only last watch restores the original across union picks and a changed config directory", async () => {
    const { home, settingsFile, ledgerPath } = sandbox();
    const lines: string[] = [];
    put(settingsFile, { model: "opus", keep: 1 });
    const first = await beginModelSettingWatch(["or@a"], dependencies(lines));
    const second = await beginModelSettingWatch(["or@b"], dependencies(lines));
    try {
      expect(first.registered).toBe(true);
      expect(second.registered).toBe(true);
      expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, ".claudish")).mode & 0o777).toBe(0o700);
      put(settingsFile, { model: "or@a", keep: 2 });
      await first.end();
      expect(json<{ model: string; keep: number }>(settingsFile)).toEqual({
        model: "or@a",
        keep: 2,
      });

      process.env.CLAUDE_CONFIG_DIR = join(home, "other-config");
      const other = join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
      put(other, { model: "do-not-touch" });
      await second.end();
      expect(json<{ model: string; keep: number }>(settingsFile)).toEqual({
        model: "opus",
        keep: 2,
      });
      expect(json<{ model: string }>(other)).toEqual({ model: "do-not-touch" });
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      await first.end();
      await second.end();
    }
  });

  test.each(["{nope", "[]", "null", "42"])(
    "TEST-54 invalid settings %s create one inert-watch diagnostic and remain unchanged",
    async (bytes) => {
      const { settingsFile, ledgerPath } = sandbox();
      put(settingsFile, bytes);
      const lines: string[] = [];
      const watch = await beginModelSettingWatch(["or@a"], dependencies(lines));
      expect(watch.registered).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(settingsFile);
      expect(lines[0]).toContain("will not put back");
      await watch.end();
      watch.endSync();
      expect(readFileSync(settingsFile, "utf8")).toBe(bytes);
      expect(existsSync(ledgerPath)).toBe(false);
    }
  );

  test.each(['{"version":2,"entries":{}}', "{not-json", '{"version":1,"entries":[]}'])(
    "TEST-55 bad ledger %s is reported once and never rewritten",
    async (bytes) => {
      const { ledgerPath } = sandbox();
      put(ledgerPath, bytes);
      const before = fileStat(ledgerPath);
      const lines: string[] = [];
      const watch = await beginModelSettingWatch(["or@a"], dependencies(lines));
      expect(watch.registered).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(ledgerPath);
      expect(lines[0]).toContain("delete that file");
      await watch.end();
      expect(readFileSync(ledgerPath, "utf8")).toBe(bytes);
      expect(fileStat(ledgerPath)).toEqual(before);
    }
  );

  test("TEST-55 a ledger directory produces the manual remedy and stays a directory", async () => {
    const { ledgerPath } = sandbox();
    mkdirSync(ledgerPath, { recursive: true });
    const lines: string[] = [];
    const watch = await beginModelSettingWatch(["or@a"], dependencies(lines));
    expect(watch.registered).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ledgerPath);
    expect(lines[0]).toContain("delete that file");
    await watch.end();
    expect(statSync(ledgerPath).isDirectory()).toBe(true);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "TEST-55 an EACCES ledger is reported without changing its contents",
    async () => {
      const { ledgerPath } = sandbox();
      const bytes = '{"version":1,"entries":{}}';
      put(ledgerPath, bytes);
      chmodSync(ledgerPath, 0o000);
      const lines: string[] = [];
      try {
        const watch = await beginModelSettingWatch(["or@a"], dependencies(lines));
        expect(watch.registered).toBe(false);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(ledgerPath);
        expect(lines[0]).toContain("delete that file");
        await watch.end();
      } finally {
        chmodSync(ledgerPath, 0o600);
      }
      expect(readFileSync(ledgerPath, "utf8")).toBe(bytes);
    }
  );

  // ENOTDIR is additionally exercised at the actual launch boundary by TEST-62.
  test("TEST-55 ledger with a regular-file parent leaves the watch inert without throwing", async () => {
    const { home, ledgerPath } = sandbox();
    put(join(home, ".claudish"), "not a directory");
    const lines: string[] = [];
    const watch = await beginModelSettingWatch(["or@a"], dependencies(lines));
    expect(watch.registered).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ledgerPath);
    await watch.end();
    expect(readFileSync(join(home, ".claudish"), "utf8")).toBe("not a directory");
  });

  test("TEST-56 sweep followed by watch reports the same bad ledger only once", async () => {
    const lines: string[] = [];
    put(sandbox().ledgerPath, "{not-json");
    const deps = dependencies(lines);
    await sweepModelSettingLedger(deps);
    const watch = await beginModelSettingWatch(["or@a"], deps);
    expect(watch.registered).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(sandbox().ledgerPath);
    expect(lines[0]).toContain("delete that file");
    await watch.end();
  });

  test("TEST-57 a real live lock holder makes registration inert with one lock-path diagnostic", async () => {
    const { home, settingsFile, ledgerPath } = sandbox();
    const held = join(home, "lock-held");
    const release = join(home, "release-lock");
    put(settingsFile, { model: "opus" });
    const source = [
      'import {existsSync,writeFileSync} from "node:fs";',
      "const {beginModelSettingWatch}=await import(" + JSON.stringify(moduleUrl) + ");",
      "const settingsFile=" + JSON.stringify(settingsFile) + ";",
      'const watch=await beginModelSettingWatch(["or@a"],{settingsFile,ledgerPath:' +
        JSON.stringify(ledgerPath) +
        ",report:line=>console.error(line),beforeRename(){",
      "  writeFileSync(" + JSON.stringify(held) + ',"held");',
      "  const end=Date.now()+10000;const cell=new Int32Array(new SharedArrayBuffer(4));",
      "  while(!existsSync(" +
        JSON.stringify(release) +
        ')){if(Date.now()>end)throw new Error("lock holder release timeout");Atomics.wait(cell,0,0,20);}',
      "}});",
      'if(!watch.registered)throw new Error("holder did not register");',
      'writeFileSync(settingsFile,JSON.stringify({model:"or@a"}));',
      "await watch.end();",
    ].join("\n");
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "--preload", networkGuard(home), "--eval", source],
      {
        cwd: home,
        env: childEnv(home),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    try {
      await waitForFile(held);
      const lines: string[] = [];
      const watch = await beginModelSettingWatch(["or@a"], dependencies(lines));
      expect(watch.registered).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(ledgerPath + ".lock");
      await watch.end();
    } finally {
      put(release, "release");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
      const code = await child.exited;
      clearTimeout(timeout);
      const [stdout, stderr] = await output;
      expect(code, stdout + stderr).toBe(0);
    }
  }, 30_000);

  // REQ-36
  test("TEST-58 end and endSync share one latch and repeated exits cannot overwrite new data", async () => {
    const { settingsFile } = sandbox();
    put(settingsFile, { model: "opus" });
    const watch = await beginModelSettingWatch(["or@a"], dependencies([]));
    expect(watch.registered).toBe(true);
    put(settingsFile, { model: "or@a" });
    const ending = watch.end();
    watch.endSync();
    await ending;
    expect(json<{ model: string }>(settingsFile)).toEqual({ model: "opus" });

    put(settingsFile, { model: "new-user-default", keep: true });
    watch.endSync();
    await watch.end();
    expect(json<{ model: string; keep: boolean }>(settingsFile)).toEqual({
      model: "new-user-default",
      keep: true,
    });
  });

  // REQ-37
  test("TEST-59 sweep restores an abandoned entry and deletes the last ledger file", async () => {
    put(sandbox().settingsFile, { model: "or@a", keep: true });
    abandoned();
    await sweepModelSettingLedger(dependencies([]));
    expect(json<{ model: string; keep: boolean }>(sandbox().settingsFile)).toEqual({
      model: "opus",
      keep: true,
    });
    expect(existsSync(sandbox().ledgerPath)).toBe(false);
  });

  // REQ-35: neither private process-table shapes nor mock liveness answers are used.
  test("TEST-60 a real surviving child holds restore after its launcher exits", async () => {
    const { home, settingsFile, ledgerPath } = sandbox();
    put(settingsFile, { model: "opus" });
    const pidFile = join(home, "survivor-pid.json");
    const source = [
      'import {writeFileSync} from "node:fs";',
      "const {beginModelSettingWatch}=await import(" + JSON.stringify(moduleUrl) + ");",
      'const watch=await beginModelSettingWatch(["or@a"],{settingsFile:' +
        JSON.stringify(settingsFile) +
        ",ledgerPath:" +
        JSON.stringify(ledgerPath) +
        "});",
      'if(!watch.registered)throw new Error("launcher failed to register");',
      'const child=Bun.spawn([process.execPath,"--no-env-file","--eval","setInterval(()=>{},1000)"],{cwd:process.env.HOME,env:{...process.env},stdin:"ignore",stdout:"ignore",stderr:"ignore"});',
      "watch.recordChild(child.pid);",
      "writeFileSync(" + JSON.stringify(pidFile) + ",JSON.stringify({pid:child.pid}));",
      "writeFileSync(" +
        JSON.stringify(settingsFile) +
        ',JSON.stringify({model:"or@a",keep:true}));',
      "child.unref();",
      "process.exit(0);",
    ].join("\n");
    let survivor: number | undefined;
    try {
      const launch = await runChild(home, source);
      if (existsSync(pidFile)) survivor = json<{ pid: number }>(pidFile).pid;
      expect(launch.code, launch.stdout + launch.stderr).toBe(0);
      expect(survivor).toBeDefined();
      await sweepModelSettingLedger(dependencies([]));
      expect(json<{ model: string; keep: boolean }>(settingsFile)).toEqual({
        model: "or@a",
        keep: true,
      });

      process.kill(survivor!, "SIGTERM");
      const end = Date.now() + 5_000;
      while (true) {
        try {
          process.kill(survivor!, 0);
        } catch {
          break;
        }
        if (Date.now() > end) throw new Error("Surviving child did not exit");
        await Bun.sleep(10);
      }
      survivor = undefined;
      await sweepModelSettingLedger(dependencies([]));
      expect(json<{ model: string; keep: boolean }>(settingsFile)).toEqual({
        model: "opus",
        keep: true,
      });
      expect(existsSync(ledgerPath)).toBe(false);
    } finally {
      if (survivor !== undefined) {
        try {
          process.kill(survivor, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
    }
  }, 20_000);

  test("TEST-61 sweep reports unreadable settings once and retries only after a changed file", async () => {
    const { settingsFile, ledgerPath } = sandbox();
    put(settingsFile, "{nope");
    abandoned();
    const lines: string[] = [];
    const deps = dependencies(lines);
    await sweepModelSettingLedger(deps);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(settingsFile);
    expect(readFileSync(settingsFile, "utf8")).toBe("{nope");
    await sweepModelSettingLedger(deps);
    expect(lines).toHaveLength(1);

    put(settingsFile, { model: "or@a", repaired: true });
    await sweepModelSettingLedger(deps);
    expect(json<{ model: string; repaired: boolean }>(settingsFile)).toEqual({
      model: "opus",
      repaired: true,
    });
    expect(existsSync(ledgerPath)).toBe(false);
  });
});
