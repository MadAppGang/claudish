/**
 * `claudish subscription probe antigravity|devin --model <wire model id>
 *    --request-file <path> --raw --json`
 *
 * Sends ONE real request through the user's subscription login and prints the
 * vendor's answer inside one JSON envelope on ONE stdout line. The caller is
 * the models-index wire-probe runner: it never holds the credential, it hands
 * over the request in a file, and it seals the answer as evidence of what the
 * connection does on the wire.
 *
 * Antigravity (this module): the file is the inner Gemini-format `request`
 * object. The request is sent exactly as the file says: no retry, no model-id
 * rewrite (the `ag@` path resolves the id against the account's dynamic models
 * catalog; this command does not), no thinking or effort translation. The
 * file's bytes are spliced into the CodeAssist envelope, never parsed and
 * re-serialized. The envelope and headers are the ones
 * `AntigravityCredentialProvider` builds for `ag@`.
 *
 * Devin: `subscription-devin-probe.ts`, loaded only for a `devin` argv. It
 * shares the envelope, the run wrapper and the guard defined here.
 *
 * Contract: ai-docs/architecture/providers/antigravity.md and
 * ai-docs/architecture/providers/devin.md, "Wire probe for models-index". It
 * mirrors `subscription models` (`subscription-models-command.ts`): one line on
 * every exit, field presence, fixed failure classes and exit codes, and the
 * secret guard. Two differences:
 * - A non-2xx answer is exit 0 WITH its body: the vendor's error is evidence.
 * - A credential value inside the vendor's body is replaced by `[REDACTED]`
 *   and `bodyRedacted` says so; the refuse-on-hit guard still runs over the
 *   final line.
 */

import { randomUUID } from "node:crypto";
import {
  defaultAntigravityTokenDeps,
  readAntigravityStoreClassified,
} from "./auth/antigravity-token.js";
import {
  type AntigravityClientVersionSource,
  antigravityHost,
  antigravityUserAgentFor,
  resolveAntigravityClientVersion,
} from "./auth/antigravity-user.js";
import {
  type AntigravitySessionDeps,
  type FailureClass,
  SESSION_FAILURE_CODES,
  type Secrets,
  type SubscriptionCommandProvider,
  containsSecret,
  establishAntigravitySession,
  newSecrets,
  failureOf as sessionFailureOf,
  stripUserinfo,
} from "./subscription-antigravity-session.js";
import { SUBSCRIPTION_PROBE_SCHEMA } from "./subscription-dispatch.js";
import {
  PROBE_BODY_CAP_BYTES,
  defaultReadRequestFile,
  jsonUnescapedForms,
  readCapped,
  readRequestFileChecked,
  redactSecretValues,
} from "./subscription-secret-guard.js";
import { VERSION } from "./version.js";

export { isSubscriptionProbeArgv, SUBSCRIPTION_PROBE_SCHEMA } from "./subscription-dispatch.js";
export {
  MAX_UNESCAPE_ROUNDS,
  PROBE_BODY_CAP_BYTES,
  PROBE_REQUEST_FILE_CAP_BYTES,
  REDACTED,
  jsonUnescapedForms,
  readCapped,
  redactSecretValues,
} from "./subscription-secret-guard.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Every fixed `failure.code`, grouped by the class it belongs to. */
export const PROBE_FAILURE_CODES = {
  credential_missing: [...SESSION_FAILURE_CODES.credential_missing, "devin_credential_absent"],
  keychain_locked: SESSION_FAILURE_CODES.keychain_locked,
  mint_failed: SESSION_FAILURE_CODES.mint_failed,
  network: [
    ...SESSION_FAILURE_CODES.network,
    "generate_content_network_error",
    "generate_content_timeout",
    "get_chat_message_network_error",
    "get_chat_message_timeout",
  ],
  list_incomplete: ["body_too_large", "body_not_json", "body_unverifiable"],
  internal: [
    "usage",
    "request_file_unreadable",
    "request_file_invalid",
    "secret_guard",
    "internal_error",
  ],
} as const satisfies Record<FailureClass, readonly string[]>;

export type ProbeFailureCode = (typeof PROBE_FAILURE_CODES)[FailureClass][number];

export interface SubscriptionProbeFailure {
  class: FailureClass;
  code: ProbeFailureCode;
  httpStatus?: number;
}

/** Exit codes: the same table as `subscription models`. */
export const PROBE_EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  credential_missing: 3,
  keychain_locked: 4,
  mint_failed: 5,
  network: 6,
  list_incomplete: 7,
} as const;

/** Caller errors exit 2: the argv or the request file, never the account. */
const CALLER_CODES: readonly ProbeFailureCode[] = [
  "usage",
  "request_file_unreadable",
  "request_file_invalid",
];

export function probeExitCodeFor(failure: SubscriptionProbeFailure): number {
  if (failure.class === "internal") {
    return CALLER_CODES.includes(failure.code) ? PROBE_EXIT.usage : PROBE_EXIT.internal;
  }
  return PROBE_EXIT[failure.class];
}

/** A Devin error frame inside an HTTP 200: its code and whether it is retryable. */
export interface ProbeStreamError {
  code: string;
  retryable: boolean;
}

/**
 * The one object on stdout. Key order on the wire is the order below. Optional
 * fields appear exactly when this run determined them.
 */
export interface SubscriptionProbeEnvelope {
  schema: typeof SUBSCRIPTION_PROBE_SCHEMA;
  /** Present once the argv parsed; absent on a usage error. */
  provider?: SubscriptionCommandProvider;
  claudishVersion: string;
  /** The `--model` value, sent unchanged. Present with `provider`. */
  model?: string;
  /** ISO-8601 UTC, once the request answered. */
  fetchedAt?: string;
  /** The request URL, userinfo stripped, once it was attempted. */
  sourceUrl?: string;
  clientVersion?: string;
  /** Antigravity only. */
  clientVersionSource?: AntigravityClientVersionSource;
  tokenRefreshed: boolean;
  /** The request's HTTP status, once it answered. */
  httpStatus?: number;
  /** Devin only: the uid the backend reported serving (field 7.9), when it reported one. */
  servedModel?: string;
  /** Devin only: an error frame carried inside the HTTP 200. */
  streamError?: ProbeStreamError;
  failure?: SubscriptionProbeFailure;
  /** Present with `body`: whether a credential value was replaced inside it. */
  bodyRedacted?: boolean;
  /**
   * The response text, 2xx or not, as read, apart from redaction. Antigravity:
   * a 2xx body parsed as JSON; a non-2xx body is printed whatever it is.
   * Devin: a 2xx answer is the decoded Messages object as JSON text.
   */
  body?: string;
}

export const SUBSCRIPTION_PROBE_USAGE =
  "usage: claudish subscription probe antigravity|devin --model <wire-model-id> --request-file <path> --raw --json";
export const PROBE_REQUEST_FILE_MESSAGE =
  "[claudish subscription] the request file must hold one JSON object (the inner Gemini request)";
const SECRET_GUARD_MESSAGE = "[claudish subscription] refused: output contained a credential value";
const INTERNAL_ERROR_MESSAGE = "[claudish subscription] internal error";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SubscriptionProbeDeps extends AntigravitySessionDeps {
  now: () => number;
  /** Bound on the probe request: the fetch AND the body read (300 s). */
  requestTimeoutMs: number;
  /** Read the request file. Rejects when it is unreadable; `null` when it is over the cap. */
  readRequestFile: (path: string) => Promise<string | null>;
  /** Write one complete line; resolves once it is flushed. */
  writeStdout: (line: string) => Promise<void>;
  writeStderr: (line: string) => void;
}

/** What every provider's probe run uses from the deps. */
export type ProbeOutputDeps = Pick<SubscriptionProbeDeps, "writeStdout" | "writeStderr">;

export function defaultSubscriptionProbeDeps(): SubscriptionProbeDeps {
  return {
    platform: () => process.platform,
    readStore: readAntigravityStoreClassified,
    tokenDeps: defaultAntigravityTokenDeps,
    now: () => Date.now(),
    httpTimeoutMs: 30_000,
    keychainDeadlineMs: 10_000,
    requestTimeoutMs: 300_000,
    readRequestFile: defaultReadRequestFile,
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

export type SubscriptionProbeArgs =
  | { ok: true; provider: SubscriptionCommandProvider; model: string; requestFile: string }
  | { ok: false };

const PROBE_PROVIDERS: readonly string[] = ["antigravity", "devin"];

/**
 * Parse the argv that follows `subscription`: exactly `probe antigravity` or
 * `probe devin`, `--model <id>`, `--request-file <path>`, `--raw` and
 * `--json`, each once, in any order. A value is the next token and must not
 * start with `-`. Anything else (the `ag` or `dv` shortcut, `--model=x`, an
 * extra token) is a usage error.
 */
export function parseSubscriptionProbeArgs(argv: readonly string[]): SubscriptionProbeArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--model" || token === "--request-file") {
      const value = argv[i + 1];
      if (values.has(token) || value === undefined || value === "" || value.startsWith("-")) {
        return { ok: false };
      }
      values.set(token, value);
      i++;
    } else if (token === "--raw" || token === "--json") {
      if (switches.has(token)) return { ok: false };
      switches.add(token);
    } else if (token.startsWith("-")) {
      return { ok: false };
    } else {
      positionals.push(token);
    }
  }
  const model = values.get("--model");
  const requestFile = values.get("--request-file");
  if (
    positionals.length !== 2 ||
    positionals[0] !== "probe" ||
    !PROBE_PROVIDERS.includes(positionals[1]) ||
    switches.size !== 2 ||
    model === undefined ||
    requestFile === undefined
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    provider: positionals[1] as SubscriptionCommandProvider,
    model,
    requestFile,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** What a probe run has determined so far: the envelope's optional fields. */
export interface ProbeFacts {
  provider?: SubscriptionCommandProvider;
  model?: string;
  fetchedAt?: string;
  sourceUrl?: string;
  clientVersion?: string;
  clientVersionSource?: AntigravityClientVersionSource;
  tokenRefreshed: boolean;
  httpStatus?: number;
  servedModel?: string;
  streamError?: ProbeStreamError;
}

export function probeFailureOf(
  cls: FailureClass,
  code: ProbeFailureCode,
  httpStatus?: number
): SubscriptionProbeFailure {
  return sessionFailureOf(cls, code, httpStatus);
}

/** Build the envelope with its keys in contract order, omitting what is unknown. */
export function buildProbeEnvelope(
  facts: ProbeFacts,
  failure?: SubscriptionProbeFailure,
  body?: { text: string; redacted: boolean }
): SubscriptionProbeEnvelope {
  return {
    schema: SUBSCRIPTION_PROBE_SCHEMA,
    ...(facts.provider !== undefined ? { provider: facts.provider } : {}),
    claudishVersion: VERSION,
    ...(facts.model !== undefined ? { model: facts.model } : {}),
    ...(facts.fetchedAt !== undefined ? { fetchedAt: facts.fetchedAt } : {}),
    ...(facts.sourceUrl !== undefined ? { sourceUrl: facts.sourceUrl } : {}),
    ...(facts.clientVersion !== undefined ? { clientVersion: facts.clientVersion } : {}),
    ...(facts.clientVersionSource !== undefined
      ? { clientVersionSource: facts.clientVersionSource }
      : {}),
    tokenRefreshed: facts.tokenRefreshed,
    ...(facts.httpStatus !== undefined ? { httpStatus: facts.httpStatus } : {}),
    ...(facts.servedModel !== undefined ? { servedModel: facts.servedModel } : {}),
    ...(facts.streamError !== undefined ? { streamError: facts.streamError } : {}),
    ...(failure ? { failure } : {}),
    ...(body ? { bodyRedacted: body.redacted, body: body.text } : {}),
  };
}

export interface ProbeRunResult {
  envelope: SubscriptionProbeEnvelope;
  exitCode: number;
  /** The printed body text, kept for the secret guard. */
  bodyText?: string;
  /** Every decoded form of `bodyText`, complete to a fixed point, for the guard. */
  bodyForms?: string[];
}

export function probeFail(facts: ProbeFacts, failure: SubscriptionProbeFailure): ProbeRunResult {
  return { envelope: buildProbeEnvelope(facts, failure), exitCode: probeExitCodeFor(failure) };
}

/**
 * The success result for a body text that was read within the cap: redact it,
 * decode every escaped form, and withhold it as `body_unverifiable` when the
 * forms do not reach a fixed point within the budget.
 */
export function probeBodyResult(
  facts: ProbeFacts,
  text: string,
  secrets: Secrets,
  status: number
): ProbeRunResult {
  const body = redactSecretValues(text, secrets);
  const unescaped = jsonUnescapedForms(body.text);
  if (!unescaped.complete) {
    // The guard could not decode it to a fixed point, so it cannot vouch for it.
    return probeFail(facts, probeFailureOf("list_incomplete", "body_unverifiable", status));
  }
  return {
    envelope: buildProbeEnvelope(facts, undefined, body),
    exitCode: PROBE_EXIT.ok,
    bodyText: body.text,
    bodyForms: unescaped.forms,
  };
}

function lineOf(envelope: SubscriptionProbeEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

function safeStderr(deps: ProbeOutputDeps, line: string): void {
  try {
    deps.writeStderr(line);
  } catch {
    // Nowhere left to report it.
  }
}

/**
 * Write a fixed stderr line, then a class-`internal` failure line, and return
 * the exit code. The line holds only facts and fixed strings; it is still
 * checked against `secrets`; on a hit the line drops to its fixed fields. Never throws.
 */
async function writeInternalFailure(
  deps: ProbeOutputDeps,
  facts: ProbeFacts,
  code: (typeof PROBE_FAILURE_CODES)["internal"][number],
  stderrLine: string,
  secrets?: Secrets
): Promise<number> {
  const failure = probeFailureOf("internal", code);
  safeStderr(deps, `${stderrLine}\n`);
  let line = lineOf(buildProbeEnvelope(facts, failure));
  if (secrets && containsSecret(secrets, line)) {
    // A caller-supplied value (`--model`) can equal a credential. Drop every
    // fact but the fixed ones, so a line is still printed: it then holds only
    // the schema, the version, a boolean and fixed failure strings. It is NOT
    // checked again, on purpose: every byte of it is a constant in the
    // published source, so a "credential" that matches part of it (a project
    // id spelled `internal`) reveals nothing, while suppressing it would break
    // the one-line-on-every-exit contract.
    line = lineOf(buildProbeEnvelope({ tokenRefreshed: facts.tokenRefreshed }, failure));
  }
  try {
    await deps.writeStdout(line);
  } catch {
    // stdout is unusable; the stderr line already says what happened.
  }
  return probeExitCodeFor(failure);
}

/**
 * The shared tail of every provider's probe: run `determine`, run the secret
 * guard, write ONE flushed line, and return the exit code. Never throws.
 *
 * `requestFileMessage` is the fixed stderr line printed on a request-file
 * failure; it names what the provider's file must hold.
 */
export async function runProbeWith(
  deps: ProbeOutputDeps,
  facts: ProbeFacts,
  secrets: Secrets,
  requestFileMessage: string,
  determine: () => Promise<ProbeRunResult>
): Promise<number> {
  let result: ProbeRunResult;
  try {
    result = await determine();
  } catch {
    return writeInternalFailure(
      deps,
      { provider: facts.provider, model: facts.model, tokenRefreshed: facts.tokenRefreshed },
      "internal_error",
      INTERNAL_ERROR_MESSAGE,
      secrets
    );
  }
  if (
    result.envelope.failure?.code === "request_file_unreadable" ||
    result.envelope.failure?.code === "request_file_invalid"
  ) {
    safeStderr(deps, `${requestFileMessage}\n`);
  }
  const line = lineOf(result.envelope);
  // Redaction ran on the body; this is the backstop over everything printed.
  if (containsSecret(secrets, line, result.bodyText, ...(result.bodyForms ?? []))) {
    return writeInternalFailure(deps, facts, "secret_guard", SECRET_GUARD_MESSAGE, secrets);
  }
  try {
    await deps.writeStdout(line);
  } catch {
    safeStderr(deps, `${INTERNAL_ERROR_MESSAGE}\n`);
    return PROBE_EXIT.internal;
  }
  return result.exitCode;
}

/**
 * The CodeAssist envelope `AntigravityCredentialProvider` builds:
 * `{model, project, user_prompt_id, request}`, plus `enabled_credit_types` on a
 * paid tier. `request` is the file's own text, spliced in.
 */
export function buildProbeEnvelopeBody(
  model: string,
  projectId: string,
  tierId: string,
  requestText: string,
  userPromptId: string = randomUUID()
): string {
  const head = JSON.stringify({ model, project: projectId, user_prompt_id: userPromptId });
  const credits =
    tierId && tierId !== "free-tier"
      ? `,"enabled_credit_types":${JSON.stringify(["GOOGLE_ONE_AI"])}`
      : "";
  return `${head.slice(0, -1)},"request":${requestText}${credits}}`;
}

/** A short random id, as the Antigravity CLI's activity logger makes one. */
function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

async function determineAntigravity(
  deps: SubscriptionProbeDeps,
  secrets: Secrets,
  facts: ProbeFacts,
  args: { model: string; requestFile: string }
): Promise<ProbeRunResult> {
  // The caller's file first: a request that cannot be sent touches no credential.
  const request = await readRequestFileChecked(deps.readRequestFile, args.requestFile);
  if (!request.ok) return probeFail(facts, probeFailureOf("internal", request.code));

  const session = await establishAntigravitySession(deps, secrets, facts);
  if (!session.ok) return probeFail(facts, session.failure);

  // URL, version and User-Agent in one synchronous step, so the envelope
  // names what this request presented.
  const url = `${antigravityHost()}/v1internal:generateContent`;
  const version = resolveAntigravityClientVersion();
  facts.sourceUrl = stripUserinfo(url);
  facts.clientVersion = version.version;
  facts.clientVersionSource = version.source;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.requestTimeoutMs);
  const networkFailure = () =>
    probeFailureOf(
      "network",
      controller.signal.aborted ? "generate_content_timeout" : "generate_content_network_error",
      facts.httpStatus
    );
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": antigravityUserAgentFor(version.version),
          "x-activity-request-id": createActivityRequestId(),
        },
        // Untrimmed: JSON allows whitespace around a value, so the splice stays
        // valid and the caller's bytes reach the wire as written.
        body: buildProbeEnvelopeBody(args.model, session.projectId, session.tierId, request.text),
        signal: controller.signal,
        // A 3xx is the answer. Following it would POST a second generation
        // and report the second response's status instead of the first.
        redirect: "manual",
      });
    } catch {
      return probeFail(facts, networkFailure());
    }
    facts.fetchedAt = new Date(deps.now()).toISOString();
    facts.httpStatus = res.status;

    let text: string | null;
    try {
      text = await readCapped(res, PROBE_BODY_CAP_BYTES);
    } catch {
      return probeFail(facts, networkFailure());
    }
    if (text === null)
      return probeFail(facts, probeFailureOf("list_incomplete", "body_too_large", res.status));

    if (res.ok) {
      try {
        JSON.parse(text);
      } catch {
        return probeFail(facts, probeFailureOf("list_incomplete", "body_not_json", res.status));
      }
    }
    // A non-2xx answer is not a failure: the vendor's error body is the evidence.
    return probeBodyResult(facts, text, secrets, res.status);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Determine the envelope, run the secret guard, write ONE flushed line, and
 * return the exit code. Never throws.
 */
export async function runAntigravityProbe(
  deps: SubscriptionProbeDeps,
  args: { model: string; requestFile: string }
): Promise<number> {
  const secrets = newSecrets();
  const facts: ProbeFacts = { provider: "antigravity", model: args.model, tokenRefreshed: false };
  return runProbeWith(deps, facts, secrets, PROBE_REQUEST_FILE_MESSAGE, () =>
    determineAntigravity(deps, secrets, facts, args)
  );
}

/**
 * The `internal_error` exit for a caller with no run state: the `index.ts`
 * catch around the whole command. No `provider`, `tokenRefreshed: false`.
 * Never throws.
 */
export async function reportProbeInternalError(deps?: SubscriptionProbeDeps): Promise<number> {
  let resolved: SubscriptionProbeDeps;
  try {
    resolved = deps ?? defaultSubscriptionProbeDeps();
  } catch {
    process.stderr.write(`${INTERNAL_ERROR_MESSAGE}\n`);
    return PROBE_EXIT.internal;
  }
  return writeInternalFailure(
    resolved,
    { tokenRefreshed: false },
    "internal_error",
    INTERNAL_ERROR_MESSAGE
  );
}

/** Entry point for the argv that follows `subscription`, when it starts with `probe`. */
export async function subscriptionProbeCommand(
  argv: readonly string[],
  deps: SubscriptionProbeDeps = defaultSubscriptionProbeDeps()
): Promise<number> {
  const args = parseSubscriptionProbeArgs(argv);
  if (!args.ok) {
    return writeInternalFailure(deps, { tokenRefreshed: false }, "usage", SUBSCRIPTION_PROBE_USAGE);
  }
  if (args.provider === "devin") {
    // Loaded only for a Devin argv: the Antigravity probe never pulls in the
    // Devin adapter, codec and stream parser.
    let devin: typeof import("./subscription-devin-probe.js");
    try {
      devin = await import("./subscription-devin-probe.js");
    } catch {
      return writeInternalFailure(
        deps,
        { provider: args.provider, model: args.model, tokenRefreshed: false },
        "internal_error",
        INTERNAL_ERROR_MESSAGE
      );
    }
    return devin.runDevinProbe(deps, args);
  }
  return runAntigravityProbe(deps, args);
}
