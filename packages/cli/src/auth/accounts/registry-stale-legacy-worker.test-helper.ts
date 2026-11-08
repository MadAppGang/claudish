/**
 * Isolated child for registry-stale-legacy.test.ts (MTL-372, review round 3,
 * R3-1). Runs under a temp HOME with `CLAUDISH_DISABLE_KEYCHAIN=1` KEPT, so
 * the request-path legacy move never starts and no `security` is spawned. The
 * metered half is an in-memory fake carrying a canary bearer; no vault, no
 * network.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialProvider, RequestAuth } from "../credentials/types.js";

const scenario = process.argv[2]!;
const home = process.env.HOME!;
assert.ok(home && home !== "/", "a dedicated temp HOME is mandatory");
assert.equal(process.env.CLAUDISH_DISABLE_KEYCHAIN, "1", "the move must stay off in this child");

const { AccountRegistry, setAccountRegistryForTests } = await import("./registry.js");
const { AccountListUnavailableError } = await import("./errors.js");
const { CodexPoolHalf } = await import("../credentials/codex-credential.js");
const { CompositeCredentialProvider } = await import("../credentials/composite-credential.js");

const appHome = join(home, ".claudish");
mkdirSync(appHome, { recursive: true, mode: 0o700 });
const configPath = join(appHome, "config.json");
const legacyPath = join(appHome, "codex-oauth.json");

/** While set, every read of config.json fails as an EACCES would. */
let failConfigRead = false;
const registry = new AccountRegistry({
  env: process.env,
  configPath: () => configPath,
  legacyCodexPath: () => legacyPath,
  readFile: (path) => {
    if (failConfigRead && path === configPath) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: "EACCES",
      });
    }
    return readFileSync(path, "utf-8");
  },
});
setAccountRegistryForTests(registry);

function writeConfig(rows: unknown[], marker: boolean): void {
  writeFileSync(
    configPath,
    `${JSON.stringify({
      subscriptionAccounts: {
        "openai-codex": {
          generation: rows.length + 1,
          accounts: rows,
          ...(marker ? { legacyCodexSuppressed: true } : {}),
        },
      },
    })}\n`,
    { mode: 0o600 }
  );
}
function writeLegacyFile(): void {
  writeFileSync(
    legacyPath,
    JSON.stringify({
      access_token: "legacy-access-marker",
      refresh_token: "legacy-refresh-marker",
      expires_at: Date.now() + 3_600_000,
      account_id: "test-codex-identity",
    }),
    { mode: 0o600 }
  );
}
const keychainRow = {
  id: "aaaaaaaaaaaa",
  label: "default",
  store: "keychain",
  enabled: true,
  identity: { chatgptAccountId: "test-codex-identity" },
  addedAt: "2026-01-02T03:04:05.000Z",
};

/** The pre-move list (0 rows, synthesized legacy), then the move, then a failed config read. */
function warmThenMoveThenFailConfig(): void {
  writeConfig([], false);
  writeLegacyFile();
  registry.invalidate();
  assert.equal(registry.isSynthesizedLegacyOnly(), true, "warm: the synthesized legacy login");
  writeConfig([keychainRow], true); // M6
  rmSync(legacyPath); // M8
  failConfigRead = true;
  registry.invalidate();
}

/** Throws or answers true; never false-without-throw. */
function presence(): "throws" | boolean {
  try {
    return registry.hasConfiguredAccounts("openai-codex");
  } catch (err) {
    assert.ok(err instanceof AccountListUnavailableError, `unexpected ${String(err)}`);
    return "throws";
  }
}

const legacyHalf: CredentialProvider = {
  catalogName: "openai-codex",
  isAvailable: async () => true,
  getRequestAuth: async (): Promise<RequestAuth> => ({
    arm: "oauth",
    headers: { Authorization: "Bearer legacy-oauth-canary" },
  }),
};
const meteredHalf: CredentialProvider = {
  catalogName: "openai-codex",
  isAvailable: async () => true,
  getRequestAuth: async (): Promise<RequestAuth> => ({
    headers: { Authorization: "Bearer METERED-canary" },
  }),
};

switch (scenario) {
  case "config-failed-after-move": {
    warmThenMoveThenFailConfig();

    const composite = new CompositeCredentialProvider(
      "openai-codex",
      new CodexPoolHalf(registry, undefined, legacyHalf),
      meteredHalf
    );
    let auth: RequestAuth | undefined;
    let error: unknown;
    try {
      auth = await composite.getRequestAuth({ model: "gpt-test" });
    } catch (err) {
      error = err;
    }
    const bearer = auth?.headers.Authorization ?? "";
    assert.equal(bearer.includes("METERED"), false, "the composite must not sign metered");
    assert.ok(auth?.arm === "oauth" || error !== undefined, "OAuth or a refusal");

    assert.notEqual(presence(), false, "never 'no accounts' from a stale config + fresh file");
    assert.equal(registry.mayHaveConfiguredAccounts("openai-codex"), true);
    break;
  }
  case "config-recovers": {
    // Control: once config.json reads again, the moved list (keychain row) is served.
    warmThenMoveThenFailConfig();
    failConfigRead = false;
    registry.invalidate();
    const rows = registry.listAccounts("openai-codex");
    assert.deepEqual(
      rows.map((r) => r.store),
      ["keychain"]
    );
    break;
  }
  case "claude-scope-ignores-legacy": {
    // Control: a torn legacy file at warm-up leaves no legacy copy. With the
    // config failing next, the Codex answer throws; the Claude answer does not.
    writeConfig([], false);
    writeFileSync(legacyPath, '{"refresh_tok', { mode: 0o600 });
    registry.invalidate();
    assert.throws(() => registry.snapshot("openai-codex"), AccountListUnavailableError);
    writeConfig([], true);
    failConfigRead = true;
    registry.invalidate();
    assert.throws(() => registry.snapshot("openai-codex"), AccountListUnavailableError);
    assert.doesNotThrow(() => registry.snapshot("native-anthropic"));
    break;
  }
  default:
    throw new Error(`unknown scenario: ${scenario}`);
}
