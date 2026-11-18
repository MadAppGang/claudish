/**
 * Reads test hooks out of test source text, for the guard tests that check each hook passes a
 * timeout above Bun's 5 s default when its body waits longer than that.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The source tree the guard tests scan: `packages/cli/src`. */
export const SRC = join(import.meta.dir, "..");

/** Each `<name>(...)` call in `source`, from its name to its matching closing parenthesis. */
export function hookCalls(source: string, name: string): string[] {
  const calls: string[] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    for (let i = m.index + name.length; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) {
        calls.push(source.slice(m.index, i + 1));
        break;
      }
    }
  }
  return calls;
}

/** The end index (exclusive) of the bracket group that opens at `source[open]`. */
function groupEnd(source: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === left) depth++;
    else if (source[i] === right && --depth === 0) return i + 1;
  }
  return source.length;
}

/**
 * The names of the `function` declarations in `source` whose bodies contain `needle`: a hook
 * that calls one of them waits as long as a hook that calls `needle` itself.
 */
export function localCallersOf(source: string, needle: string): string[] {
  const names: string[] = [];
  const re = /\bfunction\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const paramsEnd = groupEnd(source, m.index + m[0].length - 1, "(", ")");
    const open = source.indexOf("{", paramsEnd);
    if (open < 0) continue;
    const body = source.slice(open, groupEnd(source, open, "{", "}"));
    if (body.includes(needle) && m[1]) names.push(m[1]);
  }
  return names;
}

/**
 * Every `<name>(...)` hook under `SRC` that calls `needle`, directly or through a function
 * declared in the same file (`localCallersOf`), with its file.
 */
export function hooksCalling(
  names: readonly string[],
  needle: string
): { file: string; call: string }[] {
  const files = [...new Bun.Glob("**/*.test.ts").scanSync(SRC)];
  return files.flatMap((file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    const needles = [needle, ...localCallersOf(source, needle).map((n) => `${n}(`)];
    return names.flatMap((name) =>
      hookCalls(source, name)
        .filter((call) => needles.some((n) => call.includes(n)))
        .map((call) => ({ file, call }))
    );
  });
}

/** The files of the hooks whose last argument is not `constant`. */
export function hooksWithout(hooks: { file: string; call: string }[], constant: string): string[] {
  const last = new RegExp(`,\\s*${constant}\\s*\\)$`);
  return hooks.filter(({ call }) => !last.test(call)).map(({ file }) => file);
}
