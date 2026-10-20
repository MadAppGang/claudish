/** @jsxImportSource @opentui/react */
import { spawnSync } from "node:child_process";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { _resetAntigravityTokenState } from "../auth/antigravity-token.js";
import { getCodexOAuth } from "../auth/codex-oauth.js";
import { credentials } from "../auth/credentials/authority.js";
import { decideTuiRole, setCredentialPromptRole } from "../auth/credentials/prompt-role.js";
import { getKimiOAuth } from "../auth/kimi-oauth.js";
import { resetVertexProjectDiscovery } from "../auth/vertex-auth.js";
import { getConfigFileOverride } from "../config-override.js";
import { NO_ENV_FILE_FLAG, isCompiledEntry } from "../launch-env.js";
import { setStderrQuiet } from "../logger.js";
import { ensureEndpointsRegistered } from "../providers/endpoint-registration.js";
import { resetMuseCredentialState } from "../providers/meta-muse/muse-credentials.js";
import { _clearVertexDiscoveryCache } from "../providers/transport/vertex-discovery.js";
import { applyRendererThemeMode } from "../theme/renderer-theme.js";
import { App } from "./App.js";
import { invalidateProbeProxyHandlers, shutdownProbeProxy } from "./probe-proxy.js";
import type { ProviderLoginAction } from "./providers.js";

export function gcloudCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "gcloud.cmd" : "gcloud";
}

/**
 * The `claudish login <slug>` child of this process. Bun runs the script with
 * `--no-env-file`, as every claudish launch does (launch-env.ts), so the working
 * directory's env files stay out and the child keeps this run's config: an active
 * `--config` is passed on as the flag. A compiled binary is its own script, takes no
 * Bun flags, and reads no env files.
 */
export function loginCommand(
  slug: string,
  execPath: string,
  entry: string,
  configFile: string | null
): { command: string; args: string[] } {
  const tail = ["login", slug, ...(configFile ? ["--config", configFile] : [])];
  if (isCompiledEntry(entry)) return { command: execPath, args: tail };
  return { command: execPath, args: [NO_ENV_FILE_FLAG, entry, ...tail] };
}

/**
 * Start the config TUI. Re-entrant: if App requests a login,
 * we tear down the renderer, spawn the login command as a CHILD
 * process (clean stdio so the OAuth callback server doesn't fight with
 * OpenTUI's lifecycle), wait for it to exit, then start a fresh TUI.
 *
 * Child-process isolation avoids the ERR_CONNECTION_REFUSED issue that
 * the previous in-process attempt hit — the child gets a clean Node
 * runtime with no OpenTUI residue, and the parent doesn't need to
 * restart anything until the child cleanly exits.
 *
 * Cursor/tab state is NOT preserved across the boundary. After login,
 * the user lands back on the default tab. Acceptable because login is
 * rare and the state machine is small.
 */
export async function startConfigTui(): Promise<void> {
  // The config TUI may read a credential only inside an explicit user action,
  // in-process, before that action issues any proxy request
  // (`auth/credentials/prompt-role.ts`), and never inside an MCP session.
  setCredentialPromptRole(decideTuiRole());
  // Register bundled endpoints before the first render: the Providers tab is
  // built from `getAllProviders()`, so a catalog vendor the user has a key for
  // must already be in the provider list or it simply is not there to configure.
  // Re-entry after an OAuth login calls this again — idempotent by design.
  ensureEndpointsRegistered();

  // Silence proxy/handler stderr toasts ("[claudish] Error [Provider]: ...")
  // while the TUI owns the screen. Probe failures are still captured in the
  // testResults state and surfaced inline on each provider row — writing them
  // to stderr would corrupt the OpenTUI buffer and leave ghost characters on
  // screen (the renderer can't invalidate cells it didn't draw).
  setStderrQuiet(true);

  const loginRequest: { action: ProviderLoginAction | null } = {
    action: null,
  };

  const requestLogin = (action: ProviderLoginAction): void => {
    loginRequest.action = action;
  };

  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // Core shortcut handler
  });

  // Light/dark palette selection BEFORE first paint — the renderer runs the
  // OSC theme handshake; an unanswered query resolves null → dark (status quo).
  await applyRendererThemeMode(renderer);

  // When the renderer destroys (either via q/Ctrl-C or App calling
  // renderer.destroy() after setting loginRequest), control returns
  // here. If a login was requested, run it as a child process then
  // restart the TUI.
  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve());
    createRoot(renderer).render(<App requestLogin={requestLogin} />);
  });

  // Tear down the test-button probe proxy if it was started. Keeping it alive
  // across the renderer-destroy → re-render cycle (e.g. after OAuth login)
  // would leak the port; the next probe will lazily start a fresh proxy.
  await shutdownProbeProxy();

  // Restore stderr output for any post-TUI work (login child process, error
  // messages on quit). Re-suppressed at the top of the next recursive call.
  setStderrQuiet(false);

  if (loginRequest.action !== null) {
    const action = loginRequest.action;
    const command =
      action.kind === "gcloud-adc"
        ? "gcloud auth application-default login"
        : `claudish login ${action.slug}`;
    console.log(`\nLaunching: ${command}\n`);
    // stdio: "inherit" gives the child our terminal so inquirer prompts
    // and the OAuth callback server work normally.
    let result: ReturnType<typeof spawnSync>;
    if (action.kind === "gcloud-adc") {
      result = spawnSync(
        gcloudCommand(process.platform),
        ["auth", "application-default", "login"],
        {
          stdio: "inherit",
          // Windows .cmd scripts require a shell to execute.
          shell: process.platform === "win32",
        }
      );
    } else {
      const login = loginCommand(
        action.slug,
        process.execPath,
        process.argv[1],
        getConfigFileOverride()
      );
      result = spawnSync(login.command, login.args, { stdio: "inherit" });
    }
    if (result.error) {
      if (
        action.kind === "gcloud-adc" &&
        (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        console.error(
          "\ngcloud not found — install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install)\n"
        );
      } else {
        console.error(`\n❌ Failed to spawn login: ${result.error.message}\n`);
      }
    } else if (result.status !== 0) {
      console.error(`\n❌ Login exited with status ${result.status}\n`);
    } else if (action.kind === "gcloud-adc") {
      resetVertexProjectDiscovery();
      credentials.invalidate("vertex");
      _clearVertexDiscoveryCache();
      invalidateProbeProxyHandlers("vertex");
    } else {
      const slug = action.slug;
      // Login succeeded IN A CHILD PROCESS, which wrote a fresh token file this
      // long-lived parent never re-reads (the OAuth singletons load once at
      // startup). Reload the relevant singleton from disk so the re-entered TUI's
      // probe/request path uses the NEW token immediately — without this the
      // provider keeps failing auth until claudish is fully relaunched. Also drop
      // the probe-proxy's per-provider handler cache so the next test rebuilds
      // the transport with the fresh credential.
      if (slug === "antigravity") {
        // The login child wrote the shared keychain token. Drop the memoized
        // presence flag so the re-entered TUI sees it immediately, and rebuild
        // the probe handler with the fresh credential.
        _resetAntigravityTokenState();
        invalidateProbeProxyHandlers("antigravity");
      } else if (slug === "codex") {
        getCodexOAuth().reloadCredentials();
        invalidateProbeProxyHandlers("openai-codex");
      } else if (slug === "kimi") {
        getKimiOAuth().reloadCredentials();
        invalidateProbeProxyHandlers("kimi");
        invalidateProbeProxyHandlers("kimi-coding");
      } else if (slug === "muse") {
        // The child wrote meta-muse-oauth.json. Drop this process's minted key
        // and the authority's memo so the next test signs with the new login.
        resetMuseCredentialState();
        credentials.invalidate("meta-muse-code");
        invalidateProbeProxyHandlers("meta-muse-code");
      }
    }
    // Re-enter the TUI regardless of login outcome — failed login should
    // still let the user retry or set an API key instead.
    console.log("\nReturning to config…\n");
    await startConfigTui();
  }
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
  startConfigTui().catch((err) => {
    console.error("TUI error:", err);
    process.exit(1);
  });
}
