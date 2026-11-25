/**
 * Where magmux lives, in the three shapes claudish ships in.
 *
 * Extracted from `team-grid.ts` rather than copied, because a second list of
 * places to look is a second thing to forget: `team --grid` and the recovery
 * wrapper must agree about which binary is running, or a machine where one of
 * them finds magmux and the other does not produces a feature that works in
 * one surface and is silently absent from the other.
 */

import { constants, accessSync, existsSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The two file-system calls a PATH walk makes. */
export interface PathLookupFs {
  statSync(path: string): { isFile(): boolean };
  accessSync(path: string, mode: number): void;
}

const NODE_FS: PathLookupFs = { statSync, accessSync };

/** What one PATH walk found: the first executable, nothing, or an error that hid an entry. */
export type PathLookup =
  | { kind: "found"; path: string }
  | { kind: "not-found" }
  | { kind: "error"; code: string; path: string };

/** A candidate that is absent, sits under a non-directory, or cannot be reached: not here. */
const NOT_HERE = new Set(["ENOENT", "ENOTDIR", "EACCES"]);

/**
 * `name` on `pathValue`, walked in process like `which`: the first entry holding an executable
 * regular file wins. An error other than "not here" on an entry is kept and the walk goes on, so
 * a later entry can still answer; only when none does is the lookup reported as failed, since
 * the failing entry may be the one that holds `name`. Empty entries are skipped.
 */
export function lookupOnPath(
  name: string,
  pathValue: string,
  fs: PathLookupFs = NODE_FS
): PathLookup {
  let failure: PathLookup | null = null;
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const at = checkCandidate(join(dir, name), fs);
    if (at.kind === "found") return at;
    if (at.kind === "error") failure ??= at;
  }
  return failure ?? { kind: "not-found" };
}

/** One PATH entry's candidate: an executable regular file, not here, or an error reading it. */
function checkCandidate(candidate: string, fs: PathLookupFs): PathLookup {
  try {
    if (!fs.statSync(candidate).isFile()) return { kind: "not-found" };
    fs.accessSync(candidate, constants.X_OK);
    return { kind: "found", path: candidate };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code && NOT_HERE.has(code)) return { kind: "not-found" };
    return { kind: "error", code: code ?? String(e), path: candidate };
  }
}

/** The magmux binaries found, and why the PATH lookup failed when it did. */
export interface MagmuxCandidates {
  /** every magmux found, in priority order, each path once */
  paths: string[];
  /** `<code> on <path>` when the PATH walk failed and found nothing; null otherwise */
  lookupError: string | null;
}

/**
 * Every magmux binary found, in priority order, each path once:
 *  1. Bundled (`native/magmux-<platform>-<arch>`)
 *  2. The platform-specific npm package (npm installs only the matching one)
 *  3. `magmux` in PATH (e.g. Homebrew)
 *
 * A caller that needs a minimum version walks this list, because the first entry can be a
 * stale bundled copy while a newer one sits on PATH.
 */
export function findMagmuxCandidates(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fs: PathLookupFs = NODE_FS
): MagmuxCandidates {
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

  const onPath = lookupOnPath("magmux", env.PATH ?? "", fs);
  if (onPath.kind === "found") add(onPath.path);

  return {
    paths: found,
    lookupError: onPath.kind === "error" ? `${onPath.code} on ${onPath.path}` : null,
  };
}

/** The first magmux binary found (`findMagmuxCandidates` order), or null. */
export function findMagmuxBinaryOrNull(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fs: PathLookupFs = NODE_FS
): string | null {
  return findMagmuxCandidates(env, fs).paths[0] ?? null;
}

/**
 * The same lookup, but fatal.
 *
 * `team --grid` cannot run at all without magmux, so it wants the throw. The
 * recovery wrapper wants the null: a missing multiplexer there means the
 * session launches exactly as it did before this feature existed, which is the
 * correct degradation and not an error.
 */
export function findMagmuxBinary(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fs: PathLookupFs = NODE_FS
): string {
  const { paths, lookupError } = findMagmuxCandidates(env, fs);
  if (paths[0]) return paths[0];
  if (lookupError) throw new Error(`magmux lookup failed: ${lookupError}`);
  throw new Error("magmux not found. Install it:\n  brew install MadAppGang/tap/magmux");
}
