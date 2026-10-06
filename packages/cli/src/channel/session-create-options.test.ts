/**
 * Process-level coverage for SessionCreateOptions passthroughs.
 *
 * Every session is the fake interactive child in a real headless magmux pane, built from
 * a hermetic `parentEnv`. Its `env_probe` scenario writes the environment the pane child
 * actually received to FAKE_PROBE_FILE, so `tokenFile` and the upstream-error log are
 * checked where the child reads them. Every manager writes into a per-test temporary
 * root; afterEach settles every session and proves no pane is left.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENV } from "../config.js";
import { UPSTREAM_ERROR_LOG_ENV } from "../handlers/shared/upstream-error-capture.js";
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
  `SessionCreateOptions passthroughs (${MAGMUX ? "magmux" : NO_MAGMUX_MESSAGE})`,
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

    /** The environment the pane child received, from its env_probe file. */
    async function childEnv(
      manager: SessionManager,
      sessionId: string
    ): Promise<Record<string, string>> {
      const path = probe.replace("{session}", manager.getSession(sessionId).claudeSessionId);
      await waitUntil(() => existsSync(path));
      return (JSON.parse(readFileSync(path, "utf-8")) as { env: Record<string, string> }).env;
    }

    test(
      "uses a caller-supplied sessionId verbatim",
      async () => {
        const manager = makeManager();
        const sessionId = await manager.createSession({
          model: "fake-answer",
          cwd: t.cwd,
          sessionId: "slot-07",
        });
        expect(sessionId).toBe("slot-07");
        expect(manager.getSession(sessionId).sessionId).toBe("slot-07");
        expect(manager.getSession(sessionId).pane).toContain("slot07");
      },
      T_PANE
    );

    test(
      "rejects reuse of a live caller-supplied sessionId",
      async () => {
        const manager = makeManager();
        const sessionId = "live-slot";
        await manager.createSession({ model: "first-model", cwd: t.cwd, sessionId });
        const originalPane = manager.getSession(sessionId).pane;

        await expect(
          manager.createSession({ model: "replacement-model", cwd: t.cwd, sessionId })
        ).rejects.toThrow(`Session id already in use: ${sessionId}`);
        expect(manager.getSession(sessionId).model).toBe("first-model");
        expect(manager.getSession(sessionId).pane).toBe(originalPane);
      },
      T_PANE
    );

    test(
      "writes artifacts to sessionDir instead of the manager sessionsDir",
      async () => {
        const manager = makeManager();
        const sessionId = "custom-artifacts";
        const sessionDir = join(t.tmp, "elsewhere", "slot-artifacts");
        const prompt = "keep this artifact in the requested directory";

        await manager.createSession({
          model: "contract-fake-model",
          cwd: t.cwd,
          sessionId,
          sessionDir,
          prompt: `${prompt} @@HANG@@`,
        });

        expect(readFileSync(join(sessionDir, "prompt.md"), "utf8")).toBe(`${prompt} @@HANG@@`);
        expect(existsSync(join(sessionDir, "spawn.json"))).toBe(true);
        expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
        expect(existsSync(join(sessionsDir, sessionId))).toBe(false);
      },
      T_PANE
    );

    test(
      "points the child token tracker at tokenFile and the upstream-error log into sessionDir",
      async () => {
        const manager = makeManager();
        const tokenFile = join(t.tmp, "accounting", "slot-03.json");
        const sessionDir = join(t.tmp, "elsewhere", "slot-03");
        const sessionId = await manager.createSession({
          model: "fake-env_probe",
          cwd: t.cwd,
          sessionDir,
          tokenFile,
        });

        const env = await childEnv(manager, sessionId);
        expect(env[ENV.CLAUDISH_TOKEN_FILE]).toBe(tokenFile);
        expect(env[UPSTREAM_ERROR_LOG_ENV]).toBe(join(sessionDir, "upstream-errors.jsonl"));
        expect(manager.getDiagnostics(sessionId).upstreamErrorLogPath).toBe(
          join(sessionDir, "upstream-errors.jsonl")
        );
      },
      T_PANE
    );

    test(
      "omitting the options keeps the random id and the artifact and token defaults",
      async () => {
        const manager = makeManager();
        const sessionId = await manager.createSession({ model: "fake-env_probe", cwd: t.cwd });

        const defaultSessionDir = join(sessionsDir, sessionId);
        expect(sessionId).toMatch(/^[0-9a-f]{8}$/);
        expect(manager.getDiagnostics(sessionId).sessionDir).toBe(defaultSessionDir);
        expect(existsSync(defaultSessionDir)).toBe(true);
        const env = await childEnv(manager, sessionId);
        expect(env[ENV.CLAUDISH_TOKEN_FILE]).toBe(join(defaultSessionDir, "tokens.json"));
        expect(env[UPSTREAM_ERROR_LOG_ENV]).toBe(join(defaultSessionDir, "upstream-errors.jsonl"));
      },
      T_PANE
    );
  }
);
