/**
 * What a working directory's `.env` may set: provider API keys and claudish model
 * settings, and nothing else.
 *
 * claudish reads `.env` from the directory it starts in, and that directory is often a
 * checkout nobody has reviewed: Claude Code starts the claudish MCP server there before
 * its folder-trust dialog. A `.env` exists to supply credentials, so that is all it can
 * supply, plus the model choice a project may reasonably pin. Every other name is
 * ignored, because too many of them choose what code runs:
 * `CLAUDE_PATH` names the Claude Code executable claudish spawns, `BUN_OPTIONS` and
 * `NODE_OPTIONS` preload a module into every child, `CLAUDE_CONFIG_DIR`,
 * `CLAUDISH_PANE_ROOT` and `CLAUDISH_SESSIONS_DIR` move state into the checkout, and the
 * catalog URL and provider base URLs choose where prompts and keys are sent. A list of
 * forbidden names was bypassed three times; this is a list of permitted ones.
 *
 * The list is DERIVED, never typed out, so a new provider is covered the day it lands:
 *
 *   - each builtin provider's `apiKeyEnvVar` and `apiKeyAliases` (`BUILTIN_PROVIDERS`);
 *   - each bundled endpoint's `apiKeyEnvVar` and `apiKeyAliases` (`PREDEFINED_ENDPOINTS`);
 *   - every `CUSTOM_<NAME>_KEY`, the variable a custom endpoint's key is read from
 *     (`isCustomEndpointKeyEnvVar`). User endpoints live in the config file, which is
 *     read after this, so the shape is matched rather than the names.
 *
 * Beyond that, `NAMED_KEYS` is a short list, each name with its reason. Base URLs,
 * `OLLAMA_HOST`, `CLAUDISH_PORT`, `CLAUDISH_RECOVERY` and `GOOGLE_APPLICATION_CREDENTIALS`
 * stay out: a base URL or host would send the user's existing key to the checkout's
 * server, and the credentials file is a POINTER to credential logic, not a secret — an
 * `external_account` JSON names a local file and a `token_url`, so gcloud would read the
 * file and POST it to a repo-chosen host. A destination, not a credential; shell-only.
 *
 * The two model keys that CAN still name a destination are refused by VALUE, not by name:
 * a `CLAUDISH_MODEL`/`CLAUDISH_MODEL_*` whose spec resolves to the raw-URL `custom-url`
 * provider (`http(s)://…`) would make claudish connect to a repo-chosen host. Such a
 * value is dropped (`modelSpecNamesRawUrl`, the same check a project `.claudish.json`
 * profile gets in `project-models.ts`) and the variable left unset, with its own one
 * line. This is the `.env` boundary the credential authority relies on: it has no notion
 * of a variable's provenance, so a repo-set raw-URL model must be stopped here, before
 * routing ever reaches `custom-url` (see the note at `parseModelSpec`'s URL branch).
 *
 * This is the ONLY module that parses a `.env`. `index.ts` loads the file through
 * `loadDotenvText` once, before anything else reads the environment — the `--mcp` server
 * included, which runs in the same process — and the provenance view reads it through
 * `readAllowedDotenv`. No other module imports `dotenv`: a second, unfiltered `config()`
 * re-opens every name refused here.
 *
 * Loaded lazily by `index.ts`, and only when a `.env` exists, so a launch without one
 * does not pay for the provider table.
 */

import { parse } from "dotenv";
import { isCustomEndpointKeyEnvVar } from "./providers/endpoint-key-env.js";
import { modelSpecNamesRawUrl } from "./providers/model-parser.js";
import { PREDEFINED_ENDPOINTS } from "./providers/predefined-catalog.js";
import { BUILTIN_PROVIDERS } from "./providers/provider-definitions.js";

type Env = Record<string, string | undefined>;

interface KeyNames {
  apiKeyEnvVar?: string;
  apiKeyAliases?: readonly string[];
}

/** The names a `.env` may set besides the derived provider keys. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  // Native Anthropic passthrough: `native-anthropic` declares no apiKeyEnvVar.
  "ANTHROPIC_API_KEY",
  // Vertex region; vertexApiHost refuses anything but a location name before it builds a host.
  "VERTEX_LOCATION",
  // The default model, a per-project choice.
  "CLAUDISH_MODEL",
  // The model each Claude Code tier maps to, per project.
  "CLAUDISH_MODEL_OPUS",
  "CLAUDISH_MODEL_SONNET",
  "CLAUDISH_MODEL_HAIKU",
  "CLAUDISH_MODEL_SUBAGENT",
]);

/** The model-pin keys, whose VALUE is checked before it is accepted (raw-URL refusal). */
const MODEL_KEYS: ReadonlySet<string> = new Set([
  "CLAUDISH_MODEL",
  "CLAUDISH_MODEL_OPUS",
  "CLAUDISH_MODEL_SONNET",
  "CLAUDISH_MODEL_HAIKU",
  "CLAUDISH_MODEL_SUBAGENT",
]);

let allowed: ReadonlySet<string> | undefined;

/** The provider API-key variable names, from the provider definitions. */
export function providerKeyEnvVars(): ReadonlySet<string> {
  if (allowed) return allowed;
  const names = new Set<string>();
  const sources: readonly KeyNames[] = [...BUILTIN_PROVIDERS, ...PREDEFINED_ENDPOINTS];
  for (const p of sources) {
    // An OAuth or no-auth provider declares `apiKeyEnvVar: ""`: it reads no variable.
    if (p.apiKeyEnvVar) names.add(p.apiKeyEnvVar);
    for (const alias of p.apiKeyAliases ?? []) names.add(alias);
  }
  allowed = names;
  return names;
}

/** True when a cwd `.env` may set `key`. */
export function isDotenvAllowedKey(key: string): boolean {
  return providerKeyEnvVars().has(key) || NAMED_KEYS.has(key) || isCustomEndpointKeyEnvVar(key);
}

/** What a repository `.env` may do with one entry. */
type DotenvVerdict = "allowed" | "refused" | "raw_url_model";

function verdictFor(key: string, value: string): DotenvVerdict {
  if (!isDotenvAllowedKey(key)) return "refused";
  if (MODEL_KEYS.has(key) && modelSpecNamesRawUrl(value)) return "raw_url_model";
  return "allowed";
}

/**
 * The entries of one `.env` file's text that a repository `.env` may set, for a reader
 * that reports what the file holds rather than loading it (the API-key provenance view).
 * The same rule as `loadDotenvText`, so the two can never disagree about a name.
 */
export function readAllowedDotenv(text: string | Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parse(text))) {
    if (verdictFor(key, value) === "allowed") out[key] = value;
  }
  return out;
}

/**
 * Apply one `.env` file's text to `env` the way dotenv's `config()` does — no
 * expansion, an existing value is never overwritten — for the allowed names only.
 * Returns the other names the file assigned that were NOT already set, i.e. the ones
 * that would have taken effect. Values are never returned.
 *
 * `onRejectedModel` is called with a model-pin name whose VALUE names the raw-URL
 * provider; that variable is left unset, as if it were not in the file.
 */
export function loadDotenvText(
  env: Env,
  text: string | Buffer,
  onRejectedModel: (name: string) => void = () => {}
): string[] {
  const refused: string[] = [];
  for (const [key, value] of Object.entries(parse(text))) {
    if (env[key] !== undefined) continue;
    const verdict = verdictFor(key, value);
    if (verdict === "refused") refused.push(key);
    else if (verdict === "raw_url_model") onRejectedModel(key);
    else env[key] = value;
  }
  return refused;
}

/** The one stderr line for the names a `.env` file tried to set. Names only. */
export function refusedFromDotenvNotice(names: readonly string[]): string {
  const them = names.length === 1 ? "it" : "them";
  return `[claudish] ignoring ${names.join(", ")} in .env: a repository's .env may set only provider API keys and claudish model settings. Set ${them} in your shell${names.includes("CLAUDISH_CONFIG") ? ", or pass --config" : ""}.`;
}

/** The one stderr line for a model pin a `.env` set to a raw-URL provider. Names only. */
export function rejectedModelNotice(names: readonly string[]): string {
  const them = names.length === 1 ? "it" : "them";
  return `[claudish] ignoring ${names.join(", ")} in .env: a repository's .env may not point a model at a raw http(s):// URL. Set ${them} in your shell.`;
}
