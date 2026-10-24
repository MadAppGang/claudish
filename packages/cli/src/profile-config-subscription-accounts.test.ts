import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClaudishProfileConfig,
  loadConfig,
  saveConfig,
  setConfigFileOverride,
} from "./profile-config.js";

let dir = "";
let configPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-profile-accounts-test-"));
  configPath = join(dir, "config.json");
  setConfigFileOverride(configPath);
});

afterEach(() => {
  setConfigFileOverride(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("subscriptionAccounts profile config", () => {
  test("survives load followed by an unrelated save", () => {
    const subscriptionAccounts = {
      "openai-codex": {
        enabled: true,
        switchAt: 0.88,
        switchAtByWindow: { primary: 0.8 },
        generation: 7,
        accounts: [
          {
            id: "abc123def456",
            label: "work",
            identity: { email: "work@example.test", plan: "pro" },
            store: "file",
            addedAt: "2026-09-12T00:00:00.000Z",
          },
        ],
      },
    };
    const initial: ClaudishProfileConfig = {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts,
      debug: false,
    };
    // Accounts are disk-owned; global saves cannot publish an in-memory list.
    writeFileSync(configPath, JSON.stringify(initial));

    const loaded = loadConfig();
    expect(loaded.subscriptionAccounts).toEqual(subscriptionAccounts);
    saveConfig({ ...loaded, debug: true });

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as ClaudishProfileConfig;
    expect(onDisk.subscriptionAccounts).toEqual(subscriptionAccounts);
    expect(onDisk.debug).toBe(true);

    // Mutation caught: remove subscriptionAccounts from loadConfig's allowlist;
    // the first assertion loses it and the unrelated save deletes it from disk.
  });
});
