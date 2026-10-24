import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountCommand } from "./account-command.js";
import {
  AccountPool,
  resetAccountPoolsForTests,
  setAccountPoolForTests,
} from "./auth/accounts/pool.js";
import { AccountRegistry, setAccountRegistryForTests } from "./auth/accounts/registry.js";
import { StateStore, setStateStoreForTests } from "./auth/accounts/state-store.js";
import type { TokenStore } from "./auth/accounts/token-store.js";

let dir = "";
let configPath = "";
let legacyPath = "";
let statePath = "";
let stateLockPath = "";

const displayStore: TokenStore = {
  kind: "file",
  read: async () => {
    throw new Error("accountCommand must not read token material");
  },
  write: async () => {
    throw new Error("accountCommand must not write token material");
  },
  delete: async () => {
    throw new Error("accountCommand must not delete token material");
  },
  describe: () => "isolated test store",
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function installPools(now = Date.parse("2026-09-12T12:00:00.000Z")): void {
  const registry = new AccountRegistry({
    configPath: () => configPath,
    legacyCodexPath: () => legacyPath,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
  });
  const state = new StateStore({
    path: statePath,
    lockPath: stateLockPath,
    now: () => now,
  });
  setAccountRegistryForTests(registry);
  setStateStoreForTests(state);
  for (const provider of ["native-anthropic", "openai-codex"] as const) {
    setAccountPoolForTests(
      provider,
      new AccountPool(provider, {
        registry,
        state,
        now: () => now,
        storeFactory: () => displayStore,
        env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
      })
    );
  }
}

async function capture(args: string[]): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    await accountCommand(args);
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(sgr, "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-account-command-test-"));
  configPath = join(dir, "config.json");
  legacyPath = join(dir, "codex-oauth.json");
  statePath = join(dir, "state.json");
  stateLockPath = join(dir, "state.lock");
  process.exitCode = 0;
});

afterEach(() => {
  resetAccountPoolsForTests();
  setAccountRegistryForTests(null);
  setStateStoreForTests(null);
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe("read-only account command", () => {
  test("list renders a legacy-only Codex account list without writing config", async () => {
    writeJson(legacyPath, {
      access_token: "legacy-access",
      refresh_token: "legacy-refresh",
      expires_at: 1,
      account_id: "acct-legacy",
    });
    installPools();

    const output = await capture(["list"]);

    expect(output).toContain("codex");
    expect(output).toContain("default (legacy file)");
    expect(output).toContain("never contacted · isolated test store");
    expect(() => readFileSync(configPath, "utf8")).toThrow();

    // Mutation caught: omit legacy synthesis from list, or persist it as a config
    // migration while rendering the read-only command.
  });

  test("status renders both vendors, usage, active state, and blockers", async () => {
    const commandNow = Date.now();
    writeJson(configPath, {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: {
        "native-anthropic": {
          generation: 1,
          accounts: [
            {
              id: "aaa111bbb222",
              label: "claude-work",
              identity: { plan: "max" },
              store: "file",
              addedAt: "2026-09-12T00:00:00.000Z",
            },
          ],
        },
        "openai-codex": {
          generation: 2,
          switchAt: 0.9,
          switchAtByWindow: { primary: 0.8 },
          accounts: [
            {
              id: "abc123def456",
              label: "codex-work",
              identity: { plan: "pro" },
              store: "file",
              addedAt: "2026-09-12T00:00:00.000Z",
            },
            {
              id: "def456abc123",
              label: "codex-spare",
              store: "file",
              addedAt: "2026-09-12T00:00:00.000Z",
            },
          ],
        },
      },
    });
    writeJson(statePath, {
      version: 1,
      providers: {
        "openai-codex": {
          active: "abc123def456",
          accounts: {
            abc123def456: {
              usage: {
                observedAt: Date.parse("2026-09-12T11:55:00.000Z"),
                windows: [
                  {
                    slot: "primary",
                    displayId: "7d",
                    lengthMinutes: 10_080,
                    usedFraction: 0.81,
                  },
                ],
              },
            },
            def456abc123: {
              exhaustedUntil: commandNow + 3_600_000,
            },
          },
        },
      },
    });
    installPools(commandNow);

    const output = await capture(["status"]);

    expect(output).toContain("claude-work");
    expect(output).toContain("codex-work");
    expect(output).toContain("7d 81%");
    expect(output).toContain("active");
    expect(output).toContain("codex-spare");
    expect(output).toMatch(/resets .*\(in 1h 0m\)/);
    expect(output).toContain("switch at 90% (per window: primary 80%)");

    // Mutation caught: render only one-account/legacy shapes, omit blocker detail,
    // or key the displayed threshold by displayId instead of the primary slot.
  });

  test("status refuses to describe an invalid account list as zero accounts", async () => {
    writeFileSync(configPath, '{"subscriptionAccounts":', "utf8");
    installPools();

    const output = await capture(["status"]);

    expect(output).toContain("Invalid account list in");
    expect(output).toContain(configPath);
    expect(output).toContain("invalid JSON");
    expect(output).toContain("Repair the named config field");
    expect(output).not.toContain("No subscription accounts are configured");

    // Mutation caught: catch the registry error as an empty report, which prints
    // the reassuring but false `No subscription accounts` message.
  });

  test.skipIf(process.getuid?.() === 0)(
    "status refuses to describe an unreadable account list as zero accounts",
    async () => {
      writeJson(configPath, {});
      chmodSync(configPath, 0);
      try {
        installPools();
        const output = await capture(["status"]);

        expect(output).toContain("Could not read the");
        expect(output).toContain(configPath);
        expect(output).toContain("Refusing to treat an unreadable account list as an empty one");
        expect(output).not.toContain("No subscription accounts are configured");
      } finally {
        chmodSync(configPath, 0o600);
      }
    }
  );

  test("--json emits parseable legacy and multi-account facts without token material", async () => {
    writeJson(configPath, {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: {
        "openai-codex": {
          generation: 1,
          accounts: [
            {
              id: "abc123def456",
              label: "work",
              identity: { email: "work@example.test" },
              store: "file",
              addedAt: "2026-09-12T00:00:00.000Z",
            },
          ],
        },
      },
    });
    installPools();

    const output = await capture(["status", "--json"]);
    const parsed = JSON.parse(output) as {
      providers: Array<{ provider: string; accounts?: Array<Record<string, unknown>> }>;
    };
    const codex = parsed.providers.find((provider) => provider.provider === "openai-codex");

    expect(codex?.accounts).toHaveLength(1);
    expect(codex?.accounts?.[0]).toMatchObject({
      id: "abc123def456",
      label: "work",
      identity: { email: "work@example.test" },
    });
    expect(output).not.toContain("access_token");
    expect(output).not.toContain("refresh_token");

    // Mutation caught: mix human decoration into --json or serialize token-store
    // records; JSON.parse fails or the forbidden credential keys appear.
  });
});
