/**
 * The steps every `claudish subscription … antigravity --raw --json` command
 * shares before its own request: platform, bounded keychain read, a valid
 * access token (refreshed through agy when expired), the client version, and
 * `loadCodeAssist` -> project. Each step records what it determined in the
 * caller's facts and every credential value it saw in the caller's secrets.
 *
 * Used by `subscription-models-command.ts` (`fetchAvailableModels`) and
 * `subscription-probe-command.ts` (`generateContent`). Contract:
 * ai-docs/architecture/providers/antigravity.md.
 */

import {
  type AgyRefreshOutcome,
  type AntigravityStoreRead,
  type AntigravityTokenDeps,
  getValidAntigravityAccessToken,
  readSharedAntigravityToken,
} from "./auth/antigravity-token.js";
import {
  type AntigravityClientVersionSource,
  resolveAntigravityClientVersion,
  setupAntigravityUser,
} from "./auth/antigravity-user.js";
import type { CredentialFailureFields } from "./auth/credentials/credential-error.js";

export type FailureClass =
  | "credential_missing"
  | "keychain_locked"
  | "mint_failed"
  | "network"
  | "list_incomplete"
  | "internal";

/** Every fixed code the shared steps can fail with, by class. */
export const SESSION_FAILURE_CODES = {
  credential_missing: ["platform_unsupported", "keychain_item_absent", "token_unparseable"],
  keychain_locked: ["keychain_locked", "keychain_read_timeout", "keychain_read_failed"],
  mint_failed: [
    "agy_missing",
    "agy_refresh_failed",
    "agy_refresh_timeout",
    "agy_refresh_no_valid_token",
    "load_code_assist_4xx",
    "load_code_assist_no_project",
    "load_code_assist_bad_body",
  ],
  network: [
    "load_code_assist_network_error",
    "load_code_assist_429",
    "load_code_assist_5xx",
    "load_code_assist_timeout",
  ],
} as const;

export type SessionFailureCode =
  (typeof SESSION_FAILURE_CODES)[keyof typeof SESSION_FAILURE_CODES][number];

export interface SessionFailure {
  class: FailureClass;
  code: SessionFailureCode;
  httpStatus?: number;
}

/** What the shared steps need from a command's deps. */
export interface AntigravitySessionDeps {
  platform: () => string;
  readStore: (deadlineMs: number) => Promise<AntigravityStoreRead>;
  tokenDeps: () => AntigravityTokenDeps;
  /** Bound on `loadCodeAssist`. */
  httpTimeoutMs: number;
  keychainDeadlineMs: number;
}

/** The facts the shared steps determine. A command's own facts extend these. */
export interface AntigravitySessionFacts {
  tokenRefreshed: boolean;
  clientVersion?: string;
  clientVersionSource?: AntigravityClientVersionSource;
}

/** Values no output line may carry. */
export interface Secrets {
  values: Set<string>;
}

export function newSecrets(): Secrets {
  return { values: new Set() };
}

export function addSecret(secrets: Secrets, value: string | null | undefined): void {
  if (typeof value === "string" && value.length > 0) secrets.values.add(value);
}

/** Whether any of `texts` contains a secret value, in full. */
export function containsSecret(secrets: Secrets, ...texts: (string | undefined)[]): boolean {
  for (const secret of secrets.values) {
    if (texts.some((text) => text?.includes(secret))) return true;
  }
  return false;
}

export function failureOf<C extends string>(
  cls: FailureClass,
  code: C,
  httpStatus?: number
): { class: FailureClass; code: C; httpStatus?: number } {
  return { class: cls, code, ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

/** `url` without userinfo, so a credential in `AICODE_ENDPOINT_URL` is never printed. */
export function stripUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
  }
}

export const TIMED_OUT: unique symbol = Symbol("timed-out");

/** Race `work` against `ms`. The loser keeps running; its rejection is absorbed. */
export async function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The class of a keychain read that produced no value. */
function storeReadFailure(
  read: Exclude<AntigravityStoreRead, { kind: "present" }>
): SessionFailure {
  switch (read.kind) {
    case "absent":
      return failureOf("credential_missing", "keychain_item_absent");
    case "locked":
      return failureOf("keychain_locked", "keychain_locked");
    case "timeout":
      return failureOf("keychain_locked", "keychain_read_timeout");
    default:
      return failureOf("keychain_locked", "keychain_read_failed");
  }
}

/** The class of a token failure, from what was OBSERVED, never from message text. */
function tokenFailure(refreshCalled: boolean, outcome: AgyRefreshOutcome | null): SessionFailure {
  if (!refreshCalled) return failureOf("credential_missing", "token_unparseable");
  switch (outcome?.kind) {
    case "not-installed":
      return failureOf("mint_failed", "agy_missing");
    case "timeout":
      return failureOf("mint_failed", "agy_refresh_timeout");
    case "ran":
      return failureOf("mint_failed", "agy_refresh_no_valid_token");
    default:
      // "failed", or a refresh that threw before reporting an outcome.
      return failureOf("mint_failed", "agy_refresh_failed");
  }
}

/** The class of a `setupAntigravityUser` failure, from its fields. */
function loadCodeAssistFailure(err: unknown): SessionFailure {
  const fields = (err ?? {}) as CredentialFailureFields;
  const status = typeof fields.upstreamStatus === "number" ? fields.upstreamStatus : undefined;
  if (status !== undefined) {
    if (status === 429) return failureOf("network", "load_code_assist_429", status);
    if (status >= 500 && status <= 599) return failureOf("network", "load_code_assist_5xx", status);
    return failureOf("mint_failed", "load_code_assist_4xx", status);
  }
  // A 2xx body that is not JSON: `Response.json()` throws SyntaxError (Phase 0, M4).
  if (err instanceof SyntaxError) return failureOf("mint_failed", "load_code_assist_bad_body");
  // No project in a 2xx answer: the only terminal error without a status.
  if (fields.terminal === true) return failureOf("mint_failed", "load_code_assist_no_project");
  return failureOf("network", "load_code_assist_network_error");
}

type TokenStep = { ok: true; accessToken: string } | { ok: false; failure: SessionFailure };

/**
 * A valid access token, through the token module with observed deps.
 *
 * The first `readStore` call returns the bounded pre-read, so the token module
 * never spawns an unbounded `security` for it. Later reads (the re-read after a
 * refresh) go to the real store and are kept for the secret guard. The refresh
 * is recorded: whether it was called, and what it reported.
 */
async function obtainAccessToken(
  deps: AntigravitySessionDeps,
  facts: AntigravitySessionFacts,
  secrets: Secrets,
  preRaw: string
): Promise<TokenStep> {
  const base = deps.tokenDeps();
  let firstRead = true;
  let refreshCalled = false;
  let refreshOutcome: AgyRefreshOutcome | null = null;
  const laterReads: string[] = [];
  const observed: AntigravityTokenDeps = {
    ...base,
    readStore: () => {
      if (firstRead) {
        firstRead = false;
        return preRaw;
      }
      const raw = base.readStore();
      if (raw) laterReads.push(raw);
      return raw;
    },
    runAgyRefresh: () => {
      refreshCalled = true;
      facts.tokenRefreshed = true;
      refreshOutcome = base.runAgyRefresh();
      return refreshOutcome;
    },
  };

  let accessToken: string;
  try {
    accessToken = await getValidAntigravityAccessToken(observed);
  } catch {
    // A failure envelope holds only fixed strings, and `preRaw` is already guarded.
    return { ok: false, failure: tokenFailure(refreshCalled, refreshOutcome) };
  }
  addSecret(secrets, accessToken);
  // Every refresh token this run saw is a secret, whichever read it came from.
  // Parsed only on success: every record read on this path has already parsed,
  // so this logs nothing a second time.
  for (const raw of [preRaw, ...laterReads]) {
    addSecret(secrets, raw);
    addSecret(
      secrets,
      readSharedAntigravityToken({ ...base, readStore: () => raw })?.refresh_token
    );
  }
  return { ok: true, accessToken };
}

export type AntigravitySession =
  | { ok: true; accessToken: string; projectId: string; tierId: string }
  | { ok: false; failure: SessionFailure };

/**
 * Platform, keychain, token, client version, `loadCodeAssist`. On success the
 * access token, the refresh tokens and the project id are all in `secrets`.
 */
export async function establishAntigravitySession(
  deps: AntigravitySessionDeps,
  secrets: Secrets,
  facts: AntigravitySessionFacts
): Promise<AntigravitySession> {
  if (deps.platform() !== "darwin") {
    return { ok: false, failure: failureOf("credential_missing", "platform_unsupported") };
  }

  const read = await deps.readStore(deps.keychainDeadlineMs);
  if (read.kind !== "present") return { ok: false, failure: storeReadFailure(read) };
  addSecret(secrets, read.raw);

  const token = await obtainAccessToken(deps, facts, secrets, read.raw);
  if (!token.ok) return token;

  const version = resolveAntigravityClientVersion();
  facts.clientVersion = version.version;
  facts.clientVersionSource = version.source;

  let projectId: string;
  let tierId: string;
  try {
    const setup = await raceTimeout(setupAntigravityUser(token.accessToken), deps.httpTimeoutMs);
    if (setup === TIMED_OUT) {
      return { ok: false, failure: failureOf("network", "load_code_assist_timeout") };
    }
    projectId = setup.projectId;
    tierId = setup.tierId;
  } catch (err) {
    return { ok: false, failure: loadCodeAssistFailure(err) };
  }
  addSecret(secrets, projectId);
  return { ok: true, accessToken: token.accessToken, projectId, tierId };
}
