import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../auth/credentials/authority.js";
import { deriveAccountKey, writeStoredModelsList } from "./dynamic-models-catalog-store.js";
import {
  _resetAccountModelsListsForTest,
  readAccountModelsList,
} from "./dynamic-models-catalog.js";

test("an external credential-file change cannot return the previous account's live list", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claudish-external-account-login-"));
  const credentialPath = join(directory, "credential");
  const options = {
    dir: join(directory, "dynamic-models-catalog"),
    keyPath: join(directory, "dynamic-models-catalog.key"),
  };
  const originalProvider = credentials.get("devin")!;
  const originalFetch = globalThis.fetch;
  const forbiddenFetch = mock(async () => {
    throw new Error("Network forbidden");
  });
  const modelsA = [{ id: "account-a-only", reported: "chat" as const }];
  const modelsB = [{ id: "account-b-only", reported: "chat" as const }];

  try {
    _resetAccountModelsListsForTest();
    globalThis.fetch = forbiddenFetch as unknown as typeof fetch;
    credentials.register({
      catalogName: "devin",
      isAvailable: async () => true,
      accountIdentity: async () => readFileSync(credentialPath, "utf8"),
      getRequestAuth: async () => ({ headers: {} }),
    });
    for (const [account, models] of [
      ["account-a", modelsA],
      ["account-b", modelsB],
    ] as const) {
      writeFileSync(credentialPath, account);
      const binding = deriveAccountKey(
        "devin",
        await credentials.accountIdentity("devin"),
        options
      );
      if (!binding.ok) throw new Error(binding.reason);
      expect(writeStoredModelsList("devin", binding.accountKey, [...models], options)).toBe(true);
    }
    writeFileSync(credentialPath, "account-a");
    const identityA = await credentials.accountIdentity("devin");
    expect(await readAccountModelsList("devin", options)).toMatchObject({
      models: modelsA,
      mayDeny: true,
    });

    // Another process replaces the credential source; it cannot invalidate our memory.
    writeFileSync(credentialPath, "account-b");
    expect(await credentials.accountIdentity("devin")).not.toBe(identityA);
    const afterLogin = await readAccountModelsList("devin", options);

    expect(forbiddenFetch).not.toHaveBeenCalled();
    expect(afterLogin?.models.map(({ id }) => id) ?? []).not.toContain("account-a-only");
    if (afterLogin) expect(afterLogin.models).toEqual(modelsB);
  } finally {
    credentials.register(originalProvider);
    globalThis.fetch = originalFetch;
    _resetAccountModelsListsForTest();
    rmSync(directory, { recursive: true, force: true });
  }
});
