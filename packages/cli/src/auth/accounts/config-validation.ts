import { CodexWindowSlotSchema, SubscriptionAccountsSchema } from "../../config-schema.js";
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_LABEL_PATTERN,
  ACCOUNT_PROVIDERS,
  type AccountProvider,
  type SubscriptionAccountsConfig,
  type SubscriptionAccountsEntry,
} from "./types.js";

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldPath(segments: readonly PropertyKey[]): string {
  let out = "subscriptionAccounts";
  for (const segment of segments) {
    out += typeof segment === "number" ? `[${segment}]` : `[${JSON.stringify(String(segment))}]`;
  }
  return out;
}

const ANTHROPIC_WINDOW_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

function checkEntryInvariants(provider: AccountProvider, entry: SubscriptionAccountsEntry): void {
  const ids = new Map<string, number>();
  const labels = new Map<string, number>();
  let legacyRows = 0;
  entry.accounts.forEach((account, i) => {
    const at = (field: string) => fieldPath([provider, "accounts", i, field]);
    if (!ACCOUNT_ID_PATTERN.test(account.id)) {
      throw new Error(`${at("id")}: not a generated id (${ACCOUNT_ID_PATTERN.source})`);
    }
    if (!ACCOUNT_LABEL_PATTERN.test(account.label)) {
      throw new Error(`${at("label")}: not a valid label (${ACCOUNT_LABEL_PATTERN.source})`);
    }
    for (const [field, value, seen] of [
      ["id", account.id, ids],
      ["label", account.label, labels],
    ] as const) {
      const first = seen.get(value);
      if (first !== undefined) throw new Error(`${at(field)}: duplicates accounts[${first}]`);
      seen.set(value, i);
    }
    if (account.store === "legacy-codex-file") {
      if (provider !== "openai-codex") {
        throw new Error(`${at("store")}: the legacy store is the Codex credential file`);
      }
      if (++legacyRows > 1)
        throw new Error(
          `${at("store")}: only one account may use the legacy Codex file — it holds one refresh token`
        );
      if (entry.legacyCodexSuppressed)
        throw new Error(
          `${at("store")}: the legacy Codex file is suppressed; explicitly re-enroll it first`
        );
    }
  });
  if (provider !== "openai-codex" && entry.legacyCodexSuppressed !== undefined) {
    throw new Error(
      `${fieldPath([provider, "legacyCodexSuppressed"])}: only Codex has a legacy credential file`
    );
  }
  for (const key of Object.keys(entry.switchAtByWindow ?? {})) {
    const valid =
      provider === "openai-codex"
        ? CodexWindowSlotSchema.safeParse(key).success
        : ANTHROPIC_WINDOW_NAME.test(key);
    if (!valid)
      throw new Error(
        `${fieldPath([provider, "switchAtByWindow", key])}: no usage reading can carry this window`
      );
  }
}

/** Shared reader/writer validation. Reject the whole block, never drop a row. */
export function parseAccountsBlock(block: unknown): SubscriptionAccountsConfig {
  if (!isConfigObject(block)) throw new Error("subscriptionAccounts is not an object");
  const parsed = SubscriptionAccountsSchema.safeParse(block);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      issue ? `${fieldPath(issue.path)}: ${issue.message}` : "subscriptionAccounts is invalid"
    );
  }
  const settings: SubscriptionAccountsConfig = {};
  for (const provider of ACCOUNT_PROVIDERS) {
    const entry = parsed.data[provider];
    if (!entry) continue;
    checkEntryInvariants(provider, entry);
    settings[provider] = entry;
  }
  return settings;
}

/** Validate raw JSON without replacing it with Zod's unknown-field-stripped copy. */
export function validateRawConfig(raw: unknown): asserts raw is Record<string, unknown> {
  if (!isConfigObject(raw)) throw new Error("config is not an object");
  if (raw.subscriptionAccounts !== undefined) parseAccountsBlock(raw.subscriptionAccounts);
}
