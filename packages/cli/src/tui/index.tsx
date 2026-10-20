/** @jsxImportSource @opentui/react */
import { spawnSync } from "node:child_process";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { _resetAntigravityTokenState } from "../auth/antigravity-token.js";
import { getCodexOAuth } from "../auth/codex-oauth.js";
import { credentials } from "../auth/credentials/authority.js";
import { setCredentialPromptRole } from "../auth/credentials/prompt-role.js";
import { getKimiOAuth } from "../auth/kimi-oauth.js";
import { setStderrQuiet } from "../logger.js";
import { applyRendererThemeMode } from "../theme/renderer-theme.js";
import type { ProviderDef } from "./providers.js";

/** The `claudish login <slug>` argument, derived from the provider catalog. */
type LoginSlug = NonNullable<ProviderDef["oauthSlug"]>;
import { ensureEndpointsRegistered } from "../providers/endpoint-registration.js";
import { resetMuseCredentialState } from "../providers/meta-muse/muse-credentials.js";
import { App } from "./App.js";
import { invalidateProbeProxyHandlers, shutdownProbeProxy } from "./probe-proxy.js";

/**
 * Start the config TUI. Re-entrant: if App requests an OAuth login,
 * we tear down the renderer, spawn `claudish login {slug}` as a CHILD
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
  // (`auth/credentials/prompt-role.ts`).
  setCredentialPromptRole("tui");
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

  // Derived from the catalog's `oauthLoginSlug` — see the note on
  // `ProviderDef.oauthSlug`. These were hand-written unions that had drifted to
  // name a removed provider (`gemini`) while missing newer slugs.
  const loginRequest: { slug: LoginSlug | null } = {
    slug: null,
  };

  const requestLogin = (slug: LoginSlug): void => {
    loginRequest.slug = slug;
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

  if (loginRequest.slug !== null) {
    const slug = loginRequest.slug;
    console.log(`\nLaunching: claudish login ${slug}\n`);
    // Spawn the same runtime + script with `login {slug}`. stdio: "inherit"
    // gives the child our terminal so inquirer prompts and the OAuth
    // callback server work normally.
    const result = spawnSync(process.argv[0], [process.argv[1], "login", slug], {
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`\n❌ Failed to spawn login: ${result.error.message}\n`);
    } else if (result.status !== 0) {
      console.error(`\n❌ Login exited with status ${result.status}\n`);
    } else {
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
