/**
 * Every environment variable a provider credential (or a provider base URL) is read
 * from, DERIVED from the provider definitions, never typed out.
 *
 * Why: `routing-rules.test.ts` cleared a hand list of 24 key names. `POE_API_KEY` was
 * not on it, so with that key in the developer's shell two tests routed to Poe and
 * failed (model-failures-2026-10-21.md, D4). A hand list reopens that hole every time a
 * provider lands; this derivation covers it the day the definition does.
 *
 * Sources:
 *   - `providerKeyEnvVars()` (`dotenv-allowlist.ts`): every `apiKeyEnvVar` and
 *     `apiKeyAliases` in `BUILTIN_PROVIDERS` and `PREDEFINED_ENDPOINTS`;
 *   - the credential names no definition declares (`UNDECLARED_CREDENTIAL_VARS`, each
 *     with its reader), taken from the reader's own constant where one exists;
 *   - every `CUSTOM_<NAME>_KEY` present in the environment (`isCustomEndpointKeyEnvVar`):
 *     user endpoints live in the config file, so their names are matched by shape.
 *
 * Base URLs are not credentials, but `localBaseUrl` and the transports read them, so
 * `clearProviderCredentialEnv` clears `providerBaseUrlEnvVars()` too.
 */
import { VERTEX_PROJECT_ENV_VARS } from "../auth/vertex-auth.js";
import { providerKeyEnvVars } from "../dotenv-allowlist.js";
import { DEVIN_API_KEY_ENV } from "../providers/devin/devin-credentials.js";
import { isCustomEndpointKeyEnvVar } from "../providers/endpoint-key-env.js";
import { PREDEFINED_ENDPOINTS } from "../providers/predefined-catalog.js";
import { BUILTIN_PROVIDERS } from "../providers/provider-definitions.js";

type Env = Record<string, string | undefined>;

/** Credential variables that no provider definition declares (see the module comment). */
const UNDECLARED_CREDENTIAL_VARS = [
  // native-anthropic declares no apiKeyEnvVar (native-anthropic-credential.ts)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // devin's apiKeyEnvVar MUST stay "" (CLAUDE.md); its source reads this name directly
  DEVIN_API_KEY_ENV,
  // read by the advisor's Gemini call (native-handler-advisor.ts)
  "GOOGLE_API_KEY",
  // vertex: ADC file pointer and project (vertex-auth.ts)
  "GOOGLE_APPLICATION_CREDENTIALS",
  ...VERTEX_PROJECT_ENV_VARS,
];

/** Every environment variable a credential source reads, derived; never hand-listed. */
export function providerCredentialEnvVars(env: Env = process.env): string[] {
  const names = new Set<string>(providerKeyEnvVars());
  for (const name of UNDECLARED_CREDENTIAL_VARS) names.add(name);
  for (const name of Object.keys(env)) {
    if (isCustomEndpointKeyEnvVar(name)) names.add(name);
  }
  return [...names].sort();
}

/** Every base-URL override a builtin provider or bundled endpoint declares. */
export function providerBaseUrlEnvVars(): string[] {
  const names = new Set<string>();
  const sources: readonly { baseUrlEnvVars?: readonly string[] }[] = [
    ...BUILTIN_PROVIDERS,
    ...PREDEFINED_ENDPOINTS,
  ];
  for (const def of sources) {
    for (const name of def.baseUrlEnvVars ?? []) names.add(name);
  }
  return [...names].sort();
}

/**
 * Snapshot and delete every provider credential and base-URL variable from
 * `process.env`. Returns the function that restores the snapshot (call it in afterEach).
 */
export function clearProviderCredentialEnv(): () => void {
  const names = [...new Set([...providerCredentialEnvVars(), ...providerBaseUrlEnvVars()])];
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
