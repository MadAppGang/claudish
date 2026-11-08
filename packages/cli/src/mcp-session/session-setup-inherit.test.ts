/** Process-level coverage for caller setup inheritance in a real headless magmux pane. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import { SessionManager } from "./session-manager.js";

const T_PANE = 30_000;

type ChildProbe = { argv: string[]; env: Record<string, string>; cwd: string };
type InheritedSettings = { enabledPlugins: Record<string, boolean>; model?: string };

function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(check, 20);
    };
    check();
  });
}

describe.skipIf(!MAGMUX)(
  `SessionCreateOptions setup inheritance (${MAGMUX ? "magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    let t: PaneTestEnv;
    let sessionsDir: string;
    let probe: string;
    let managers: SessionManager[];

    beforeEach(() => {
      t = makePaneTestEnv();
      sessionsDir = join(t.tmp, "sessions");
      probe = join(t.tmp, "probe-{session}.json");
      managers = [];
    });

    afterEach(async () => {
      for (const m of managers) await m.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot }, 10_000);
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    });

    function makeManager(): SessionManager {
      const manager = new SessionManager({
        sessionsDir,
        hostPid: 1,
        parentEnv: { ...t.env, FAKE_PROBE_FILE: probe },
        paneTimings: { replStableMs: 200 },
      });
      managers.push(manager);
      return manager;
    }

    async function childProbe(manager: SessionManager, sessionId: string): Promise<ChildProbe> {
      const path = probe.replace("{session}", manager.getSession(sessionId).claudeSessionId);
      await waitUntil(() => existsSync(path));
      return JSON.parse(readFileSync(path, "utf-8")) as ChildProbe;
    }

    async function expectInheritedSession(claudishFlags: string[]): Promise<InheritedSettings> {
      const caller = join(t.tmp, "caller");
      const work = join(t.tmp, "work");
      mkdirSync(join(caller, ".claude"), { recursive: true });
      mkdirSync(work);
      const callerSettings = join(caller, ".claude", "settings.json");
      writeFileSync(callerSettings, '{"enabledPlugins":{"dev@magus":true}}\n');
      const before = readFileSync(callerSettings);
      const manager = makeManager();

      const sessionId = await manager.createSession({
        model: "fake-env_probe",
        cwd: work,
        setupFrom: caller,
        claudishFlags,
      });
      const child = await childProbe(manager, sessionId);
      const sessionDir = join(sessionsDir, sessionId);
      expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
      expect(child.argv.filter((arg) => arg === "--settings")).toHaveLength(1);
      expect(child.argv.some((arg) => arg.startsWith("--settings="))).toBe(false);
      const settingsPath = child.argv[child.argv.indexOf("--settings") + 1];
      expect(isAbsolute(settingsPath)).toBe(true);
      expect(settingsPath).toBe(join(sessionDir, "inherited-settings.json"));
      expect(settingsPath.startsWith(`${sessionsDir}${sep}`)).toBe(true);
      expect(settingsPath.startsWith(`${work}${sep}`)).toBe(false);
      expect(settingsPath.startsWith(`${caller}${sep}`)).toBe(false);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as InheritedSettings;
      expect(settings.enabledPlugins["dev@magus"]).toBe(true);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      expect(child.cwd).toBe(realpathSync(work));
      const spawn = JSON.parse(readFileSync(join(sessionDir, "spawn.json"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(spawn.setupFrom).toBe(caller);

      await manager.shutdownAll();
      expect(readdirSync(work)).toEqual([]);
      expect(readFileSync(callerSettings)).toEqual(before);
      return settings;
    }

    test(
      "inherits caller plugins through one private settings file outside the work directory",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        await expectInheritedSession([]);
      },
      T_PANE
    );

    test(
      "merges a caller settings flag into the inherited file without adding another settings flag",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        const settings = await expectInheritedSession(["--settings", '{"model":"c"}']);
        expect(settings.model).toBe("c");
      },
      T_PANE
    );

    test(
      "omitting setupFrom adds no settings flag, inherited file, or spawn metadata",
      async () => {
        // REGRESSION: MTL-204/MTL-185 sandbox child lost the caller's plugins — /dev:fix session dev-fix-20261022-023522-f75563b5
        const work = join(t.tmp, "work");
        mkdirSync(work);
        const manager = makeManager();
        const sessionId = await manager.createSession({
          model: "fake-env_probe",
          cwd: work,
          claudishFlags: [],
        });
        const child = await childProbe(manager, sessionId);
        const sessionDir = join(sessionsDir, sessionId);

        expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
        expect(
          child.argv.filter((arg) => arg === "--settings" || arg.startsWith("--settings="))
        ).toEqual([]);
        expect(existsSync(join(sessionDir, "inherited-settings.json"))).toBe(false);
        const spawn = JSON.parse(readFileSync(join(sessionDir, "spawn.json"), "utf-8")) as Record<
          string,
          unknown
        >;
        expect(spawn).not.toHaveProperty("setupFrom");
        expect(child.cwd).toBe(realpathSync(work));

        await manager.shutdownAll();
        expect(readdirSync(work)).toEqual([]);
      },
      T_PANE
    );
  }
);
