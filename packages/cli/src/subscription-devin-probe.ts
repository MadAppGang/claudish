/**
 * `claudish subscription probe devin --model <uid> --request-file <path> --raw --json`
 *
 * Sends ONE `GetChatMessage` through the user's Devin login and prints the
 * answer inside the `claudish.subscription-probe.v1` envelope on ONE stdout
 * line. The request file is an Anthropic Messages body; it goes through the
 * same Layer 1 `dv@` uses (`DevinAPIFormat`, driven as `ComposedHandler`
 * drives it), and the uid sent in field 21 is the `--model` value verbatim:
 * no `resolveDevinModelUid`, which would expand a tier-less uid with the
 * request's effort. On Devin the reasoning tier lives only in the uid.
 *
 * The answer is decoded, not printed as protobuf: the stream parser `dv@`
 * uses turns the Connect frames into Claude SSE, and `collectSseMessage`
 * folds that into one Messages object. Base64 protobuf would carry a
 * credential past a text guard; decoded JSON cannot.
 *
 * Contract: ai-docs/architecture/providers/devin.md, "Wire probe for
 * models-index". The envelope, the run wrapper, the exit codes and the guard
 * are the Antigravity probe's (`subscription-probe-command.ts`).
 */

import type { Context } from "hono";
import { DevinAPIFormat, type DevinRequestPayload } from "./adapters/devin-api-format.js";
import { devinAuthHeaders } from "./auth/credentials/devin-credential.js";
import { collectSseMessage } from "./handlers/shared/collect-sse-message.js";
import {
  classifyDevinStreamError,
  sniffDevinStreamHead,
} from "./handlers/shared/devin-stream-head-sniffer.js";
import { filterIdentity } from "./handlers/shared/openai-compat.js";
import { createDevinConnectStream } from "./handlers/shared/stream-parsers/devin-connect.js";
import { readDevinServerUrl } from "./providers/devin/devin-credentials.js";
import { DEVIN_CLI_VERSION, encodeDevinRequest } from "./providers/devin/devin-request.js";
import { CHAT_PATH } from "./providers/transport/devin.js";
import { type Secrets, newSecrets, stripUserinfo } from "./subscription-antigravity-session.js";
import { readDevinSecrets } from "./subscription-devin-models.js";
import {
  type ProbeFacts,
  type ProbeRunResult,
  type SubscriptionProbeDeps,
  probeBodyResult,
  probeFail,
  probeFailureOf,
  runProbeWith,
} from "./subscription-probe-command.js";
import {
  PROBE_BODY_CAP_BYTES,
  readCapped,
  readRequestFileChecked,
} from "./subscription-secret-guard.js";

/** The fixed stderr line for a request file that cannot be sent. */
export const DEVIN_PROBE_REQUEST_FILE_MESSAGE =
  "[claudish subscription] the request file must hold one JSON object (an Anthropic Messages request)";

/** Connect streaming content type, as the `dv@` transport sends it. */
const CHAT_CONTENT_TYPE = "application/connect+proto";

/** What the Devin probe uses from the shared probe deps. */
export type DevinProbeDeps = Pick<
  SubscriptionProbeDeps,
  "now" | "requestTimeoutMs" | "readRequestFile" | "writeStdout" | "writeStderr"
>;

/**
 * Layer 1 exactly as `ComposedHandler` drives it for `dv@`: convert the
 * messages and tools, build the payload, post-process it. Then pin the uid to
 * `model` and drop `effort`, so the tier comes from the uid alone.
 */
export function buildDevinProbePayload(
  model: string,
  claudeRequest: Record<string, unknown>
): { payload: DevinRequestPayload; toolNameMap: Map<string, string> } {
  const adapter = new DevinAPIFormat(model);
  adapter.setResponseWireFormat("connect-proto");
  adapter.reset();
  const messages = adapter.convertMessages(claudeRequest, filterIdentity);
  const tools = adapter.convertTools(claudeRequest);
  const payload = adapter.buildPayload(claudeRequest, messages, tools);
  adapter.prepareRequest(payload, claudeRequest);
  payload.modelUid = model;
  delete payload.effort;
  return { payload, toolNameMap: adapter.getToolNameMap() };
}

/**
 * A 2xx `GetChatMessage` answer as body text, recording `streamError` and
 * `servedModel` in `facts`. Errors ride an HTTP 200, so the head is sniffed
 * first: an error frame there is the answer, `{"error":{"code","message"}}`.
 * A clean stream goes through the `dv@` parser into one Messages object; an
 * error frame mid-stream sets `streamError` too. `null` when the stream
 * failed with no error frame: it could not be read.
 */
async function decodeDevinAnswer(
  res: Response,
  facts: ProbeFacts,
  model: string,
  toolNameMap: Map<string, string>
): Promise<string | null> {
  const head = await sniffDevinStreamHead(res);
  if (head.kind !== "clean") {
    facts.streamError = { code: head.code, retryable: head.kind === "retryable" };
    return JSON.stringify({ error: { code: head.code, message: head.message } });
  }
  let apiError: { code: string; message: string } | undefined;
  // The field-28 counters, reported once at the end of the stream (an absent
  // value is 0). `message_start` carries an estimate instead, which the
  // collector would keep whenever the input count is 0.
  let measured: { input_tokens: number; output_tokens: number } | undefined;
  // A body that ends without the end-of-stream frame is a truncated turn,
  // which the parser still closes as complete.
  let endOfStream = false;
  // The parser's Context argument is unused.
  const sse = createDevinConnectStream({} as Context, head.response, {
    modelName: model,
    toolNameMap,
    onTokenUpdate: (input, output) => {
      measured = { input_tokens: input, output_tokens: output };
    },
    onServedModel: (uid) => {
      facts.servedModel = uid;
    },
    onApiError: (code, message) => {
      apiError ??= { code, message };
    },
    onEndOfStream: () => {
      endOfStream = true;
    },
  });
  const collected = await collectSseMessage(sse, model);
  if (apiError) {
    facts.streamError = {
      code: apiError.code,
      retryable: classifyDevinStreamError(apiError.code, apiError.message) === "retryable",
    };
  } else if (collected.streamError || !endOfStream) {
    return null;
  }
  const { streamError: _internal, ...message } = collected;
  if (measured) message.usage = measured;
  return JSON.stringify(message);
}

async function determineDevin(
  deps: DevinProbeDeps,
  secrets: Secrets,
  facts: ProbeFacts,
  args: { model: string; requestFile: string }
): Promise<ProbeRunResult> {
  // The caller's file first: a request that cannot be sent touches no credential.
  const request = await readRequestFileChecked(deps.readRequestFile, args.requestFile);
  if (!request.ok) return probeFail(facts, probeFailureOf("internal", request.code));

  const apiKey = readDevinSecrets(secrets);
  if (!apiKey) {
    return probeFail(facts, probeFailureOf("credential_missing", "devin_credential_absent"));
  }

  const { payload, toolNameMap } = buildDevinProbePayload(args.model, request.value);
  const body = encodeDevinRequest(payload, { apiKey });
  const url = `${readDevinServerUrl()}${CHAT_PATH}`;
  facts.sourceUrl = stripUserinfo(url);
  facts.clientVersion = DEVIN_CLI_VERSION;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.requestTimeoutMs);
  const networkFailure = () =>
    probeFailureOf(
      "network",
      controller.signal.aborted ? "get_chat_message_timeout" : "get_chat_message_network_error",
      facts.httpStatus
    );
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...devinAuthHeaders(apiKey), "content-type": CHAT_CONTENT_TYPE },
        body,
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

    if (!res.ok) {
      // Not a failure: the vendor's error body is the evidence.
      let text: string | null;
      try {
        text = await readCapped(res, PROBE_BODY_CAP_BYTES);
      } catch {
        return probeFail(facts, networkFailure());
      }
      if (text === null) {
        return probeFail(facts, probeFailureOf("list_incomplete", "body_too_large", res.status));
      }
      return probeBodyResult(facts, text, secrets, res.status);
    }

    const text = await decodeDevinAnswer(res, facts, args.model, toolNameMap);
    if (text === null) return probeFail(facts, networkFailure());
    if (Buffer.byteLength(text, "utf8") > PROBE_BODY_CAP_BYTES) {
      return probeFail(facts, probeFailureOf("list_incomplete", "body_too_large", res.status));
    }
    return probeBodyResult(facts, text, secrets, res.status);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Determine the envelope, run the secret guard, write ONE flushed line, and
 * return the exit code. Never throws.
 */
export async function runDevinProbe(
  deps: DevinProbeDeps,
  args: { model: string; requestFile: string }
): Promise<number> {
  const secrets = newSecrets();
  const facts: ProbeFacts = { provider: "devin", model: args.model, tokenRefreshed: false };
  return runProbeWith(deps, facts, secrets, DEVIN_PROBE_REQUEST_FILE_MESSAGE, () =>
    determineDevin(deps, secrets, facts, args)
  );
}
