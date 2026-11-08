import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../../config-override.js";
import { type AllowanceReport, allowanceReportSchema } from "./allowance-report-schema.js";
import { AllowanceService, _setAllowanceServiceForTests } from "./allowance-service.js";
import { buildResponseRow } from "./ledger/ledger-row.js";
import { _resetLedgerWriterForTests, flushUsageLedger, rollupDay } from "./ledger/ledger-writer.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";

const H = 3_600_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const CHILD = "11111111-aaaa-bbbb-cccc-123456789abc";
const OTHER = "22222222-bbbb-cccc-dddd-123456789abc";
let dir: string;
let oldAccounts: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "allowance-rollup-attribution-"));
  oldAccounts = process.env.CLAUDISH_ACCOUNTS_DIR;
  process.env.CLAUDISH_ACCOUNTS_DIR = join(dir, "accounts");
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
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
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

function response(at: number, session: string | null, input: number, usedFraction?: number) {
  return buildResponseRow({
    provider: "openai-codex",
    requestId: "rollup-attribution-" + at,
    attempt: 0,
    at,
    accountId: A,
    label: "work",
    planClass: "pro",
    session,
    model: "contract-model",
    reason: undefined,
    outcome: "ok",
    tokens: { input, cacheRead: 0, cacheWrite: 0, output: 0 },
    finalInput: input,
    ...(usedFraction === undefined
      ? {}
      : {
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
        }),
  })!;
}

async function reports(rows: ReturnType<typeof response>[]) {
  const day = new Date(rows[0]!.at).toISOString().slice(0, 10);
  expect(rows.every((row) => new Date(row.at).toISOString().slice(0, 10) === day)).toBe(true);
  expect(rows.every((row) => row.at < T - 48 * H)).toBe(true);
  const results: AllowanceReport[] = [];
  for (const kind of ["raw", "hourly"] as const) {
    const accountsDir = join(dir, kind);
    process.env.CLAUDISH_ACCOUNTS_DIR = accountsDir;
    const path = join(accountsDir, "usage", kind);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, day + ".jsonl"),
      kind === "raw"
        ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
        : rollupDay(day, rows),
      { mode: 0o600 }
    );
    expect(existsSync(join(accountsDir, "usage", kind === "raw" ? "hourly" : "raw"))).toBe(false);
    const report = allowanceReportSchema.parse(
      await new AllowanceService(
        {
          HOME: dir,
          CLAUDE_CONFIG_DIR: join(dir, ".claude"),
          CLAUDISH_ACCOUNTS_DIR: accountsDir,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
        },
        () => T
      ).report("openai-codex", H)
    );
    expect(report.evidence).not.toBe("none");
    results.push(report);
  }
  return { raw: results[0]!, hourly: results[1]! };
}

function sameAttribution(raw: AllowanceReport, hourly: AllowanceReport, session: string) {
  const rawSession = raw.sessions.find((row) => row.session === session.slice(0, 8));
  const hourlySession = hourly.sessions.find((row) => row.session === session.slice(0, 8));
  expect(rawSession).toBeDefined();
  expect(hourlySession).toBeDefined();
  expect(rawSession!.tokens.in).toBeGreaterThan(0);
  expect(hourlySession!.tokens.in).toBe(rawSession!.tokens.in);
  expect(rawSession!.cu).toBeGreaterThan(0);
  expect(hourlySession!.cu).toBe(rawSession!.cu);
}

describe("MTL-301 raw and rollup session attribution", () => {
  test("R1 last active hour without a later reading has equal positive usage", async () => {
    const { raw, hourly } = await reports([
      response(T - 75 * H, null, 0, 0.1),
      response(T - 74 * H, CHILD, 1000, 0.11),
    ]);
    sameAttribution(raw, hourly, CHILD);
  });

  test("R2 a reading in the following hour preserves equal usage", async () => {
    const { raw, hourly } = await reports([
      response(T - 75 * H, null, 0, 0.1),
      response(T - 74 * H, CHILD, 1000, 0.11),
      response(T - 73 * H, null, 0, 0.12),
    ]);
    sameAttribution(raw, hourly, CHILD);
  });

  test("R3 two sessions in different hours each retain equal usage", async () => {
    const { raw, hourly } = await reports([
      response(T - 76 * H, null, 0, 0.1),
      response(T - 75 * H, OTHER, 2000, 0.105),
      response(T - 74 * H, CHILD, 1000, 0.11),
    ]);
    sameAttribution(raw, hourly, OTHER);
    sameAttribution(raw, hourly, CHILD);
  });
});
