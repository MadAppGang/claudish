/**
 * The process-wide code-mode stores. Created on first use (only a code-mode
 * request reaches here), process memory only: a claudish restart loses them,
 * and the input builder's restart rendering covers that.
 */

import { ScriptStore } from "./script-store.js";
import { TurnRecords } from "./turn-records.js";

export interface CodeModeStores {
  scripts: ScriptStore;
  turns: TurnRecords;
}

let stores: CodeModeStores | undefined;

/** The process's stores; the script store's reaper starts with them. */
export function getCodeModeStores(): CodeModeStores {
  if (!stores) {
    stores = { scripts: new ScriptStore(), turns: new TurnRecords() };
    stores.scripts.startReaper();
  }
  return stores;
}

/** Drop the process's stores, disposing every runtime (tests; a process reset). */
export function resetCodeModeStores(): void {
  if (!stores) return;
  stores.scripts.stopReaper();
  stores.scripts.clear();
  stores.turns.clear();
  stores = undefined;
}
