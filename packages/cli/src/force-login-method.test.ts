/**
 * Tests for the forced-claude.ai-auth hardening in claude-runner.ts.
 *
 * When a user's global (~/.claude/settings.json) or project (.claude/settings.json)
 * settings set `forceLoginMethod: "claudeai"`, Claude Code would block claudish's
 * proxy sessions (which authenticate via a placeholder ANTHROPIC_API_KEY) at startup.
 * claudish neutralizes this by writing `forceLoginMethod: "console"` into its own
 * --settings overlay, which loads at the CLI-args precedence tier — above the user,
 * project, and local settings files. Native-Anthropic / --monitor sessions use the
 * real claude.ai subscription, so they must be left untouched. The OS *managed* tier
 * cannot be overridden and is caught with a fail-fast abort instead.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudishSettingsOverlay,
  hasResolvableAnthropicAuth,
  isProxyAuthMode,
  managedSettingsForcesClaudeAi,
  mergeUserSettingsIfPresent,
  shouldHideIncidentalAnthropicKey,
} from "./claude-runner.js";
import { setConfigFileOverride } from "./profile-config.js";
import type { ClaudishConfig } from "./types.js";

const baseConfig = (overrides: Partial<ClaudishConfig> = {}): ClaudishConfig =>
  ({
    claudeArgs: [],
    ...overrides,
  }) as ClaudishConfig;

const statusLine = { type: "command", command: "echo hi", padding: 0 };

describe("isProxyAuthMode", () => {
  test("alternative model (proxy) → proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "x-ai/grok-code-fast-1" }))).toBe(true);
  });

  test("bare/unknown model (proxy) → proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "deepseek-v3" }))).toBe(true);
  });

  test("native claude model → NOT proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "claude-opus-4-6" }))).toBe(false);
  });

  test("native claude in a profile mapping → NOT proxy mode", () => {
    expect(
      isProxyAuthMode(
        baseConfig({ modelOpus: "claude-opus-4-6", modelSonnet: "x-ai/grok-code-fast-1" })
      )
    ).toBe(false);
  });

  test("--monitor → NOT proxy mode (uses native subscription)", () => {
    expect(isProxyAuthMode(baseConfig({ monitor: true }))).toBe(false);
  });

  test("--monitor wins even with an alternative model set", () => {
    expect(isProxyAuthMode(baseConfig({ monitor: true, model: "x-ai/grok-code-fast-1" }))).toBe(
      false
    );
  });
});

describe("buildClaudishSettingsOverlay", () => {
  test("proxy mode injects forceLoginMethod: console", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, true);
    expect(overlay.forceLoginMethod).toBe("console");
    expect(overlay.disableClaudeAiConnectors).toBe(true);
    expect(overlay.statusLine).toBe(statusLine);
  });

  test("native/monitor mode OMITS forceLoginMethod entirely", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, false);
    expect("forceLoginMethod" in overlay).toBe(false);
    // Non-auth keys are still present regardless of mode.
    expect(overlay.disableClaudeAiConnectors).toBe(true);
    expect(overlay.statusLine).toBe(statusLine);
  });

  test("an MCP pane child skips the dangerous-mode prompt (D5)", () => {
    expect(
      buildClaudishSettingsOverlay(statusLine, true, true).skipDangerousModePermissionPrompt
    ).toBe(true);
    expect(
      buildClaudishSettingsOverlay(statusLine, false, true).skipDangerousModePermissionPrompt
    ).toBe(true);
  });

  test("no other launch carries skipDangerousModePermissionPrompt", () => {
    expect(
      "skipDangerousModePermissionPrompt" in buildClaudishSettingsOverlay(statusLine, true, false)
    ).toBe(false);
  });

  test.each([true, false])("pane editorMode follows the marker (proxy=%p)", (proxyAuthMode) => {
    const saved = process.env.CLAUDISH_PANE_CHILD;
    try {
      for (const marker of ["1", undefined, "0", ""]) {
        if (marker === undefined) delete process.env.CLAUDISH_PANE_CHILD;
        else process.env.CLAUDISH_PANE_CHILD = marker;
        const overlay = buildClaudishSettingsOverlay(statusLine, proxyAuthMode);
        if (marker === "1") expect(overlay.editorMode).toBe("normal");
        else expect(Object.hasOwn(overlay, "editorMode")).toBe(false);
        expect(overlay.statusLine).toBe(statusLine);
        if (proxyAuthMode) expect(overlay.forceLoginMethod).toBe("console");
        else expect(Object.hasOwn(overlay, "forceLoginMethod")).toBe(false);
      }
    } finally {
      if (saved === undefined) delete process.env.CLAUDISH_PANE_CHILD;
      else process.env.CLAUDISH_PANE_CHILD = saved;
    }
  });

  test("the default reads the CLAUDISH_PANE_CHILD marker", () => {
    const saved = process.env.CLAUDISH_PANE_CHILD;
    try {
      process.env.CLAUDISH_PANE_CHILD = "1";
      expect(buildClaudishSettingsOverlay(statusLine, true).skipDangerousModePermissionPrompt).toBe(
        true
      );
      delete process.env.CLAUDISH_PANE_CHILD;
      expect(
        "skipDangerousModePermissionPrompt" in buildClaudishSettingsOverlay(statusLine, true)
      ).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CLAUDISH_PANE_CHILD;
      else process.env.CLAUDISH_PANE_CHILD = saved;
    }
  });
});

describe("mergeUserSettingsIfPresent", () => {
  const merged = (
    userSettings: Record<string, unknown>,
    paneChild: boolean | undefined,
    proxyAuthMode = true,
    form: "inline" | "file" = "inline"
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-merge-"));
    const path = join(dir, "overlay.json");
    try {
      writeFileSync(
        path,
        JSON.stringify(buildClaudishSettingsOverlay(statusLine, proxyAuthMode, paneChild))
      );
      const userPath = join(dir, "user.json");
      if (form === "file") writeFileSync(userPath, JSON.stringify(userSettings));
      const config = baseConfig({
        claudeArgs: ["--settings", form === "file" ? userPath : JSON.stringify(userSettings)],
      });
      mergeUserSettingsIfPresent(config, path, statusLine, proxyAuthMode, paneChild);
      expect(config.claudeArgs).toEqual([]);
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  for (const form of ["inline", "file"] as const) {
    test.each([true, false])(
      `pane editorMode overrides caller vim in ${form} settings (proxy=%p)`,
      (proxyAuthMode) => {
        const saved = process.env.CLAUDISH_PANE_CHILD;
        try {
          process.env.CLAUDISH_PANE_CHILD = "1";
          const settings = merged({ editorMode: "vim", x: 1 }, undefined, proxyAuthMode, form);
          expect(settings).toMatchObject({ editorMode: "normal", x: 1, statusLine });
          if (proxyAuthMode) expect(settings.forceLoginMethod).toBe("console");
          else expect(Object.hasOwn(settings, "forceLoginMethod")).toBe(false);

          delete process.env.CLAUDISH_PANE_CHILD;
          expect(merged({ editorMode: "vim", x: 1 }, undefined, proxyAuthMode, form)).toMatchObject(
            {
              editorMode: "vim",
              x: 1,
              statusLine,
            }
          );
          expect(
            Object.hasOwn(merged({ x: 1 }, undefined, proxyAuthMode, form), "editorMode")
          ).toBe(false);
        } finally {
          if (saved === undefined) delete process.env.CLAUDISH_PANE_CHILD;
          else process.env.CLAUDISH_PANE_CHILD = saved;
        }
      }
    );

    test.each([true, false])(
      `editorMode does not change forceLoginMethod precedence in ${form} settings (pane=%p)`,
      (paneChild) => {
        const caller = { editorMode: "vim", forceLoginMethod: "claudeai", x: 1 };
        expect(merged(caller, paneChild, true, form)).toMatchObject({
          forceLoginMethod: "claudeai",
          editorMode: paneChild ? "normal" : "vim",
          x: 1,
        });
        expect(merged(caller, paneChild, false, form)).toMatchObject({
          forceLoginMethod: "claudeai",
          editorMode: paneChild ? "normal" : "vim",
          x: 1,
        });
      }
    );
  }

  test("a pane child's merged settings carry skipDangerousModePermissionPrompt", () => {
    expect(merged({ model: "x" }, true).skipDangerousModePermissionPrompt).toBe(true);
  });

  test("the caller's own value is kept", () => {
    expect(
      merged({ skipDangerousModePermissionPrompt: false }, true).skipDangerousModePermissionPrompt
    ).toBe(false);
  });

  test("outside a pane child the key is not added", () => {
    expect("skipDangerousModePermissionPrompt" in merged({ model: "x" }, false)).toBe(false);
  });
});

describe("managedSettingsForcesClaudeAi", () => {
  test("managed settings forcing claudeai → true", () => {
    const readFile = (() => JSON.stringify({ forceLoginMethod: "claudeai" })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(true);
  });

  test("managed settings forcing console → false (not a claudeai block)", () => {
    const readFile = (() => JSON.stringify({ forceLoginMethod: "console" })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("managed settings without forceLoginMethod → false", () => {
    const readFile = (() => JSON.stringify({ someOtherKey: true })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("unreadable/garbled managed settings → false (best-effort, non-fatal)", () => {
    const readFile = (() => {
      throw new Error("EACCES");
    }) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("garbage JSON → false", () => {
    const readFile = (() => "{ not json") as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });
});

describe("hasResolvableAnthropicAuth", () => {
  // Inject all deps so tests are hermetic: never read the real process.env / filesystem,
  // never mutate process.platform, and never spawn `security`.
  const noEnv: NodeJS.ProcessEnv = {};
  const noFile = () => false;
  const noKeychain = () => false;

  test("ANTHROPIC_API_KEY env → true", () => {
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(true);
  });

  test("ANTHROPIC_AUTH_TOKEN env → true", () => {
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_AUTH_TOKEN: "tok-test" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(true);
  });

  test("credentials file present → true (no env, no keychain)", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: () => true, keychainProbe: noKeychain })
    ).toBe(true);
  });

  test("macOS Keychain item present → true (no env, no file)", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: () => true })
    ).toBe(true);
  });

  test("Keychain absent + no env + no file → false", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: noKeychain })
    ).toBe(false);
  });

  test("non-darwin (probe returns false) still resolves via env/file", () => {
    // Off-darwin, defaultKeychainAnthropicProbe returns false; the env/file checks
    // remain the only sources. All-absent → false; env present → still true.
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: () => false })
    ).toBe(false);
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fileExists: noFile,
        keychainProbe: () => false,
      })
    ).toBe(true);
  });
});

describe("shouldHideIncidentalAnthropicKey", () => {
  const apiKeyEnv: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-test" };
  const noEnv: NodeJS.ProcessEnv = {};
  const configPath = join(tmpdir(), `claudish-force-login-method-${randomUUID()}.json`);

  beforeAll(() => {
    writeFileSync(configPath, "{}", "utf8");
    setConfigFileOverride(configPath);
  });

  afterAll(() => {
    setConfigFileOverride(null);
    rmSync(configPath, { force: true });
  });

  test("native mapping + API key + default billing → true", () => {
    expect(
      shouldHideIncidentalAnthropicKey(baseConfig({ model: "claude-opus-4-6" }), apiKeyEnv)
    ).toBe(true);
  });

  test.each([
    ["o4-mini", false],
    ["opusplan", true],
    ["sonnet[1m]", true],
    ["claude-haiku-4-5-20251001", true],
  ])("classifies %s for native Anthropic auth as %p", (model, expected) => {
    expect(shouldHideIncidentalAnthropicKey(baseConfig({ model }), apiKeyEnv)).toBe(expected);
  });

  test("native mapping + API key + API billing opt-in → false", () => {
    expect(
      shouldHideIncidentalAnthropicKey(
        baseConfig({ model: "claude-opus-4-6", anthropicApiBilling: true }),
        apiKeyEnv
      )
    ).toBe(false);
  });

  test("native mapping + no API key → false", () => {
    expect(shouldHideIncidentalAnthropicKey(baseConfig({ model: "claude-opus-4-6" }), noEnv)).toBe(
      false
    );
  });

  test("classifier-only passthrough + API key → false", () => {
    // Under classifier-only passthrough, the key may be the user's only Anthropic
    // credential; hiding it would strand the classifier request at a login gate.
    expect(
      shouldHideIncidentalAnthropicKey(
        baseConfig({ model: "x-ai/grok-code-fast-1", classifierProvider: "anthropic" }),
        apiKeyEnv
      )
    ).toBe(false);
  });

  test("no native mapping or classifier config + API key → false", () => {
    expect(
      shouldHideIncidentalAnthropicKey(baseConfig({ model: "x-ai/grok-code-fast-1" }), apiKeyEnv)
    ).toBe(false);
  });
});
