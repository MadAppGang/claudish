/**
 * The Devin `GetChatMessage` request — logical object → enveloped wire bytes.
 *
 * Layer 1 (`DevinAPIFormat.buildPayload`) produces the {@link DevinRequest}
 * object; the transport adds credentials and calls {@link encodeDevinRequest}.
 * The split exists because the request body embeds the API key in metadata
 * field `1.3`, and credentials are categorically Layer 3's business.
 *
 * ## Request fields (VERIFIED against live traffic — do not change)
 *
 * | # | meaning |
 * |---|---|
 * | 1 | metadata (client identity + api key) |
 * | 2 | system prompt |
 * | 3 | chat message, REPEATED |
 * | 7 | model enum, varint — must be PRESENT; need not agree with field 21 |
 * | 10 | tool, REPEATED |
 * | 21 | model uid string — **this is what routes** |
 *
 * ## Field 8 is NOT SENT — measured, not assumed
 *
 * The design doc listed `8` as a completion config carrying `{2: max_tokens}`.
 * That shape was decoded from an internal struct and never put on the wire. Sent
 * live, it FAILS EVERY REQUEST:
 *
 * ```
 * no field 8              -> 200, "The capital of Australia is Canberra."
 * 8 = {2: 256}   (wire 2) -> invalid_argument
 * 8 = {1: 256}   (wire 2) -> invalid_argument
 * 8 = {}         (wire 2) -> invalid_argument      <- even EMPTY
 * 8 = "256"      (wire 2) -> invalid_argument
 * 8 = 256        (wire 0) -> 200
 * 9 / 11 = {2:256}        -> 200                   <- so it is field-8 type
 *                                                     validation, not a generic
 *                                                     unknown-field rejection
 * ```
 *
 * Claude Code sends `max_tokens` on essentially every request, so the
 * length-delimited form would have broken 100% of Devin turns.
 *
 * The varint form is accepted — and does NOTHING. Measured on two families with
 * a prompt whose natural answer is ~330-455 output tokens:
 *
 * ```
 * claude-sonnet-5-medium  no field 8 -> 326 out tokens, complete answer
 *                         8 = 16     -> 328 out tokens, complete answer
 *                         8 = 4096   -> 326 out tokens, complete answer
 * glm-5-2                 no field 8 -> 455 out tokens, complete answer
 *                         8 = 16     -> 430 out tokens, complete answer
 * ```
 *
 * A budget of 16 producing a complete 330-token answer means the field is
 * ignored. Emitting it would be the "believes it set the limit and did nothing"
 * failure this codebase calls out elsewhere — worse than useless here, because a
 * user who sets a small `max_tokens` would be billed for a long answer while the
 * request claims to have capped it. So `max_tokens` is DROPPED, deliberately and
 * visibly, rather than encoded into a field that cannot honour it. Revisit only
 * with a capture showing field 8 actually truncating a turn.
 *
 * ## Role enum (VERIFIED — public prior art is WRONG)
 *
 * `1 = USER`, `2 = ASSISTANT`, `4 = TOOL_RESULT`. Never 3.
 * `opencode-windsurf-auth` documents `3 = ASSISTANT` for Windsurf's
 * `LanguageServerService`; on Devin's `ApiServerService` a 3 produces
 * FAMILY-SPECIFIC failures that look transient and are not — `permission_denied`
 * on Claude, "third-party model provider is experiencing issues" on GLM, while
 * `gpt-5.6-luna` silently tolerates it. That asymmetry is why this is pinned by
 * a test rather than trusted to review.
 *
 * ## Secret hygiene (mandatory)
 *
 * The api key rides in metadata field `1.3`. `--debug` must NEVER dump these
 * bytes; log through {@link describeDevinRequestForLog}, which by construction
 * never encodes the metadata at all.
 */

import { randomUUID } from "node:crypto";
import { bytes, envelope, msg, vint } from "./proto-codec.js";

/**
 * The devin-cli version claudish presents as. A protocol constant (it also
 * gates the unary metadata rpcs — see `devin-models.ts`), not model data.
 */
export const DEVIN_CLI_VERSION = "3000.3.27";

/**
 * Field 7 is a required-but-ignored model enum, NOT a model identifier: field
 * 21 (the uid string) is what routes. Verified by sending
 * `claude-sonnet-5-medium` in 21 while leaving 7 at GLM's enum — Claude
 * answered. If the backend ever starts cross-checking the two, this constant is
 * the first suspect.
 */
export const DEFAULT_MODEL_ENUM = 5;

/** Chat-message `source` enum. VERIFIED; see the module header. */
export const DEVIN_ROLE = {
  user: 1,
  assistant: 2,
  tool_result: 4,
} as const;

export type DevinRole = keyof typeof DEVIN_ROLE;

/** An assistant tool call (message field 6). */
export interface DevinToolCall {
  /** Call id, echoed by the matching tool result's field 7. */
  id: string;
  name: string;
  /** Arguments as a JSON string — the wire carries text, not a struct. */
  argumentsJson: string;
}

/**
 * One chat message (request field 3, repeated).
 *
 * A PURE tool call carries `toolCall` and no `text` — that is the shape every
 * capture shows. An assistant turn that has both text and tool calls is split
 * by the converter into N+1 messages (one text, then one per call); this
 * encoder stays faithful to whatever it is handed and never silently drops
 * either half.
 */
export interface DevinMessage {
  role: DevinRole;
  /** Message uuid (field 1). Generated when absent. */
  id?: string;
  /** Text body (field 3). Omitted from the wire when empty. */
  text?: string;
  /** Assistant tool call (field 6). */
  toolCall?: DevinToolCall;
  /** For `tool_result`: the id of the call being answered (field 7). */
  toolCallId?: string;
}

/** A tool advertised to the model (request field 10, repeated). */
export interface DevinTool {
  name: string;
  description?: string;
  /** JSON Schema for the parameters, already stringified. */
  parametersJson: string;
}

/** The logical request — everything except credentials. */
export interface DevinRequest {
  /** Field 21 — the AUTHORITATIVE routing key. */
  modelUid: string;
  /** Field 7 — defaults to {@link DEFAULT_MODEL_ENUM}. */
  modelEnum?: number;
  /** Field 2. */
  system?: string;
  /** Field 3, repeated. */
  messages: DevinMessage[];
  /** Field 10, repeated. */
  tools?: DevinTool[];
  // NO maxTokens. Field 8 breaks the request as a message and is ignored as a
  // varint — both measured live; see the module header. A property here that
  // never reaches the wire would be a lie the next reader has to re-discover.
}

/** Client identity for metadata (field 1). The api key lives here. */
export interface DevinMetadata {
  apiKey: string;
  /** Defaults to {@link DEVIN_CLI_VERSION}. */
  clientVersion?: string;
  /** Defaults to `process.platform` (the capture was `"darwin"`). */
  platform?: string;
}

/**
 * Encode metadata (field 1's body) for `GetChatMessage`.
 *
 * The unary metadata rpcs use a DIFFERENT shape (field 1 is `"chisel"`, not
 * `"devin-cli"`) — `devin-models.ts` builds its own on purpose. Do not share
 * one builder between them.
 */
function encodeChatMetadata(meta: DevinMetadata): Uint8Array {
  const version = meta.clientVersion ?? DEVIN_CLI_VERSION;
  return msg(
    bytes(1, "devin-cli"),
    bytes(2, version),
    bytes(3, meta.apiKey),
    bytes(4, "en"),
    bytes(5, meta.platform ?? process.platform),
    bytes(7, version),
    bytes(12, "chisel"),
    bytes(28, "chisel")
  );
}

/** Encode one chat message (the body of a field-3 entry). */
function encodeMessage(message: DevinMessage): Uint8Array {
  const parts: Uint8Array[] = [
    bytes(1, message.id ?? randomUUID()),
    vint(2, DEVIN_ROLE[message.role]),
  ];
  if (message.text) parts.push(bytes(3, message.text));
  if (message.toolCall) {
    parts.push(
      bytes(
        6,
        msg(
          bytes(1, message.toolCall.id),
          bytes(2, message.toolCall.name),
          bytes(3, message.toolCall.argumentsJson)
        )
      )
    );
  }
  if (message.toolCallId) parts.push(bytes(7, message.toolCallId));
  return msg(...parts);
}

/** Encode one tool (the body of a field-10 entry). */
function encodeTool(tool: DevinTool): Uint8Array {
  return msg(bytes(1, tool.name), bytes(2, tool.description ?? ""), bytes(3, tool.parametersJson));
}

/**
 * Every request field EXCEPT metadata.
 *
 * Split out so {@link describeDevinRequestForLog} can size the payload without
 * ever encoding the api key — the hygiene rule is enforced by construction, not
 * by remembering to redact.
 */
function encodeRequestBodyParts(req: DevinRequest): Uint8Array[] {
  const parts: Uint8Array[] = [];
  if (req.system) parts.push(bytes(2, req.system));
  for (const message of req.messages) parts.push(bytes(3, encodeMessage(message)));
  parts.push(vint(7, req.modelEnum ?? DEFAULT_MODEL_ENUM));
  // Field 8 is deliberately absent — see the module header for the measurement.
  for (const tool of req.tools ?? []) parts.push(bytes(10, encodeTool(tool)));
  parts.push(bytes(21, req.modelUid));
  return parts;
}

/**
 * Encode a request to ENVELOPED bytes, ready to be the fetch body.
 *
 * `GetChatMessage` is the streaming rpc, so the message ships inside a Connect
 * envelope (`[flags][len][payload]`) with `content-type:
 * application/connect+proto`.
 */
export function encodeDevinRequest(
  req: DevinRequest,
  meta: DevinMetadata
): Uint8Array<ArrayBuffer> {
  const body = msg(bytes(1, encodeChatMetadata(meta)), ...encodeRequestBodyParts(req));
  return envelope(body);
}

/**
 * A one-line, CREDENTIAL-FREE description of a request, for `--debug`.
 *
 * The reported size is the request body EXCLUDING metadata, because metadata is
 * where the api key lives and this function must never touch it. It is the
 * right number for the question the log answers anyway ("how big did the
 * conversation get"), since metadata is a fixed overhead.
 */
export function describeDevinRequestForLog(req: DevinRequest): string {
  const roles = { user: 0, assistant: 0, tool_result: 0 };
  let toolCalls = 0;
  for (const message of req.messages) {
    roles[message.role]++;
    if (message.toolCall) toolCalls++;
  }
  const size = encodeRequestBodyParts(req).reduce((total, part) => total + part.length, 0);

  const fields = [
    `uid=${req.modelUid}`,
    `enum=${req.modelEnum ?? DEFAULT_MODEL_ENUM}`,
    `messages=${req.messages.length}`,
    `(user ${roles.user}/assistant ${roles.assistant}/tool_result ${roles.tool_result}`,
    `calls ${toolCalls})`,
    `tools=${req.tools?.length ?? 0}`,
    `system=${req.system?.length ?? 0}ch`,
  ];
  fields.push(`body=${size}B (excl. metadata)`);
  return fields.join(" ");
}
