import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HOOK_API_VERSION, act, defineHook } from "./public.js";

describe("claudish/hooks public exports", () => {
  it("is version 1", () => {
    expect(HOOK_API_VERSION).toBe(1);
  });

  it("defineHook is the identity", () => {
    const hook = { apiVersion: 1, id: "x", on: { request: () => [] } } as const;
    expect(defineHook(hook)).toBe(hook);
  });

  it("act constructors equal the object literals", () => {
    expect(act.injectSystemNote("n")).toEqual({ type: "injectSystemNote", text: "n" });
    expect(act.appendUserText("u")).toEqual({ type: "appendUserText", text: "u" });
    expect(act.replaceMessageText("a", "b")).toEqual({
      type: "replaceMessageText",
      find: "a",
      replace: "b",
    });
    expect(
      act.replaceMessageText("a", "b", { regex: true, flags: "gi", roles: ["assistant"] })
    ).toEqual({
      type: "replaceMessageText",
      find: "a",
      replace: "b",
      regex: true,
      flags: "gi",
      roles: ["assistant"],
    });
    expect(act.removeMessageText("a")).toEqual({ type: "removeMessageText", find: "a" });
    expect(act.rewriteToolDescription("T", " x")).toEqual({
      type: "rewriteToolDescription",
      tool: "T",
      append: " x",
    });
    expect(act.replaceToolDescription("T", "d")).toEqual({
      type: "replaceToolDescription",
      tool: "T",
      description: "d",
    });
    expect(act.replaceToolSchema("T", { type: "object" })).toEqual({
      type: "replaceToolSchema",
      tool: "T",
      inputSchema: { type: "object" },
    });
    expect(act.removeTool("T")).toEqual({ type: "removeTool", tool: "T" });
    expect(act.repairToolArgs({ a: 1 }, "r")).toEqual({
      type: "repairToolArgs",
      args: { a: 1 },
      reason: "r",
    });
    expect(act.appendText("t")).toEqual({ type: "appendText", text: "t" });
    expect(act.prependText("t")).toEqual({ type: "prependText", text: "t" });
    expect(act.replaceText("a", "b", { regex: true })).toEqual({
      type: "replaceText",
      find: "a",
      replace: "b",
      regex: true,
    });
    expect(act.removeText("a")).toEqual({ type: "removeText", find: "a" });
    expect(act.injectUserTurn("go")).toEqual({ type: "injectUserTurn", text: "go" });
    expect(act.annotateTurn("k", { v: [1] })).toEqual({
      type: "annotateTurn",
      key: "k",
      value: { v: [1] },
    });
    expect(act.warn("w")).toEqual({ type: "warn", message: "w" });
  });
});

/** Every .ts file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

const IMPORT =
  /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(IMPORT)].map((m) => (m[1] ?? m[2]) as string);
}

describe("module boundaries", () => {
  const hooksDir = import.meta.dir;

  it("public.ts imports nothing", () => {
    expect(importsOf(join(hooksDir, "public.ts"))).toEqual([]);
  });

  it("nothing under hooks/ imports behavior/ or middleware/", () => {
    const offenders = sources(hooksDir).flatMap((file) =>
      importsOf(file)
        .filter((spec) => /(^|\/)(behavior|middleware)\//.test(spec))
        .map((spec) => `${relative(hooksDir, file)} → ${spec}`)
    );
    expect(offenders).toEqual([]);
  });

  it("the import scanner sees a real import (control)", () => {
    expect(importsOf(join(hooksDir, "engine.ts"))).toContain("./actions.js");
  });
});
