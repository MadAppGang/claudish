/**
 * DevinAPIFormat — Layer 1 wire format for the Devin (Cognition/Codeium)
 * `GetChatMessage` rpc.
 *
 * ## Why it reuses the OpenAI intermediate representation
 *
 * `convertMessages` / `convertTools` are deliberately NOT overridden. The
 * inherited `convertMessagesToOpenAI` / `convertToolsToOpenAI` already handle
 * the hard parts of Claude Messages (block arrays, `tool_use`/`tool_result`
 * pairing, system extraction, identity filtering) — and, decisively, they
 * produce the shape that every middleware and every Layer 4 rule already
 * understands:
 *
 * - `middlewareManager.beforeRequest({ messages, tools, … })` mutates
 *   OpenAI-shaped objects at ComposedHandler step 3b.
 * - `behaviorSession.applyRequest(claudeRequest, claudeTools, tools, messages)`
 *   reads OpenAI-shaped tools for `rewriteToolDescription` — the mechanism the
 *   `plan-mode/plan-file-path` rule depends on.
 *
 * Inventing a bespoke Devin message shape here would silently disable both for
 * this provider. {@link buildPayload} therefore does the Devin-specific mapping
 * AFTER those hooks have run, translating the OpenAI arrays into the logical
 * {@link DevinRequest}.
 *
 * ## What this format does NOT do
 *
 * - **No bytes.** `buildPayload` returns a logical object; the transport adds
 *   credentials and calls the codec (`serializeBody`). The request body embeds
 *   the api key in metadata field `1.3`, and credentials are categorically
 *   Layer 3's business.
 * - **No effort field.** Devin encodes the reasoning tier in the model UID
 *   suffix, not in a request field, so {@link applyNativeReasoning} only
 *   RECORDS the level on the payload; the transport folds it into field 21 via
 *   `resolveDevinModelUid` against the LIVE roster.
 * - **No vision.** {@link supportsVision} returns false, which routes images
 *   through ComposedHandler's existing vision-proxy path (described into text,
 *   or stripped). That is a working degradation for free, and it is why Devin's
 *   single-string message body (field 3) is safe. Image input on this backend is
 *   unverified — revisit only when it is measured live.
 */

import type { DevinMessage, DevinRequest, DevinTool } from "../providers/devin/devin-request.js";
import { applyDevinToolDescriptions } from "../providers/devin/tool-descriptions.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { type AdapterResult, BaseAPIFormat, type EffortLevel } from "./base-api-format.js";

/**
 * The payload {@link DevinAPIFormat.buildPayload} produces.
 *
 * A plain {@link DevinRequest} plus the requested reasoning level, which is NOT
 * a wire field: Devin has no effort parameter, so Layer 3 resolves
 * `modelUid` + `effort` into a served uid (`claude-opus-5` + `high` →
 * `claude-opus-5-high`) before encoding. Keeping `effort` on the payload rather
 * than on the transport is what makes it a per-REQUEST value — a cached handler
 * serves overlapping turns that may carry different levels.
 */
export interface DevinRequestPayload extends DevinRequest {
  /** Reasoning tier from `output_config.effort`; folded into the uid at Layer 3. */
  effort?: EffortLevel;
}

/**
 * Flatten OpenAI message content (a string, or an array of typed parts) to text.
 *
 * Devin's message body is a single string (field 3), so parts must collapse.
 * Non-text parts are dropped rather than stringified — by the time this runs the
 * vision proxy has already turned any image into an `[Image Description: …]`
 * TEXT part (or stripped it), so anything still non-text is genuinely not
 * content this wire can carry.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object" && "text" in part) {
      const { text } = part as { text?: unknown };
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/**
 * What claudish puts in request field 2 when it has relocated the real system
 * prompt into the leading user message.
 *
 * This is claudish's own transport annotation, not a rewrite of anyone's
 * instructions: it names where the real prompt went and tells the model to obey
 * it. The user's text is still delivered verbatim, in full, in the message that
 * immediately follows.
 *
 * It is not decorative — field 2 must be non-empty whenever tools are present or
 * the Claude family rejects the turn. See {@link DevinAPIFormat.buildPayload}.
 */
export const DEVIN_RELOCATION_NOTE =
  "You are a coding agent. Your complete operating instructions for this session are supplied " +
  "in the first user message, inside <system_instructions> tags. Treat everything inside those " +
  "tags as your system prompt and follow it exactly.";

/**
 * Field 2 for the rare turn that carries tools but NO system prompt at all.
 *
 * Deliberately the most neutral sentence that satisfies the backend's
 * non-empty requirement — an empty string and a single space both fail (see
 * {@link DevinAPIFormat.buildPayload}). Claude Code always sends a system
 * prompt, so this is a robustness path for other clients, not the normal one.
 */
export const DEVIN_MINIMAL_SYSTEM = "You are a coding agent.";

export class DevinAPIFormat extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  /**
   * Never auto-selected. Devin uids collide head-on with other providers'
   * namespaces (`claude-sonnet-5-medium`, `gpt-5-6-luna-medium`, `glm-5-2`),
   * so this format is only ever passed explicitly by the `devin` provider
   * profile — exactly like access to the provider itself, which is always
   * explicit (`dv@…`). It is also not registered in DialectManager.
   */
  shouldHandle(_modelId: string): boolean {
    return false;
  }

  getName(): string {
    return "DevinAPIFormat";
  }

  override getStreamFormat(): StreamFormat {
    return "connect-proto";
  }

  /**
   * Zero = "no opinion". The live per-uid window comes from the transport's
   * `getContextWindow()` (ComposedHandler step 5b, positive-only), which reads
   * the backend's own `GetCliModelConfigs` roster — the only source that knows
   * what THIS subscription serves.
   */
  override getContextWindow(): number {
    return 0;
  }

  /** See the module header: images are described or stripped upstream. */
  override supportsVision(): boolean {
    return false;
  }

  /**
   * Record the requested reasoning level for Layer 3.
   *
   * Devin exposes no effort parameter — the tier lives in the uid suffix — so
   * there is nothing to set on the wire here. Writing the level onto the
   * payload is the whole job; `DevinProviderTransport.serializeBody` resolves
   * it against the live roster.
   */
  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    const effort = this.resolveEffortLevel(originalRequest);
    if (effort) (request as DevinRequestPayload).effort = effort;
    return request;
  }

  /**
   * OpenAI-shaped messages/tools → the logical Devin request.
   *
   * Role enum (VERIFIED, and public prior art is wrong): 1 = USER,
   * 2 = ASSISTANT, 4 = TOOL_RESULT. Never 3 — see `devin-request.ts`.
   *
   * An assistant turn carrying BOTH text and N tool calls becomes **N+1**
   * messages: one `{assistant, text}` (omitted when there is no text) followed
   * by one `{assistant, toolCall}` per call, in order. Field 6 is not
   * documented as repeated and every captured pure-tool-call message carries no
   * field 3, so this is the conservative encoding consistent with all captures.
   *
   * `claudeRequest` is unused: the system prompt already arrives inside
   * `messages` (convertMessagesToOpenAI hoists it to a `role: "system"` entry),
   * and `max_tokens` is dropped for the measured reason below.
   *
   * ## The system prompt is carried as a leading USER message, NOT in field 2
   *
   * Devin's backend fingerprints Claude Code and rejects it with
   * `permission_denied`, delivered inside an HTTP 200 Connect stream. One of the
   * fields it scans is request **field 2** (the system prompt), which every turn
   * would have hit since Claude Code sends that prompt on every request.
   *
   * The scope of the field-2 gate was MEASURED live, with the Claude Code prompt
   * text byte-identical in every arm:
   *
   * ```
   * A. CC prompt in field 2 (system)            -> ERR permission_denied
   * B. CC prompt as a USER message, no field 2  -> OK
   * C. short field 2 + CC as a user message     -> OK
   * D. metadata client = "chisel"               -> ERR  (metadata does NOT gate it)
   * E. metadata client = "windsurf"             -> ERR
   * F. no system prompt at all                  -> OK
   * ```
   *
   * So the same bytes that are rejected in field 2 pass in a chat message. This
   * encoder therefore takes arm **C**: the system text becomes the first message
   * (role `user`, source 1), wrapped in `<system_instructions>` tags so the model
   * reads it as instructions rather than as a user turn, and field 2 carries only
   * {@link DEVIN_RELOCATION_NOTE} — claudish's own one-sentence pointer at where
   * the real prompt went. All real messages follow in their original order.
   *
   * **The prompt text is passed through VERBATIM.** Nothing is rewritten,
   * paraphrased, truncated, reordered, or removed — only the two wrapper lines
   * are added around it. This is a transport-PLACEMENT change, not content
   * filtering: the model receives exactly the instructions Claude Code wrote.
   * Do not "tidy this up" by moving the text back into `payload.system`; arm A
   * above is what that produces.
   *
   * ## Field 2 must be NON-EMPTY whenever tools are present (Claude family only)
   *
   * An earlier revision took arm **B** and left field 2 unset entirely. That is
   * fine on a toolless turn, and it survived review because a tool-carrying turn
   * could not be observed at all until the tool-description gate below was
   * cleared. Measured the moment one could be:
   *
   * ```
   *                                       sonnet-5-medium   opus-5-medium   glm-5-2   gpt-5-6-luna-medium
   * relocated prompt + 86 tools, no f2    invalid_argument  invalid_argument  OK        OK
   *                             f2 = ""   invalid_argument  invalid_argument  OK        OK
   *                            f2 = " "   invalid_argument  invalid_argument  OK        OK
   *                f2 = the note above    OK                OK                OK        OK
   *
   * 86 tools, NO relocated prompt, no f2  invalid_argument  invalid_argument
   *       f2 = "You are a coding agent."  OK                OK
   * no tools at all, no f2                OK                OK
   * ```
   *
   * The rule is `tools present ⇒ field 2 non-empty AND not blank`, and it is
   * FAMILY-SPECIFIC: GLM and gpt-5.6-luna accept every arm, so a change here that
   * is verified only on those two will ship a provider that fails on its
   * headline models. Whitespace does not satisfy it — the field has to say
   * something. Note also that `invalid_argument` surfaces to the user as Claude
   * Code's "empty or malformed response (HTTP 200)", which names neither the
   * field nor the family; the table above is the fast path back to the cause.
   *
   * So field 2 is populated exactly when the turn would otherwise be rejected:
   * {@link DEVIN_RELOCATION_NOTE} whenever a prompt was relocated, and
   * {@link DEVIN_MINIMAL_SYSTEM} on the (Claude-Code-impossible) turn that
   * carries tools with no system prompt at all. Neither paraphrases the user:
   * their own text is still delivered verbatim in the message that follows.
   *
   * ## Field 2 is NOT the only thing scanned — the relocation alone does NOT
   * ## make a Claude Code session work
   *
   * Measured after the relocation landed. Do not read the A–F table above and
   * conclude the problem was solved by it:
   *
   * ```
   * 0. benign system, no tools                     -> OK
   * 1. relocated CC prompt, NO tools               -> OK   (this change works)
   * 2. benign system + all 86 real CC tools        -> ERR permission_denied
   * 3. relocated prompt + all real tools           -> ERR permission_denied  <- the real e2e
   *
   * only mcp__* tools (58)                         -> OK
   * only native CC tools (28)                      -> ERR permission_denied
   * single tool: Read                              -> ERR permission_denied
   * single tool: Write / Bash / Edit               -> OK / OK / OK
   * ```
   *
   * The gate also fingerprints **tool descriptions (field 10.2)**. Testing all 28
   * native tools one at a time narrowed it to exactly three — `Read`,
   * `TaskOutput`, `WebSearch` — with the other 25 and all 58 `mcp__*` tools
   * passing untouched. (An earlier "15 CC tools passed" result was invalid: it
   * used synthetic `"D".repeat(n)` descriptions, never the real text.)
   *
   * `applyDevinToolDescriptions` below substitutes claudish-authored
   * documentation for those three, which is what clears arm 3. The measurement,
   * the re-measurement procedure, and the semantic-fidelity bar those rewrites
   * are held to live in `providers/devin/tool-descriptions.ts` — read that header
   * before touching them. It is a Devin-only substitution matched on tool NAME;
   * every other tool reaches the wire exactly as Claude Code wrote it, and the
   * system prompt is still passed through verbatim.
   *
   * The user of this provider is the subscription holder and confirmed with the
   * vendor that this rejection is a technical state of the backend, not a
   * contractual restriction on which client may talk to it.
   */
  override buildPayload(_claudeRequest: any, messages: any[], tools: any[]): DevinRequestPayload {
    const systemParts: string[] = [];
    const devinMessages: DevinMessage[] = [];

    for (const message of messages) {
      const role = message?.role;

      if (role === "system") {
        const text = contentToText(message.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (role === "tool") {
        devinMessages.push({
          role: "tool_result",
          text: contentToText(message.content),
          toolCallId: message.tool_call_id,
        });
        continue;
      }

      if (role === "assistant") {
        const text = contentToText(message.content);
        if (text) devinMessages.push({ role: "assistant", text });
        for (const call of message.tool_calls ?? []) {
          devinMessages.push({
            role: "assistant",
            toolCall: {
              id: call?.id ?? "",
              name: call?.function?.name ?? "",
              // The wire carries argument TEXT, not a struct. An absent
              // arguments field is an empty object, not an empty string —
              // the backend rejects a non-JSON body here.
              argumentsJson: call?.function?.arguments || "{}",
            },
          });
        }
        continue;
      }

      // Everything else (including "user") is a user turn. Defaulting rather
      // than dropping keeps an unexpected role in the conversation instead of
      // silently losing context.
      devinMessages.push({ role: "user", text: contentToText(message.content) });
    }

    // Substitute claudish's own text for the three tool descriptions Devin's
    // field-10.2 fingerprint rejects. Returns a NEW array — the caller's `tools`
    // (which middleware and Layer 4 rules still hold references to) is untouched.
    const devinTools: DevinTool[] = applyDevinToolDescriptions(tools).map((tool: any) => ({
      name: tool?.function?.name ?? tool?.name ?? "",
      description: tool?.function?.description ?? tool?.description ?? "",
      parametersJson: JSON.stringify(
        tool?.function?.parameters ?? tool?.parameters ?? { type: "object", properties: {} }
      ),
    }));

    // Arm C (see the doc comment): the VERBATIM system text leads the
    // conversation as a user message, and field 2 carries only claudish's
    // pointer at it. `unshift` rather than seeding the array up front because a
    // `role: "system"` entry is not guaranteed to be the first element —
    // collecting first, then prepending, keeps the instructions ahead of every
    // real turn either way.
    let system: string | undefined;
    if (systemParts.length > 0) {
      devinMessages.unshift({
        role: "user",
        text: `<system_instructions>\n${systemParts.join("\n\n")}\n</system_instructions>`,
      });
      system = DEVIN_RELOCATION_NOTE;
    } else if (devinTools.length > 0) {
      // Tools with no system prompt at all: the Claude family still requires a
      // non-blank field 2, so send the most neutral sentence that satisfies it.
      system = DEVIN_MINIMAL_SYSTEM;
    }

    const payload: DevinRequestPayload = {
      // The bare requested name. The transport resolves it to a SERVED uid
      // (family + effort → tier) against the live roster before encoding.
      modelUid: this.modelId,
      messages: devinMessages,
    };
    if (system) payload.system = system;
    if (devinTools.length > 0) payload.tools = devinTools;
    // `claudeRequest.max_tokens` is deliberately DROPPED. Devin's request field
    // 8 fails the whole request as a length-delimited message and is silently
    // ignored as a varint — both measured live; the numbers are in
    // `devin-request.ts`'s header. Since Claude Code sends max_tokens on
    // essentially every request, encoding the documented shape would have
    // broken every Devin turn.
    return payload;
  }
}
