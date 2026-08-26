#!/usr/bin/env bun

// Load .env file before anything else (quiet mode to suppress verbose output)
import { config } from "dotenv";
config({ quiet: true }); // Loads .env from current working directory

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveExplicitFlagAuth } from "./auth/credentials/op-source.js";
import { resolveClassifierConfig } from "./classifier-passthrough.js";
import {
  beginSpan,
  finalizeStartupTrace,
  suppressStartupTraceTerminalOutput,
  traceSpan,
} from "./startup-trace.js";

// ── Startup-timing analytics (startup-trace.ts) ─────────────────────────────
// Every launch appends one JSON line to ~/.claudish/startup-metrics.jsonl; a
// >8s startup prints a one-line diagnosis; CLAUDISH_STARTUP_TRACE=1 prints the
// full phase table. The two paths with a well-defined "ready" point (config →
// pre-TUI-mount, run → proxy-up) finalize explicitly below; this exit hook is
// the fallback so every OTHER launch kind (update, login, --probe, --version,
// team, …) still writes its line at exit. Idempotent — an explicit finalize
// wins. quiet:true → the fallback never prints the slow-start stderr line
// (a management command's total isn't "startup"), but the opt-in table still
// prints. MCP/serve are excluded: they run for hours, so an at-exit total is
// process lifetime, not startup, and would pollute the metrics.
function classifyStartupKind(): string {
  const argv = process.argv.slice(2);
  const first = argv.find((a) => !a.startsWith("-"));
  if (first === "config") return "config";
  const management = new Set([
    "update",
    "init",
    "profile",
    "telemetry",
    "stats",
    "providers",
    "keychain",
    "login",
    "logout",
    "quota",
    "usage",
  ]);
  if ((first && management.has(first)) || argv.includes("--mcp") || first === "serve") {
    return "other";
  }
  return "run";
}
process.on("exit", () => {
  const argv = process.argv.slice(2);
  const longRunningServer =
    argv.includes("--mcp") || argv.find((a) => !a.startsWith("-")) === "serve";
  if (longRunningServer) return;
  finalizeStartupTrace(classifyStartupKind(), { quiet: true });
});

// The 1Password SDK-auth resolver, the multi-account picker, and the
// config-driven hydration (loadStoredApiKeys / applyCustomEndpointOpKeys /
// hydrateOpSecrets) all moved to auth/credentials/op-source.ts in the
// async-credential-layer refactor. Config-driven op:// keys are now resolved
// ON DEMAND by the credential authority (per provider, lazy SDK) — there is no
// per-entry-point push into process.env anymore. Only the EXPLICIT --op /
// --op-env flags below still hydrate eagerly (direct user intent), and they
// share op-source's memoized auth via resolveExplicitFlagAuth().

/**
 * 1Password Environments are now POINT-OF-NEED, not eager. This function no
 * longer resolves anything or touches the SDK — it ONLY validates the `--op-env`
 * flag shape. Both sources are discovered and resolved lazily by the credential
 * authority, exactly when a routed provider's key misses env/config:
 *   1. `onepasswordEnvironments[]` config — read directly by the resolver.
 *   2. `--op-env <id>` flag — parsed from argv by the resolver.
 * (see auth/credentials/op-source.ts `registeredEnvironmentEntries` /
 * `resolveEnvironmentShared`).
 *
 * Why: the old eager hydration ran the SDK (DesktopAuth prompt) at the top of
 * EVERY process launch whenever a config environment existed — so `--update`,
 * `--version`, `--help`, and OAuth-only (codex) sessions all prompted, and every
 * spawned team/channel child re-prompted (the "storm"). Point-of-need touches
 * 1Password only when a key is actually needed; no-key runs never prompt. This
 * also changes precedence: environments are now a lazy op source (env/config
 * already set wins), not a startup overwrite.
 */
async function applyOpEnvironment(): Promise<void> {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== "--op-env" && !a.startsWith("--op-env=")) continue;
    const val = a === "--op-env" ? argv[i + 1] : a.slice("--op-env=".length);
    if (val === undefined || val === "" || val.startsWith("-")) {
      console.error("[claudish] --op-env requires a 1Password Environment ID");
      process.exit(1);
    }
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
      const auth = await resolveExplicitFlagAuth();
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
    const { resolveGlobImport, recordOpHydratedVars } = await import("./providers/onepassword.js");
    const auth = await resolveExplicitFlagAuth();
    const resolved = await resolveGlobImport(glob, { auth });
    for (const [key, value] of Object.entries(resolved)) {
      process.env[key] = value;
    }
    recordOpHydratedVars(Object.keys(resolved));
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
//
// These four are LAZY BY NEED: each inspects its source (the --op-env / --op
// flags, then config.json's op:// refs + glob imports, then custom-endpoint
// op:// keys) and returns IMMEDIATELY when there is nothing to resolve — without
// importing the 1Password SDK or its ~10MB WASM. So a user who doesn't use
// 1Password at all pays nothing here. The SDK + WASM load only at the moment a
// key is actually resolved, inside the sdkLoader (providers/onepassword.ts).
//
// Hydration is split by WHO asked:
//
//  - EXPLICIT FLAGS (--op-env / --op) are direct user intent and self-terminate
//    (--op --list previews and exits; a bare --op import applies then exits), so
//    they run EAGERLY here. Both are zero-cost when their flag is absent (they
//    read argv and return immediately), so a flagless management command pays
//    nothing.
//
//  - CONFIG-DRIVEN sources (config.json `onepassword[]` globs + apiKeys, and
//    custom-endpoint op:// keys) are ONLY needed by commands that actually route
//    a model and read a provider key from process.env: the proxy/CLI path
//    (runCli), the MCP server, and `serve`. Management subcommands — update,
//    init, profile, config, telemetry, stats, providers, login/logout, quota,
//    help, version — never use a provider key, so they must NOT trigger
//    1Password (no auth prompt, no SDK, no WASM, no glob expansion). We DEFER
//    those into hydrateOpSecrets() and call it ONLY from the routing paths
//    (an allowlist), instead of resolving for every command and trying to
//    deny-list the rest.
// `--config <file>` / `CLAUDISH_CONFIG`: for THIS run only, read config from the
// given file instead of the machine's ~/.claudish/config.json, and ignore the
// project .claudish.json. Must run before ANY config read — parseArgs and the op
// resolution below both load config — and the flag is stripped from argv so the
// child `claude` never sees it. The file's `apiKeys` resolve through the normal
// env→config chain, so it can carry literal provider keys directly.
async function applyConfigOverride(): Promise<void> {
  const { planConfigOverride, setConfigFileOverride } = await import("./config-override.js");
  const plan = planConfigOverride(process.argv.slice(2), process.env, {
    resolve,
    exists: existsSync,
  });
  if (plan.kind === "none") return;
  if (plan.kind === "error") {
    console.error(plan.message);
    process.exit(1);
  }

  // Strip the flag so parseArgs never sees it and the child `claude` never
  // inherits it (a no-op when the override came from CLAUDISH_CONFIG).
  if (plan.fromFlag) process.argv = [...process.argv.slice(0, 2), ...plan.argv];

  // Set the single, process-wide override authority. Every config reader
  // (profile-config, op-source's hasOpSources sniff + point-of-need environment
  // ids, onepassword-config's defaultOpConfigPaths) consults it, so
  // applyOpEnvironment()/applyOpImport() below — and the credential authority's
  // op:// step — read the OVERRIDE file. A file that names no op:// source makes
  // hasOpSources() false, so 1Password is never touched: no auth prompt. This is
  // why the override is fundamental, not a "disable 1Password" flag.
  setConfigFileOverride(plan.path);

  // Propagate to the whole process tree via the (absolute) env fallback: team
  // mode and channel sessions spawn CHILD `claudish` processes, which re-read
  // CLAUDISH_CONFIG here and apply the same override. The child `claude` ignores
  // it. Absolute so a child with a different cwd still resolves the same file.
  process.env.CLAUDISH_CONFIG = plan.path;
}

await traceSpan("startup:config-override", () => applyConfigOverride());
await traceSpan("startup:op-env-flags", () => applyOpEnvironment());
await traceSpan("startup:op-import-flag", () => applyOpImport());

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
// Keychain subcommand: claudish keychain status|list|import|set|rm|enable|disable
const isKeychainCommand = firstPositional === "keychain";
// Behavior subcommand: claudish behavior rules|corpus (Layer 4 introspection)
const isBehaviorCommand = firstPositional === "behavior";
// Team subcommand: claudish team run|run-and-judge (multi-model orchestration)
const isTeamCommand = firstPositional === "team";
// Auth subcommands: claudish login [provider], claudish logout [provider]
const isLoginCommand = firstPositional === "login";
const isLogoutCommand = firstPositional === "logout";
// Quota subcommand: claudish quota [provider]
const isQuotaCommand = firstPositional === "quota" || firstPositional === "usage";
// Legacy auth flags (deprecated, redirect to new subcommands)
// NOTE: --gemini-login/--gemini-logout were removed with the Gemini Code Assist
// provider (Google retired it for individuals). The Gemini subscription flow is
// `claudish login antigravity`.
const isLegacyKimiLogin = args.includes("--kimi-login");
const isLegacyKimiLogout = args.includes("--kimi-logout");

if (isMcpMode) {
  // MCP server mode - dynamic import to keep CLI fast. Provider keys (incl.
  // op://) are resolved ON DEMAND by the credential authority when a tool routes
  // a model — no startup hydration, so the server can never die at boot on a
  // multi-account 1Password ambiguity.
  import("./mcp-server.js").then(async (mcp) => {
    mcp.startMcpServer();
    // Observability seam for the MCP e2e harness. Spans are BUFFERED until
    // finalize, and the MCP path — unlike every other entry point — never
    // finalizes, because a long-lived server has no "startup done" moment that
    // maps onto the CLI's. That made every later span (op:auth-resolve,
    // op:resolve(NAMES), op:sdk-wasm-import) invisible: measured, an MCP server
    // launched with CLAUDISH_STARTUP_TRACE=1 emitted zero trace lines.
    //
    // Finalizing here flips the trace into live-print mode, so spans raised by
    // on-demand credential resolution stream to stderr as they happen — which is
    // the only way to tell "resolved from 1Password" apart from "found it in
    // env" without asserting on prose. Gated on the flag so production MCP runs
    // are byte-identical; quiet so the slow-start line never lands on a stdio
    // transport that a host is parsing.
    if (process.env.CLAUDISH_STARTUP_TRACE === "1") {
      const { finalizeStartupTrace } = await import("./startup-trace.js");
      finalizeStartupTrace("mcp", { quiet: true });
    }
  });
} else if (isServeCommand) {
  // Standalone inference gateway for Claude Desktop redirect:
  // claudish serve --port <n> --models <path>. Keys resolve on demand per route.
  const serveArgIndex = args.indexOf("serve");
  import("./serve-command.js").then((m) =>
    m.serveCommand(args.slice(serveArgIndex + 1)).catch((e) => {
      console.error(`[claudish serve] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    })
  );
} else if (isBehaviorCommand) {
  // Layer 4 introspection: claudish behavior rules|corpus. Read-only unless
  // --write is passed to `corpus`.
  const behaviorArgIndex = args.indexOf("behavior");
  import("./behavior-command.js").then((m) =>
    m.behaviorCommand(args.slice(behaviorArgIndex + 1)).catch((e) => {
      console.error(`[claudish behavior] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    })
  );
} else if (isTeamCommand) {
  // Multi-model orchestration: claudish team run|run-and-judge. Routed here
  // because an UNROUTED subcommand does not error — it falls through to the
  // default path and `team run --models a,b` silently becomes a catalog search
  // for the literal string "a,b", which reads like a working command.
  const teamArgIndex = args.indexOf("team");
  import("./team-cli.js").then((m) =>
    m.teamCommand(args.slice(teamArgIndex + 1)).catch((e) => {
      console.error(`[claudish team] ${e instanceof Error ? e.message : String(e)}`);
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
} else if (isKeychainCommand) {
  // macOS Keychain backend: claudish keychain status|list|import|set|rm|enable|disable
  const keychainArgIndex = args.indexOf("keychain");
  import("./keychain-command.js").then((m) =>
    m.keychainCommand(args.slice(keychainArgIndex + 1)).catch((e) => {
      console.error(`[claudish keychain] ${e instanceof Error ? e.message : String(e)}`);
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
} else if (isLegacyKimiLogin) {
  // Deprecated --kimi-login flag — redirect to the new subcommand
  console.log("Note: --kimi-login is deprecated. Use: claudish login kimi");
  import("./auth/auth-commands.js").then((m) => m.loginCommand("kimi").catch(handlePromptExit));
} else if (isLegacyKimiLogout) {
  // Deprecated --kimi-logout flag — redirect to the new subcommand
  console.log("Note: --kimi-logout is deprecated. Use: claudish logout kimi");
  import("./auth/auth-commands.js").then((m) => m.logoutCommand("kimi").catch(handlePromptExit));
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
  // Interactive configuration TUI: claudish config (full-screen btop-inspired TUI).
  //
  // The Providers screen reads readiness SYNCHRONOUSLY from process.env, but a
  // 1Password glob (op://Vault/Item/**) hides which env vars it contains until
  // resolved. So before mounting, resolve EACH known provider's credentials
  // through the credential authority concurrently — each call pulls that
  // provider's op:// key on demand (lazy SDK) and writes it through to
  // process.env. This is the on-demand path (no "resolve everything" glob pass);
  // it's a zero-cost no-op when no 1Password source exists. allowOpPrompt lets
  // the (TTY) config TUI prompt for a multi-account pick if needed.
  //
  // Startup-trace ORDERING: finalizeStartupTrace runs AFTER credential
  // resolution but BEFORE startConfigTui() mounts the OpenTUI fullscreen — the
  // slow-start line / trace table must hit stderr before the TUI owns the
  // screen, or they'd corrupt the render buffer.
  traceSpan("startup:tui-import", () => import("./tui/index.js")).then(async (m) => {
    // Terminal background capture, BEFORE OpenTUI mounts.
    //
    // The TUI takes its light/dark answer from OpenTUI's own handshake
    // (`applyRendererThemeMode`), which returns ONLY that bit — never the
    // background COLOUR. So this path never populated it, and the page fell
    // back to a hardcoded #ffffff that sat as a visible white slab inside a
    // cream terminal. `detectAndSetThemeMode` runs the OSC 11 query and records
    // the measured colour; OpenTUI still refines the MODE afterwards, and
    // `applyTuiTheme` only paints the colour when the two agree.
    //
    // It must run HERE, before `createCliRenderer`: the query puts stdin in raw
    // mode and reads it, which would fight OpenTUI for the input stream once
    // the renderer owns it.
    await traceSpan("startup:theme-detect", async () => {
      const { detectAndSetThemeMode } = await import("./theme/theme-mode.js");
      await detectAndSetThemeMode();
    });
    const { credentials } = await import("./auth/credentials/authority.js");
    // Register runtime providers BEFORE the sweep below, not after.
    //
    // `startConfigTui()` also calls `ensureEndpointsRegistered()`, but it does so
    // INSIDE the function — i.e. after this sweep has already run. So a bundled
    // catalog row or a user `customEndpoints` entry whose key lives only in
    // 1Password was enumerated by the TUI and then shown as not-configured,
    // because the one pass that resolves op:// keys had finished before the
    // provider existed. The latch makes the second call free.
    const { ensureEndpointsRegistered } = await import("./providers/endpoint-registration.js");
    ensureEndpointsRegistered();
    const { getProviderDefs } = await import("./tui/providers.js");
    const tuiProviders = getProviderDefs();
    await traceSpan(
      "startup:credential-resolution",
      () =>
        Promise.all(
          tuiProviders.map((p) => credentials.isAvailable(p.catalogName, { allowOpPrompt: true }))
        ),
      { providers: tuiProviders.length }
    );
    finalizeStartupTrace("config");
    // From here the OpenTUI fullscreen owns the terminal: NO trace line may hit
    // it (a live-printed span under CLAUDISH_STARTUP_TRACE=1 overwrites TUI
    // rows). Spans emitted during the TUI session are still buffered and, with
    // --debug, mirrored to the log file. The finalize table/slow-line above
    // already printed pre-mount, so nothing user-visible is lost.
    suppressStartupTraceTerminalOutput();
    return m.startConfigTui().catch(handlePromptExit);
  });
} else {
  // CLI mode
  runCli();
}

/**
 * Run CLI mode
 */
async function runCli() {
  const endImports = beginSpan("startup:cli-imports");
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
  endImports();

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
    // Terminal light/dark detection BEFORE any colored output — parseArgs
    // handles --help/--models/--probe, which print colored text and exit
    // inside. Cheap env sources always run; the OSC round-trip (bounded
    // 150ms) only when stdin AND stdout are OUR TTYs, so a piped/proxied
    // claudish never writes escapes into another program's stream.
    await traceSpan("startup:theme-detect", async () => {
      const { detectAndSetThemeMode } = await import("./theme/theme-mode.js");
      await detectAndSetThemeMode();
    });

    // Parse CLI arguments (includes profile/config load; terminal flags like
    // --version/--models/--probe exit inside — the exit-hook fallback covers them)
    const cliConfig = await traceSpan("startup:parse-args", () => parseArgs(process.argv.slice(2)));

    // Register the bundled endpoint catalog before ANYTHING enumerates or
    // validates providers. Two consumers below need it and both run long before
    // the proxy (which has always registered endpoints for the request path):
    // the interactive picker enumerates the roster, and `validateApiKeysForModels`
    // decides whether an explicit `vendor@model` has a credential — a provider
    // that is not registered yet reads as an unknown one.
    //
    // Placed AFTER parseArgs on purpose: terminal flags (`--version`, `--models`,
    // `--probe`) exit inside it, so those paths pay nothing for a roster they
    // never show. Sync, config-only, idempotent; dynamically imported like every
    // other heavy module in runCli.
    await traceSpan("startup:endpoint-registration", async () => {
      const { ensureEndpointsRegistered } = await import("./providers/endpoint-registration.js");
      ensureEndpointsRegistered();
    });

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
      console.log("\nTeam Status");
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
    // Skip in single-shot/print mode too: a machine-driven run (e.g. madbench:
    // `--print --output-format stream-json`, prompt piped on stdin without
    // claudish's own --stdin flag) has no human to answer, and the readline
    // would steal the prompt from the child `claude`'s stdin and hang.
    const rawArgs = process.argv.slice(2);
    const explicitNoAutoApprove = rawArgs.includes("--no-auto-approve");
    if (
      cliConfig.autoApprove &&
      !explicitNoAutoApprove &&
      !cliConfig.stdin &&
      cliConfig.interactive
    ) {
      const { loadConfig, saveConfig } = await import("./profile-config.js");
      try {
        const cfg = loadConfig();
        if (!cfg.autoApproveConfirmedAt) {
          // First run — show one-time confirmation (human wait: traced so a
          // slow first launch is attributable to this prompt, not claudish).
          const endConfirm = beginSpan("startup:first-run-confirm", {
            mayIncludeUserPrompt: true,
          });
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
          endConfirm();
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
      await traceSpan("startup:update-check", () =>
        checkForUpdates(getVersion(), { quiet: cliConfig.quiet })
      );
    }

    // Check if Claude Code is installed
    if (!(await traceSpan("startup:claude-detect", () => checkClaudeInstalled()))) {
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
      // Human wait (the interactive picker) + per-provider credential probes.
      cliConfig.model = (await traceSpan(
        "startup:model-select",
        () => selectModel({ freeOnly: cliConfig.freeOnly }).catch(handlePromptExit),
        { mayIncludeUserPrompt: true }
      )) as string;
      console.log(""); // Empty line after selection
    }

    // In non-interactive mode, model must be specified (via --model, env var, or profile)
    if (!cliConfig.interactive && !cliConfig.monitor && !cliConfig.model && !hasProfileTiers) {
      console.error("Error: Model must be specified in non-interactive mode");
      console.error("Use --model <model> flag, set CLAUDISH_MODEL env var, or use --profile");
      console.error("Try: claudish --models");
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

      // === API-key validation (1Password resolved on demand, point of need) ===
      // validateApiKeysForModels is async and pulls from 1Password ITSELF for any
      // routed model whose key is missing — seeking ONLY that model's env var,
      // through the single op-source seam (lazy SDK). So:
      //   - ollama@... / any keyless model       → no key needed → no 1Password
      //   - a key already in process.env         → not missing → no 1Password
      //   - a missing key an op:// source supplies → resolved + written to env
      // parseArgs has already exited terminal flags, so --version etc. never
      // reach here at all (laziness preserved without an ordering chokepoint).
      const resolutions = await traceSpan(
        "startup:validate-api-keys",
        () => validateApiKeysForModels(modelsToValidate),
        { models: modelsToValidate.filter((m) => typeof m === "string").length }
      );
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
          const stillMissing = getMissingKeyResolutions(
            await validateApiKeysForModels(modelsToValidate)
          );
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
      // Blocks on the PIPE producer — slow here means the caller, not claudish.
      const stdinInput = await traceSpan("startup:stdin-read", () => readStdin());
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
    //   "skipped"   — local model or --models-skip-update
    //   "hard_fail" — missing cache + network failure → exit 1
    const warmOutcome = await traceSpan("startup:catalog-warm", () =>
      warmCatalogIfNeeded(cliConfig)
    );
    if (warmOutcome === "hard_fail") {
      process.exit(1);
    }

    // Find available port
    const port =
      cliConfig.port ||
      (await traceSpan("startup:find-port", () =>
        findAvailablePort(DEFAULT_PORT_RANGE.start, DEFAULT_PORT_RANGE.end)
      ));

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

    // A bare `--resume` opens the session picker before anything else starts. Doing it
    // here — after config resolution but BEFORE the proxy — means a cancelled pick costs
    // nothing: no port bound, no child spawned. The picker returns a concrete id, which
    // is appended as the explicit `--resume <id>` form the child understands.
    // The session id claudish KNOWS it launched, when it knows one — from the picker, or
    // from an explicit `--resume <id>`. Preferred over guessing by mtime, which cannot
    // tell this session's transcript from a concurrent one in the same directory.
    let resumedSessionId: string | null = (() => {
      const i = cliConfig.claudeArgs.indexOf("--resume");
      const v = i !== -1 ? cliConfig.claudeArgs[i + 1] : undefined;
      return v && !v.startsWith("-") ? v : null;
    })();

    if (cliConfig._resumePicker) {
      // THE PICKER IS AN UPGRADE OF `--resume`, NEVER A REPLACEMENT FOR IT.
      //
      // Every path that cannot show a full-screen TUI must forward the bare flag and let
      // Claude Code handle it, because that is what `claudish --resume` did before this
      // feature existed. Two ways to get here without a usable screen:
      //
      //   - NOT A TTY. `claudish -p --resume --output-format stream-json | jq` would
      //     otherwise write alternate-screen escapes into the stdout that print mode
      //     reserves for machine-readable output, and then block forever waiting for a
      //     keypress that cannot arrive. Same for any CI shell or a piped run.
      //   - NOT A GIT REPOSITORY. `getRepoContext` returns null, which made the picker
      //     report "no sessions" and `exit(0)` — turning a previously working flag into
      //     a silent no-op in every non-git directory. Sessions may well exist there;
      //     claudish just has no worktree structure to group them by.
      const canDrawTui = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!canDrawTui || cliConfig._hasPrintFlag || !cliConfig.interactive) {
        cliConfig.claudeArgs.push("--resume");
      } else {
        const { runResumePicker } = await import("./session/resume-picker-run.js");
        const outcome = await runResumePicker();
        if (!outcome.hadSessions) {
          // Nothing to group, or not a repository — hand the flag over rather than
          // deciding on Claude Code's behalf that there is nothing to resume.
          cliConfig.claudeArgs.push("--resume");
        } else if (!outcome.sessionId) {
          // Cancelled. Exit 0 — declining to pick is not an error, and forwarding the
          // flag here would reopen a picker the user just dismissed.
          process.exit(0);
        } else {
          cliConfig.claudeArgs.push("--resume", outcome.sessionId);
          resumedSessionId = outcome.sessionId;
        }
      }
    }

    const proxy = await traceSpan("startup:proxy-start", () =>
      createProxyServer(
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
          // Present only when `--model` was a pinned chain; `explicitModel` above
          // is its first element, so the proxy can match the two.
          modelChain: cliConfig.monitor ? undefined : cliConfig.modelChain,
          classifier: resolveClassifierConfig(cliConfig, process.env),
          effortOverride: cliConfig.effortOverride,
          modelParams: cliConfig.modelParams,
          proOnUltracode: cliConfig.proOnUltracode,
        }
      )
    );

    // Route diagnostic output to log file
    const diag = createDiagOutput({
      interactive: cliConfig.interactive,
      diagMode: cliConfig.diagMode,
    });
    if (cliConfig.interactive) {
      setDiagOutput(diag);
    }

    // Startup is "ready": the proxy is up and Claude Code launches next. Print
    // any slow-start diagnosis BEFORE Claude Code takes over the terminal.
    finalizeStartupTrace("run", { quiet: cliConfig.quiet });

    // Run Claude Code with proxy
    let exitCode = 0;
    try {
      exitCode = await runClaudeWithProxy(cliConfig, proxy.url, () => diag.cleanup());
    } finally {
      // Clear diagOutput BEFORE cleanup to prevent write-after-end
      setDiagOutput(null);
      diag.cleanup();
      // Always cleanup proxy. Route claudish's own chatter to stderr in
      // single-shot mode — stdout there carries Claude Code's machine-readable
      // output (e.g. --output-format stream-json) that consumers parse line-by-line.
      if (!cliConfig.quiet) {
        const write = cliConfig.interactive ? console.log : console.error;
        write("\n[claudish] Shutting down proxy server...");
      }
      await proxy.shutdown();
    }

    if (!cliConfig.quiet) {
      const write = cliConfig.interactive ? console.log : console.error;
      write("[claudish] Done\n");
      // The end-of-session card. Printed here, after `proxy.shutdown()`, for the same
      // reason the probe prints its results after tearing its renderer down: nothing is
      // drawing to the terminal any more, so this lands in the scrollback intact.
      //
      // It reads `~/.claudish/tokens-<port>.json`, which TokenTracker leaves behind, and
      // returns null when that file records nothing — a session that never got a
      // response prints no card rather than a card full of zeroes. Never fatal: a
      // summary that throws must not change the exit code of the user's actual work.
      //
      // Imported dynamically, like everything else heavy in this file: the summary
      // reaches the viz layer, which imports `@opentui/core` for its colour maths.
      // A static import here would pull OpenTUI into `--version`, `--update` and every
      // other run that never draws anything.
      try {
        const [{ readSessionStats }, { printSessionSummary }, { findLatestSessionId }] =
          await Promise.all([
            import("./session/session-stats.js"),
            import("./session/session-summary.js"),
            import("./session/session-discovery.js"),
          ]);
        const stats = readSessionStats(port);
        if (stats) {
          printSessionSummary(
            {
              stats,
              modelSpec: explicitModel || stats.modelName || "",
              // Only an EXPLICIT `--model` is safe to reprint. `stats.modelName` is
              // prefix-stripped by TokenTracker, so reusing it here would emit a bare
              // name that re-routes from scratch — and a profile-role session
              // (modelOpus/modelSonnet/…) has no single spec to print at all.
              resumeModelSpec: explicitModel ?? null,
              resumeId:
                resumedSessionId ??
                findLatestSessionId(process.cwd(), Date.now() - stats.durationMs),
              exitCode,
            },
            write
          );
        }
      } catch (e) {
        console.error(`[claudish] session summary unavailable: ${e}`);
      }
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
