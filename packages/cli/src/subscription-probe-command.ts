/**
 * `claudish subscription probe antigravity --model <wire model id>
 *    --request-file <path> --raw --json`
 *
 * Sends ONE real request through the user's Antigravity login and prints the
 * vendor's answer inside one JSON envelope on ONE stdout line. The caller is
 * the models-index wire-probe runner: it never holds the token, it hands over
 * the inner Gemini-format `request` object in a file, and it seals the answer
 * as evidence of what the connection does on the wire.
 *
 * The request is sent exactly as the file says: no retry, no model-id rewrite
 * (the `ag@` path resolves the id against the account's dynamic models
 * catalog; this command does not), no thinking or effort translation. The
 * file's bytes are spliced into the CodeAssist envelope, never parsed and
 * re-serialized. The envelope and headers are the ones
 * `AntigravityCredentialProvider` builds for `ag@`.
 *
 * Contract: ai-docs/architecture/providers/antigravity.md, "Wire probe for
 * models-index". It mirrors `subscription models antigravity`
 * (`subscription-models-command.ts`): one line on every exit, field presence,
 * fixed failure classes and exit codes, and the secret guard. Two differences:
 * - A non-2xx answer is exit 0 WITH its body: the vendor's error is evidence.
 * - A credential value inside the vendor's body is replaced by `[REDACTED]`
 *   and `bodyRedacted` says so; the refuse-on-hit guard still runs over the
 *   final line.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
  containsSecret,
  establishAntigravitySession,
  newSecrets,
  failureOf as sessionFailureOf,
  stripUserinfo,
} from "./subscription-antigravity-session.js";
import { SUBSCRIPTION_PROBE_SCHEMA } from "./subscription-dispatch.js";
import { VERSION } from "./version.js";

export { isSubscriptionProbeArgv, SUBSCRIPTION_PROBE_SCHEMA } from "./subscription-dispatch.js";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Every fixed `failure.code`, grouped by the class it belongs to. */
export const PROBE_FAILURE_CODES = {
  credential_missing: SESSION_FAILURE_CODES.credential_missing,
  keychain_locked: SESSION_FAILURE_CODES.keychain_locked,
  mint_failed: SESSION_FAILURE_CODES.mint_failed,
  network: [
    ...SESSION_FAILURE_CODES.network,
    "generate_content_network_error",
    "generate_content_timeout",
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

/** The largest response body printed. A larger one is `body_too_large`, with no body. */
export const PROBE_BODY_CAP_BYTES = 512 * 1024;
/** The largest request file read. A larger one is `request_file_invalid`. */
export const PROBE_REQUEST_FILE_CAP_BYTES = 8 * 1024 * 1024;
/** What replaces a credential value inside the vendor's body. */
export const REDACTED = "[REDACTED]";

/**
 * The one object on stdout. Key order on the wire is the order below. Optional
 * fields appear exactly when this run determined them.
 */
export interface SubscriptionProbeEnvelope {
  schema: typeof SUBSCRIPTION_PROBE_SCHEMA;
  /** Present once the argv parsed; absent on a usage error. */
  provider?: "antigravity";
  claudishVersion: string;
  /** The `--model` value, sent unchanged as the envelope's `model`. Present with `provider`. */
  model?: string;
  /** ISO-8601 UTC, once `generateContent` answered. */
  fetchedAt?: string;
  /** `<host>/v1internal:generateContent`, userinfo stripped, once it was attempted. */
  sourceUrl?: string;
  clientVersion?: string;
  clientVersionSource?: AntigravityClientVersionSource;
  tokenRefreshed: boolean;
  /** `generateContent` status, once it answered. */
  httpStatus?: number;
  failure?: SubscriptionProbeFailure;
  /** Present with `body`: whether a credential value was replaced inside it. */
  bodyRedacted?: boolean;
  /**
   * The response text, 2xx or not, as read, apart from redaction. A 2xx body
   * parsed as JSON; a non-2xx body is printed whatever it is.
   */
  body?: string;
}

export const SUBSCRIPTION_PROBE_USAGE =
  "usage: claudish subscription probe antigravity --model <wire-model-id> --request-file <path> --raw --json";
export const PROBE_REQUEST_FILE_MESSAGE =
  "[claudish subscription] the request file must hold one JSON object (the inner Gemini request)";
const SECRET_GUARD_MESSAGE = "[claudish subscription] refused: output contained a credential value";
const INTERNAL_ERROR_MESSAGE = "[claudish subscription] internal error";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SubscriptionProbeDeps extends AntigravitySessionDeps {
  now: () => number;
  /** Bound on `generateContent`: the fetch AND the body read (300 s). */
  requestTimeoutMs: number;
  /** Read the request file. Rejects when it is unreadable; `null` when it is over the cap. */
  readRequestFile: (path: string) => Promise<string | null>;
  /** Write one complete line; resolves once it is flushed. */
  writeStdout: (line: string) => Promise<void>;
  writeStderr: (line: string) => void;
}

async function defaultReadRequestFile(path: string): Promise<string | null> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > PROBE_REQUEST_FILE_CAP_BYTES) return null;
  return readFile(path, "utf8");
}

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
  | { ok: true; provider: "antigravity"; model: string; requestFile: string }
  | { ok: false };

/**
 * Parse the argv that follows `subscription`: exactly `probe antigravity`,
 * `--model <id>`, `--request-file <path>`, `--raw` and `--json`, each once, in
 * any order. A value is the next token and must not start with `-`. Anything
 * else (the `ag` shortcut, `--model=x`, an extra token) is a usage error.
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
    positionals[1] !== "antigravity" ||
    switches.size !== 2 ||
    model === undefined ||
    requestFile === undefined
  ) {
    return { ok: false };
  }
  return { ok: true, provider: "antigravity", model, requestFile };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface Facts {
  provider?: "antigravity";
  model?: string;
  fetchedAt?: string;
  sourceUrl?: string;
  clientVersion?: string;
  clientVersionSource?: AntigravityClientVersionSource;
  tokenRefreshed: boolean;
  httpStatus?: number;
}

function failureOf(
  cls: FailureClass,
  code: ProbeFailureCode,
  httpStatus?: number
): SubscriptionProbeFailure {
  return sessionFailureOf(cls, code, httpStatus);
}

function buildEnvelope(
  facts: Facts,
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
    ...(failure ? { failure } : {}),
    ...(body ? { bodyRedacted: body.redacted, body: body.text } : {}),
  };
}

interface RunResult {
  envelope: SubscriptionProbeEnvelope;
  exitCode: number;
  /** The printed body text, kept for the secret guard. */
  bodyText?: string;
  /** Every decoded form of `bodyText`, complete to a fixed point, for the guard. */
  bodyForms?: string[];
}

function fail(facts: Facts, failure: SubscriptionProbeFailure): RunResult {
  return { envelope: buildEnvelope(facts, failure), exitCode: probeExitCodeFor(failure) };
}

function lineOf(envelope: SubscriptionProbeEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

function safeStderr(deps: SubscriptionProbeDeps, line: string): void {
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
  deps: SubscriptionProbeDeps,
  facts: Facts,
  code: (typeof PROBE_FAILURE_CODES)["internal"][number],
  stderrLine: string,
  secrets?: Secrets
): Promise<number> {
  const failure = failureOf("internal", code);
  safeStderr(deps, `${stderrLine}\n`);
  let line = lineOf(buildEnvelope(facts, failure));
  if (secrets && containsSecret(secrets, line)) {
    // A caller-supplied value (`--model`) can equal a credential. Drop every
    // fact but the fixed ones, so a line is still printed: it then holds only
    // the schema, the version, a boolean and fixed failure strings. It is NOT
    // checked again, on purpose: every byte of it is a constant in the
    // published source, so a "credential" that matches part of it (a project
    // id spelled `internal`) reveals nothing, while suppressing it would break
    // the one-line-on-every-exit contract.
    line = lineOf(buildEnvelope({ tokenRefreshed: facts.tokenRefreshed }, failure));
  }
  try {
    await deps.writeStdout(line);
  } catch {
    // stdout is unusable; the stderr line already says what happened.
  }
  return probeExitCodeFor(failure);
}

/**
 * Replace every secret value in `text`, longest first, also in its `\/`
 * spelling (JSON may escape `/`, and a Google refresh token holds `1//`).
 */
export function redactSecretValues(
  text: string,
  secrets: Secrets
): { text: string; redacted: boolean } {
  let out = text;
  const values = [...secrets.values].sort((a, b) => b.length - a.length);
  for (const value of values) {
    for (const form of new Set([value, value.replaceAll("/", "\\/")])) {
      if (out.includes(form)) out = out.replaceAll(form, REDACTED);
    }
  }
  return { text: out, redacted: out !== text };
}

/** One JSON escape sequence: a backslash-u code unit, or a backslash and one escape letter. */
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
/**
 * The decode budget. A real body needs 1 to 3 rounds. It is a budget, not a
 * depth limit: a body that has not reached a fixed point within it is
 * withheld (`body_unverifiable`), never printed half-checked. Round 4 of the
 * review broke a 16-round CAP with a body nested 17 deep; a cap silently
 * passes what it did not decode, a budget fails closed. 64 rounds over the
 * 512 KiB cap bound the work at about 32 MiB of scanning.
 */
export const MAX_UNESCAPE_ROUNDS = 64;

/**
 * Every form of `text` a chain of JSON parsers could produce: each round
 * decodes every JSON escape sequence ANYWHERE in the text, left to right, and
 * the rounds repeat until nothing changes. The guard checks each form.
 *
 * It ignores string boundaries on purpose. A guard that first finds string
 * literals can be misled: a stray quote in a non-JSON error body pairs the
 * wrong quotes, one `JSON.parse` keeps only the last of two duplicate
 * members, and JSON nested inside a JSON string needs a second decode. Here
 * one round is one level of escaping: a doubly escaped letter (two
 * backslashes, then `u0043`) needs two rounds to become `C`. Over-decoding text that was never inside a string is harmless: these
 * forms are only checked, never printed.
 *
 * Scope: a credential in literal form or under any depth of JSON string
 * escaping. Other transforms (base64, reversal) are outside any text guard.
 *
 * `complete` is true only when a fixed point was reached within
 * `MAX_UNESCAPE_ROUNDS`: then every form a decode chain can produce was
 * returned. When false, the caller must not print the text.
 */
export function jsonUnescapedForms(text: string | undefined): {
  forms: string[];
  complete: boolean;
} {
  const forms: string[] = [];
  if (text === undefined) return { forms, complete: true };
  let current = text;
  for (let round = 0; round < MAX_UNESCAPE_ROUNDS; round++) {
    const next = current.replace(JSON_ESCAPE, (_match, hex: string | undefined, letter: string) =>
      hex !== undefined ? String.fromCharCode(Number.parseInt(hex, 16)) : SIMPLE_ESCAPES[letter]
    );
    if (next === current) return { forms, complete: true };
    forms.push(next);
    current = next;
  }
  return { forms, complete: false };
}

/** The request file, checked: one JSON object. Its text is what gets sent. */
type RequestFileStep =
  | { ok: true; text: string }
  | { ok: false; code: "request_file_unreadable" | "request_file_invalid" };

async function readRequest(deps: SubscriptionProbeDeps, path: string): Promise<RequestFileStep> {
  let text: string | null;
  try {
    text = await deps.readRequestFile(path);
  } catch {
    return { ok: false, code: "request_file_unreadable" };
  }
  if (text === null) return { ok: false, code: "request_file_invalid" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "request_file_invalid" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "request_file_invalid" };
  }
  // Untrimmed: JSON allows whitespace around a value, so the splice stays valid
  // and the caller's bytes reach the wire as written.
  return { ok: true, text };
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

/** Read at most `cap + 1` bytes. `null` means the body is over the cap. */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function determine(
  deps: SubscriptionProbeDeps,
  secrets: Secrets,
  facts: Facts,
  args: { model: string; requestFile: string }
): Promise<RunResult> {
  // The caller's file first: a request that cannot be sent touches no credential.
  const request = await readRequest(deps, args.requestFile);
  if (!request.ok) return fail(facts, failureOf("internal", request.code));

  const session = await establishAntigravitySession(deps, secrets, facts);
  if (!session.ok) return fail(facts, session.failure);

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
    failureOf(
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
        body: buildProbeEnvelopeBody(args.model, session.projectId, session.tierId, request.text),
        signal: controller.signal,
        // A 3xx is the answer. Following it would POST a second generation
        // and report the second response's status instead of the first.
        redirect: "manual",
      });
    } catch {
      return fail(facts, networkFailure());
    }
    facts.fetchedAt = new Date(deps.now()).toISOString();
    facts.httpStatus = res.status;

    let text: string | null;
    try {
      text = await readCapped(res, PROBE_BODY_CAP_BYTES);
    } catch {
      return fail(facts, networkFailure());
    }
    if (text === null)
      return fail(facts, failureOf("list_incomplete", "body_too_large", res.status));

    if (res.ok) {
      try {
        JSON.parse(text);
      } catch {
        return fail(facts, failureOf("list_incomplete", "body_not_json", res.status));
      }
    }
    // A non-2xx answer is not a failure: the vendor's error body is the evidence.
    const body = redactSecretValues(text, secrets);
    const unescaped = jsonUnescapedForms(body.text);
    if (!unescaped.complete) {
      // The guard could not decode it to a fixed point, so it cannot vouch for it.
      return fail(facts, failureOf("list_incomplete", "body_unverifiable", res.status));
    }
    return {
      envelope: buildEnvelope(facts, undefined, body),
      exitCode: PROBE_EXIT.ok,
      bodyText: body.text,
      bodyForms: unescaped.forms,
    };
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
  const facts: Facts = { provider: "antigravity", model: args.model, tokenRefreshed: false };
  let result: RunResult;
  try {
    result = await determine(deps, secrets, facts, args);
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
    safeStderr(deps, `${PROBE_REQUEST_FILE_MESSAGE}\n`);
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
  return runAntigravityProbe(deps, args);
}
