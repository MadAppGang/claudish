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
import { _resetLedgerWriterForTests, flushUsageLedger } from "./ledger/ledger-writer.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";

const H = 3_600_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
let dir: string;
let config: string;
let accountsDir: string;
let oldAccounts: string | undefined;
let serial = 0;

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
function seed(used = [0.97, 0.01], resetHours = [72, 96], rate = 1e6) {
  const rows: ReturnType<typeof row>[] = [];
  for (const id of [A, B]) {
    const start = T - 8 * 24 * H;
    for (const [hours, fraction, tokens] of [
      [0, 0.1, 0],
      [1, 0.22, 12e6],
      [3, 0.34, 12e6],
      [6, 0.46, 12e6],
    ])
      rows.push(row(start + hours! * H, id, tokens!, [window(fraction!, T - H)]));
  }
  for (let i = 7 * 24; i > 0; i--) rows.push(row(T - i * H + H / 2, A, rate));
  for (const [i, id] of [A, B].entries())
    rows.push(row(T - H / 4, id, 0, [window(used[i]!, T + resetHours[i]! * H)]));
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
async function report() {
  const svc = new AllowanceService(
    {
      HOME: dir,
      CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      CLAUDISH_ACCOUNTS_DIR: accountsDir,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    },
    () => T
  );
  return allowanceReportSchema.parse(await svc.report("openai-codex", 168 * H));
}
function switches(r: AllowanceReport) {
  expect(r.trajectory.switches!.length).toBeGreaterThan(0);
  expect(r.trajectory.switches!.some((s) => s.accountId === B)).toBe(true);
  return r.trajectory.switches!;
}
function likelihood(s: NonNullable<AllowanceReport["trajectory"]["switches"]>[number]) {
  expect(s.likelihood).toBeDefined();
  return s.likelihood!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "allowance-switch-likelihood-"));
  config = join(dir, "config.json");
  accountsDir = join(dir, "accounts");
  mkdirSync(accountsDir);
  oldAccounts = process.env.CLAUDISH_ACCOUNTS_DIR;
  process.env.CLAUDISH_ACCOUNTS_DIR = accountsDir;
  setConfigFileOverride(config);
  writeFileSync(
    config,
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: {
        "openai-codex": {
          generation: 1,
          strategy: "sticky",
          accounts: [A, B].map((id) => ({
            id,
            label: id,
            store: "file",
            addedAt: "2026-10-20T00:00:00Z",
          })),
        },
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
  writeFileSync(
    join(accountsDir, "state.json"),
    JSON.stringify({
      version: 1,
      providers: { "openai-codex": { active: A, accounts: {} } },
    })
  );
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

describe("MTL-299 switch likelihood black-box contract", () => {
  test("L1 each takeover has a peak-normalised hourly curve with at most three decimals", async () => {
    seed();
    for (const s of switches(await report())) {
      const curve = likelihood(s);
      expect(curve.stepHours).toBe(1);
      expect(curve.p.length).toBeGreaterThan(0);
      expect(Math.max(...curve.p)).toBe(1);
      for (const p of curve.p) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
        expect(p).toBe(Number(p.toFixed(3)));
      }
    }
  }, 30000);

  test("L2 curve starts on the hourly forecast grid within the horizon", async () => {
    seed();
    const r = await report();
    expect(r.trajectory.forecast.length).toBeGreaterThan(0);
    const first = Date.parse(r.trajectory.forecast[0]!.at);
    for (const s of switches(r)) {
      const start = Date.parse(likelihood(s).start);
      expect(Number.isFinite(start)).toBe(true);
      expect(start % H).toBe(0);
      expect((start - first) % H).toBe(0);
      expect(start).toBeGreaterThanOrEqual(first);
      expect(start).toBeLessThanOrEqual(first + r.horizonHours * H);
    }
  }, 30000);

  test("L3 leading and trailing zero tails are trimmed", async () => {
    seed();
    for (const s of switches(await report())) {
      const { p } = likelihood(s);
      expect(p[0]).toBeGreaterThan(0);
      expect(p[p.length - 1]).toBeGreaterThan(0);
    }
  }, 30000);

  test("L4 first peak falls inside its own switch window with one-hour tolerance", async () => {
    seed();
    for (const s of switches(await report())) {
      const { start, p } = likelihood(s);
      const index = p.indexOf(1);
      expect(index).toBeGreaterThanOrEqual(0);
      const peak = Date.parse(start) + index * H;
      expect(peak).toBeGreaterThanOrEqual(Date.parse(s.soonest) - H);
      expect(peak).toBeLessThanOrEqual(Date.parse(s.latest) + H);
    }
  }, 30000);

  test("L5 tight reset takeover uses counts with no smoothed early tail", async () => {
    seed([0.97, 1], [72, 24]);
    const s = switches(await report()).find((s) => s.accountId === B)!;
    expect(s.soonest).toBe(s.latest);
    expect(Date.parse(s.soonest)).toBe(T + 24 * H);
    const { start, p } = likelihood(s);
    const hour = Math.floor(Date.parse(s.soonest) / H) * H;
    expect(Date.parse(start) + p.indexOf(1) * H).toBe(hour);
    const early = p.reduce(
      (sum, value, i) => sum + (Date.parse(start) + i * H < hour ? value : 0),
      0
    );
    expect(early).toBeLessThanOrEqual(0.125);
  }, 30000);

  test("L6 reports validate with likelihood present or omitted", async () => {
    seed();
    const r = await report();
    for (const s of switches(r)) likelihood(s);
    expect(allowanceReportSchema.safeParse(r).success).toBe(true);
    for (const s of r.trajectory.switches!) delete s.likelihood;
    expect(allowanceReportSchema.safeParse(r).success).toBe(true);
  }, 30000);

  test("L6 schema rejects stepHours 2, probabilities above 1, and empty curves", async () => {
    seed();
    const r = await report();
    switches(r);
    for (const invalid of [{ stepHours: 2 }, { p: [1.001] }, { p: [] }]) {
      const changed = structuredClone(r);
      const s = changed.trajectory.switches![0]!;
      s.likelihood = { ...likelihood(s), ...invalid } as typeof s.likelihood;
      expect(allowanceReportSchema.safeParse(changed).success).toBe(false);
    }
  }, 30000);

  test("L7 schema preserves likelihood in a trajectory-only MCP answer", async () => {
    seed();
    const r = await report();
    for (const s of switches(r)) likelihood(s);
    const { accounts, alerts, burn, combined, sessions, ...partial } = r;
    const answer = allowanceStatusAnswerSchema.parse({
      contract_version: 1,
      capabilities: ["allowance"],
      sections: ["trajectory"],
      allowance: partial,
    });
    expect(answer.allowance!.trajectory!.switches).toEqual(r.trajectory.switches);
  }, 30000);
});
