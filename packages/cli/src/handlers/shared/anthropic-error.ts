/**
 * Anthropic error envelope wrapper.
 * All proxy error responses MUST use this format.
 */

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "overloaded_error"
  | "api_error"
  | "connection_error";

export interface AnthropicErrorEnvelope {
  type: "error";
  error: {
    type: AnthropicErrorType;
    message: string;
    /**
     * The UPSTREAM'S OWN WORDS, unedited — no hint, no provider name, no status
     * (port of upstream 196e6f8f). `message` may be a composed sentence or a
     * whole raw body (the non-JSON fallback wrap puts the entire upstream body
     * there, SSE frame included); this field carries just the provider's
     * sentence, unwrapped, for machine consumers that clip — a probe row showed
     * 100% of claudish's wrapper and 0% of the provider's fact. Extra JSON
     * fields are ignored by Claude Code.
     */
    provider_message?: string;
  };
}

/**
 * Map HTTP status codes to Anthropic error types.
 */
export function statusToErrorType(status: number): AnthropicErrorType {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 429: return "rate_limit_error";
    case 503:
    case 529: return "overloaded_error";
    default:  return "api_error";
  }
}

/**
 * Create a properly formatted Anthropic error envelope.
 *
 * @param status          - HTTP status code (used to infer error type if not provided)
 * @param message         - Human-readable error message
 * @param errorType       - Override the error type (e.g., from a provider's structured error)
 * @param providerMessage - The upstream's own sentence, kept whole and separate from
 *                         `message` (port of upstream 196e6f8f). Flattened to one line
 *                         here rather than at each caller: the field exists to be rendered
 *                         in a single row, and a provider may answer with a multi-line
 *                         SSE frame. Omitted entirely when absent or blank.
 */
export function wrapAnthropicError(
  status: number,
  message: string,
  errorType?: string,
  providerMessage?: string
): AnthropicErrorEnvelope {
  const type = (errorType as AnthropicErrorType) || statusToErrorType(status);
  const error: AnthropicErrorEnvelope["error"] = { type, message };
  const oneLine = (providerMessage ?? "").replace(/\s+/g, " ").trim();
  if (oneLine) error.provider_message = oneLine;
  return { type: "error", error };
}

/**
 * Extract the `data:` payload of an SSE error frame, in both shapes it reaches
 * us (port of upstream 196e6f8f).
 *
 * Shape 1: a real frame, still carrying its line breaks. Multiple `data:` lines
 * concatenate, per the SSE specification.
 *
 * Shape 2: the SAME frame after its newlines became spaces. Non-JSON upstream
 * bodies get wrapped as `{error:{message: <that body>}}` (composed-handler's
 * non-JSON fallback), and JSON.stringify flattens embedded newlines to spaces
 * on the way through — so a consumer re-parsing the envelope sees
 * `event:error data:{…}` on ONE line, where no line starts with `data:` and
 * shape 1 finds nothing. Everything after the first `data:` is the payload; a
 * frame carrying several data fields has already lost its boundaries by this
 * point, and one JSON object is the case that occurs.
 *
 * Returns undefined for a body that is not an SSE frame at all.
 */
export function sseDataPayload(body: string): string | undefined {
  if (!/(^|\s)(event|data):/.test(body)) return undefined;

  // Shape 1: real frame with line breaks.
  const lines = body.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (lines.length > 0) {
    const joined = lines.map((line) => line.slice("data:".length).trim()).join("");
    if (joined.length > 0) return joined;
  }

  // Shape 2: flattened frame (newlines → spaces).
  const at = body.search(/(^|\s)data:/);
  if (at === -1) return undefined;
  const payload = body.slice(body.indexOf("data:", at) + "data:".length).trim();
  return payload.length > 0 ? payload : undefined;
}

/**
 * The upstream's own error sentence, extracted from any body shape seen
 * (port of upstream 196e6f8f). A message field can itself hold a whole SSE
 * frame — a raw upstream body re-wrapped as `{error:{message: <that body>}}`
 * parses as valid JSON, so a plain ladder hands back wire protocol wearing a
 * message field — so string candidates are re-entered through the string arm,
 * which opens the frame first. FastAPI validation errors (`detail:
 * [{ msg, loc, ... }]`) yield their first `msg`.
 */
export function extractProviderMessage(body: any): string {
  if (body == null) return "";
  if (typeof body === "string") {
    // A streamed error is still a document once the frame is opened. Only the
    // payload is re-entered, so a frame that carries no recognisable message
    // falls back to the frame itself rather than to nothing.
    const payload = sseDataPayload(body);
    if (payload) {
      try {
        const inner = extractProviderMessage(JSON.parse(payload));
        if (inner) return inner;
      } catch {
        return payload;
      }
      return payload;
    }
    return body;
  }
  const candidates = [
    body?.error?.message,
    body?.message,
    typeof body?.error === "string" ? body.error : undefined,
    body?.error?.detail,
    body?.detail,
  ];
  for (const c of candidates) {
    // Re-entered through the string arm, not returned directly (see above).
    if (typeof c === "string" && c.length > 0) return extractProviderMessage(c);
    if (Array.isArray(c)) {
      const first = c.find((e) => typeof e?.msg === "string" && e.msg.length > 0);
      if (first) return first.msg;
    }
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Check if a parsed JSON body is already in Anthropic error envelope format.
 * Returns the body as-is if valid, or wraps it if not.
 */
export function ensureAnthropicErrorFormat(
  status: number,
  body: any
): AnthropicErrorEnvelope {
  // Already correct format: { type: "error", error: { type: "...", message: "..." } }
  if (
    body?.type === "error" &&
    typeof body?.error?.type === "string" &&
    typeof body?.error?.message === "string"
  ) {
    return body;
  }

  // Partial format: { error: { type: "...", message: "..." } } (missing outer type)
  if (typeof body?.error?.type === "string" && typeof body?.error?.message === "string") {
    return { type: "error", error: body.error };
  }

  // Provider returned some other JSON structure -- extract best message
  const message =
    body?.error?.message ||
    body?.message ||
    body?.error ||
    (typeof body === "string" ? body : JSON.stringify(body));

  const errorType = body?.error?.type || body?.type || body?.code;

  return wrapAnthropicError(status, String(message), errorType);
}
