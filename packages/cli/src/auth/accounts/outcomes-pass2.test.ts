import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCodexUsageLimit } from "../../handlers/shared/codex-usage-limit.js";
import * as logger from "../../logger.js";
import { type AccountOutcomeFold, codexQuotaOutcome, reportAccountOutcome } from "./outcomes.js";
import { AccountPool } from "./pool.js";
import { AccountRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import type { AccountRef, UsageSnapshot } from "./types.js";

const src = resolve(import.meta.dir, "../..");
const now = 1_800_000_000_000;
const minute = 60_000;
const usage: UsageSnapshot = {
  observedAt: now,
  windows: [
    { slot: "primary", displayId: "primary", usedFraction: 1, resetAt: now + 20 * minute },
    { slot: "secondary", displayId: "secondary", usedFraction: 1, resetAt: now + 10 * minute },
    { slot: "not-full", displayId: "not-full", usedFraction: 0.99, resetAt: now + minute },
    { slot: "past", displayId: "past", usedFraction: 1, resetAt: now - minute },
    { slot: "invalid", displayId: "invalid", usedFraction: 1, resetAt: Number.NaN },
  ],
};

for (const [name, evidence, headers, expectedMinutes, estimated] of [
  [
    "absolute body beats conflicting relative and header",
    { resets_at: (now + 45 * minute) / 1000, resets_in_seconds: 60 },
    usage,
    45,
    false,
  ],
  ["relative body seconds beat header", { resets_in_seconds: 90 }, usage, 1.5, false],
  [
    "past absolute body falls through to earliest future full header",
    { resets_at: (now - minute) / 1000 },
    usage,
    10,
    false,
  ],
  [
    "invalid absolute body falls through to full header",
    { resets_at: "not-a-time" },
    usage,
    10,
    false,
  ],
  ["past relative body falls through to full header", { resets_in_seconds: -10 }, usage, 10, false],
  ["absent body uses earliest future full header", {}, usage, 10, false],
  [
    "non-full and past headers are not reset evidence",
    {},
    { observedAt: now, windows: usage.windows.slice(2) },
    15,
    true,
  ],
  ["absent body and headers estimate", {}, undefined, 15, true],
] as const) {
  test(`E6 ${name}`, () => {
    const limit = parseCodexUsageLimit({
      error: { type: "usage_limit_reached", message: "simulated quota", ...evidence },
    });
    expect(limit).not.toBeNull();
    const outcome = codexQuotaOutcome(limit, headers as UsageSnapshot | undefined, now);
    expect(outcome.resetAt).toBe(now + expectedMinutes * minute);
    expect(outcome.estimated).toBe(estimated);
  });
}

test("E6 Retry-After/RPM without full-window evidence is estimated", () => {
  const outcome = codexQuotaOutcome(null, undefined, now);
  expect(outcome).toMatchObject({ resetAt: now + 15 * minute, estimated: true });
});

const restartProgram = String.raw`
const src = process.env.TEST_SRC;
let stateModule = src + "/auth/accounts/state-store.ts";
if (process.env.MUTATION === "fixed-estimate") {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const original = readFileSync(stateModule, "utf8");
  let copy = original.replace("const count = Math.max(0, numberOr(node.quotaEstimateCount, 0));", "const count = 0;");
  if (copy === original) throw new Error("fixed-estimate mutation target was not reached");
  copy = copy.replace(/(from\s+["'])(\.[^"']+)/g, (_, lead, spec) => lead + resolve(src + "/auth/accounts", spec).replace(/\.js$/, ".ts"));
  stateModule = process.env.HOME + "/mutant-state-store.ts";
  writeFileSync(stateModule, copy);
}
const { StateStore } = await import(stateModule);
const { AccountPool } = await import(src + "/auth/accounts/pool.ts");
const { AccountRegistry } = await import(src + "/auth/accounts/registry.ts");
const { codexQuotaOutcome, reportAccountOutcome } = await import(src + "/auth/accounts/outcomes.ts");
const { readFileSync, writeFileSync } = await import("node:fs");
const root = process.env.HOME;
const at = Number(process.env.AT);
const ref = { provider: "openai-codex", id: "aaaaaaaaaaaa", label: "A" };
writeFileSync(root + "/config.json", JSON.stringify({ subscriptionAccounts: { "openai-codex": { generation: 1, accounts: [{ ...ref, store: "file", addedAt: "2026-09-12T00:00:00Z" }] } } }));
const state = new StateStore({ path: root + "/state.json", lockPath: root + "/state.lock", now: () => at });
const registry = new AccountRegistry({ configPath: () => root + "/config.json", legacyCodexPath: () => root + "/absent-legacy" });
const pool = new AccountPool("openai-codex", { state, registry, now: () => at });
const operation = process.env.OP;
const snapshot = { observedAt: at, windows: [{ slot: "primary", displayId: "primary", usedFraction: 0.1, resetAt: at + 3600000 }] };
const outcome = operation === "success" ? { kind: "ok", usage: snapshot } : operation === "authoritative" ? { kind: "quota", resetAt: at + 1200000, estimated: false } : codexQuotaOutcome(null, undefined, at);
await reportAccountOutcome({ requestId: process.env.REQUEST_ID, account: ref, outcome, observedAt: at }, new Map(), pool);
await state.flush();
console.log("RESULT " + JSON.stringify({ view: state.stateFor(ref).state, disk: JSON.parse(readFileSync(root + "/state.json", "utf8")).providers["openai-codex"].accounts[ref.id] }));
`;

async function restarted(
  root: string,
  at: number,
  requestId: string,
  operation = "estimate"
): Promise<any> {
  const child = Bun.spawn([process.execPath, "-e", restartProgram], {
    cwd: resolve(src, ".."),
    env: {
      ...process.env,
      HOME: root,
      TEST_SRC: src,
      AT: String(at),
      REQUEST_ID: requestId,
      OP: operation,
      MUTATION: process.env.ACCOUNTS_2A_RESET_MUTATION ?? "",
      CLAUDISH_ACCOUNTS_DIR: join(root, "accounts"),
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_OP: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  const line = stdout.split("\n").find((line) => line.startsWith("RESULT "));
  expect(line, stdout + stderr).toBeDefined();
  return JSON.parse(line!.slice(7));
}

test("E6 estimates persist 15/30/60/120/240/300/300 minutes across actual process restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudish-2a-estimates-"));
  try {
    let at = now;
    for (const [index, minutes] of [15, 30, 60, 120, 240, 300, 300].entries()) {
      const result = await restarted(root, at, `request-${index}`);
      expect(result.view.exhaustedUntil).toBe(at + minutes * minute);
      expect(result.view.exhaustedEstimated).toBe(true);
      expect(result.disk.quotaEstimateCount).toBe(Math.min(index + 1, 6));
      const duplicate = await restarted(root, at, `request-${index}`);
      expect(duplicate.disk).toEqual(result.disk);
      at = result.view.exhaustedUntil + 1;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function isolatedPool(root: string): { pool: AccountPool; state: StateStore; ref: AccountRef } {
  const ref: AccountRef = { provider: "openai-codex", id: "aaaaaaaaaaaa", label: "A" };
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      subscriptionAccounts: {
        "openai-codex": {
          generation: 1,
          accounts: [ref, { ...ref, id: "bbbbbbbbbbbb", label: "B" }].map((row) => ({
            ...row,
            store: "file",
            addedAt: "2026-09-12T00:00:00Z",
          })),
        },
      },
    })
  );
  const state = new StateStore({
    path: join(root, "state.json"),
    lockPath: join(root, "state.lock"),
    now: () => now,
  });
  const registry = new AccountRegistry({
    configPath: () => config,
    legacyCodexPath: () => join(root, "absent-legacy"),
  });
  const pool = new AccountPool("openai-codex", {
    state,
    registry,
    now: () => now,
    storeFactory: () => ({
      kind: "file",
      describe: () => "injected store",
      read: async () => {
        throw new Error("unexpected token read");
      },
      write: async () => {
        throw new Error("unexpected token write");
      },
      delete: async () => {
        throw new Error("unexpected token delete");
      },
    }),
  });
  return { pool, state, ref };
}

test("E19 duplicate usage then quota upgrades once and keeps newest inactive-account usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudish-2a-fold-"));
  const savedLog = process.env.CLAUDISH_ACCOUNTS_LOG;
  try {
    process.env.CLAUDISH_ACCOUNTS_LOG = join(root, "outcomes.jsonl");
    const { pool, state, ref } = isolatedPool(root);
    await state.setActive("openai-codex", "bbbbbbbbbbbb");
    const fold: AccountOutcomeFold = new Map();
    const reports: string[] = [];
    const report = pool.report.bind(pool);
    pool.report = async (...args) => {
      reports.push(args[1].kind);
      await report(...args);
    };
    const fresh = {
      observedAt: now,
      windows: [
        { slot: "primary", displayId: "primary", usedFraction: 0.8, resetAt: now + minute },
      ],
    };
    const base = { requestId: "one-request", account: ref, observedAt: now };
    await reportAccountOutcome({ ...base, outcome: { kind: "usage", usage: fresh } }, fold, pool);
    await reportAccountOutcome({ ...base, outcome: { kind: "usage", usage: fresh } }, fold, pool);
    await reportAccountOutcome(
      {
        ...base,
        usage: { ...fresh, observedAt: now - 1 },
        outcome: { kind: "quota", resetAt: now + 30 * minute, estimated: false },
      },
      fold,
      pool
    );
    await reportAccountOutcome(
      {
        ...base,
        usage: { ...fresh, observedAt: now - 1 },
        outcome: { kind: "quota", resetAt: now + 30 * minute, estimated: false },
      },
      fold,
      pool
    );
    await state.flush();
    expect(reports).toEqual(["usage", "quota"]);
    expect(fold.size).toBe(1);
    expect([...fold.values()][0]).toMatchObject({ pending: false, outcome: { kind: "quota" } });
    expect(state.activeId("openai-codex")).toBe("bbbbbbbbbbbb");
    expect(state.stateFor(ref).state).toMatchObject({
      usage: fresh,
      exhaustedUntil: now + 30 * minute,
      exhaustedEstimated: false,
      quotaEstimateCount: 0,
    });
    const disk = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    expect(disk.providers["openai-codex"].accounts[ref.id].usage).toEqual(fresh);
    expect(readFileSync(process.env.CLAUDISH_ACCOUNTS_LOG, "utf8").trim().split("\n")).toHaveLength(
      2
    );
  } finally {
    if (savedLog === undefined) delete process.env.CLAUDISH_ACCOUNTS_LOG;
    else process.env.CLAUDISH_ACCOUNTS_LOG = savedLog;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["persist", "report", "log"]) {
  test(`E19 ${failure} failure retains pending quota/status and excludes A without a refresh gate`, async () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-2a-pending-"));
    const savedLog = process.env.CLAUDISH_ACCOUNTS_LOG;
    const diagnostic = spyOn(logger, "log");
    try {
      const { pool, state, ref } = isolatedPool(root);
      const fold: AccountOutcomeFold = new Map();
      if (failure === "persist") mkdirSync(join(root, "state.json"));
      if (failure === "report")
        pool.report = async () => {
          throw new Error("simulated reporter failure");
        };
      process.env.CLAUDISH_ACCOUNTS_LOG = failure === "log" ? root : join(root, "outcomes.jsonl");
      await expect(
        reportAccountOutcome(
          {
            requestId: "pending-request",
            account: ref,
            outcome: { kind: "quota", resetAt: now + 30 * minute, estimated: false },
            observedAt: now,
          },
          fold,
          pool
        )
      ).resolves.toBeUndefined();
      expect(state.stateFor(ref).state.exhaustedUntil).toBe(now + 30 * minute);
      expect(pool.describe().accounts.find((row) => row.ref.id === ref.id)).toMatchObject({
        eligible: false,
        blocker: { kind: "exhausted" },
      });
      const messages = diagnostic.mock.calls.map((call) => call[0]).join("\n");
      expect(messages).toMatch(
        failure === "log" ? /outcome log could not be appended/ : /pending|not persisted/
      );
      if (failure !== "log") expect(pool.describe().dropped.length).toBeGreaterThan(0);
      if (failure === "report") {
        expect([...fold.values()][0].pending).toBe(true);
        await state.flush(); // Do not leave a beforeExit flush to recreate the cleaned root.
      }
      if (failure === "persist") {
        rmSync(join(root, "state.json"), { recursive: true });
        await state.flush();
        expect(
          JSON.parse(readFileSync(join(root, "state.json"), "utf8")).providers["openai-codex"]
            .accounts[ref.id].exhaustedUntil
        ).toBe(now + 30 * minute);
        expect(pool.describe().dropped).toEqual([]);
      }
    } finally {
      diagnostic.mockRestore();
      if (savedLog === undefined) delete process.env.CLAUDISH_ACCOUNTS_LOG;
      else process.env.CLAUDISH_ACCOUNTS_LOG = savedLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("C7 outcome JSONL has only allowlisted metadata, mode 0600 and no secret fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudish-2a-jsonl-"));
  const savedLog = process.env.CLAUDISH_ACCOUNTS_LOG;
  try {
    const log = join(root, "outcomes.jsonl");
    process.env.CLAUDISH_ACCOUNTS_LOG = log;
    writeFileSync(log, "", { mode: 0o644 });
    const { pool, ref } = isolatedPool(root);
    const secret = "simulated-secret-marker";
    const payload = {
      requestId: "log-request",
      account: ref,
      outcome: {
        kind: "quota" as const,
        resetAt: now + minute,
        estimated: false,
        body: secret,
        accessToken: secret,
      },
      observedAt: now,
      reason: "quota-switch",
      email: secret,
      refreshToken: secret,
      callback: "?code=" + secret,
      verifier: secret,
    };
    await reportAccountOutcome(payload, new Map(), pool);
    const text = readFileSync(log, "utf8");
    const row = JSON.parse(text);
    expect(Object.keys(row).sort()).toEqual(
      [
        "requestId",
        "provider",
        "accountId",
        "label",
        "reason",
        "outcome",
        "resetAt",
        "estimated",
        "arm",
      ].sort()
    );
    expect(row).toMatchObject({
      requestId: "log-request",
      accountId: ref.id,
      outcome: "quota",
      arm: "oauth",
      estimated: false,
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain("?code=");
    expect(statSync(log).mode & 0o777).toBe(0o600);
  } finally {
    if (savedLog === undefined) delete process.env.CLAUDISH_ACCOUNTS_LOG;
    else process.env.CLAUDISH_ACCOUNTS_LOG = savedLog;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["authoritative", "success"]) {
  test(`E6 ${operation} evidence resets the persisted consecutive-estimate counter`, async () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-2a-reset-counter-"));
    try {
      const first = await restarted(root, now, "first");
      const at = first.view.exhaustedUntil + 1;
      const cleared = await restarted(root, at, "clear", operation);
      expect(cleared.disk.quotaEstimateCount).toBe(0);
      if (operation === "authoritative") expect(cleared.view.exhaustedEstimated).toBe(false);
      const nextAt = Math.max(cleared.view.exhaustedUntil ?? 0, at) + 1;
      const next = await restarted(root, nextAt, "next");
      expect(next.view.exhaustedUntil).toBe(nextAt + 15 * minute);
      expect(next.disk.quotaEstimateCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
