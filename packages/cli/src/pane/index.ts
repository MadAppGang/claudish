/**
 * The pane module's public surface (architecture §2, D1). Team and the MCP sessions import
 * from here only; internal files are imported directly only by their own tests.
 * `child-env.ts` runs in the pane child and is imported by the CLI entry, not here.
 */

export * from "./contract.js";
export { toSlotRow } from "./slot-row.js";
export { REASON_DETAIL_MAX_CHARS, reasonDetail, upstreamRecordsFor } from "./reason-detail.js";
export { deliveryRefusal } from "./prompt-delivery.js";
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
  requestedAgentOf,
  MagmuxUnavailableError,
  MIN_MAGMUX_VERSION,
  SOCK_ROOT,
  sockRootFor,
} from "./pane-launch.js";
export {
  ensureSwept,
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
  type PaneDiagnostics,
  type PaneLastSend,
  type PaneSession,
  type PaneResizeOutcome,
  type PaneSessionOptions,
  PaneStartError,
  type SendResult,
  startPaneSession,
} from "./pane-session.js";
export {
  type ReplayPane,
  type ReplayPaneOptions,
  type ReplayReady,
  startReplayPane,
} from "./replay-pane.js";
export {
  clampPaneSize,
  DEFAULT_PANE_COLS,
  DEFAULT_PANE_ROWS,
  MAX_PANE_CELLS,
  MAX_PANE_COLS,
  MAX_PANE_ROWS,
  MIN_PANE_COLS,
  MIN_PANE_ROWS,
  type PaneSize,
  RESIZE_QUIET_MS,
} from "./pane-size.js";
export {
  CTRL_END,
  isLiveBottom,
  LIVE_BOTTOM,
  MAX_SCROLL_ROWS,
  planScroll,
  type ScrollDirection,
  type ScrollPlan,
  type ScrollPosition,
  type ScrollRequest,
  scrollRowsOf,
  UNKNOWN_POSITION,
  WHEEL_DOWN,
  WHEEL_UP,
} from "./scroll-input.js";
export {
  renderEntry,
  sanitiseText,
  splitText,
  TOOL_ARG_MAX_CHARS,
  toolCall,
} from "./transcript-lines.js";
export {
  entryLines,
  linesOfEntry,
  maskedSlice,
  type PendingLine,
  type RedactedText,
  redactCarrying,
  type SigningRangeFinder,
} from "./transcript-redaction.js";
export {
  decodeCursor,
  DEFAULT_PAGE_LIMITS,
  encodeCursor,
  fileAgeMs,
  transcriptQuiet,
  isUuid,
  locateTranscriptByUuid,
  NO_UUID_ID8,
  openContainedTranscript,
  type PageLimits,
  readTranscriptPage,
  readTranscriptPageFd,
  TRANSCRIPT_GRACE_MS,
  type TranscriptCursor,
  transcriptAnswer,
  type TranscriptPage,
  type TranscriptSource,
  writerLiveness,
} from "./transcript-page.js";
export type { FinalVerdict, PaneSnapshot, SettledTurn } from "./types.js";
export { chainAnswerOf } from "./types.js";
export type { Phase } from "./slot-state.js";
