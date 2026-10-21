/**
 * Antigravity login — DELEGATES to the Antigravity CLI (`agy`).
 *
 * claudish runs NO OAuth flow of its own for Antigravity and ships NO Antigravity
 * secret. Antigravity's client_secret is a static literal baked into the agy
 * binary, and agy AUTO-UPDATES — each release rotates the secret and Google
 * revokes the old one — so any embedded/PKCE flow claudish owned would break
 * within days. There is no dynamic client registration.
 *
 * So agy OWNS authentication (it always ships the current secret). agy has no
 * `login` subcommand: on first run it checks the keychain and, if there's no
 * valid session, opens the browser to sign in, then writes the token to the
 * SHARED keychain store (service=gemini, account=antigravity, go-keyring-base64)
 * that claudish reads. `claudish login antigravity` therefore:
 *   1. short-circuits if a valid shared token already exists;
 *   2. locates agy (`which agy` → ~/.local/bin/agy), offering to install it via
 *      the official installer if absent (with confirmation);
 *   3. triggers agy's first-run auth (spawns agy with inherited stdio so the user
 *      completes the browser sign-in) — a single-shot run first, then interactive
 *      agy as a fallback;
 *   4. polls the shared store until the token appears (~3 min shared budget).
 *
 * logout() just clears the shared store — agy's own logout is its `/logout` TUI
 * command; claudish only drops the shared token it reads.
 *
 * Every side effect (locate / install / spawn agy / read store / clock / sleep /
 * confirm / exit) is behind an injectable `deps` object so the orchestration can
 * be smoke-tested without spawning real processes or waiting minutes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import {
  type AntigravityToken,
  type AntigravityTokenDeps,
  _resetAntigravityTokenState,
  deleteSharedAntigravityToken,
  getValidAntigravityAccessToken,
  locateAgyBinary,
  readSharedAntigravityToken,
} from "./antigravity-token.js";
import { getServedAntigravityModels, setupAntigravityUser } from "./antigravity-user.js";

/**
 * Resolve a concrete CURRENT served model id for the success message, LIVE from
 * the backend (its `defaultAgentModelId`, e.g. gemini-3.6-flash-high) — no
 * hardcoded model list. Best-effort: any failure (no token, offline) → `<model>`.
 */
async function defaultSuggestModel(): Promise<string> {
  try {
    // `getValidAntigravityAccessToken`, not a raw store read: it also captures
    // agy's client version, and the backend's default depends on that version.
    const token = await getValidAntigravityAccessToken();
    const { projectId } = await setupAntigravityUser(token);
    const { servedIds, defaultId } = await getServedAntigravityModels(token, projectId);
    return defaultId || servedIds[0] || "<model>";
  } catch {
    return "<model>";
  }
}

/** The official Antigravity CLI installer + docs. */
const INSTALL_CMD = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
const INSTALL_DOCS = "https://antigravity.google/docs/cli/install";

/** Injectable side-effect seams for the login delegation. */
export interface AntigravityLoginDeps {
  /** Locate the agy binary path, or null if not installed. */
  locateAgy: () => string | null;
  /** True when a valid shared Antigravity token is already present. */
  hasToken: () => boolean;
  /** Read the current shared token fresh (no memo), or null. */
  readToken: () => AntigravityToken | null;
  /**
   * A concrete, CURRENT served model to show in the success message (e.g.
   * `gemini-3.6-flash-high`) — discovered LIVE from the backend's own default,
   * never hardcoded. Optional: defaults to the live resolver; falls back to the
   * literal `<model>` placeholder.
   */
  suggestModel?: () => Promise<string>;
  /** Ask the user to confirm installing agy (interactive y/n). */
  confirmInstall: () => Promise<boolean>;
  /** Run the official agy installer (inherited stdio). Returns success. */
  runInstall: () => boolean;
  /**
   * Trigger agy's first-run auth (inherited stdio, blocking). `interactive=false`
   * is the single-shot `agy -p "hello" --print-timeout 3m` attempt;
   * `interactive=true` starts agy interactively for the user to sign in + exit.
   */
  runAgyAuth: (agyPath: string, interactive: boolean) => void;
  /** Drop the memoized presence flag once a token appears. */
  onAuthenticated: () => void;
  /** True when stdin is a TTY (gates the install prompt). */
  isInteractive: () => boolean;
  /** Current time in ms (defaults to Date.now) — the poll deadline seam. */
  now: () => number;
  /** Sleep helper (seam so smoke/tests don't wait). */
  sleep: (ms: number) => Promise<void>;
  /**
   * Terminate the process non-fatally (defaults to process.exit). The login owns
   * its own outcome messaging and exits before the generic wrapper prints its
   * boilerplate success line, so a still-unauthenticated outcome is never
   * reported as "✅ login successful".
   */
  exit: (code: number) => void;
  /**
   * Poll timing. The ~3-minute sign-in window is owned by agy's OWN blocking
   * spawn (`--print-timeout 3m`), which returns only after the user finishes and
   * agy has written the token. `graceMs` is just the short post-spawn window to
   * absorb any keychain-write lag before we decide the attempt didn't land;
   * `intervalMs` is the poll cadence.
   */
  timing: { graceMs: number; intervalMs: number };
}

/** Print the manual-install guidance (used when auto-install is skipped/failed). */
function printManualInstall(): void {
  console.log("\nInstall the Antigravity CLI, then retry `claudish login antigravity`:");
  console.log(`  ${INSTALL_CMD}`);
  console.log(`  Docs: ${INSTALL_DOCS}`);
}

/** Default: confirm install via an interactive y/n prompt. */
async function defaultConfirmInstall(): Promise<boolean> {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({
    message: `Install the Antigravity CLI now? (runs: ${INSTALL_CMD})`,
    default: true,
  });
}

/** Default: run the official installer via bash (inherited stdio). */
function defaultRunInstall(): boolean {
  const res = spawnSync("bash", ["-c", INSTALL_CMD], { stdio: "inherit" });
  return !res.error && res.status === 0;
}

/** Default: spawn agy to trigger its first-run browser auth (blocking). */
function defaultRunAgyAuth(agyPath: string, interactive: boolean): void {
  if (interactive) {
    // Interactive session — the user signs in, then exits agy to return here.
    spawnSync(agyPath, [], { stdio: "inherit" });
  } else {
    // Single-shot: agy signs in (browser) then answers + exits within the timeout.
    spawnSync(agyPath, ["-p", "hello", "--print-timeout", "3m"], { stdio: "inherit" });
  }
}

const defaultLoginDeps: AntigravityLoginDeps = {
  locateAgy: locateAgyBinary,
  // Reads the store rather than the 5s-memoized hasSharedAntigravityToken(): the
  // "already authenticated?" short-circuit must see a just-logged-out store
  // immediately, otherwise a login right after a logout falsely reports "already
  // logged in". A logout drops the read memo as part of deleting the item, so
  // this stays true even though the raw read is itself burst-memoized.
  hasToken: () => readSharedAntigravityToken() != null,
  // agy writes the store from ANOTHER process, so neither memo can observe the
  // new token on its own: reset first, then read, and a subsequent
  // hasSharedAntigravityToken() reflects it at once too.
  readToken: () => {
    _resetAntigravityTokenState();
    return readSharedAntigravityToken();
  },
  suggestModel: defaultSuggestModel,
  confirmInstall: defaultConfirmInstall,
  runInstall: defaultRunInstall,
  runAgyAuth: defaultRunAgyAuth,
  onAuthenticated: () => _resetAntigravityTokenState(),
  isInteractive: () => Boolean(process.stdin.isTTY),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  exit: (code) => process.exit(code),
  timing: { graceMs: 10_000, intervalMs: 500 },
};

/**
 * Poll the shared store for a short grace window after a blocking agy spawn
 * returns. Resolves as soon as the token appears (immediate when agy blocked
 * through the sign-in), or null once the grace window elapses.
 */
async function pollForToken(deps: AntigravityLoginDeps): Promise<AntigravityToken | null> {
  const deadline = deps.now() + deps.timing.graceMs;
  for (;;) {
    const tok = deps.readToken();
    if (tok) return tok;
    if (deps.now() >= deadline) return null;
    const remaining = deadline - deps.now();
    await deps.sleep(Math.min(deps.timing.intervalMs, Math.max(0, remaining)));
  }
}

/**
 * Manages `claudish login antigravity` / `logout antigravity`. Mirrors the other
 * OAuth managers' singleton shape (getInstance / login / logout) so it slots into
 * AUTH_PROVIDERS uniformly, but holds NO in-memory token — the shared keychain
 * store, owned by agy, is the single source of truth.
 */
export class AntigravityOAuth {
  private static instance: AntigravityOAuth | null = null;

  static getInstance(): AntigravityOAuth {
    if (!AntigravityOAuth.instance) {
      AntigravityOAuth.instance = new AntigravityOAuth();
    }
    return AntigravityOAuth.instance;
  }

  private constructor() {}

  /**
   * Delegate sign-in to agy, then wait for the shared token. Owns its own
   * user-facing messaging and exits (non-fatally, code 0) in every branch, so the
   * generic login wrapper's boilerplate success line never contradicts a
   * still-unauthenticated outcome.
   */
  async login(depsOverride: Partial<AntigravityLoginDeps> = {}): Promise<void> {
    const deps: AntigravityLoginDeps = { ...defaultLoginDeps, ...depsOverride };
    log("[AntigravityOAuth] Starting agy-delegated login");

    // 1. Already authenticated? Nothing to do.
    if (deps.hasToken()) {
      console.log(
        `✅ Already authenticated with Antigravity. Use: claudish --model ag@${await (deps.suggestModel ?? defaultSuggestModel)()}`
      );
      return deps.exit(0);
    }

    // 2. Locate agy; offer to install it if absent.
    let agyPath = deps.locateAgy();
    if (!agyPath) {
      console.log("\nThe Antigravity CLI (`agy`) is required to sign in to Antigravity.");
      console.log(
        "claudish delegates Antigravity sign-in to agy — agy holds the current OAuth secret\n" +
          "and writes the session to the shared keychain store that claudish reads."
      );
      if (!deps.isInteractive()) {
        printManualInstall();
        return deps.exit(0);
      }
      const proceed = await deps.confirmInstall();
      if (!proceed) {
        printManualInstall();
        return deps.exit(0);
      }
      console.log("\nInstalling the Antigravity CLI…\n");
      if (!deps.runInstall()) {
        console.log("\n❌ Antigravity CLI installation failed.");
        printManualInstall();
        return deps.exit(0);
      }
      agyPath = deps.locateAgy();
      if (!agyPath) {
        console.log("\n❌ Antigravity CLI still not found after install.");
        printManualInstall();
        return deps.exit(0);
      }
    }

    // 3. Trigger agy's first-run auth, then confirm the shared token. The
    //    single-shot spawn BLOCKS through agy's own ~3-min sign-in window
    //    (`--print-timeout 3m`), so by the time it returns the token is normally
    //    already written — the grace poll just absorbs any keychain-write lag.
    console.log(
      "\nLaunching the Antigravity CLI to sign in — complete the sign-in in your browser.\n" +
        "claudish will detect the session automatically.\n"
    );
    deps.runAgyAuth(agyPath, false); // single-shot
    let token = await pollForToken(deps);

    // 3b. Fallback: the single-shot didn't yield a session — start agy
    //     interactively so the user can sign in, then exit agy to return.
    if (!token) {
      console.log(
        "\nNo session detected yet. Starting the Antigravity CLI interactively —\n" +
          "sign in, then exit agy (its `/quit` command or Ctrl-C) to return here.\n"
      );
      deps.runAgyAuth(agyPath, true);
      token = await pollForToken(deps);
    }

    // 4. Outcome.
    if (token) {
      deps.onAuthenticated();
      console.log(
        `\n✅ Authenticated with Antigravity. Use: claudish --model ag@${await (deps.suggestModel ?? defaultSuggestModel)()}`
      );
      return deps.exit(0);
    }
    console.log(
      "\nNo Antigravity session detected. Run `agy` and sign in, then retry " +
        "`claudish login antigravity`."
    );
    return deps.exit(0);
  }

  /**
   * Logout — fully clear the Antigravity session, for BOTH claudish and agy.
   * agy has no non-interactive logout command (its `/logout` is a TUI slash
   * command that runs `clearCredentials`), so claudish reproduces that clear:
   *   1. delete the SHARED keychain token — this IS agy's live session (both
   *      tools read the same go-keyring item), so removing it logs agy out too;
   *   2. best-effort remove agy's on-disk token artifact so no stale session
   *      survives to re-hydrate.
   * agy re-authenticates (browser) on its next use, same as after `/logout`.
   */
  async logout(deps?: AntigravityTokenDeps): Promise<void> {
    deleteSharedAntigravityToken(deps);
    try {
      const tokenFile = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
      if (existsSync(tokenFile)) unlinkSync(tokenFile);
    } catch {
      // Non-fatal: the keychain delete above is the authoritative logout.
    }
    log("[AntigravityOAuth] Antigravity session cleared (keychain + agy token file)");
  }
}

/** Get the shared AntigravityOAuth instance. */
export function getAntigravityOAuth(): AntigravityOAuth {
  return AntigravityOAuth.getInstance();
}
