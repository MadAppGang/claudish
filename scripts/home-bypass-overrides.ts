/**
 * The environment variables that send claudish's reads and writes past `HOME`.
 *
 * Each one names a path claudish uses instead of the one under `HOME`: the config file
 * (`--config` exports `CLAUDISH_CONFIG` to every process a session starts), the account
 * list, and the dynamic models catalog and its key. A test run that only moves `HOME`
 * still follows them to wherever they point, a real config with real `apiKeys` included.
 *
 * Literals with no imports, like `session-env-vars.ts`: the bun test preload loads this
 * file before every test file. Importing it has NO side effect.
 *
 * Read by `scripts/test-preload.ts` (in-process, first layer) and
 * `scripts/guard-real-config.ts` (the child's OS environment, second layer).
 */
export const HOME_BYPASS_OVERRIDES = [
  "CLAUDISH_ACCOUNTS_DIR",
  "CLAUDISH_CONFIG",
  "CLAUDISH_DYNAMIC_CATALOG_DIR",
  "CLAUDISH_DYNAMIC_CATALOG_KEY",
] as const;
