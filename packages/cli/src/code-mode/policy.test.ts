import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CodexModelInfo } from "../providers/codex-models-discovery.js";
import { type CodeModeDecision, type CodeModeDecisionInput, decideCodeMode } from "./policy.js";

type OffReason = Extract<CodeModeDecision, { on: false }>["reason"];

const capture = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/code-mode/codex-models-response.json", import.meta.url),
    "utf8"
  )
) as {
  models: Array<{
    slug: string;
    tool_mode?: string;
    use_responses_lite?: boolean;
    default_reasoning_level?: string;
  }>;
};
const discovered = capture.models.find(
  (model) => model.tool_mode === "code_mode_only" && model.use_responses_lite
)!;
const info: CodexModelInfo = {
  slug: discovered.slug,
  toolMode: discovered.tool_mode,
  useResponsesLite: discovered.use_responses_lite,
  defaultReasoningLevel: discovered.default_reasoning_level,
};
const baseline: CodeModeDecisionInput = {
  providerName: "openai-codex",
  arm: "oauth",
  accountKey: "account-a",
  api: "responses",
  hasTools: true,
  toolChoice: undefined,
  hasSessionId: true,
  setting: "auto",
  modelInfo: info,
  pinned: false,
  sandboxAvailable: true,
  liteFallbackActive: false,
};

describe("code-mode policy", () => {
  test.each([
    ["other claudish provider", { providerName: "openai" }, "not-openai-codex"],
    ["api-key arm [M]", { arm: "api-key" }, "metered-arm"],
    ["absent arm", { arm: undefined }, "metered-arm"],
    ["no account id", { accountKey: undefined }, "no-account-id"],
    ["non-Responses API", { api: "chat-completions" }, "not-responses"],
    ["unknown API", { api: undefined }, "not-responses"],
    ["no tools", { hasTools: false }, "no-tools"],
    ["named tool choice", { toolChoice: { type: "tool", name: "Read" } }, "forced-tool-choice"],
    ["any tool choice", { toolChoice: { type: "any" } }, "forced-tool-choice"],
    ["none tool choice", { toolChoice: { type: "none" } }, "forced-tool-choice"],
    ["no session id", { hasSessionId: false }, "no-session-id"],
    ["setting off", { setting: "off" }, "setting-off"],
    ["sandbox unavailable", { sandboxAvailable: false }, "sandbox-unavailable"],
    ["unknown discovery", { modelInfo: undefined }, "discovery-unknown"],
    [
      "other discovered tool mode",
      { modelInfo: { ...info, toolMode: "classic" } },
      "classic-by-discovery",
    ],
  ] as Array<[string, Partial<CodeModeDecisionInput>, OffReason]>)(
    "%s remains non-code-mode",
    (_name, patch, reason) => {
      expect(decideCodeMode({ ...baseline, ...patch })).toEqual({ on: false, reason });
    }
  );

  test("auto follows the live discovery fields and accepts explicit auto tool choice", () => {
    expect(discovered).toBeDefined();
    expect(decideCodeMode(baseline)).toEqual({ on: true, shape: "lite", reason: "discovery" });
    expect(decideCodeMode({ ...baseline, toolChoice: { type: "auto" } })).toEqual({
      on: true,
      shape: "lite",
      reason: "discovery",
    });
  });

  test("setting on forces code mode without discovery, but uses classic shape", () => {
    expect(decideCodeMode({ ...baseline, setting: "on", modelInfo: undefined })).toEqual({
      on: true,
      shape: "classic",
      reason: "forced",
    });
  });

  test("forced on never bypasses the api-key arm or session/account/sandbox guards [M]", () => {
    for (const [patch, reason] of [
      [{ arm: "api-key" }, "metered-arm"],
      [{ accountKey: undefined }, "no-account-id"],
      [{ hasSessionId: false }, "no-session-id"],
      [{ sandboxAvailable: false }, "sandbox-unavailable"],
    ] as Array<[Partial<CodeModeDecisionInput>, OffReason]>) {
      expect(decideCodeMode({ ...baseline, setting: "on", ...patch })).toEqual({
        on: false,
        reason,
      });
    }
  });

  test("pin preserves code mode when discovery is unknown, never when setting is off", () => {
    expect(decideCodeMode({ ...baseline, pinned: true, modelInfo: undefined })).toEqual({
      on: true,
      shape: "classic",
      reason: "pinned",
    });
    expect(decideCodeMode({ ...baseline, pinned: true, setting: "off" })).toEqual({
      on: false,
      reason: "setting-off",
    });
    expect(decideCodeMode({ ...baseline, pinned: true, arm: "api-key" })).toEqual({
      on: false,
      reason: "metered-arm",
    });
  });

  test("lite rejection or discovery without lite selects classic code-mode shape", () => {
    expect(decideCodeMode({ ...baseline, liteFallbackActive: true })).toEqual({
      on: true,
      shape: "classic",
      reason: "discovery",
    });
    expect(
      decideCodeMode({ ...baseline, modelInfo: { ...info, useResponsesLite: false } })
    ).toEqual({ on: true, shape: "classic", reason: "discovery" });
  });
});
