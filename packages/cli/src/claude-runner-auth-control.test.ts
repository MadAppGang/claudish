import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildAuthControlDeps } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const FILE = import.meta.path;
const TIMEOUT = 20_000;

if (process.env.T4_ISOLATED_FILE !== FILE) {
  test(
    "T4 G1 runs with an isolated HOME and no inherited credentials",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "t4-auth-control-"));
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(ANTHROPIC|CLAUDE|CLAUDISH|OPENAI|OP_)/.test(key)) delete env[key];
      }
      const child = Bun.spawn([process.execPath, "test", FILE], {
        cwd: home,
        env: {
          ...env,
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, "claude"),
          T4_ISOLATED_FILE: FILE,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        console.info(stdout + stderr);
        expect(code).toBe(0);
      } finally {
        child.kill();
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT
  );
} else {
  let childAuthControl: typeof import("./claude-runner.js").childAuthControl;
  let placeholder: string;
  const cwd = join(process.env.HOME!, "project");
  const settingsPath = join(cwd, "auth-settings.json");
  const firstPath = join(cwd, "first-settings.json");
  const token = "OPAQUE_TEST_TOKEN_abc";
  const config = (overrides: Partial<ClaudishConfig> = {}): ClaudishConfig => ({
    autoApprove: false,
    dangerous: false,
    interactive: false,
    debug: false,
    logLevel: "minimal",
    quiet: true,
    jsonOutput: false,
    monitor: false,
    stdin: false,
    noLogs: true,
    diagMode: "off",
    claudeArgs: [],
    advisor: true,
    // A native role mapping forwards real auth rather than a foreign-model placeholder.
    model: "cx@t4-structural-model",
    modelHaiku: "haiku",
    ...overrides,
  });
  const reads = (files: Record<string, unknown> = {}): ChildAuthControlDeps => ({
    cwd,
    home: process.env.HOME!,
    readFile(path) {
      if (!(path in files)) throw new Error("ENOENT");
      return JSON.stringify(files[path]);
    },
  });

  beforeAll(async () => {
    globalThis.fetch = (() => {
      throw new Error("T4 forbids network");
    }) as unknown as typeof fetch;
    ({ childAuthControl, CLAUDISH_PLACEHOLDER_AUTH_TOKEN: placeholder } = await import(
      "./claude-runner.js"
    ));
  });

  describe("G1 childAuthControl — A9 and every forwarded --settings", () => {
    test(
      "native role mapping without another auth source is controlled",
      () => {
        expect(childAuthControl(config(), {}, reads())).toEqual({ controlled: true });
      },
      TIMEOUT
    );

    test(
      "foreign main model without a native mapping is not controlled",
      () => {
        expect(childAuthControl(config({ modelHaiku: undefined }), {}, reads())).toMatchObject({
          controlled: false,
          reason: "proxy-auth",
        });
      },
      TIMEOUT
    );

    test(
      "a forwarded user token is not controlled, even on a native mapping",
      () => {
        const result = childAuthControl(config(), { ANTHROPIC_AUTH_TOKEN: token }, reads());
        expect(result).toMatchObject({ controlled: false, reason: "user-auth-token" });
        expect(JSON.stringify(result)).not.toContain(token);
      },
      TIMEOUT
    );

    test(
      "a claudish placeholder cannot prove the child uses a login",
      () => {
        expect(
          childAuthControl(
            config({ modelHaiku: undefined }),
            {
              ANTHROPIC_AUTH_TOKEN: placeholder,
            },
            reads()
          )
        ).toMatchObject({ controlled: false, reason: "proxy-auth" });
      },
      TIMEOUT
    );

    for (const [label, value, reason] of [
      ["token", { env: { ANTHROPIC_AUTH_TOKEN: token } }, "settings-auth-token"],
      ["apiKeyHelper", { apiKeyHelper: "T4-never-executed-helper" }, "api-key-helper"],
    ] as const) {
      for (const [form, args] of [
        ["two-token path", ["--settings", settingsPath]],
        ["equals path", [`--settings=${settingsPath}`]],
        ["second two-token occurrence", ["--settings", firstPath, "--settings", settingsPath]],
        ["second equals occurrence", ["--settings", firstPath, `--settings=${settingsPath}`]],
        ["inline JSON", ["--settings", JSON.stringify(value)]],
      ] as const) {
        test(
          `${label} through ${form} is not controlled`,
          () => {
            const result = childAuthControl(
              config({ claudeArgs: [...args] }),
              {},
              reads({
                [firstPath]: { permissions: {} },
                [settingsPath]: value,
              })
            );
            expect(result).toMatchObject({ controlled: false, reason });
            expect(JSON.stringify(result)).not.toContain(token);
            expect(JSON.stringify(result)).not.toContain("T4-never-executed-helper");
          },
          TIMEOUT
        );
      }
    }

    test(
      "an unreadable forwarded equals settings file is not controlled",
      () => {
        expect(
          childAuthControl(config({ claudeArgs: [`--settings=${settingsPath}`] }), {}, reads())
        ).toMatchObject({ controlled: false, reason: "settings-unreadable" });
      },
      TIMEOUT
    );

    test(
      "a second unreadable settings file cannot be ignored",
      () => {
        expect(
          childAuthControl(
            config({
              claudeArgs: ["--settings", firstPath, "--settings", settingsPath],
            }),
            {},
            reads({ [firstPath]: {} })
          )
        ).toMatchObject({ controlled: false, reason: "settings-unreadable" });
      },
      TIMEOUT
    );

    for (const path of [
      join(process.env.HOME!, ".claude", "settings.json"),
      join(cwd, ".claude", "settings.json"),
      join(cwd, ".claude", "settings.local.json"),
    ]) {
      test(
        `a settings-supplied token at ${path} prevents the login promise`,
        () => {
          expect(
            childAuthControl(
              config(),
              {},
              reads({
                [path]: {
                  env: { ANTHROPIC_AUTH_TOKEN: token },
                },
              })
            )
          ).toMatchObject({ controlled: false, reason: "settings-auth-token" });
        },
        TIMEOUT
      );
    }
  });
}
