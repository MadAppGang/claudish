/**
 * The pane module's public surface (architecture §2, D1). Team and the channel import
 * from here only; internal files are imported directly only by their own tests.
 * `child-env.ts` runs in the pane child and is imported by the CLI entry, not here.
 */

export * from "./contract.js";
export { toSlotRow } from "./slot-row.js";
export {
  type Accounting,
  mergeAccounting,
  readTokenFileCached,
  resolveProvider,
  type TokenFileStats,
} from "./accounting.js";
export {
  buildClaudishPaneArgv,
  checkChildFlags,
  assertMagmuxAvailable,
  flagsRemoveRead,
  MagmuxUnavailableError,
  SOCK_ROOT,
  sockRootFor,
} from "./pane-launch.js";
export {
  installPaneShutdownHooks,
  livePaneCount,
  MAX_LIVE_PANES,
  PaneLimitError,
  reapAllPanes,
  releasePaneReservations,
  reservePanes,
  sweepOrphanPanes,
} from "./pane-registry.js";
export {
  type PaneBlock,
  type PaneSession,
  type PaneSessionOptions,
  PaneStartError,
  type SendResult,
  startPaneSession,
} from "./pane-session.js";
export type { FinalVerdict, PaneSnapshot, SettledTurn } from "./types.js";
export type { Phase } from "./slot-state.js";
