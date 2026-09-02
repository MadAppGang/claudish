/**
 * `describeMissingCredential` — the sentence a user reads when an explicit
 * `provider@model` produced no handler.
 *
 * It is the only place claudish tells someone what to do about a credential,
 * and the two error directions are NOT symmetric: omitting a signup URL costs a
 * search, while telling a ChatGPT Plus subscriber to go and buy metered API
 * access costs money. Same reasoning that keeps `openai-codex` out of
 * `SUBSCRIPTION_PROVIDERS`.
 *
 * Everything here is derived from the live definitions rather than pinned to a
 * roster: which providers are local, and which carry an `oauthFallback`, are
 * both read at run time, so adding a provider cannot leave a stale list behind.
 */

import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PROVIDERS,
  describeMissingCredential,
  getApiKeyInfo,
  getProviderByName,
  isLocalTransport,
} from "./provider-definitions.js";

const oauthProviders = BUILTIN_PROVIDERS.filter((d) => d.oauthFallback).map((d) => d.name);
const localProviders = BUILTIN_PROVIDERS.filter((d) => isLocalTransport(d.name)).map((d) => d.name);

/**
 * The trailing clause a provider gets for declaring `siblingKeyEnvVars` — the
 * same vendor's OTHER key, which this provider does not accept.
 *
 * Rebuilt here from the definition rather than copied as a literal, so the
 * exact-sentence test below stays a statement about the OTHER three shapes and
 * does not silently become a pin on this one. The owner lookup mirrors
 * `describeSiblingKeys`: whichever provider claims that variable as its primary.
 */
function siblingClause(name: string): string {
  const def = getProviderByName(name);
  const vars = def?.siblingKeyEnvVars ?? [];
  if (vars.length === 0) return "";
  const named = vars.map((v) => {
    const owner = BUILTIN_PROVIDERS.find((p) => p.name !== name && p.apiKeyEnvVar === v);
    return owner ? `${v} (${owner.name})` : v;
  });
  return ` Note: ${named.join(" or ")} is a DIFFERENT plan's key and is not accepted here.`;
}

describe("describeMissingCredential — dual-mode (OAuth) providers", () => {
  test("the catalog actually contains some, or the block below is vacuous", () => {
    expect(oauthProviders.length).toBeGreaterThan(0);
  });

  for (const name of oauthProviders) {
    test(`${name}: names the sign-in path BEFORE the purchase path`, () => {
      const msg = describeMissingCredential(name);
      expect(msg).toContain(`claudish login ${name}`);
      const signInAt = msg.indexOf("claudish login");
      const keyAt = msg.indexOf("Or set ");
      expect(signInAt).toBeGreaterThanOrEqual(0);
      if (keyAt >= 0) expect(signInAt).toBeLessThan(keyAt);
    });

    test(`${name}: the metered key path is still offered`, () => {
      const info = getApiKeyInfo(name);
      if (!info?.envVar) return;
      expect(describeMissingCredential(name)).toContain(info.envVar);
    });
  }

  test("the printed `claudish login <name>` command actually resolves", async () => {
    // The hint interpolates the CANONICAL provider name rather than consulting
    // a second name table. That is the right call, and this is what keeps it
    // true: the failure mode of the coupling rotting is a printed command that
    // silently does not work.
    const { findProvider } = await import("../auth/auth-commands.js");
    for (const name of oauthProviders) {
      expect(findProvider(name)).not.toBeNull();
    }
  });
});

describe("describeMissingCredential — local providers", () => {
  test("the catalog actually contains some, or the block below is vacuous", () => {
    expect(localProviders.length).toBeGreaterThan(0);
  });

  for (const name of localProviders) {
    test(`${name}: leads with 'not enabled', not with an API key`, () => {
      const msg = describeMissingCredential(name);
      // The real cause: LocalCredentialProvider.isAvailable() is
      // isLocalProviderEnabled(name), i.e. config.localProviders membership.
      expect(msg).toContain("LOCAL server and is not enabled");
      expect(msg).toContain("localProviders");
      expect(msg.startsWith("No API key")).toBe(false);
    });

    test(`${name}: any key variable is secondary and conditional`, () => {
      const info = getApiKeyInfo(name);
      const msg = describeMissingCredential(name);
      if (!info?.envVar) return;
      expect(msg).toContain(`Only set ${info.envVar}`);
      expect(msg).not.toContain(`Set ${info.envVar} (env, config, or 1Password import)`);
    });

    test(`${name}: names where claudish will look`, () => {
      const def = getProviderByName(name);
      expect(def).toBeDefined();
      if (!def) return;
      expect(describeMissingCredential(name)).toContain(def.baseUrl);
    });
  }
});

describe("describeMissingCredential — everything else is unchanged", () => {
  const plain = BUILTIN_PROVIDERS.filter((d) => !d.oauthFallback && !isLocalTransport(d.name)).map(
    (d) => d.name
  );

  test("plain providers keep today's exact sentence", () => {
    expect(plain.length).toBeGreaterThan(0);
    for (const name of plain) {
      const info = getApiKeyInfo(name);
      const keyNames = info?.envVar
        ? [info.envVar, ...(info.aliases ?? [])].join(" or ")
        : undefined;
      const signup = info?.url ? ` Get one at ${info.url}.` : "";
      // `siblingKeyEnvVars` appends one clause and is declared by almost nobody,
      // so the expectation is derived from the SAME field rather than pinned to
      // a roster — a provider adopting it later must not have to edit this test,
      // and one that quietly LOSES the declaration must still fail below.
      const expected = keyNames
        ? `No API key for provider "${name}". Set ${keyNames} (env, config, or 1Password import).${signup}${siblingClause(name)}`
        : `No API key for provider "${name}".${siblingClause(name)}`;
      expect(describeMissingCredential(name)).toBe(expected);
    }
  });

  test("the sibling clause is opt-in, and at least one provider opts in", () => {
    const declaring = BUILTIN_PROVIDERS.filter((d) => (d.siblingKeyEnvVars ?? []).length > 0);
    // Vacuity guard: with no declarer, `siblingClause` returns "" everywhere and
    // the test above would pass against a describeMissingCredential that had
    // dropped the feature entirely.
    expect(declaring.length).toBeGreaterThan(0);
    for (const d of declaring) {
      expect(describeMissingCredential(d.name)).toContain("is not accepted here");
    }
    const silent = BUILTIN_PROVIDERS.filter((d) => !(d.siblingKeyEnvVars ?? []).length);
    for (const d of silent) {
      expect(describeMissingCredential(d.name)).not.toContain("is not accepted here");
    }
  });

  test("an unknown provider still gets the bare sentence", () => {
    expect(describeMissingCredential("no-such-provider")).toBe(
      'No API key for provider "no-such-provider".'
    );
  });
});
