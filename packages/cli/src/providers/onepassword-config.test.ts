/**
 * Tests for onepassword-config.ts — scope-aware persistence of the three
 * 1Password config fields (onepasswordAccount, onepassword[],
 * onepasswordEnvironments[]) at global + project scope.
 *
 * Fully hermetic: every function takes an injectable OpConfigPaths, so tests
 * point "global" and "project" at temp files in a fresh mkdtemp dir. No real
 * ~/.claudish/config.json or ./.claudish.json is ever read or written, and the
 * SDK / `op` binary are never touched (this module is config-only).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigInvalidError } from "../auth/accounts/config-lock.js";
import {
  type OpConfigPaths,
  addOnepasswordEnvironment,
  addOnepasswordImport,
  clearOnepasswordAccount,
  listOnepasswordEnvironmentEntries,
  listOnepasswordEnvironments,
  listOnepasswordImportEntries,
  listOnepasswordImports,
  readAllOnepasswordEnvironmentEntries,
  readAllOnepasswordEnvironments,
  readAllOnepasswordImportEntries,
  readOnepasswordAccount,
  readOnepasswordAccountForScope,
  removeOnepasswordEnvironment,
  removeOnepasswordImport,
  saveOnepasswordAccount,
} from "./onepassword-config.js";

let dir: string;
let paths: OpConfigPaths;
let globalPath: string;
let projectPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-opcfg-"));
  globalPath = join(dir, "global-config.json");
  projectPath = join(dir, "project-claudish.json");
  paths = { global: () => globalPath, project: () => projectPath };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Read+parse a temp config file (or {} when absent). */
function read(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("account: save / read / clear", () => {
  test("saves at global scope and reads it back", () => {
    saveOnepasswordAccount("my-team.1password.com", "global", paths);
    expect(read(globalPath).onepasswordAccount).toBe("my-team.1password.com");
    expect(readOnepasswordAccountForScope("global", paths)).toBe("my-team.1password.com");
    // project untouched
    expect(existsSync(projectPath)).toBe(false);
  });

  test("saves at project scope independently of global", () => {
    saveOnepasswordAccount("global-team.1password.com", "global", paths);
    saveOnepasswordAccount("proj-team.1password.com", "project", paths);
    expect(readOnepasswordAccountForScope("global", paths)).toBe("global-team.1password.com");
    expect(readOnepasswordAccountForScope("project", paths)).toBe("proj-team.1password.com");
  });

  test("readOnepasswordAccount prefers project over global (local wins)", () => {
    saveOnepasswordAccount("global-team.1password.com", "global", paths);
    saveOnepasswordAccount("proj-team.1password.com", "project", paths);
    expect(readOnepasswordAccount(paths)).toBe("proj-team.1password.com");
  });

  test("readOnepasswordAccount falls back to global when no project value", () => {
    saveOnepasswordAccount("global-team.1password.com", "global", paths);
    expect(readOnepasswordAccount(paths)).toBe("global-team.1password.com");
  });

  test("readOnepasswordAccount returns undefined when neither set", () => {
    expect(readOnepasswordAccount(paths)).toBeUndefined();
  });

  test("trims the saved value", () => {
    saveOnepasswordAccount("  spaced.1password.com  ", "global", paths);
    expect(read(globalPath).onepasswordAccount).toBe("spaced.1password.com");
  });

  test("clear removes the account at a scope only", () => {
    saveOnepasswordAccount("g.1password.com", "global", paths);
    saveOnepasswordAccount("p.1password.com", "project", paths);
    clearOnepasswordAccount("project", paths);
    expect(readOnepasswordAccountForScope("project", paths)).toBeUndefined();
    expect(readOnepasswordAccountForScope("global", paths)).toBe("g.1password.com");
  });
});

describe("imports: add / list / remove (onepassword[])", () => {
  test("add then list at global scope", () => {
    addOnepasswordImport("op://Vault/Item/API_KEY", "global", paths);
    addOnepasswordImport("op://Vault/Item/*", "global", paths);
    expect(listOnepasswordImports("global", paths)).toEqual([
      "op://Vault/Item/API_KEY",
      "op://Vault/Item/*",
    ]);
  });

  test("add is idempotent (no duplicate)", () => {
    addOnepasswordImport("op://Vault/Item/API_KEY", "global", paths);
    addOnepasswordImport("op://Vault/Item/API_KEY", "global", paths);
    expect(listOnepasswordImports("global", paths)).toEqual(["op://Vault/Item/API_KEY"]);
  });

  test("empty/whitespace entry is a no-op", () => {
    addOnepasswordImport("   ", "global", paths);
    expect(listOnepasswordImports("global", paths)).toEqual([]);
    expect(existsSync(globalPath)).toBe(false);
  });

  test("global and project import lists are independent", () => {
    addOnepasswordImport("op://G/Item/KEY", "global", paths);
    addOnepasswordImport("op://P/Item/KEY", "project", paths);
    expect(listOnepasswordImports("global", paths)).toEqual(["op://G/Item/KEY"]);
    expect(listOnepasswordImports("project", paths)).toEqual(["op://P/Item/KEY"]);
  });

  test("remove drops one entry; key deleted when list empties", () => {
    addOnepasswordImport("op://Vault/Item/A", "global", paths);
    addOnepasswordImport("op://Vault/Item/B", "global", paths);
    removeOnepasswordImport("op://Vault/Item/A", "global", paths);
    expect(listOnepasswordImports("global", paths)).toEqual(["op://Vault/Item/B"]);
    removeOnepasswordImport("op://Vault/Item/B", "global", paths);
    expect(listOnepasswordImports("global", paths)).toEqual([]);
    expect(read(globalPath).onepassword).toBeUndefined();
  });
});

describe("environments: add / list / remove + dedup read", () => {
  test("add then list at project scope", () => {
    addOnepasswordEnvironment("env-abc", "project", paths);
    addOnepasswordEnvironment("env-xyz", "project", paths);
    expect(listOnepasswordEnvironments("project", paths)).toEqual(["env-abc", "env-xyz"]);
  });

  test("remove drops one; key deleted when empty", () => {
    addOnepasswordEnvironment("env-abc", "global", paths);
    removeOnepasswordEnvironment("env-abc", "global", paths);
    expect(listOnepasswordEnvironments("global", paths)).toEqual([]);
    expect(read(globalPath).onepasswordEnvironments).toBeUndefined();
  });

  test("readAllOnepasswordEnvironments: project first, then non-dup globals", () => {
    addOnepasswordEnvironment("shared", "global", paths);
    addOnepasswordEnvironment("global-only", "global", paths);
    addOnepasswordEnvironment("shared", "project", paths);
    addOnepasswordEnvironment("project-only", "project", paths);
    expect(readAllOnepasswordEnvironments(paths)).toEqual([
      "shared",
      "project-only",
      "global-only",
    ]);
  });

  test("readAllOnepasswordEnvironments is empty when nothing set", () => {
    expect(readAllOnepasswordEnvironments(paths)).toEqual([]);
  });
});

describe("account-per-source entries", () => {
  // Regression: declared accounts must use object form without churning undeclared legacy entries.
  test("writes account-declared objects and undeclared bare strings", () => {
    addOnepasswordEnvironment("environment-declared", "global", paths, "a.1password.com");
    addOnepasswordEnvironment("environment-bare", "global", paths);
    addOnepasswordImport("op://Vault/Declared/**", "global", paths, "b.1password.com");
    addOnepasswordImport("op://Vault/Bare/**", "global", paths);

    expect(read(globalPath).onepasswordEnvironments).toEqual([
      { id: "environment-declared", account: "a.1password.com" },
      "environment-bare",
    ]);
    expect(read(globalPath).onepassword).toEqual([
      { ref: "op://Vault/Declared/**", account: "b.1password.com" },
      "op://Vault/Bare/**",
    ]);
    expect(listOnepasswordEnvironmentEntries("global", paths)).toEqual([
      { value: "environment-declared", account: "a.1password.com" },
      { value: "environment-bare" },
    ]);
    expect(listOnepasswordImportEntries("global", paths)).toEqual([
      { value: "op://Vault/Declared/**", account: "b.1password.com" },
      { value: "op://Vault/Bare/**" },
    ]);
  });

  // Regression: a legacy bare source must be upgradable without manual config editing.
  test("upgrades an existing bare value with its newly declared account", () => {
    addOnepasswordEnvironment("environment-id", "global", paths);
    addOnepasswordEnvironment("environment-id", "global", paths, "a.1password.com");
    addOnepasswordImport("op://Vault/Item/**", "global", paths);
    addOnepasswordImport("op://Vault/Item/**", "global", paths, "b.1password.com");

    expect(read(globalPath).onepasswordEnvironments).toEqual([
      { id: "environment-id", account: "a.1password.com" },
    ]);
    expect(read(globalPath).onepassword).toEqual([
      { ref: "op://Vault/Item/**", account: "b.1password.com" },
    ]);
  });

  // Regression: a repeated add must not silently rebind a source to another account.
  test("preserves the first declared account for an existing value", () => {
    addOnepasswordEnvironment("environment-id", "global", paths, "first.1password.com");
    addOnepasswordEnvironment("environment-id", "global", paths, "second.1password.com");
    addOnepasswordImport("op://Vault/Item/**", "global", paths, "first.1password.com");
    addOnepasswordImport("op://Vault/Item/**", "global", paths, "second.1password.com");

    expect(read(globalPath).onepasswordEnvironments).toEqual([
      { id: "environment-id", account: "first.1password.com" },
    ]);
    expect(read(globalPath).onepassword).toEqual([
      { ref: "op://Vault/Item/**", account: "first.1password.com" },
    ]);
  });

  // Regression: this guards against losing account declarations when removing one source.
  test("keeps sibling account-declared objects when removing an unrelated entry", () => {
    writeFileSync(
      globalPath,
      JSON.stringify({
        onepasswordEnvironments: [
          "environment-remove",
          { id: "environment-a", account: "a.1password.com" },
          { id: "environment-b", account: "b.1password.com" },
        ],
        onepassword: [
          "op://Vault/Remove/**",
          { ref: "op://Vault/A/**", account: "a.1password.com" },
          { ref: "op://Vault/B/**", account: "b.1password.com" },
        ],
      }),
      "utf-8"
    );

    removeOnepasswordEnvironment("environment-remove", "global", paths);
    removeOnepasswordImport("op://Vault/Remove/**", "global", paths);

    expect(read(globalPath).onepasswordEnvironments).toEqual([
      { id: "environment-a", account: "a.1password.com" },
      { id: "environment-b", account: "b.1password.com" },
    ]);
    expect(read(globalPath).onepassword).toEqual([
      { ref: "op://Vault/A/**", account: "a.1password.com" },
      { ref: "op://Vault/B/**", account: "b.1password.com" },
    ]);
  });

  // Regression: adding an account declaration must not hide values from legacy string callers.
  test("keeps object-entry values visible through legacy environment readers", () => {
    addOnepasswordEnvironment("global-object", "global", paths, "g.1password.com");
    addOnepasswordEnvironment("shared", "global", paths, "global.1password.com");
    addOnepasswordEnvironment("shared", "project", paths, "project.1password.com");
    addOnepasswordEnvironment("project-object", "project", paths, "p.1password.com");

    expect(listOnepasswordEnvironments("global", paths)).toEqual(["global-object", "shared"]);
    expect(readAllOnepasswordEnvironments(paths)).toEqual([
      "shared",
      "project-object",
      "global-object",
    ]);
  });

  // Regression: global duplicates must not override a project's account binding or read order.
  test("gives project entries precedence and permits project account re-pointing", () => {
    addOnepasswordEnvironment("shared-environment", "global", paths, "global.1password.com");
    addOnepasswordEnvironment("global-environment", "global", paths, "global.1password.com");
    addOnepasswordEnvironment("shared-environment", "project", paths, "project.1password.com");
    addOnepasswordEnvironment("project-environment", "project", paths, "project.1password.com");

    addOnepasswordImport("op://Vault/Shared/**", "global", paths, "global.1password.com");
    addOnepasswordImport("op://Vault/Global/**", "global", paths, "global.1password.com");
    addOnepasswordImport("op://Vault/Shared/**", "project", paths, "project.1password.com");
    addOnepasswordImport("op://Vault/Project/**", "project", paths, "project.1password.com");

    expect(readAllOnepasswordEnvironmentEntries(paths)).toEqual([
      { value: "shared-environment", account: "project.1password.com" },
      { value: "project-environment", account: "project.1password.com" },
      { value: "global-environment", account: "global.1password.com" },
    ]);
    expect(readAllOnepasswordImportEntries(paths)).toEqual([
      { value: "op://Vault/Shared/**", account: "project.1password.com" },
      { value: "op://Vault/Project/**", account: "project.1password.com" },
      { value: "op://Vault/Global/**", account: "global.1password.com" },
    ]);
  });
});

describe("field preservation (raw read-modify-write)", () => {
  test("global write preserves unrelated keys", () => {
    // Seed a config with other fields a user might have.
    writeFileSync(
      globalPath,
      JSON.stringify({
        version: "1.0.0",
        defaultProfile: "default",
        profiles: { default: { name: "default", models: {} } },
        defaultProvider: "openrouter",
        diagMode: "off",
      }),
      "utf-8"
    );
    saveOnepasswordAccount("team.1password.com", "global", paths);
    addOnepasswordImport("op://V/I/KEY", "global", paths);
    const cfg = read(globalPath);
    expect(cfg.onepasswordAccount).toBe("team.1password.com");
    expect(cfg.onepassword).toEqual(["op://V/I/KEY"]);
    // Unrelated fields survive.
    expect(cfg.defaultProvider).toBe("openrouter");
    expect(cfg.diagMode).toBe("off");
    expect(cfg.profiles).toEqual({ default: { name: "default", models: {} } });
  });

  test("project write preserves an account-only file's other keys", () => {
    writeFileSync(
      projectPath,
      JSON.stringify({ onepasswordAccount: "p.1password.com", someTool: { nested: true } }),
      "utf-8"
    );
    addOnepasswordEnvironment("env-1", "project", paths);
    const cfg = read(projectPath);
    expect(cfg.onepasswordAccount).toBe("p.1password.com");
    expect(cfg.onepasswordEnvironments).toEqual(["env-1"]);
    expect(cfg.someTool).toEqual({ nested: true });
  });

  test("garbled global file throws ConfigInvalidError and leaves bytes unchanged", () => {
    writeFileSync(globalPath, "{ not valid json ", "utf-8");
    const originalBytes = readFileSync(globalPath);
    expect(() => addOnepasswordImport("op://V/I/KEY", "global", paths)).toThrow(ConfigInvalidError);
    expect(readFileSync(globalPath)).toEqual(originalBytes);
  });

  test("garbled project file is treated as empty rather than throwing", () => {
    writeFileSync(projectPath, "{ not valid json ", "utf-8");
    expect(() => addOnepasswordImport("op://V/I/KEY", "project", paths)).not.toThrow();
    expect(listOnepasswordImports("project", paths)).toEqual(["op://V/I/KEY"]);
  });

  test("non-string array members are filtered out on read", () => {
    writeFileSync(
      globalPath,
      JSON.stringify({ onepassword: ["op://V/I/A", 42, null, "op://V/I/B"] }),
      "utf-8"
    );
    expect(listOnepasswordImports("global", paths)).toEqual(["op://V/I/A", "op://V/I/B"]);
  });
});
