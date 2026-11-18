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

/** Every `<name>(...)` hook under `SRC` whose text contains `needle`, with its file. */
export function hooksCalling(
  names: readonly string[],
  needle: string
): { file: string; call: string }[] {
  const files = [...new Bun.Glob("**/*.test.ts").scanSync(SRC)];
  return files.flatMap((file) => {
    const source = readFileSync(join(SRC, file), "utf8");
    return names.flatMap((name) =>
      hookCalls(source, name)
        .filter((call) => call.includes(needle))
        .map((call) => ({ file, call }))
    );
  });
}

/** The files of the hooks whose last argument is not `constant`. */
export function hooksWithout(hooks: { file: string; call: string }[], constant: string): string[] {
  const last = new RegExp(`,\\s*${constant}\\s*\\)$`);
  return hooks.filter(({ call }) => !last.test(call)).map(({ file }) => file);
}
