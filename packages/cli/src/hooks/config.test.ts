import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { loadConfig, saveConfig } from "../profile-config.js";
import {
  hooksConfigDir,
  maxConsecutiveInjections,
  parseHooksConfig,
  reportBehaviorBlock,
  reportProjectHooks,
  resetConfigReportersForTests,
  resolveSeverity,
} from "./config.js";

function capture() {
  const lines: string[] = [];
  return { lines, warn: (line: string) => lines.push(line) };
}

afterEach(() => resetConfigReportersForTests());

describe("parseHooksConfig", () => {
  it("accepts the documented shape", () => {
    const sink = capture();
    const parsed = parseHooksConfig(
      {
        modules: ["~/.claudish/hooks/ping.ts", "hooks/add-marker.ts"],
        severity: { "plan-mode/*": "warn", "gpt-5.6-*:plan-mode/plan-file-path": "fix" },
        injection: { maxConsecutive: 5 },
        observer: { enabled: false, mode: "off", timeoutMs: 1500, watchTools: ["Write"] },
        telemetry: { enabled: false },
      },
      sink.warn
    );
    expect(sink.lines).toEqual([]);
    expect(parsed.modules).toEqual(["~/.claudish/hooks/ping.ts", "hooks/add-marker.ts"]);
    expect(maxConsecutiveInjections(parsed)).toBe(5);
  });

  it("treats a missing block as empty with the default injection cap", () => {
    expect(parseHooksConfig(undefined)).toEqual({});
    expect(maxConsecutiveInjections({})).toBe(3);
  });

  it("warns once per issue, prefixed, and degrades an invalid block to {}", () => {
    const sink = capture();
    const parsed = parseHooksConfig(
      {
        modules: "not-an-array",
        severity: { "plan-mode/*": "rewrite-everything" },
        injection: { maxConsecutive: 21 },
      },
      sink.warn
    );
    expect(parsed).toEqual({});
    expect(sink.lines.length).toBe(3);
    for (const line of sink.lines) expect(line.startsWith("hooks config: ")).toBe(true);
    expect(sink.lines.some((l) => l.includes("injection.maxConsecutive"))).toBe(true);
  });

  it("rejects observer mode enforce", () => {
    const sink = capture();
    expect(parseHooksConfig({ observer: { mode: "enforce" } }, sink.warn)).toEqual({});
    expect(sink.lines.length).toBe(1);
  });

  it("bounds maxConsecutive to 1..20", () => {
    const sink = capture();
    expect(parseHooksConfig({ injection: { maxConsecutive: 0 } }, sink.warn)).toEqual({});
    expect(parseHooksConfig({ injection: { maxConsecutive: 1 } }, sink.warn)).toEqual({
      injection: { maxConsecutive: 1 },
    });
    expect(parseHooksConfig({ injection: { maxConsecutive: 20 } }, sink.warn)).toEqual({
      injection: { maxConsecutive: 20 },
    });
  });
});

describe("reportBehaviorBlock", () => {
  it("prints what to change for each key present, once per process", () => {
    const sink = capture();
    expect(
      reportBehaviorBlock(
        { rules: { "plan-mode/*": "off" }, hooks: ["a.ts"], telemetry: { enabled: true } },
        sink.warn
      )
    ).toBe(true);
    const text = sink.lines.join("\n");
    expect(text).toContain("behavior.rules → hooks.severity");
    expect(text).toContain("behavior.hooks → hooks.modules");
    expect(text).toContain("apiVersion: 1");
    expect(text).toContain("consent is NOT carried over");
    expect(text).not.toContain("behavior.preset");

    expect(reportBehaviorBlock({ rules: {} }, sink.warn)).toBe(false);
  });

  it("prints nothing when there is no behavior block", () => {
    const sink = capture();
    expect(reportBehaviorBlock(undefined, sink.warn)).toBe(false);
    expect(sink.lines).toEqual([]);
  });
});

describe("reportProjectHooks", () => {
  it("reports a hooks key in the project file and ignores it", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-hooks-config-"));
    try {
      const path = join(dir, ".claudish.json");
      writeFileSync(path, JSON.stringify({ hooks: { modules: ["evil.ts"] } }));
      const sink = capture();
      expect(reportProjectHooks(path, sink.warn)).toBe(true);
      expect(sink.lines).toEqual([
        `hooks in ${path} ignored: hooks are read from the global config only`,
      ]);
      expect(reportProjectHooks(path, sink.warn)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is silent for a project file without hooks, or none at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-hooks-config-"));
    try {
      const path = join(dir, ".claudish.json");
      const sink = capture();
      expect(reportProjectHooks(path, sink.warn)).toBe(false);
      writeFileSync(path, JSON.stringify({ defaultProvider: "x" }));
      expect(reportProjectHooks(path, sink.warn)).toBe(false);
      expect(sink.lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSeverity", () => {
  it("prefers an exact rule id over a matching glob", () => {
    expect(
      resolveSeverity("plan-mode/plan-file-path", "warn", {
        "plan-mode/*": "off",
        "plan-mode/plan-file-path": "fix",
      })
    ).toBe("fix");
  });

  it("uses the longest matching glob", () => {
    expect(
      resolveSeverity("plan-mode/plan-file-path", "warn", {
        "*": "off",
        "plan-*": "warn",
        "plan-mode/plan-*": "fix",
      })
    ).toBe("fix");
  });

  it("allows a specific rule to be re-enabled inside a disabled namespace", () => {
    const config = {
      "plan-mode/*": "off" as const,
      "plan-mode/plan-file-path": "fix" as const,
    };

    expect(resolveSeverity("plan-mode/other-rule", "warn", config)).toBe("off");
    expect(resolveSeverity("plan-mode/plan-file-path", "warn", config)).toBe("fix");
  });

  it("falls back to the rule's default severity when unconfigured", () => {
    expect(resolveSeverity("plan-mode/plan-file-path", "fix", undefined)).toBe("fix");
    expect(
      resolveSeverity("plan-mode/plan-file-path", "warn", { "other-namespace/*": "off" })
    ).toBe("warn");
  });

  it("uses an unscoped key when no model-scoped key matches", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        {
          "plan-mode/plan-file-path": "fix",
          "other-model:plan-mode/plan-file-path": "off",
        },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("lets a matching model-scoped key beat an unscoped key", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        {
          "plan-mode/plan-file-path": "off",
          "gpt-5.6-sol:plan-mode/plan-file-path": "fix",
        },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("does not apply a model-scoped key to a different model", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        {
          "plan-mode/plan-file-path": "warn",
          "gpt-5.6-sol:plan-mode/plan-file-path": "fix",
        },
        "gpt-5.6-codex"
      )
    ).toBe("warn");
  });

  it("matches model globs", () => {
    expect(
      resolveSeverity(
        "plan-mode/plan-file-path",
        "warn",
        { "gpt-5.6-*:plan-mode/plan-file-path": "fix" },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("prefers an exact rule id over a rule glob in both scope tiers", () => {
    const unscoped = {
      "plan-mode/*": "off" as const,
      "plan-mode/plan-file-path": "fix" as const,
    };
    const scoped = {
      "gpt-5.6-*:plan-mode/*": "off" as const,
      "gpt-5.6-*:plan-mode/plan-file-path": "fix" as const,
    };

    expect(resolveSeverity("plan-mode/plan-file-path", "warn", unscoped, "gpt-5.6-sol")).toBe(
      "fix"
    );
    expect(resolveSeverity("plan-mode/plan-file-path", "warn", scoped, "gpt-5.6-sol")).toBe("fix");
  });

  it("prefers the longer rule glob in both scope tiers", () => {
    const unscoped = {
      "plan-*": "off" as const,
      "plan-mode/plan-*": "fix" as const,
    };
    const scoped = {
      "gpt-5.6-*:plan-*": "off" as const,
      "gpt-5.6-*:plan-mode/plan-*": "fix" as const,
    };

    expect(resolveSeverity("plan-mode/plan-file-path", "warn", unscoped, "gpt-5.6-sol")).toBe(
      "fix"
    );
    expect(resolveSeverity("plan-mode/plan-file-path", "warn", scoped, "gpt-5.6-sol")).toBe("fix");
  });

  it("does not mis-parse a hook rule id as a model scope", () => {
    expect(
      resolveSeverity(
        "hook:my-file/my-rule",
        "warn",
        { "hook:my-file/my-rule": "fix" },
        "gpt-5.6-sol"
      )
    ).toBe("fix");
  });

  it("uses unscoped-only behavior when modelId is omitted", () => {
    expect(
      resolveSeverity("plan-mode/plan-file-path", "off", {
        "plan-mode/plan-file-path": "warn",
        "gpt-5.6-sol:plan-mode/plan-file-path": "fix",
      })
    ).toBe("warn");
  });
});

describe("the hooks key survives loadConfig's allowlist", () => {
  it("round-trips through saveConfig(loadConfig()) and resolves modules against the file's dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-hooks-config-"));
    const file = join(dir, "config.json");
    const hooks = { modules: ["hooks/a.ts"], severity: { "hook:a/*": "warn" } };
    writeFileSync(
      file,
      JSON.stringify({
        version: "1.0.0",
        defaultProfile: "",
        profiles: {},
        hooks,
        behavior: { rules: {} },
      })
    );
    setConfigFileOverride(file);
    try {
      expect(loadConfig().hooks).toEqual(hooks);
      expect(hooksConfigDir()).toBe(dir);
      saveConfig(loadConfig());
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved.hooks).toEqual(hooks);
      // The old block is kept on disk until the user moves it.
      expect(saved.behavior).toEqual({ rules: {} });
    } finally {
      setConfigFileOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
