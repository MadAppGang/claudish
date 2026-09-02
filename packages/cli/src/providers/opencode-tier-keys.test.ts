/**
 * The two OpenCode tiers hold two keys, and neither may satisfy the other.
 *
 * `opencode-zen-go` is classified flat-rate BY NAME (`SUBSCRIPTION_PROVIDERS`),
 * so every credential able to reach it is reported `SUB` at `$0`. Until
 * 2026-09-02 it also aliased `OPENCODE_API_KEY` — the METERED Zen key — which
 * made "billed per token, displayed as a subscription" reachable with one env
 * var. The alias was justified by a comment claiming OpenCode refuses a key
 * across tiers with a 401. That claim was measured on `minimax-m3`, a model both
 * tiers serve (`ai-docs/reports/data/measurements-20260902.txt`):
 *
 *     CONTROL  Zen Go key -> /zen/go/v1/chat/completions -> 200
 *     CROSS    Zen Go key -> /zen/v1/chat/completions    -> 200   <- claim said 401
 *     BOGUS    fake key   -> /zen/v1/chat/completions    -> 401 AuthError
 *
 * The bogus control is what makes the cross-tier 200 mean acceptance rather than
 * an open door. So the alias rested on a false premise, and the direction that
 * costs money — a Zen-tier key against /zen/go — was never measured at all
 * (no Zen-tier key exists on this machine). The alias is gone.
 *
 * These tests pin the consequence at three altitudes, because the alias lived in
 * two tables and the failure of either is silent:
 *   1. the DEFINITION, which the credential authority builds from;
 *   2. `API_KEY_MAP`, which `--probe` builds its `hasCredentials` rows from —
 *      leaving it would have printed a credentialed `zgo@` row for a key the
 *      authority refuses;
 *   3. the live authority itself, asked the way production asks it.
 *
 * Hermetic by construction: an override config file that does not exist (so no
 * project overlay, no `~/.claudish/config.json`, and `hasOpSources()` is false
 * on its own), the keychain and 1Password backends switched off, and every
 * OPENCODE env var saved and restored. No `mock.module` — the registry bleed it
 * causes has broken sibling e2e files here before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetSniffForTests } from "../auth/credentials/op-source.js";
import { getConfigFileOverride, setConfigFileOverride } from "../config-override.js";
import { API_KEY_MAP } from "./api-key-map.js";
import {
  BUILTIN_PROVIDERS,
  describeMissingCredential,
  getApiKeyEnvVars,
  getApiKeyInfo,
  getProviderByName,
} from "./provider-definitions.js";
import { getProviderApiKeyEnv } from "./routing-hints.js";

const GO = "opencode-zen-go";
const ZEN = "opencode-zen";
const GO_KEY = "OPENCODE_GO_API_KEY";
const ZEN_KEY = "OPENCODE_API_KEY";

// ---------------------------------------------------------------------------
// 1. The definition
// ---------------------------------------------------------------------------

describe("opencode-zen-go — the definition after the alias removal", () => {
  test("declares its own key and NO alias onto the metered Zen key", () => {
    const go = BUILTIN_PROVIDERS.find((d) => d.name === GO);
    expect(go).toBeDefined();
    expect(go!.apiKeyEnvVar).toBe(GO_KEY);
    // Not "does not contain ZEN_KEY" — there is no alias at all, and an alias
    // list appearing here again is the thing to notice.
    expect(go!.apiKeyAliases).toBeUndefined();
  });

  test("names the metered key as a SIBLING, so the remedy can explain itself", () => {
    const go = getProviderByName(GO)!;
    expect(go.siblingKeyEnvVars).toEqual([ZEN_KEY]);
    // The sibling is explanatory only: it must never be consulted for auth.
    expect(getApiKeyEnvVars(GO)).toEqual({ envVar: GO_KEY, aliases: undefined });
  });

  test("the metered tier still owns OPENCODE_API_KEY and gains nothing from this", () => {
    const zen = BUILTIN_PROVIDERS.find((d) => d.name === ZEN)!;
    expect(zen.apiKeyEnvVar).toBe(ZEN_KEY);
    expect(zen.apiKeyAliases).toBeUndefined();
    // The reverse alias would be the same defect mirrored.
    expect(zen.siblingKeyEnvVars ?? []).not.toContain(GO_KEY);
  });
});

// ---------------------------------------------------------------------------
// 2. The second and third tables that answer the same question
// ---------------------------------------------------------------------------

describe("opencode-zen-go — every key table agrees", () => {
  test("API_KEY_MAP (the --probe credential rows) carries no alias either", () => {
    const go = getProviderByName(GO)!;
    expect(API_KEY_MAP[GO]).toEqual({ envVar: go.apiKeyEnvVar, aliases: go.apiKeyAliases });
    expect(API_KEY_MAP[GO]?.aliases ?? []).not.toContain(ZEN_KEY);
  });

  test("the routing hint names the key, so zgo@ cannot vanish unexplained", () => {
    // opencode-zen-go heads seven default chains; with no hint entry a bare
    // `deepseek-v4-pro` on an empty machine listed DeepSeek and OpenRouter and
    // never mentioned the plan it would have tried first.
    expect(getProviderApiKeyEnv(GO)).toBe(GO_KEY);
    expect(getProviderApiKeyEnv(ZEN)).toBe(ZEN_KEY);
  });
});

// ---------------------------------------------------------------------------
// 3. The live credential authority
// ---------------------------------------------------------------------------

const HERMETIC_CONFIG = join(tmpdir(), `claudish-opencode-tiers-${process.pid}-absent.json`);

describe("opencode-zen-go — credential resolution through the real authority", () => {
  const saved = new Map<string, string | undefined>();
  let savedConfigOverride: string | null = null;
  let credentials: typeof import("../auth/credentials/authority.js").credentials;

  beforeEach(async () => {
    ({ credentials } = await import("../auth/credentials/authority.js"));
    savedConfigOverride = getConfigFileOverride();
    for (const v of [ZEN_KEY, GO_KEY, "CLAUDISH_DISABLE_KEYCHAIN", "CLAUDISH_DISABLE_OP"]) {
      saved.set(v, process.env[v]);
    }
    delete process.env[ZEN_KEY];
    delete process.env[GO_KEY];
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    setConfigFileOverride(HERMETIC_CONFIG);
    __resetSniffForTests();
    credentials.invalidate(GO);
    credentials.invalidate(ZEN);
  });

  afterEach(() => {
    for (const [v, value] of saved) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
    saved.clear();
    setConfigFileOverride(savedConfigOverride);
    __resetSniffForTests();
    // The authority memoizes per provider; a resolution made under this file's
    // env must not answer for the next file.
    credentials.invalidate(GO);
    credentials.invalidate(ZEN);
  });

  test("neither tier is available with no key at all", async () => {
    expect(await credentials.isAvailable(GO)).toBe(false);
    expect(await credentials.isAvailable(ZEN)).toBe(false);
  });

  test("OPENCODE_API_KEY alone does NOT satisfy zgo@ — and DOES satisfy zen@", async () => {
    process.env[ZEN_KEY] = "sk-zen-tier-only";
    credentials.invalidate(GO);
    credentials.invalidate(ZEN);

    // The whole point of the change: a metered Zen key cannot reach a provider
    // that reports SUB and $0.
    expect(await credentials.isAvailable(GO)).toBe(false);
    // The control, and the reason the line above means something. Without it a
    // broken fixture (env not visible to the authority, wrong config override)
    // would produce the same `false` and read as a pass.
    expect(await credentials.isAvailable(ZEN)).toBe(true);
  });

  test("OPENCODE_GO_API_KEY alone satisfies zgo@ and nothing else", async () => {
    process.env[GO_KEY] = "sk-go-plan-only";
    credentials.invalidate(GO);
    credentials.invalidate(ZEN);

    expect(await credentials.isAvailable(GO)).toBe(true);
    expect(await credentials.isAvailable(ZEN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. What the user reads
// ---------------------------------------------------------------------------

describe("opencode-zen-go — the missing-credential sentence", () => {
  const msg = () => describeMissingCredential(GO);

  test("names the key to set, with somewhere to get one", () => {
    expect(msg()).toContain(`Set ${GO_KEY}`);
    expect(msg()).toContain(getApiKeyInfo(GO)!.url);
  });

  test("never offers the Zen key as a way to satisfy this provider", () => {
    // The alias used to make this sentence read "Set OPENCODE_GO_API_KEY or
    // OPENCODE_API_KEY", i.e. instructions for the money-losing path.
    expect(msg()).not.toContain(`Set ${GO_KEY} or ${ZEN_KEY}`);
  });

  test("explains the key the user probably already has, and whose it is", () => {
    // A user upgrading into this change holds OPENCODE_API_KEY and had zgo@
    // working. "Set OPENCODE_GO_API_KEY" alone invites them to export the key
    // they have under the new name and collect a 401 they cannot attribute.
    expect(msg()).toContain(`${ZEN_KEY} (${ZEN})`);
    expect(msg()).toContain("is not accepted here");
  });

  test("the note is opt-in — a provider declaring no sibling reads exactly as before", () => {
    const zen = getApiKeyInfo(ZEN)!;
    expect(describeMissingCredential(ZEN)).toBe(
      `No API key for provider "${ZEN}". Set ${zen.envVar} (env, config, or 1Password import).` +
        ` Get one at ${zen.url}.`
    );
  });
});
