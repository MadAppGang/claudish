/**
 * Environment isolation for the MCP e2e harness.
 *
 * Two independent isolation jobs, both load-bearing:
 *
 *  1. CONFIG — every child gets `CLAUDISH_CONFIG=<arm dir>/config.json`. The
 *     real `~/.claudish/config.json` is read ONCE, read-only, to seed arm
 *     configs, and is never written. This is not hygiene: the repo's e2e tests
 *     destroyed a real user's `onepasswordEnvironments` and `onepasswordAccount`
 *     exactly this way, by overwriting the real file and restoring it only in
 *     `afterEach` — which a killed or timed-out run never reaches. The failure is
 *     silent, because a config with no op sources makes claudish skip 1Password
 *     entirely rather than error.
 *
 *  2. ENV — provider keys are STRIPPED. Claude Code is launched via
 *     `op run --environment … -- claude`, so every descendant inherits keys
 *     1Password already resolved. `op-source` correctly short-circuits when a
 *     key is present in `process.env`, which means an arm that inherits the
 *     parent env never touches 1Password at all and passes green while the
 *     integration is broken. That is precisely the blind spot this harness
 *     exists to close.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultOpAccountLister, defaultOpDefaultAccountProbe } from "../providers/onepassword.js";
import type { ArmConfigSpec } from "./types.js";

/** The real global config. Read-only, always — never a write target. */
export const REAL_CONFIG_PATH = join(homedir(), ".claudish", "config.json");

/**
 * Env names that must survive stripping for `bun`/`claudish` to run at all.
 * Everything not matched here and not explicitly re-added by a scenario is
 * dropped.
 */
const ESSENTIAL = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BUN_INSTALL",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
]);

/**
 * Anything matching these is a credential and gets dropped unless a scenario
 * explicitly keeps it. Deliberately broad — a key that slips through silently
 * disables the very code path under test, which is a false PASS, the worst
 * failure mode a harness can have.
 */
const CREDENTIAL_PATTERNS = [
  /_API_KEY$/,
  /_TOKEN$/,
  /^OP_/,
  /_KEY$/,
  /_SECRET$/,
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^GOOGLE_/,
  /^GEMINI_/,
  /^AWS_/,
  /^AZURE_/,
];

function isCredential(name: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(name));
}

/**
 * Build the env for one arm: essentials + explicitly kept credentials +
 * scenario overrides. `CLAUDISH_*` flags are set by the runner, not here.
 */
export function buildArmEnv(opts: {
  parent: NodeJS.ProcessEnv;
  keepKeys?: string[];
  extra?: Record<string, string>;
}): Record<string, string> {
  const keep = new Set(opts.keepKeys ?? []);
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(opts.parent)) {
    if (value === undefined) continue;
    if (keep.has(name)) {
      out[name] = value;
      continue;
    }
    if (isCredential(name)) continue;
    if (ESSENTIAL.has(name)) out[name] = value;
  }

  // Scenario overrides land last so an arm can pin a literal (including the
  // deliberately-malformed `${OP_ACCOUNT}` placeholder the op-placeholder arm
  // uses to document Claude Code's unexpanded-env behaviour).
  for (const [name, value] of Object.entries(opts.extra ?? {})) out[name] = value;

  return out;
}

/**
 * The account URL `op` itself would use, or undefined.
 *
 * Reuses the product's own probe + lister rather than re-shelling to `op`, so
 * the harness and `resolveDesktopAccount` can never disagree about which account
 * "the default" means.
 */
function discoverDefaultAccountUrl(): string | undefined {
  try {
    const uuid = defaultOpDefaultAccountProbe();
    if (!uuid) return undefined;
    const accounts = defaultOpAccountLister();
    return accounts?.find((a) => a.account_uuid === uuid)?.url;
  } catch {
    return undefined;
  }
}

/** The real config, parsed. `{}` when absent or garbled — never throws. */
export function readRealConfig(): Record<string, unknown> {
  try {
    if (!existsSync(REAL_CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(REAL_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Materialise one arm's config object from its spec.
 *
 * `"inherit"` copies the real value; `null` deliberately OMITS the key (how the
 * multi-account wall is reproduced); a literal pins it. The result is a fresh
 * minimal object — never a copy of the real config — so unrelated real settings
 * (custom endpoints, profiles, stats) can't leak in and perturb an arm.
 */
export function buildArmConfig(spec: ArmConfigSpec): Record<string, unknown> {
  const real = readRealConfig();
  const cfg: Record<string, unknown> = {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
  };

  const account = spec.onepasswordAccount;
  if (account === "inherit") {
    // "inherit" means "this arm tests the CONFIGURED-account path". Since the
    // account fix landed, a healthy machine may legitimately have no
    // `onepasswordAccount` at all — and then inheriting nothing would silently
    // turn this arm into a duplicate of `op-no-account`, quietly dropping
    // coverage of the path it was written for. So fall back to the machine's own
    // default account: the arm still pins "an account is configured and used",
    // and stays distinct from the arm that pins the fallback.
    const v = real.onepasswordAccount;
    if (typeof v === "string" && v.trim()) cfg.onepasswordAccount = v;
    else {
      const discovered = discoverDefaultAccountUrl();
      if (discovered) cfg.onepasswordAccount = discovered;
    }
  } else if (typeof account === "string") {
    cfg.onepasswordAccount = account;
  }
  // account === null → key omitted (that is `op-no-account`'s whole point).

  const envs = spec.onepasswordEnvironments;
  if (envs === "inherit") {
    const v = real.onepasswordEnvironments;
    if (Array.isArray(v) && v.length > 0) cfg.onepasswordEnvironments = v;
  } else if (Array.isArray(envs)) {
    cfg.onepasswordEnvironments = envs;
  }

  for (const [k, v] of Object.entries(spec.extra ?? {})) cfg[k] = v;
  return cfg;
}

/**
 * Preconditions the whole suite depends on. Returned as human-readable
 * problems so the runner can refuse to run rather than emit a page of arm
 * failures that all trace back to one missing setting.
 */
export function checkPreconditions(): string[] {
  const problems: string[] = [];
  const real = readRealConfig();

  // `onepasswordAccount` is deliberately NOT required. It used to be — a
  // multi-account machine could not select an account without a TTY, so every
  // arm failed. `resolveDesktopAccount` now falls back to `op account get`, so
  // an unset account is a SUPPORTED state and the suite must run in it. That is
  // the state `op-no-account` exists to cover; requiring it here would refuse to
  // run in exactly the configuration the fix makes work.
  const envs = real.onepasswordEnvironments;
  if (!Array.isArray(envs) || envs.length === 0) {
    problems.push(
      "~/.claudish/config.json has no `onepasswordEnvironments`. The op arms have " +
        "no source to resolve from and cannot be meaningful."
    );
  }
  return problems;
}
