/**
 * Devin credential + endpoint resolution.
 *
 * The Devin CLI stores its credential as ONE plaintext TOML line in
 * `~/.local/share/devin/credentials.toml` (mode 0644):
 *
 * ```toml
 * windsurf_api_key = "devin-session-token$<JWT>"
 * ```
 *
 * That value is used verbatim in two places — the `authorization: Basic <k>-<k>`
 * header and request metadata field `1.3`. There is no exchange, no refresh and
 * no keychain, which is why this module is fully synchronous and why the
 * transport has no `forceRefreshAuth` path.
 *
 * The TOML is read with a single anchored regex rather than a parser: one
 * key/value line does not justify a new dependency, and a partial read is
 * strictly better than a hard failure on a file claudish does not own.
 *
 * Read-only, always: never copy this file, never log its contents, never write
 * to it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realValue } from "../../env-placeholder.js";
import { getApiKey } from "../../profile-config.js";

/** Env var overriding the credential (also honoured by the Devin CLI itself). */
export const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";

/** Env var overriding the backend base URL (the plain-HTTP capture hook). */
export const DEVIN_SERVER_URL_ENV = "WINDSURF_API_SERVER_URL";

/** The backend the Devin CLI talks to when nothing overrides it. */
export const DEFAULT_DEVIN_SERVER_URL = "https://server.codeium.com";

/**
 * Test seam: an explicit credentials-file path.
 *
 * Tests point this at a temp file. They must NOT try to move `homedir()` — it
 * cannot be re-pointed at runtime in Bun (the standing lesson from
 * `onepassword-config.test.ts`).
 */
let credentialsPathOverride: string | null = null;

/** Parsed contents of the credentials file, memoized per resolved path. */
interface DevinCredentialsFile {
  apiKey?: string;
  serverUrl?: string;
}

let fileCache: { path: string; value: DevinCredentialsFile } | null = null;

/**
 * Point the credentials reader at a specific file (tests only). Pass `null` to
 * restore the real path. Always clears the memo.
 */
export function setDevinCredentialsPathForTesting(path: string | null): void {
  credentialsPathOverride = path;
  fileCache = null;
}

/** The credentials file claudish reads (honours the test seam). */
export function devinCredentialsPath(): string {
  return credentialsPathOverride ?? join(homedir(), ".local", "share", "devin", "credentials.toml");
}

/** First `key = "value"` line, or undefined. Anchored per-line, quotes required. */
function readTomlString(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * Read + memoize the credentials file. A missing or unreadable file is an empty
 * record, never a throw: an absent Devin CLI is a normal state for every user
 * who does not have one.
 */
function readCredentialsFile(): DevinCredentialsFile {
  const path = devinCredentialsPath();
  if (fileCache && fileCache.path === path) return fileCache.value;

  let value: DevinCredentialsFile = {};
  try {
    const source = readFileSync(path, "utf8");
    value = {
      // The regex is the whole TOML parser, deliberately — see the module header.
      apiKey: readTomlString(source, "windsurf_api_key"),
      serverUrl: readTomlString(source, "api_server_url"),
    };
  } catch {
    // Missing / unreadable / not-a-file — all mean "no Devin credential here".
  }

  fileCache = { path, value };
  return value;
}

/**
 * The Devin api key, or undefined when there is none.
 *
 * Resolution order: env → claudish config `apiKeys` → the Devin CLI's own
 * credentials file. `realValue()` drops an unexpanded `${WINDSURF_API_KEY}`
 * placeholder at every step — an MCP host passes those through verbatim, and a
 * truthy placeholder would otherwise win the chain and be signed into a header.
 *
 * Never returns an empty string: a request must never be sent with an empty key.
 */
export function readDevinApiKey(): string | undefined {
  const fromEnv = realValue(process.env[DEVIN_API_KEY_ENV]);
  if (fromEnv?.trim()) return fromEnv.trim();

  const fromConfig = realValue(getApiKey(DEVIN_API_KEY_ENV));
  if (fromConfig?.trim()) return fromConfig.trim();

  const fromFile = readCredentialsFile().apiKey;
  return fromFile?.trim() ? fromFile.trim() : undefined;
}

/**
 * Whether a Devin credential is available — sync and cheap enough for the TUI's
 * readiness classifier and the routing check. The file read is memoized; env
 * and config are re-read every call so a key hydrated mid-run (1Password) is
 * seen immediately.
 */
export function hasDevinCredentials(): boolean {
  return readDevinApiKey() !== undefined;
}

/**
 * The Devin backend base URL, without a trailing slash.
 *
 * Same override the CLI honours, which is also the cheapest way to debug a
 * protocol drift: point it at a plain-HTTP forwarder and read the traffic
 * without touching the system trust store.
 */
export function readDevinServerUrl(): string {
  const fromEnv = realValue(process.env[DEVIN_SERVER_URL_ENV])?.trim();
  const url = fromEnv || readCredentialsFile().serverUrl || DEFAULT_DEVIN_SERVER_URL;
  return url.replace(/\/+$/, "");
}
