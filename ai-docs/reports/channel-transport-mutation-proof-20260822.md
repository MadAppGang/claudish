# Channel regression guard mutation proof

Every mutation below was applied directly to the implementation, run against its named guard, and then reversed with a second hand-written patch. No git checkout or stash operation was used.

| guard | mutation applied | observed failure | reverted+green |
|---|---|---|---|
| G1 | Restored the old non-absorbing exit verdict by assigning `verdict.state` after the child exit unless the prior state was only `cancelled`. | `Expected: "timeout"` / `Received: "completed"` at `expect(info.status).toBe("timeout")`. | Yes; shared G1/G2 test passed after reversal. |
| G2 | Emitted `"timeout"` as the channel event whenever `sessionStatus` was `"timeout"`. | Terminal wire assertion diff: expected `["failed"]`, received `["timeout"]`. | Yes; shared G1/G2 test passed after reversal. |
| G3 | Restored both module-load signal exit codes to `0`. | SIGTERM assertion diff: expected `code: 143`, received `code: 0`. | Yes; G3 passed after reversal. |
| G4 | Emptied `RESERVED_CHILD_FLAGS`. | `Expected pattern: /channel transport/`; function did not throw and returned `undefined`. | Yes; G4 passed after reversal. |
| G5 | Swapped spawn argv order to `--quiet --verbose`. | `expect(quietAt).toBeGreaterThan(verboseAt)`: expected `> 4`, received `3`. | Yes; G5 passed after reversal. |
| G6 | Appended every raw stdout chunk to scrollback before reduction, storing the delta firehose. | `Expected to contain: "ALPHA"`; received only repeated captured `{"type":"stream_event",..."content_block_delta"...}` lines after the 2,000-line cap evicted the assistant prose. | Yes; G6 passed after reversal. |
| G7 | Unconditionally called `proc.stdin.end()` immediately after spawn. | `waitUntil timed out` while waiting for the promptless session to reach a usable `running` state. | Yes; G7 passed after reversal. |
| G1 contract rewrite | Narrowed the prior-terminal guard to `cancelled` and restored the historical exit-verdict overwrite, so exit 0 upgraded a recorded timeout to completed. | `Expected: "timeout"` / `Received: "completed"` at `expect(info.status).toBe("timeout")`. | Yes; rewritten G1/G2 passed after a hand-written reversal. |
| G2 contract rewrite | Restored the old split verdict by emitting `failed` from the reducer and retaining `timeout` only in `SessionInfo.status`. | Terminal wire assertion diff: expected `["timeout"]`, received `["failed"]`. | Yes; rewritten G1/G2 passed after a hand-written reversal. |
| SEP-1686 timeout map | Deleted `["timeout", "failed"]` from `EVENT_TO_TASK_STATUS`. | Behavioural guard failed at `mapEventToTaskStatus("timeout")`: expected `"failed"`, received `"working"`. | Yes; focused mapper guard passed after a hand-written reversal. |

## Reverted guard run

```text
bun test v1.3.10 (30e609e0)

packages/cli/src/channel/session-manager.test.ts:
(pass) SessionManager > G1/G2: timeout stays timeout in memory and meta while the wire reports failed
(pass) SessionManager > G7: a promptless session reaches a usable state and accepts later input
(pass) SessionManager > G6: delta firehose is not stored and cannot evict assistant prose
(pass) exported channel transport seams > G4: every transport-owned flag is rejected loudly
(pass) exported channel transport seams > G5: spawn argv keeps verbose before quiet and leaves -p valueless
(pass) claudish signal exit codes > G3: module-load signal handlers preserve SIGTERM=143 and SIGINT=130

6 pass
24 filtered out
0 fail
28 expect() calls
Ran 6 tests across 1 file.
```

## Full channel suite

```text
$ CLAUDISH_SKIP_LIVE_E2E=1 bun test packages/cli/src/channel/
bun test v1.3.10 (30e609e0)

packages/cli/src/channel/session-manager.test.ts:
(pass) SessionManager > G1/G2: timeout stays timeout in memory and meta while the wire reports failed [1094.30ms]
(pass) SessionManager > G7: a promptless session reaches a usable state and accepts later input [130.23ms]
(pass) SessionManager > G6: delta firehose is not stored and cannot evict assistant prose [81.17ms]
(pass) exported channel transport seams > G4: every transport-owned flag is rejected loudly [76.85ms]
(pass) exported channel transport seams > G5: spawn argv keeps verbose before quiet and leaves -p valueless [76.73ms]
(pass) claudish signal exit codes > G3: module-load signal handlers preserve SIGTERM=143 and SIGINT=130 [132.97ms]

packages/cli/src/channel/scrollback-buffer.test.ts:
11 pass

packages/cli/src/mcp-session/e2e-sessions.test.ts:
[e2e-channel] Group 2 SKIPPED — `claude -p` is unavailable or not authenticated (needs ANTHROPIC_API_KEY or a headless-usable claude.ai login).

packages/cli/src/mcp-session/session-wire-format.test.ts:
8 pass

packages/cli/src/channel/stream-json-reducer.test.ts:
(pass) StreamJsonReducer > captured semantic frames drive state, prose, result accounting, and diagnostics [0.71ms]
(pass) StreamJsonReducer > G6: delta firehose never evicts real assistant prose from scrollback [2.77ms]

4 tests skipped:
(skip) Group 1: MCP Protocol — channel capability > create_session → poll → get_output lifecycle
(skip) Group 2: Real Claude Code — MCP tool discovery > claude discovers claudish MCP tools and can call list_models
(skip) Group 2: Real Claude Code — MCP tool discovery > claude discovers channel tools (create_session, list_sessions)
(skip) Group 2: Real Claude Code — MCP tool discovery > claude creates a session via create_session tool

62 pass
4 skip
0 fail
229 expect() calls
Ran 66 tests across 5 files. [10.60s]
```
