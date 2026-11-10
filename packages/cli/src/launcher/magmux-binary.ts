/**
 * Where magmux lives, in the three shapes claudish ships in.
 *
 * Extracted from `team-grid.ts` rather than copied, because a second list of
 * places to look is a second thing to forget: `team --grid` and the recovery
 * wrapper must agree about which binary is running, or a machine where one of
 * them finds magmux and the other does not produces a feature that works in
 * one surface and is silently absent from the other.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every magmux binary found, in priority order, each path once:
 *  1. Bundled (`native/magmux-<platform>-<arch>`)
 *  2. The platform-specific npm package (npm installs only the matching one)
 *  3. `magmux` in PATH (e.g. Homebrew)
 *
 * A caller that needs a minimum version walks this list, because the first entry can be a
 * stale bundled copy while a newer one sits on PATH.
 */
export function findMagmuxCandidates(): string[] {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  // `launcher/` is one level below `src/`, which is itself below the package
  // root — so two levels up from here is where `native/` sits in a build.
  const pkgRoots = [join(thisDir, ".."), join(thisDir, "..", "..")];
  const platform = process.platform;
  const arch = process.arch;
  const found: string[] = [];
  const add = (path: string) => {
    if (!found.includes(path)) found.push(path);
  };

  for (const pkgRoot of pkgRoots) {
    const bundled = join(pkgRoot, "native", `magmux-${platform}-${arch}`);
    if (existsSync(bundled)) add(bundled);
  }

  try {
    const pkgName = `@claudish/magmux-${platform}-${arch}`;
    let searchDir = pkgRoots[0] as string;
    for (let i = 0; i < 5; i++) {
      const candidate = join(searchDir, "node_modules", pkgName, "bin", "magmux");
      if (existsSync(candidate)) {
        add(candidate);
        break;
      }
      const parent = dirname(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }
  } catch {
    /* not installed */
  }

  try {
    const result = execSync("which magmux", { encoding: "utf-8" }).trim();
    if (result) add(result);
  } catch {
    /* not in PATH */
  }

  return found;
}

/** The first magmux binary found (`findMagmuxCandidates` order), or null. */
export function findMagmuxBinaryOrNull(): string | null {
  return findMagmuxCandidates()[0] ?? null;
}

/**
 * The same lookup, but fatal.
 *
 * `team --grid` cannot run at all without magmux, so it wants the throw. The
 * recovery wrapper wants the null: a missing multiplexer there means the
 * session launches exactly as it did before this feature existed, which is the
 * correct degradation and not an error.
 */
export function findMagmuxBinary(): string {
  const found = findMagmuxBinaryOrNull();
  if (found) return found;
  throw new Error("magmux not found. Install it:\n  brew install MadAppGang/tap/magmux");
}
