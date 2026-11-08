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

  test.each([true, false])("pane editorMode needs the flag and cwd (proxy=%p)", (proxyAuthMode) => {
    const savedFlag = process.env.CLAUDISH_PANE_CHILD;
    const savedCwd = process.env.CLAUDISH_PANE_CWD;
    try {
      for (const cwd of ["/w", undefined, ""]) {
        if (cwd === undefined) delete process.env.CLAUDISH_PANE_CWD;
        else process.env.CLAUDISH_PANE_CWD = cwd;
        for (const marker of ["1", undefined, "0", ""]) {
          if (marker === undefined) delete process.env.CLAUDISH_PANE_CHILD;
          else process.env.CLAUDISH_PANE_CHILD = marker;
          const overlay = buildClaudishSettingsOverlay(statusLine, proxyAuthMode);
          if (marker === "1" && cwd) {
            expect(overlay.editorMode).toBe("normal");
            expect(overlay.skipDangerousModePermissionPrompt).toBe(true);
          } else {
            expect(Object.hasOwn(overlay, "editorMode")).toBe(false);
            expect(Object.hasOwn(overlay, "skipDangerousModePermissionPrompt")).toBe(false);
          }
          expect(overlay.statusLine).toBe(statusLine);
          if (proxyAuthMode) expect(overlay.forceLoginMethod).toBe("console");
          else expect(Object.hasOwn(overlay, "forceLoginMethod")).toBe(false);
        }
      }
    } finally {
      if (savedFlag === undefined) delete process.env.CLAUDISH_PANE_CHILD;
      else process.env.CLAUDISH_PANE_CHILD = savedFlag;
      if (savedCwd === undefined) delete process.env.CLAUDISH_PANE_CWD;
      else process.env.CLAUDISH_PANE_CWD = savedCwd;
    }
  });

  test("T-U-8: the default skips the prompt only with the flag and a pane cwd", () => {
    const savedFlag = process.env.CLAUDISH_PANE_CHILD;
    const savedCwd = process.env.CLAUDISH_PANE_CWD;
    try {
      process.env.CLAUDISH_PANE_CHILD = "1";
      delete process.env.CLAUDISH_PANE_CWD;
      expect(
        "skipDangerousModePermissionPrompt" in buildClaudishSettingsOverlay(statusLine, true)
      ).toBe(false);
      process.env.CLAUDISH_PANE_CWD = "/w";
      expect(
        "skipDangerousModePermissionPrompt" in buildClaudishSettingsOverlay(statusLine, true)
      ).toBe(true);
      expect(buildClaudishSettingsOverlay(statusLine, true).skipDangerousModePermissionPrompt).toBe(
        true
      );
      delete process.env.CLAUDISH_PANE_CHILD;
      expect(
        "skipDangerousModePermissionPrompt" in buildClaudishSettingsOverlay(statusLine, true)
      ).toBe(false);
    } finally {
      if (savedFlag === undefined) delete process.env.CLAUDISH_PANE_CHILD;
      else process.env.CLAUDISH_PANE_CHILD = savedFlag;
      if (savedCwd === undefined) delete process.env.CLAUDISH_PANE_CWD;
      else process.env.CLAUDISH_PANE_CWD = savedCwd;
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
        const savedFlag = process.env.CLAUDISH_PANE_CHILD;
        const savedCwd = process.env.CLAUDISH_PANE_CWD;
        try {
          process.env.CLAUDISH_PANE_CHILD = "1";
          delete process.env.CLAUDISH_PANE_CWD;
          expect(merged({ editorMode: "vim", x: 1 }, undefined, proxyAuthMode, form)).toMatchObject(
            {
              editorMode: "vim",
              x: 1,
              statusLine,
            }
          );
          const nestedSettings = merged({ x: 1 }, undefined, proxyAuthMode, form);
          expect(Object.hasOwn(nestedSettings, "editorMode")).toBe(false);
          expect(Object.hasOwn(nestedSettings, "skipDangerousModePermissionPrompt")).toBe(false);

          process.env.CLAUDISH_PANE_CWD = "/w";
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
          if (savedFlag === undefined) delete process.env.CLAUDISH_PANE_CHILD;
          else process.env.CLAUDISH_PANE_CHILD = savedFlag;
          if (savedCwd === undefined) delete process.env.CLAUDISH_PANE_CWD;
          else process.env.CLAUDISH_PANE_CWD = savedCwd;
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

describe("pane child wheel acceleration settings", () => {
  function withPaneEnv<T>(marker: string | undefined, cwd: string | undefined, fn: () => T): T {
    const savedMarker = process.env.CLAUDISH_PANE_CHILD;
    const savedCwd = process.env.CLAUDISH_PANE_CWD;
    try {
      if (marker === undefined) delete process.env.CLAUDISH_PANE_CHILD;
      else process.env.CLAUDISH_PANE_CHILD = marker;
      if (cwd === undefined) delete process.env.CLAUDISH_PANE_CWD;
      else process.env.CLAUDISH_PANE_CWD = cwd;
      return fn();
    } finally {
      if (savedMarker === undefined) delete process.env.CLAUDISH_PANE_CHILD;
      else process.env.CLAUDISH_PANE_CHILD = savedMarker;
      if (savedCwd === undefined) delete process.env.CLAUDISH_PANE_CWD;
      else process.env.CLAUDISH_PANE_CWD = savedCwd;
    }
  }

  function mergeWheelSettings(
    user: Record<string, unknown>,
    paneChild: boolean | undefined,
    proxy: boolean,
    form: "inline" | "file"
  ): Record<string, unknown> {
    const dir = mkdtempSync(join(tmpdir(), "claudish-wheel-settings-"));
    try {
      const path = join(dir, "overlay.json");
      const userPath = join(dir, "caller.json");
      writeFileSync(
        path,
        JSON.stringify(buildClaudishSettingsOverlay(statusLine, proxy, paneChild))
      );
      if (form === "file") writeFileSync(userPath, JSON.stringify(user));
      const config = baseConfig({
        claudeArgs: ["--settings", form === "file" ? userPath : JSON.stringify(user)],
      });
      mergeUserSettingsIfPresent(config, path, statusLine, proxy, paneChild);
      expect(config.claudeArgs).toEqual([]);
      return JSON.parse(readFileSync(path, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const proxy of [true, false]) {
    // REQ: 6
    test(`explicit pane child disables acceleration (proxy=${proxy})`, () => {
      withPaneEnv(undefined, undefined, () => {
        expect(buildClaudishSettingsOverlay(statusLine, proxy, true)).toMatchObject({
          wheelScrollAccelerationEnabled: false,
          editorMode: "normal",
          skipDangerousModePermissionPrompt: true,
          statusLine,
        });
      });
    });

    // REQ: 6
    test(`non-pane launches do not acquire the acceleration key (proxy=${proxy})`, () => {
      withPaneEnv("1", "/pane", () => {
        expect(
          Object.hasOwn(
            buildClaudishSettingsOverlay(statusLine, proxy, false),
            "wheelScrollAccelerationEnabled"
          )
        ).toBe(false);
      });
      withPaneEnv(undefined, undefined, () => {
        expect(
          Object.hasOwn(
            buildClaudishSettingsOverlay(statusLine, proxy),
            "wheelScrollAccelerationEnabled"
          )
        ).toBe(false);
      });
    });

    // REQ: 6
    test(`default acceleration gate is the existing marker-and-cwd gate (proxy=${proxy})`, () => {
      for (const marker of ["1", "0", "", undefined]) {
        for (const cwd of ["/pane", "", undefined]) {
          withPaneEnv(marker, cwd, () => {
            const overlay = buildClaudishSettingsOverlay(statusLine, proxy);
            if (marker === "1" && cwd) expect(overlay.wheelScrollAccelerationEnabled).toBe(false);
            else expect(Object.hasOwn(overlay, "wheelScrollAccelerationEnabled")).toBe(false);
          });
        }
      }
    });

    for (const form of ["inline", "file"] as const) {
      for (const userValue of [true, false, undefined]) {
        // REQ: 6
        test(`pane overlay forces false over user ${userValue} in ${form} settings (proxy=${proxy})`, () => {
          withPaneEnv(undefined, undefined, () => {
            const user = {
              ...(userValue === undefined ? {} : { wheelScrollAccelerationEnabled: userValue }),
              unrelated: "preserved",
            };
            expect(mergeWheelSettings(user, true, proxy, form)).toMatchObject({
              wheelScrollAccelerationEnabled: false,
              unrelated: "preserved",
              statusLine,
            });
          });
        });
      }

      // REQ: 6
      test(`non-pane ${form} merge leaves an explicit user acceleration setting alone (proxy=${proxy})`, () => {
        withPaneEnv(undefined, undefined, () => {
          expect(
            mergeWheelSettings({ wheelScrollAccelerationEnabled: true }, false, proxy, form)
              .wheelScrollAccelerationEnabled
          ).toBe(true);
          expect(
            Object.hasOwn(
              mergeWheelSettings({}, false, proxy, form),
              "wheelScrollAccelerationEnabled"
            )
          ).toBe(false);
        });
      });

      // REQ: 6
      test(`merged default gate forces acceleration off only for marker plus cwd in ${form} settings (proxy=${proxy})`, () => {
        withPaneEnv("1", "/pane", () => {
          expect(
            mergeWheelSettings({ wheelScrollAccelerationEnabled: true }, undefined, proxy, form)
              .wheelScrollAccelerationEnabled
          ).toBe(false);
        });
        withPaneEnv("1", undefined, () => {
          expect(
            mergeWheelSettings({ wheelScrollAccelerationEnabled: true }, undefined, proxy, form)
              .wheelScrollAccelerationEnabled
          ).toBe(true);
        });
      });
    }
  }

  // A pane child runs the fullscreen view: the classic view ignores the SGR wheel
  // events scroll_session sends. Launches outside a pane keep the user's `tui`.
  for (const proxy of [true, false]) {
    test(`pane child overlay pins tui to fullscreen (proxy=${proxy})`, () => {
      withPaneEnv(undefined, undefined, () => {
        expect(buildClaudishSettingsOverlay(statusLine, proxy, true).tui).toBe("fullscreen");
      });
    });

    test(`non-pane overlay has no tui key (proxy=${proxy})`, () => {
      withPaneEnv(undefined, undefined, () => {
        expect(Object.hasOwn(buildClaudishSettingsOverlay(statusLine, proxy, false), "tui")).toBe(
          false
        );
      });
    });

    for (const form of ["inline", "file"] as const) {
      for (const userValue of ["default", "fullscreen", undefined]) {
        test(`pane merge forces tui fullscreen over user ${userValue} in ${form} settings (proxy=${proxy})`, () => {
          withPaneEnv(undefined, undefined, () => {
            const user = {
              ...(userValue === undefined ? {} : { tui: userValue }),
              unrelated: "preserved",
            };
            expect(mergeWheelSettings(user, true, proxy, form)).toMatchObject({
              tui: "fullscreen",
              unrelated: "preserved",
              statusLine,
            });
          });
        });
      }

      test(`non-pane ${form} merge leaves the user tui alone (proxy=${proxy})`, () => {
        withPaneEnv(undefined, undefined, () => {
          expect(mergeWheelSettings({ tui: "default" }, false, proxy, form).tui).toBe("default");
          expect(Object.hasOwn(mergeWheelSettings({}, false, proxy, form), "tui")).toBe(false);
        });
      });
    }
  }
});
