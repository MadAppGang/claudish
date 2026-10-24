import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool } from "../accounts/pool.js";
import { AccountRegistry } from "../accounts/registry.js";
import { StateStore } from "../accounts/state-store.js";
import { CodexPoolHalf } from "./codex-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

// E20 structural evidence only: the retained facade's builders remain its own.
// This does not claim byte equality between separately built pinned binaries.
for (const forceRefresh of [false, true]) {
  test(`E20 synthesized legacy delegates verbatim with forceRefresh=${forceRefresh}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "claudish-2a-legacy-"));
    try {
      const config = join(root, "config.json");
      const legacy = join(root, "codex-oauth.json");
      writeFileSync(config, "{}");
      writeFileSync(
        legacy,
        JSON.stringify({
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          expires_at: Date.now() + 3_600_000,
        })
      );
      const registry = new AccountRegistry({
        configPath: () => config,
        legacyCodexPath: () => legacy,
      });
      const pool = new AccountPool("openai-codex", {
        registry,
        state: new StateStore({
          path: join(root, "state.json"),
          lockPath: join(root, "state.lock"),
        }),
        storeFactory: () => {
          throw new Error("legacy delegation must not lease from the pool");
        },
      });
      const artifact: RequestAuth = Object.freeze({
        arm: "oauth",
        headers: Object.freeze({ Authorization: "Bearer legacy-access" }),
      });
      const contexts: RequestAuthContext[] = [];
      const facade: CredentialProvider = {
        catalogName: "openai-codex",
        isAvailable: async () => {
          throw new Error("the registry decides presence");
        },
        getRequestAuth: async (context) => {
          contexts.push(context);
          return artifact;
        },
      };
      const half = new CodexPoolHalf(registry, pool, facade);
      const before = [readFileSync(config, "utf8"), readFileSync(legacy, "utf8")];
      const context = { model: "gpt-test", forceRefresh, requireOAuth: true };
      expect(await half.isAvailable()).toBe(true);
      const result = await half.getRequestAuth(context);
      expect(result).toBe(artifact);
      expect(result.account).toBeUndefined();
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toBe(context);
      expect([readFileSync(config, "utf8"), readFileSync(legacy, "utf8")]).toEqual(before);
      const rejected = new Error("retained legacy refresh rejection");
      facade.getRequestAuth = async () => {
        throw rejected;
      };
      await expect(half.getRequestAuth(context)).rejects.toBe(rejected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("E20 suppression never delegates to a surviving legacy file", async () => {
  const root = mkdtempSync(join(tmpdir(), "claudish-2a-suppressed-"));
  try {
    const config = join(root, "config.json");
    const legacy = join(root, "codex-oauth.json");
    writeFileSync(
      config,
      JSON.stringify({
        subscriptionAccounts: {
          "openai-codex": { generation: 1, accounts: [], legacyCodexSuppressed: true },
        },
      })
    );
    // Even unreadable debris is irrelevant after committed suppression.
    mkdirSync(legacy);
    const registry = new AccountRegistry({
      configPath: () => config,
      legacyCodexPath: () => legacy,
    });
    const pool = new AccountPool("openai-codex", {
      registry,
      state: new StateStore({ path: join(root, "state.json"), lockPath: join(root, "state.lock") }),
    });
    const facade: CredentialProvider = {
      catalogName: "openai-codex",
      isAvailable: async () => true,
      getRequestAuth: async () => {
        throw new Error("legacy facade must not be called");
      },
    };
    const half = new CodexPoolHalf(registry, pool, facade);
    expect(await half.isAvailable()).toBe(false);
    await expect(half.getRequestAuth({ model: "gpt-test", requireOAuth: true })).rejects.toThrow(
      "account list disappeared"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
