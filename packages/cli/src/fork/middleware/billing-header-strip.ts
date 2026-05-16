/**
 * Billing header strip (fork extension).
 *
 * Claude Code injects `x-anthropic-billing-header: cc_version=...; cch=XXXXX;`
 * into the prompt body — the `cch=` token changes every request, which breaks
 * vLLM prefix caching (strict hash). Only Anthropic needs this; strip for others.
 */

export function stripBillingHeaderFromBody(body: any, isNative: boolean): void {
  if (isNative) return;

  if (typeof body.system === "string") {
    body.system = body.system.replace(
      /x-anthropic-billing-header: cc_version=[^\n]*\n?/g,
      ""
    );
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = block.text.replace(
          /x-anthropic-billing-header: cc_version=[^\n]*\n?/g,
          ""
        );
      }
    }
  }
}
