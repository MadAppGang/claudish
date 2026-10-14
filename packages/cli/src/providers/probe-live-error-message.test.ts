/**
 * Pins for the port of upstream 196e6f8f in the probe path (#28 early take).
 *
 * The probe goes THROUGH the running proxy, so what it reads is claudish's own
 * envelope, not the provider's raw answer. On the non-JSON fallback path that
 * envelope's `error.message` is a whole raw upstream body — an SSE frame whose
 * newlines have become spaces by then. `error.provider_message` carries the
 * unwrapped sentence; the probe row must lead with it. Mutation checks: revert
 * either half (the provider_message read, or the frame unwrap) and each pin
 * below goes red.
 */
import { describe, test, expect } from "bun:test";
import { classifyHttpError } from "./probe-live.js";

const ALIBABA_SSE =
  'event:error\ndata:{"code":"AccessDenied","message":"Model access denied.","request_id":"x"}';
const COMPOSED =
  "Alibaba PAYG error (HTTP 403): The provider accepted the credential but denied access to this model — check model access or activation for this account in the provider's console, not the key.";

function proxyBody(message: string, providerMessage?: string): string {
  const error: Record<string, unknown> = {
    type: "invalid_request_error",
    message,
  };
  if (providerMessage !== undefined) error.provider_message = providerMessage;
  return JSON.stringify({ type: "error", error });
}

describe("classifyHttpError errorMessage (port 196e6f8f)", () => {
  test("leads with provider_message when present", () => {
    const result = classifyHttpError(400, proxyBody(COMPOSED, "Model access denied."), 1200);
    expect(result.errorMessage).toBe("Model access denied.");
  });

  test("falls back to the composed message when provider_message is absent", () => {
    const result = classifyHttpError(400, proxyBody(COMPOSED), 1200);
    // The composed hint is 196 chars — the row's pre-existing 160-char clip
    // applies (that clip is the very reason the provider's 3-word sentence
    // needs its own field).
    expect(result.errorMessage).toBe(`${COMPOSED.slice(0, 157)}...`);
  });

  test("unwraps a raw SSE frame body (provider answered the wire frame directly)", () => {
    const result = classifyHttpError(403, ALIBABA_SSE, 1200);
    expect(result.errorMessage).toBe("Model access denied.");
  });

  test("unwraps a FLATTENED frame riding in error.message (newlines → spaces)", () => {
    // composed-handler's non-JSON fallback wraps the raw body as the message;
    // by the time the probe re-parses the envelope, the frame is one line.
    const flattened = "event:error data:" + ALIBABA_SSE.split("data:")[1];
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: flattened } });
    const result = classifyHttpError(400, body, 1200);
    expect(result.errorMessage).toBe("Model access denied.");
  });
});
