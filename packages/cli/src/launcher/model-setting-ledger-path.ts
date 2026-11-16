/**
 * Where the /model restore ledger lives: `<claudish home>/model-setting-restore.json`.
 *
 * A leaf on purpose. Every interactive launch stats this path to learn whether a
 * restore is pending, and nearly every machine has none, so the check must load
 * no claudish module. The claudish home rule is `claudishHome`'s
 * (`auth/accounts/paths.ts`), inlined here: `HOME` when set and non-empty, else
 * the OS home directory.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const MODEL_SETTING_LEDGER_FILE = "model-setting-restore.json";

export function modelSettingLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".claudish", MODEL_SETTING_LEDGER_FILE);
}
