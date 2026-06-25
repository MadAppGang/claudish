#!/usr/bin/env bun

// Load .env file before anything else (quiet mode to suppress verbose output)
import { config } from "dotenv";
config({ quiet: true }); // Loads .env from current working directory

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountInfo, SdkAuth } from "./providers/onepassword.js";
import {
  readOnepasswordAccount,
  readAllOnepasswordEnvironments,
  saveOnepasswordAccount as saveOpConfigAccount,
} from "./providers/onepassword-config.js";

/**
 * Raw-read `onepasswordAccount`: local `.claudish.json` then global (local wins).
 * Thin wrapper over the shared scope-aware reader so the early-hydration path
 * and the TUI use ONE implementation. Returns undefined when neither sets it.
 */
function readConfiguredOnepasswordAccount(): string | undefined {
  return readOnepasswordAccount();
}

/**
 * Persist a picked 1Password account URL as `onepasswordAccount` at the chosen
 * scope (global → ~/.claudish/config.json, project → ./.claudish.json). Delegates
 * to the shared persistence helper (raw-merge for project, loadConfig/saveConfig
 * for global). Best-effort: a save failure only means the user is re-prompted.
 */
async function saveOnepasswordAccount(
  accountUrl: string,
  scope: "global" | "project"
): Promise<void> {
  try {
    saveOpConfigAccount(accountUrl, scope);
  } catch {
    // Non-fatal — the account is still used for THIS run via the returned auth.
  }
}

/**
 * Ask whether to save the picked account globally or for this project only.
 * Returns "global" (default on empty/abort) or "project". TTY-gated by the
 * caller (only reached inside the interactive picker).
 */
async function pickSaveScope(): Promise<"global" | "project"> {
  const { createInterface } = await import("node:readline");
  process.stderr.write(
    "\n[claudish] Remember this account for:\n" +
      "  1) all projects (global ~/.claudish/config.json)  [default]\n" +
      "  2) this project only (./.claudish.json)\n"
  );
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Scope [1-2]: ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
  return answer === "2" ? "project" : "global";
}

/**
 * Interactive multi-account picker. Prints the accounts to stderr and reads the
 * user's choice from stdin (readline). Returns the chosen account URL, or
 * undefined if the user aborts. Only invoked when stdout is a TTY.
 */
async function pickOnepasswordAccount(accounts: AccountInfo[]): Promise<string | undefined> {
  const { createInterface } = await import("node:readline");
  process.stderr.write("\n[claudish] Multiple 1Password accounts found. Choose one:\n");
  accounts.forEach((a, i) => {
    process.stderr.write(`  ${i + 1}) ${a.url}${a.email ? `  (${a.email})` : ""}\n`);
  });
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Account [1-${accounts.length}]: `, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
  const idx = Number.parseInt(answer, 10);
  if (Number.isNaN(idx) || idx < 1 || idx > accounts.length) {
    process.stderr.write("[claudish] No valid selection — aborting 1Password account picker.\n");
    return undefined;
  }
  return accounts[idx - 1].url;
}

/**
 * Memoized SDK auth resolver shared across all early-hydration 1Password paths
 * (--op-env, --op, config apiKeys/onepassword[], custom-endpoint op:// keys).
 * Resolving once means a multi-account user is prompted AT MOST once per run,
 * and the picked account is saved to global config.
 *
 * Returns the resolved SdkAuth, or undefined when NO auth could be resolved AND
 * there's nothing to prompt (the individual callers still hard-fail at the
 * point of use via acquireSdkClient if they actually need a secret). We resolve
 * lazily: this is only ever called when at least one op:// source is present.
 */
let cachedSdkAuth: SdkAuth | undefined;
let sdkAuthResolved = false;
async function getSdkAuth(): Promise<SdkAuth | undefined> {
  if (sdkAuthResolved) return cachedSdkAuth;
  sdkAuthResolved = true;
  const { resolveSdkAuth } = await import("./providers/onepassword.js");
  const interactive = Boolean(process.stdout.isTTY) && !process.argv.includes("--stdin");
  try {
    cachedSdkAuth = await resolveSdkAuth({
      configAccount: readConfiguredOnepasswordAccount(),
      interactive,
      onNeedsPicker: async (accounts) => {
        const chosen = await pickOnepasswordAccount(accounts);
        if (chosen) {
          const scope = await pickSaveScope();
          await saveOnepasswordAccount(chosen, scope);
        }
        return chosen;
      },
    });
  } catch (err) {
    // No usable auth. Surface the actionable message and hard-fail — every
    // caller of getSdkAuth() only runs because an op:// source is present, so
    // there's no "skip silently" path.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password authentication failed: ${message}`);
    process.exit(1);
  }
  return cachedSdkAuth;
}

/**
 * Highest-priority source: 1Password Environments. Two inputs, both OVERWRITE
 * anything already in process.env (and, being applied before loadStoredApiKeys,
 * also beat config apiKeys/onepassword[]):
 *  1. `--op-env <id>` flag — the ephemeral, inline form.
 *  2. `onepasswordEnvironments[]` config — the persisted form (local + global,
 *     deduped). The flag's environment (when present) is applied LAST so an
 *     inline `--op-env` wins over a config one with overlapping keys.
 *
 * Runs the SDK ONLY when at least one environment source is present, so
 * non-users never touch the `op` binary OR the 1Password SDK. Async because the
 * SDK resolver is async. On any failure (including no SDK auth) this hard-fails
 * (exit 1) — every 1Password source is explicit opt-in.
 */
async function applyOpEnvironment(): Promise<void> {
  const argv = process.argv.slice(2);
  let flagEnvId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--op-env") {
      flagEnvId = argv[i + 1];
      break;
    }
    if (a.startsWith("--op-env=")) {
      flagEnvId = a.slice("--op-env=".length);
      break;
    }
  }
  if (flagEnvId !== undefined && (flagEnvId === "" || flagEnvId.startsWith("-"))) {
    console.error("[claudish] --op-env requires a 1Password Environment ID");
    process.exit(1);
  }

  // Config-persisted environments (local + global, deduped). Config IDs resolve
  // first; the inline flag (if any) is appended LAST so it wins on key overlap.
  const configEnvIds = readAllOnepasswordEnvironments();
  const envIds = [...configEnvIds];
  if (flagEnvId !== undefined && flagEnvId !== "") envIds.push(flagEnvId);

  // No environment source at all → zero cost, never invoke `op` or import the SDK.
  if (envIds.length === 0) return;

  try {
    // Dynamic import: only pull in the onepassword resolution path (and the SDK)
    // when an environment source is actually present.
    const { readEnvironment } = await import("./providers/onepassword.js");
    const auth = await getSdkAuth();
    for (const envId of envIds) {
      const vars = await readEnvironment(envId, { auth });
      for (const [key, value] of Object.entries(vars)) {
        // Environments are the highest-priority source: overwrite unconditionally.
        process.env[key] = value;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password Environment load failed: ${message}`);
    process.exit(1);
  }
}

/**
 * Inline 1Password glob import via the `--op <glob>` early-hydration flag.
 * Mirrors `applyOpEnvironment()`: scans argv BEFORE the subcommand router runs,
 * resolves the glob, and hydrates process.env so `--op` composes with EVERY
 * downstream path (config TUI, serve, a model run, plain interactive) with zero
 * special handoff.
 *
 * Two modes, selected by a bare `--list` token in the same argv:
 *  - `--op <glob> --list`  → PREVIEW: print the field-name table (no values),
 *    then exit 0. Terminal — never continues to a session or dispatch.
 *  - `--op <glob>`         → hydrate env vars (OVERWRITE — explicit inline
 *    request, like --op-env), then RETURN so execution falls through to the
 *    normal dispatch.
 *
 * After consuming, the `--op`, its glob value, and any `--list` token are
 * REMOVED from process.argv so the downstream router + parseArgs never see them
 * (critically, so the glob value isn't mistaken for the first positional arg).
 *
 * Runs only when `--op` is present, so non-users never import onepassword/SDK.
 * Hard-fails (exit 1) on any resolution/preview failure — `--op` is explicit
 * opt-in.
 */
async function applyOpImport(): Promise<void> {
  const argv = process.argv.slice(2);
  const { parseOpFlag } = await import("./providers/onepassword.js");
  const parsed = parseOpFlag(argv);

  // Flag not present → zero cost, never invoke `op` or import the SDK/command.
  if (!parsed.present) return;

  if (parsed.glob === undefined) {
    console.error("[claudish] --op requires an op:// glob path");
    process.exit(1);
  }
  const glob = parsed.glob;

  if (parsed.list) {
    // PREVIEW — names only, terminal. Never resolves secret values, never
    // continues to dispatch.
    try {
      const { opPreviewCommand } = await import("./onepassword-command.js");
      const auth = await getSdkAuth();
      await opPreviewCommand(glob, { auth });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[claudish] 1Password --op preview failed: ${message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // HYDRATE — resolve the glob and OVERWRITE each {envVar: value} into the
  // process env (explicit inline request, same as --op-env). Then strip the flag
  // tokens from process.argv and fall through to the normal dispatch.
  try {
    const { resolveGlobImport } = await import("./providers/onepassword.js");
    const auth = await getSdkAuth();
    const resolved = await resolveGlobImport(glob, { auth });
    for (const [key, value] of Object.entries(resolved)) {
      process.env[key] = value;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password --op import failed: ${message}`);
    process.exit(1);
  }

  // Remove the consumed flag tokens so downstream firstPositional detection /
  // parseArgs never see them. We drop: `--op` + its glob value, OR `--op=<glob>`.
  // (No `--list` here — list mode already exited above.)
  const head = process.argv.slice(0, 2);
  const rebuilt: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--op") {
      // Skip `--op` and its following value (the glob).
      i++;
      continue;
    }
    if (a.startsWith("--op=")) {
      continue; // inline form — single token
    }
    rebuilt.push(a);
  }
  process.argv = [...head, ...rebuilt];
}

/**
 * Load API keys and custom endpoints from ~/.claudish/config.json into process.env.
 * Environment variables already set take precedence over stored values.
 * Uses raw fs reads (no profile-config.ts import) to avoid loading heavy dependencies
 * on every CLI invocation.
 *
 * Two 1Password sources are honored:
 *  - `cfg.apiKeys` / `cfg.endpoints` — a `{ NAME: value }` map. A single op://
 *    ref VALUE resolves under its explicit NAME (the original behavior). Glob
 *    VALUES in apiKeys are NO LONGER specially detected.
 *  - `cfg.onepassword` — a dedicated `string[]` of glob OR single op:// ref
 *    entries. Globs expand to MANY env vars (named by field label); single refs
 *    are named by their trailing field label. This replaces the old magic
 *    placeholder-key-in-apiKeys glob convention.
 *
 * Resolution is explicit opt-in (an op:// ref/glob is present), so a failure
 * hard-fails (exit 1).
 */
async function loadStoredApiKeys(): Promise<void> {
  let opRefs: Record<string, string> = {};
  let globImports: string[] = [];
  // Mirror the apiKeys/endpoints gap-fill into process.env BEFORE collecting,
  // so single op:// refs sitting in config seed process.env exactly as before.
  let apiKeysForSeed: Record<string, string> | undefined;
  try {
    const configPath = join(homedir(), ".claudish", "config.json");
    if (!existsSync(configPath)) return;
    const raw = readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as {
      apiKeys?: Record<string, string>;
      endpoints?: Record<string, string>;
      onepassword?: string[];
    };

    // Gap-fill apiKeys + endpoints into process.env (env already set wins).
    const seedSources = [cfg.apiKeys, cfg.endpoints];
    const mergedApiKeys: Record<string, string> = {};
    for (const source of seedSources) {
      if (!source) continue;
      for (const [envVar, value] of Object.entries(source)) {
        if (typeof value !== "string") continue;
        if (!process.env[envVar]) {
          process.env[envVar] = value;
        }
        mergedApiKeys[envVar] = value;
      }
    }
    apiKeysForSeed = mergedApiKeys;

    // collectConfigImports is pure — it reads the (now-seeded) process.env to
    // honor "don't resolve a real already-set env var that differs from config".
    const { collectConfigImports } = await import("./providers/onepassword.js");
    const collected = collectConfigImports(
      { apiKeys: apiKeysForSeed, onepassword: cfg.onepassword },
      process.env
    );
    opRefs = collected.opRefs;
    globImports = collected.globImports;
    for (const w of collected.warnings) console.error(w);
  } catch {
    // Silently ignore config load/parse failures (missing/garbled config.json).
  }

  // Nothing to resolve → zero cost, no SDK/op import.
  const refKeys = Object.keys(opRefs);
  if (refKeys.length === 0 && globImports.length === 0) return;

  try {
    // Dynamic import: only load the resolution path (and the SDK) when an
    // op:// reference OR glob import is actually present.
    const { resolveSecrets, resolveGlobImport } = await import(
      "./providers/onepassword.js"
    );
    const auth = await getSdkAuth();

    // Single op:// refs: batched, in one resolveAll call.
    if (refKeys.length > 0) {
      const resolved = await resolveSecrets(opRefs, { auth });
      for (const [envVar, value] of Object.entries(resolved)) {
        process.env[envVar] = value;
      }
    }

    // Glob imports: each expands to MANY env vars (named by field label).
    // Explicit/shell env wins — never overwrite an already-set var.
    // A glob failure is NON-FATAL (warn + skip): a glob can legitimately match
    // nothing after a 1Password item edit, and that must NOT lock the user out
    // of claudish (especially `claudish config`, where they'd go to FIX it).
    // Genuine auth/token failures still surface via resolveSecrets above.
    for (const globPath of globImports) {
      try {
        const resolved = await resolveGlobImport(globPath, { auth });
        for (const [envVar, value] of Object.entries(resolved)) {
          if (!process.env[envVar]) {
            process.env[envVar] = value;
          }
        }
      } catch (globErr) {
        const m = globErr instanceof Error ? globErr.message : String(globErr);
        console.error(`[claudish] 1Password import skipped: ${m}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[claudish] 1Password secret resolution failed: ${message}`
    );
    process.exit(1);
  }
}

/**
 * Pre-resolve custom-endpoint `op://` apiKeys into `CUSTOM_<NAME>_KEY` env vars
 * so the SYNCHRONOUS provider-construction path (custom-endpoints-loader's
 * createHandler) can read the resolved value without awaiting the async SDK.
 *
 * Raw-reads `customEndpoints` from ~/.claudish/config.json (dependency-light,
 * mirrors loadStoredApiKeys). For each endpoint whose `apiKey` is an op:// ref,
 * collects `{ CUSTOM_<sanitize(name)>_KEY: "op://..." }` and resolves the batch
 * via the SDK. The sanitize rule matches custom-endpoints-loader's
 * sanitizeEnvName (UPPERCASE, non-alphanumerics → `_`). An already-set
 * CUSTOM_<NAME>_KEY (shell/env) wins and is skipped.
 *
 * Zero-cost when no custom endpoint uses an op:// key. Hard-fails (exit 1) on a
 * resolution error — an op:// apiKey is explicit opt-in.
 */
async function applyCustomEndpointOpKeys(): Promise<void> {
  let refs: Record<string, string> = {};
  try {
    const configPath = join(homedir(), ".claudish", "config.json");
    if (!existsSync(configPath)) return;
    const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as {
      customEndpoints?: Record<string, unknown>;
    };
    const endpoints = cfg.customEndpoints;
    if (!endpoints || typeof endpoints !== "object") return;

    const { isOpReference } = await import("./providers/onepassword.js");
    for (const [name, raw] of Object.entries(endpoints)) {
      if (!raw || typeof raw !== "object") continue;
      const apiKey = (raw as { apiKey?: unknown }).apiKey;
      if (typeof apiKey !== "string" || !isOpReference(apiKey)) continue;
      const envVar = `CUSTOM_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
      // Shell/env value already present → don't overwrite, don't resolve.
      if (process.env[envVar]) continue;
      refs[envVar] = apiKey;
    }
  } catch {
    // Unreadable/garbled config → nothing to resolve.
    refs = {};
  }

  if (Object.keys(refs).length === 0) return;

  try {
    const { resolveSecrets } = await import("./providers/onepassword.js");
    const auth = await getSdkAuth();
    const resolved = await resolveSecrets(refs, { auth });
    for (const [envVar, value] of Object.entries(resolved)) {
      process.env[envVar] = value;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password custom-endpoint key resolution failed: ${message}`);
    process.exit(1);
  }
}

// Early-hydration sequence (all async — the SDK is async). Both explicit flags
// beat config; config only fills remaining gaps:
//   1. --op-env <id>           — highest priority, overwrites unconditionally.
//   2. --op <glob>             — explicit inline import, also overwrites; in
//      --list mode it previews and exits before any dispatch.
//   3. config.json apiKeys/onepassword[] — gap-fill (never overwrites a set var).
//   4. customEndpoints op:// apiKeys     — pre-resolved into CUSTOM_<NAME>_KEY.
// Run to completion BEFORE the subcommand dispatch so process.env is fully
// hydrated. When none of these flags/refs are present, each returns immediately
// without importing the 1Password SDK. SDK auth is resolved AT MOST once and
// shared across all four (getSdkAuth memoization).
await applyOpEnvironment();
await applyOpImport();
await loadStoredApiKeys();
await applyCustomEndpointOpKeys();

// Check for MCP mode before loading heavy dependencies
const isMcpMode = process.argv.includes("--mcp");

// Handle Ctrl+C gracefully during interactive prompts
function handlePromptExit(err: unknown): void {
  if (err && typeof err === "object" && "name" in err && err.name === "ExitPromptError") {
    console.log("");
    process.exit(0);
  }
  throw err;
}

// Check for auth and profile management commands
const args = process.argv.slice(2);

// Check for subcommands (can appear anywhere in args due to aliases like `claudish -y`)
const isUpdateCommand = args.includes("update");
const isInitCommand = args[0] === "init" || args.includes("init");
const isProfileCommand =
  args[0] === "profile" ||
  args.some((a, i) => a === "profile" && (i === 0 || !args[i - 1]?.startsWith("-")));
// Find first positional (non-flag) arg — handles aliases like `claudish -y config`
const firstPositional = args.find((a) => !a.startsWith("-"));
// Check for telemetry management subcommand
const isTelemetryCommand = firstPositional === "telemetry";
// Check for stats management subcommand
const isStatsCommand = firstPositional === "stats";
// Check for interactive config TUI
const isConfigCommand = firstPositional === "config";
// Serve subcommand: claudish serve --port <n> --models <path> (Claude Desktop redirect gateway)
const isServeCommand = firstPositional === "serve";
// Providers subcommand: claudish providers --json (credential presence, no key material)
const isProvidersCommand = firstPositional === "providers";
// Auth subcommands: claudish login [provider], claudish logout [provider]
const isLoginCommand = firstPositional === "login";
const isLogoutCommand = firstPositional === "logout";
// Quota subcommand: claudish quota [provider]
const isQuotaCommand = firstPositional === "quota" || firstPositional === "usage";
// Legacy auth flags (deprecated, redirect to new subcommands)
const isLegacyGeminiLogin = args.includes("--gemini-login");
const isLegacyGeminiLogout = args.includes("--gemini-logout");
const isLegacyKimiLogin = args.includes("--kimi-login");
const isLegacyKimiLogout = args.includes("--kimi-logout");

if (isMcpMode) {
  // MCP server mode - dynamic import to keep CLI fast
  import("./mcp-server.js").then((mcp) => mcp.startMcpServer());
} else if (isServeCommand) {
  // Standalone inference gateway for Claude Desktop redirect:
  // claudish serve --port <n> --models <path>
  const serveArgIndex = args.indexOf("serve");
  import("./serve-command.js").then((m) =>
    m.serveCommand(args.slice(serveArgIndex + 1)).catch((e) => {
      console.error(`[claudish serve] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    })
  );
} else if (isProvidersCommand) {
  // Provider credential presence (no key material): claudish providers --json
  const json = args.includes("--json");
  import("./providers-command.js").then((m) =>
    m.providersCommand({ json }).catch((e) => {
      console.error(`[claudish providers] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    })
  );
} else if (isLoginCommand) {
  // Auth login subcommand: claudish login [provider]
  const loginProviderArg = args.find((a, i) => i > args.indexOf("login") && !a.startsWith("-"));
  import("./auth/auth-commands.js").then((m) =>
    m.loginCommand(loginProviderArg).catch(handlePromptExit)
  );
} else if (isLogoutCommand) {
  // Auth logout subcommand: claudish logout [provider]
  const logoutProviderArg = args.find((a, i) => i > args.indexOf("logout") && !a.startsWith("-"));
  import("./auth/auth-commands.js").then((m) =>
    m.logoutCommand(logoutProviderArg).catch(handlePromptExit)
  );
} else if (isLegacyGeminiLogin || isLegacyKimiLogin) {
  // Deprecated --*-login flags — redirect to new subcommands
  const provider = isLegacyGeminiLogin ? "gemini" : "kimi";
  console.log(`Note: --${provider}-login is deprecated. Use: claudish login ${provider}`);
  import("./auth/auth-commands.js").then((m) => m.loginCommand(provider).catch(handlePromptExit));
} else if (isLegacyGeminiLogout || isLegacyKimiLogout) {
  // Deprecated --*-logout flags — redirect to new subcommands
  const provider = isLegacyGeminiLogout ? "gemini" : "kimi";
  console.log(`Note: --${provider}-logout is deprecated. Use: claudish logout ${provider}`);
  import("./auth/auth-commands.js").then((m) => m.logoutCommand(provider).catch(handlePromptExit));
} else if (isQuotaCommand) {
  // Quota/usage subcommand: claudish quota [provider]
  const quotaProviderArg = args.find(
    (a, i) => i > args.indexOf(firstPositional!) && !a.startsWith("-")
  );
  import("./auth/quota-command.js").then((m) => m.quotaCommand(quotaProviderArg));
} else if (isUpdateCommand) {
  // Self-update command (checked early to work with aliases like `claudish -y update`)
  import("./update-command.js").then((m) => m.updateCommand());
} else if (isInitCommand) {
  // Profile setup wizard — pass --local/--global scope flag if provided
  const scopeFlag = args.includes("--local")
    ? "local"
    : args.includes("--global")
      ? "global"
      : undefined;
  import("./profile-commands.js").then((pc) => pc.initCommand(scopeFlag).catch(handlePromptExit));
} else if (isProfileCommand) {
  // Profile management commands
  const profileArgIndex = args.findIndex((a) => a === "profile");
  import("./profile-commands.js").then((pc) =>
    pc.profileCommand(args.slice(profileArgIndex + 1)).catch(handlePromptExit)
  );
} else if (isTelemetryCommand) {
  // Telemetry management: claudish telemetry on|off|status|reset
  const subcommand = args[1] ?? "status";
  import("./telemetry.js").then((tel) => {
    tel.initTelemetry({ interactive: true } as any);
    return tel.handleTelemetryCommand(subcommand);
  });
} else if (isStatsCommand) {
  // Stats management: claudish stats on|off|status|reset
  const subcommand = args[1] ?? "status";
  import("./stats.js").then((stats) => {
    stats.initStats({ interactive: true } as any);
    return stats.handleStatsCommand(subcommand);
  });
} else if (isConfigCommand) {
  // Interactive configuration TUI: claudish config (full-screen btop-inspired TUI)
  import("./tui/index.js").then((m) => m.startConfigTui().catch(handlePromptExit));
} else {
  // CLI mode
  runCli();
}

/**
 * Run CLI mode
 */
async function runCli() {
  const { checkClaudeInstalled, runClaudeWithProxy } = await import("./claude-runner.js");
  const { parseArgs, getVersion } = await import("./cli.js");
  const { DEFAULT_PORT_RANGE } = await import("./config.js");
  const { selectModel, promptForApiKey } = await import("./model-selector.js");
  const {
    resolveModelProvider,
    validateApiKeysForModels,
    getMissingKeyResolutions,
    getMissingKeysError,
  } = await import("./providers/provider-resolver.js");
  const { initLogger, getLogFilePath, getAlwaysOnLogPath, setDiagOutput } = await import(
    "./logger.js"
  );
  const { createDiagOutput } = await import("./diag-output.js");
  const { findAvailablePort } = await import("./port-manager.js");
  const { createProxyServer } = await import("./proxy-server.js");
  const { checkForUpdates } = await import("./update-checker.js");
  const { warmCatalogIfNeeded } = await import("./launcher/catalog-warm.js");

  /**
   * Read content from stdin
   */
  async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  try {
    // Parse CLI arguments
    const cliConfig = await parseArgs(process.argv.slice(2));

    // Team mode: run models in parallel (skip normal Claude Code path)
    if (cliConfig.team && cliConfig.team.length > 0) {
      // Resolve prompt: --file flag, or positional args from claudeArgs
      let prompt = cliConfig.claudeArgs.join(" ");
      if (cliConfig.inputFile) {
        prompt = readFileSync(cliConfig.inputFile, "utf-8");
      }
      if (!prompt.trim()) {
        console.error("Error: --team requires a prompt (positional args or -f <file>)");
        process.exit(1);
      }

      const mode = cliConfig.teamMode ?? "default";
      const sessionPath = join(process.cwd(), `.claudish-team-${Date.now()}`);

      if (mode === "json") {
        // JSON mode: run models without grid, collect JSON output to stdout
        const { setupSession, runModels } = await import("./team-orchestrator.js");
        setupSession(sessionPath, cliConfig.team, prompt);
        const status = await runModels(sessionPath, {
          timeout: 300,
          claudeFlags: ["--json"],
        });

        // Build JSON result with model responses included
        const result: Record<string, unknown> = { ...status, responses: {} };
        for (const anonId of Object.keys(status.models)) {
          const responsePath = join(sessionPath, `response-${anonId}.md`);
          try {
            const raw = readFileSync(responsePath, "utf-8").trim();
            try {
              (result.responses as Record<string, unknown>)[anonId] = JSON.parse(raw);
            } catch {
              (result.responses as Record<string, unknown>)[anonId] = raw;
            }
          } catch {
            (result.responses as Record<string, unknown>)[anonId] = null;
          }
        }
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      }

      // Default or interactive mode — both use magmux grid
      const { runWithGrid } = await import("./team-grid.js");
      const keep = cliConfig.teamKeep ?? false;
      const status = await runWithGrid(sessionPath, cliConfig.team, prompt, {
        timeout: 300,
        keep,
        mode: mode as "default" | "interactive",
      });

      // Print final status (interactive may not reach here until user quits magmux)
      const modelIds = Object.keys(status.models).sort();
      console.log(`\nTeam Status`);
      for (const id of modelIds) {
        const m = status.models[id];
        const duration =
          m.startedAt && m.completedAt
            ? `${Math.round((new Date(m.completedAt).getTime() - new Date(m.startedAt).getTime()) / 1000)}s`
            : "pending";
        console.log(`  ${id}  ${m.state.padEnd(10)}  ${duration}`);
      }
      process.exit(0);
    }

    // First-run auto-approve confirmation
    // Auto-approve is enabled by default, but on first run we confirm with the user.
    // If user explicitly passed --no-auto-approve, skip the prompt entirely.
    // If --stdin is set, skip the prompt — no human to confirm when piping input.
    const rawArgs = process.argv.slice(2);
    const explicitNoAutoApprove = rawArgs.includes("--no-auto-approve");
    if (cliConfig.autoApprove && !explicitNoAutoApprove && !cliConfig.stdin) {
      const { loadConfig, saveConfig } = await import("./profile-config.js");
      try {
        const cfg = loadConfig();
        if (!cfg.autoApproveConfirmedAt) {
          // First run — show one-time confirmation
          const { createInterface } = await import("node:readline");
          process.stderr.write(
            "\n[claudish] Auto-approve is enabled by default.\n" +
              "  This skips Claude Code permission prompts for tools like Bash, Read, Write.\n" +
              "  You can disable it anytime with: --no-auto-approve\n\n"
          );
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            rl.question("Enable auto-approve? [Y/n] ", (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            });
          });
          const declined = answer === "n" || answer === "no";
          if (declined) {
            cliConfig.autoApprove = false;
            process.stderr.write("[claudish] Auto-approve disabled. Use -y to enable per-run.\n\n");
          } else {
            process.stderr.write("[claudish] Auto-approve confirmed.\n\n");
          }
          cfg.autoApproveConfirmedAt = new Date().toISOString();
          saveConfig(cfg);
        }
      } catch {
        // Config read/write failure — proceed with default (auto-approve on)
      }
    }

    // Initialize logger: always-on structural logging + optional debug logging
    initLogger(cliConfig.debug, cliConfig.logLevel, cliConfig.noLogs);

    // Initialize telemetry (reads consent, generates session_id)
    // Must come after parseArgs() so cliConfig.interactive is known
    const { initTelemetry } = await import("./telemetry.js");
    initTelemetry(cliConfig);

    // Initialize anonymous usage stats (reads consent, detects environment)
    const { initStats, showMonthlyBanner } = await import("./stats.js");
    initStats(cliConfig);
    showMonthlyBanner();

    // Show debug log location if enabled
    if (cliConfig.debug && !cliConfig.quiet) {
      const logFile = getLogFilePath();
      if (logFile) {
        console.log(`[claudish] Debug log: ${logFile}`);
      }
    }

    // Check for updates (only in interactive mode, skip in JSON output mode)
    if (cliConfig.interactive && !cliConfig.jsonOutput) {
      await checkForUpdates(getVersion(), { quiet: cliConfig.quiet });
    }

    // Check if Claude Code is installed
    if (!(await checkClaudeInstalled())) {
      console.error("Error: Claude Code CLI not found");
      console.error("Install it from: https://claude.com/claude-code");
      console.error("");
      console.error("Or if you have a local installation, set CLAUDE_PATH:");
      console.error("  export CLAUDE_PATH=~/.claude/local/claude");
      process.exit(1);
    }

    // Show interactive model selector ONLY when no model configuration exists
    // Skip if: explicit --model, OR profile provides tier mappings (Claude Code uses these internally)
    const hasProfileTiers =
      cliConfig.modelOpus ||
      cliConfig.modelSonnet ||
      cliConfig.modelHaiku ||
      cliConfig.modelSubagent;
    if (cliConfig.interactive && !cliConfig.monitor && !cliConfig.model && !hasProfileTiers) {
      cliConfig.model = (await selectModel({ freeOnly: cliConfig.freeOnly }).catch(
        handlePromptExit
      )) as string;
      console.log(""); // Empty line after selection
    }

    // In non-interactive mode, model must be specified (via --model, env var, or profile)
    if (!cliConfig.interactive && !cliConfig.monitor && !cliConfig.model && !hasProfileTiers) {
      console.error("Error: Model must be specified in non-interactive mode");
      console.error("Use --model <model> flag, set CLAUDISH_MODEL env var, or use --profile");
      console.error("Try: claudish --list-models");
      process.exit(1);
    }

    // === API Key Validation ===
    // This happens AFTER model selection so we know exactly which provider(s) are being used
    // The centralized ProviderResolver handles all provider detection and key requirements
    if (!cliConfig.monitor) {
      // When --model is explicitly set, it overrides ALL role mappings (opus/sonnet/haiku/subagent)
      // So we only need to validate the explicit model, not the profile mappings
      const hasExplicitModel = typeof cliConfig.model === "string";

      // Collect models to validate
      const modelsToValidate = hasExplicitModel
        ? [cliConfig.model] // Only validate the explicit model
        : [
            cliConfig.model,
            cliConfig.modelOpus,
            cliConfig.modelSonnet,
            cliConfig.modelHaiku,
            cliConfig.modelSubagent,
          ];

      // Validate API keys for all models
      const resolutions = validateApiKeysForModels(modelsToValidate);
      const missingKeys = getMissingKeyResolutions(resolutions);

      if (missingKeys.length > 0) {
        if (cliConfig.interactive) {
          // Interactive mode: prompt for missing OpenRouter key if that's what's needed
          const needsOpenRouter = missingKeys.some((r) => r.category === "openrouter");
          if (needsOpenRouter && !cliConfig.openrouterApiKey) {
            cliConfig.openrouterApiKey = await promptForApiKey();
            console.log(""); // Empty line after input

            // Re-validate after getting the key (it's now in process.env)
            process.env.OPENROUTER_API_KEY = cliConfig.openrouterApiKey;
          }

          // Check if there are still missing keys (non-OpenRouter providers)
          const stillMissing = getMissingKeyResolutions(validateApiKeysForModels(modelsToValidate));
          const nonOpenRouterMissing = stillMissing.filter((r) => r.category !== "openrouter");

          if (nonOpenRouterMissing.length > 0) {
            // Can't prompt for other providers - show error
            console.error(getMissingKeysError(nonOpenRouterMissing));
            process.exit(1);
          }
        } else {
          // Non-interactive mode: fail with clear error message
          console.error(getMissingKeysError(missingKeys));
          process.exit(1);
        }
      }
    }

    // Clean up stdin after interactive prompts (readline, @inquirer/prompts).
    // These leave lingering data/keypress listeners and raw mode state that interfere
    // with Claude Code's TTY handling when spawned with stdio: "inherit". (#85, #88, #99)
    if (cliConfig.interactive && !cliConfig.monitor && process.stdin.isTTY) {
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("keypress");
    }

    // Show deprecation warnings for legacy syntax
    if (!cliConfig.quiet) {
      const modelsToCheck = [
        cliConfig.model,
        cliConfig.modelOpus,
        cliConfig.modelSonnet,
        cliConfig.modelHaiku,
        cliConfig.modelSubagent,
      ].filter((m): m is string => typeof m === "string");

      for (const modelId of modelsToCheck) {
        const resolution = resolveModelProvider(modelId);
        if (resolution.deprecationWarning) {
          console.warn(`[claudish] ${resolution.deprecationWarning}`);
        }
      }
    }

    // Read prompt from stdin if --stdin flag is set
    if (cliConfig.stdin) {
      const stdinInput = await readStdin();
      if (stdinInput.trim()) {
        // Prepend stdin content to claudeArgs
        cliConfig.claudeArgs = [stdinInput, ...cliConfig.claudeArgs];
      }
    }

    // Launcher catalog warm step. Runs BEFORE port resolution / proxy startup
    // so we can exit cleanly without a half-spawned server when the catalog
    // is missing AND the network is unreachable. See architecture.md §2.4.
    //
    // Returns one of:
    //   "ok"        — catalog ready (fresh or freshly refreshed)
    //   "warned"    — proceed with stale cache, warning already on stderr
    //   "skipped"   — local model or --skip-models-update
    //   "hard_fail" — missing cache + network failure → exit 1
    const warmOutcome = await warmCatalogIfNeeded(cliConfig);
    if (warmOutcome === "hard_fail") {
      process.exit(1);
    }

    // Find available port
    const port =
      cliConfig.port || (await findAvailablePort(DEFAULT_PORT_RANGE.start, DEFAULT_PORT_RANGE.end));

    // Start proxy server
    // explicitModel is the default/fallback model
    // modelMap provides per-role overrides (opus/sonnet/haiku) that take priority
    const explicitModel = typeof cliConfig.model === "string" ? cliConfig.model : undefined;
    // Always pass modelMap - role mappings should work even when a default model is set
    const modelMap = {
      opus: cliConfig.modelOpus,
      sonnet: cliConfig.modelSonnet,
      haiku: cliConfig.modelHaiku,
      subagent: cliConfig.modelSubagent,
    };

    const proxy = await createProxyServer(
      port,
      cliConfig.monitor ? undefined : cliConfig.openrouterApiKey!,
      cliConfig.monitor ? undefined : explicitModel,
      cliConfig.monitor,
      cliConfig.anthropicApiKey,
      modelMap,
      {
        summarizeTools: cliConfig.summarizeTools,
        quiet: cliConfig.quiet,
        isInteractive: cliConfig.interactive,
        advisorModels: cliConfig.advisorModels,
        advisorCollector: cliConfig.advisorCollector,
      }
    );

    // Route diagnostic output to log file
    const diag = createDiagOutput({
      interactive: cliConfig.interactive,
      diagMode: cliConfig.diagMode,
    });
    if (cliConfig.interactive) {
      setDiagOutput(diag);
    }

    // Run Claude Code with proxy
    let exitCode = 0;
    try {
      exitCode = await runClaudeWithProxy(cliConfig, proxy.url, () => diag.cleanup());
    } finally {
      // Clear diagOutput BEFORE cleanup to prevent write-after-end
      setDiagOutput(null);
      diag.cleanup();
      // Always cleanup proxy
      if (!cliConfig.quiet) {
        console.log("\n[claudish] Shutting down proxy server...");
      }
      await proxy.shutdown();
    }

    if (!cliConfig.quiet) {
      console.log("[claudish] Done\n");
    }

    // Suggest sending logs if session had errors
    const sessionLogPath = getAlwaysOnLogPath();
    if (exitCode !== 0 && sessionLogPath && !cliConfig.quiet) {
      console.error(`\n[claudish] Session ended with errors. Log: ${sessionLogPath}`);
      console.error(`[claudish] To review: /debug-logs ${sessionLogPath}`);
    }

    process.exit(exitCode);
  } catch (error) {
    console.error("[claudish] Fatal error:", error);
    console.error("[claudish] Stack:", error instanceof Error ? error.stack : "no stack");
    process.exit(1);
  }
}
