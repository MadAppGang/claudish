/**
 * Pure resolver for the effective default provider used when a bare model name
 * is supplied without an explicit `provider@` prefix.
 *
 * No imports from cli.ts or proxy-server.ts (otherwise we get import cycles).
 * Reads from a passed-in config object, env vars, and an optional CLI flag.
 * Also `planDefaultProviderFlag`, the argv scan index.ts applies before parseArgs
 * (port of upstream 9be012fc).
 *
 * LiteLLM auto-promotion was removed in commit 5 of the model-catalog and
 * routing redesign. Users who relied on `LITELLM_BASE_URL` + `LITELLM_API_KEY`
 * triggering "make LiteLLM the default" must add `defaultProvider: "litellm"`
 * to `~/.claudish/config.json` (or set `CLAUDISH_DEFAULT_PROVIDER=litellm`).
 */

import type { ClaudishProfileConfig } from "./profile-config.js";

export type DefaultProviderSource =
  | "cli-flag"
  | "env-var"
  | "config-file"
  | "openrouter-key"
  | "hardcoded";

export interface ResolvedDefaultProvider {
  /** Resolved provider name (builtin or custom-endpoint name). */
  provider: string;
  /** Where the value came from. */
  source: DefaultProviderSource;
  /**
   * Always `false` post-commit-5. Field is preserved for type-stability with
   * existing callers that pattern-match on it; will be removed in a future
   * cleanup once those callers are gone.
   */
  legacyAutoPromoted: boolean;
}

export interface ResolveOptions {
  cliFlag?: string;
  config: ClaudishProfileConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the effective default provider using the precedence chain:
 *   1. --default-provider CLI flag (reached here as CLAUDISH_DEFAULT_PROVIDER,
 *      exported by index.ts before parseArgs — see planDefaultProviderFlag)
 *   2. CLAUDISH_DEFAULT_PROVIDER env var
 *   3. config.json defaultProvider
 *   4. OPENROUTER_API_KEY present → "openrouter"
 *   5. hardcoded "openrouter"
 *
 * An env value that is PRESENT but empty ("") is an explicit opt-out: it beats
 * the config file and disables the fallback hop — that is how
 * `--default-provider ""` survives its trip through the environment. A missing
 * env var falls through to config. So an env `""` beats a config `x`.
 */
export function resolveDefaultProvider(opts: ResolveOptions): ResolvedDefaultProvider {
  const env = opts.env ?? process.env;

  if (opts.cliFlag && opts.cliFlag.length > 0) {
    return { provider: opts.cliFlag, source: "cli-flag", legacyAutoPromoted: false };
  }

  const envVal = env.CLAUDISH_DEFAULT_PROVIDER;
  if (envVal !== undefined) {
    return { provider: envVal, source: "env-var", legacyAutoPromoted: false };
  }

  if (opts.config.defaultProvider && opts.config.defaultProvider.length > 0) {
    return {
      provider: opts.config.defaultProvider,
      source: "config-file",
      legacyAutoPromoted: false,
    };
  }

  if (env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", source: "openrouter-key", legacyAutoPromoted: false };
  }

  return { provider: "openrouter", source: "hardcoded", legacyAutoPromoted: false };
}

/**
 * What a `--default-provider` scan of argv decided. A plan rather than an
 * effect: index.ts applies it (strips argv, exports the value as
 * CLAUDISH_DEFAULT_PROVIDER) — the same shape as a config-override plan.
 */
export type DefaultProviderFlagPlan =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | {
      kind: "apply";
      /** The flag's value. `""` is kept: it disables the fallback hop. */
      value: string;
      /** argv with every occurrence of the flag and its value removed. */
      argv: string[];
    };

const DEFAULT_PROVIDER_FLAG = "--default-provider";

/**
 * Find `--default-provider <name>` (or `--default-provider=<name>`) in argv,
 * before `parseArgs` sees it (upstream 9be012fc).
 *
 * Why before: `--probe` runs and exits INSIDE `parseArgs`'s argv loop, so a
 * flag read there — or positioned after `--probe` — never reached the probe,
 * in either argv order. Scanning first gives every path the same answer.
 *
 * - Every occurrence is removed; the last one wins, as `parseArgs` did.
 * - `""` is a value, not a missing one: `--default-provider ""` disables the
 *   fallback.
 * - A missing value, or a following token that is itself a flag, is an error,
 *   so a dangling flag never swallows the next option or leaks to Claude Code
 *   as a passthrough arg.
 * - Scanning stops at `--`. What follows it belongs to Claude Code, as in
 *   `parseArgs`.
 */
export function planDefaultProviderFlag(argv: string[]): DefaultProviderFlagPlan {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === DEFAULT_PROVIDER_FLAG) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          kind: "error",
          message: `${DEFAULT_PROVIDER_FLAG} requires a provider name ("" for no fallback provider)`,
        };
      }
      value = next;
      i++;
      continue;
    }
    if (arg.startsWith(`${DEFAULT_PROVIDER_FLAG}=`)) {
      value = arg.slice(DEFAULT_PROVIDER_FLAG.length + 1);
      continue;
    }
    rest.push(arg);
  }
  return value === undefined ? { kind: "none" } : { kind: "apply", value, argv: rest };
}

/**
 * Legacy stub — LiteLLM auto-promotion was removed in commit 5; the hint never
 * fires anymore. Kept as a no-op for callers that still import it.
 */
export function buildLegacyHint(_resolved: ResolvedDefaultProvider): string | null {
  return null;
}
