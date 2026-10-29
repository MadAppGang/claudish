import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setConfigFileOverride } from "../../config-override.js";
import { McpServer, serverEnv } from "../../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "../../test-helpers/contract-records.js";
import {
  ALLOWANCE_REPORT_SECTIONS,
  ALLOWANCE_REPORT_SECTIONS_V1_BASE,
  type AllowanceReport,
  allowanceReportSchema,
  allowanceStatusAnswerSchema,
} from "./allowance-report-schema.js";
import {
  AllowanceService,
  _setAllowanceServiceForTests,
  toSignificant,
} from "./allowance-service.js";
import * as goldens from "./allowance-status-golden.js";
import { DEFAULT_ALLOWANCE_CONFIG } from "./allowance/constants.js";
import { initialState, observeAll } from "./allowance/state.js";
import type { AllowanceEvent, AllowanceState, WindowReading } from "./allowance/types.js";
import { usageByHour } from "./allowance/usage.js";
import {
  type ResponseRow,
  type RollupRow,
  noEligibleRowSchema,
  responseRowSchema,
  rollupRowSchema,
} from "./ledger/ledger-row.js";
import { _resetLedgerWriterForTests, flushUsageLedger } from "./ledger/ledger-writer.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";

const H = 3_600_000;
const T = Date.parse("2026-10-26T12:00:00Z");
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const D = "dddddddddddd";
const E = "eeeeeeeeeeee";
const iso = (at: number) => new Date(at).toISOString();
let layout: TempLayout;
let config: string;
let accountsDir: string;
let serial = 0;
let server: McpServer | undefined;
let oldEnv: Record<string, string | undefined>;

function weekly(usedFraction: number, resetAt: number | null): WindowReading {
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
  accountId = A,
  inTok = 0,
  windows: WindowReading[] | null = null
): ResponseRow {
  return {
    v: 1,
    kind: "response",
    at,
    id: `usage-${serial++}:0:${accountId}`,
    provider: "openai-codex",
    accountId,
    label: accountId,
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
function reading(at: number, used: number, reset: number | null, id = A) {
  return row(at, id, 0, [weekly(used, reset)]);
}
function rollup(hour: number, accountId = A, input = 0): RollupRow {
  return {
    v: 1,
    kind: "rollup",
    id: `rollup-${serial++}`,
    hour,
    accountId,
    provider: "openai-codex",
    session: "s-123",
    model: "contract-model",
    n: 2,
    tokens: { input, cacheRead: 0, cacheWrite: 0, output: 0 },
    first: null,
    last: null,
    censoredMinutes: 0,
  };
}
function configure(ids = [A]) {
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
          accounts: ids.map((id) => ({
            id,
            label: id,
            store: "file",
            addedAt: "2026-10-20T00:00:00Z",
          })),
        },
      },
    })
  );
  writeFileSync(
    join(accountsDir, "state.json"),
    JSON.stringify({
      version: 1,
      providers: { "openai-codex": { active: ids[0], accounts: {} } },
    })
  );
}
function seed(
  rows: Array<
    ResponseRow | RollupRow | { v: 1; kind: "no-eligible"; at: number; provider: "openai-codex" }
  >
) {
  const days = new Map<string, string[]>();
  for (const r of rows) {
    const hourly = r.kind === "rollup";
    const parsed = hourly
      ? rollupRowSchema.parse(r)
      : r.kind === "response"
        ? responseRowSchema.parse(r)
        : noEligibleRowSchema.parse(r);
    const at = hourly ? r.hour : r.at;
    const path = join(
      accountsDir,
      "usage",
      hourly ? "hourly" : "raw",
      iso(at).slice(0, 10) + ".jsonl"
    );
    days.set(path, [...(days.get(path) ?? []), JSON.stringify(parsed)]);
  }
  for (const [path, lines] of days) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  }
}
async function report(now = T, evaluate = false): Promise<AllowanceReport> {
  let clock = evaluate ? now - H / 3 : now;
  const service = new AllowanceService(
    {
      HOME: layout.home,
      CLAUDE_CONFIG_DIR: layout.configDir,
      CLAUDISH_ACCOUNTS_DIR: accountsDir,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    },
    () => clock
  );
  if (evaluate) {
    await service.evaluateAlerts("openai-codex");
    clock = now;
    await service.evaluateAlerts("openai-codex");
  }
  const value = await service.report("openai-codex", 168 * H);
  expect(allowanceReportSchema.safeParse(value).success).toBe(true);
  return value;
}
function usage(r: AllowanceReport) {
  expect(r.usage).toBeDefined();
  return r.usage!;
}
function scenario(now: number, used = [0.97, 0.01], resets = [72, 96]) {
  configure([A, B]);
  const rows: ResponseRow[] = [];
  for (const id of [A, B]) {
    for (const [hours, fraction, tokens] of [
      [0, 0.1, 0],
      [1, 0.22, 12e6],
      [3, 0.34, 12e6],
      [6, 0.46, 12e6],
    ])
      rows.push(row(now - 8 * 24 * H + hours! * H, id, tokens!, [weekly(fraction!, now - H)]));
  }
  for (let i = 168; i > 0; i--) rows.push(row(now - i * H + H / 2, A, 1e6));
  rows.push(reading(now - H / 4, used[0]!, now + resets[0]! * H, A));
  rows.push(reading(now - H / 4, used[1]!, now + resets[1]! * H, B));
  seed(rows);
}
function header(r: AllowanceReport) {
  const { accounts, alerts, burn, combined, sessions, trajectory, usage: grid, ...rest } = r;
  return rest;
}
function assertByteBound(grid: NonNullable<AllowanceReport["usage"]>) {
  const bound =
    200 +
    grid.accounts.reduce((sum, a) => sum + 40 + a.accountId.length + 9 * 336, 0) +
    10 * grid.censored.length;
  expect(JSON.stringify(grid).length).toBeLessThanOrEqual(bound);
}

beforeEach(() => {
  layout = makeTempLayout("usage-rounding");
  accountsDir = join(layout.root, "accounts");
  mkdirSync(accountsDir);
  mkdirSync(join(layout.home, ".claudish"));
  config = join(layout.home, ".claudish", "config.json");
  oldEnv = {};
  for (const [name, value] of Object.entries({
    CLAUDISH_ACCOUNTS_DIR: accountsDir,
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
  })) {
    oldEnv[name] = process.env[name];
    process.env[name] = value;
  }
  setConfigFileOverride(config);
  configure();
  setAccountRegistryForTests(
    new AccountRegistry({
      configPath: () => config,
      legacyCodexPath: () => join(layout.root, "absent.json"),
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_DISABLE_OP: "1" },
    })
  );
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  _setAllowanceServiceForTests(undefined);
  setAccountRegistryForTests(null);
  setConfigFileOverride(null);
  await flushUsageLedger();
  _resetLedgerWriterForTests();
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  layout.cleanup();
});

describe("hourly usage R2", () => {
  test("C13 full report contains a 336-hour nonnegative integer cu grid", async () => {
    seed([row(T - H, A, 123)]);
    const u = usage(await report(T + 17 * 60_000));
    expect(u).toMatchObject({ start: iso(T - 335 * H), stepHours: 1, hours: 336, unit: "cu" });
    expect(u.accounts).toHaveLength(1);
    for (const a of u.accounts) {
      expect(a.cu).toHaveLength(336);
      expect(a.cu.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
    }
  });
  test("C14 raw token weighting, summation and hour boundaries are exact", async () => {
    const start = T - 335 * H;
    seed([
      row(T - 3 * H + H / 12, A, 1e6),
      row(T - 3 * H + (H * 2) / 3, A, 234567),
      row(T, A, 99),
      row(start - 1, A, 555),
      { ...row(T - H, A, 48), cacheReadTok: 30, cacheWriteTok: 7, outTok: 5 },
      row(start, A, 42),
    ]);
    const cells = usage(await report()).accounts[0]!.cu;
    expect(cells[332]).toBe(1234567);
    expect(cells[335]).toBe(99);
    expect(cells[334]).toBe(41);
    expect(cells[0]).toBe(42);
    expect(cells.reduce((a, b) => a + b, 0)).toBe(1234567 + 99 + 41 + 42);
  });
  test("C15 tiny positive cu occupies a cell as one", async () => {
    seed([{ ...row(T - H), cacheReadTok: 3 }]);
    expect(usage(await report()).accounts[0]!.cu[334]).toBe(1);
  });
  test("C16 hourly rollup cu lands in the declared hour", async () => {
    seed([rollup(T - 72 * H, A, 2e6)]);
    expect(usage(await report()).accounts[0]!.cu[263]).toBe(2e6);
  });
  test("C17 configured order precedes removed used accounts and omits removed zero accounts", async () => {
    configure([B, A, C]);
    seed([row(T - H, A, 1), row(T - H, D, 2), row(T - H, E, 0)]);
    const r = await report();
    expect(r.accounts.map((a) => a.id)).toEqual([B, A, C]);
    const u = usage(r);
    expect(u.accounts.map((a) => a.accountId)).toEqual([B, A, C, D]);
    expect(u.accounts[2]!.cu.every((n) => n === 0)).toBe(true);
  });
  test("C18 pool no-eligible intervals encode ordered nonzero minute pairs", async () => {
    seed([
      { v: 1, kind: "no-eligible", at: T - 5 * H + H / 6, provider: "openai-codex" },
      row(T - 5 * H + (H * 2) / 3, A, 100),
      { v: 1, kind: "no-eligible", at: T - 2 * H, provider: "openai-codex" },
      row(T - H, A, 100),
    ]);
    const grid = usage(await report());
    const censored = grid.censored;
    expect(censored).toContainEqual([330, 30]);
    expect(censored).toContainEqual([333, 60]);
    expect(censored.map(([i]) => i)).toEqual(censored.map(([i]) => i).sort((a, b) => a - b));
    expect(
      censored.every(([i, m]) => Number.isInteger(i) && Number.isInteger(m) && m >= 1 && m <= 60)
    ).toBe(true);
    assertByteBound(grid);
  });
  test("C19 coverage is null when empty, hour-aligned and clipped at start", async () => {
    expect(usage(await report()).coveredFrom).toBeNull();
    seed([row(T - 3 * 24 * H + 1234, A, 1)]);
    expect(usage(await report()).coveredFrom).toBe(iso(T - 3 * 24 * H));
    seed([row(T - 20 * 24 * H, A, 1)]);
    expect(usage(await report()).coveredFrom).toBe(iso(T - 335 * H));
  });
  test("C20 real MCP projects, normalizes and validates usage sections", async () => {
    configure([A, B]);
    const now = Date.now();
    seed([row(now - H, A, 1e6), row(now - H / 2, B, 2e6)]);
    server = await McpServer.start({
      env: serverEnv(layout, { CLAUDISH_ACCOUNTS_DIR: accountsDir }),
      cwd: layout.cwd,
    });
    const tools = await server.listTools();
    const tool = tools.find((t) => t.name === "allowance_status")!;
    const schema = tool.inputSchema!.properties!.sections as { items: { enum: string[] } };
    expect(schema.items.enum).toContain("usage");
    async function call(args: Record<string, unknown>) {
      const result = await server!.callTool("allowance_status", args);
      expect(result.isError).toBe(false);
      return allowanceStatusAnswerSchema.parse(JSON.parse(result.text));
    }
    const only = await call({ sections: ["usage"] });
    expect(only.sections).toEqual(["usage"]);
    expect(only.allowance!.usage!.accounts.map((a) => a.accountId)).toEqual([A, B]);
    for (const key of ["accounts", "alerts", "burn", "combined", "sessions", "trajectory"])
      expect(Object.hasOwn(only.allowance!, key)).toBe(false);
    expect(JSON.stringify(only).length).toBeLessThanOrEqual(4096);
    const trajectory = await call({ sections: ["trajectory"] });
    expect(Object.hasOwn(trajectory.allowance!, "usage")).toBe(false);
    expect((await call({ sections: ["usage", "trajectory", "usage"] })).sections).toEqual([
      "trajectory",
      "usage",
    ]);
    expect((await call({})).allowance!.usage).toBeDefined();
    const bad = await server.callTool("allowance_status", { sections: ["usag"] });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.text).error.code).toBe("invalid_args");
  }, 60000);
  test("C21 old v1 goldens remain valid but an explicitly requested usage section is required", async () => {
    for (const [key, golden] of Object.entries(goldens)) {
      if (!key.endsWith("_ANSWER")) continue;
      expect(allowanceStatusAnswerSchema.safeParse(golden).success).toBe(true);
      const old = structuredClone(golden) as { allowance: null | Record<string, unknown> };
      if (old.allowance) delete old.allowance.usage;
      expect(allowanceStatusAnswerSchema.safeParse(old).success).toBe(true);
    }
    const r = await report();
    usage(r);
    const old = structuredClone(r);
    delete old.usage;
    expect(
      allowanceStatusAnswerSchema.safeParse({
        contract_version: 1,
        capabilities: ["allowance"],
        allowance: old,
      }).success
    ).toBe(true);
    expect(
      allowanceStatusAnswerSchema.safeParse({
        contract_version: 1,
        capabilities: ["allowance"],
        sections: ["usage"],
        allowance: { ...header(r), trajectory: r.trajectory },
      }).success
    ).toBe(false);
    for (const key of [
      "GOLDEN_ALLOWANCE_WARN_ANSWER",
      "GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER",
    ] as const) {
      const golden = goldens[key];
      expect(golden.allowance.usage).toBeDefined();
    }
  });
  test.each([...ALLOWANCE_REPORT_SECTIONS_V1_BASE])(
    "C21 full answer without sections requires %s",
    async (section) => {
      const answer = {
        contract_version: 1,
        capabilities: ["allowance"],
        allowance: (await report()) as Partial<AllowanceReport>,
      };
      expect(allowanceStatusAnswerSchema.safeParse(answer).success).toBe(true);
      delete answer.allowance[section];
      expect(allowanceStatusAnswerSchema.safeParse(answer).success).toBe(false);
    }
  );
  test.each([...ALLOWANCE_REPORT_SECTIONS])(
    "C21 answer explicitly naming %s requires that section",
    async (section) => {
      const answer = {
        contract_version: 1,
        capabilities: ["allowance"],
        sections: [section],
        allowance: (await report()) as Partial<AllowanceReport>,
      };
      expect(allowanceStatusAnswerSchema.safeParse(answer).success).toBe(true);
      delete answer.allowance[section];
      expect(allowanceStatusAnswerSchema.safeParse(answer).success).toBe(false);
    }
  );
  test("C22a realistic 14-day two-account answer stays inline within 4096 bytes", async () => {
    configure([A, B]);
    const start = T - 335 * H;
    const rows: ResponseRow[] = [];
    for (let day = 0; day < 14; day++) {
      for (let h = 0; h < 10; h++) {
        const count = 1 + ((day + h) % 4);
        for (let k = 0; k < count; k++)
          rows.push(
            row(
              start + (day * 24 + h) * H + ((k + 1) * H) / 10,
              day < 7 ? A : B,
              500000 + ((day * 10 + h + k) % 10) * 500000
            )
          );
      }
    }
    seed(rows);
    const r = await report();
    const u = usage(r);
    expect(u.accounts.map((a) => a.cu.filter((n) => n > 0).length)).toEqual([70, 70]);
    const answer = {
      contract_version: 1,
      capabilities: [
        "list",
        "status",
        "cancel",
        "capture",
        "capture_since_seq",
        "capture_spans",
        "resize",
        "allowance",
      ],
      sections: ["usage"],
      allowance: { ...header(r), usage: u },
    };
    expect(allowanceStatusAnswerSchema.safeParse(answer).success).toBe(true);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(4096);
    assertByteBound(u);
  });
  test("C22b C22c worst-case 336 populated hours obey grid and general byte bounds", async () => {
    configure([A, B]);
    const start = T - 335 * H;
    seed(
      [A, B].flatMap((id) =>
        Array.from({ length: 336 }, (_, i) => row(start + i * H, id, 99000000))
      )
    );
    const u = usage(await report());
    for (const a of u.accounts) expect(a.cu).toEqual(Array(336).fill(99000000));
    expect(JSON.stringify(u).length).toBeLessThanOrEqual(6400);
    assertByteBound(u);
  });
});

function responseEvent(r: ResponseRow): AllowanceEvent {
  return {
    kind: "response",
    id: r.id,
    at: r.at,
    account: r.accountId,
    session: r.session,
    model: r.model,
    tokens: {
      input: r.inTok,
      cacheRead: r.cacheReadTok,
      cacheWrite: r.cacheWriteTok,
      output: r.outTok,
    },
    finalInput: r.finalInTok,
    windows: r.windows,
    outcome: r.outcome,
  };
}
function rollupEvent(r: RollupRow): AllowanceEvent {
  return {
    kind: "rollup",
    id: r.id,
    hour: r.hour,
    account: r.accountId,
    session: r.session,
    model: r.model,
    n: r.n,
    tokens: r.tokens,
    first: r.first,
    last: r.last,
    censoredMinutes: r.censoredMinutes,
  };
}
function fold(events: AllowanceEvent[], state: AllowanceState = initialState()) {
  return observeAll(state, events, DEFAULT_ALLOWANCE_CONFIG);
}
function censoredPairs(state: AllowanceState, now: number) {
  return usageByHour(state, now).censoredMinutes.flatMap((minutes, index) =>
    minutes > 0 ? [[index, minutes]] : []
  );
}

describe("review regressions", () => {
  test("R4 ongoing censoring spans the grid, clips at now and merges sealed minutes", () => {
    const noon = Date.parse("2026-10-20T12:00:00Z");
    const now = noon + H / 2;
    const start = noon - 335 * H;
    const open = fold([{ kind: "no-eligible", at: noon - 2 * H + H / 6 }]);
    const beforeGrid = fold([{ kind: "no-eligible", at: start - 2 * H + H / 6 }]);
    const sealedAndOpen = fold([
      { kind: "no-eligible", at: noon - 2 * H },
      responseEvent(row(noon - 2 * H + H / 3, A, 1)),
      { kind: "no-eligible", at: noon - 2 * H + H / 2 },
    ]);
    const states = [open, beforeGrid, sealedAndOpen];
    const snapshots = states.map((state) => JSON.stringify(state));
    const actual = states.map((state) => censoredPairs(state, now));
    expect(states.map((state) => JSON.stringify(state))).toEqual(snapshots);
    for (const pairs of actual)
      expect(pairs.every(([, minutes]) => minutes! > 0 && minutes! <= 60)).toBe(true);
    const expected = [
      [
        [333, 50],
        [334, 60],
        [335, 30],
      ],
      Array.from({ length: 336 }, (_, i) => [i, i === 335 ? 30 : 60]),
      [
        [333, 50],
        [334, 60],
        [335, 30],
      ],
    ];
    expect(actual.map((pairs) => JSON.stringify(pairs))).toEqual(
      expected.map((pairs) => JSON.stringify(pairs))
    );
  });

  test("R5 coverage starts at recorded zero-cu hours, with raw and rollup parity", async () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const start = now - 335 * H;
    const zero = reading(now - H, 0.2, now + 100 * H);
    const positive = row(now, A, 1);
    const oldZero = reading(start - 10 * H, 0.1, now + 100 * H);
    const compacted = {
      ...rollup(now - H),
      n: 1,
      first: zero.windows,
      last: zero.windows,
    };
    const rawCoverage = usageByHour(fold([responseEvent(zero)]), now).coveredFrom;
    const rollupCoverage = usageByHour(fold([rollupEvent(compacted)]), now).coveredFrom;
    seed([zero]);
    const zeroReport = usage(await report(now)).coveredFrom;
    seed([zero, positive]);
    const beforePositiveReport = usage(await report(now)).coveredFrom;
    seed([oldZero, zero, positive]);
    const clippedReport = usage(await report(now)).coveredFrom;
    expect({
      raw: rawCoverage,
      rollup: rollupCoverage,
      beforePositive: usageByHour(fold([responseEvent(zero), responseEvent(positive)]), now)
        .coveredFrom,
      clipped: usageByHour(fold([responseEvent(oldZero), responseEvent(positive)]), now)
        .coveredFrom,
      zeroReport,
      beforePositiveReport,
      clippedReport,
    }).toEqual({
      raw: now - H,
      rollup: now - H,
      beforePositive: now - H,
      clipped: start,
      zeroReport: iso(now - H),
      beforePositiveReport: iso(now - H),
      clippedReport: iso(start),
    });
  });
});

describe("forecast rounding R3", () => {
  test("C23 evidence-full forecast quantiles are ordered and rounded to four significant digits", async () => {
    scenario(T);
    const r = await report();
    expect(r.evidence).toBe("full");
    expect(r.trajectory.forecast.length).toBeGreaterThan(0);
    expect(r.trajectory.forecast.some((p) => p.p50 > 0)).toBe(true);
    for (const p of r.trajectory.forecast) {
      for (const q of ["p10", "p50", "p90"] as const)
        expect(p[q]).toBe(p[q] === 0 ? 0 : Number(p[q].toPrecision(4)));
      expect(p.p10).toBeLessThanOrEqual(p.p50);
      expect(p.p50).toBeLessThanOrEqual(p.p90);
    }
  }, 30000);
  test("C24 exported helper matches an independent signed finite-number oracle and preserves order", () => {
    expect(toSignificant(0, 4)).toBe(0);
    expect(toSignificant(99126073.37062046, 4)).toBe(99130000);
    expect(toSignificant(1.23456, 4)).toBe(1.235);
    const values = [-99126073.37062046, -1.23456, -0.0000123456, 0, 1.23456, 99126073.37062046];
    for (let exponent = -250; exponent <= 250; exponent += 5)
      for (const mantissa of [-9.99999, -1.00051, 1.00051, 1.23456, 9.99999])
        values.push(mantissa * 10 ** exponent);
    values.sort((a, b) => a - b);
    let last = Number.NEGATIVE_INFINITY;
    for (const x of values) {
      const rounded = toSignificant(x, 4);
      expect(rounded).toBe(x === 0 ? 0 : Number(x.toPrecision(4)));
      expect(Math.abs(rounded - x)).toBeLessThanOrEqual(5e-4 * Math.abs(x));
      expect(rounded).toBeGreaterThanOrEqual(last);
      last = rounded;
    }
  });
  test("C25 slower-scenario forecast fits 16000 bytes", async () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    scenario(now);
    expect(JSON.stringify((await report(now)).trajectory.forecast).length).toBeLessThanOrEqual(
      16000
    );
  }, 30000);
  test("C26 historical exact sums and sustainable-burn identity retain full precision", async () => {
    scenario(T, [0.8, 0.8], [100, 120]);
    const r = await report(T, true);
    const series = r.trajectory.historyByAccount!;
    expect(series).toHaveLength(2);
    let compared = 0;
    for (const p of r.trajectory.history) {
      const points = series.map((s) => s.history.find((v) => v.at === p.at));
      if (!points.every((v) => v !== undefined)) continue;
      expect(
        Math.abs(points.reduce((sum, v) => sum + v!.remaining, 0) - p.remaining)
      ).toBeLessThanOrEqual(1e-9);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
    const historical = [...r.trajectory.history, ...series.flatMap((s) => s.history)].map(
      (p) => p.remaining
    );
    expect(historical.some((v) => v !== Number(v.toPrecision(4)))).toBe(true);
    expect(r.burn.long).toBeGreaterThan(0);
    expect(r.alerts.length).toBeGreaterThan(0);
    const remedy = r.alerts[0]!.remedy;
    if (remedy.kind === "cut") {
      const expected = (remedy.cutToPercent! / 100) * r.burn.long!;
      expect(Math.abs(r.burn.sustainable! - expected)).toBeLessThanOrEqual(
        Math.abs(expected) * 1e-9
      );
    } else expect(r.burn.sustainable).toBe(0);
  }, 30000);
});
