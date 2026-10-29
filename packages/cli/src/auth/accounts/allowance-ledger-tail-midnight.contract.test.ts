import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../../config-override.js";
import { type AllowanceReport, allowanceReportSchema } from "./allowance-report-schema.js";
import { AllowanceService, _setAllowanceServiceForTests } from "./allowance-service.js";
import { buildResponseRow, serializeRow, utcDay } from "./ledger/ledger-row.js";
import { _resetLedgerWriterForTests, flushUsageLedger } from "./ledger/ledger-writer.js";
import { usageRawDir, usageRawPath } from "./paths.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";

const H = 3_600_000;
const MIN = 60_000;
const T = Date.parse("2026-10-29T00:00:00Z");
const A = "aaaaaaaaaaaa";
const INITIAL_CU = 100;
const LATE_CU = 250;
const TODAY_CU = 40;
let dir: string;
let now: number;
let env: NodeJS.ProcessEnv;
let oldEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "allowance-ledger-tail-midnight-"));
  now = T + 10_000;
  env = {
    HOME: join(dir, "home"),
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts"),
    XDG_CONFIG_HOME: join(dir, "config"),
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
  };
  oldEnv = {};
  for (const [key, value] of Object.entries(env)) {
    oldEnv[key] = process.env[key];
    process.env[key] = value;
  }
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDISH_ACCOUNTS_DIR", "XDG_CONFIG_HOME"]) {
    mkdirSync(env[key]!, { recursive: true });
  }
  const config = join(dir, "config.json");
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
          accounts: [{ id: A, label: "work", store: "file", addedAt: "2026-10-20T00:00:00Z" }],
        },
      },
    })
  );
  setConfigFileOverride(config);
  setAccountRegistryForTests(
    new AccountRegistry({
      configPath: () => config,
      legacyCodexPath: () => join(dir, "absent.json"),
      env,
    })
  );
});

afterEach(async () => {
  _setAllowanceServiceForTests(undefined);
  setAccountRegistryForTests(null);
  setConfigFileOverride(null);
  await flushUsageLedger();
  _resetLedgerWriterForTests();
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function appendResponse(at: number, input: number, usedFraction: number) {
  const row = buildResponseRow({
    provider: "openai-codex",
    requestId: "midnight-" + at,
    attempt: 0,
    at,
    accountId: A,
    label: "work",
    planClass: "pro",
    session: "midnight-contract",
    model: "contract-model",
    reason: undefined,
    outcome: "ok",
    tokens: { input, cacheRead: 0, cacheWrite: 0, output: 0 },
    finalInput: input,
    usage: {
      observedAt: at,
      windows: [
        {
          slot: "secondary",
          displayId: "7d",
          lengthMinutes: 10080,
          usedFraction,
          resetAt: T + 72 * H,
        },
      ],
    },
  });
  expect(row).not.toBeNull();
  const line = serializeRow(row!);
  expect(line).not.toBeNull();
  mkdirSync(usageRawDir(env), { recursive: true });
  // Write outside the service, just as a second process appending a completed response would.
  appendFileSync(usageRawPath(utcDay(at), env), line!, { mode: 0o600 });
}

async function report(service: AllowanceService) {
  return allowanceReportSchema.parse(await service.report("openai-codex", 168 * H));
}

function cuAt(value: AllowanceReport, at: number) {
  expect(value.usage).toBeDefined();
  const usage = value.usage!;
  const account = usage.accounts.find((a) => a.accountId === A);
  expect(account).toBeDefined();
  const cell = Math.floor((at - Date.parse(usage.start)) / H);
  expect(cell).toBeGreaterThanOrEqual(0);
  expect(cell).toBeLessThan(usage.hours);
  return account!.cu[cell]!;
}

async function assertLateAppend(lateAt: number) {
  appendResponse(T - MIN, INITIAL_CU, 0.6);
  const live = new AllowanceService(env, () => now);
  const loaded = await report(live);
  expect(cuAt(loaded, T - MIN)).toBe(INITIAL_CU);
  expect(cuAt(loaded, T)).toBe(0);

  now = T + 30_000;
  appendResponse(lateAt, LATE_CU, 0.7);
  now = T + 2 * MIN;
  appendResponse(now, TODAY_CU, 0.75);
  now += MIN;
  await live.evaluateAlerts("openai-codex");
  const refreshed = await report(live);
  const fresh = await report(new AllowanceService(env, () => now));
  const lateHourBaseline = cuAt(loaded, lateAt);
  const sameDay = utcDay(lateAt) === utcDay(T);

  expect(
    cuAt(fresh, lateAt) - lateHourBaseline - (sameDay ? TODAY_CU : 0),
    "a fresh service must include the late row's 250 cu"
  ).toBe(LATE_CU);
  expect(
    cuAt(refreshed, T),
    "the live refresh must include today's row before checking the late append"
  ).toBe(TODAY_CU + (sameDay ? LATE_CU : 0));
  expect(
    cuAt(refreshed, lateAt) - lateHourBaseline - (sameDay ? TODAY_CU : 0),
    "the live refresh must include the late row's 250 cu, even in yesterday's UTC ledger file"
  ).toBe(LATE_CU);
  expect(refreshed.usage).toEqual(fresh.usage);
}

describe("MTL-324 usage ledger tail across UTC midnight", () => {
  test("regression: refresh includes a late row appended to yesterday's raw file", async () => {
    // REGRESSION: MTL-324 — a row appended to yesterday's ledger file after the load is never folded — Fixed in /dev:fix session dev-fix-20261029-234333-dcf968b2
    await assertLateAppend(T - 30_000);
  });

  test("control: refresh includes a late row appended to today's raw file", async () => {
    // CONTROL: the same history with the late row in today's file is folded by the live refresh, so the regression fails for the file's day, not for the harness.
    await assertLateAppend(T + 30_000);
  });
});
