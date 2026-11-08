import { describe, expect, test } from "bun:test";
import { sniffResponsesStreamHead } from "./stream-head-sniffer.js";

const encoder = new TextEncoder();

/**
 * PROVISIONAL: replace with the D8 real Codex capture (metadata prefix plus
 * `usage_limit_reached`) before Phase 2 merges. The `api_error` type is included
 * deliberately: it also matches the transient classifier, making ordering
 * observable rather than merely asserted in prose.
 */
const PROVISIONAL_QUOTA_EVENT = {
  type: "error",
  error: {
    type: "api_error",
    code: "usage_limit_reached",
    message: "You've hit your usage limit. Please retry after 14:32.",
    resets_in_seconds: 120,
  },
};

function eventResponse(
  event: unknown,
  hooks: { onCancel?: () => void; keepOpen?: boolean } = {}
): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (!hooks.keepOpen) controller.close();
      },
      cancel() {
        hooks.onCancel?.();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

describe("sniffResponsesStreamHead quota verdict", () => {
  test("classifies usage quota before the retryable api_error type", async () => {
    let cancelled = false;
    const verdict = await sniffResponsesStreamHead(
      eventResponse(PROVISIONAL_QUOTA_EVENT, {
        keepOpen: true,
        onCancel: () => {
          cancelled = true;
        },
      }),
      { budgetMs: 100 }
    );
    await Promise.resolve();

    expect(verdict).toEqual({
      kind: "quota",
      code: "usage_limit_reached",
      message: "You've hit your usage limit. Please retry after 14:32.",
      resetsInSeconds: 120,
    });
    expect("response" in verdict).toBe(false);
    expect(cancelled).toBe(true);

    // Mutation caught: move the quota check below isRetryableStreamError. The
    // same event becomes retryable because error.type is api_error. Removing the
    // cancellation or attaching a replay Response also turns this row red.
  });

  test("classifies quota in default mode without enabling the extended watch", async () => {
    const verdict = await sniffResponsesStreamHead(eventResponse(PROVISIONAL_QUOTA_EVENT), {
      budgetMs: 100,
      extendedQuotaWatch: false,
    });

    expect(verdict.kind).toBe("quota");

    // Mutation caught: make false mode pure legacy by dropping quota parsing.
    // A one-account stream must still be classified and markable even though it
    // cannot rotate.
  });

  test("keeps a plain rate_limit_exceeded event retryable rather than quota", async () => {
    const verdict = await sniffResponsesStreamHead(
      eventResponse({
        type: "error",
        error: {
          type: "api_error",
          code: "rate_limit_exceeded",
          message: "Please retry later",
        },
      }),
      { budgetMs: 100 }
    );

    expect(verdict).toEqual({
      kind: "retryable",
      code: "rate_limit_exceeded",
      message: "Please retry later",
    });

    // Mutation caught: broaden usage-limit parsing to ordinary rate limits.
  });

  test("replays an ordinary content event byte-for-byte", async () => {
    const event = {
      type: "response.output_text.delta",
      delta: "ordinary output",
    };
    const raw = `data: ${JSON.stringify(event)}\n\n`;
    const verdict = await sniffResponsesStreamHead(eventResponse(event), {
      budgetMs: 100,
      extendedQuotaWatch: true,
    });

    expect(verdict.kind).toBe("clean");
    if (verdict.kind === "clean") expect(await verdict.response.text()).toBe(raw);

    // Mutation caught: consume a clean prefix without replaying it, or treat a
    // content delta as metadata that remains eligible for rotation.
  });
});
