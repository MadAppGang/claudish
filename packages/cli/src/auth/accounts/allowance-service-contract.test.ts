import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_USAGE_LINE, alertModelLine, renderForecast } from "../../account-forecast-render.js";
import { setConfigFileOverride } from "../../config-override.js";
import * as logger from "../../logger.js";
import { setStderrQuiet } from "../../logger.js";
import { allowanceReportSchema, allowanceStatusAnswerSchema } from "./allowance-report-schema.js";
import * as serviceApi from "./allowance-service.js";
import {
  GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER,
  GOLDEN_ALLOWANCE_UNAVAILABLE_ANSWER,
  GOLDEN_ALLOWANCE_WARN_ANSWER,
} from "./allowance-status-golden.js";
import * as modelApi from "./allowance/index.js";
import { candidatesToChooseRequest, threadKeyOf } from "./allowance/index.js";
import { validateRawConfig } from "./config-validation.js";
import * as locks from "./file-lock.js";
import { acquireFileLock } from "./file-lock.js";
import * as ledgerReader from "./ledger/ledger-reader.js";
import { buildResponseRow } from "./ledger/ledger-row.js";
import {
  _resetLedgerWriterForTests,
  appendUsageRow,
  flushUsageLedger,
} from "./ledger/ledger-writer.js";
import { AccountPool } from "./pool.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";
import { StateStore } from "./state-store.js";
import { type TokenStore, fingerprintOf } from "./token-store.js";
import { AllAccountsExhaustedError, type AllowanceSelectionHint } from "./types.js";

const M = { ...serviceApi };
const H = 3_600_000;
const MIN = 60_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
let dir = "";
let config = "";
let now = T;
let oldAccounts: string | undefined;
const accounts = [A, B].map((id, i) => ({
  id,
  label: i ? "home" : "work",
  store: "file",
  addedAt: "2026-10-20T00:00:00Z",
}));
function configure(strategy?: string, switchAt = 0.9) {
  writeFileSync(
    config,
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: {
        "openai-codex": { generation: 1, accounts, switchAt, ...(strategy ? { strategy } : {}) },
      },
    })
  );
  setAccountRegistryForTests(
    new AccountRegistry({
      configPath: () => config,
      legacyCodexPath: () => join(dir, "absent.json"),
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
    })
  );
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "allowance-service-contract-"));
  config = join(dir, "config.json");
  now = T;
  oldAccounts = process.env.CLAUDISH_ACCOUNTS_DIR;
  process.env.CLAUDISH_ACCOUNTS_DIR = join(dir, "accounts");
  setConfigFileOverride(config);
  configure();
});
afterEach(async () => {
  M._setAllowanceServiceForTests(undefined);
  setAccountRegistryForTests(null);
  setConfigFileOverride(null);
  await flushUsageLedger();
  _resetLedgerWriterForTests();
  if (oldAccounts === undefined) delete process.env.CLAUDISH_ACCOUNTS_DIR;
  else process.env.CLAUDISH_ACCOUNTS_DIR = oldAccounts;
  rmSync(dir, { recursive: true, force: true });
});
function pool() {
  const store: TokenStore = {
    kind: "file",
    read: async () => ({
      accessToken: "TEST_ACCESS",
      refreshToken: "TEST_REFRESH",
      expiresAt: T + H,
      generation: 1,
      fingerprint: fingerprintOf("TEST_REFRESH"),
      updatedAt: T,
    }),
    write: async () => {},
    delete: async () => {},
    describe: () => "isolated test store",
  };
  return new AccountPool("openai-codex", {
    now: () => now,
    state: new StateStore({
      path: join(dir, "state.json"),
      lockPath: join(dir, "state.lock"),
      now: () => now,
    }),
    storeFactory: () => store,
  });
}
function fakeService(ranker: serviceApi.AllowanceService["ranker"]) {
  const svc = new M.AllowanceService({ ...process.env }, () => now);
  svc.ranker = ranker;
  M._setAllowanceServiceForTests(svc);
  return svc;
}
describe("service and pool contracts", () => {
  test("C30 absent strategy never invokes the service or hint builder", async () => {
    let calls = 0;
    fakeService(() => {
      calls++;
      throw new Error("sticky must not rank");
    });
    const p = pool();
    const context = p.createSelectionContext(() => {
      calls++;
      return { sessionKey: "s", threadKey: "t", contextTokens: 1 };
    });
    expect(context.allowance).toBeUndefined();
    const first = await p.acquire({ selectionContext: context });
    expect(first.account.id).toBe(A);
    expect(calls).toBe(0);
    expect(existsSync(join(process.env.CLAUDISH_ACCOUNTS_DIR!, "usage"))).toBe(false);
  });
  test("C31b safeRanker catches service access failures before policy receives a rank", async () => {
    configure("lookahead");
    let calls = 0;
    fakeService(() => {
      calls++;
      throw new Error("service constructor failure");
    });
    const p = pool();
    expect(p.errorIfNoEligible()).toBeNull();
    expect(p.describe()).toBeDefined();
    const lease = await p.acquire();
    expect(lease.account.id).toBe(A);
    expect(calls).toBeGreaterThan(0);
    expect(M.safeRanker("openai-codex", null, { now: T })?.([])).toBeNull();
  });
  test("C31 a throwing decision declines and the request succeeds on sticky", async () => {
    configure("lookahead");
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    svc.decide = () => {
      throw new Error("decision unavailable");
    };
    M._setAllowanceServiceForTests(svc);
    expect((await pool().acquire()).account.id).toBe(A);
  });
  test("C32/F10 readers keep deployable strategies and treat unknown values as sticky", () => {
    for (const strategy of ["sticky", "ebr", "lookahead"] as const) {
      configure(strategy);
      expect(
        new AccountRegistry({
          configPath: () => config,
          legacyCodexPath: () => join(dir, "absent"),
        }).settingsFor("openai-codex").strategy
      ).toBe(strategy);
    }
    configure("fefo");
    // F10 changed the reader contract; strict validation remains a writer rule.
    const registry = new AccountRegistry({
      configPath: () => config,
      legacyCodexPath: () => join(dir, "absent"),
    });
    expect(registry.settingsFor("openai-codex").strategy).toBe("sticky");
    expect(registry.listAccounts("openai-codex").map((a) => a.id)).toEqual([A, B]);
  });
  test("C39/C40 pool uses the public mapping and thread state remains independent", async () => {
    configure("lookahead");
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    M._setAllowanceServiceForTests(svc);
    const seen: unknown[] = [];
    const hints: AllowanceSelectionHint[] = [];
    const decide = spyOn(svc, "decide").mockImplementation((_provider, req) => {
      seen.push(req);
      return { id: req.thread === "two" ? B : A, reason: "lookahead-initial" };
    });
    const p = pool();
    for (const thread of ["one", "two", "one", "two"]) {
      const hint = {
        sessionKey: "same-session",
        threadKey: thread,
        contextTokens: thread === "one" ? 200_000 : 20_000,
      };
      hints.push(hint);
      const context = p.createSelectionContext(() => hint);
      const lease = await p.acquire({ selectionContext: context });
      expect(lease.account.id).toBe(thread === "one" ? A : B);
    }
    const requests = seen as Parameters<serviceApi.AllowanceService["decide"]>[1][];
    expect(requests.filter((r) => r.thread === "one").at(-1)).toMatchObject({
      thread: "one",
      threadAccount: A,
      contextTokens: 200_000,
    });
    expect(requests.filter((r) => r.thread === "two").at(-1)).toMatchObject({
      thread: "two",
      threadAccount: B,
      contextTokens: 20_000,
    });
    const last = requests.at(-1)!;
    expect(last.session).toBe("same-session");
    expect(last.contextTokens).toBe(hints[3]!.contextTokens);
    const stored = existsSync(join(dir, "state.json"))
      ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))
      : {};
    expect(stored.providers?.["openai-codex"]?.active).toBeUndefined();
    decide.mockRestore();
  });
  test("C40 the pool rank closure and simulator mapping produce identical ChooseRequest data", async () => {
    configure("lookahead");
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    M._setAllowanceServiceForTests(svc);
    let expected: unknown;
    let observed: unknown;
    const original = svc.ranker.bind(svc);
    svc.ranker = (provider, hint, options) => {
      const rank = original(provider, hint, options);
      return (candidates) => {
        expected = candidatesToChooseRequest(candidates, options, {
          session: hint?.sessionKey ?? null,
          thread: hint?.threadKey ?? null,
          threadAccount: null,
          lastSwitchAt: null,
          contextTokens: hint?.contextTokens ?? null,
        });
        return rank(candidates);
      };
    };
    svc.decide = (_provider, request) => {
      observed = request;
      return { id: A, reason: "lookahead-initial" };
    };
    const p = pool();
    const hint = { sessionKey: "session", threadKey: "thread", contextTokens: 12345 };
    await p.acquire({ selectionContext: p.createSelectionContext(() => hint) });
    expect(observed).toEqual(expected);
    expect(observed).toMatchObject({ session: "session", thread: "thread", contextTokens: 12345 });
  });
  test("C39 thread hashes whole system and first message, but not later context", () => {
    const prefix = "shared".repeat(1500);
    const req = (system: string, first: string, tail = "") => ({
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prefix },
            { type: "text", text: first },
          ],
        },
        { role: "user", content: tail },
      ],
    });
    const original = threadKeyOf("s", req("system", "x"));
    expect(threadKeyOf("s", req("system", "x"))).toBe(original);
    expect(threadKeyOf("s", req("system", "y"))).not.toBe(original);
    expect(threadKeyOf("s", req("system-2", "x"))).not.toBe(original);
    expect(threadKeyOf("s", req("system", "x", "z".repeat(800_000)))).toBe(original);
    expect(threadKeyOf(null, req("system", "x"))).toBeNull();
    const large = M.allowanceHintOf("s", req("system", "x", "z".repeat(800_000)));
    const small = M.allowanceHintOf("s", req("system", "x", "z".repeat(80_000)));
    expect(large.threadKey).toBe(small.threadKey);
    expect(large.contextTokens!).toBeGreaterThan(small.contextTokens! + 170_000);
  });
  test("C34c notice wording, cleared transition and account pluralization", () => {
    const g = { kind: "7d" as const, start: T, end: T + 43 * H, lengthMs: 43 * H, binding: [] };
    const alert = {
      level: "warn" as const,
      raisedAt: T,
      episode: "test",
      gap: { atLongRate: g, atShortRate: g, start: null, end: null, lengthMs: null },
      pGap: 0.86,
      burn: { long: 1, short: 1, sustainable: 0.6 },
      remedy: { kind: "cut" as const, cutToFraction: 0.6, until: T + 43 * H, pauseMs: 14 * H },
    };
    const transition = { id: "id", level: "warn" as const, to: "raised" as const, at: T };
    const format = (at: number) => (at === T ? "Thu 14:00" : "Sat 09:00");
    expect(M.allowanceNotice("openai-codex", transition, alert, 2, format)).toBe(
      "Codex allowance: at the current rate both accounts are spent Thu 14:00 and blocked until Sat 09:00 (43 h). Cut to 60 % of current rate until Sat 09:00, or pause 14 h. `claudish account forecast`"
    );
    expect(M.allowanceNotice("openai-codex", { ...transition, to: "cleared" }, undefined, 2)).toBe(
      "Codex allowance: the projected gap has cleared."
    );
    expect(
      M.allowanceNotice("openai-codex", { ...transition, to: "deescalated" }, alert, 2)
    ).toBeNull();
    expect(M.allowanceNotice("openai-codex", transition, alert, 1, format)).toContain(
      "the account is"
    );
    expect(M.allowanceNotice("openai-codex", transition, alert, 3, format)).toContain(
      "all 3 accounts are"
    );
  });
  async function seedAlertLedger(usedFraction = 0.99) {
    for (let i = 7 * 24; i > 0; i--)
      appendUsageRow(
        buildResponseRow({
          provider: "openai-codex",
          requestId: "demand-" + i,
          attempt: 0,
          at: T - i * H + 30 * MIN,
          accountId: A,
          label: "work",
          planClass: "pro",
          session: "session-123",
          model: "contract-model",
          reason: undefined,
          outcome: "ok",
          tokens: { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 },
          finalInput: 1e6,
        })!
      );
    for (const [i, id] of [A, B].entries())
      appendUsageRow(
        buildResponseRow({
          provider: "openai-codex",
          requestId: "read-" + i,
          attempt: 0,
          at: T - 30 * MIN,
          accountId: id,
          label: i ? "home" : "work",
          planClass: "pro",
          session: null,
          model: "contract-model",
          reason: undefined,
          outcome: "ok",
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          finalInput: 0,
          usage: {
            observedAt: T - 30 * MIN,
            windows: [
              {
                slot: "primary",
                displayId: "7d",
                lengthMinutes: 10080,
                usedFraction,
                resetAt: T + (100 + i * 20) * H,
              },
            ],
          },
        })!
      );
    await flushUsageLedger();
  }
  test("C34 shared alert memory announces a transition only once across two services", async () => {
    await seedAlertLedger();
    now = T - 20 * MIN;
    const first = new M.AllowanceService({ ...process.env }, () => now);
    const second = new M.AllowanceService({ ...process.env }, () => now);
    await first.evaluateAlerts("openai-codex");
    await second.evaluateAlerts("openai-codex");
    now = T;
    const writes: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    let transitions: Awaited<ReturnType<serviceApi.AllowanceService["evaluateAlerts"]>>;
    try {
      transitions = [
        ...(await first.evaluateAlerts("openai-codex")),
        ...(await second.evaluateAlerts("openai-codex")),
      ];
    } finally {
      stderr.mockRestore();
    }
    expect(
      writes
        .join("")
        .split("\n")
        .filter((line) => line.includes("Codex allowance: at the current rate"))
    ).toHaveLength(transitions.filter((t) => t.to === "raised" || t.to === "escalated").length);
    expect(transitions.filter((t) => t.level === "warn" && t.to === "raised")).toHaveLength(1);
    const stored = JSON.parse(
      readFileSync(join(process.env.CLAUDISH_ACCOUNTS_DIR!, "allowance-alerts.json"), "utf8")
    );
    const ids = transitions.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(stored.providers["openai-codex"].announced).toContain(id);
  });
  test("C34b held alert lock skips publication and announces after release", async () => {
    await seedAlertLedger();
    const lock = await acquireFileLock(
      join(process.env.CLAUDISH_ACCOUNTS_DIR!, "allowance-alerts.lock"),
      { staleMs: 10000, timeoutMs: 0 }
    );
    expect(lock).not.toBeNull();
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    try {
      expect(await svc.evaluateAlerts("openai-codex")).toEqual([]);
      expect(existsSync(join(process.env.CLAUDISH_ACCOUNTS_DIR!, "allowance-alerts.json"))).toBe(
        false
      );
    } finally {
      await lock?.release();
    }
    await svc.evaluateAlerts("openai-codex");
    now += 20 * MIN;
    expect(
      (await svc.evaluateAlerts("openai-codex")).some(
        (t) => t.level === "warn" && t.to === "raised"
      )
    ).toBe(true);
  });
  test("C34 quiet stderr suppresses notices without suppressing persisted transitions", async () => {
    await seedAlertLedger();
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    await svc.evaluateAlerts("openai-codex");
    now += 20 * MIN;
    const writes: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    setStderrQuiet(true);
    try {
      expect(
        (await svc.evaluateAlerts("openai-codex")).some(
          (t) => t.level === "warn" && t.to === "raised"
        )
      ).toBe(true);
      expect(writes.join("")).not.toContain("Codex allowance:");
    } finally {
      setStderrQuiet(false);
      stderr.mockRestore();
    }
    const persisted = JSON.parse(
      readFileSync(join(process.env.CLAUDISH_ACCOUNTS_DIR!, "allowance-alerts.json"), "utf8")
    );
    expect(persisted.providers["openai-codex"].announced.length).toBeGreaterThan(0);
  });
  test("F1 report shows raised alerts without consuming a separate process's announcement", async () => {
    await seedAlertLedger();
    now = T - 20 * MIN;
    const first = new M.AllowanceService({ ...process.env }, () => now);
    await first.evaluateAlerts("openai-codex");
    const path = join(process.env.CLAUDISH_ACCOUNTS_DIR!, "allowance-alerts.json");
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    now = T;
    const labels: unknown[] = [];
    first.attachLabelSink("openai-codex", { setAllowanceLabel: (v) => labels.push(v) });
    labels.length = 0;
    const writes: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const report = await first.report("openai-codex", 24 * H);
      expect(report.alerts.some((a) => a.level === "warn")).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(statSync(path).mtimeMs).toBe(mtime);
      expect(labels).toEqual([]);
      expect(writes.join("")).not.toContain("Codex allowance:");
      const program = `
        const { setConfigFileOverride } = await import(${JSON.stringify(new URL("../../config-override.ts", import.meta.url).href)});
        setConfigFileOverride(${JSON.stringify(config)});
        const { AllowanceService } = await import(${JSON.stringify(new URL("./allowance-service.ts", import.meta.url).href)});
        const svc = new AllowanceService(process.env, () => ${now});
        console.log(JSON.stringify(await svc.evaluateAlerts("openai-codex")));
      `;
      const child = Bun.spawn([process.execPath, "-e", program], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      const won = JSON.parse(await stdout) as Awaited<
        ReturnType<serviceApi.AllowanceService["evaluateAlerts"]>
      >;
      expect(won.filter((t) => t.level === "warn" && t.to === "raised")).toHaveLength(1);
      expect(await errors).toContain("Codex allowance:");
      expect(writes.join("")).not.toContain("Codex allowance:");
    } finally {
      stderr.mockRestore();
    }
  });

  test("F3 two overlapping requests gate first load and later tail refresh", async () => {
    configure("ebr");
    await seedAlertLedger();
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    const originalRead = ledgerReader.readLedger;
    const originalTail = ledgerReader.createLedgerTail;
    let reads = 0;
    let tails = 0;
    const readSpy = spyOn(ledgerReader, "readLedger").mockImplementation((opts) => {
      reads++;
      return originalRead(opts);
    });
    const tailSpy = spyOn(ledgerReader, "createLedgerTail").mockImplementation((opts) => {
      const tail = originalTail(opts);
      return {
        offsets: () => tail.offsets(),
        tail: () => {
          tails++;
          return tail.tail();
        },
      };
    });
    const releaseA = svc.requestStarted();
    const releaseB = svc.requestStarted();
    try {
      releaseA();
      releaseA(); // Idempotence must not release B.
      svc.requestSettled("openai-codex");
      await Bun.sleep(1100);
      await svc.settled("openai-codex");
      expect(reads).toBe(0);
      expect(tails).toBe(0);
      expect(svc.idle()).toBe(false);
      expect(
        svc.decide("openai-codex", {
          now,
          session: null,
          thread: null,
          threadAccount: null,
          poolActive: A,
          lastSwitchAt: null,
          contextTokens: 0,
          eligible: [
            {
              id: A,
              order: 0,
              usageFailed: false,
              overThreshold: false,
              snapshot: null,
              snapshotAt: null,
            },
          ],
        })
      ).toBeNull();
      releaseB();
      svc.requestSettled("openai-codex");
      await Bun.sleep(1100);
      await svc.settled("openai-codex");
      expect(reads).toBeGreaterThan(0);
      const before = tails;
      const releaseC = svc.requestStarted();
      try {
        now += 2 * MIN;
        await svc.evaluateAlerts("openai-codex");
        expect(tails).toBe(before);
      } finally {
        releaseC();
      }
      svc.requestSettled("openai-codex");
      await svc.settled("openai-codex");
      expect(tails).toBeGreaterThan(before);
    } finally {
      releaseA();
      releaseB();
      readSpy.mockRestore();
      tailSpy.mockRestore();
    }
  }, 15000);

  test("F4 a stolen alert lock cannot overwrite its successor's memory", async () => {
    await seedAlertLedger();
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    await svc.evaluateAlerts("openai-codex");
    now += 20 * MIN;
    const memoryPath = join(process.env.CLAUDISH_ACCOUNTS_DIR!, "allowance-alerts.json");
    const before = readFileSync(memoryPath, "utf8");
    const originalAcquire = locks.acquireFileLock;
    let stolen = false;
    const fence = spyOn(locks, "acquireFileLock").mockImplementation(async (path, opts) => {
      const handle = await originalAcquire(path, opts);
      if (path.endsWith("allowance-alerts.lock") && !stolen) {
        stolen = true;
        const holder = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...holder, nonce: "successor" }));
      }
      return handle;
    });
    try {
      expect(await svc.evaluateAlerts("openai-codex")).toEqual([]);
      expect(stolen).toBe(true);
      expect(readFileSync(memoryPath, "utf8")).toBe(before);
    } finally {
      fence.mockRestore();
    }
  });

  test("F4 changed shared memory retries sliced evaluation outside the lock", async () => {
    await seedAlertLedger();
    now = T - 20 * MIN;
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    const peer = new M.AllowanceService({ ...process.env }, () => now);
    await svc.evaluateAlerts("openai-codex");
    now = T;
    const originalAcquire = locks.acquireFileLock;
    const originalImmediate = globalThis.setImmediate;
    let peerRunning = false;
    let moved = false;
    let ticks = 0;
    const acquisitionTicks: number[] = [];
    const lockPath = join(process.env.CLAUDISH_ACCOUNTS_DIR!, "allowance-alerts.lock");
    const originalSliced = modelApi.alertsSliced;
    const originalSync = modelApi.alerts;
    const evaluationUnderLock: boolean[] = [];
    let slicedCalls = 0;
    let syncCalls = 0;
    const sliced = spyOn(modelApi, "alertsSliced").mockImplementation((...args) => {
      slicedCalls++;
      const generator = originalSliced(...args);
      return (function* () {
        for (;;) {
          evaluationUnderLock.push(existsSync(lockPath));
          const next = generator.next();
          if (next.done) return next.value;
          yield next.value;
        }
      })();
    });
    const sync = spyOn(modelApi, "alerts").mockImplementation((...args) => {
      syncCalls++;
      evaluationUnderLock.push(existsSync(lockPath));
      return originalSync(...args);
    });
    const immediate = spyOn(globalThis, "setImmediate").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ...args: unknown[]
    ) =>
      originalImmediate(() => {
        ticks++;
        fn(...args);
      })) as typeof setImmediate);
    const acquire = spyOn(locks, "acquireFileLock").mockImplementation(async (path, opts) => {
      if (path.endsWith("allowance-alerts.lock") && !peerRunning) {
        if (!moved) {
          moved = true;
          peerRunning = true;
          try {
            const won = await peer.evaluateAlerts("openai-codex");
            expect(won.some((t) => t.level === "warn" && t.to === "raised")).toBe(true);
          } finally {
            peerRunning = false;
          }
        }
        acquisitionTicks.push(ticks);
      }
      return originalAcquire(path, opts);
    });
    try {
      expect(await svc.evaluateAlerts("openai-codex")).toEqual([]);
      expect(acquisitionTicks.length).toBeGreaterThanOrEqual(2);
      // Cached payloads may need zero new simulations: do not require artificial yields.
      expect(slicedCalls).toBeGreaterThanOrEqual(3); // First, peer, fresh-memory retry.
      expect(syncCalls).toBe(0);
      expect(evaluationUnderLock.length).toBeGreaterThan(0);
      expect(evaluationUnderLock.some(Boolean)).toBe(false);
    } finally {
      acquire.mockRestore();
      immediate.mockRestore();
      sliced.mockRestore();
      sync.mockRestore();
    }
  });

  test("F5 no fresh lookahead plan declines to the pool's live switchAt", async () => {
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    await svc.report("openai-codex", H); // Loaded while sticky.
    configure("lookahead", 0.5); // Must be read on this call, not the next refresh.
    M._setAllowanceServiceForTests(svc);
    const usage = (u: number) => ({
      observedAt: now,
      windows: [
        {
          slot: "primary",
          displayId: "7d",
          lengthMinutes: 10080,
          usedFraction: u,
          resetAt: now + 100 * H,
        },
      ],
    });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "openai-codex": {
            active: A,
            accounts: { [A]: { usage: usage(0.6) }, [B]: { usage: usage(0.1) } },
          },
        },
      })
    );
    const request = {
      now,
      session: null,
      thread: null,
      threadAccount: null,
      lastSwitchAt: null,
      poolActive: A,
      contextTokens: 0,
      eligible: [A, B].map((id, order) => ({
        id,
        order,
        usageFailed: false,
        overThreshold: id === A,
        snapshot: null,
        snapshotAt: null,
      })),
    };
    expect(svc.decide("openai-codex", request)).toBeNull();
    const lines: string[] = [];
    const logged = spyOn(logger, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const lease = await pool().acquire();
      expect(lease.account.id).toBe(B);
      expect(["sticky", "first-under-threshold"]).toContain(lease.reason);
      expect(lines.join("\n")).toContain("allowance model reverted to sticky (rank declined)");
    } finally {
      logged.mockRestore();
    }
    configure("ebr", 0.5);
    const ebr = svc.decide("openai-codex", request);
    expect(ebr).not.toBeNull();
    expect(ebr!.reason).toStartWith("ebr-");
    configure("sticky", 0.5);
    expect(svc.decide("openai-codex", request)).toBeNull();
  });

  test("F9 pinned exhausted account does not record a pool-wide outage", async () => {
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    M._setAllowanceServiceForTests(svc);
    const recorded = spyOn(svc, "recordNoEligible");
    const p = pool();
    const refA = { provider: "openai-codex" as const, id: A, label: "work" };
    const refB = { provider: "openai-codex" as const, id: B, label: "home" };
    try {
      await p.report(refA, { kind: "quota", resetAt: now + H, estimated: false });
      expect(p.observationState(refA).exhaustedUntil).toBe(now + H);
      // A pin forces re-signing even when the account is exhausted.
      const pinned = await p.acquire({ pin: refA });
      expect(pinned.account.id).toBe(A);
      await flushUsageLedger();
      expect(recorded).not.toHaveBeenCalled();
      expect(existsSync(join(process.env.CLAUDISH_ACCOUNTS_DIR!, "usage"))).toBe(false);
      await p.report(refB, { kind: "quota", resetAt: now + H, estimated: false });
      await expect(p.acquire()).rejects.toBeInstanceOf(AllAccountsExhaustedError);
      expect(recorded).toHaveBeenCalledTimes(1);
    } finally {
      recorded.mockRestore();
    }
  });

  test("F10 typo strategy serves on sticky but writers still reject the raw block", async () => {
    configure("EBR");
    const lines: string[] = [];
    const logged = spyOn(logger, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      expect((await pool().acquire()).account.id).toBe(A);
      expect((await pool().acquire()).account.id).toBe(A);
      expect(lines.filter((line) => line.includes('unknown strategy "EBR"'))).toHaveLength(1);
      expect(() => validateRawConfig(JSON.parse(readFileSync(config, "utf8")))).toThrow();
      // The reader must not repair the saved value behind the writer's back.
      expect(
        JSON.parse(readFileSync(config, "utf8")).subscriptionAccounts["openai-codex"].strategy
      ).toBe("EBR");
    } finally {
      logged.mockRestore();
    }
  });

  test("F15 a never-seen thread uses the fresh pool plan without a stale decision", async () => {
    configure("lookahead");
    await seedAlertLedger(0.2);
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    await svc.evaluateAlerts("openai-codex");
    const request = {
      now,
      session: null,
      thread: null,
      threadAccount: null,
      poolActive: null,
      lastSwitchAt: null,
      contextTokens: null,
      eligible: [A, B].map((id, order) => ({
        id,
        order,
        usageFailed: false,
        overThreshold: false,
        snapshot: null,
        snapshotAt: null,
      })),
    };
    svc.decide("openai-codex", request);
    svc.record({
      requestId: "fresh-plan",
      attempt: 0,
      at: now,
      account: { provider: "openai-codex", id: A, label: "work" },
      planClass: "pro",
      session: null,
      model: "contract-model",
      reason: undefined,
      outcome: "ok",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      finalInput: 0,
    });
    svc.requestSettled("openai-codex");
    await svc.settled("openai-codex");
    const before = svc.staleDecisions("openai-codex");
    const poolPick = svc.decide("openai-codex", request);
    expect(poolPick).not.toBeNull();
    expect(svc.decide("openai-codex", { ...request, thread: "never-seen" })).toEqual(poolPick);
    expect(svc.staleDecisions("openai-codex")).toBe(before);
  });

  test("L1 service forecast work yields between slices and preserves the pure result", async () => {
    await seedAlertLedger(0.2);
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    const original = modelApi.forecastSliced;
    const originalImmediate = globalThis.setImmediate;
    let ticks = 0;
    const completed: {
      ticks: number;
      args: Parameters<typeof modelApi.forecastSliced>;
      value: ReturnType<typeof modelApi.forecast>;
    }[] = [];
    const immediate = spyOn(globalThis, "setImmediate").mockImplementation(((
      fn: (...args: unknown[]) => void,
      ...args: unknown[]
    ) =>
      originalImmediate(() => {
        ticks++;
        fn(...args);
      })) as typeof setImmediate);
    const sliced = spyOn(modelApi, "forecastSliced").mockImplementation((...args) => {
      const start = ticks;
      const generator = original(...args);
      return (function* () {
        for (;;) {
          const next = generator.next();
          if (next.done) {
            if (next.value.paths === 1000) {
              completed.push({ ticks: ticks - start, args, value: next.value });
            }
            return next.value;
          }
          yield next.value;
        }
      })();
    });
    try {
      await svc.report("openai-codex", H);
      now += H;
      await svc.report("openai-codex", H);
    } finally {
      sliced.mockRestore();
      immediate.mockRestore();
    }
    expect(completed.length).toBeGreaterThanOrEqual(2);
    for (const run of completed) {
      expect(run.ticks).toBeGreaterThanOrEqual(10);
      expect(run.value).toEqual(modelApi.forecast(...run.args));
    }
  });

  test("L5 detached label sinks stop receiving evaluations and reattach to the current label", async () => {
    await seedAlertLedger();
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    await svc.evaluateAlerts("openai-codex");
    const labels: unknown[] = [];
    const sink = { setAllowanceLabel: (label: unknown) => labels.push(label) };
    svc.attachLabelSink("openai-codex", sink);
    expect(labels).toHaveLength(1);
    svc.detachLabelSink(sink);
    labels.length = 0;
    now += MIN;
    await svc.evaluateAlerts("openai-codex");
    expect(svc.labelFor("openai-codex")).toBeDefined();
    expect(labels).toEqual([]);
    svc.attachLabelSink("openai-codex", sink);
    expect(labels).toEqual([svc.labelFor("openai-codex")]);
    svc.detachLabelSink(sink);
  });

  test("L6 pending drops the oldest 904 of 5000 rows with one warning, retaining ledger recovery", async () => {
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    const lines: string[] = [];
    const logged = spyOn(logger, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    const originalSliced = modelApi.forecastSliced;
    const states: Parameters<typeof modelApi.forecastSliced>[0][] = [];
    const captured = spyOn(modelApi, "forecastSliced").mockImplementation((...args) => {
      states.push(structuredClone(args[0]));
      return originalSliced(...args);
    });
    let read: ReturnType<typeof spyOn> | undefined;
    try {
      for (let i = 0; i < 5000; i++) {
        svc.recordNoEligible("openai-codex", T - 5000 + i);
        // Avoid the independent ledger writer's 1024-row limit.
        if (i % 128 === 127) await flushUsageLedger();
      }
      await flushUsageLedger();
      expect(
        lines.filter((line) =>
          line.includes("the fold buffer is full (4096 rows); the oldest are dropped")
        )
      ).toHaveLength(1);
      const rows = await ledgerReader.readLedger({ sinceMs: T - H, env: { ...process.env } });
      expect(rows.rows).toHaveLength(5000);
      // Withhold the disk replay once, so only the bounded buffer can supply events.
      read = spyOn(ledgerReader, "readLedger").mockResolvedValue({ rows: [], skipped: 0 });
      await svc.report("openai-codex", H);
      expect(states.length).toBeGreaterThan(0);
      expect(states.at(-1)!.censorOpenAt).toBe(T - 4096);
      read.mockRestore();
      read = undefined;
      states.length = 0;
      const recovered = new M.AllowanceService({ ...process.env }, () => now);
      await recovered.report("openai-codex", H);
      expect(states.at(-1)!.censorOpenAt).toBe(T - 5000);
      const events = rows.rows
        .filter((row) => row.kind === "no-eligible")
        .map((row) => ({ kind: "no-eligible" as const, at: row.at }));
      const expected = modelApi.observeAll(
        modelApi.initialState(),
        events,
        modelApi.DEFAULT_ALLOWANCE_CONFIG
      );
      expect(states.at(-1)!.demand).toEqual(expected.demand);
      expect(states.at(-1)!.lastAt).toBe(now); // The registry accounts event is stamped at load time.
    } finally {
      read?.mockRestore();
      captured.mockRestore();
      logged.mockRestore();
    }
  }, 15000);

  test("L6 failed loads back off across direct evaluations and response-settled arming", async () => {
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    const failed = spyOn(ledgerReader, "readLedger").mockRejectedValue(
      new Error("test load failure")
    );
    const logged = spyOn(logger, "log").mockImplementation(() => {});
    try {
      await svc.evaluateAlerts("openai-codex");
      const first = failed.mock.calls.length;
      expect(first).toBeGreaterThan(0);
      now = T + 30_000;
      await svc.evaluateAlerts("openai-codex");
      svc.requestSettled("openai-codex");
      await Bun.sleep(1100);
      await svc.settled("openai-codex");
      expect(failed).toHaveBeenCalledTimes(first);
      now = T + 61_000;
      svc.requestSettled("openai-codex");
      await Bun.sleep(1100);
      await svc.settled("openai-codex");
      expect(failed.mock.calls.length).toBeGreaterThan(first);
      const second = failed.mock.calls.length;
      now = T + 180_000;
      await svc.evaluateAlerts("openai-codex");
      expect(failed).toHaveBeenCalledTimes(second);
      now = T + 182_000;
      await svc.evaluateAlerts("openai-codex");
      expect(failed.mock.calls.length).toBeGreaterThan(second);
      for (const delay of [240, 480, 960, 1920, 3600, 3600]) {
        const before = failed.mock.calls.length;
        now += delay * 1000 - 1;
        await svc.evaluateAlerts("openai-codex");
        expect(failed).toHaveBeenCalledTimes(before);
        now += 2;
        await svc.evaluateAlerts("openai-codex");
        expect(failed.mock.calls.length).toBeGreaterThan(before);
      }
    } finally {
      failed.mockRestore();
      logged.mockRestore();
    }
  }, 10000);

  test("C35 service report on no evidence validates and renders the no-usage line", async () => {
    const svc = new M.AllowanceService({ ...process.env }, () => now);
    const report = await svc.report("openai-codex", 36 * H);
    expect(allowanceReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      status: "insufficient-evidence",
      horizonHours: 36,
      alerts: [],
      sessions: [],
      forecastAt: null,
    });
    expect(renderForecast(report)).toEqual([NO_USAGE_LINE]);
  });
});

describe("schema and forecast surfaces", () => {
  test("golden MCP answers and reports validate without full session ids", () => {
    for (const answer of [
      GOLDEN_ALLOWANCE_WARN_ANSWER,
      GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER,
      GOLDEN_ALLOWANCE_UNAVAILABLE_ANSWER,
    ])
      expect(allowanceStatusAnswerSchema.safeParse(answer).success).toBe(true);
    const report = structuredClone(GOLDEN_ALLOWANCE_WARN_ANSWER.allowance);
    expect(allowanceReportSchema.safeParse({ ...report, generatedAt: 123 }).success).toBe(false);
    report.sessions[0]!.session = "full-session-id-not-public";
    expect(allowanceReportSchema.safeParse(report).success).toBe(false);
  });
  test("lookahead alert-model disclosure is exact and limited to lookahead", () => {
    const report = allowanceReportSchema.parse(GOLDEN_ALLOWANCE_WARN_ANSWER.allowance);
    expect(renderForecast(report)[1]).toBe("alerts simulate ebr (lookahead alert model pending)");
    expect(alertModelLine("ebr")).toBeNull();
    expect(alertModelLine("sticky")).toBeNull();
    expect(
      renderForecast({ ...report, strategy: "ebr" }).some((l) => l.includes("alerts simulate"))
    ).toBe(false);
    expect(renderForecast(GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER.allowance)).toEqual([NO_USAGE_LINE]);
  });
  test("C35 renderer displays gap quantiles, remedy and unattributed row", () => {
    const lines = renderForecast(
      allowanceReportSchema.parse(GOLDEN_ALLOWANCE_WARN_ANSWER.allowance)
    );
    expect(lines.some((l) => l.includes("(43 h, p10–p90 31–55 h) · p(gap) 0.86"))).toBe(true);
    expect(
      lines.some((l) => l.includes("cut to 60 % of current rate until Sat 09:00, or pause 14 h"))
    ).toBe(true);
    expect(lines.at(-1)).toContain("unattributed");
    expect(lines.at(-1)).toContain("Codex CLI / ChatGPT app");
  });
});
