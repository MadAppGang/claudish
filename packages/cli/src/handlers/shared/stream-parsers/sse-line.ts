/**
 * Payload of an SSE `data:` line, or null when the line isn't one.
 *
 * The SSE spec makes the space after the colon OPTIONAL — `data:{...}` and
 * `data: {...}` are both valid, and a conforming parser strips at most ONE
 * leading space. A `startsWith("data: ")` gate silently skips every line from
 * a provider that emits the bare form. That bit twice upstream, both times
 * Alibaba: Model Studio's Anthropic endpoint (the anthropic parser — our fork
 * normalizes inline at anthropic-sse.ts), then DashScope's Responses API
 * (measured 2026-10-14: `qwen3.8-max-0902` streamed
 * `response.output_text.delta` events as `data:{…}` and claudish delivered an
 * empty answer — `--probe` said "stream ended without content"). Port of
 * upstream 3dbd3167: every parser that gated on the spaced form now reads
 * data lines through this one function.
 */
export function sseDataPayload(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const rest = line.slice(5);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}
