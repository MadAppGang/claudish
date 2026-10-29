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
import baseline from "./allowance-slower-scenario.baseline.json";
import { DEFAULT_ALLOWANCE_CONFIG, SLOWER_FACTOR } from "./allowance/constants.js";
import { simulate } from "./allowance/simulate.js";
import { sticky } from "./allowance/strategies/sticky.js";
import type { AccountView, ViewWindow } from "./allowance/types.js";
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
  const raw = await svc.report("openai-codex", 168 * H);
  expect(allowanceReportSchema.safeParse(raw).success).toBe(true);
  return allowanceReportSchema.parse(raw);
}
function slower(r: AllowanceReport) {
  expect(r.trajectory.slower).toBeDefined();
  return r.trajectory.slower!;
}
function assertBlocked(r: AllowanceReport) {
  const current = r.trajectory.blocked;
  const reduced = slower(r).blocked;
  expect(reduced.reduce((sum, b) => sum + b.probability, 0)).toBeLessThanOrEqual(
    current.reduce((sum, b) => sum + b.probability, 0) + 0.05
  );
  if (current.length === 0) expect(reduced).toEqual([]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "allowance-slower-scenario-"));
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

describe("MTL-298 slower scenario black-box contract", () => {
  test("C1 current reports include slower and older v1 reports may omit it", async () => {
    seed();
    const r = await report();
    slower(r);
    delete r.trajectory.slower;
    expect(allowanceReportSchema.safeParse(r).success).toBe(true);
  }, 30000);

  test("C2 slower factor equals 0.667 and is strictly between zero and one", async () => {
    seed();
    const r = await report();
    expect(slower(r).factor).toBe(0.667);
    expect(slower(r).factor).toBeGreaterThan(0);
    expect(slower(r).factor).toBeLessThan(1);
    for (const factor of [0, 1, -0.1, 1.1]) {
      const changed = structuredClone(r);
      slower(changed).factor = factor;
      expect(allowanceReportSchema.safeParse(changed).success).toBe(false);
    }
  }, 30000);

  test("C3 both scenarios share element schemas and switches are ordered by usual", async () => {
    seed();
    const r = await report();
    expect(r.trajectory.switches!.some((s) => s.accountId === B)).toBe(true);
    for (const scenario of [r.trajectory, slower(r)]) {
      const switches = scenario.switches!;
      expect(switches.map((s) => s.usual)).toEqual(switches.map((s) => s.usual).sort());
      for (const s of switches) {
        expect(Date.parse(s.soonest)).toBeLessThanOrEqual(Date.parse(s.usual));
        expect(Date.parse(s.usual)).toBeLessThanOrEqual(Date.parse(s.latest));
      }
    }
    const exchanged = structuredClone(r);
    exchanged.trajectory.switches = slower(r).switches;
    exchanged.trajectory.blocked = slower(r).blocked;
    slower(exchanged).switches = r.trajectory.switches!;
    slower(exchanged).blocked = r.trajectory.blocked;
    expect(allowanceReportSchema.safeParse(exchanged).success).toBe(true);
    for (const target of ["current", "slower"]) {
      for (const field of ["switches", "blocked"]) {
        const changed = structuredClone(r);
        const scenario = target === "current" ? changed.trajectory : slower(changed);
        if (field === "switches")
          scenario.switches = [{ ...r.trajectory.switches![0]!, probability: 1.01 }];
        else
          scenario.blocked = [
            { from: r.generatedAt, to: r.generatedAt, kind: "invalid", probability: 1.01 },
          ] as unknown as typeof scenario.blocked;
        expect(allowanceReportSchema.safeParse(changed).success).toBe(false);
      }
    }
  }, 30000);

  // allowance.md, "Not monotone, under any strategy": this seeded pool has no reset divergence.
  test("C4 this seeded pool preserves shared takeover timing and probability within tolerance", async () => {
    seed();
    const r = await report();
    expect(r.trajectory.switches!.some((s) => s.accountId === B)).toBe(true);
    for (const reduced of slower(r).switches) {
      const current = r.trajectory.switches!.find((s) => s.accountId === reduced.accountId);
      if (!current) continue;
      expect(Date.parse(reduced.usual)).toBeGreaterThanOrEqual(Date.parse(current.usual) - H);
      expect(reduced.probability).toBeLessThanOrEqual(current.probability + 0.05);
    }
  }, 30000);

  // allowance.md, "Not monotone, under any strategy": these seeded pools have no reset divergence.
  test("C5 these seeded pools preserve blocked probability and gap regression checks", async () => {
    seed([0.8, 0.8], [100, 120], 1e6);
    const blocked = await report();
    expect(blocked.trajectory.blocked.length).toBeGreaterThan(0);
    assertBlocked(blocked);
    seed([0.1, 0.1], [72, 96], 100);
    const clear = await report();
    expect(clear.trajectory.blocked).toEqual([]);
    assertBlocked(clear);
  }, 30000);

  test("C6 C27 the report except slower matches the rounded additive v1 baseline", async () => {
    seed();
    const current = await report();
    delete current.trajectory.slower;
    expect<unknown>(current).toEqual(baseline);
  }, 30000);

  test("C7 no evidence produces empty slower switches and blocked runs", async () => {
    const r = await report();
    expect(r.evidence).toBe("none");
    expect(slower(r).switches).toEqual([]);
    expect(slower(r).blocked).toEqual([]);
  });

  test("C8 trajectory-only MCP answers preserve slower", async () => {
    seed();
    const r = await report();
    slower(r);
    const { accounts, alerts, burn, combined, sessions, ...partial } = r;
    const answer = allowanceStatusAnswerSchema.parse({
      contract_version: 1,
      capabilities: ["allowance"],
      sections: ["trajectory"],
      allowance: partial,
    });
    expect(answer.allowance!.trajectory!.slower).toEqual(r.trajectory.slower);
  }, 30000);

  test("C9 sticky reset divergence creates a 7d gap only in the slower scenario", () => {
    function account(
      id: string,
      order: number,
      lengthMinutes: number,
      remaining: number,
      resetHours: number
    ): AccountView {
      const window: ViewWindow = {
        key: `len:${lengthMinutes}`,
        slot: order === 0 ? "primary" : "secondary",
        lengthMinutes,
        remaining,
        resetAt: T + resetHours * H,
        provenance: "observed",
        semantics: "fixed-start",
        quantum: 0.01,
        rejected: false,
      };
      return {
        account: id,
        order,
        windows: [window],
        binding: window.key,
        governing: window.key,
        deliverable: remaining,
        beta: { [window.key]: { value: 0.5, quality: "calibrated", relSd: 0 } },
        kappa: {},
        externalPerHour: { value: 0, quality: "calibrated", relSd: 0 },
        observedAt: T,
      };
    }
    const views = [account(A, 0, 300, 0.2, 2), account(B, 1, 10080, 1, 6)];
    const demand = Array.from({ length: 24 }, (_, hour) =>
      hour >= 18 ? 0 : hour === 12 ? 1.5 : 0.5
    );
    const options = {
      now: T,
      strategy: sticky,
      thread: { account: A, lastSwitchAt: null, contextTokens: 0 },
      poolActive: A,
    };
    const current = simulate(views, demand, DEFAULT_ALLOWANCE_CONFIG, options);
    const reduced = simulate(
      views,
      demand.map((cu) => cu * SLOWER_FACTOR),
      DEFAULT_ALLOWANCE_CONFIG,
      options
    );
    expect(current.gaps).toEqual([]);
    expect(current.unserved.every((cu) => cu === 0)).toBe(true);
    expect(reduced.gaps.map((gap) => gap.kind)).toEqual(["7d"]);
    expect(reduced.unserved.flatMap((cu, hour) => (cu > 0 ? [hour] : []))).toEqual([16]);
    expect(reduced.unserved[16]).toBeCloseTo(1 / 3, 8);
  });
});
