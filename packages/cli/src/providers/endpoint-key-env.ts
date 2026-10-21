/**
 * The env var name a custom endpoint's API key is read from.
 *
 * A leaf: it imports nothing, so the cwd `.env` allowlist (`dotenv-allowlist.ts`) can
 * name the custom-endpoint key variables at startup without loading the endpoint
 * loader, whose static import closure reaches the 1Password SDK.
 */

/**
 * The synthesized `CUSTOM_<NAME>_KEY` env var for an endpoint name.
 *
 * A BUNDLED endpoint carries the vendor's own variable as its primary and this
 * spelling as an ALIAS, so the user-authored form keeps working for a name that also
 * ships. The two must be produced by one function or a rename in either place
 * silently stops honouring the other's variable.
 */
export function customEndpointKeyEnvVar(name: string): string {
  return `CUSTOM_${sanitizeEnvName(name)}_KEY`;
}

/**
 * True for every name `customEndpointKeyEnvVar` can produce, whatever the endpoint is
 * called. User-authored endpoints are read from the config file after the cwd `.env`
 * is applied, so the allowlist matches the shape rather than a list of names.
 */
export function isCustomEndpointKeyEnvVar(key: string): boolean {
  return CUSTOM_ENDPOINT_KEY.test(key);
}

/** `sanitizeEnvName` emits only `[A-Z0-9_]`, and an endpoint name is never empty. */
const CUSTOM_ENDPOINT_KEY = /^CUSTOM_[A-Z0-9_]+_KEY$/;

function sanitizeEnvName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
