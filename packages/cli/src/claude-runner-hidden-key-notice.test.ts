/**
 * The startup notice printed when a real ANTHROPIC_API_KEY is hidden from the
 * spawned Claude Code. On a classifier-only launch the vision proxy, which
 * signs only with the inbound `x-api-key`, then has no key, so a main model
 * that cannot read images gets no image descriptions.
 */

import { describe, expect, test } from "bun:test";
import { hiddenAnthropicKeyNotice } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const config = {} as ClaudishConfig;

describe("hiddenAnthropicKeyNotice", () => {
  // REGRESSION: a classifier-only launch hid the key and never said image descriptions stop
  test("says image descriptions are off on a classifier-only launch", () => {
    expect(hiddenAnthropicKeyNotice(config, false)).toContain(
      "image descriptions for a non-vision main model are off"
    );
  });

  test("keeps the API billing advice on a classifier-only launch", () => {
    expect(hiddenAnthropicKeyNotice(config, false)).toContain("--anthropic-api-billing");
  });

  test("does not mention image descriptions on a native Claude role launch", () => {
    expect(hiddenAnthropicKeyNotice(config, true)).not.toContain("image descriptions");
  });
});
