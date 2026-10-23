/**
 * Thinking-block signature hygiene for the native Anthropic path.
 *
 * A `thinking` block carries a cryptographic `signature` that Anthropic issued
 * and later verifies. Send one back with a signature Anthropic did not produce
 * and the whole request dies:
 *
 *   400 messages.19.content.0: Invalid signature in thinking block
 *
 * Claudish manufactures exactly that situation. Reasoning from non-Anthropic
 * providers (GLM, Kimi, DeepSeek, MiniMax, …) is surfaced to the client as
 * Anthropic-shaped `{ type: "thinking" }` blocks so Claude Code can render it —
 * but `openai-sse` has no signature to give them, so the client stores
 * `signature: ""`. While a session stays on a foreign provider that is
 * harmless: at EMIT our own filter drops thinking under every policy except
 * `forced` and `effort` (`shouldFilterThinking()` = `kind !== "forced" &&
 * kind !== "effort"`), so the unsigned blocks are mostly not even echoed back.
 * The blocks
 * only become poison when a LATER turn in the same session routes to a real
 * Anthropic model, because `NativeHandler` forwards the conversation verbatim —
 * which is the entire point of a native passthrough. One mixed-provider session
 * is enough to wedge every subsequent native turn until the user compacts.
 *
 * This helper removes thinking blocks whose signature is missing, null or
 * empty — plus, when the caller opts in on the native wire, blocks carrying a
 * foreign 64-hex digest (#597). Genuine Anthropic thinking blocks carry a real
 * base64 signature and are preserved — they are required for
 * interleaved-thinking / tool-use continuity. Other block types (text, tool_use,
 * tool_result, redacted_thinking, …) are untouched.
 *
 * ─── Why absent-signature is the whole problem, not part of it ──────────────
 *
 * The obvious worry is that this only catches an EMPTY signature, while an
 * Anthropic-compatible provider could send a real-looking one that Anthropic
 * still will not accept. MiniMax does exactly that — a 64-hex digest, visible
 * as `7caa0d3cc2a449ac…` in `minimax-m25-turn1-thinking-text-tool.sse`.
 *
 * That foreign signature CAN reach the client, and the fork's pins say so:
 * thinking is not stripped unconditionally at emit — `shouldFilterThinking()`
 * filters by policy kind (`kind !== "forced" && kind !== "effort"`), so a
 * client that asked for thinking receives its `thinking_delta`s on every
 * `anthropic-sse` path (`composed-handler-minimax-thinking.test.ts:95`), and
 * under `forced` the block arrives WITH its signature — the client must be able
 * to echo it back or the chain can never restart
 * (`composed-handler-minimax-thinking.test.ts:131`). An earlier draft of this
 * header claimed the opposite, imported from upstream `0e8f3b05`; that claim is
 * false in this fork and was corrected in review (#596).
 *
 * So why is a 64-hex digest left alone by DEFAULT? Because the same shape means
 * two different things depending on the wire. On the MiniMax path those blocks
 * are the model's own thinking, preserved and re-sent by the dialect
 * (`preserveThinkingBlock()`); stripping them would delete real reasoning. On
 * the NATIVE path such a block is worthless — Anthropic never signed it and it
 * 400s the request — so the native caller opts in explicitly through
 * `stripForeignHexSignature` (#597). The discrimination is by WIRE (which
 * caller asks), never by shape alone inside the predicate: a shape-only strip
 * here would delete MiniMax's own reasoning the moment anyone reused the
 * helper on a composed path.
 *
 * The coupling that does hold: if `shouldFilterThinking()` is narrowed further,
 * more thinking reaches the client and this absent-signature filter alone stops
 * being sufficient to make a history native-safe. The two files are coupled
 * through the wire, not through anything either file says.
 *
 * ─── Role scope ────────────────────────────────────────────────────────────
 *
 * No role filter: a thinking block is invalid on the Anthropic wire wherever it
 * sits, so a `thinking` block found on a `user` message is stripped too rather
 * than left to 400 the request. Reconciled with upstream `0e8f3b05` (MadAppGang
 * re-implementation of our June helper, `651debe0`), which does the same.
 */

/** MiniMax emits SHA-256-digest-shaped thinking signatures: exactly 64 lowercase
 *  hex characters. An Anthropic signature is a long opaque base64 blob and never
 *  matches. One definition for two readers that interpret it in OPPOSITE
 *  directions — the MiniMax dialect calls such a signature the model's OWN
 *  (`preserveThinkingBlock()`, #324 B1), the native path calls it foreign and
 *  strips it (#597). Sharing the shape, never the verdict, is what keeps the two
 *  wires from drifting apart. */
const HEX_64_SIGNATURE = /^[0-9a-f]{64}$/;

/** True when `signature` has the shape MiniMax issues (64 lowercase hex). */
export function isHex64Signature(signature: unknown): boolean {
  return typeof signature === "string" && HEX_64_SIGNATURE.test(signature);
}

/**
 * True when this block is a thinking block Anthropic cannot have signed.
 *
 * An ABSENT, NULL or EMPTY signature always counts. A NON-EMPTY signature is
 * left alone unless `stripForeignHex` is set — see the gap described above;
 * guessing which non-empty signatures are genuine is how you delete real
 * thinking, so the wire has to say so explicitly.
 */
function isStrippableThinking(block: unknown, stripForeignHex: boolean): boolean {
  if (!block || typeof block !== "object") return false;
  const b = block as { type?: unknown; signature?: unknown };
  if (b.type !== "thinking") return false;
  if (typeof b.signature !== "string" || b.signature.length === 0) return true;
  return stripForeignHex && isHex64Signature(b.signature);
}

export interface StripThinkingOptions {
  /**
   * NATIVE PATH ONLY (#597): also remove thinking blocks whose signature is a
   * foreign 64-hex digest. Opt-in per wire — on a MiniMax lane the same shape is
   * the model's own thinking and the `forced` chain cannot restart without it.
   */
  stripForeignHexSignature?: boolean;
}

/**
 * Remove unsigned thinking blocks from a message array, IN PLACE.
 *
 * `options.stripForeignHexSignature` also removes blocks whose signature is a
 * foreign 64-hex digest; only the native handler sets it (#597). Default off, so
 * a caller that never considered the question keeps the conservative behaviour.
 *
 * In place because the caller is about to serialize this exact payload, and a
 * copy would have to be threaded back through every branch that touches
 * `payload.messages` — more surface for the strip to be silently skipped on.
 *
 * A message is only reassigned when something was actually removed, so an
 * untouched history keeps its original array identities.
 *
 * Returns how many blocks were removed, so the caller can log the fact rather
 * than the transformation being invisible.
 *
 * A message whose content becomes EMPTY is left with an empty array rather than
 * deleted: removing the message would renumber the conversation, and the empty
 * case only arises for a turn that was pure unsigned thinking, which cannot
 * have carried anything Anthropic needs.
 */
export function stripUnsignedThinkingBlocks(
  messages: unknown,
  options: StripThinkingOptions = {}
): number {
  if (!Array.isArray(messages)) return 0;
  const stripForeignHex = options.stripForeignHexSignature === true;
  let removed = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const kept = content.filter((block) => !isStrippableThinking(block, stripForeignHex));
    if (kept.length !== content.length) {
      removed += content.length - kept.length;
      (message as { content: unknown }).content = kept;
    }
  }
  return removed;
}
