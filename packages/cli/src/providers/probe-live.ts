/**
 * probe-live — send real 1-token chat requests through the running proxy
 * to validate that each link in a model's fallback chain actually works.
 *
 * The probe goes through the same proxy that serves real traffic, so it
 * exercises every layer: API key resolution (env/.env/config.json),
 * routing rules, transport classes, adapter format, and stream parser.
 *
 * Each link is pinned to a single provider by passing its `provider@model`
 * spec as the request body. The runtime router sees `isExplicitProvider`
 * and skips fallback — so a failure here is a real failure for that link,
 * not a silent failover to something else.
 */

export type ProbeState =
  | "live"
  | "key-missing"
  | "auth-failed"
  | "model-not-found"
  | "rate-limited"
  | "server-error"
  | "timeout"
  | "network-error"
  | "error";

export interface ProbeResult {
  state: ProbeState;
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  /** Hint shown after the error message (e.g. "run: claudish login gemini"). */
  actionHint?: string;
}

/**
 * Providers that authenticate via OAuth rather than a static env-var key.
 * Their static credential check is unreliable (no env var to test), so the
 * probe must treat the live request as the source of truth: if it returns a
 * token-related failure, we surface a login hint instead of masking the link
 * as "skipped".
 */
const OAUTH_PROVIDERS = new Set(["vertex", "gemini-codeassist"]);
const PROBE_PROMPT = "ping";
const PROBE_MAX_TOKENS = 1;

export interface ProbeLinkInput {
  provider: string;
  modelSpec: string;
  hasCredentials: boolean;
  credentialHint?: string;
}

export async function probeLink(
  proxyUrl: string,
  link: ProbeLinkInput,
  timeoutMs: number
): Promise<ProbeResult> {
  const isOAuth = OAUTH_PROVIDERS.has(link.provider);

  if (!link.hasCredentials && !isOAuth) {
    return {
      state: "key-missing",
      latencyMs: 0,
      errorMessage: link.credentialHint,
    };
  }

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: link.modelSpec,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    const latencyMs = Date.now() - startedAt;
    const name = e?.name || "";
    const msg = String(e?.message || e);
    if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) {
      return { state: "timeout", latencyMs, errorMessage: msg };
    }
    return { state: "network-error", latencyMs, errorMessage: msg };
  }

  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const body = await safeReadBody(response);
    return annotateOAuthHint(
      classifyHttpError(response.status, body, latencyMs),
      link.provider,
      isOAuth
    );
  }

  const streamResult = await consumeProbeStream(response, timeoutMs);
  return annotateOAuthHint(
    {
      ...streamResult,
      latencyMs: Date.now() - startedAt,
    },
    link.provider,
    isOAuth
  );
}

/**
 * Attach a login hint when an OAuth provider failed authentication. The
 * `gemini` / `vertex` transports authenticate via cached tokens, so a 401 or
 * a parser error that mentions OAuth usually means the user needs to
 * re-authenticate — surface the exact command instead of leaving them to
 * guess.
 */
function annotateOAuthHint(
  result: ProbeResult,
  provider: string,
  isOAuth: boolean
): ProbeResult {
  if (!isOAuth) return result;
  if (result.state === "live") return result;

  const loginCommand =
    provider === "gemini-codeassist"
      ? "claudish login gemini"
      : provider === "vertex"
        ? "gcloud auth application-default login"
        : undefined;

  if (!loginCommand) return result;

  const looksLikeAuthFailure =
    result.state === "auth-failed" ||
    /auth|token|login|credential|unauthor/i.test(result.errorMessage || "");
  if (!looksLikeAuthFailure) return result;

  return {
    ...result,
    state: "auth-failed",
    actionHint: `run: ${loginCommand}`,
  };
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

function classifyHttpError(
  status: number,
  body: string,
  latencyMs: number
): ProbeResult {
  const lowered = body.toLowerCase();
  if (status === 401 || status === 403) {
    return {
      state: "auth-failed",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
    };
  }
  if (status === 404 || /model[_ ]not[_ ]found|no such model|unknown model/.test(lowered)) {
    return {
      state: "model-not-found",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
    };
  }
  if (status === 429) {
    return {
      state: "rate-limited",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || "Rate limited",
    };
  }
  if (status >= 500) {
    return {
      state: "server-error",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
    };
  }
  return {
    state: "error",
    latencyMs,
    httpStatus: status,
    errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
  };
}

function extractErrorMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const msg =
      parsed?.error?.message ||
      parsed?.error?.error?.message ||
      parsed?.message ||
      parsed?.detail;
    if (typeof msg === "string" && msg.length > 0) {
      return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
    }
  } catch {
    // not JSON, fall through
  }
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

/**
 * Read the SSE stream just long enough to confirm a valid first content event.
 * We don't accumulate the full response — a single valid data chunk is proof
 * that the entire stack (auth, routing, adapter, transport, parser) works.
 */
async function consumeProbeStream(
  response: Response,
  timeoutMs: number
): Promise<Omit<ProbeResult, "latencyMs">> {
  const body = response.body;
  if (!body) {
    return { state: "error", errorMessage: "empty response body" };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      const events = buffered.split("\n\n");
      buffered = events.pop() ?? "";

      for (const event of events) {
        const verdict = interpretSseEvent(event);
        if (verdict === "live") {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return { state: "live" };
        }
        if (verdict && verdict.state !== "live") {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return verdict;
        }
      }
    }
  } catch (e: any) {
    return {
      state: "network-error",
      errorMessage: String(e?.message || e),
    };
  }

  return {
    state: "error",
    errorMessage: "stream ended without content",
  };
}

type SseVerdict = "live" | Omit<ProbeResult, "latencyMs"> | null;

function interpretSseEvent(rawEvent: string): SseVerdict {
  const lines = rawEvent.split("\n");
  let eventType = "";
  let dataPayload = "";
  for (const line of lines) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) dataPayload += line.slice(5).trim();
  }
  if (!dataPayload) return null;
  if (dataPayload === "[DONE]") return null;

  let parsed: any;
  try {
    parsed = JSON.parse(dataPayload);
  } catch {
    return null;
  }

  if (parsed?.type === "error" || eventType === "error" || parsed?.error) {
    const message =
      parsed?.error?.message ||
      parsed?.error?.error?.message ||
      parsed?.message ||
      "provider returned error event";
    const status = parsed?.error?.status || parsed?.status;
    if (typeof status === "number") {
      return {
        state: status === 401 || status === 403 ? "auth-failed" : "error",
        httpStatus: status,
        errorMessage: message,
      };
    }
    return { state: "error", errorMessage: message };
  }

  if (isContentEvent(parsed, eventType)) {
    return "live";
  }
  return null;
}

function isContentEvent(parsed: any, eventType: string): boolean {
  // A `content_block_start` alone is not evidence of content (S4-b edd4ce9):
  // the contentless guard can legitimately emit an EMPTY text block on a
  // successful-but-empty turn, so counting any start as live would pass a
  // probe on a stream that produced nothing. Only a tool_use start is a start
  // that IS the call. Deltas still count — they carry actual payload, and a
  // normal text answer reaches a text_delta right after its start.
  if (eventType === "content_block_start") return parsed?.content_block?.type === "tool_use";
  if (eventType === "content_block_delta") return true;
  if (eventType === "message_start") return true;
  if (parsed?.type === "content_block_start") return parsed?.content_block?.type === "tool_use";
  if (parsed?.type === "content_block_delta") return true;
  if (parsed?.type === "message_start") return true;
  if (parsed?.type === "message_delta") return true;
  if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
    const choice = parsed.choices[0];
    if (choice?.delta || choice?.message || choice?.text || choice?.finish_reason) return true;
  }
  if (parsed?.candidates) return true;
  return false;
}

export function describeProbeState(result: ProbeResult): string {
  switch (result.state) {
    case "live":
      return `live · ${result.latencyMs}ms`;
    case "key-missing":
      return result.errorMessage
        ? `missing (${result.errorMessage})`
        : "missing";
    case "auth-failed":
      return `auth failed · ${result.httpStatus ?? ""}${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`.trim();
    case "model-not-found":
      return `model not found · ${result.httpStatus ?? ""}${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`.trim();
    case "rate-limited":
      return `rate limited · ${result.latencyMs}ms`;
    case "server-error":
      return `server error · ${result.httpStatus ?? ""} · ${result.latencyMs}ms`;
    case "timeout":
      return `timeout · ${result.latencyMs}ms`;
    case "network-error":
      return `network error · ${result.latencyMs}ms`;
    case "error":
      return `error${result.httpStatus ? ` · ${result.httpStatus}` : ""}${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`;
  }
}

export function isReadyState(state: ProbeState): boolean {
  return state === "live";
}

export function isFailureState(state: ProbeState): boolean {
  return (
    state === "auth-failed" ||
    state === "model-not-found" ||
    state === "rate-limited" ||
    state === "server-error" ||
    state === "timeout" ||
    state === "network-error" ||
    state === "error"
  );
}
