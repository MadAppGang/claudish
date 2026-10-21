/**
 * `claudish subscription models antigravity --raw --json`
 *
 * Prints the body of Antigravity's `fetchAvailableModels` exactly as the
 * backend sent it (the response text, byte for byte, as a JSON string) inside
 * one JSON envelope on ONE stdout line. The caller is
 * the models-index wire-probe runner: a macOS LaunchAgent with no TTY and no
 * browser. It uploads stdout, and models-index seals the body as evidence of
 * what this account's subscription serves.
 *
 * Everything reuses the claudish Antigravity path. Nothing is re-implemented:
 *   readAntigravityStoreClassified  bounded keychain read, never kills `security`
 *   getValidAntigravityAccessToken  refresh through `agy models` when expired
 *   setupAntigravityUser            loadCodeAssist -> project
 *   fetchAntigravityAvailableModelsRaw  the body, before any processing
 *
 * Contract (ai-docs/architecture/providers/antigravity.md, "Raw model list for
 * models-index"):
 * - Every exit (0 and 1 to 7) writes exactly one JSON object built from the
 *   typed envelope to stdout, and nothing else. An error message is never
 *   printed: messages embed vendor text and agy's stderr.
 * - A field appears exactly when this run determined it.
 * - A non-2xx `fetchAvailableModels` answer is not a failure (exit 0, no body).
 * - Each failure carries a fixed `class` and `code`, and the class decides the
 *   exit code.
 * - Before anything is written, the raw body text and the line are checked for
 *   the access token, the refresh token and the project id. A hit exits 1 and
 *   prints a body-free `secret_guard` failure instead.
 * - No prompt: stdin is never read, no browser path is reachable, claudish
 *   never writes the keychain, and every wait is bounded.
 */

import {
  type AgyRefreshOutcome,
  type AntigravityStoreRead,
  type AntigravityTokenDeps,
  defaultAntigravityTokenDeps,
  getValidAntigravityAccessToken,
  readAntigravityStoreClassified,
  readSharedAntigravityToken,
} from "./auth/antigravity-token.js";
import {
  type AntigravityClientVersionSource,
  type FetchAvailableModelsRaw,
  fetchAntigravityAvailableModelsRaw,
  resolveAntigravityClientVersion,
  setupAntigravityUser,
} from "./auth/antigravity-user.js";
import type { CredentialFailureFields } from "./auth/credentials/credential-error.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_MODEL_LIST_SCHEMA = "claudish.subscription-model-list.v1" as const;

export type FailureClass =
  | "credential_missing"
  | "keychain_locked"
  | "mint_failed"
  | "network"
  | "list_incomplete"
  | "internal";

/** Every fixed `failure.code`, grouped by the class it belongs to. */
export const FAILURE_CODES = {
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
    "fetch_available_models_network_error",
    "fetch_available_models_timeout",
  ],
  list_incomplete: ["models_absent", "models_empty", "body_not_json"],
  internal: ["usage", "secret_guard", "internal_error"],
} as const satisfies Record<FailureClass, readonly string[]>;

export type FailureCode = (typeof FAILURE_CODES)[FailureClass][number];

/**
 * Exit codes. 0 includes a non-2xx `fetchAvailableModels` answer. Class
 * `internal` exits 2 for `usage` and 1 for `secret_guard` and `internal_error`.
 */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  credential_missing: 3,
  keychain_locked: 4,
  mint_failed: 5,
  network: 6,
  list_incomplete: 7,
} as const satisfies Record<FailureClass | "ok" | "usage", number>;

/** The exit code a failure decides: its class, except that `usage` exits 2. */
export function exitCodeFor(failure: SubscriptionModelListFailure): number {
  if (failure.class === "internal") return failure.code === "usage" ? EXIT.usage : EXIT.internal;
  return EXIT[failure.class];
}

export interface SubscriptionModelListFailure {
  class: FailureClass;
  code: FailureCode;
  /** The HTTP status the failure was read from, when one exists. */
  httpStatus?: number;
}

/**
 * The one object on stdout. Key order on the wire is the order below. Optional
 * fields appear exactly when this run determined them.
 */
export interface SubscriptionModelListEnvelope {
  schema: typeof SUBSCRIPTION_MODEL_LIST_SCHEMA;
  /** Present whenever the provider was determined; absent on a usage error. */
  provider?: "antigravity";
  claudishVersion: string;
  /** ISO-8601 UTC, once `fetchAvailableModels` answered. */
  fetchedAt?: string;
  /** `<host>/v1internal:fetchAvailableModels`, userinfo stripped, once it was attempted. */
  sourceUrl?: string;
  /** The client version in the User-Agent, once a valid token was obtained. */
  clientVersion?: string;
  clientVersionSource?: AntigravityClientVersionSource;
  /** Whether this run asked agy to refresh (true even if that refresh failed). */
  tokenRefreshed: boolean;
  /** `fetchAvailableModels` status, once it answered. */
  httpStatus?: number;
  failure?: SubscriptionModelListFailure;
  /**
   * The 2xx response text, byte for byte as `res.text()` read it: never parsed
   * and re-serialized, never trimmed. Success only.
   */
  body?: string;
}

/** The fixed usage line (stderr, exit 2; stdout carries the `usage` failure). */
export const SUBSCRIPTION_MODELS_USAGE =
  "usage: claudish subscription models antigravity --raw --json";
/** The fixed line when the secret guard trips (stderr, exit 1; stdout carries `secret_guard`). */
export const SECRET_GUARD_MESSAGE =
  "[claudish subscription] refused: output contained a credential value";
/** The fixed line for any unexpected error (stderr, exit 1; stdout carries `internal_error`). */
export const INTERNAL_ERROR_MESSAGE = "[claudish subscription] internal error";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SubscriptionModelsDeps {
  /** `process.platform`. */
  platform: () => string;
  /** The bounded, classified keychain read. */
  readStore: (deadlineMs: number) => Promise<AntigravityStoreRead>;
  /** The token module's deps. The command wraps `readStore` and `runAgyRefresh`. */
  tokenDeps: () => AntigravityTokenDeps;
  /** Clock for `fetchedAt`. */
  now: () => number;
  /** Bound on `loadCodeAssist` and on `fetchAvailableModels` (30 s). */
  httpTimeoutMs: number;
  /** Bound on the keychain read (10 s). */
  keychainDeadlineMs: number;
  /**
   * Write one complete line (its trailing newline included) to stdout. Resolves
   * only once the line is flushed: a 200 KB body is larger than a pipe buffer,
   * and `process.exit` right after an unawaited write cuts it at 65,536 bytes.
   */
  writeStdout: (line: string) => Promise<void>;
  /** Write one complete line (its trailing newline included) to stderr. */
  writeStderr: (line: string) => void;
}

export function defaultSubscriptionModelsDeps(): SubscriptionModelsDeps {
  return {
    platform: () => process.platform,
    readStore: readAntigravityStoreClassified,
    tokenDeps: defaultAntigravityTokenDeps,
    now: () => Date.now(),
    httpTimeoutMs: 30_000,
    keychainDeadlineMs: 10_000,
    writeStdout: (line) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (err) => (err ? reject(err) : resolve()));
      }),
    writeStderr: (line) => {
      process.stderr.write(line);
    },
  };
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

export type SubscriptionModelsArgs = { ok: true; provider: "antigravity" } | { ok: false };

/**
 * Parse the argv that follows `subscription`. v1 accepts exactly
 * `models antigravity` plus `--raw` and `--json`, each once, in any order.
 * Anything else is a usage error: a missing flag, the `ag` shortcut, or an
 * extra token. That leaves the bare form free for a later human view.
 */
export function parseSubscriptionModelsArgs(argv: readonly string[]): SubscriptionModelsArgs {
  const positionals = argv.filter((a) => !a.startsWith("-"));
  const flags = argv.filter((a) => a.startsWith("-"));
  const positionalsOk =
    positionals.length === 2 && positionals[0] === "models" && positionals[1] === "antigravity";
  const flagsOk = flags.length === 2 && flags.includes("--raw") && flags.includes("--json");
  return positionalsOk && flagsOk ? { ok: true, provider: "antigravity" } : { ok: false };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** What this run has determined so far: the envelope's optional fields. */
interface Facts {
  provider?: "antigravity";
  fetchedAt?: string;
  sourceUrl?: string;
  clientVersion?: string;
  clientVersionSource?: AntigravityClientVersionSource;
  tokenRefreshed: boolean;
  httpStatus?: number;
}

/** Values the secret guard checks the output line for. */
interface Secrets {
  values: Set<string>;
}

function addSecret(secrets: Secrets, value: string | null | undefined): void {
  if (typeof value === "string" && value.length > 0) secrets.values.add(value);
}

/** Build the envelope with its keys in contract order, omitting what is unknown. */
function buildEnvelope(
  facts: Facts,
  failure?: SubscriptionModelListFailure,
  body?: string
): SubscriptionModelListEnvelope {
  return {
    schema: SUBSCRIPTION_MODEL_LIST_SCHEMA,
    ...(facts.provider !== undefined ? { provider: facts.provider } : {}),
    claudishVersion: VERSION,
    ...(facts.fetchedAt !== undefined ? { fetchedAt: facts.fetchedAt } : {}),
    ...(facts.sourceUrl !== undefined ? { sourceUrl: facts.sourceUrl } : {}),
    ...(facts.clientVersion !== undefined ? { clientVersion: facts.clientVersion } : {}),
    ...(facts.clientVersionSource !== undefined
      ? { clientVersionSource: facts.clientVersionSource }
      : {}),
    tokenRefreshed: facts.tokenRefreshed,
    ...(facts.httpStatus !== undefined ? { httpStatus: facts.httpStatus } : {}),
    ...(failure ? { failure } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

function failureOf(
  cls: FailureClass,
  code: FailureCode,
  httpStatus?: number
): SubscriptionModelListFailure {
  return { class: cls, code, ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

/** `url` without userinfo, so a credential in `AICODE_ENDPOINT_URL` is never printed. */
function stripUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
  }
}

/** The class of a keychain read that produced no value. */
function storeReadFailure(
  read: Exclude<AntigravityStoreRead, { kind: "present" }>
): SubscriptionModelListFailure {
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
function tokenFailure(
  refreshCalled: boolean,
  outcome: AgyRefreshOutcome | null
): SubscriptionModelListFailure {
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
function loadCodeAssistFailure(err: unknown): SubscriptionModelListFailure {
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

/** The class of a 2xx `fetchAvailableModels` JSON body, or null when it lists models. */
function listFailure(value: unknown, status: number): SubscriptionModelListFailure | null {
  const models =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { models?: unknown }).models
      : undefined;
  if (models === null || typeof models !== "object" || Array.isArray(models)) {
    return failureOf("list_incomplete", "models_absent", status);
  }
  if (Object.keys(models).length === 0) {
    return failureOf("list_incomplete", "models_empty", status);
  }
  return null;
}

/** Race `work` against `ms`. The loser keeps running; its rejection is absorbed. */
async function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
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
const TIMED_OUT: unique symbol = Symbol("timed-out");

interface RunResult {
  envelope: SubscriptionModelListEnvelope;
  exitCode: number;
  /** The raw response text printed as `body`, kept for the secret guard. */
  bodyText?: string;
}

function fail(facts: Facts, failure: SubscriptionModelListFailure): RunResult {
  return { envelope: buildEnvelope(facts, failure), exitCode: exitCodeFor(failure) };
}

/** One serialized envelope line, trailing newline included. */
function lineOf(envelope: SubscriptionModelListEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/** Whether any of `texts` contains a secret value, in full. */
function containsSecret(secrets: Secrets, ...texts: (string | undefined)[]): boolean {
  for (const secret of secrets.values) {
    if (texts.some((text) => text?.includes(secret))) return true;
  }
  return false;
}

/** A stderr write that never throws. It carries only fixed lines. */
function safeStderr(deps: SubscriptionModelsDeps, line: string): void {
  try {
    deps.writeStderr(line);
  } catch {
    // Nowhere left to report it.
  }
}

type InternalCode = (typeof FAILURE_CODES)["internal"][number];

/**
 * Write the fixed stderr line, then a class-`internal` failure line through the
 * awaited `writeStdout`, and return the exit code. Never throws.
 *
 * The line holds only `facts` and fixed strings, never a body. It is still
 * checked against `secrets`; a hit (which cannot happen) prints nothing.
 */
async function writeInternalFailure(
  deps: SubscriptionModelsDeps,
  facts: Facts,
  code: InternalCode,
  stderrLine: string,
  secrets?: Secrets
): Promise<number> {
  const failure = failureOf("internal", code);
  safeStderr(deps, `${stderrLine}\n`);
  const line = lineOf(buildEnvelope(facts, failure));
  if (!secrets || !containsSecret(secrets, line)) {
    try {
      await deps.writeStdout(line);
    } catch {
      // stdout is unusable; the stderr line already says what happened.
    }
  }
  return exitCodeFor(failure);
}

/**
 * The `internal_error` exit for a caller with no run state: the `index.ts`
 * catch around the whole command. The line has no `provider` (none was
 * determined) and `tokenRefreshed: false`. Never throws.
 */
export async function reportSubscriptionInternalError(
  deps?: SubscriptionModelsDeps
): Promise<number> {
  let resolved: SubscriptionModelsDeps;
  try {
    resolved = deps ?? defaultSubscriptionModelsDeps();
  } catch {
    process.stderr.write(`${INTERNAL_ERROR_MESSAGE}\n`);
    return EXIT.internal;
  }
  return writeInternalFailure(
    resolved,
    { tokenRefreshed: false },
    "internal_error",
    INTERNAL_ERROR_MESSAGE
  );
}

type TokenStep = { ok: true; accessToken: string } | { ok: false; result: RunResult };

/**
 * Step 4: a valid access token, through the token module with observed deps.
 *
 * The first `readStore` call returns the bounded pre-read, so the token module
 * never spawns an unbounded `security` for it. Later reads (the re-read after a
 * refresh) go to the real store and are kept for the secret guard. The refresh
 * is recorded: whether it was called, and what it reported.
 */
async function obtainAccessToken(
  deps: SubscriptionModelsDeps,
  facts: Facts,
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
    return { ok: false, result: fail(facts, tokenFailure(refreshCalled, refreshOutcome)) };
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

/** Step 7's verdict: the envelope and exit code for one raw `fetchAvailableModels` result. */
function classifyAvailableModels(
  facts: Facts,
  raw: FetchAvailableModelsRaw,
  timedOut: boolean
): RunResult {
  // What was SENT: the same value as step 5 unless the version changed in between.
  facts.sourceUrl = stripUserinfo(raw.url);
  facts.clientVersion = raw.clientVersion;
  facts.clientVersionSource = raw.clientVersionSource;
  const networkCode = timedOut
    ? "fetch_available_models_timeout"
    : "fetch_available_models_network_error";

  if (raw.kind === "unreachable") return fail(facts, failureOf("network", networkCode));
  facts.fetchedAt = raw.fetchedAt;
  facts.httpStatus = raw.status;

  if (raw.status < 200 || raw.status >= 300) {
    // Not a failure: the backend answered, and its status is the answer.
    return { envelope: buildEnvelope(facts), exitCode: EXIT.ok };
  }
  switch (raw.body.kind) {
    case "json": {
      // The parse decides success; the TEXT is what gets printed.
      const incomplete = listFailure(raw.body.value, raw.status);
      if (incomplete) return fail(facts, incomplete);
      return {
        envelope: buildEnvelope(facts, undefined, raw.body.text),
        exitCode: EXIT.ok,
        bodyText: raw.body.text,
      };
    }
    case "not-json":
      return fail(facts, failureOf("list_incomplete", "body_not_json", raw.status));
    default:
      // read-failed (`unread` cannot occur on a 2xx).
      return fail(facts, failureOf("network", networkCode, raw.status));
  }
}

/** Steps 2-7 of the sequence: determine the envelope and its exit code. */
async function determine(
  deps: SubscriptionModelsDeps,
  secrets: Secrets,
  facts: Facts
): Promise<RunResult> {
  if (deps.platform() !== "darwin") {
    return fail(facts, failureOf("credential_missing", "platform_unsupported"));
  }

  const read = await deps.readStore(deps.keychainDeadlineMs);
  if (read.kind !== "present") return fail(facts, storeReadFailure(read));
  addSecret(secrets, read.raw);

  const token = await obtainAccessToken(deps, facts, secrets, read.raw);
  if (!token.ok) return token.result;

  const version = resolveAntigravityClientVersion();
  facts.clientVersion = version.version;
  facts.clientVersionSource = version.source;

  let projectId: string;
  try {
    const setup = await raceTimeout(setupAntigravityUser(token.accessToken), deps.httpTimeoutMs);
    if (setup === TIMED_OUT) return fail(facts, failureOf("network", "load_code_assist_timeout"));
    projectId = setup.projectId;
  } catch (err) {
    return fail(facts, loadCodeAssistFailure(err));
  }
  addSecret(secrets, projectId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.httpTimeoutMs);
  try {
    const raw = await fetchAntigravityAvailableModelsRaw(token.accessToken, projectId, {
      signal: controller.signal,
      now: deps.now,
    });
    return classifyAvailableModels(facts, raw, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Determine the envelope, run the secret guard, write ONE flushed line, and
 * return the exit code. Never throws.
 *
 * Both exit-1 paths write their fixed stderr line and a class-`internal` line:
 * - an unexpected error: `internal_error`, with `provider` and the
 *   `tokenRefreshed` known so far, and nothing else the failed run determined;
 * - a secret-guard hit: `secret_guard`, with every fact determined so far and
 *   never a body.
 */
export async function runAntigravityRawModelList(deps: SubscriptionModelsDeps): Promise<number> {
  const secrets: Secrets = { values: new Set() };
  const facts: Facts = { provider: "antigravity", tokenRefreshed: false };
  let line: string;
  let exitCode: number;
  let bodyText: string | undefined;
  try {
    const result = await determine(deps, secrets, facts);
    line = lineOf(result.envelope);
    exitCode = result.exitCode;
    bodyText = result.bodyText;
  } catch {
    return writeInternalFailure(
      deps,
      { provider: facts.provider, tokenRefreshed: facts.tokenRefreshed },
      "internal_error",
      INTERNAL_ERROR_MESSAGE,
      secrets
    );
  }
  // The raw text too: an escaped form in the line cannot hide a credential.
  if (containsSecret(secrets, line, bodyText)) {
    return writeInternalFailure(deps, facts, "secret_guard", SECRET_GUARD_MESSAGE, secrets);
  }
  try {
    await deps.writeStdout(line);
  } catch {
    // Not followed by an `internal_error` line: a write that failed part-way
    // would leave a second object on stdout.
    safeStderr(deps, `${INTERNAL_ERROR_MESSAGE}\n`);
    return EXIT.internal;
  }
  return exitCode;
}

/**
 * Entry point for the argv that follows `subscription`. Returns the exit code;
 * the caller exits with it (an unkilled `security` would keep the loop alive).
 */
export async function subscriptionModelsCommand(
  argv: readonly string[],
  deps: SubscriptionModelsDeps = defaultSubscriptionModelsDeps()
): Promise<number> {
  if (!parseSubscriptionModelsArgs(argv).ok) {
    // No provider was determined, so the line omits it.
    return writeInternalFailure(
      deps,
      { tokenRefreshed: false },
      "usage",
      SUBSCRIPTION_MODELS_USAGE
    );
  }
  return runAntigravityRawModelList(deps);
}
