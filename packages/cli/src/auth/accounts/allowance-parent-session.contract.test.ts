import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubChildEnv } from "../../claude-runner.js";
import { setConfigFileOverride } from "../../config-override.js";
import { CONTROL_VARS, dropControlVars } from "../../launch-env.js";
import { applyPaneEnvSnapshot } from "../../pane/child-env.js";
import { buildPaneEnv } from "../../pane/pane-launch.js";
import { allowanceReportSchema } from "./allowance-report-schema.js";
import { AllowanceService, _setAllowanceServiceForTests } from "./allowance-service.js";
import { buildResponseRow } from "./ledger/ledger-row.js";
import { _resetLedgerWriterForTests, flushUsageLedger, rollupDay } from "./ledger/ledger-writer.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";

const H = 3_600_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const CHILD = "11111111-aaaa-bbbb-cccc-123456789abc";
const PARENT = "22222222-bbbb-cccc-dddd-123456789abc";
let dir: string;
let accountsDir: string;
let oldAccounts: string | undefined;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "allowance-parent-session-"));
  accountsDir = join(dir, "accounts");
  mkdirSync(accountsDir);
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
  oldAccounts = process.env.CLAUDISH_ACCOUNTS_DIR;
  process.env.CLAUDISH_ACCOUNTS_DIR = accountsDir;
  setConfigFileOverride(config);
  setAccountRegistryForTests(
    new AccountRegistry({
      configPath: () => config,
      legacyCodexPath: () => join(dir, "absent.json"),
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
    })
  );
  env = {
    HOME: dir,
    CLAUDE_CONFIG_DIR: join(dir, ".claude"),
    CLAUDISH_ACCOUNTS_DIR: accountsDir,
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
  };
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
function windows() {
  return [
    {
      key: "len:10080",
      slot: "secondary",
      lengthMinutes: 10080,
      usedFraction: 0.1,
      resetAt: T + 72 * H,
      rejected: false,
      quantum: 0.01,
    },
  ];
}
function raw(session: string | null, parent?: string, n = 0) {
  return {
    v: 1,
    kind: "response",
    at: T - H + n,
    id: `parent-${n}:0:${A}`,
    provider: "openai-codex",
    accountId: A,
    label: "work",
    planClass: "pro",
    session,
    model: "contract-model",
    reason: null,
    outcome: "ok",
    inTok: 1000,
    outTok: 0,
    cacheReadTok: 0,
    cacheWriteTok: 0,
    finalInTok: 1000,
    windows: windows(),
    ...(parent === undefined ? {} : { parent }),
  };
}
function put(kind: "raw" | "hourly", rows: unknown[], day = "2026-10-25") {
  const path = join(accountsDir, "usage", kind);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, day + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    mode: 0o600,
  });
}
async function report() {
  const r = allowanceReportSchema.parse(
    await new AllowanceService(env, () => T).report("openai-codex", H)
  );
  expect(r.schema).toBe("claudish.allowance.v1");
  return r;
}
async function record(extraEnv: Record<string, string | undefined>) {
  const svc = new AllowanceService({ ...env, ...extraEnv }, () => T);
  svc.record({
    requestId: "parent-record",
    attempt: 0,
    at: T - H,
    account: { provider: "openai-codex", id: A, label: "work" },
    planClass: "pro",
    session: CHILD,
    model: "contract-model",
    reason: undefined,
    outcome: "ok",
    tokens: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
    finalInput: 1000,
  });
  await flushUsageLedger();
  const path = join(accountsDir, "usage/raw");
  const rows = readdirSync(path).flatMap((f) =>
    readFileSync(join(path, f), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].session).toBe(CHILD);
  return rows[0] as Record<string, unknown>;
}

describe("MTL-294 C-T5 delegated session parent", () => {
  test("C-T5.1,4 raw parents are exposed only as eight characters and nine are rejected", async () => {
    put("raw", [
      { ...raw(null, undefined, 99), at: T - 2 * H, inTok: 0, finalInTok: 0 },
      raw(CHILD, PARENT),
    ]);
    const r = await report();
    const child = r.sessions.find((s) => s.session === "11111111");
    expect(child).toBeDefined();
    expect(child!.parent).toBe("22222222");
    for (const s of r.sessions)
      if (s.parent !== null) expect(s.parent!.length).toBeLessThanOrEqual(8);
    const bad = structuredClone(r);
    bad.sessions.find((s) => s.session === "11111111")!.parent = "123456789";
    expect(allowanceReportSchema.safeParse(bad).success).toBe(false);
  }, 30000);
  test("C-T5.2,10 old rows and unattributed usage have a null parent", async () => {
    put("raw", [raw(CHILD), raw(null, PARENT, 1)]);
    const r = await report();
    expect(r.sessions.find((s) => s.session === "11111111")?.parent).toBeNull();
    expect(r.sessions.find((s) => s.session === "unattributed")?.parent).toBeNull();
    expect(r.sessions.length).toBeGreaterThanOrEqual(2);
    expect(r.sessions.every((s) => s.parent === null)).toBe(true);
  }, 30000);
  test("C-T5.3 an hourly rollup preserves the same shortened parent", async () => {
    const rows = [
      { at: T - 95 * H, session: null, input: 0, usedFraction: 0.1 },
      { at: T - 94 * H, session: CHILD, input: 1000, usedFraction: 0.11 },
      { at: T - 93 * H, session: null, input: 0, usedFraction: 0.12 },
    ].map(
      ({ at, session, input, usedFraction }, i) =>
        buildResponseRow({
          provider: "openai-codex",
          requestId: "parent-rollup-" + i,
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
          usage: { observedAt: at, windows: [{ ...windows()[0]!, usedFraction, displayId: "7d" }] },
        })!
    );
    const day = new Date(rows[0]!.at).toISOString().slice(0, 10);
    const hourly = rollupDay(day, rows)
      .trim()
      .split("\n")
      .map((line) => {
        const row = JSON.parse(line);
        return row.session === CHILD ? { ...row, parent: PARENT } : row;
      });
    put("hourly", hourly, day);
    expect(existsSync(join(accountsDir, "usage/raw", day + ".jsonl"))).toBe(false);
    const child = hourly.find((row) => row.session === CHILD);
    expect(child?.parent).toBe(PARENT);
    expect(hourly.some((row) => row.hour > child.hour)).toBe(true);
    const r = await report();
    expect(r.evidence).not.toBe("none");
    expect(r.sessions.find((s) => s.session === "11111111")?.parent).toBe("22222222");
  }, 30000);
  test("C-T5.5 a pane service records the full pattern-checked parent locally", async () => {
    const row = await record({
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: dir,
      CLAUDISH_PARENT_SESSION: PARENT,
    });
    expect(row.parent).toBe(PARENT);
  });
  for (const [name, extra] of [
    ["no pane flag", { CLAUDISH_PANE_CWD: "present", CLAUDISH_PARENT_SESSION: PARENT }],
    [
      "space in parent",
      { CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "present", CLAUDISH_PARENT_SESSION: "a b" },
    ],
    [
      "underscore in parent",
      { CLAUDISH_PANE_CHILD: "1", CLAUDISH_PANE_CWD: "present", CLAUDISH_PARENT_SESSION: "x_y" },
    ],
  ] as const)
    test(`C-T5.6 ${name} keeps the row but omits parent`, async () => {
      expect(await record(extra)).not.toHaveProperty("parent");
    });
  test("C-T5.7 a session cannot be its own parent", async () => {
    expect(
      await record({
        CLAUDISH_PANE_CHILD: "1",
        CLAUDISH_PANE_CWD: dir,
        CLAUDISH_PARENT_SESSION: CHILD,
      })
    ).not.toHaveProperty("parent");
  });
  test("C-T5.8 parent is scrubbed from child launches but survives pane snapshots and cannot be set by env files", () => {
    for (const interactive of [true, false]) {
      const child: Record<string, string | undefined> = {
        CLAUDISH_PARENT_SESSION: PARENT,
        KEEP: "yes",
      };
      scrubChildEnv(child, { interactive });
      expect(child).toEqual({ KEEP: "yes" });
    }
    const pane: Record<string, string | undefined> = {
      CLAUDISH_PANE_CHILD: "1",
      CLAUDISH_PANE_CWD: dir,
      CLAUDISH_PARENT_SESSION: PARENT,
      CLAUDISH_PANE_ENV: JSON.stringify({ KEEP: "yes" }),
    };
    expect(applyPaneEnvSnapshot(pane)).toEqual({ ok: true });
    expect(pane.CLAUDISH_PARENT_SESSION).toBe(PARENT);
    expect([...CONTROL_VARS]).toContain("CLAUDISH_PARENT_SESSION");
    const fileEnv: Record<string, string | undefined> = {
      CLAUDISH_PARENT_SESSION: PARENT,
      KEEP: "yes",
    };
    expect(dropControlVars(fileEnv)).toContain("CLAUDISH_PARENT_SESSION");
    expect(fileEnv).toEqual({ KEEP: "yes" });
  });
  test("C-T5.9 the owner's slot parent reaches both magmux env and the JSON snapshot", () => {
    const { magmuxEnv } = buildPaneEnv({
      parentEnv: { PATH: "/bin", HOME: dir, CLAUDISH_PARENT_SESSION: "stale-parent" },
      slotEnv: { CLAUDISH_PARENT_SESSION: PARENT },
      cwd: dir,
      ctlDir: join(dir, "launch"),
      configFile: null,
    });
    expect(magmuxEnv.CLAUDISH_PARENT_SESSION).toBe(PARENT);
    expect(JSON.parse(magmuxEnv.CLAUDISH_PANE_ENV!).CLAUDISH_PARENT_SESSION).toBe(PARENT);
    const pane = { ...magmuxEnv };
    expect(applyPaneEnvSnapshot(pane)).toEqual({ ok: true });
    expect(pane.CLAUDISH_PARENT_SESSION).toBe(PARENT);
  });
});
