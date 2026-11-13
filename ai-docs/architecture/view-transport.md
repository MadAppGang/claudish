# The view transport: claudish sessions as native herdr items

A claudish MCP server serves its sessions, team slots and replays to local clients other than its
own Claude Code. Those clients are `claudish view <target>` (in a plain terminal, in a herdr pane,
or in a hidden hc terminal under Herdr.app), the feed relay that lists them for the Herdr.app mod,
and other claudish MCP servers. claudish opens nothing in herdr terminal: no tab, no pane. Sessions
are shown beside Claude Code by the Claude Code mod, and a user may run `claudish view <target>` in
any pane by hand.

This file records why the transport is shaped the way it is and what was measured to get there.
The code is `packages/cli/src/view/` (transport, viewer, replays shared across servers),
`packages/cli/src/herdr/` (the herdr terminal adapter and the Herdr.app mod) and
`pane/view-contract.ts` (the wire types). Measured on herdr 0.9.5 (protocol 22), magmux 0.19.0
(9c45e07), Herdr.app 0.1.14 with hc 0.1.19, Bun 1.4.0, macOS arm64, November 2026. The spike
scripts and their raw output live in the session that built this (gitignored); the numbers below
are copied from them. Read [`pane-session.md`](pane-session.md) first: everything here sits on top
of the pane driver it describes.

## Magmux drives, herdr shows

```
Claude Code ── stdio MCP ──▶ claudish MCP server (one per Claude Code)
                               │ control socket (claudish only)
                               ▼
            magmux --view-sock --id <pane> --sock-dir <root>
              <root>/magmux-<pane>.sock   control, never published
              <root>/magmux-<pane>.view   read-only, published ◀── watch ── claudish view <target>
                               ▲                                   (by hand, any pane) │ claim, renew,
                               │                                                       ▼ subscribe
                               └── watch ── claudish view (hc terminal) ──▶ <root>/endpoints/c<pid>-<start36>.sock
                                              ▲ keyed window in Herdr.app     (claudish.view.v1)
                                              └ mod lists from <root>/feed/feed.json (claudish view --feed)
```

There is exactly one magmux per session, and the MCP server that started it stays its only
driver. herdr never runs a second multiplexer, never attaches to the session, and never types
into it. What a herdr pane shows is a `claudish view` process that reads frames from the pane's
read-only socket and paints them.

Two facts made this the only safe shape:

- **magmux's unix socket has no read-only mode.** Every connection to `magmux-<pane>.sock` may
  `send`, `input`, `resize` and `close_pane`; the only guard is the 0700 socket root. A viewer
  given that path could type into a running session by mistake, and nothing would stop it.
- **magmux 0.19.0 serves a second socket that is read-only by construction.** With `--view-sock`
  it binds `magmux-<pane>.view` beside the control socket. Measured: the control socket's
  `capabilities` answers `readOnly: false` and `viewSocket: <dir>/magmux-<id>.view`; the view
  socket answers `readOnly: true`; `send` on it answers
  `{"ok":false,"code":"forbidden","error":"\"send\" is not available on the read-only view socket","reason":"read_only"}`.
  claudish never passes `--view-op`, so a view client can call no plugin op either.

So the rule is one path published, one path kept. Every reply, event and feed file carries
`magmux.view_socket` (the `.view` path) or null. None carries the control socket's path, a pane
record, a control directory, a hook inbox, a token file or a transcript path. claudish's own
viewer uses nothing but the `.view` socket and the local transport, and neither has an op that
carries input.

This keeps a client from driving a session by mistake; it is not a security boundary. magmux
0.19.0's `.view` socket itself answers `capabilities` with `sock` (the control socket's path) and
the transcript path (measured while capturing test frames). A deliberate process of the same user
can therefore find the control socket. The boundary is the uid and the 0700 root, as it always
was for the control sockets.

**A `.view` path is published only after two checks agree** (`pane/view-socket.ts`, run at every
attach). The control socket's `capabilities.viewSocket` must equal the path claudish derives
(`viewSockPathOf`), and a plain dial of that path must answer `readOnly: true`. Anything else
records the anomaly `view_socket_unverified` and publishes `view_socket: null`; the session keeps
running, and herdr shows no screen for it. This catches a magmux that passed the version check but
ignored the flag: 0.18.0 given `--view-sock` prints nothing and keeps running (measured, killed by
`timeout` at 4 s), so there is no stderr line to match.

**The floor is `MIN_MAGMUX_VERSION = "0.19.0"`, on the 0.x line only.** A major version other
than 0 is refused. `probeMagmux` walks every candidate in order: bundled `native/`, the
`@claudish/magmux-*` package, then `PATH`. It takes the first that passes. With none, it refuses
and names every candidate with its version. The walk exists because of one install: the global
claudish carried `@claudish/magmux-darwin-arm64` at 0.18.0, found before `PATH`, while Homebrew
had 0.19.0. With only the floor raised, every pane session on that install was refused.

A failed view bind is fatal to the pane: magmux exits 1 with `magmux: view socket <path>: <err>`,
which `FATAL_MAGMUX_STDERR` maps to `pane_lost`. Both socket inodes are mode 0755 (the umask;
magmux does not chmod them). The protection is the 0700 root, which `ensureSockRoot` checks.

## The local view socket, `claudish.view.v1`

Every non-nested MCP server binds `<root>/endpoints/c<pid>-<start36>.sock` at startup: the
directory 0700, the socket chmod 0600. The name carries the owner's pid and start time (base 36),
so a client tells a stale file from a live one without dialing, and a reused pid reads as dead
(`endpointOwnerAlive`). An endpoint path of 104 bytes or more (`sun_path` on macOS) switches the
transport off for that process with one log line; sessions do not depend on it. A nested server
binds nothing.

Framing is JSON Lines:

```
→ {"id": 3, "op": "claim", "args": {"target": "s:0441fed6-…", "cols": 219, "rows": 56}}
← {"id": 3, "ok": true, "result": {"granted": true, "view": {"holder": "herdr", "label": "herdr", …}, "resize": {…}}}
← {"type": "event", "sub": 1, "seq": 7, "event": "item.upsert", "item": {…}}
← {"id": 4, "ok": false, "error": {"code": "view_not_held", "message": "…"}}
```

A target is `s:<session_id>`, `t:<run_id>/<slot>` or `r:<replay_id>`. A `ViewItem` is the contract
v1 `SessionRow` or `SlotRow` plus `prompt_summary`, `prompts_sent`, `pending_inputs`, `subagents`
and `magmux {pane_id, view_socket}`; a replay item has `of`, `model`, `final` and `view`. Built on
the contract rows, the two surfaces cannot drift.

**Who may connect.** Any process of the same user that can reach the 0700 root. `hello` declares a
role: `viewer` (the default for a connection that skips `hello`), `relay` or `peer`. A `peer` must
name another live server's endpoint, else `forbidden`. That is a correctness gate that keeps a
viewer from closing a replay by mistake, not authentication: the boundary is the uid, as it is for
the control sockets.

| op | who | what it does |
|---|---|---|
| `hello` | all | role, front end, term program; answers protocol, server, capabilities |
| `list`, `subscribe`, `unsubscribe` | all | rows; a subscription gets a `snapshot`, then upserts |
| `capture`, `transcript` | all | the same answers as the MCP verbs, with `view` |
| `claim`, `release` | viewer, peer | take or drop the active view (below) |
| `renew` | viewer | the viewer's heartbeat |
| `resize` | the holder | `view_not_held` for anyone else |
| `replay.open`, `replay.release` | viewer, peer | open or join a replay; drop this connection's hold |
| `replay.scroll`, `replay.close` | peer only | relayed from another server's own Claude Code |

Events are `snapshot`, `item.upsert` (a full row), `item.remove {target, reason}` with reason
`evicted`, `replay_closed` or `run_pruned`, and `server.closing` (sub 0). They are ordered per
connection and lossless, or the connection is dropped and a reconnect gets a fresh snapshot.

**What a viewer may never do:** send input, cancel, scroll, close a replay, start a session or a
team. The MCP mutator names answer `forbidden`, not `unknown_op`, so a client learns the verb
exists and is refused here. They are `send_input`, `cancel`, `cancel_session`, `scroll`,
`scroll_session`, `create_session`, `team`, `run_prompt` and `close_replay`. `scroll` is input
bytes to the child (SGR wheel events). It reaches a replay only as `replay.scroll`, from a peer
server relaying its own Claude Code's `scroll_session`. A live session is never scrollable over
this socket.

```ts
type ViewErrorCode =
  | ContractError["error"]["code"]   // the contract v1 codes
  | "unknown_op" | "forbidden" | "view_not_held" | "slow_consumer" | "too_many_connections"
  | "line_too_long" | "replay_limit" | "replay_elsewhere" | "server_gone";
```

A local error is never a `ContractError`, and every message goes through `redactSecrets`. The
bounds are 64 connections per server, a 64 KiB request line and a 4 MiB outbound queue. A client
past the queue is dropped, and the server logs `slow_consumer`. `server_gone` is the client's own:
`ViewClient` ends with it when the endpoint's owner is dead. It reconnects with backoff only while
that owner may live.

## The status stream: nothing runs while nothing changes

`PaneSession` calls its owner's `onChange` on a 250 ms ticker whether or not anything happened. A
naive stream would build and send a row per session four times a second forever. Two gates keep
an idle session at zero rows built, zero upserts and zero feed writes:

1. **Stage 1, in the owner** (`view/change-key.ts`). The owner compares `paneChangeKey(snap)` with
   the last key it notified and calls `feed.changed(target)` only on a difference. The key holds
   every snapshot field a row reads, with `lastActivityAt` rounded down to 5 s. `idleSeconds`,
   `screenTail`, `liveAnswerBytes` and the screen's `seq` are deliberately left out. A field added
   to `PaneSnapshot` has to be classified, or it goes stale in every client until the next
   transition.
2. **Stage 2, in `ViewFeed`.** A flush builds the row once and compares it, without
   `idle_seconds`, `elapsed_seconds` and `last_activity_at`, against the last row published. Equal
   rows publish nothing; a row that differs only in `last_activity_at` publishes at most once per
   5 s, with one trailing flush at the window's end.

Non-urgent changes flush 250 ms after the first one; urgent ones flush at once. The notify sites
are the owners, not the feed:

| Change | Notifier | Urgent |
|---|---|---|
| pane transition, registration after spawn, `send_input` enqueue | `SessionManager`, team orchestrator | yes |
| transcript, screen activity, counts | `onChange` through the stage 1 key | no |
| the child rewrote `tokens.json` (cost, provider) | `watchTokenFile`, an `fs.watch` on the token file's directory while the item lives | no |
| claim taken, released, expired | `ViewClaims.notify` | yes |
| replay open, finish, close, hold change, eviction | `ReplayManager` (owned entries only) | yes |
| item gone | `feed.removed(target, reason)` | at once |

Clients compute `idle_seconds` from `last_activity_at`: no upsert is sent because time passed.
The feed returns at once from `changed` when it has no listener. `ViewServer` subscribes to the
feed only while one of its clients holds a subscription, so a server with no client builds no row
on any change. The transport adds four timers, each alive only while it has work:

- the claims timer, one per server, while a claim exists;
- a viewer's 5 s heartbeat, while it holds a claim;
- the relay's 60 s endpoint backstop;
- the mod's 15 s relay check, while its panel is visible.

## View claims: one size, the latest user act wins

A magmux pane has one grid. Two clients that both resize it undo each other, each answering
`changed: true`. So exactly one holder per item sets the size, and every other viewer shows a
one-line band instead of the picture: `viewing in <label> — Enter to view here`, or
`Enter to view here` when nobody holds it. A non-holder unwatches frames.

```ts
interface ViewHolder {
  holder: "claude_code" | "claude_code_other" | "herdr" | "herdr_app" | "terminal";
  label: string;     // set by the server from the role, never by the client
  since: string;
  claim_id: string;  // new per grant, stable across renewals
}
```

**One mode: take.** A claim always takes the view, whoever held it. An earlier design had an
`if_free` mode for background panes; it was removed because it handed the view to a background pane
at creation and again after every lapse, which the user never asked for. The view moves only on a
user act:

| Act | Claim |
|---|---|
| `claudish view <target>` run by hand, or a Herdr.app row selected | takes at start |
| Enter in any viewer | takes |
| selecting the herdr pane a `claudish view` runs in | takes, on `pane_focused` for its own `$HERDR_PANE_ID` |
| MCP `resize_session`, `team(mode:"resize")`, a replay resize | takes (MCP resize claims before it resizes) |
| MCP `capture_session` | renews an existing Claude Code claim of this caller; never takes |
| a viewer's `capture` | touches no claim |

The focus claim reads herdr's `pane_focused` event (subscribed as `{type:"pane.focused"}`; the
event name is underscored). It fires on selecting a pane and on switching to a tab, and not on
reselecting the focused pane (S6). `CLAUDISH_VIEW_FOCUS_CLAIM=0` turns it off. Reselecting a
Herdr.app row whose viewer still runs sends that terminal an Enter (`hc keys <address> enter`),
which takes the view back.

**TTLs.** A viewer claim lives 15 s and its heartbeat renews it every 5 s; closing the connection
(SIGKILL included, the kernel closes it) releases everything it held. A Claude Code claim, this
server's MCP link or a peer server, lives 10 s and is renewed by a resize or by that owner's own
capture. A peer relays its Claude Code's captures one for one, so both lapse together. An expired
claim reads as absent at once, before the single `unref()`'d timer removes it. After a lapse the
view is null and stays null until a user acts.

**The holder is relative in MCP answers.** Over the local transport any Claude Code reads
`claude_code`. In an MCP answer the owning server says `claude_code` for its own MCP link and
`claude_code_other` (label "another Claude Code") for a peer's claim, so a Claude Code mod can tell
its own expanded view from another Claude Code's.

Measured live in herdr (validation check 5): `resize_session` 120x40 answered holder
`claude_code` and the herdr pane's viewer showed the band; Enter in the pane made the next capture answer
219x56 with holder `herdr`; `resize_session` again gave 120x40 `claude_code`. The first capture
right after Enter still read 120x40 (the resize was not applied yet); the second read 219x56.

## Replays shared across servers

A replay is a read-only `claude --resume` of a finished session in its own pane
([`pane-session.md`](pane-session.md) § Replay panes). Several Claude Codes, each with its own MCP
server, may open the same finished session, and a hand-run `claudish view` may open it too. Each
replay is its own `claude --resume` with its own fork record, so per-server replays would mean
several processes and several screens for one session. There is one replay per Claude session
across every server under the root instead.

**The exclusion is a kernel lock, not a file protocol.** The opener takes `flock(2)` on
`<root>/replays/<uuid>.lock` with `LOCK_EX|LOCK_NB` and hands the descriptor to the replay's
magmux at fd 3 (`stdio[3]`), then closes its own copy. The kernel holds the lock exactly as long as
that magmux lives. Lock free means no replay process, whatever any file says. Only a holder of the
lock reaches the spawn, so a second replay has no code path. There is no liveness, age, owner or
stale-lock rule anywhere in this path, so none can be wrong.

`<root>/replays/<uuid>.json` is only a directory of whom to dial: `{state, replay_id,
owner_endpoint, pane_id, since}`, written by atomic rename under a short `flock` on
`registry.lock` (5 s wait; its holder only does file operations). An entry whose lock is free is
stale and the next winner overwrites it. A loser of the lock reads the entry and joins the owner
over a peer link (`replay.open {replay_id}`), or polls the lock for up to `REPLAY_READY_MS` (15 s)
plus 10 s and is then refused. It never spawns.

S12 measured every link of the hand-off, on source, bundle and compiled binary:

| Claim | Evidence |
|---|---|
| the lock fd is close-on-exec in the server | `F_GETFD before spawn = 1 (FD_CLOEXEC)`; `fs.openSync` does not set it, so `O_CLOEXEC` is spelled per platform |
| magmux inherits it at fd 3 | `lsof`: `magmux … 3u REG … replays/s12.lock` |
| no child of magmux keeps it | the replay launcher's first line is `exec 3>&-`; `lsof` lists magmux only |
| held while magmux lives | a second process gets `EWOULDBLOCK` |
| freed on `close_pane` and on SIGKILL of magmux | `ACQUIRED` immediately after |
| held when the owner server dies and magmux lives | owner SIGKILLed, watcher SIGSTOPped: still `EWOULDBLOCK`; after SIGCONT the watcher reaps and the lock is free |

The negative control matters: with `exec 3>&-` removed from the launcher, `lsof` showed the
`claude` stand-in and its background child holding the lock beside magmux. A Bash-tool background
process would then keep a session unreplayable until it exited. Go leaves inherited descriptors
open across `exec`, which is why the close is in the pane's shell and not in magmux. Only `flock`
and the errno read go through `bun:ffi`: `open` is variadic, and Apple arm64 passes variadic
arguments on the stack, which an FFI signature cannot.

**Holds.** An owned entry keeps `holds: {mcp, conns}`: this server's MCP link, and every
connection (viewer or peer) that opened or joined it. `replay.release` drops one connection's
hold, and the owner reaps only when no hold is left. A viewer connection may hold 4 replays, and a
server runs at most 8 replays opened by viewers (`replay_limit`), on top of `FINISHED_REPLAYS_MAX`
(20). MCP and peer opens are not counted: they come from a Claude Code's own `replay_session`.

**`close_replay` has one meaning on every server.** When it returns, the replay process is gone and
its fork record removed, or `reap_unverified: true` says that could not be verified. On the owner it
always reaps, whatever other holds exist. On a joined server it is relayed as `replay.close` and
answers only after the owner's reap and registry removal. If the owner is unreachable, the joined
server polls up to 15 s for the lock to be free and the pane record to be gone. Every other holder
gets `item.remove {reason:"replay_closed"}` and keeps the frozen last screen with `final: true`.

Where `flock` cannot be bound (no libc binding, or a filesystem answering `ENOLCK`/`ENOTSUP`),
replays are per server, as before: no registry, no remote entry, no redirect.

## herdr terminal

claudish opens nothing in herdr terminal: no tab, no pane, and the MCP server never dials herdr.
Sessions are shown beside Claude Code by the Claude Code mod. A user may run
`claudish view <target>` in any herdr pane by hand; that viewer reports for its pane (below) and
never closes it.

**The agent report.** A `claudish view` in a herdr pane is the pane's foreground program, and it
reports for the pane:

| Call | Source | Carries |
|---|---|---|
| `pane.report_agent` | `claudish`, agent `claudish` | the state below |
| `pane.report_metadata` | `claudish:meta` | display agent `claudish · <model>`, title, tokens |
| `pane.release_agent` | `claudish` | at the end |

STARTING and RUNNING are `working`. AWAITING_PERMISSION, and AWAITING_INPUT on `AskUserQuestion`,
are `blocked`. Every other AWAITING_INPUT, the terminal states and replays are `idle`. S5 measured
that a foreground report persists for the process's life (135 s). herdr detects neither a `bun`
foreground nor one with `argv0` `claudish` as an agent, so nothing competes with the report.
`working` followed by `idle` reads `done` in herdr until the pane is seen.

```
check 2, live:  claudish · gpt-6-luna   working (Bash) → working (thinking) → working (finishing)
                                        → done "awaiting input"; tokens and turns updated each step
```

## Measured herdr facts the code depends on

**herdr 0.9.5 answers ONE request per socket connection, then closes it.** A probe against a live
session wrote `tab.list` twice on one connection:

```
+102ms data: <the first tab.list reply>
+103ms close
          (the second tab.list, written at +300 ms, is never answered)
```

The first `HerdrSocket` shared one connection, and a second request on it went into the closing
connection and failed with `HerdrNoReply` "dropped". `HerdrSocket.request` opens a connection per
request and closes it after the reply. An event subscription keeps a connection of its own,
which herdr holds open. The test fake (`pane/test-helpers/fake-herdr.ts`) answers one request per
connection and then closes it, so a reused connection fails in tests the way it fails live.

Two failures look alike and mean opposite things, so they are two classes. `HerdrApiError` means
herdr answered with an error and did nothing. `HerdrNoReply` means no reply came (`timeout` or
`dropped`). The outcome is then unknown.

| Fact | Measured | Consequence in code |
|---|---|---|
| error codes | `pane_not_found`; not `not_found` | matched by name |
| `pane_focused` | on select and on tab switch; not on reselect | the focus claim |

## The Herdr.app mod

Herdr.app's mod runtime reads files and runs programs; it cannot open a unix socket. So the mod
never talks to an endpoint. It reads a file and starts viewers in hc terminals:

- **Feed relay.** `hc run --name claudish-feed -- claudish view --feed` follows `<root>/endpoints/`
  (`fs.watch`, plus re-reads 250 ms, 1 s and 4 s after arming and a 60 s backstop), subscribes to
  each live server as a `relay` with `include_finished: true`, and writes `<root>/feed/feed.json`:
  0600, atomic rename, only on change, at most four writes a second, stamped with the relay's pid
  and start, removed on exit. hc keeps `--name` unique among live terminals (S7a: a second
  `hc run --name` answered `name_taken`, exit 1), so a second relay start is refused. A second relay
  started by hand exits 3. The re-reads exist because on macOS a bind inside the window between
  `fs.watch()` returning and its event stream running was lost and waited for the 60 s backstop
  (8 copies in parallel: 2 of 40, 4 of 40 and 5 of 24 runs failed before the fix; 0 of 64 after).
- **Polling path.** While no relay can run, the mod runs
  `claudish view --list --json --include-finished` every 2 s (a claudish that refuses the flag is
  polled without it). The relay is checked when the panel shows, when `feed.json` is missing, when
  the relay's terminal leaves `terminals()`, and every 15 s while visible (`view --feed-check`,
  JSON plus exit code). A dead relay empties the list at once and is started again. Nothing runs
  while the panel is hidden.
- **Earlier runs come from the records.** A server holds a finished session only until it evicts
  it, and none at all once it exits. Live, a session that failed after 1 s (`child_exited`) was
  evicted, the feed read `items: []`, and the panel went blank. So `feed.json` and
  `--include-finished` carry `history`: the newest 30 runs under `~/.claudish/sessions/`, taken
  by directory mtime (a record written by rename moves it), minus what a server holds. Rows come
  from the builders the MCP tools use for a run they do not hold (`diskSessionRow`,
  `teamRunRowFromDisk` on the `status.json` a `team-*` record names). One read stats every run
  directory: 12 381 entries took 55 to 73 ms, so the relay reads them at start and when a server
  lets items go, at most once per 2 s, on a timer of its own (sharing the write timer delayed item
  updates for the whole interval). A run only the records hold opens no viewer; Text reads its
  transcript from the records. The run on screen is kept while a refresh drops it.
- **A relay from an older build is replaced.** A relay keeps running the code of the build that
  started it; after an update it went on writing the old shape (live: pid 49877, started before
  the update). The relay stamps its version, and `--feed-check` names its own. When they differ,
  or the relay stamps none, the mod kills the `claudish-feed` terminal and starts one. A checker
  that names no version is an older claudish whose relays never stamp one, so it is never
  compared (comparing with `claudish --version` would restart such a relay in a loop). A relay
  that exits when its binary changes would not have helped: the relay already running is the old
  code. The relay claims the signal exit, so SIGTERM removes `feed.json` (the stats listener
  exited 143 first and left it).
- **Keyed window overlay.** Selecting a row starts `claudish view <target> --front-end herdr-core`
  in a hidden hc terminal `claudish-view-<12 hex of sha256(target)>` and shows it in
  `openOverlay({kind: "window", key: "claudish-view", …})`. The same key replaces the open window.
  `layout.set` is refused on the shipped "main" layout, and `terminal.show` would replace a user's
  pane, which is why it is a window (S7e). Selecting another row kills the previous viewer, which
  releases its claim.
- **Status through OSC 7501.** Inside an hc terminal the viewer writes
  `ESC ] 7501 ; state=…:app=claudish:title=<b64>:msg=<b64> ESC \` on each row change; hc accepted it
  (S7d: `"reported":true`, state `working`, msg `Bash`; then `blocked`, `permission: Bash`).
- **The outdated-claudish line.** At load the mod runs `claudish --version`, then
  `claudish view --print-root`. A claudish that answers the first and not the second predates
  `view`; the panel says `<version> has no view command: bun install -g claudish@latest`, not "not
  installed". The live run found the panel calling the released 14.19.1 "not installed".
- **Environment.** An hc terminal gets the core's environment (S7d), not the mod's: an env var set
  on the `hc run` caller did not reach it. Every hc argv is
  `/usr/bin/env PATH=… CLAUDISH_PANE_ROOT=… <claudish> …`. A server under a different
  `CLAUDISH_PANE_ROOT` than the mod's is not listed.

**`mod.json` `"place": "right"` did not dock the panel.** Live: with the mod folder present when
Herdr.app first ran, the panel did not appear, and `seen.json` never listed `claudish`.
`herdr-app do pane.split '{"direction":"right","mod":"claudish"}'` shows it. The cause is not known.

`claudish herdr install-app-mod` copies the built mod into `mods/claudish/` under
`$HERDR_APP_HOME`, or `~/.config/herdr-app` when that is unset. It refuses when that home does not
exist. `herdr-app check` writes `gpui-kit.d.ts` and `jsconfig.json` into the folder it checks, so
it is run on a copy, and the installer skips those two files.

## FR9: no herdr or hc identity reaches a pane child

```ts
// pane/pane-launch.ts, read by isStrippedFromChildEnv
export const MULTIPLEXER_IDENTITY_PREFIXES = ["HERDR_"] as const;
export const MULTIPLEXER_IDENTITY_VARS = [
  "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "HC_SESSION", "HC_SOCKET",
] as const;
```

Every `HERDR_*` key and the five named `HC_*` variables are withheld from every child the server
starts. `HC_` is not a prefix: only those five names go. One predicate serves both spawners:

- `buildPaneEnv`: magmux's env, and the `CLAUDISH_PANE_ENV` snapshot taken from the same object;
- `claudeCodePrintEnv`: `run_prompt`'s print child.

`buildReplayEnv` is an allowlist and never had them.

The reason: before this, all six `HERDR_*` variables reached the pane child, and Claude Code inside
ran the user's herdr `SessionStart` hook against them. Reproduced against a fake socket, the hook
sent `pane.report_agent_session` with the CHILD's session id and transcript to the CALLER's
`$HERDR_PANE_ID`, with `seq = time_ns()`, newer than the caller's own report. Every
`create_session`, team slot and `run_prompt` child of a server inside herdr reported itself as the
caller's agent.

Live (check 8): after a full turn the caller pane w1:p1 had no agent (`agent_status: unknown`);
`ps eww` found 0 `HERDR_`/`HC_` variables in the session's magmux, claudish and claude, and 7
`HERDR_` names in the server (positive control).

`CLAUDISH_PANE_CHILD` is not in either set and stays untouched. It is how a process inside a
session knows it is one level deep ([`pane-session.md`](pane-session.md) § One level of nesting).
The cost of FR9: a user hook that wants the caller's herdr pane inside a child no longer gets it.
Nothing in claudish reads these variables there.

## Failure modes and cleanup

| Event | What happens |
|---|---|
| MCP server SIGKILLed | Kernel closes its sockets and lock descriptors. Viewers see EOF with a dead owner: no reconnect loop, "claudish server ended", agent released. Pane watchers reap magmux and remove `.sock`, `.view` and records; a replay's magmux dying frees its lock. Peers keep their last capture as `final`. The endpoint file and registry entries wait for the next sweep. |
| Clean shutdown | `replays.beginShutdown()`, then `server.closing` to every client, then the existing team, session and pane reaps. The endpoint is unlinked last, so a peer can still fetch a final screen. |
| magmux ignored `--view-sock` | `view_socket_unverified`, `view_socket: null`; the session runs, herdr shows no screen |
| `.view` bind failure | `magmux: view socket <path>: <err>`, exit 1, `pane_lost` |
| a viewer is slow | magmux coalesces frames latest-wins per subscriber; the local transport drops it at 4 MiB queued; a reconnect gets a fresh snapshot |
| relay SIGKILLed | noticed within 15 s while the panel is visible, else at the next show; items dropped, relay restarted |
| process table untrusted | nothing is judged dead: endpoints and the feed file stay. The replay locks never read the table |

**Who removes what.** `.view` goes with the pane's other files, at the same three places as `.sock`:

| Where | When | How |
|---|---|---|
| `removePaneFiles` | after a verified reap | beside the `.sock` |
| the pane watcher's script | the owner died | `rm -f -- "$ROOT/magmux-$PANE.view"` beside the `.sock` line |
| the startup sweep (`sweepRecordlessViewSockets`) | a later server starts | a recordless `magmux-c<pid>-*.view` whose owner is dead and whose control socket is gone |

The startup sweep (`sweepOrphanPanes`) also removes two more kinds of leftover:

- endpoint files whose owner a trusted process table proves dead;
- `feed/feed.json` of a relay the table proves dead. The stamp is read again before the unlink, so
  a relay that started meanwhile keeps its file.

Replay registry entries whose lock is free go in `replays.sweep()`, which the MCP server runs after
the pane sweep: by then a reaped orphan replay's magmux has freed its lock.

## What is not verified

- Focus behaviour with an attached herdr TUI client: S6 ran on a headless server. The live checks
  used a visible session and agree for the paths they drove.
- `flock` on Linux (`__errno_location`, the `O_CLOEXEC` value).
- Two real MCP server processes sharing one replay end to end: the tests run several servers in one
  process, with the lock holders as real child processes.
- Herdr.app's live list and screen: the mod runs the first `claudish` on its `PATH`, which was the
  released version without `view` during validation. `watchFolder` on an atomic rename is not
  settled either; the relay writes its tmp file in the watched folder and the 15 s check is the
  backstop.

## Triggers: read this file before you

- add a field or reply that could carry a socket path, or touch `pane/view-contract.ts`,
  `pane/view-socket.ts`, `viewSockPathOf` or the magmux argv (`--view-sock`, never `--view-op`);
- change `MIN_MAGMUX_VERSION`, the 0.x rule or candidate selection (magmux 1.0 lifts the major-0
  rule);
- add a `PaneSnapshot` field (classify it for `paneChangeKey`), a `ViewItem` field (add its
  notifier), or any timer to `view/`;
- edit `view/view-claims.ts` or a capture or resize path's `caller`;
- edit `view/kernel-lock.ts`, `view/replay-registry.ts`, `view/peer-link.ts`, the replay launcher's
  `exec 3>&-`, or `ReplayManager`'s holds and close;
- edit `herdr/herdr-socket.ts` (one connection per request), `herdr/reporter.ts` or the fake herdr;
- edit `herdr/app-mod/`, `view/feed-relay.ts` or `view/endpoint-watch.ts`;
- change `isStrippedFromChildEnv`, `MULTIPLEXER_IDENTITY_PREFIXES` or `MULTIPLEXER_IDENTITY_VARS`;
- change the sweep, the pane watcher's script or `removePaneFiles`.

## Where to look

| file | what |
|---|---|
| `pane/view-contract.ts` | `claudish.view.v1` wire types, `ViewItem`, `ViewErrorCode` |
| `pane/view-socket.ts` | the two-socket check before a `.view` path is published |
| `view/view-server.ts`, `view/view-client.ts`, `view/endpoints.ts` | the endpoint, ops, roles, bounds; the client and its reconnect rule |
| `view/change-key.ts`, `view/view-feed.ts`, `view/token-watch.ts` | the two change gates and the token-file watch |
| `view/view-claims.ts` | claims, TTLs, relative holders |
| `view/kernel-lock.ts`, `view/replay-registry.ts`, `view/peer-link.ts`, `mcp-session/replay-manager.ts` | replays shared across servers |
| `view/viewer.ts`, `view/magmux-view-client.ts`, `view/magmux-frame.ts`, `view/ansi-painter.ts` | `claudish view`; the frame decoder is a verbatim copy of magmux's `demo/rc/frame.ts` |
| `herdr/front-end.ts`, `herdr/herdr-socket.ts`, `herdr/reporter.ts` | a `claudish view` in a herdr pane: front end detection and the agent report |
| `herdr/app-mod/`, `herdr/hc-reporter.ts`, `herdr/osc7501.ts`, `view/feed-relay.ts`, `view/endpoint-watch.ts` | the Herdr.app front end |
| `pane/test-helpers/fake-herdr.ts` | the fake herdr 0.9.5 socket, one request per connection |
