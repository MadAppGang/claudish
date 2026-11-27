/**
 * The caller's project settings, carried into a `create_session` child that runs
 * in another directory (MTL-185, claudish#284).
 *
 * Claude Code reads project-scope settings only from `<cwd>/.claude/`, and a child
 * started in `work_dir` has that as its cwd, so every plugin the caller's project
 * enables is off in the child. The layer built here is handed to the child as ONE
 * `--settings` value: Claude Code keeps only the LAST `--settings`, so a second one
 * would replace either this layer or claudish's own overlay. See
 * ai-docs/architecture/mcp-sessions.md § A work_dir child inherits the caller's
 * settings layer.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { claudeCodeGlobalConfigPath } from "../auth/claude-code-facts.js";
import {
  type SettingSource,
  enabledSettingSources,
  localSettingsFiles,
  mainCheckoutRoot,
  managedSettingsPath,
  userSettingsFile,
} from "../claude-runner.js";
import { log } from "../logger.js";

type SettingsLayer = Record<string, unknown>;

/**
 * A path's kind with only a REGULAR file counted as a file (symlinks followed). A named
 * pipe, socket or device is undefined, so it is never read: a synchronous read of a pipe
 * with no writer blocks the whole MCP server. Claude Code skips such config files too.
 */
function regularPathKind(path: string): "dir" | "file" | undefined {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return "dir";
    return stat.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

function isRegularFile(path: string): boolean {
  return regularPathKind(path) === "file";
}

/** Claude Code's server-name syntax for the string form of a server list. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * `layer` with a string `enabledMcpjsonServers` / `disabledMcpjsonServers` turned into a
 * one-name list, as Claude Code reads a user, project, local or `--settings` source (never
 * a managed one). A string outside {@link SERVER_NAME} is left as it is.
 */
function withServerListsAsArrays(layer: SettingsLayer): SettingsLayer {
  for (const key of ["enabledMcpjsonServers", "disabledMcpjsonServers"]) {
    const value = layer[key];
    if (typeof value === "string" && SERVER_NAME.test(value)) layer[key] = [value];
  }
  return layer;
}

function isPlainObject(value: unknown): value is SettingsLayer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `values` with repeats removed, the first occurrence kept, compared by JSON value. */
function uniqueByJson(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deep-merge two settings layers the way Claude Code merges settings sources:
 * plain objects merge recursively; arrays concatenate with duplicates removed
 * (first occurrence kept, compared by JSON value); any other value: `over` wins.
 * Neither input is mutated.
 */
export function mergeSettingsLayers(base: SettingsLayer, over: SettingsLayer): SettingsLayer {
  const merged: SettingsLayer = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeSettingsLayers(current, value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      merged[key] = uniqueByJson([...current, ...structuredClone(value)]);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

/**
 * One layer's JSON object; anything else is `invalid_args` naming `source`. The parser's
 * own message is left out: it quotes the token it rejected, which can be a credential.
 */
function parseLayer(text: string, source: string): SettingsLayer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid_args: settings ${source} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`invalid_args: settings ${source} is not a JSON object`);
  }
  return parsed;
}

/**
 * A `--settings` value: inline JSON when it starts with `{`, else a file path. Inline JSON
 * is named only as "inline --settings value": the value itself can hold a credential.
 */
function readSettingsValue(value: string): SettingsLayer {
  if (value.trim().startsWith("{")) return parseLayer(value, "inline --settings value");
  if (regularPathKind(value) === undefined && existsSync(value)) {
    throw new Error(`invalid_args: settings ${value} cannot be read (not a regular file)`);
  }
  let text: string;
  try {
    text = readFileSync(value, "utf-8");
  } catch (err) {
    throw new Error(`invalid_args: settings ${value} cannot be read (${(err as Error).message})`);
  }
  return parseLayer(text, value);
}

/** What {@link buildInheritedSettingsLayer} needs beyond setupFrom and the flags. */
export interface InheritedSettingsOptions {
  /**
   * The setting sources the child loads (`enabledSettingSources` of the caller's flags);
   * null or absent loads them all. Without `project` setupFrom's `settings.json` is not
   * read, without `local` no `settings.local.json` is: the child would not read them either.
   */
  settingSources?: ReadonlySet<SettingSource> | null;
}

/**
 * The layer a child in another directory needs to see the caller's project setup.
 * setupFrom is taken by its real path. Reads `<setupFrom>/.claude/settings.json`, then the
 * local settings files Claude Code reads for a launch from setupFrom: the main checkout's
 * `.claude/settings.local.json` (for a linked worktree or a subdirectory) and
 * `<setupFrom>/.claude/settings.local.json` (a missing or non-regular file is skipped),
 * each only when `options.settingSources` loads its tier, then folds EVERY `--settings`
 * value found in `callerFlags` on top, in order. Both forms count: `--settings <v>` and
 * `--settings=<v>`. A string server list in any of them is read as a one-name list.
 *
 * `permissions.additionalDirectories` is removed from the result: it is `--add-dir` in
 * settings form and would widen the child's file access beyond work_dir.
 *
 * `restFlags` is `callerFlags` with every `--settings` token (and its value) removed.
 * `layer` is null when no settings file is read and no `--settings` was given.
 * A source that is not a JSON object throws `invalid_args:` naming it. Never writes.
 */
export function buildInheritedSettingsLayer(
  setupFrom: string,
  callerFlags: readonly string[],
  options: InheritedSettingsOptions = {}
): { layer: SettingsLayer | null; restFlags: string[] } {
  const layers = settingsFilesFor(realOrResolved(setupFrom), options.settingSources ?? null)
    .filter(isRegularFile)
    .map((file) => withServerListsAsArrays(parseLayer(readText(file), file)));

  const restFlags: string[] = [];
  for (let i = 0; i < callerFlags.length; i++) {
    const flag = callerFlags[i];
    if (flag === "--settings") {
      const value = callerFlags[i + 1];
      if (value === undefined) throw new Error("invalid_args: --settings needs a value");
      layers.push(withServerListsAsArrays(readSettingsValue(value)));
      i++;
    } else if (flag.startsWith("--settings=")) {
      layers.push(withServerListsAsArrays(readSettingsValue(flag.slice("--settings=".length))));
    } else {
      restFlags.push(flag);
    }
  }

  if (layers.length === 0) return { layer: null, restFlags };
  const layer = layers.reduce((acc, next) => mergeSettingsLayers(acc, next), {});
  if (isPlainObject(layer.permissions)) delete layer.permissions.additionalDirectories;
  return { layer, restFlags };
}

/**
 * The project and local settings files of a launch from `setupReal`, in merge order, each
 * only when `sources` (null: all) loads its tier.
 */
function settingsFilesFor(setupReal: string, sources: ReadonlySet<SettingSource> | null): string[] {
  const loads = (source: SettingSource) => sources === null || sources.has(source);
  return [
    ...(loads("project") ? [join(setupReal, ".claude", "settings.json")] : []),
    ...(loads("local")
      ? localSettingsFiles(setupReal, readText, regularPathKind).map(([file]) => file)
      : []),
  ];
}

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

/**
 * `path`'s realpath. A path that does not exist is the realpath of its nearest existing
 * ancestor plus the remaining segments, so a symlink above it is still followed.
 */
export function realOrResolved(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `path` is `parent` or a descendant of it, compared by path segment on
 * realpaths ({@link realOrResolved}): `/a/bc` is not within `/a/b`.
 */
export function isWithin(path: string, parent: string): boolean {
  const rel = relative(realOrResolved(parent), realOrResolved(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * `value` as pretty JSON at `path`, mode 0600 whether or not the file existed: `mode`
 * applies only when a file is created, so an existing file is narrowed BEFORE the write
 * and the content never lands in a wider file.
 */
export function writePrivateJson(path: string, value: unknown): void {
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** The MCP server file a child is handed with `--mcp-config`. */
export interface InheritedMcpConfig {
  mcpServers: Record<string, unknown>;
}

/** The largest `.mcp.json` Claude Code reads, in bytes; a larger one is skipped unread. */
const MCP_JSON_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A `.mcp.json`'s servers, or null when Claude Code would skip the file: larger than
 * {@link MCP_JSON_MAX_BYTES} (decided from its size, before any byte is read), unreadable,
 * not JSON, not a JSON object, or `mcpServers` not a JSON object. A skipped file gets a log
 * line naming only its path: the parser's message quotes the token it rejected, which can
 * be a header value or a key. A blank or whitespace-only file is no servers, as Claude Code
 * reads a blank project `.mcp.json`.
 */
function readMcpJson(file: string): SettingsLayer | null {
  let text: string;
  try {
    if (statSync(file).size > MCP_JSON_MAX_BYTES) {
      log(`[mcp-session] MCP config skipped: ${file} is larger than ${MCP_JSON_MAX_BYTES} bytes`);
      return null;
    }
    text = readText(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log(`[mcp-session] MCP config skipped: ${file} cannot be read${code ? ` (${code})` : ""}`);
    return null;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log(`[mcp-session] MCP config skipped: ${file} is not valid JSON`);
    return null;
  }
  const servers = isPlainObject(parsed) ? (parsed.mcpServers ?? {}) : undefined;
  if (!isPlainObject(servers)) {
    log(`[mcp-session] MCP config skipped: ${file} is not {"mcpServers": {...}} JSON`);
    return null;
  }
  return servers;
}

/** The folder name Claude Code saves claude.ai connector files under. */
const CONNECTOR_DOWNLOADS = "connector-downloads";
const CONNECTOR_DOWNLOADS_NAME = /^connector-downloads[. ]*(?::.*)?$/;
const INVISIBLE_FORMAT_CHARS = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * Whether a path segment is a connector-downloads folder name as Claude Code compares it:
 * lower-cased, a long s read as `s`, invisible format characters dropped, then trailing
 * dots or spaces and a `:stream` suffix allowed.
 */
function isConnectorDownloadsName(segment: string): boolean {
  const folded = segment.toLowerCase().replaceAll("ſ", "s").replace(INVISIBLE_FORMAT_CHARS, "");
  return segment.length >= CONNECTOR_DOWNLOADS.length && CONNECTOR_DOWNLOADS_NAME.test(folded);
}

/** Whether `dir` is a connector-downloads folder or lies inside one. */
function inConnectorDownloads(dir: string): boolean {
  return dir.split(/[\\/]/).some(isConnectorDownloadsName);
}

/**
 * The folders Claude Code saves browser downloads under. It never reads a `.mcp.json` in
 * one of them or below, compared on the path as written.
 */
const BROWSER_DOWNLOADS_ROOTS = [
  "/mnt/user-data/browser-downloads",
  "/mnt/user-data/desktop-browser-downloads",
];

/** Whether `dir` is a browser-downloads root or lies inside one. */
function inBrowserDownloads(dir: string): boolean {
  return BROWSER_DOWNLOADS_ROOTS.some((root) => dir === root || dir.startsWith(`${root}/`));
}

/** The Linux autofs superblock magic (`AUTOFS_SUPER_MAGIC`). */
const AUTOFS_SUPER_MAGIC = 0x0187;

/**
 * Whether Claude Code treats `dir` as an automount map root, whose `.mcp.json` it never
 * reads: a path listed in `env.CLAUDE_CODE_AUTOMOUNT_ROOTS` (absolute entries separated by
 * the path delimiter), or on Linux a folder directly under `/` whose file system is autofs.
 * A lookup inside such a folder can trigger a mount.
 */
export function isAutofsMapRoot(
  dir: string,
  env: Record<string, string | undefined>,
  platform: string = process.platform,
  statfs: (path: string) => { type: number } = statfsSync
): boolean {
  const listed = env.CLAUDE_CODE_AUTOMOUNT_ROOTS?.split(delimiter).some(
    (root) => isAbsolute(root) && resolve(root) === dir
  );
  if (listed) return true;
  if (platform !== "linux" || dir === "/" || dirname(dir) !== "/") return false;
  try {
    return statfs(dir).type === AUTOFS_SUPER_MAGIC;
  } catch {
    return false;
  }
}

/** How {@link mcpJsonWalkDirs} walks. */
export interface McpJsonWalk {
  /** The folder the walk stops before; the file system root of the start by default. */
  root?: string;
  /** The child's environment (`CLAUDE_CODE_AUTOMOUNT_ROOTS`). */
  env: Record<string, string | undefined>;
}

/**
 * The folders whose `.mcp.json` Claude Code reads when started in `start`, nearest first:
 * every folder walking up from `start`, stopping BEFORE the root (the root's own
 * `.mcp.json` is never read), minus a folder in a connector-downloads folder, a folder at
 * or under a browser-downloads root, and an automount map root ({@link isAutofsMapRoot}).
 */
export function mcpJsonWalkDirs(start: string, walk: McpJsonWalk): string[] {
  let current = resolve(start);
  const root = walk.root === undefined ? parse(current).root : resolve(walk.root);
  const dirs: string[] = [];
  while (current !== root) {
    const skipped =
      inConnectorDownloads(current) ||
      inBrowserDownloads(current) ||
      isAutofsMapRoot(current, walk.env);
    if (!skipped) dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/**
 * The project servers Claude Code sees when started in `setupReal` that a child started in
 * `childReal` does not find itself: the regular `.mcp.json` of every folder of
 * {@link mcpJsonWalkDirs} except one holding `childReal` (the child's own walk-up reads that
 * file, under its own disabled lists), merged so the nearest file wins a name clash. A file
 * Claude Code would skip is skipped ({@link readMcpJson}).
 */
function walkUpMcpJsonServers(
  setupReal: string,
  childReal: string,
  env: Record<string, string | undefined>
): SettingsLayer {
  const files = mcpJsonWalkDirs(setupReal, { env })
    .filter((dir) => !isWithin(childReal, dir))
    .map((dir) => join(dir, ".mcp.json"))
    .filter(isRegularFile);
  const servers: SettingsLayer = {};
  for (const file of files.reverse()) Object.assign(servers, readMcpJson(file) ?? {});
  return servers;
}

/**
 * The project entry of Claude Code's global config (`.claude.json`) for `projectKey`, or
 * null. The file is `claudeCodeGlobalConfigPath(env, cwd)`: a relative `CLAUDE_CONFIG_DIR`
 * resolves against `cwd`, the child's cwd. A missing or non-regular file is null; an
 * unreadable or malformed one is null with a log line naming only the path (its values can
 * hold credentials).
 */
function globalConfigProjectEntry(
  env: Record<string, string | undefined>,
  projectKey: string,
  cwd: string
): SettingsLayer | null {
  const file = claudeCodeGlobalConfigPath(env, cwd);
  if (!isRegularFile(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(file));
  } catch {
    log(`[mcp-session] local-scope MCP servers skipped: ${file} is unreadable or not valid JSON`);
    return null;
  }
  const projects = isPlainObject(parsed) ? parsed.projects : undefined;
  const entry = isPlainObject(projects) ? projects[projectKey] : undefined;
  return isPlainObject(entry) ? entry : null;
}

/**
 * A `disabledMcpjsonServers` value as names. An array keeps its strings. A string naming
 * one server ({@link SERVER_NAME}) is a one-name list where `acceptString` holds: Claude
 * Code reads that form from every source except managed settings.
 */
function serverNameList(value: unknown, acceptString: boolean): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return acceptString && typeof value === "string" && SERVER_NAME.test(value) ? [value] : [];
}

/**
 * A settings file's `disabledMcpjsonServers`. A missing or non-regular file is empty; an
 * unreadable or malformed one is empty with a log line naming only the path.
 */
function disabledListOf(file: string, acceptString: boolean): string[] {
  if (!isRegularFile(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readText(file));
    return isPlainObject(parsed) ? serverNameList(parsed.disabledMcpjsonServers, acceptString) : [];
  } catch {
    log(`[mcp-session] disabledMcpjsonServers not read: ${file} is unreadable or not valid JSON`);
    return [];
  }
}

/**
 * The managed `disabledMcpjsonServers`: the base file, then every drop-in in `dropInDir`
 * whose name ends in `.json` and does not start with `.`, in sorted name order, as Claude
 * Code reads them. Claude Code concatenates arrays across those files, so the lists add up.
 */
function managedDisabledList(file: string | undefined, dropInDir: string | undefined): string[] {
  const files = file ? [file] : [];
  if (dropInDir && regularPathKind(dropInDir) === "dir") {
    let names: string[] = [];
    try {
      names = readdirSync(dropInDir);
    } catch {
      log(`[mcp-session] managed drop-ins not read: ${dropInDir} cannot be listed`);
    }
    const dropIns = names.filter((name) => name.endsWith(".json") && !name.startsWith("."));
    files.push(...dropIns.sort().map((name) => join(dropInDir, name)));
  }
  return files.flatMap((path) => disabledListOf(path, false));
}

/**
 * A server name as Claude Code compares it against a disabled list: every character outside
 * `[A-Za-z0-9_-]` becomes `_`. A `plugin:` name only ever matches exactly.
 */
function comparableServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isDisabledBy(name: string, disabled: readonly string[]): boolean {
  return disabled.some(
    (entry) =>
      entry === name ||
      (!entry.startsWith("plugin:") &&
        !name.startsWith("plugin:") &&
        comparableServerName(entry) === comparableServerName(name))
  );
}

/** Claude Code's managed (enterprise) files, read only. */
export interface ManagedPaths {
  /** `managed-settings.json`, whose `disabledMcpjsonServers` always applies. */
  managedSettingsFile: string;
  /** `managed-settings.d`, the drop-ins merged after the base file. */
  managedSettingsDropInDir: string;
  /**
   * `managed-mcp.json`. While it exists Claude Code refuses any `--mcp-config` server
   * ("You cannot dynamically configure MCP servers when an enterprise MCP config is
   * present"), so nothing is handed over.
   */
  managedMcpFile: string;
}

/**
 * The managed files on this machine: all three live in the directory of
 * `managedSettingsPath()` (macOS `/Library/Application Support/ClaudeCode`, Linux
 * `/etc/claude-code`).
 */
export function realManagedPaths(): ManagedPaths {
  const managedSettingsFile = managedSettingsPath();
  const dir = dirname(managedSettingsFile);
  return {
    managedSettingsFile,
    managedSettingsDropInDir: join(dir, "managed-settings.d"),
    managedMcpFile: join(dir, "managed-mcp.json"),
  };
}

/**
 * Whether `file` (`managed-mcp.json`) exists, with a log line naming it when it does: Claude
 * Code then refuses any `--mcp-config` server.
 */
function managedMcpPresent(file: string | undefined): boolean {
  if (!file || !existsSync(file)) return false;
  log(
    `[mcp-session] no MCP server handed over: ${file} is present, and Claude Code refuses --mcp-config while it is`
  );
  return true;
}

/** The real main checkout holding `dir` (`.git` files read only when regular), else `dir`. */
function mainCheckoutKey(dir: string): string {
  return realOrResolved(mainCheckoutRoot(dir, readText, regularPathKind) ?? dir);
}

/** What {@link buildInheritedMcpConfig} needs beyond the two directories. */
export interface InheritedMcpOptions extends Partial<ManagedPaths> {
  /**
   * The setting sources the child loads (`enabledSettingSources` of the caller's
   * flags); null or absent loads them all. Without `project` no `.mcp.json` server is
   * handed over, without `local` no local-scope server, without `user` the user
   * settings' `disabledMcpjsonServers` is not read: the child would not read it either.
   */
  settingSources?: ReadonlySet<SettingSource> | null;
}

/**
 * The MCP servers a child started in `childCwd` would lack next to a child started in
 * `setupFrom`, because Claude Code finds them from its cwd. Never writes. `setupFrom` is
 * taken by its real path throughout, and the `.claude.json` project entry is looked up
 * under setupFrom's real main checkout.
 *
 * - Nothing while `options.managedMcpFile` exists: Claude Code would refuse the
 *   `--mcp-config` flag and the child would not start. A log line names the file.
 * - `.mcp.json` servers, only when `childCwd` is not within setupFrom (walk-up cannot
 *   reach them): every regular file of the folders Claude Code's walk-up from setupFrom
 *   reads ({@link mcpJsonWalkDirs}) except a folder holding `childCwd`, nearest wins, minus every
 *   name in `disabledMcpjsonServers` of `layer`, the `.claude.json` project entry, the
 *   user settings, the managed settings and its drop-ins, since a `--mcp-config` server
 *   bypasses that list. A name matches as Claude Code compares it ({@link isDisabledBy}).
 *   When the child shares setupFrom's main checkout, a name its local scope defines is
 *   left out too: the child loads that local definition itself.
 * - Local-scope servers, only when the child's main checkout differs from setupFrom's:
 *   `projects[<setupFrom's main checkout>].mcpServers` of the `.claude.json` at
 *   `claudeCodeGlobalConfigPath(env, childCwd)`. They win a name clash, as local scope does.
 * - From both, every name in the `.claude.json` project entry's `disabledMcpServers` (the
 *   `/mcp disable` list), compared exactly: Claude Code drops a server of any scope on that
 *   list, and the child reads the list under its own project key, not setupFrom's.
 *
 * Definitions are copied verbatim: `${VAR}` stays unexpanded, so the child expands it
 * from its own environment; a literal value is copied as it is. A `.mcp.json` Claude Code
 * would skip (unreadable or malformed) is skipped with a log line naming only its path; a
 * blank one is no servers. Null when there is no server.
 */
export function buildInheritedMcpConfig(
  setupFrom: string,
  childCwd: string,
  layer: SettingsLayer | null,
  env: Record<string, string | undefined>,
  options: InheritedMcpOptions = {}
): InheritedMcpConfig | null {
  const setupReal = realOrResolved(setupFrom);
  const childReal = realOrResolved(childCwd);
  const sources = options.settingSources ?? null;
  const loads = (source: SettingSource) => sources === null || sources.has(source);

  const projectGate = !isWithin(childReal, setupReal) && loads("project");
  const setupMain = mainCheckoutKey(setupReal);
  const sharedMain = setupMain === mainCheckoutKey(childReal);
  const localGate = !sharedMain && loads("local");
  if (!projectGate && !localGate) return null;
  if (managedMcpPresent(options.managedMcpFile)) return null;

  const entry = globalConfigProjectEntry(env, setupMain, childReal);
  const localDefined = isPlainObject(entry?.mcpServers) ? entry.mcpServers : {};
  const projectServers = projectGate ? walkUpMcpJsonServers(setupReal, childReal, env) : {};
  const userFile = userSettingsFile(env.CLAUDE_CONFIG_DIR, env.HOME ?? "", childReal);
  const disabled = [
    ...serverNameList(layer?.disabledMcpjsonServers, true),
    ...serverNameList(entry?.disabledMcpjsonServers, true),
    ...(loads("user") ? disabledListOf(userFile, true) : []),
    ...managedDisabledList(options.managedSettingsFile, options.managedSettingsDropInDir),
  ];
  const turnedOff = serverNameList(entry?.disabledMcpServers, false);
  const definedLocally = sharedMain && loads("local") ? Object.keys(localDefined) : [];
  const withheld = (name: string) => isDisabledBy(name, disabled) || definedLocally.includes(name);
  for (const name of Object.keys(projectServers).filter(withheld)) delete projectServers[name];
  const localServers = localGate ? localDefined : {};
  const mcpServers = Object.fromEntries(
    Object.entries({ ...projectServers, ...localServers }).filter(
      ([name]) => !turnedOff.includes(name)
    )
  );
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : null;
}

/**
 * The caller's cwd-bound MCP servers for a `setup_from` child ({@link buildInheritedMcpConfig}).
 * None without setupFrom, and none when the caller's flags carry `--strict-mcp-config`:
 * they state the exact set. The caller's `--setting-sources` decides which scopes are
 * handed over, as it decides which the child reads itself.
 */
export function inheritedMcpFor(
  setupFrom: string | undefined,
  childCwd: string,
  layer: SettingsLayer | null,
  callerFlags: readonly string[],
  env: Record<string, string | undefined>,
  managed: ManagedPaths
): InheritedMcpConfig | null {
  if (!setupFrom || callerFlags.includes("--strict-mcp-config")) return null;
  return buildInheritedMcpConfig(setupFrom, childCwd, layer, env, {
    settingSources: enabledSettingSources(callerFlags),
    ...managed,
  });
}

/**
 * The setup directory a create_session call uses: `null` opts out, a string is
 * resolved, `undefined` is the server's cwd (the caller's project). Undefined when
 * that is the child's own directory, whose files Claude Code already reads natively.
 *
 * An explicit string must name an existing directory and any other non-null value is
 * refused, both as `invalid_args:`: a mistyped path would otherwise inherit nothing
 * and look like success. The implicit default is not checked.
 */
export function resolveSetupFrom(
  arg: unknown,
  workDir: string | undefined,
  serverCwd: string
): string | undefined {
  if (arg === null) return undefined;
  let setupFrom = serverCwd;
  if (typeof arg === "string") {
    setupFrom = resolve(arg);
    if (!statSync(setupFrom, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`invalid_args: setup_from ${setupFrom} is not an existing directory`);
    }
  } else if (arg !== undefined) {
    throw new Error("invalid_args: setup_from must be a directory path or null");
  }
  return setupFrom === resolve(workDir ?? serverCwd) ? undefined : setupFrom;
}
