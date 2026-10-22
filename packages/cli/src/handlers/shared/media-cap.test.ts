/**
 * #575 — the vLLM per-prompt image cap, pinned against the REAL body.
 *
 * Fixture: `test-fixtures/upstream-errors/vllm-image-cap-400.json`, byte-for-byte
 * the `body` field of 10 `upstream-errors.log` entries (12/10 → 20/10). The
 * classifier is narrow on purpose — an invalid image payload is a genuine 400
 * and must not be laundered into a skip.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countMediaBlocks, estimateClampTokens } from "./context-overflow.js";
import { classifyMediaCap, mediaCapRefusalText, mediaCapSkipDetail } from "./media-cap.js";
import { encodeStepSkipHeader, readStepSkip } from "./step-skip.js";
import { isQuotaExhaustion } from "../../fork/failover.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_BODY = readFileSync(
  join(__dirname, "..", "..", "test-fixtures", "upstream-errors", "vllm-image-cap-400.json"),
  "utf-8"
).trim();

/** An Anthropic-shaped content array carrying `n` base64 image blocks. */
function imageBlocks(n: number, dataSize = 1_000_000): unknown[] {
  const blocks: unknown[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A".repeat(dataSize) },
    });
  }
  blocks.push({ type: "text", text: "describe these screenshots" });
  return blocks;
}

describe("#575 — classifyMediaCap", () => {
  test("the REAL upstream body classifies: cap 4, parameter image", () => {
    const m = classifyMediaCap(400, REAL_BODY);
    expect(m.matched).toBe(true);
    expect(m.max).toBe(4);
    expect(m.param).toBe("image");
  });

  test("a non-JSON body carrying the same sentence still classifies", () => {
    const m = classifyMediaCap(
      400,
      "BadRequestError: At most 2 image(s) may be provided in one prompt."
    );
    expect(m.matched).toBe(true);
    expect(m.max).toBe(2);
  });

  test("status-gated: the same body on a 413/422 is not this class", () => {
    expect(classifyMediaCap(413, REAL_BODY).matched).toBe(false);
    expect(classifyMediaCap(422, REAL_BODY).matched).toBe(false);
    expect(classifyMediaCap(200, REAL_BODY).matched).toBe(false);
  });

  test("NARROW: a bare `param:\"image\"` without the cap phrasing is a genuine 400, not a skip", () => {
    // An invalid image payload (bad base64, unsupported media type) must keep
    // its ordinary 400 — laundering it into a skip would move a real request
    // error onto the next step and hide it.
    const invalidPayload = JSON.stringify({
      error: {
        message: "Invalid image data: expected base64 (parameter=image)",
        type: "BadRequestError",
        param: "image",
        code: 400,
      },
    });
    expect(classifyMediaCap(400, invalidPayload).matched).toBe(false);
    // A refusal that merely MENTIONS images but states no cap is not this class.
    expect(
      classifyMediaCap(400, '{"error":{"message":"image format not supported"}}').matched
    ).toBe(false);
    // ANCHOR PIN (review 23:39Z): the phrase must be anchored on "may be
    // provided". Without the anchor, a usage message that merely cites a cap
    // is laundered into a step-skip, and the real request error moves to the
    // next step — the exact risk this test names.
    expect(
      classifyMediaCap(
        400,
        JSON.stringify({
          error: {
            message:
              "Usage: at most 4 image(s) per request on this plan (parameter=image)",
            param: "image",
          },
        })
      ).matched
    ).toBe(false);
    // And an unrelated 400 is untouched.
    expect(
      classifyMediaCap(400, '{"error":{"message":"model not found"}}').matched
    ).toBe(false);
  });
});

describe("#575 — the media count the marker reports", () => {
  test("counts image blocks with the SAME walk as the #441 clamp estimator", () => {
    const payload = { messages: [{ role: "user", content: imageBlocks(5) }] };
    expect(countMediaBlocks(payload)).toBe(5);
    // The estimator replaces each block's base64 with MEDIA_BLOCK_TOKENS, so
    // five 1 MB images score ~8k tokens, not ~1.25M — the two walk together.
    expect(estimateClampTokens(payload)).toBeLessThan(20_000);
  });

  test("text-only and empty payloads count zero, never NaN", () => {
    expect(countMediaBlocks({ messages: [{ role: "user", content: "hi" }] })).toBe(0);
    expect(countMediaBlocks(undefined)).toBe(0);
    expect(countMediaBlocks(null)).toBe(0);
  });
});

describe("#575 — the skip wire carries the new reason", () => {
  test("encode → read round-trip: media survives with its countable detail", () => {
    const detail = mediaCapSkipDetail({ matched: true, max: 4, param: "image" }, 5);
    expect(detail).toBe("images=5 cap=4 param=image");
    const r = new Response(null, {
      headers: { "x-claudish-step-skip": encodeStepSkipHeader("media", detail) },
    });
    expect(readStepSkip(r)).toEqual({ reason: "media", detail });
  });

  test("an unknown reason still reads as null — the reader never acts on what it cannot name", () => {
    const r = new Response(null, { headers: { "x-claudish-step-skip": "invented; x=1" } });
    expect(readStepSkip(r)).toBeNull();
  });

  test("all three reasons the loop acts on are accepted", () => {
    for (const reason of ["context", "busy", "media"] as const) {
      const r = new Response(null, {
        headers: { "x-claudish-step-skip": encodeStepSkipHeader(reason) },
      });
      expect(readStepSkip(r)?.reason).toBe(reason);
    }
  });
});

describe("#575 — the exact label", () => {
  test("names the engine's cap and what the request carries", () => {
    const text = mediaCapRefusalText(4, 5);
    expect(text).toContain("at most 4 image(s)");
    expect(text).toContain("carries 5");
    expect(text).not.toContain("Request format may be incompatible");
  });

  test("degrades honestly when either number is missing", () => {
    expect(mediaCapRefusalText(4, 0)).not.toContain("carries");
    expect(mediaCapRefusalText(undefined, 5)).toContain("limited number of images");
  });

  test("LOAD-BEARING: isQuotaExhaustion never matches it — a screenshot count must not arm a cascade", () => {
    const text = mediaCapRefusalText(4, 5);
    expect(isQuotaExhaustion(400, text)).toBe(false);
    // The shape that would matter if this text ever rode a 429.
    expect(isQuotaExhaustion(429, text)).toBe(false);
    expect(isQuotaExhaustion(402, text)).toBe(true); // status alone, by design
  });
});