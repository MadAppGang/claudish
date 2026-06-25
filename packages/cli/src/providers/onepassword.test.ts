/**
 * Tests for onepassword.ts — pure unit tests of parsing/detection/error logic
 * plus SDK-backed resolution against an injected FAKE SDK client.
 *
 * Neither the `op` binary NOR the real @1password/sdk is ever invoked here.
 * Every SDK-backed function accepts an injectable SdkClientFactory; tests pass a
 * fake client that returns canned vaults/items/secrets/environments. The
 * read-only account lister (the ONE remaining `op` touch) is also injectable
 * (OpAccountLister) and stubbed. This keeps the suite hermetic and runnable in
 * CI without 1Password installed or signed in.
 */

import { describe, expect, test } from "bun:test";
import {
  OP_REF_RE,
  type AccountInfo,
  type OpAccountLister,
  type SdkAuth,
  type SdkClientFactory,
  type SdkClientLike,
  buildAuthError,
  collectConfigImports,
  detectSdkAuth,
  discoverItemFields,
  envNameFromOpRef,
  filterGlobFields,
  globToRegExp,
  isGlobImport,
  isOpReference,
  isTransientSdkError,
  maskSecret,
  parseGlobImport,
  parseOpFlag,
  readEnvironment,
  resolveDesktopAccount,
  resolveGlobImport,
  resolveSdkAuth,
  resolveSecrets,
  withSdkRetry,
} from "./onepassword.js";

describe("isOpReference / OP_REF_RE", () => {
  test("true for a full op:// reference", () => {
    expect(isOpReference("op://a/b/c")).toBe(true);
    expect(isOpReference("op://Vault/Item/section/field")).toBe(true);
    expect(OP_REF_RE.test("op://a/b/c")).toBe(true);
  });

  test("false for env var names, ${VAR}, literal keys, and empty string", () => {
    expect(isOpReference("OPENROUTER_API_KEY")).toBe(false);
    expect(isOpReference("${VAR}")).toBe(false);
    expect(isOpReference("sk-123")).toBe(false);
    expect(isOpReference("")).toBe(false);
  });

  test("false when the ref contains whitespace or is not anchored", () => {
    expect(isOpReference("op://a b/c")).toBe(false);
    expect(isOpReference("prefix op://a/b/c")).toBe(false);
    expect(isOpReference("op://a/b/c suffix")).toBe(false);
  });

  test("false for non-strings", () => {
    // @ts-expect-error intentionally passing a non-string
    expect(isOpReference(null)).toBe(false);
    // @ts-expect-error intentionally passing a non-string
    expect(isOpReference(undefined)).toBe(false);
  });
});

describe("maskSecret", () => {
  test("returns first 4 chars + ellipsis", () => {
    expect(maskSecret("sk-abcdef")).toBe("sk-a…");
  });
  test("short secrets are still masked, empty stays empty", () => {
    expect(maskSecret("ab")).toBe("ab…");
    expect(maskSecret("")).toBe("");
  });
});

describe("buildAuthError", () => {
  test("includes the detail and the SDK-only remediation lines", () => {
    const err = buildAuthError("something went wrong");
    expect(err.message).toContain("something went wrong");
    expect(err.message).toContain("OP_SERVICE_ACCOUNT_TOKEN");
    expect(err.message).toContain("OP_ACCOUNT");
    expect(err.message).toContain("onepasswordAccount");
    // No longer mentions the CLI remediation.
    expect(err.message).not.toContain("op signin");
    expect(err.message).not.toContain("brew install");
  });
});

// ===========================================================================
// SDK layer — fake client + factory seams
// ===========================================================================

type ResolveAllResult = Awaited<ReturnType<SdkClientLike["secrets"]["resolveAll"]>>;
type SdkItem = Awaited<ReturnType<SdkClientLike["items"]["get"]>>;

/**
 * A fake SDK client whose every namespace is scripted per test. Defaults make a
 * deterministic secret per ref so simple tests don't need to spell it out.
 */
function makeFakeSdkClient(opts: {
  resolveAll?: (refs: string[]) => ResolveAllResult;
  throwOnResolveAll?: Error;
  vaults?: { id: string; title: string }[];
  items?: { id: string; title: string }[];
  item?: SdkItem;
  getVariables?: (id: string) => { variables: { name: string; value: string; masked: boolean }[] };
  noEnvironments?: boolean;
}): SdkClientLike {
  const client: SdkClientLike = {
    secrets: {
      async resolve(ref: string): Promise<string> {
        return `secret-for-${ref}`;
      },
      async resolveAll(refs: string[]): Promise<ResolveAllResult> {
        if (opts.throwOnResolveAll) throw opts.throwOnResolveAll;
        if (opts.resolveAll) return opts.resolveAll(refs);
        const individualResponses: ResolveAllResult["individualResponses"] = {};
        for (const r of refs) individualResponses[r] = { content: { secret: `sdk:${r}` } };
        return { individualResponses };
      },
    },
    vaults: {
      async list() {
        return opts.vaults ?? [];
      },
    },
    items: {
      async list() {
        return opts.items ?? [];
      },
      async get() {
        if (!opts.item) throw new Error("fake item not configured");
        return opts.item;
      },
    },
    environments: {
      async getVariables(id: string) {
        if (opts.getVariables) return opts.getVariables(id);
        return { variables: [] };
      },
    },
  };
  if (opts.noEnvironments) {
    // Simulate the stable 0.4.0 SDK with no environments API.
    (client as { environments?: unknown }).environments = undefined;
  }
  return client;
}

/** A factory that returns the given fake client and records that it was called. */
function makeFakeSdkFactory(
  client: SdkClientLike,
  spy?: { called: boolean; auth?: SdkAuth }
): SdkClientFactory {
  return async (auth) => {
    if (spy) {
      spy.called = true;
      spy.auth = auth;
    }
    return client;
  };
}

describe("detectSdkAuth", () => {
  test("OP_SERVICE_ACCOUNT_TOKEN → token auth", () => {
    const auth = detectSdkAuth({ OP_SERVICE_ACCOUNT_TOKEN: "ops_abc " });
    expect(auth).toEqual({ kind: "token", token: "ops_abc" });
  });

  test("OP_ACCOUNT (no token) → desktop auth", () => {
    const auth = detectSdkAuth({ OP_ACCOUNT: "my-team.1password.com" });
    expect(auth).toEqual({ kind: "desktop", accountName: "my-team.1password.com" });
  });

  test("token wins over OP_ACCOUNT", () => {
    const auth = detectSdkAuth({
      OP_SERVICE_ACCOUNT_TOKEN: "ops_xyz",
      OP_ACCOUNT: "ignored",
    });
    expect(auth).toEqual({ kind: "token", token: "ops_xyz" });
  });

  test("neither → undefined", () => {
    expect(detectSdkAuth({})).toBeUndefined();
  });
});

// ===========================================================================
// Account resolution (resolveDesktopAccount + resolveSdkAuth)
// ===========================================================================

function lister(accounts: AccountInfo[] | null): OpAccountLister {
  return () => accounts;
}

const ACCT_A: AccountInfo = {
  url: "team-a.1password.com",
  email: "a@example.com",
  account_uuid: "uuid-a",
  user_id: "user-a",
};
const ACCT_B: AccountInfo = {
  url: "team-b.1password.com",
  email: "a@example.com", // same email — collision, url is the unique key
  account_uuid: "uuid-b",
  user_id: "user-b",
};

describe("resolveDesktopAccount", () => {
  test("(a) OP_ACCOUNT env wins", () => {
    const out = resolveDesktopAccount({
      env: { OP_ACCOUNT: "from-env.1password.com" },
      configAccount: "from-config.1password.com",
      opAccountLister: lister([ACCT_A, ACCT_B]),
    });
    expect(out).toEqual({ accountName: "from-env.1password.com" });
  });

  test("(b) configAccount used when no OP_ACCOUNT", () => {
    const out = resolveDesktopAccount({
      env: {},
      configAccount: "from-config.1password.com",
      opAccountLister: lister([ACCT_A, ACCT_B]),
    });
    expect(out).toEqual({ accountName: "from-config.1password.com" });
  });

  test("(c) single account auto-detected → its url", () => {
    const out = resolveDesktopAccount({ env: {}, opAccountLister: lister([ACCT_A]) });
    expect(out).toEqual({ accountName: ACCT_A.url });
  });

  test("(c) multiple + interactive → needsPicker", () => {
    const out = resolveDesktopAccount({
      env: {},
      interactive: true,
      opAccountLister: lister([ACCT_A, ACCT_B]),
    });
    expect(out).toEqual({ needsPicker: [ACCT_A, ACCT_B] });
  });

  test("(c) multiple + non-interactive → error listing the accounts", () => {
    const out = resolveDesktopAccount({
      env: {},
      interactive: false,
      opAccountLister: lister([ACCT_A, ACCT_B]),
    });
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error).toMatch(/multiple 1password accounts/i);
      expect(out.error).toContain(ACCT_A.url);
      expect(out.error).toContain(ACCT_B.url);
      expect(out.error).toContain("OP_ACCOUNT");
    }
  });

  test("(c) op absent (lister → null) → generic error", () => {
    const out = resolveDesktopAccount({ env: {}, opAccountLister: lister(null) });
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error).toMatch(/could not determine/i);
      expect(out.error).toContain("OP_ACCOUNT");
    }
  });
});

describe("resolveSdkAuth", () => {
  test("token wins", async () => {
    const auth = await resolveSdkAuth({
      env: { OP_SERVICE_ACCOUNT_TOKEN: "ops_tok" },
      opAccountLister: lister([ACCT_A, ACCT_B]),
    });
    expect(auth).toEqual({ kind: "token", token: "ops_tok" });
  });

  test("OP_ACCOUNT → desktop", async () => {
    const auth = await resolveSdkAuth({
      env: { OP_ACCOUNT: "env.1password.com" },
    });
    expect(auth).toEqual({ kind: "desktop", accountName: "env.1password.com" });
  });

  test("config account → desktop", async () => {
    const auth = await resolveSdkAuth({
      env: {},
      configAccount: "cfg.1password.com",
    });
    expect(auth).toEqual({ kind: "desktop", accountName: "cfg.1password.com" });
  });

  test("single account auto → desktop", async () => {
    const auth = await resolveSdkAuth({ env: {}, opAccountLister: lister([ACCT_A]) });
    expect(auth).toEqual({ kind: "desktop", accountName: ACCT_A.url });
  });

  test("multiple + interactive + picker → picked account", async () => {
    const auth = await resolveSdkAuth({
      env: {},
      interactive: true,
      opAccountLister: lister([ACCT_A, ACCT_B]),
      onNeedsPicker: async (accounts) => accounts[1].url,
    });
    expect(auth).toEqual({ kind: "desktop", accountName: ACCT_B.url });
  });

  test("multiple + interactive + picker aborts → throws", async () => {
    expect(
      resolveSdkAuth({
        env: {},
        interactive: true,
        opAccountLister: lister([ACCT_A, ACCT_B]),
        onNeedsPicker: async () => undefined,
      })
    ).rejects.toThrow(/none was selected|OP_ACCOUNT/i);
  });

  test("multiple + non-interactive → throws actionable error", async () => {
    expect(
      resolveSdkAuth({ env: {}, interactive: false, opAccountLister: lister([ACCT_A, ACCT_B]) })
    ).rejects.toThrow(/OP_ACCOUNT|multiple/i);
  });

  test("op absent → throws", async () => {
    expect(resolveSdkAuth({ env: {}, opAccountLister: lister(null) })).rejects.toThrow(
      /OP_SERVICE_ACCOUNT_TOKEN|OP_ACCOUNT/i
    );
  });
});

describe("resolveSecrets", () => {
  const auth: SdkAuth = { kind: "token", token: "ops_test" };

  test("empty refs short-circuits without touching the SDK", async () => {
    const spy = { called: false } as { called: boolean; auth?: SdkAuth };
    const out = await resolveSecrets(
      {},
      { auth, sdkFactory: makeFakeSdkFactory(makeFakeSdkClient({}), spy) }
    );
    expect(out).toEqual({});
    expect(spy.called).toBe(false);
  });

  test("resolves a batch via the SDK and re-keys by env var name", async () => {
    const spy = { called: false } as { called: boolean; auth?: SdkAuth };
    const client = makeFakeSdkClient({
      resolveAll: (refs) => {
        const individualResponses: ResolveAllResult["individualResponses"] = {};
        for (const r of refs) individualResponses[r] = { content: { secret: `S:${r}` } };
        return { individualResponses };
      },
    });
    const out = await resolveSecrets(
      { A: "op://v/i/a", B: "op://v/i/b" },
      { auth, sdkFactory: makeFakeSdkFactory(client, spy) }
    );
    expect(out).toEqual({ A: "S:op://v/i/a", B: "S:op://v/i/b" });
    expect(spy.called).toBe(true);
    expect(spy.auth).toEqual(auth);
  });

  test("maps individualResponses (keyed by ref) → flat envVar map", async () => {
    const client = makeFakeSdkClient({
      resolveAll: () => ({
        individualResponses: {
          "op://v/i/a": { content: { secret: "alpha" } },
          "op://v/i/b": { content: { secret: "beta" } },
        },
      }),
    });
    const out = await resolveSecrets(
      { A: "op://v/i/a", B: "op://v/i/b" },
      { auth, sdkFactory: makeFakeSdkFactory(client) }
    );
    expect(out).toEqual({ A: "alpha", B: "beta" });
  });

  test("per-ref error → throws with the failing env var named", async () => {
    const client = makeFakeSdkClient({
      resolveAll: () => ({
        individualResponses: {
          "op://v/i/a": { content: { secret: "alpha" } },
          "op://v/i/b": { error: { type: "fieldNotFound", message: "no such field" } },
        },
      }),
    });
    expect(
      resolveSecrets({ A: "op://v/i/a", B: "op://v/i/b" }, { auth, sdkFactory: makeFakeSdkFactory(client) })
    ).rejects.toThrow(/B.*fieldNotFound|could not resolve/i);
  });

  test("no SDK auth → hard-fails with an actionable error (no CLI fallback)", async () => {
    const spy = { called: false } as { called: boolean; auth?: SdkAuth };
    expect(
      resolveSecrets(
        { A: "op://v/i/a" },
        {
          env: {}, // no token / OP_ACCOUNT
          sdkFactory: makeFakeSdkFactory(makeFakeSdkClient({}), spy),
        }
      )
    ).rejects.toThrow(/SDK auth is required|OP_SERVICE_ACCOUNT_TOKEN/i);
    expect(spy.called).toBe(false); // factory never invoked without auth
  });
});

describe("readEnvironment", () => {
  const auth: SdkAuth = { kind: "token", token: "ops_test" };

  test("maps SDK getVariables → { name: value }", async () => {
    const client = makeFakeSdkClient({
      getVariables: () => ({
        variables: [
          { name: "OPENAI_API_KEY", value: "sk-1", masked: true },
          { name: "FOO", value: "bar=baz", masked: false },
        ],
      }),
    });
    const out = await readEnvironment("env-123", { auth, sdkFactory: makeFakeSdkFactory(client) });
    expect(out).toEqual({ OPENAI_API_KEY: "sk-1", FOO: "bar=baz" });
  });

  test("empty id throws a usage error without touching the SDK", async () => {
    const spy = { called: false } as { called: boolean; auth?: SdkAuth };
    expect(
      readEnvironment("   ", { auth, sdkFactory: makeFakeSdkFactory(makeFakeSdkClient({}), spy) })
    ).rejects.toThrow(/empty|usage/i);
    expect(spy.called).toBe(false);
  });

  test("no variables → throws", async () => {
    const client = makeFakeSdkClient({ getVariables: () => ({ variables: [] }) });
    expect(
      readEnvironment("env-1", { auth, sdkFactory: makeFakeSdkFactory(client) })
    ).rejects.toThrow(/no variables/i);
  });

  test("SDK without environments API → actionable beta hint", async () => {
    const client = makeFakeSdkClient({ noEnvironments: true });
    expect(
      readEnvironment("env-1", { auth, sdkFactory: makeFakeSdkFactory(client) })
    ).rejects.toThrow(/0\.4\.1-beta\.1|environments API/i);
  });

  test("no SDK auth → hard-fails", async () => {
    expect(
      readEnvironment("env-1", { env: {}, sdkFactory: makeFakeSdkFactory(makeFakeSdkClient({})) })
    ).rejects.toThrow(/SDK auth is required|OP_SERVICE_ACCOUNT_TOKEN/i);
  });
});

// ===========================================================================
// Glob field import — SDK-shaped fixture derived from the real-captured item
// ===========================================================================

/**
 * The real captured item (`op://Jack/AI LLM models API keys 10xlabs`, verified
 * via `op item get --format json`) in the OLD CLI shape: each field has
 * `label`/`type`/`value`/`reference` and an optional `section: {id,label}`.
 * We KEEP this as the source of truth and DERIVE the SDK-shaped fixture from it
 * (per the no-handcraft-fixtures preference — no new secret-like data invented).
 */
const VAULT = "Jack";
const ITEM = "AI LLM models API keys 10xlabs";
function ref(rest: string): string {
  return `op://${VAULT}/${ITEM}/${rest}`;
}
const CAPTURED_ITEM = {
  id: "abc123",
  title: ITEM,
  vault: { id: "vid", name: VAULT },
  sections: [
    { id: "s-claude", label: "Claude" },
    { id: "s-glm", label: "GLM Z models" },
    { id: "s-gem", label: "GOOGLE_GEMINI_API_KEY" },
    { id: "s-mm", label: "Minimax" },
    { id: "s-moon", label: "Moonshot Kimi" },
    { id: "s-or", label: "Open router" },
    { id: "s-oai", label: "OpenAI" },
    { id: "s-xai", label: "XAI_API_KEY" },
  ],
  fields: [
    // --- sectionless (top-level) ---
    { label: "notesPlain", type: "STRING", value: "", reference: ref("notesPlain") },
    { label: "username", type: "STRING", value: "", reference: ref("username") },
    { label: "credential", type: "CONCEALED", value: "", reference: ref("credential") },
    // --- OpenAI ---
    {
      label: "OPENAI_API_KEY",
      type: "CONCEALED",
      value: "sk-oai",
      reference: ref("OpenAI/OPENAI_API_KEY"),
      section: { id: "s-oai", label: "OpenAI" },
    },
    // --- GOOGLE_GEMINI_API_KEY section: trailing-space label ---
    {
      label: "GEMINI_API_KEY ", // NOTE trailing space
      type: "CONCEALED",
      value: "sk-gem",
      reference: ref("GOOGLE_GEMINI_API_KEY/GEMINI_API_KEY "),
      section: { id: "s-gem", label: "GOOGLE_GEMINI_API_KEY" },
    },
    // --- XAI_API_KEY section: 3 noise fields + the real key ---
    {
      label: "Customer Key",
      type: "STRING",
      value: "cust",
      reference: ref("XAI_API_KEY/Customer Key"),
      section: { id: "s-xai", label: "XAI_API_KEY" },
    },
    {
      label: "Secret Key",
      type: "CONCEALED",
      value: "secret",
      reference: ref("XAI_API_KEY/Secret Key"),
      section: { id: "s-xai", label: "XAI_API_KEY" },
    },
    {
      label: "Bearer token",
      type: "CONCEALED",
      value: "bearer",
      reference: ref("XAI_API_KEY/Bearer token"),
      section: { id: "s-xai", label: "XAI_API_KEY" },
    },
    {
      label: "XAI_API_KEY",
      type: "CONCEALED",
      value: "sk-xai",
      reference: ref("XAI_API_KEY/XAI_API_KEY"),
      section: { id: "s-xai", label: "XAI_API_KEY" },
    },
    // --- Moonshot Kimi (two fields) ---
    {
      label: "MOONSHOT_API_KEY",
      type: "CONCEALED",
      value: "sk-moon",
      reference: ref("Moonshot Kimi/MOONSHOT_API_KEY"),
      section: { id: "s-moon", label: "Moonshot Kimi" },
    },
    {
      label: "KIMI_CODING_API_KEY",
      type: "CONCEALED",
      value: "sk-kimi",
      reference: ref("Moonshot Kimi/KIMI_CODING_API_KEY"),
      section: { id: "s-moon", label: "Moonshot Kimi" },
    },
    // --- one *_API_KEY per remaining section ---
    {
      label: "ZHIPU_API_KEY",
      type: "CONCEALED",
      value: "sk-zhipu",
      reference: ref("GLM Z models/ZHIPU_API_KEY"),
      section: { id: "s-glm", label: "GLM Z models" },
    },
    {
      label: "MINIMAX_API_KEY",
      type: "CONCEALED",
      value: "sk-mm",
      reference: ref("Minimax/MINIMAX_API_KEY"),
      section: { id: "s-mm", label: "Minimax" },
    },
    {
      label: "OPENROUTER_API_KEY",
      type: "CONCEALED",
      value: "sk-or",
      reference: ref("Open router/OPENROUTER_API_KEY"),
      section: { id: "s-or", label: "Open router" },
    },
    {
      label: "ANTHROPIC_API_KEY",
      type: "CONCEALED",
      value: "sk-anthropic",
      reference: ref("Claude/ANTHROPIC_API_KEY"),
      section: { id: "s-claude", label: "Claude" },
    },
    // --- a field that's invalid as an env var name even after trim ---
    {
      label: "Bad Name",
      type: "STRING",
      value: "noise",
      reference: ref("Open router/Bad Name"),
      section: { id: "s-or", label: "Open router" },
    },
  ],
};

/**
 * Derive the SDK-shaped item from the captured CLI fixture:
 *  - sections: { id, label } → { id, title }.
 *  - fields:   { label, type, value, section } → { id, title, sectionId?,
 *              fieldType, value }. NO `reference` (the SDK doesn't emit one — we
 *              synthesize it in discoverItemFields).
 */
const SDK_ITEM: Awaited<ReturnType<SdkClientLike["items"]["get"]>> = {
  id: CAPTURED_ITEM.id,
  title: CAPTURED_ITEM.title,
  sections: CAPTURED_ITEM.sections.map((s) => ({ id: s.id, title: s.label })),
  fields: CAPTURED_ITEM.fields.map((f, i) => ({
    id: `f-${i}`,
    title: f.label,
    sectionId: (f as { section?: { id: string } }).section?.id,
    fieldType: f.type,
    value: f.value,
  })),
};

/** The SDK vault/item list overviews matching the fixture. */
const SDK_VAULTS = [{ id: "vid", title: VAULT }];
const SDK_ITEMS = [{ id: CAPTURED_ITEM.id, title: ITEM }];

/** A fake SDK factory that answers vaults/items/get for the fixture item. */
function itemSdkFactory(spy?: { called: boolean; auth?: SdkAuth }): SdkClientFactory {
  return makeFakeSdkFactory(
    makeFakeSdkClient({
      vaults: SDK_VAULTS,
      items: SDK_ITEMS,
      item: SDK_ITEM,
      resolveAll: (refs) => {
        const individualResponses: ResolveAllResult["individualResponses"] = {};
        for (const r of refs) individualResponses[r] = { content: { secret: `sdk:${r}` } };
        return { individualResponses };
      },
    }),
    spy
  );
}

const stubAuth: SdkAuth = { kind: "token", token: "ops_test" };

describe("isGlobImport", () => {
  test("1-segment glob → true", () => {
    expect(isGlobImport("op://Jack/My Item/*")).toBe(true);
    expect(isGlobImport("op://Jack/My Item/*_API_KEY")).toBe(true);
  });
  test("2-segment glob (field and/or section) → true", () => {
    expect(isGlobImport("op://Jack/My Item/*/*_API_KEY")).toBe(true);
    expect(isGlobImport("op://Jack/My Item/Moonshot/*")).toBe(true);
    expect(isGlobImport("op://Jack/My Item/M*/KEY")).toBe(true);
  });
  test("no '*' in post-item segments → not a glob", () => {
    expect(isGlobImport("op://Jack/My Item/field")).toBe(false);
    expect(isGlobImport("op://Jack/My Item/Section/field")).toBe(false);
  });
  test(">2 post-item segments → not supported (false)", () => {
    expect(isGlobImport("op://Jack/My Item/a/b/*")).toBe(false);
  });
  test("non-op:// or too-short paths → false", () => {
    expect(isGlobImport("OPENROUTER_API_KEY")).toBe(false);
    expect(isGlobImport("op://Jack/Item")).toBe(false); // no post-item segment
    // @ts-expect-error non-string
    expect(isGlobImport(undefined)).toBe(false);
  });
});

describe("parseGlobImport", () => {
  test("1 segment → sectionGlob null", () => {
    expect(parseGlobImport("op://Jack/My Item/*_API_KEY")).toEqual({
      vault: "Jack",
      item: "My Item",
      sectionGlob: null,
      fieldGlob: "*_API_KEY",
    });
  });
  test("2 segments → section + field glob", () => {
    expect(parseGlobImport("op://Jack/My Item/Moonshot Kimi/*")).toEqual({
      vault: "Jack",
      item: "My Item",
      sectionGlob: "Moonshot Kimi",
      fieldGlob: "*",
    });
  });
  test("lone ** → whole-item match-all", () => {
    expect(parseGlobImport("op://Jack/My Item/**")).toEqual({
      vault: "Jack",
      item: "My Item",
      sectionGlob: null,
      fieldGlob: "*",
      matchAll: true,
    });
  });
});

describe("globToRegExp", () => {
  test("'*' matches anything including empty", () => {
    const re = globToRegExp("*");
    expect(re.test("")).toBe(true);
    expect(re.test("ANYTHING")).toBe(true);
  });
  test("'*_API_KEY' is an anchored suffix match", () => {
    const re = globToRegExp("*_API_KEY");
    expect(re.test("OPENROUTER_API_KEY")).toBe(true);
    expect(re.test("_API_KEY")).toBe(true);
    expect(re.test("API_KEY")).toBe(false); // missing leading underscore
    expect(re.test("OPENROUTER_API_KEY_EXTRA")).toBe(false); // not a suffix
  });
  test("'M*' is an anchored prefix match", () => {
    const re = globToRegExp("M*");
    expect(re.test("Minimax")).toBe(true);
    expect(re.test("Moonshot Kimi")).toBe(true);
    expect(re.test("XAI")).toBe(false);
  });
  test("case-sensitive", () => {
    expect(globToRegExp("Open router").test("Open router")).toBe(true);
    expect(globToRegExp("Open router").test("open ROUTER")).toBe(false);
  });
  test("regex metacharacters are escaped (treated literally)", () => {
    const re = globToRegExp("a.b+c");
    expect(re.test("a.b+c")).toBe(true);
    expect(re.test("aXbXc")).toBe(false); // '.' and '+' are literal, not regex
  });
});

describe("discoverItemFields", () => {
  test("maps the SDK item into {label, section, reference, type, hasValue}", async () => {
    const fields = await discoverItemFields(VAULT, ITEM, {
      auth: stubAuth,
      sdkFactory: itemSdkFactory(),
    });
    const byLabel = Object.fromEntries(fields.map((f) => [f.label, f]));
    // sectionless field → section null
    expect(byLabel["username"].section).toBeNull();
    expect(byLabel["username"].hasValue).toBe(false);
    // sectioned field → section title + synthesized reference
    expect(byLabel["OPENROUTER_API_KEY"].section).toBe("Open router");
    expect(byLabel["OPENROUTER_API_KEY"].reference).toBe(ref("Open router/OPENROUTER_API_KEY"));
    expect(byLabel["OPENROUTER_API_KEY"].hasValue).toBe(true);
    // trailing-space label preserved verbatim in discovery
    expect(byLabel["GEMINI_API_KEY "]).toBeDefined();
    // synthesized reference for the trailing-space field keeps the space
    expect(byLabel["GEMINI_API_KEY "].reference).toBe(
      ref("GOOGLE_GEMINI_API_KEY/GEMINI_API_KEY ")
    );
    // valueTail = last 4 chars of the value (for masked ••••1234 display); a
    // valueless field → "". The full value is never kept.
    expect(byLabel["OPENAI_API_KEY"].valueTail).toBe("-oai"); // value "sk-oai"
    expect(byLabel["username"].valueTail).toBe(""); // empty value
  });

  test("no SDK auth → hard-fails", async () => {
    expect(discoverItemFields(VAULT, ITEM, { env: {} })).rejects.toThrow(
      /SDK auth is required|OP_SERVICE_ACCOUNT_TOKEN/i
    );
  });

  test("vault not found → throws", async () => {
    const factory = makeFakeSdkFactory(
      makeFakeSdkClient({ vaults: [{ id: "x", title: "Other" }], items: SDK_ITEMS, item: SDK_ITEM })
    );
    expect(
      discoverItemFields(VAULT, ITEM, { auth: stubAuth, sdkFactory: factory })
    ).rejects.toThrow(/vault 'Jack' not found/i);
  });

  test("item not found → throws", async () => {
    const factory = makeFakeSdkFactory(
      makeFakeSdkClient({
        vaults: SDK_VAULTS,
        items: [{ id: "z", title: "Some Other Item" }],
        item: SDK_ITEM,
      })
    );
    expect(
      discoverItemFields(VAULT, ITEM, { auth: stubAuth, sdkFactory: factory })
    ).rejects.toThrow(/item '.*' not found/i);
  });

  test("duplicate vault titles → first-match + warning", async () => {
    const warnings: string[] = [];
    const factory = makeFakeSdkFactory(
      makeFakeSdkClient({
        vaults: [
          { id: "vid", title: VAULT },
          { id: "vid2", title: VAULT },
        ],
        items: SDK_ITEMS,
        item: SDK_ITEM,
      })
    );
    const fields = await discoverItemFields(VAULT, ITEM, {
      auth: stubAuth,
      sdkFactory: factory,
      warn: (m) => warnings.push(m),
    });
    expect(fields.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("multiple 1Password vaults"))).toBe(true);
  });
});

describe("filterGlobFields", () => {
  async function discover() {
    return discoverItemFields(VAULT, ITEM, { auth: stubAuth, sdkFactory: itemSdkFactory() });
  }

  test("'/*/*_API_KEY' → exactly the 9 *_API_KEY env vars (noise excluded by field glob)", async () => {
    const fields = await discover();
    const matches = filterGlobFields(fields, parseGlobImport(ref("*/*_API_KEY")));
    const names = matches.map((m) => m.envName).sort();
    expect(names).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "KIMI_CODING_API_KEY",
        "MINIMAX_API_KEY",
        "MOONSHOT_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "XAI_API_KEY",
        "ZHIPU_API_KEY",
      ].sort()
    );
    expect(names).not.toContain("Customer Key");
    expect(names).not.toContain("Bearer token");
    expect(names).toContain("GEMINI_API_KEY");
    expect(names).not.toContain("GEMINI_API_KEY ");
    expect(matches.every((m) => m.valid)).toBe(true);
  });

  test("'/*' (1 segment) → only sectionless fields", async () => {
    const fields = await discover();
    const matches = filterGlobFields(fields, parseGlobImport(ref("*")));
    expect(matches.map((m) => m.envName).sort()).toEqual(
      ["credential", "notesPlain", "username"].sort()
    );
  });

  test("'/**' (whole-item match-all) → the UNION of sectionless + all-section fields", async () => {
    const fields = await discover();
    const all = filterGlobFields(fields, parseGlobImport(ref("**"))).map((m) => m.envName).sort();
    const sectionless = filterGlobFields(fields, parseGlobImport(ref("*"))).map((m) => m.envName);
    const sectioned = filterGlobFields(fields, parseGlobImport(ref("*/*"))).map((m) => m.envName);
    // ** is exactly the union of `*` (sectionless) and `*/*` (every section).
    const expectedUnion = [...new Set([...sectionless, ...sectioned])].sort();
    expect(all).toEqual(expectedUnion);
    // And it genuinely spans both axes: contains a sectionless field AND a
    // sectioned key.
    expect(all).toContain("username"); // sectionless
    expect(all).toContain("OPENAI_API_KEY"); // sectioned
  });

  test("'/Moonshot Kimi/*' → the 2 fields in that section", async () => {
    const fields = await discover();
    const matches = filterGlobFields(fields, parseGlobImport(ref("Moonshot Kimi/*")));
    expect(matches.map((m) => m.envName).sort()).toEqual(
      ["KIMI_CODING_API_KEY", "MOONSHOT_API_KEY"].sort()
    );
  });

  test("'/M*/*' (section prefix glob) → Minimax + Moonshot Kimi sections", async () => {
    const fields = await discover();
    const matches = filterGlobFields(fields, parseGlobImport(ref("M*/*")));
    expect(matches.map((m) => m.envName).sort()).toEqual(
      ["KIMI_CODING_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY"].sort()
    );
  });

  test("invalid-after-trim labels are flagged valid:false (e.g. 'Bad Name')", async () => {
    const fields = await discover();
    const matches = filterGlobFields(fields, parseGlobImport(ref("Open router/*")));
    const bad = matches.find((m) => m.envName === "Bad Name");
    expect(bad).toBeDefined();
    expect(bad!.valid).toBe(false);
    const good = matches.find((m) => m.envName === "OPENROUTER_API_KEY");
    expect(good!.valid).toBe(true);
  });
});

describe("resolveGlobImport", () => {
  test("'/*/*_API_KEY' resolves exactly the 9 keys, trims GEMINI, excludes noise", async () => {
    const out = await resolveGlobImport(ref("*/*_API_KEY"), {
      auth: stubAuth,
      sdkFactory: itemSdkFactory(),
      warn: () => {},
    });
    expect(Object.keys(out).sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "KIMI_CODING_API_KEY",
        "MINIMAX_API_KEY",
        "MOONSHOT_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "XAI_API_KEY",
        "ZHIPU_API_KEY",
      ].sort()
    );
    // GEMINI_API_KEY resolved via the TRAILING-SPACE reference, named WITHOUT it.
    expect(out["GEMINI_API_KEY"]).toBe(`sdk:${ref("GOOGLE_GEMINI_API_KEY/GEMINI_API_KEY ")}`);
    expect(out["Customer Key"]).toBeUndefined();
    expect(out["Bearer token"]).toBeUndefined();
  });

  test("'/Moonshot Kimi/*' resolves the 2 section fields", async () => {
    const out = await resolveGlobImport(ref("Moonshot Kimi/*"), {
      auth: stubAuth,
      sdkFactory: itemSdkFactory(),
    });
    expect(Object.keys(out).sort()).toEqual(["KIMI_CODING_API_KEY", "MOONSHOT_API_KEY"].sort());
  });

  test("'/*' (sectionless) — all 3 sectionless labels are lowercase → all skipped → throws", async () => {
    const warnings: string[] = [];
    expect(
      resolveGlobImport(ref("*"), {
        auth: stubAuth,
        sdkFactory: itemSdkFactory(),
        warn: (m) => warnings.push(m),
      })
    ).rejects.toThrow(/matched no importable fields/i);
    expect(warnings.some((w) => w.includes("notesPlain"))).toBe(true);
    expect(warnings.some((w) => w.includes("username"))).toBe(true);
    expect(warnings.some((w) => w.includes("credential"))).toBe(true);
  });

  test("warns + skips a glob-matched invalid env name ('Bad Name'), not in output", async () => {
    const warnings: string[] = [];
    const out = await resolveGlobImport(ref("Open router/*"), {
      auth: stubAuth,
      sdkFactory: itemSdkFactory(),
      warn: (m) => warnings.push(m),
    });
    expect(out["OPENROUTER_API_KEY"]).toBeDefined();
    expect(out["Bad Name"]).toBeUndefined();
    expect(warnings.some((w) => w.includes("Bad Name"))).toBe(true);
    expect(warnings.some((w) => w.includes("not a valid env var name"))).toBe(true);
  });

  test("zero matches → throws with available-labels hint", async () => {
    expect(
      resolveGlobImport(ref("*/NO_SUCH_*"), {
        auth: stubAuth,
        sdkFactory: itemSdkFactory(),
      })
    ).rejects.toThrow(/matched no importable fields/i);
  });

  test("value phase uses the injected SDK factory — real op/SDK never touched", async () => {
    const spy = { called: false } as { called: boolean; auth?: SdkAuth };
    const out = await resolveGlobImport(ref("Moonshot Kimi/*"), {
      auth: stubAuth,
      sdkFactory: itemSdkFactory(spy),
    });
    expect(spy.called).toBe(true);
    expect(out["MOONSHOT_API_KEY"]).toBe(`sdk:${ref("Moonshot Kimi/MOONSHOT_API_KEY")}`);
  });
});

// ===========================================================================
// Config-import collection + inline-mode arg parsing
// ===========================================================================

describe("envNameFromOpRef", () => {
  test("derives the env name from the trailing field-label segment", () => {
    expect(envNameFromOpRef("op://Jack/My Item/OpenAI/OPENROUTER_API_KEY")).toBe(
      "OPENROUTER_API_KEY"
    );
    expect(envNameFromOpRef("op://Jack/My Item/OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
  });
  test("trims a trailing-space field label", () => {
    expect(envNameFromOpRef("op://Jack/My Item/GOOGLE/GEMINI_API_KEY ")).toBe("GEMINI_API_KEY");
  });
  test("null when the trailing label is not a valid env var name", () => {
    expect(envNameFromOpRef("op://Jack/My Item/OpenAI/Customer Key")).toBeNull();
    expect(envNameFromOpRef("op://Jack/My Item/lowercase")).toBeNull();
  });
  test("null for non-op:// strings", () => {
    expect(envNameFromOpRef("OPENROUTER_API_KEY")).toBeNull();
    // @ts-expect-error non-string
    expect(envNameFromOpRef(undefined)).toBeNull();
  });
});

describe("collectConfigImports", () => {
  test("onepassword[] glob entries → globImports", () => {
    const out = collectConfigImports(
      { onepassword: ["op://Jack/My Item/*/*_API_KEY", "op://Jack/Other/Sec/*"] },
      {}
    );
    expect(out.globImports).toEqual(["op://Jack/My Item/*/*_API_KEY", "op://Jack/Other/Sec/*"]);
    expect(out.opRefs).toEqual({});
    expect(out.warnings).toEqual([]);
  });

  test("onepassword[] single op:// ref → named by trailing field label", () => {
    const out = collectConfigImports(
      { onepassword: ["op://Jack/My Item/OpenAI/OPENROUTER_API_KEY"] },
      {}
    );
    expect(out.opRefs).toEqual({
      OPENROUTER_API_KEY: "op://Jack/My Item/OpenAI/OPENROUTER_API_KEY",
    });
    expect(out.globImports).toEqual([]);
  });

  test("onepassword[] single ref does NOT overwrite an already-set env var", () => {
    const out = collectConfigImports(
      { onepassword: ["op://Jack/My Item/OpenAI/OPENROUTER_API_KEY"] },
      { OPENROUTER_API_KEY: "already-set" }
    );
    expect(out.opRefs).toEqual({});
  });

  test("onepassword[] single ref with an invalid trailing label → warned + skipped", () => {
    const out = collectConfigImports(
      { onepassword: ["op://Jack/My Item/OpenAI/Customer Key"] },
      {}
    );
    expect(out.opRefs).toEqual({});
    expect(out.globImports).toEqual([]);
    expect(out.warnings.some((w) => w.includes("Customer Key"))).toBe(true);
  });

  test("onepassword[] non-ref / non-glob entry → warned + skipped", () => {
    const out = collectConfigImports({ onepassword: ["just-a-literal"] }, {});
    expect(out.opRefs).toEqual({});
    expect(out.globImports).toEqual([]);
    expect(out.warnings.some((w) => w.includes("just-a-literal"))).toBe(true);
  });

  test("apiKeys single op:// ref VALUE → collected under its explicit NAME", () => {
    const out = collectConfigImports({ apiKeys: { MY_KEY: "op://Jack/Item/field" } }, {});
    expect(out.opRefs).toEqual({ MY_KEY: "op://Jack/Item/field" });
  });

  test("apiKeys plain (non-op://) values are ignored (no collection)", () => {
    const out = collectConfigImports({ apiKeys: { MY_KEY: "sk-plain" } }, {});
    expect(out.opRefs).toEqual({});
    expect(out.globImports).toEqual([]);
  });

  test("a GLOB value sitting in apiKeys is NOT detected (globs come from onepassword[] only)", () => {
    const out = collectConfigImports({ apiKeys: { _import: "op://Jack/My Item/*/*_API_KEY" } }, {});
    expect(out.globImports).toEqual([]);
    expect(out.opRefs).toEqual({});
  });

  test("apiKeys + onepassword[] combine; env-set value still collected as a ref", () => {
    const out = collectConfigImports(
      {
        apiKeys: { MY_KEY: "op://Jack/Item/field" },
        onepassword: ["op://Jack/My Item/*/*_API_KEY"],
      },
      { MY_KEY: "op://Jack/Item/field" }
    );
    expect(out.opRefs).toEqual({ MY_KEY: "op://Jack/Item/field" });
    expect(out.globImports).toEqual(["op://Jack/My Item/*/*_API_KEY"]);
  });
});

describe("parseOpFlag", () => {
  test("`--op <glob>` (space form) → glob set, list false, present true", () => {
    const out = parseOpFlag(["--op", "op://Jack/My Item/*/*_API_KEY"]);
    expect(out).toEqual({
      glob: "op://Jack/My Item/*/*_API_KEY",
      list: false,
      present: true,
    });
  });

  test("`--op=<glob>` (inline form) → glob set", () => {
    const out = parseOpFlag(["--op=op://Jack/My Item/*"]);
    expect(out).toEqual({ glob: "op://Jack/My Item/*", list: false, present: true });
  });

  test("`--op <glob> --list` → glob set + list true (preview mode)", () => {
    const out = parseOpFlag(["--op", "op://Jack/My Item/*/*_API_KEY", "--list"]);
    expect(out).toEqual({
      glob: "op://Jack/My Item/*/*_API_KEY",
      list: true,
      present: true,
    });
  });

  test("`--list` can precede `--op`", () => {
    const out = parseOpFlag(["--list", "--op", "op://Jack/My Item/*"]);
    expect(out).toEqual({ glob: "op://Jack/My Item/*", list: true, present: true });
  });

  test("the glob may contain spaces (one argv entry from the shell)", () => {
    const out = parseOpFlag(["--op", "op://Jack/AI LLM models API keys 10xlabs/*/*_API_KEY"]);
    expect(out.glob).toBe("op://Jack/AI LLM models API keys 10xlabs/*/*_API_KEY");
  });

  test("no `--op` → glob undefined, list false, present false", () => {
    expect(parseOpFlag([])).toEqual({ glob: undefined, list: false, present: false });
    expect(parseOpFlag(["config"])).toEqual({
      glob: undefined,
      list: false,
      present: false,
    });
  });

  test("`--op` with a missing value → present true, glob undefined (caller errors)", () => {
    expect(parseOpFlag(["--op"])).toEqual({ glob: undefined, list: false, present: true });
  });

  test("`--op` followed by another flag → glob undefined (value is invalid)", () => {
    const out = parseOpFlag(["--op", "--model", "gpt-4o"]);
    expect(out).toEqual({ glob: undefined, list: false, present: true });
  });

  test("`--op=` with an empty value → present true, glob undefined", () => {
    expect(parseOpFlag(["--op="])).toEqual({
      glob: undefined,
      list: false,
      present: true,
    });
  });

  test("`--op-env` is NOT matched as `--op` (the startsWith pitfall)", () => {
    const out = parseOpFlag(["--op-env", "some-env-id"]);
    expect(out).toEqual({ glob: undefined, list: false, present: false });
  });

  test("`--op-env=<id>` is NOT matched as `--op` either", () => {
    const out = parseOpFlag(["--op-env=env-123"]);
    expect(out).toEqual({ glob: undefined, list: false, present: false });
  });

  test("`--op` composes with a following subcommand (e.g. config)", () => {
    const out = parseOpFlag(["--op", "op://Jack/My Item/*/*_API_KEY", "config"]);
    expect(out.glob).toBe("op://Jack/My Item/*/*_API_KEY");
    expect(out.list).toBe(false);
    expect(out.present).toBe(true);
  });
});

describe("isTransientSdkError", () => {
  test("flags transient desktop-IPC failures", () => {
    expect(isTransientSdkError(new Error("IPC operation failed: -4"))).toBe(true);
    expect(isTransientSdkError(new Error("Error { msg: Denied }"))).toBe(true);
    expect(isTransientSdkError("broken pipe")).toBe(true);
    expect(isTransientSdkError(new Error("connection reset"))).toBe(true);
  });
  test("flags stale desktop-session errors (retryable after idle)", () => {
    // After an idle period the cached SDK client's desktop session expires; the
    // next call fails with these — a cache reset + rebuild fixes them.
    expect(isTransientSdkError(new Error("invalid client id"))).toBe(true);
    expect(isTransientSdkError(new Error("invalid session"))).toBe(true);
    expect(isTransientSdkError(new Error("session expired"))).toBe(true);
    expect(isTransientSdkError(new Error("unauthorized"))).toBe(true);
    expect(isTransientSdkError(new Error("token expired"))).toBe(true);
  });
  test("does NOT flag genuine errors", () => {
    expect(isTransientSdkError(new Error("vault 'X' not found"))).toBe(false);
    expect(isTransientSdkError(new Error("invalid secret reference"))).toBe(false);
    expect(isTransientSdkError(new Error("no auth"))).toBe(false);
  });
});

describe("withSdkRetry", () => {
  test("returns the result when the op succeeds first try", async () => {
    let calls = 0;
    const out = await withSdkRetry(async () => {
      calls++;
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(1);
  });
  test("retries a transient error, then succeeds on a later attempt", async () => {
    let calls = 0;
    const out = await withSdkRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("IPC operation failed: -4");
      return "recovered";
    });
    expect(out).toBe("recovered");
    expect(calls).toBe(2);
  });
  test("does NOT retry a non-transient error", async () => {
    let calls = 0;
    let threw: unknown;
    try {
      await withSdkRetry(async () => {
        calls++;
        throw new Error("vault not found");
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as Error)?.message).toContain("vault not found");
    expect(calls).toBe(1); // no retry for a genuine error
  });
  test("gives up after MAX_ATTEMPTS (3) on a persistent transient error", async () => {
    let calls = 0;
    let threw: unknown;
    try {
      await withSdkRetry(async () => {
        calls++;
        throw new Error("IPC operation failed: -4");
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as Error)?.message).toContain("IPC operation failed");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
  test("serializes overlapping SDK ops (never concurrent)", async () => {
    // Two ops launched together must NOT run at the same time — the second only
    // starts after the first settles. Track max concurrency.
    let active = 0;
    let maxActive = 0;
    const op = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return "done";
    };
    await Promise.all([withSdkRetry(op), withSdkRetry(op), withSdkRetry(op)]);
    expect(maxActive).toBe(1); // serialized — only one ran at a time
  });
});
