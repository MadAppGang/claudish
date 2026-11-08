import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../../config-override.js";
import {
  type AllowanceReport,
  allowanceReportSchema,
  allowanceStatusAnswerSchema,
} from "./allowance-report-schema.js";
import { AllowanceService, _setAllowanceServiceForTests } from "./allowance-service.js";
import {
  GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER,
  GOLDEN_ALLOWANCE_UNAVAILABLE_ANSWER,
  GOLDEN_ALLOWANCE_WARN_ANSWER,
} from "./allowance-status-golden.js";
import { _resetLedgerWriterForTests, flushUsageLedger } from "./ledger/ledger-writer.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";

const H = 3_600_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
let dir: string;
let config: string;
let accountsDir: string;
let oldAccounts: string | undefined;
let serial = 0;
type ConfigAccount = {
  id: string;
  label: string;
  store: string;
  addedAt: string;
  enabled?: boolean;
};
const account = (id: string): ConfigAccount => ({
  id,
  label: id,
  store: "file",
  addedAt: "2026-10-20T00:00:00Z",
});

function configure(accounts = [account(A), account(B)]) {
  writeFileSync(
    config,
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: { "openai-codex": { generation: 1, strategy: "sticky", accounts } },
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
function active(id?: string) {
  writeFileSync(
    join(accountsDir, "state.json"),
    JSON.stringify({
      version: 1,
      providers: { "openai-codex": { ...(id ? { active: id } : {}), accounts: {} } },
    })
  );
}
function window(usedFraction: number, resetAt: number) {
  return {
    key: "len:10080",
    slot: "secondary",
    lengthMinutes: 10080,
    usedFraction,
    resetAt,
    rejected: false,
    quantum: 0.01,
  };
}
function row(
  at: number,
  accountId: string,
  inTok: number,
  windows: ReturnType<typeof window>[] | null = null
) {
  return {
    v: 1,
    kind: "response",
    at,
    id: `test-${serial++}:0:${accountId}`,
    provider: "openai-codex",
    accountId,
    label: accountId === A ? "work" : "home",
    planClass: "pro",
    session: "11111111-aaaa-bbbb-cccc-123456789abc",
    model: "contract-model",
    reason: null,
    outcome: "ok",
    inTok,
    cacheReadTok: 0,
    cacheWriteTok: 0,
    outTok: 0,
    finalInTok: inTok,
    windows,
  };
}
function put(rows: ReturnType<typeof row>[]) {
  const days = new Map<string, ReturnType<typeof row>[]>();
  for (const r of rows) {
    const day = new Date(r.at).toISOString().slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), r]);
  }
  const raw = join(accountsDir, "usage/raw");
  mkdirSync(raw, { recursive: true });
  for (const [day, entries] of days)
    writeFileSync(
      join(raw, day + ".jsonl"),
      entries
        .sort((a, b) => a.at - b.at)
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      { mode: 0o600 }
    );
}
function seed(
  options: {
    ids?: string[];
    used?: number[];
    resetHours?: number[];
    rate?: number;
    calibrated?: boolean;
  } = {}
) {
  const {
    ids = [A, B],
    used = [0.1, 0.1],
    resetHours = [72, 96],
    rate = 100,
    calibrated = true,
  } = options;
  const rows: ReturnType<typeof row>[] = [];
  if (calibrated)
    for (const id of ids) {
      const start = T - 8 * 24 * H;
      for (const [hours, fraction, tokens] of [
        [0, 0.1, 0],
        [1, 0.22, 12e6],
        [3, 0.34, 12e6],
        [6, 0.46, 12e6],
      ]) {
        rows.push(row(start + hours! * H, id, tokens!, [window(fraction!, T - H)]));
      }
    }
  for (let i = 7 * 24; i > 0; i--) rows.push(row(T - i * H + H / 2, A, rate));
  for (const [i, id] of ids.entries())
    rows.push(row(T - H / 4, id, 0, [window(used[i]!, T + resetHours[i]! * H)]));
  put(rows);
}
async function report(horizonMs = 168 * H, seedAlerts = false) {
  const env = {
    HOME: dir,
    CLAUDE_CONFIG_DIR: join(dir, ".claude"),
    CLAUDISH_ACCOUNTS_DIR: accountsDir,
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
  };
  let now = seedAlerts ? T - H / 3 : T;
  const svc = new AllowanceService(env, () => now);
  if (seedAlerts) {
    await svc.evaluateAlerts("openai-codex");
    now = T;
    await svc.evaluateAlerts("openai-codex");
  }
  const raw = await svc.report("openai-codex", horizonMs);
  const parsed = allowanceReportSchema.parse(raw);
  expect(parsed.schema).toBe("claudish.allowance.v1");
  expect(parsed.accounts.filter((a) => a.active).length).toBeLessThanOrEqual(1);
  expect(parsed.accounts.every((a) => a.lambda === null)).toBe(true);
  for (const a of parsed.accounts)
    if (a.lostAtReset) {
      const lost = a.lostAtReset;
      expect(lost.p10).toBeGreaterThanOrEqual(0);
      expect(lost.p10).toBeLessThanOrEqual(lost.p50);
      expect(lost.p50).toBeLessThanOrEqual(lost.p90);
      expect(lost.p90).toBeLessThanOrEqual(1);
    }
  return parsed;
}
function assertAlertPace(r: AllowanceReport) {
  expect(r.alerts.length).toBeGreaterThan(0);
  expect(r.burn.long).toBeGreaterThan(0);
  expect(r.burn.sustainable!).toBeLessThan(r.burn.long!);
  const remedy = r.alerts[0]!.remedy;
  if (remedy.kind === "cut") {
    const expected = (remedy.cutToPercent! / 100) * r.burn.long!;
    expect(Math.abs(r.burn.sustainable! - expected)).toBeLessThanOrEqual(
      Math.max(Math.abs(expected), Number.MIN_VALUE) * 1e-9
    );
  } else expect(r.burn.sustainable).toBe(0);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "allowance-report-fields-"));
  config = join(dir, "config.json");
  accountsDir = join(dir, "accounts");
  mkdirSync(accountsDir);
  oldAccounts = process.env.CLAUDISH_ACCOUNTS_DIR;
  process.env.CLAUDISH_ACCOUNTS_DIR = accountsDir;
  setConfigFileOverride(config);
  configure();
});
afterEach(async () => {
  _setAllowanceServiceForTests(undefined);
  setAccountRegistryForTests(null);
  setConfigFileOverride(null);
  await flushUsageLedger();
  _resetLedgerWriterForTests();
  if (oldAccounts === undefined) delete process.env.CLAUDISH_ACCOUNTS_DIR;
  else process.env.CLAUDISH_ACCOUNTS_DIR = oldAccounts;
  rmSync(dir, { recursive: true, force: true });
});

describe("MTL-291 C-T2 active and account order", () => {
  test("C-T2.1,5,6 second configured account alone is active and lambda is uncomputed", async () => {
    active(B);
    const r = await report();
    expect(r.accounts.map((a) => a.active)).toEqual([false, true]);
    expect(r.accounts.every((a) => a.lambda === null)).toBe(true);
    expect(r.accounts.filter((a) => a.active)).toHaveLength(1);
  });
  test("C-T2.2,6 missing active state leaves every account inactive", async () => {
    active();
    expect((await report()).accounts.map((a) => a.active)).toEqual([false, false]);
  });
  for (const id of [B, "dddddddddddd"])
    test(`C-T2.3,4,6 disabled or absent active ${id} is not reported; order includes disabled entries`, async () => {
      configure([account(A), { ...account(B), enabled: false }, account(C)]);
      active(id);
      const r = await report();
      expect(r.accounts.map((a) => [a.id, a.order, a.active])).toEqual([
        [A, 0, false],
        [C, 2, false],
      ]);
      expect(r.accounts.every((a) => a.lambda === null)).toBe(true);
    });
});

describe("MTL-290 C-T1 sustainable pace", () => {
  test("C-T1.1 insufficient evidence has no sustainable pace", async () => {
    const r = await report();
    expect(r.status).toBe("insufficient-evidence");
    expect(r.burn.sustainable).toBeNull();
  });
  test("C-T1.2,5,6 calibrated light demand has a finite safe pace without an alert and is deterministic", async () => {
    seed();
    const r = await report();
    expect(r.status).toBe("ok");
    expect(r.unit).toBe("cu");
    expect(r.accounts.every((a) => a.calibration.beta === "calibrated")).toBe(true);
    expect(r.burn.long).toBeGreaterThan(0);
    expect(r.alerts).toEqual([]);
    expect(r.trajectory.blocked).toEqual([]);
    expect(Number.isFinite(r.burn.sustainable)).toBe(true);
    expect(r.burn.sustainable!).toBeGreaterThanOrEqual(r.burn.long!);
    expect((await report()).burn.sustainable).toBe(r.burn.sustainable);
  }, 30000);
  test("C-T1.3,7 top cut alert determines the safe pace in raw burn units", async () => {
    seed({ used: [0.8, 0.8], resetHours: [100, 120], rate: 1e6 });
    const r = await report(168 * H, true);
    expect(r.alerts[0]?.remedy.kind).toBe("cut");
    assertAlertPace(r);
    const levels = r.alerts.map((a) => a.level);
    expect(levels).toEqual([...levels].sort((a, b) => (a === b ? 0 : a === "critical" ? -1 : 1)));
  }, 30000);
  test("C-T1.4,7 a non-addressable external-use alert reports zero safe pace", async () => {
    seed({ used: [0.99, 0.99], resetHours: [100, 120], rate: 100 });
    // Large observed consumption without corresponding ledger tokens is external demand.
    const extra = [];
    for (const id of [A, B])
      for (let i = 0; i < 4; i++)
        extra.push(
          row(T - (4 - i) * H, id, 0, [window(0.1 + i * 0.29, T + (id === A ? 100 : 120) * H)])
        );
    // Preserve the seed's same-day readings while adding the external-use observations.
    const rawPath = join(
      accountsDir,
      "usage/raw",
      new Date(T - H).toISOString().slice(0, 10) + ".jsonl"
    );
    const existing: ReturnType<typeof row>[] = [];
    // Rewrite this day with steady demand, external observations, and the latest reading.
    for (let i = 24; i > 0; i--) existing.push(row(T - i * H + H / 2, A, 100));
    existing.push(
      ...extra,
      row(T - H / 4, A, 0, [window(0.99, T + 100 * H)]),
      row(T - H / 4, B, 0, [window(0.99, T + 120 * H)])
    );
    writeFileSync(
      rawPath,
      existing
        .sort((a, b) => a.at - b.at)
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      { mode: 0o600 }
    );
    const r = await report(168 * H, true);
    expect(["pause", "not-addressable"]).toContain(r.alerts[0]?.remedy.kind);
    assertAlertPace(r);
  }, 30000);
});

describe("MTL-292 C-T3 trajectory switches", () => {
  test("C-T3.1,2,3 a depleted active account hands over to the fresh account inside ordered quantile bounds", async () => {
    active(A);
    seed({ used: [0.97, 0.01], resetHours: [72, 96], rate: 1e6 });
    const r = await report();
    const switches = r.trajectory.switches!;
    expect(Array.isArray(switches)).toBe(true);
    expect(switches.find((s) => s.accountId === B)?.probability).toBeGreaterThanOrEqual(0.5);
    expect(new Set(switches.map((s) => s.accountId)).size).toBe(switches.length);
    expect(switches.map((s) => s.usual)).toEqual(switches.map((s) => s.usual).sort());
    for (const s of switches) {
      expect(r.accounts.map((a) => a.id)).toContain(s.accountId);
      expect(s.probability).toBeGreaterThanOrEqual(0.1);
      expect(Date.parse(s.soonest)).toBeGreaterThanOrEqual(Date.parse(r.generatedAt));
      expect(Date.parse(s.soonest)).toBeLessThanOrEqual(Date.parse(s.usual));
      expect(Date.parse(s.usual)).toBeLessThanOrEqual(Date.parse(s.latest));
      expect(Date.parse(s.latest)).toBeLessThanOrEqual(
        Date.parse(r.generatedAt) + r.horizonHours * H
      );
    }
  }, 30000);
  test("C-T3.4 a one-account pool has no switch", async () => {
    configure([account(A)]);
    seed({ ids: [A], used: [0.97], resetHours: [72], rate: 1e6 });
    expect((await report()).trajectory.switches).toEqual([]);
  }, 30000);
  test("C-T3.4 a short horizon excludes a takeover days away", async () => {
    active(A);
    seed({ used: [0.1, 0.01], resetHours: [144, 160], rate: 1e6 });
    expect((await report(H)).trajectory.switches).toEqual([]);
    expect((await report()).trajectory.switches!.some((s) => s.accountId === B)).toBe(true);
  }, 30000);
  test("C-T3.5 no evidence has no switches", async () => {
    const r = await report();
    expect(r.evidence).toBe("none");
    expect(r.trajectory.switches).toEqual([]);
  });
});

describe("MTL-293 C-T4 share lost at the governing reset", () => {
  test("C-T4.1,3,5 idle capacity expires unused at the same reset regardless of horizon", async () => {
    seed({ used: [0.1, 0.1], resetHours: [2, 2], rate: 0 });
    const short = await report(H);
    const long = await report(168 * H);
    for (const r of [short, long])
      for (const a of r.accounts) {
        expect(a.lostAtReset).not.toBeNull();
        expect(a.lostAtReset?.at).toBe(new Date(T + 2 * H).toISOString());
        expect(a.lostAtReset!.p50).toBeGreaterThanOrEqual(0.8);
        expect(a.lostAtReset!.p10).toBeGreaterThanOrEqual(0);
        expect(a.lostAtReset!.p10).toBeLessThanOrEqual(a.lostAtReset!.p50);
        expect(a.lostAtReset!.p50).toBeLessThanOrEqual(a.lostAtReset!.p90);
        expect(a.lostAtReset!.p90).toBeLessThanOrEqual(1);
      }
    expect(short.accounts.map((a) => a.lostAtReset?.at)).toEqual(
      long.accounts.map((a) => a.lostAtReset?.at)
    );
  }, 30000);
  test("C-T4.2,3 heavy demand exhausts the window before reset", async () => {
    configure([account(A)]);
    seed({ ids: [A], used: [0.99], resetHours: [72], rate: 1e6 });
    const lost = (await report()).accounts[0]!.lostAtReset!;
    expect(lost).not.toBeNull();
    expect(lost.p50).toBeLessThanOrEqual(0.05);
    expect(lost.p10).toBeGreaterThanOrEqual(0);
    expect(lost.p10).toBeLessThanOrEqual(lost.p50);
    expect(lost.p50).toBeLessThanOrEqual(lost.p90);
    expect(lost.p90).toBeLessThanOrEqual(1);
  }, 30000);
  test("C-T4.4 an unread account has no lost-at-reset estimate", async () => {
    seed({ ids: [A], used: [0.1], resetHours: [2] });
    const r = await report();
    expect(r.accounts.find((a) => a.id === B)?.windows).toEqual([]);
    expect(r.accounts.find((a) => a.id === B)?.lostAtReset).toBeNull();
  }, 30000);
});

describe("MTL-295 C-T6 per-account history", () => {
  test("C-T6.1,2,3 last-day series follow read-account order and sum to combined history", async () => {
    configure([account(B), account(A), account(C)]);
    seed();
    const r = await report();
    const series = r.trajectory.historyByAccount!;
    expect(series.map((s) => s.accountId)).toEqual([B, A]);
    let compared = 0;
    for (const s of series) {
      expect(s.history.length).toBeGreaterThan(0);
      expect(s.history.length).toBeLessThanOrEqual(25);
      for (const p of s.history)
        expect(Date.parse(p.at)).toBeGreaterThanOrEqual(Date.parse(r.generatedAt) - 24 * H);
    }
    for (const combined of r.trajectory.history) {
      const points = series.map((s) => s.history.find((p) => p.at === combined.at));
      if (!points.every((p) => p !== undefined)) continue;
      expect(
        Math.abs(points.reduce((sum, p) => sum + p!.remaining, 0) - combined.remaining)
      ).toBeLessThanOrEqual(1e-9);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  }, 30000);
  test("C-T6.4 no evidence has no per-account history", async () => {
    const r = await report();
    expect(r.evidence).toBe("none");
    expect(r.trajectory.historyByAccount).toEqual([]);
  });
});

describe("C-ALL additive v1 contract", () => {
  test("C-ALL.1,2 reports without the new fields still parse as v1", async () => {
    const r = await report();
    for (const a of r.accounts) {
      delete a.active;
      delete a.order;
      delete a.lostAtReset;
    }
    delete r.trajectory.switches;
    delete r.trajectory.historyByAccount;
    delete r.alertModel;
    for (const s of r.sessions) delete s.parent;
    expect(allowanceReportSchema.parse(r).schema).toBe("claudish.allowance.v1");
    const old = allowanceReportSchema.parse(
      structuredClone(GOLDEN_ALLOWANCE_WARN_ANSWER.allowance)
    );
    for (const a of old.accounts) {
      delete a.active;
      delete a.order;
      delete a.lostAtReset;
    }
    for (const s of old.sessions) delete s.parent;
    delete old.trajectory.switches;
    delete old.trajectory.historyByAccount;
    delete old.alertModel;
    allowanceReportSchema.parse(old);
  });
  test("C-ALL.3 golden MCP answers parse and the cut rate agrees with raw long burn", () => {
    for (const answer of [
      GOLDEN_ALLOWANCE_WARN_ANSWER,
      GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER,
      GOLDEN_ALLOWANCE_UNAVAILABLE_ANSWER,
    ])
      allowanceStatusAnswerSchema.parse(answer);
    const r = allowanceReportSchema.parse(GOLDEN_ALLOWANCE_WARN_ANSWER.allowance);
    expect(r.alerts[0]!.remedy.kind).toBe("cut");
    assertAlertPace(r);
  });
});
