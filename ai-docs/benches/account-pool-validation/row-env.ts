/**
 * The environment a row's child processes get, and the guards around it.
 *
 * The environment is a WHITELIST (PATH, TERM, LANG, TMPDIR plus what is listed
 * here), never a copy of `process.env`: no `ANTHROPIC_*`, provider key, Claude
 * Code token or `CLAUDISH_*` variable of the caller's can reach a child.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "../../..");
export const LAUNCHER = join(REPO, "packages/cli/bin/claudish.cjs");
export const BUNDLE = join(REPO, "packages/cli/dist/index.js");

/** macOS sandbox profile: every non-loopback network operation is denied. */
export const OFFLINE_PROFILE =
  '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))';

/**
 * The ONE non-loopback contact the built proxy makes at startup that no
 * environment variable disables: `warmRecommendedModels` forces a refresh of
 * `?catalog=recommended` on the hard-coded catalog host (model-loader.ts). The
 * egress sink refuses it. Any other target fails the standing assertion.
 */
export const KNOWN_EGRESS = /^CONNECT us-central1-claudish-6da10\.cloudfunctions\.net:443$/;

export const sha256File = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Refuse to run against the real home: the home itself or any path under it, unless the
 * path is under the OS temp dir (a temp dir may sit under the home on some systems).
 * `os.userInfo()` ignores $HOME, unlike `os.homedir()`.
 */
export function assertNotRealHome(home: string): void {
  const real = realpathSync(userInfo().homedir);
  const candidate = realpathSync(home);
  const temp = realpathSync(tmpdir());
  const under = (parent: string, child: string) =>
    child === parent || child.startsWith(`${parent}/`);
  if (under(real, candidate) && !(candidate !== temp && under(temp, candidate))) {
    throw new Error(`refusing to run: HOME ${candidate} is the real home ${real} or inside it`);
  }
}

export function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {}
): string {
  const proc = Bun.spawnSync(cmd, { cwd: opts.cwd ?? REPO, env: opts.env ?? process.env });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

export interface RowRoot {
  root: string;
  home: string;
  claudeDir: string;
  cwd: string;
  accountsDir: string;
}

/**
 * A fresh temp tree. `home`, `claudeDir` and `cwd` exist after the call; `accountsDir`
 * (`<home>/.claudish/accounts`) is only a path, created later by the built binary.
 * Realpath up front: macOS /tmp is /private/tmp and Claude Code slugs the realpath. */
export function makeRowRoot(): RowRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pool-row-")));
  const home = join(root, "home");
  const claudeDir = join(root, "claude");
  const cwd = join(root, "work");
  for (const d of [home, claudeDir, cwd]) mkdirSync(d, { recursive: true });
  assertNotRealHome(home);
  return { root, home, claudeDir, cwd, accountsDir: join(home, ".claudish", "accounts") };
}

export interface EnvInput {
  tree: RowRoot;
  accountsLog: string;
  fakeOrigin: string;
  canaryOrigin: string;
  sinkPort: number;
  claudePath: string;
  /** Per-process additions, e.g. `CLAUDISH_ACCOUNTS_FAULT`. */
  extra?: Record<string, string>;
  /** Spike knob: names to remove, to measure what each one changes. */
  drop?: string[];
}

export function buildEnv(input: EnvInput): Record<string, string> {
  const proxy = `http://127.0.0.1:${input.sinkPort}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: input.tree.home,
    CLAUDE_CONFIG_DIR: input.tree.claudeDir,
    CLAUDE_PATH: input.claudePath,
    TERM: "dumb",
    LANG: "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    CLAUDISH_ACCOUNT_STORE: "file",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_ACCOUNTS_LOG: input.accountsLog,
    CLAUDISH_ACCOUNTS_DIR: input.tree.accountsDir,
    OPENAI_CODEX_API_KEY: "sk-canary-must-never-be-used",
    CLAUDISH_TEST_UPSTREAM: `default=${input.fakeOrigin},api.openai.com=${input.canaryOrigin}`,
    // Anything non-loopback goes to the sink and is refused; loopback bypasses it.
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    // Non-essential traffic and telemetry off (claudish side and Claude Code side).
    CLAUDISH_STATS: "0",
    CLAUDISH_TELEMETRY: "0",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    ...input.extra,
  };
  for (const name of input.drop ?? []) delete env[name];
  return env;
}

export function pinOf(
  env: Record<string, string>,
  claudePath: string,
  launcher: string = LAUNCHER
): Record<string, string> {
  // The bundle is whatever the launcher starts: `<launcher>/../../dist/index.js`.
  const bundle = join(launcher, "..", "..", "dist", "index.js");
  return {
    launcher,
    claudishVersion: run(["node", launcher, "--version"], { env }),
    launcherSha256: sha256File(launcher),
    bundle,
    bundleSha256: sha256File(bundle),
    builtBundleSha256: sha256File(BUNDLE),
    gitHead: run(["git", "rev-parse", "HEAD"]),
    gitStatusPorcelain: run(["git", "status", "--porcelain"]),
    claudePath,
    claudeVersion: run([claudePath, "--version"], { env }),
    bun: Bun.version,
  };
}
