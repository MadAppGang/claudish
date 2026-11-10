/**
 * Pure resolver for the effective default provider used when a bare model name
 * is supplied without an explicit `provider@` prefix.
 *
 * No imports from cli.ts or proxy-server.ts (otherwise we get import cycles).
 * Reads from a passed-in config object, env vars, and an optional CLI flag.
 * Also `planDefaultProviderFlag`, the argv scan index.ts applies before parseArgs.
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
  /**
   * Whether an OpenRouter key exists in a store other than `env`. Injected so this
   * module stays pure; absent, only `env.OPENROUTER_API_KEY` counts.
   */
  hasOpenRouterKey?: () => boolean;
}

/**
 * Resolve the effective default provider using the precedence chain:
 *   1. --default-provider CLI flag
 *   2. CLAUDISH_DEFAULT_PROVIDER env var
 *   3. config.json defaultProvider
 *   4. an OpenRouter key present (in `env`, or `hasOpenRouterKey()`) → "openrouter"
 *   5. hardcoded "openrouter"
 *
 * An explicit `""` from the env var or the config file is an ANSWER, not a gap:
 * it returns `{ provider: "" }`, which `route()` reads as "no fallback hop"
 * (`fallbackProviderFor`). Skipping it, as this function once did, turned the
 * documented off switch into `openrouter` for every caller that asked here.
 * So an env `""` beats a config `x`, and a flag `x` beats an env `""`.
 *
 * An empty `cliFlag` is different: it means the caller parsed no flag, and it
 * falls through. The CLI no longer passes the flag here: index.ts exports it to
 * CLAUDISH_DEFAULT_PROVIDER (`planDefaultProviderFlag`), which is also how an
 * explicit `--default-provider ""` arrives.
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

  // `typeof`, not `!== undefined`: the config is hand-edited JSON, and a `null`
  // there is not a provider name.
  const configured = opts.config.defaultProvider;
  if (typeof configured === "string") {
    return { provider: configured, source: "config-file", legacyAutoPromoted: false };
  }

  if (env.OPENROUTER_API_KEY || opts.hasOpenRouterKey?.()) {
    return { provider: "openrouter", source: "openrouter-key", legacyAutoPromoted: false };
  }

  return { provider: "openrouter", source: "hardcoded", legacyAutoPromoted: false };
}

/**
 * What a `--default-provider` scan of argv decided. A plan rather than an effect,
 * like `planConfigOverride`: index.ts applies it (strips argv, exports the value).
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
 * Find `--default-provider <name>` (or `--default-provider=<name>`) in argv, before
 * `parseArgs` sees it.
 *
 * Why before: `--probe` runs and exits INSIDE `parseArgs`'s argv loop, so a flag
 * read there, or after it, never reached `--probe` in either argv order. Scanning
 * first gives every path the same answer.
 *
 * - Every occurrence is removed; the last one wins, as `parseArgs` did.
 * - `""` is a value, not a missing one: `--default-provider ""` disables the fallback.
 * - A missing value, or a following token that is itself a flag, is an error, so a
 *   dangling flag never swallows the next option or leaks to Claude Code.
 * - Scanning stops at `--`. What follows it belongs to Claude Code, as in `parseArgs`.
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
