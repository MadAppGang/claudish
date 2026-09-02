/**
 * FR-3 — `openai-codex` bills by the credential that SIGNS, not by its name.
 *
 * The one direction that costs the user real money is reporting SUB (and $0
 * accrued) while OpenAI meters the request. Every test here exists to make that
 * direction fail loudly.
 *
 * ── Hermetic strategy ─────────────────────────────────────────────────────────
 * No `mock.module`: Bun's module registry bleeds across files, and another file
 * may construct the real CodexOAuth singleton first (equivalence.test.ts:27-28
 * records why). No credential fixture under `$HOME`: guard-real-config.ts:31
 * sandboxes only config.json. Instead we use the seam equivalence.test.ts:136-152
 * established — override the real singleton's `hasCredentials` IN PLACE (the
 * authority's CodexOAuthHalf holds a reference to that same instance) — and, for
 * the trap case, drive the singleton's in-memory credential object so the REAL
 * predicate runs against it.
 *
 * Importing `authority.js` does read ~/.claudish/codex-oauth.json once, in the
 * CodexOAuth constructor. That read is pre-existing (authority.ts:235 → :157 →
 * codex-credential.ts:43) and no assertion below depends on its result: every test
 * sets the credential state it needs. The import is deliberate — it is the ONLY
 * production registration site for the probe, so it is what the wiring test tests.
 *
 * Save/restore is per test, and both the probe and the signed-arm record are
 * run-scoped module state that would otherwise bleed into sibling files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CREDENTIAL_DECIDED_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  getModelPricing,
  isSubscriptionProvider,
  registerSubscriptionCredentialProbe,
} from "../../handlers/shared/remote-provider-types.js";
import { CodexOAuth } from "../codex-oauth.js";
import { oauthCredentialWouldQualify } from "../oauth-registry.js";
import { clearSignedArm, recordSignedArm } from "./billing-probe.js";

// The one production registration site. Importing it is what installs the probe.
// The binding is also what lets the api-key-arm test below drive the REAL
// composite instead of a stub — see "FR-3: the REAL composite's api-key arm".
const { credentials } = await import("./authority.js");
// Imported dynamically, and AFTER the authority, only to keep the ordering above
// honest: this is the sole production writer of the signed-arm record.
const { OpenAICodexTransport } = await import("../../providers/transport/openai-codex.js");

const singleton = CodexOAuth.getInstance();

/** A model name that cannot be in any warmed dynamic pricing cache. */
const SYNTHETIC_MODEL = "billing-probe-test-model";

/** An obviously-fake OPENAI_CODEX_API_KEY. Never sent anywhere. */
const METERED_KEY = "sk-codex-metered-fixture";

type Mutable = { credentials: unknown; hasCredentials?: unknown };

let savedHasCredentials: PropertyDescriptor | undefined;
let savedCredentials: unknown;
let savedEnvCodexKey: string | undefined;

/** Drive "which credential WOULD sign" without touching the filesystem. */
function setHasCredentials(value: boolean): void {
  singleton.hasCredentials = () => value;
}

/** Restore the genuine prototype predicate so it runs against `credentials`. */
function useRealHasCredentials(): void {
  delete (singleton as unknown as Record<string, unknown>).hasCredentials;
}

/**
 * Put an own-property override back the way it was — which may be ABSENT (fall
 * through to the prototype) or another file's override, never assumed to be the
 * prototype method.
 */
function restoreOwn(target: object, key: string, saved: PropertyDescriptor | undefined): void {
  if (saved) Object.defineProperty(target, key, saved);
  else delete (target as Record<string, unknown>)[key];
}

beforeEach(() => {
  savedHasCredentials = Object.getOwnPropertyDescriptor(singleton, "hasCredentials");
  savedCredentials = (singleton as unknown as Mutable).credentials;
  savedEnvCodexKey = process.env.OPENAI_CODEX_API_KEY;
  clearSignedArm();
});

afterEach(() => {
  // Restore whatever was installed BEFORE this test — which may be another
  // file's override, not the prototype method.
  if (savedHasCredentials) {
    Object.defineProperty(singleton, "hasCredentials", savedHasCredentials);
  } else {
    delete (singleton as unknown as Record<string, unknown>).hasCredentials;
  }
  (singleton as unknown as Mutable).credentials = savedCredentials;
  if (savedEnvCodexKey === undefined) delete process.env.OPENAI_CODEX_API_KEY;
  else process.env.OPENAI_CODEX_API_KEY = savedEnvCodexKey;
  // ApiKeyCredentialProvider MEMOIZES the resolved key (api-key-credential.ts:110),
  // so without this the fixture key set by a test outlives it and every later file
  // in the run sees a credentialed openai-codex. Must run AFTER the env restore.
  credentials.invalidate("openai-codex");
  clearSignedArm();
});

/** The transport under test, carrying the production definition's fields. */
function makeCodexTransport(apiKey: string): InstanceType<typeof OpenAICodexTransport> {
  return new OpenAICodexTransport(
    {
      name: "openai-codex",
      baseUrl: "https://api.openai.com",
      apiPath: "/v1/responses",
      apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
      prefixes: [],
    },
    "gpt-test",
    apiKey
  );
}

describe("FR-3: openai-codex billing follows the credential in play", () => {
  test("wiring: importing authority.js installs the probe, and the answer tracks it", () => {
    // Fails on ANY machine when the probe is not registered — the first assertion
    // is false without it, regardless of whether a real oauth file exists.
    //
    // LOAD-BEARING, and more so than it looks: this is also the assertion that
    // kills the "use hasOAuthCredentials instead" substitution HERMETICALLY. That
    // oracle reads a file, so its answer is CONSTANT across the two halves below,
    // while these assertions demand two different answers from the same call. One
    // half or the other must fail, whichever way the machine is configured —
    // measured both ways (file present: this test + 3 others red; file absent:
    // this test + 4 others red). Do not collapse it into a single-value check.
    setHasCredentials(true);
    expect(isSubscriptionProvider("openai-codex")).toBe(true);

    setHasCredentials(false);
    expect(isSubscriptionProvider("openai-codex")).toBe(false);
  });

  test("OAuth would sign → subscription, and the pricing is a real zero", () => {
    setHasCredentials(true);

    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBe(true);
    expect(pricing.inputCostPer1M).toBe(0);
    expect(pricing.outputCostPer1M).toBe(0);
  });

  test("THE TRAP: access_token unexpired with NO refresh_token → METERED", () => {
    // This is the state that distinguishes the chosen probe from the rejected
    // one, and the test only earns that claim if it can SHOW the two disagreeing.
    //
    // It could not, until now. It drove the singleton's IN-MEMORY credential while
    // the rejected oracle, hasOAuthCredentials, reads the FILE and returns false at
    // its first statement when ~/.claudish/codex-oauth.json is absent
    // (oauth-registry.ts). So on hermetic CI — the machine that has no credential
    // files, and the machine the mutation would ship from — the rejected
    // implementation answered false too and this test stayed GREEN under the very
    // mutation it exists to catch. It passed the mutation run here only because
    // this developer's machine happens to have that file. That is a property of a
    // home directory, not of a test.
    //
    // Fixed by asking the rejected oracle's RULE directly
    // (`oauthCredentialWouldQualify`, which shares its predicate with the real
    // lookup) about the same credential object. No file, no $HOME, same answer
    // everywhere.
    //
    // Every real oauth file on a developer machine carries BOTH tokens, so no
    // live run can reach this state. Only this test can.
    const trap = { access_token: "at-no-refresh", expires_at: Date.now() + 3_600_000 };
    expect(trap.access_token).toBeTruthy();
    expect(trap.expires_at).toBeGreaterThan(Date.now());
    expect("refresh_token" in trap).toBe(false);

    // THE DISCRIMINATION, asserted rather than assumed: the REJECTED oracle would
    // call this credential usable (⇒ it would report SUB), the CHOSEN one does not.
    // If these two ever agree, the choice recorded in billing-probe.ts stopped
    // being load-bearing and this whole test should be re-derived.
    expect(oauthCredentialWouldQualify("openai-codex", trap)).toBe(true);

    (singleton as unknown as Mutable).credentials = trap;
    useRealHasCredentials();

    // The mechanism, asserted so a change to either half is attributable.
    expect(singleton.hasCredentials()).toBe(false);
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBeUndefined();
    expect(pricing.isEstimate).toBe(true);
    expect(pricing.inputCostPer1M).toBeGreaterThan(0);
  });

  test("presence probe: no OAuth credential → METERED", () => {
    // Scope, stated so this is not read as more than it is: the probe path is
    // isSubscriptionProvider → the closure at billing-probe.ts:104 →
    // CodexOAuth.hasCredentials(). It reads NO env var, so setting
    // OPENAI_CODEX_API_KEY here would be inert and is deliberately not done —
    // an earlier version set it and read as a second case when it was the same
    // one. The api-key arm is exercised for real in "the REAL composite's
    // api-key arm" below, which drives the composite and the transport.
    (singleton as unknown as Mutable).credentials = null;
    useRealHasCredentials();

    expect(singleton.hasCredentials()).toBe(false);
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBeUndefined();
    expect(pricing.inputCostPer1M).toBeGreaterThan(0);
  });

  // "neither credential present → METERED" used to live here. It was deleted, not
  // lost: with the inert `process.env` write removed from the test above, the two
  // were byte-identical in behaviour — the presence probe cannot distinguish them.
  // Two spellings of one case read as two cases and hid the missing one.
});

describe("FR-3: the REAL composite's api-key arm", () => {
  test("api-key arm signs api.openai.com, so the recorded arm must be METERED", async () => {
    // THE configuration the whole of FR-3 exists for, built from the production
    // classes with NOTHING stubbed on getRequestAuth: a user with
    // OPENAI_CODEX_API_KEY and no usable ChatGPT OAuth
    // (provider-definitions.ts:410-412 — a first-class supported setup).
    //
    // CompositeCredentialProvider.getRequestAuth takes
    // `return this.fallback.getRequestAuth(ctx)` (composite-credential.ts:61) when
    // the primary is unavailable, and the api-key half RETURNS AN ARTIFACT
    // (api-key-credential.ts:283) — it never returns null and never throws. So any
    // discriminator built on "the composite returned something" answers
    // subscription here, for a request OpenAI meters. That is the money-losing
    // direction, and this test is the one that says so.
    //
    // Hermetic: the OAuth half is switched off through the singleton seam, and the
    // key comes from process.env, which is step 1 of the resolution chain
    // (api-key-credential.ts:168-172) — the keychain and 1Password steps are never
    // reached, so nothing here depends on this machine.
    setHasCredentials(false);
    process.env.OPENAI_CODEX_API_KEY = METERED_KEY;
    credentials.invalidate("openai-codex"); // drop any memoized resolution first

    // (1) The artifact is NON-NULL on the metered arm — asserted on its own so a
    //     change in the credential layer is attributable there, not to the
    //     transport. This single fact is what made `cachedAuth ? ... : ...` wrong.
    const artifact = await credentials.getRequestAuth("openai-codex", { model: "" });
    expect(artifact).toBeTruthy();
    expect(artifact.headers.Authorization).toBe(`Bearer ${METERED_KEY}`);
    // Only the OAuth half sets an endpoint override (codex-credential.ts:54).
    expect(artifact.endpoint).toBeUndefined();

    // (2) The transport really does sign the METERED host with that key.
    const transport = makeCodexTransport(METERED_KEY);
    await transport.refreshAuth();
    expect(transport.getEndpoint()).toBe("https://api.openai.com/v1/responses");
    expect((await transport.getHeaders()).Authorization).toBe(`Bearer ${METERED_KEY}`);

    // (3) …so every billing surface must say METERED, and the price must be a
    //     real per-token figure rather than a subscription zero.
    expect(isSubscriptionProvider("openai-codex")).toBe(false);
    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBeUndefined();
    expect(pricing.inputCostPer1M).toBeGreaterThan(0);
  });

  test("an artifact that names no arm is METERED — the default must stay safe", async () => {
    // A future credential provider that forgets the marker, and the shape the
    // api-key half returns with no key resolved at all: `{headers:{}}`, which is
    // truthy. Stubbed rather than driven through the real composite ON PURPOSE —
    // resolving "no key" for real would fall through to the keychain and 1Password
    // steps (api-key-credential.ts:176-205) and touch this developer's machine.
    // The stub reproduces the artifact those steps would produce, exactly.
    setHasCredentials(true); // the presence probe would say subscription…
    const realGetRequestAuth = credentials.getRequestAuth.bind(credentials);
    try {
      credentials.getRequestAuth = async () => ({ headers: {} });
      const transport = makeCodexTransport("");
      await transport.refreshAuth();
      // …but nothing said an arm, so the answer is metered.
      expect(isSubscriptionProvider("openai-codex")).toBe(false);
    } finally {
      credentials.getRequestAuth = realGetRequestAuth;
    }
  });
});

describe("FR-3: the recorded arm beats the presence probe", () => {
  test("a metered signature overrides OAuth credentials that WOULD have signed", () => {
    // C-B: refreshAuth() catches everything and falls through to the plain
    // api-key path against api.openai.com (transport/openai-codex.ts:56-63), so
    // "OAuth present but the api-key arm signed" is reachable per request.
    setHasCredentials(true);
    expect(isSubscriptionProvider("openai-codex")).toBe(true);

    recordSignedArm("openai-codex", "metered");
    expect(isSubscriptionProvider("openai-codex")).toBe(false);
    expect(getModelPricing("openai-codex", SYNTHETIC_MODEL).isSubscription).toBeUndefined();
  });

  test("a subscription signature overrides an absent presence probe", () => {
    setHasCredentials(false);
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    recordSignedArm("openai-codex", "subscription");
    expect(isSubscriptionProvider("openai-codex")).toBe(true);
  });

  test("clearing the record returns the answer to what WOULD sign", () => {
    setHasCredentials(true);
    recordSignedArm("openai-codex", "metered");
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    clearSignedArm("openai-codex");
    expect(isSubscriptionProvider("openai-codex")).toBe(true);
  });

  test("invalidate() and logout() forget the record — it must not outlive the credential", async () => {
    // The record is a statement about a credential state. In a long-lived process
    // (the MCP server, `serve`) one successful OAuth request otherwise pinned SUB
    // on preflight, list_models and the picker after the user logged out or swapped
    // the credential, until some later request happened to rewrite it.
    //
    // Both arms of the assertion matter: the record must go, AND the answer must
    // fall back to "what WOULD sign" rather than to a hardcoded value.
    setHasCredentials(false); // the presence probe says metered…
    recordSignedArm("openai-codex", "subscription"); // …but a SUB request was signed
    expect(isSubscriptionProvider("openai-codex")).toBe(true);

    credentials.invalidate("openai-codex");
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    recordSignedArm("openai-codex", "subscription");
    expect(isSubscriptionProvider("openai-codex")).toBe(true);
    // logout() on a provider whose OAuth file is what it deletes. The registered
    // Codex composite forwards to CodexOAuthHalf.logout → CodexOAuth.logout, so
    // the singleton's own logout is stubbed out for the duration: this test is
    // about the record, and must not delete a real ~/.claudish/codex-oauth.json.
    const savedLogout = Object.getOwnPropertyDescriptor(singleton, "logout");
    try {
      (singleton as unknown as Record<string, unknown>).logout = async () => {};
      await credentials.logout("openai-codex");
    } finally {
      restoreOwn(singleton, "logout", savedLogout);
    }
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    // A whole-authority invalidate clears every provider's record, not just one.
    recordSignedArm("openai-codex", "subscription");
    credentials.invalidate();
    expect(isSubscriptionProvider("openai-codex")).toBe(false);
  });

  test("refreshAuth() writes the record, per request, from the REAL arms", async () => {
    // The only production writer, driven end to end through the real
    // CodexOAuthHalf → CompositeCredentialProvider → ApiKeyCredentialProvider.
    // NOTHING is stubbed on the credential authority.
    //
    // The previous version of this test replaced `credentials.getRequestAuth`
    // with two stubs: one that THREW, and one that returned a hand-written OAuth
    // artifact. Both were wrong models of the code they guarded. The throw is a
    // shape the real composite produces only for a rejected refresh, so it made
    // "cachedAuth is null ⇒ api-key path" look like the whole story; and a
    // hand-written artifact can never catch a marker the production half fails to
    // set. That pairing is how C-1 shipped green. The seam moved DOWN, to the
    // CodexOAuth singleton, so every layer above it is the production one.
    process.env.OPENAI_CODEX_API_KEY = METERED_KEY;
    credentials.invalidate("openai-codex");
    const transport = makeCodexTransport(METERED_KEY);

    // OAuth credentials exist, so "what WOULD sign" says subscription…
    setHasCredentials(true);
    const savedToken = Object.getOwnPropertyDescriptor(singleton, "getAccessToken");
    const savedAccount = Object.getOwnPropertyDescriptor(singleton, "getAccountId");
    const mutable = singleton as unknown as Record<string, unknown>;
    try {
      // …but the refresh is rejected (expired grant, revoked token, network). The
      // real CodexOAuthHalf.getRequestAuth throws, the composite rethrows (the
      // Codex composite declares no fallbackSignal), the transport catches and
      // cachedAuth is genuinely null — the ONE state that produces it.
      mutable.getAccessToken = async () => {
        throw new Error("refresh rejected");
      };
      await transport.refreshAuth();
      expect(transport.getEndpoint()).toBe("https://api.openai.com/v1/responses");
      expect(isSubscriptionProvider("openai-codex")).toBe(false);

      // The OAuth arm wins on the next request → back to subscription. The
      // endpoint, the headers and the arm marker all come from the production
      // CodexOAuthHalf, so this assertion fails if it ever stops marking itself.
      mutable.getAccessToken = async () => "oauth-access-token-fixture";
      mutable.getAccountId = () => "acct-fixture";
      await transport.refreshAuth();
      expect(transport.getEndpoint()).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect((await transport.getHeaders()).Authorization).toBe(
        "Bearer oauth-access-token-fixture"
      );
      expect(isSubscriptionProvider("openai-codex")).toBe(true);

      // And back again on the request after that: the record is per request, not
      // sticky. This is the C-B ordering the design names.
      mutable.getAccessToken = async () => {
        throw new Error("refresh rejected again");
      };
      await transport.refreshAuth();
      expect(isSubscriptionProvider("openai-codex")).toBe(false);
    } finally {
      restoreOwn(singleton, "getAccessToken", savedToken);
      restoreOwn(singleton, "getAccountId", savedAccount);
    }
  });
});

describe("FR-3: the registration seam", () => {
  test("an unregistered probe means METERED, the safe default", () => {
    const previous = registerSubscriptionCredentialProbe(null);
    try {
      // Also proves the production probe WAS installed: null here would mean the
      // authority import registered nothing.
      expect(typeof previous).toBe("function");
      setHasCredentials(true);
      expect(isSubscriptionProvider("openai-codex")).toBe(false);
      expect(getModelPricing("openai-codex", SYNTHETIC_MODEL).isSubscription).toBeUndefined();
    } finally {
      registerSubscriptionCredentialProbe(previous);
    }
  });

  test("the registrar RETURNS the previous probe, so a test can restore it", () => {
    // Restoring `null` instead would uninstall the production probe for the rest
    // of the Bun process and break sibling files by run order.
    const fake = () => true;
    const production = registerSubscriptionCredentialProbe(fake);
    expect(typeof production).toBe("function");
    expect(production).not.toBe(fake);

    const handedBack = registerSubscriptionCredentialProbe(production);
    expect(handedBack).toBe(fake);
    expect(registerSubscriptionCredentialProbe(production)).toBe(production);
  });

  test("only the canonical uid is credential-decided; the shortcut is not", () => {
    setHasCredentials(true);
    expect(isSubscriptionProvider("cx")).toBe(false);
    expect(isSubscriptionProvider("OPENAI-CODEX")).toBe(true);
  });

  test("openai-codex is never in the name-keyed set, which would short-circuit the probe", () => {
    for (const name of CREDENTIAL_DECIDED_PROVIDERS) {
      expect(SUBSCRIPTION_PROVIDERS.has(name)).toBe(false);
    }
    expect(SUBSCRIPTION_PROVIDERS.has("openai-codex")).toBe(false);
    expect(CREDENTIAL_DECIDED_PROVIDERS.has("openai-codex")).toBe(true);
  });

  test("no other provider consults the probe", () => {
    const previous = registerSubscriptionCredentialProbe(() => true);
    try {
      expect(isSubscriptionProvider("openai")).toBe(false);
      expect(isSubscriptionProvider("opencode-zen")).toBe(false);
      // A name-set member stays true without ever reaching the probe.
      expect(isSubscriptionProvider("kimi-coding")).toBe(true);
    } finally {
      registerSubscriptionCredentialProbe(previous);
    }
  });
});
