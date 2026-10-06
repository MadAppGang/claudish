/**
 * Who exits the process on SIGTERM / SIGINT.
 *
 * `stats-buffer.ts` registers signal listeners at module load that flush telemetry and
 * call `process.exit` synchronously. A process that owns interactive panes must instead
 * settle its records (meta.json, the closing wait line, the team record) and reap its
 * panes BEFORE it exits, which is asynchronous; the pane registry's shutdown exits with
 * 128 + n itself once that is done. It claims the exit here, and the stats listener then
 * only flushes (its `exit` listener still flushes once more at the real exit).
 *
 * A flag module rather than an import, so `stats-buffer.ts` does not load the pane code.
 */
let claimed = false;

export function claimSignalExit(): void {
  claimed = true;
}

export function signalExitClaimed(): boolean {
  return claimed;
}
