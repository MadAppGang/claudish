/**
 * `claudish herdr rows`: the Agent sidebar rows that show a claudish viewer's model, activity and
 * token counts. Printed for the user to paste into their own herdr `config.toml`; claudish never
 * writes that file.
 *
 * `claudish herdr install-app-mod`: copies the Herdr.app mod this claudish was built with into
 * `<Herdr.app home>/mods/claudish/` (`$HERDR_APP_HOME`, else `~/.config/herdr-app`). Each file is
 * written under a hidden name and renamed, so Herdr, which reloads a mod on every save and skips
 * hidden files, never loads half a file.
 *
 * herdr applies `rows_by_agent` only to its own canonical agent ids, never to a reported agent such
 * as `claudish`, so the rows go into the global `ui.sidebar.agents.rows`. A `$name` token a pane
 * does not report disappears with its separator, so other agents' rows are unchanged.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SIDEBAR_TOKENS } from "./state-map.js";

const USAGE = [
  "usage: claudish herdr rows",
  "       claudish herdr install-app-mod [--from <dir>]",
  "",
  "  rows             print herdr Agent sidebar rows showing each claudish viewer's model,",
  "                   activity and tokens; paste them into herdr's config.toml (claudish does",
  "                   not edit it)",
  "  install-app-mod  copy the claudish mod into Herdr.app's mods/claudish/ ($HERDR_APP_HOME,",
  "                   else ~/.config/herdr-app); --from names another built mod folder",
  "",
].join("\n");

export const APP_MOD_NAME = "claudish";
/** where the build leaves the mod, relative to the package root */
const BUILT_MOD_DIR = join("herdr-app-mod", APP_MOD_NAME);

export interface HerdrCliDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** the folder holding the built mod; default: searched upward from this module */
  modSource?: string;
  err?: (s: string) => void;
}

/** The built mod beside this claudish: `<package>/herdr-app-mod/claudish`, from src/ or dist/. */
export function findBuiltAppMod(from: string = import.meta.dir): string | null {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, BUILT_MOD_DIR);
    if (existsSync(join(candidate, "main.js")) && existsSync(join(candidate, "mod.json")))
      return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Herdr.app's home folder: `$HERDR_APP_HOME`, else `~/.config/herdr-app`. */
export function herdrAppHome(env: Readonly<Record<string, string | undefined>>): string {
  const given = env.HERDR_APP_HOME?.trim();
  if (given) return resolve(given);
  return join(env.HOME?.trim() || homedir(), ".config", "herdr-app");
}

/**
 * A file of the mod itself. Herdr writes `jsconfig.json` and the `.d.ts` files into a mod folder
 * on its own (`herdr-app check` does too), so those are never copied; hidden files neither.
 */
function isModFile(name: string): boolean {
  return !name.startsWith(".") && name !== "jsconfig.json" && !name.endsWith(".d.ts");
}

/** Copy the mod; returns the folder it now lives in. Throws with a sentence for the user. */
export function installAppMod(source: string, appHome: string): string {
  if (!existsSync(join(source, "main.js")) || !existsSync(join(source, "mod.json")))
    throw new Error(`${source} holds no built mod (main.js and mod.json); run \`bun run build\``);
  if (!existsSync(appHome) || !statSync(appHome).isDirectory())
    throw new Error(
      `${appHome} does not exist: start Herdr.app once so it creates its home, then run this again`
    );
  const dest = join(appHome, "mods", APP_MOD_NAME);
  mkdirSync(dest, { recursive: true });
  const files = readdirSync(source).filter(
    (f) => isModFile(f) && statSync(join(source, f)).isFile()
  );
  // mod.json first: a reload triggered by main.js then sees the final manifest
  files.sort((a, b) => (a === "mod.json" ? -1 : b === "mod.json" ? 1 : a.localeCompare(b)));
  for (const f of files) {
    const hidden = join(dest, `.${f}.installing`);
    copyFileSync(join(source, f), hidden);
    renameSync(hidden, join(dest, f));
  }
  return dest;
}

function installCommand(rest: string[], out: (s: string) => void, deps: HerdrCliDeps): number {
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  let from: string | undefined;
  if (rest[0] === "--from" && rest[1] && rest.length === 2) from = resolve(rest[1]);
  else if (rest.length > 0) {
    err(USAGE);
    return 2;
  }
  const source = from ?? deps.modSource ?? findBuiltAppMod();
  if (!source) {
    err("claudish herdr install-app-mod: this claudish was installed without the Herdr.app mod\n");
    return 1;
  }
  try {
    const dest = installAppMod(source, herdrAppHome(deps.env ?? process.env));
    out(`installed the claudish mod in ${dest}\ncheck it with: herdr-app check ${dest}\n`);
    return 0;
  } catch (e) {
    err(`claudish herdr install-app-mod: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/** The TOML block, the default rows of herdr 0.9.5 plus one row of claudish tokens. */
export function sidebarRowsToml(): string {
  const tokens = SIDEBAR_TOKENS.map((t) => `"$${t}"`).join(", ");
  return [
    "[ui.sidebar.agents]",
    "rows = [",
    '  ["state_icon", "machine", "workspace", "tab"],',
    '  ["agent"],',
    `  [${tokens}],`,
    "]",
    "",
  ].join("\n");
}

export function herdrCommand(
  args: string[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  deps: HerdrCliDeps = {}
): number {
  const [sub, ...rest] = args;
  if (sub === "rows" && rest.length === 0) {
    out(sidebarRowsToml());
    return 0;
  }
  if (sub === "install-app-mod") return installCommand(rest, out, deps);
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    out(USAGE);
    return sub === undefined ? 2 : 0;
  }
  process.stderr.write(USAGE);
  return 2;
}
