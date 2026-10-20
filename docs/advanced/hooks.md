# Hooks

**Your own code, run by claudish at named points of a request and of a Claude Code session.**

A hook can change the request a model receives, repair a tool call, add text to or remove text from
a model's response before Claude Code sees it, and start a new turn on the user's behalf. Hooks
return **actions**: plain data that claudish checks, applies, logs and attributes to the hook. For
work no action covers, an **unsafe raw tier** hands a hook the live provider objects.

Hooks are trusted local code. claudish runs them in its own process, with no sandbox. Load only
modules you wrote or have read.

---

## Quick start

```bash
claudish hooks init          # writes ~/.claudish/hooks/example-hook.ts and claudish-hooks.d.ts
```

Add the module to `~/.claudish/config.json`:

```json
{
  "hooks": {
    "modules": ["~/.claudish/hooks/example-hook.ts"]
  }
}
```

Check it, then see where it sits among the built-in hooks:

```bash
claudish hooks check ~/.claudish/hooks/example-hook.ts
claudish hooks list
```

This is the file `claudish hooks init` writes:

```ts
/// <reference path="./claudish-hooks.d.ts" />
/**
 * An example claudish hook. Add its path to "hooks.modules" in
 * ~/.claudish/config.json, then run `claudish hooks list` to see it.
 *
 * Check it with: claudish hooks check example-hook.ts
 */
import type { HookDefinition } from "claudish/hooks";

export default {
  apiVersion: 1,
  id: "reply-language",
  description: "Asks foreign models to answer in English",
  routes: "foreign",
  on: {
    request(ctx) {
      ctx.log(`request for ${ctx.route.modelId}`);
      return [{ type: "injectSystemNote", text: "Always answer in English." }];
    },
  },
} satisfies HookDefinition;
```

**When a change takes effect.** Each claudish process loads its hooks once, at start. A new
interactive session or a new `create_session` / `team` child picks up an edit. The MCP server does
not: it runs the session events of every child it starts, so restart it after you change
`hooks.modules`. If a child produced an injection that the server cannot deliver, because the server
loaded no session hooks, claudish says so on stderr when the child ends:

```
[claudish] a pane child produced hook injections, but this process loaded no session hooks: restart the MCP server after changing hooks.modules
```

---

## Configuration

Hooks are read from the **global config only**: `~/.claudish/config.json`, or the file named by
`--config` / `CLAUDISH_CONFIG`, which replaces the global and the project config entirely. A `hooks`
key in a project `.claudish.json` is ignored, with one line:

```
[claudish] hooks in <path> ignored: hooks are read from the global config only
```

A project file is controlled by whoever controls the repository, and claudish will not run code it
names. A hook that should act only in some projects can check `ctx.session.cwd` or `ctx.harness`.

The same rule covers a repository choosing the config file itself, or posing as claudish's own
child process. A few environment variables steer claudish rather than configure a provider:
`CLAUDISH_CONFIG`, the pane-child markers (`CLAUDISH_PANE_CHILD`, `CLAUDISH_PANE_ENV`,
`CLAUDISH_PANE_CWD`), the hook inbox (`CLAUDISH_HOOK_INBOX`, `CLAUDISH_HOOK_SESSION`) and
`CLAUDISH_BIN`. They count only when they come from your shell, the MCP server's own `env`, or the
parent claudish that started the process. No file in the working directory can set them:

- claudish starts Bun with `--no-env-file`: the npm `claudish` command, the `dist/index.js`
  shebang, and every claudish child it spawns. The shebang uses `env -S`, which GNU and BSD `env`
  have and BusyBox `env` (Alpine) does not: there, use the npm `claudish` command or run
  `bun --no-env-file dist/index.js`. The release binary is built with Bun's `.env`
  autoload off. So Bun reads none of `.env`, `.env.local`, `.env.<NODE_ENV>` or
  `.env.<NODE_ENV>.local`.
- claudish reads `.env` in the working directory itself, and takes only provider API keys and
  claudish model settings from it, so none of these variables, and nothing like `CLAUDE_PATH` or
  `BUN_OPTIONS` that would choose the code claudish runs. If the file names one you have not set, claudish prints one
  line and goes on without it:

  ```
  [claudish] ignoring CLAUDISH_CONFIG in .env: a repository's .env may set only provider API keys and claudish model settings. Set it in your shell, or pass --config.
  ```

- If Bun was started some other way and did load those files (a hand-typed `bun <path>/index.js`,
  or `bun <path>/claudish.cjs`), claudish cannot tell their values from yours, so it drops every one
  of these variables and every name those files set, with one line naming them, and reads
  `~/.claudish/config.json`. Run the installed `claudish` command, or start Bun with
  `--no-env-file`.

`--config` is always honoured, because you typed it, and team slots and channel sessions receive it
from the claudish that started them.

```jsonc
{
  "hooks": {
    // Loaded in order. Absolute, "~/…", or relative to the config file's directory.
    "modules": ["~/.claudish/hooks/verify-tests.ts", "hooks/tidy-reply.ts"],

    // Severity per hook id. Key: "[modelGlob:]hookIdGlob". Value: "off" | "warn" | "fix".
    "severity": {
      "plan-mode/*": "warn",
      "gpt-5.6-*:plan-mode/plan-file-path": "fix",
      "hook:tidy-reply/*": "off"
    },

    // Most hook-caused turns in a row in one session. Integer 1..20, default 3.
    "injection": { "maxConsecutive": 3 },

    // The built-in observer. mode is "off" or "suggest".
    "observer": { "enabled": false, "mode": "off" },

    // Upload consent for behaviour telemetry. Default off. The local journal is always on.
    "telemetry": { "enabled": false }
  }
}
```

| Key | Meaning |
|---|---|
| `modules` | Hook modules, loaded in this order. A relative path resolves against the directory of the config file, never the working directory. |
| `severity` | Overrides a hook's default severity. See [Severity](#severity). |
| `injection.maxConsecutive` | The cap on consecutive hook-caused turns. A turn the caller or a person starts resets the count. |
| `observer` | The built-in `observer/divergence` hook: `enabled`, `mode` (`off` or `suggest`), `model`, `timeoutMs`, `watchTools`. |
| `telemetry.enabled` | Consent to upload behaviour telemetry. `claudish hooks telemetry --enable` sets it. |

An invalid `hooks` block never stops claudish. It prints one line per problem, prefixed
`[claudish] hooks config:`, and runs with built-in hooks at their default severity and no user
modules.

### Severity

| Severity | Effect |
|---|---|
| `off` | The hook is not called. |
| `warn` | The hook is called at its place in the chain. Its actions are journaled as `warned` and not applied, so the hooks after it see no change. A `toolCall` or `responseRewrite` hook at `warn` never holds the stream: it sees the response as it was delivered. |
| `fix` | The hook is called and its actions are applied. This is the default for your hooks. |

A key is `hookIdGlob` or `modelGlob:hookIdGlob`. `*` matches any run of characters, `/` included.
Model-scoped keys beat unscoped keys. Within each group an exact id beats a glob, and a longer glob
beats a shorter one. A key that starts with `hook:` is a hook id, never a model scope. For proxy
events the model is the bare model name the route serves. For session events it is the model the
caller asked for.

---

## Writing a hook

A module's **default export** is one hook definition or an array of them. Nothing else in the
module is read.

| Field | Required | Meaning |
|---|---|---|
| `apiVersion` | yes | Must be `1`. |
| `id` | yes | Lowercase letters, digits, `.`, `_`, `-`, with `/` between segments; at most 64 characters. |
| `description` | no | Shown by `claudish hooks list`. |
| `defaultSeverity` | no | `off`, `warn` or `fix`. Default `fix`. |
| `order` | no | `pre`, `normal` or `post`. Default `normal`. |
| `models` | no | A glob or a list of globs on the bare model name. Default `*`. Proxy events only. |
| `routes` | no | `foreign`, `native` or `all`. Default `all`. Proxy events only. |
| `timeoutMs` | no | Per handler call, clamped to the event's maximum and to what is left of the event's budget when your hook's turn comes (see [Events](#events)). |
| `on` | one of `on` or `raw` | The event handlers. |
| `unsafe`, `raw` | together | The raw tier. See [The unsafe raw tier](#the-unsafe-raw-tier). |

A hook's **effective id** is `hook:<module file name without extension>/<id>`, for example
`hook:verify-tests/verify-tests`. Built-in hooks carry no prefix, so a user hook can never take a
built-in's id. Use the effective id in `severity` keys.

**A module that cannot load is skipped, and claudish starts anyway.** Each problem prints one line
naming the module and the reason:

- an import error, a throw during import, or an import slower than 10 seconds;
- no default export, or an export that is not an object;
- `apiVersion` missing or not `1`:
  `[claudish] hook <module>#<id>: apiVersion 2 is not supported (this claudish supports 1)`;
- an invalid field, an unknown key in `on` or `raw` (`on.onRequest is not a hook event`), or no
  handler at all;
- `raw` without `unsafe: true`, or a `raw.providerChunk` declared `async`;
- two modules with the same file name: the later one is skipped whole
  (`hook module b/ping.js skipped: its name "ping" is already used by a/ping.ts; rename one`);
- a second hook with the same id in one module: the first is kept.

`claudish hooks check <file>` runs the same checks on one file and exits 1 when it is invalid.

### Types

Two ways to get types, and both need nothing installed:

1. **Type-only import.** `import type { HookDefinition } from "claudish/hooks"` with
   `export default { … } satisfies HookDefinition`. The import is erased when the module loads. Your
   editor finds the types in the `claudish-hooks.d.ts` that `claudish hooks init` writes, or in the
   npm package (`npm i -D claudish`), which exports `claudish/hooks`.
2. **Value import.** `import { defineHook, act } from "claudish/hooks"`. claudish serves this module
   itself when it loads your hook. `defineHook` returns its argument and gives the editor full
   inference. `act` builds actions: `act.appendText("…")` equals `{ type: "appendText", text: "…" }`.

Modules may be `.ts` or `.js`.

### Logging

Log with `ctx.log(message)`. It writes to claudish's debug log, prefixed `[hook <id>]`. Anything a
hook writes with `console.*`, `process.stdout.write` or `process.stderr.write` goes there too. None
of it reaches the terminal, Claude Code's screen or the MCP protocol stream. The debug log is written
only when claudish runs with `--debug-claudish` (or `-d`, or `CLAUDISH_DEBUG=1`), into `logs/` in the
working directory. That includes the MCP server: `claudish --mcp --debug-claudish`.

The MCP server keeps its protocol stream clean by giving standard output to the protocol writer
alone. On a platform where it cannot do that, the MCP server loads built-in hooks only, and says:

```
[claudish] hook modules not loaded by the MCP server: this platform cannot keep hook output off the MCP protocol stream
```

Every released claudish binary target can.

**Where claudish's own `[claudish] …` lines go.** To stderr, with one exception. Once the
interactive launcher has handed the screen to Claude Code, they go to `~/.claudish/diag-<pid>.log`
for the life of the session (deleted when it ends), and to the debug log when it is on. Load-time
lines, such as a module that failed to load, print before Claude Code starts.

---

## Events

There are two pipelines. **Proxy events** happen to one request on its way to a provider and back.
**Session events** happen to the Claude Code session claudish runs in a magmux pane.

| Event | Fires | Allowed actions | Timeout per hook (default / max) · budget for all hooks |
|---|---|---|---|
| `request` | Once per upstream attempt, on the Claude-format request, before it is converted for the provider. Each provider the routing chain tries is a new attempt. | `injectSystemNote`, `appendUserText`, `replaceMessageText`, `removeMessageText`, `rewriteToolDescription`, `replaceToolDescription`, `replaceToolSchema`, `removeTool`, `warn` | 1 s / 5 s · 5 s |
| `toolCall` | For each `tool_use` block whose tool the hook lists, once its arguments are complete. | `repairToolArgs`, `warn` | 1 s / 5 s · 5 s per call |
| `responseRewrite` | Once per response the hook claimed, when the response's `message_delta` arrives. | `appendText`, `prependText`, `replaceText`, `removeText`, `warn` | 2 s / 10 s · 10 s |
| `responseEnd` | Once per successful response, after the response's end was sent to Claude Code. Every response counts: tool-loop steps, the final answer, side requests. | `injectSystemNote`, `injectUserTurn`, `annotateTurn`, `warn` | 5 s / 30 s · 30 s |
| `sessionStart` | When the session starts (details below). | `injectUserTurn`, `warn` | 5 s / 30 s · 30 s |
| `sessionIdle` | Once each time a turn settles, before claudish decides what the session does next. | `injectUserTurn`, `warn` | 5 s / 30 s · 30 s |
| `sessionBlocked` | A question (`AskUserQuestion`) or a permission or plan dialog opened. | `warn` | 5 s / 30 s · 30 s |
| `sessionEnd` | The session ended. | `warn` | 1.5 s · 1.5 s |

**Hooks run in a chain.** The hooks of one event run **one after another**, in effective order:
`order` (`pre`, then `normal`, then `post`), then built-in hooks before yours, then the order of
`hooks.modules`, then export order. `claudish hooks list` prints this order. Each hook's actions are
applied before the next hook is called, so a hook sees the request, the tool arguments or the
response **as the hooks before it left them**. `ctx.prior` lists what those hooks did, with their
ids. A hook at `warn`, or one that fails, changes nothing for the hooks after it.

A handler may be `async`. Each one gets its own timeout and its own `AbortSignal` (`ctx.signal`).
Because the hooks of an event take turns, their times add up, so every event also has a **budget**
for all its hooks together (the last column above). Your hook's timeout is cut to what is left of
the budget when its turn comes; if nothing is left, it is skipped and journaled `skipped`. Keep
`request` hooks fast: they run before the request is sent. Different requests, and different tool
calls of one response, still run independently.

### Proxy events

Every proxy context carries `ctx.route` (`modelId`, `provider`, `native`), `ctx.request` (the model
Claude Code asked for, `stream`, the system prompt as text, and read-only views of `messages` and
`tools`), `ctx.harness` (plan mode, the plan file path, the Claude Code session id, the skill
listing), `ctx.host.mode` and `ctx.session`.

`ctx.session` says which pane session a request belongs to: `{ kind, id, role }`, where `role` is
`"slot"` or `"judge"` in a team run. It is set in `create_session` and `team` children. It is `null`
in the interactive launcher and in `claudish serve`.

- **`request`** sees the request after claudish turned it into Claude format, after the actions of
  every hook before it in the chain, and before any provider conversion. Change it only through
  actions. Tool descriptions already show earlier hooks' description changes. `ctx.harness` is
  worked out once, from the request as Claude Code sent it, and is the same for every hook.
- **Every context is read-only, all the way down.** `ctx.request` (its `messages`, every message and
  every tool schema), `ctx.harness`, `ctx.route`, `ctx.session`, the actions in `ctx.prior`,
  `ctx.tool.args` and `ctx.response` are frozen, so a write or an in-place `reverse()`, `sort()` or
  `push()` throws (the hook fails as any throwing hook does) and never changes what is sent or what
  the next hook sees. Change things only through actions; to repair arguments, return a new object,
  such as `act.repairToolArgs({ ...ctx.tool.args, file_path: path }, "reason")`.
- **`toolCall`** is an object, not a function:
  - `tools`: the tool names this hook sees. `"*"` means every tool, which holds every tool call's
    input until it is complete.
  - `armed(ctx)`: optional and synchronous, called once per request with the request context. Return
    `false` to skip this request. A throw counts as `false`.
  - `observe: true`: see the call after it was forwarded. Such a hook can only `warn`, and never holds
    the stream.
  - `handle(ctx)`: receives `ctx.tool` (`id`, `name`, `args`, `rawArgs`). `args` are the arguments
    after any repair an earlier hook made; `rawArgs` is always the model's own JSON. If the model's
    arguments are not valid JSON, no hook is called and the block passes unchanged.

  Only the listed tool's block is held. Other blocks, text and pings keep flowing.
- **`responseRewrite`** is an object: `claims(ctx)` and `handle(ctx)`. See
  [Rewriting a response](#rewriting-a-response).
- **`responseEnd`** receives `ctx.response`: the response **as Claude Code received it**, after any
  rewrite and any raw replacement. It holds the blocks, the joined `text` and `reasoning`, the
  `toolNames` called, and `stopReason`. A `stopReason` of `"tool_use"` marks a step of a tool loop:
  the turn goes on after the tool runs. `responseEnd` blocks nothing. For turn-level decisions, use
  `sessionIdle`.

`models` and `routes` filter proxy events only. Hooks never see token-count requests, Claude Code's
auto-mode classifier calls, `--monitor` traffic, `--probe` traffic, or responses with a non-2xx
status.

### Session events

Every session context carries `ctx.session`:

| Field | Meaning |
|---|---|
| `kind` | `interactive` (the launcher), `channel` (`create_session`) or `team` |
| `role` | `"slot"` or `"judge"` in a team run; `null` otherwise |
| `id` | the channel `session_id`, `<run_id>:<slot id>` for a team, or the Claude Code session id for the launcher |
| `claudeSessionId` | the Claude Code session id, when known |
| `model` | the model the caller asked for |
| `cwd` | the session's working directory |
| `shape` | `interactive` or `one-shot` |
| `injection` | `available` when claudish can type into the session, else `unavailable` |

- **`sessionStart`** fires in a pane session when the initial prompt starts, or when Claude Code is
  ready if there is no prompt. In the interactive launcher it fires at the first empty input box. An
  injection it returns is delivered at the first idle after the initial turn.
- **`sessionIdle`** receives `ctx.turn`: `index` (1-based; a turn that a background task wakes again
  keeps its index, and fires `sessionIdle` again when it settles), `answer`, `stopReason`,
  `apiError`, `hookCaused`, and `annotations`. It also receives `ctx.consecutiveHookTurns` and
  `ctx.callerInputPending`: when that is `true`, the caller's input goes next, and an injection
  returned now is dropped as stale.
- **`sessionBlocked`** receives `ctx.block`: `{ kind: "question" | "permission", text }`. A hook
  cannot answer the dialog.
- **`sessionEnd`** receives `ctx.outcome`: `{ state, reason, exitCode }`. In a pane session it never
  delays the end. In the interactive launcher claudish waits up to 1.5 s for it before shutting down.

`sessionIdle` and `sessionBlocked` need a pane claudish can read. The interactive launcher without
one (no terminal, no magmux, or `-p`) fires only `sessionStart`, at spawn, and `sessionEnd`, at exit.

---

## Actions

Return an array of actions, or nothing. An action an event does not allow is `invalid` and ignored.
A hook returns at most 64 actions per call; any beyond the 64th are journaled `invalid`
(`too_many_actions`) and not applied.

| Action | What it does |
|---|---|
| `injectSystemNote` `{ text }` | Appends 1–20,000 characters to the system prompt, as a new paragraph or a new text block. A text an earlier hook of the same request already added is journaled `superseded` and not added again. It reaches every route, chat-completions providers included. Returned from `responseEnd`, it waits for the same Claude Code session's next request that gets a 2xx response. With no session id it is dropped. |
| `appendUserText` `{ text }` | Adds a text block (1–20,000 characters) at the end of the last `user` message, after any tool results. A text an earlier hook already appended is `superseded`. |
| `replaceMessageText` `{ find, replace, regex?, flags?, roles? }` | Replaces text in the text blocks of messages whose role is in `roles` (default `["user"]`). Never touches tool calls, tool results, thinking, images or documents. A text block left empty is dropped. An edit that would empty a message is undone for that message. |
| `removeMessageText` `{ find, regex?, flags?, roles? }` | `replaceMessageText` with an empty replacement. |
| `rewriteToolDescription` `{ tool, append }` | Appends 1–4,000 characters to a tool's description as the hooks before you left it; later hooks see the result. Applied after claudish shortens tool descriptions (`--summarize-tools`), so the appended text always survives. |
| `replaceToolDescription` `{ tool, description }` | Replaces a tool's description (1–20,000 characters), at the same point. |
| `replaceToolSchema` `{ tool, inputSchema }` | Replaces a tool's current input schema; later hooks see yours: a JSON object with `type: "object"`, at most 64 KiB. |
| `removeTool` `{ tool }` | Removes a tool from the request; later hooks no longer see it. Refused while any message holds a call to that tool. |
| `repairToolArgs` `{ args, reason }` | Replaces a tool call's current arguments (at most 1 MiB of JSON); later hooks see yours in `ctx.tool.args`. |
| `appendText` `{ text }` | Appends to the last text block of the response. With no text block, inserts a new one just before the first tool call, or at the end. |
| `prependText` `{ text }` | Prepends to the first text block. With no text block, inserts one at the start of the held part, after any leading thinking. |
| `replaceText` `{ find, replace, regex?, flags? }` | Replaces text in each text block of the response, one block at a time. |
| `removeText` `{ find, regex?, flags? }` | `replaceText` with an empty replacement. A text block left empty is dropped. |
| `injectUserTurn` `{ text }` | Starts a new user turn when the session is idle. 1–100,000 characters, and it must not start with `/`. See [Starting a new turn](#starting-a-new-turn). |
| `annotateTurn` `{ key, value }` | Attaches a JSON value (at most 16 KiB) to the current turn. It arrives in `sessionIdle` as `ctx.turn.annotations`. `key` matches `^[a-z0-9][a-z0-9._-]{0,63}$`. Never uploaded. |
| `warn` `{ message }` | Logged and journaled. Changes nothing. |

**Matching.** `find` is literal by default and replaces every occurrence. A literal `replace` is
inserted as written: `"$500"` stays `$500`. With `regex: true`, `find` is a regular expression
source, `flags` is a subset of `gimsuy` (default `"g"`), and `$1`, `$<name>`, `$&` and `$$` work in
`replace`. An action with `flags` but no `regex: true` is `invalid` and ignored, so a typo never
turns into a silent literal match.

**Order.** Every action applies over the result of every action before it: your own earlier actions
in the order you returned them, and everything the hooks before you did. Nothing is first-wins: two
hooks changing one tool's description, one tool's schema or one tool call's arguments both apply, in
chain order, and the second sees the first's result. A `replaceToolDescription` therefore drops any
text an earlier hook appended, a built-in hook's included; append instead, or check `ctx.prior`. A
duplicate system note or appended user text from a later hook, or an action on a tool an earlier
hook removed, is journaled `superseded`. Injections from several hooks merge into one turn.

**Failures never break a request or a session.** A throw, a rejected promise, a timeout or an invalid
return value counts as "no actions" and is journaled; the chain goes on, and the next hook sees what
the failed one saw. A skip is not counted. A timeout counts unless the hooks before yours cut your
turn short by more than max(250 ms, 10% of your hook's own timeout), or by more than half your
hook's own timeout when that is less: then the budget, not your hook, ran out, and it is not
counted. A smaller cut is just the time the earlier hooks normally
take, so a hook that hangs is still counted when other hooks run before it. After 5 failures in a
row a hook is disabled for the rest of the process, with one line:
`[claudish] hook <id> disabled after 5 consecutive failures (see the debug log)`. One success resets
the count.

---

## Where hooks run

A hook module's **top-level state belongs to one process**. Which process runs an event depends on
how Claude Code was started:

| How Claude Code runs | Proxy events run in | Session events run in |
|---|---|---|
| Interactive launcher (`claudish`, `claudish -i`) | the claudish process | the same process |
| `create_session` child (MCP) | the child's own claudish process | the MCP server |
| `team` slot or judge (MCP or CLI) | the child's own claudish process | the MCP server, or the `claudish team` process |
| `claudish serve`, the MCP server's own `run_prompt` | that process | none: there is no session |

So in a `create_session` or `team` child, a variable your `responseEnd` handler sets is **not** the
variable your `sessionIdle` handler reads. They are two copies in two processes. To carry what one
turn's responses saw into `sessionIdle`, return **`annotateTurn`** from `responseEnd`. It travels with
the turn and arrives in `ctx.turn.annotations`, in arrival order, in every setup. Filter by
`a.hookId === ctx.hookId` to read only your own.

**The interactive launcher.** When a loaded hook declares `responseEnd` or a session event, claudish
needs a pane to read and type into. Started from a normal terminal, it runs Claude Code inside a
visible magmux, even with `--no-recovery` (the recovery banner and retry watchdog stay off). Started
inside a magmux pane, it uses that pane. With no terminal, no magmux or `-p`, injections are dropped,
with one line:

```
[claudish] hook injection dropped: this claudish process has no Claude Code session to deliver it to
```

---

## Starting a new turn

`injectUserTurn` types a user message into the session, which starts a new turn. It works in the
interactive launcher and in `create_session` and `team` children. An injected turn is a user
message, and the model acts on it as on anything you type, with the session's permissions, so
inject an instruction ("Run the test suite and report the result."), never a bare marker or token
that leaves the model to guess what you meant. The rules:

1. **Only when idle.** The turn has settled, the input box is empty, no dialog is open and nothing is
   running. In the interactive launcher the box must also have stayed empty and unchanged for 1.5 s,
   so claudish never types into a prompt you are writing. claudish re-reads the transcript and the
   screen at the moment it would type, not only on its last periodic check: a background task that
   woke the model, or a prompt you just submitted, makes the injection wait. If the model was woken,
   the turn runs on and the `responseEnd` injections are offered again when it settles; the
   `sessionIdle` ones are dropped `rewake`.
2. **Never over anything.** claudish never presses Esc for an injection, and never types into a
   dialog or a running turn.
3. **The caller goes first.** `send_input`, or a prompt you type, always goes before an injection. An
   injection queued before a caller turn starts is dropped as `stale`. A `sessionStart` injection
   survives the session's initial prompt. Caller input that arrives while `sessionIdle` hooks run
   ends the wait at once and drops that wait's injections.
4. **One turn per idle.** Every injection waiting at one idle merges into one message: `sessionStart`
   injections, then those from `responseEnd` in arrival order, then those from `sessionIdle` in
   chain order. They are joined with a blank line, and exact duplicates appear once. However many
   hooks inject, it is one turn against the cap. A hook can see an earlier hook's injection in
   `ctx.prior` and skip its own.
5. **A cap.** At most `hooks.injection.maxConsecutive` (default 3) hook-caused turns in a row. A
   caller turn resets the count. Over the cap, the injection is dropped `capped`.
6. **Delivery.** A single line of up to 512 characters is typed. Anything else goes into a file that
   Claude Code is told to read. When the Read tool is not available, such a message is dropped
   `delivery_unavailable`.
7. **Expiry.** An injection not delivered within 10 minutes is dropped `expired`.
8. **Never mid-turn.** An injection returned from `responseEnd` waits for the turn to settle, even when
   the response was a tool-loop step.

Every drop is journaled. A pane session also records it in its `events.jsonl` as
`hook_injection_dropped:<reason>`, and records `hook_injection_delivered` for a delivered one.

An injection is always typed text or a turn file. Its text may not start with `/`: hook text never
runs a slash command. In `create_session` and `team` children the injections cross from the child's
proxy to the session's owner through a file, and the owner checks every line again against the same
rules (`/`, the 100,000-character limit, annotation keys and sizes) before it queues anything. A
line that fails is dropped `invalid`.

In an interactive session, the turn an injection follows is judged first, as any turn is. A turn
that ended in an API error fails the session, and the injection is dropped `session_ended`. A task
file you sent with `send_input` that was not fully read is still reported as `prompt_not_read`.

Residual race in the interactive launcher: a key pressed in the instant between claudish's last check
and its typing joins the injected line. magmux has no atomic "type only if empty".

### One-shot sessions and team slots: the turn chain

A one-shot `create_session` and every `team` slot normally end at their first settled turn. An
injection changes that: it **extends the session's turn chain**, and the session ends when the chain
settles.

- The session reports `RUNNING` from the first turn to the last. It never reports `AWAITING_INPUT`
  between chain turns, and its `shape` stays `one-shot`.
- The session's answer is every chain turn's answer joined with a blank line. `get_output` grows
  turn by turn, and a team slot's `response-<slot>.md` is rewritten after each chain turn.
- `require_pattern` passes when it matches the joined answer **or any single turn's answer**, so a
  pattern anchored with `^` still finds the turn that starts with it.
- Whether the prompt was read is judged on the **first** turn, the one the caller's prompt started.
  An injected turn delivered as a file and not read records `hook_injection_not_read` and changes no
  verdict.
- `timeout_seconds` covers the whole chain. A hook never extends the caller's deadline. A timeout
  mid-chain keeps every answer already recorded.
- An injected turn that Claude Code never accepts is dropped `send_not_accepted`, and the session
  ends on the chain so far.
- The cap applies: by default a slot runs at most 3 extra turns.

In an interactive `create_session` and in the launcher, an injection simply becomes the next turn,
with no `waiting_for_input` between the two.

### Judges

A team run's judges are team children too, and hooks run in them. `ctx.session.role` is `"judge"` for
a judge, in session events and in proxy events alike. An injecting hook would extend a judge's
verdict into a chain, and a rewriting hook would edit it. **Skip judges** unless you mean to change
how a team is judged:

```ts
if (ctx.session?.role === "judge") return;
```

---

## Rewriting a response

Response rewriting is **opt-in buffering**. A request is held only when a `fix`-severity
`responseRewrite` hook claims it. Every other request streams exactly as it would with no hooks.

```ts
responseRewrite: {
  claims(ctx) { /* synchronous; true = hold this request's response */ },
  handle(ctx) { /* ctx.response is the held response, with earlier hooks' edits; return text actions */ },
}
```

- **`claims(ctx)`** runs once per request, before the response starts, with the request context.
  Omitted, it counts as `true`, which holds every response on the routes and models the hook
  matches. Narrow it with `models`, `routes` and `claims`. A throw counts as `false`.
- **What is held.** The message start and any leading thinking blocks stream live. From the first
  other block (text, tool call, anything else) until `message_delta`, claudish holds the response.
  Pings still pass through, and claudish sends its own once a second while it waits, so Claude Code
  never times out.
- **The cost.** Text and tool input of a claimed response reach Claude Code all at once, at the end,
  instead of streaming. Claude Code runs a tool only once its call is complete, so tools are not
  delayed. What you lose is the live display.
- **Limits.** If more than 8 MiB is held, claudish sends everything unchanged and stops holding. A
  text block that carries citations is never rewritten.
- `stream: false` requests are rewritten the same way, on the JSON body.

---

## The unsafe raw tier

For what no action covers, a hook can declare `unsafe: true` and a `raw` object. Raw hooks receive
provider-format objects. claudish cannot check what a raw hook writes into them.

```
[claudish] hook hook:hide-reasoning/hide-reasoning is UNSAFE (raw middleware): it receives live request and response objects
```

That line prints when the module loads. Every request a raw hook touches also writes one journal line
(`decision: "raw"`) and one debug-log line.

| Stage | Runs | Gets |
|---|---|---|
| `providerRequest(ctx)` | after the request actions, before the request is sent; routes that convert the request (not native Anthropic) | clones of `claudeRequest`, `messages` and `tools` in provider format |
| `providerChunk(ctx)` | for each parsed provider event, on the `openai-sse` and Responses stream formats | a clone of the event in `ctx.chunk`, its delta in `ctx.delta`, and a per-stream `ctx.metadata` map |
| `providerStreamEnd(ctx)` | when the provider stream ends, on the `openai-sse`, Responses and Gemini stream formats | `ctx.metadata` |
| `response(ctx)` | on the Claude-format response, every route | a replay of the response in `ctx.response`; return a new `Response` to replace it |

Raw contexts have no `ctx.log`. Use `console.*`, which goes to the debug log.

The raw hooks of one stage run in a chain too: one after another, in effective order, each on what
the one before it committed. A stage runs after the closed hooks of its point: `providerRequest`
after every `request` hook, `response` after every `responseRewrite` hook. A hook with both closed
and raw handlers takes a turn in each chain.

### What containment covers

A failing raw hook is contained like any other: the request goes on as if the hook had not run.

- **Clone and commit.** `providerRequest` and `providerChunk` work on copies. The copies replace the
  real objects only when the call returns normally (and, for `providerRequest`, within its timeout).
  A throw, a rejection or a timeout discards every change, so a hook that empties `messages` and then
  throws changes nothing.
- **`providerChunk` must be synchronous.** It runs on the parser's loop. Declared `async`, the module
  is rejected at load:
  `raw.providerChunk must be synchronous (it runs on the parser's loop)`. A plain function that
  returns a promise is caught on each call: its copy is discarded even if it was edited first, the
  call counts as a failure, and a later rejection is journaled, never thrown. On a normal return the
  copy is committed as a whole: it **becomes** the event the parser reads, so edits through
  `ctx.delta`, replacements of `ctx.chunk` and deleted fields all take effect.
- **A replacement is held whole.** claudish reads the original response to its end itself, so a hook
  that ignores `ctx.response` delays nothing. A replacement is forwarded only after it closes cleanly
  within the hook's timeout. On any failure the original goes to Claude Code from its first byte.
  Claude Code never sees part of a replacement.
- **The bytes you read are yours.** Each chunk `ctx.response` yields is a copy. Editing it in place
  changes nothing that is forwarded: the original Claude Code gets on a failure, or at `warn`, is the
  bytes the provider sent.
- **`ctx.response` ends when the call does.** Read it inside `response(ctx)`, or in the `Response`
  you return. A hook that returns nothing and keeps reading in the background sees the stream end
  early. A returned replacement built from `ctx.response` is read to the original's end, at `fix`
  and at `warn`.
- **Severity.** At `warn` a raw hook runs on copies that are never committed, so the next raw hook
  starts from the uncommitted state, and a replacement is read and discarded.

Containment does **not** cover what a raw hook does on purpose. A hook that returns normally after
emptying `messages`, or a replacement that closes cleanly with malformed content, is applied as
written. That is what `unsafe` means.

| Raw stage | Timeout per hook (default / max) · budget for all hooks |
|---|---|
| `providerRequest` | 1 s / 5 s · 5 s |
| `providerChunk` | none: it is synchronous |
| `providerStreamEnd` | 1 s / 5 s · 5 s |
| `response` | 1 s / 5 s, for the call and again for the replacement to close · no budget: each hook keeps its own deadlines |

### Example: hide streamed reasoning

```ts
/// <reference path="./claudish-hooks.d.ts" />
/**
 * UNSAFE: a raw hook. It receives provider-format objects, and claudish
 * cannot check what it writes into them.
 */
import type { HookDefinition } from "claudish/hooks";

export default {
  apiVersion: 1,
  id: "hide-reasoning",
  description: "Drops streamed reasoning text before claudish converts it to thinking blocks",
  unsafe: true,
  models: "kimi-*",
  raw: {
    // Synchronous. It runs on a clone of each parsed provider event; on a
    // normal return the clone, deletions included, is what the parser reads.
    providerChunk(ctx) {
      if (!ctx.delta) return;
      const hadReasoning = "reasoning_content" in ctx.delta;
      delete ctx.delta.reasoning_content;
      if (hadReasoning) ctx.metadata.set("hid", ((ctx.metadata.get("hid") as number) ?? 0) + 1);
    },
    providerStreamEnd(ctx) {
      // console output from a hook goes to claudish's debug log.
      console.log(`hid ${ctx.metadata.get("hid") ?? 0} reasoning chunks`);
    },
  },
} satisfies HookDefinition;
```

---

## Worked example 1: inject a user turn and start a new turn

**Goal.** When a model says the tests pass but ran no command during the turn, start one more turn
that asks it to run them.

**How.** A turn is many responses: each tool call is a step. `responseEnd` sees each response and
records, with `annotateTurn`, that a command ran. `sessionIdle` fires once when the turn settles,
reads the annotations, and returns `injectUserTurn` when no command ran.

The two handlers may run in different processes (see [Where hooks run](#where-hooks-run)), which is
why the fact travels as an annotation and not as a module variable.

```ts
/// <reference path="./claudish-hooks.d.ts" />
/**
 * Starts one extra turn when the model says the tests pass but ran no
 * command during the turn.
 */
import type { HookDefinition } from "claudish/hooks";

export default {
  apiVersion: 1,
  id: "verify-tests",
  description: "Asks the model to run the tests when it claims they pass without running them",
  on: {
    // A proxy event. In a team slot or a create_session child it runs in the
    // pane child's claudish process.
    responseEnd(ctx) {
      if (!ctx.response.toolNames.includes("Bash")) return;
      return [{ type: "annotateTurn", key: "ran-command", value: true }];
    },

    // A session event. It runs in the process that drives the pane, which may
    // be a different process: module variables set above are not visible here,
    // but the annotation is.
    sessionIdle(ctx) {
      if (ctx.session.role === "judge") return; // never change a judge's verdict
      if (ctx.turn.hookCaused) return; // one extra turn per human turn
      if (ctx.callerInputPending) return; // it would be dropped as stale
      const ranCommand = ctx.turn.annotations.some(
        (a) => a.hookId === ctx.hookId && a.key === "ran-command"
      );
      if (ranCommand || !/\btests? (all )?pass/i.test(ctx.turn.answer)) return;
      return [
        {
          type: "injectUserTurn",
          text: "You said the tests pass, but you ran no command this turn. Run the test suite and quote its summary line.",
        },
      ];
    },
  },
} satisfies HookDefinition;
```

**What happens.**

1. The model answers "All tests pass." without calling `Bash`. No annotation arrives.
2. The turn settles. `sessionIdle` finds the claim and no annotation, and returns the injection.
3. claudish waits until the session is idle, then types the line. It is one line under 512
   characters, so it is typed, not sent as a file.
4. The model runs the tests in a new turn. That turn has `hookCaused: true`, so the hook returns
   nothing, and the cap is never reached.

In a `team` slot the slot's answer becomes both turns joined, and the slot ends after the second
turn. In the interactive launcher the new turn appears in your session as if you had typed it.

---

## Worked example 2: add and remove text in a model response

**Goal.** Remove a closing pleasantry that some models add, and put the model's name under its final
answer.

**How.** A `responseRewrite` hook, scoped with `models` and `claims` so that only the responses it
edits are held.

```ts
/// <reference path="./claudish-hooks.d.ts" />
/**
 * Removes a closing pleasantry and appends the name of the model that
 * answered. Only the requests this hook claims are buffered.
 */
import { type RewriteAction, act, defineHook } from "claudish/hooks";

export default defineHook({
  apiVersion: 1,
  id: "tidy-reply",
  description: "Removes a closing pleasantry and names the model under its answer",
  models: ["glm-*", "kimi-*"],
  routes: "foreign",
  on: {
    responseRewrite: {
      // Decided per request, before the response starts. Unclaimed requests
      // stream as if the hook did not exist.
      claims: (ctx) => ctx.session?.role !== "judge",
      handle(ctx) {
        const actions: RewriteAction[] = [
          act.removeText("\\s*I hope this helps[.!]?\\s*$", { regex: true, flags: "i" }),
        ];
        // "tool_use" is a step in a tool loop; the turn goes on after the tool
        // runs. Mark only the response that ends the turn.
        if (ctx.response.stopReason !== "tool_use") {
          actions.push(act.appendText(`\n\n_${ctx.route.modelId}_`));
        }
        return actions;
      },
    },
  },
});
```

**What happens.** A `glm-5` answer ending

```
Fixed the off-by-one in parse().

I hope this helps!
```

reaches Claude Code as

```
Fixed the off-by-one in parse().

_glm-5_
```

The removal applies to each text block on its own, so `$` means the end of a block. The append goes
to the last text block. On a response with no text block, `appendText` inserts a new block just
before the first tool call, which is why the example skips tool-loop steps. Requests to other models,
and requests from team judges, are not held at all.

---

## Commands

| Command | What it does | Exit |
|---|---|---|
| `claudish hooks list [--json]` | Every hook, built-in and yours, in effective order, with its source, events, default and resolved severity, routes, models, order and `UNSAFE` flag. Then the modules that failed to load, and whether a `behavior` block is still in the config. | 0 |
| `claudish hooks check <file> [--json]` | Loads one module on its own and validates it. | 0 valid, 1 invalid |
| `claudish hooks init [dir]` | Writes `example-hook.ts` and `claudish-hooks.d.ts` into `dir` (default `~/.claudish/hooks`). Refuses to overwrite either file. | 0, or 1 if a file exists |
| `claudish hooks corpus [--write] [--json]` | Replays recorded Claude Code transcripts offline and counts plan-mode divergences per model. | 0 |
| `claudish hooks telemetry [--enable \| --disable] [--json]` | Shows or sets `hooks.telemetry.enabled`, and says what is sent and what never is. | 0 |

### Built-in hooks

| Id | What it does |
|---|---|
| `gemini/thought-signature` | Raw. Carries Gemini thought signatures between turns: on a Gemini-API wire or a Google model behind a gateway, as the model catalog lists the route, and otherwise for model names containing `gemini` or `google/`. |
| `plan-mode/plan-file-path` | Foreign routes. In plan mode, puts the assigned plan-file path into the `ExitPlanMode` tool description, and moves a `Write`, `Edit` or `NotebookEdit` aimed at another file in the plan directory onto the assigned plan file. |
| `session-context/no-harness-echo` | Foreign routes. Adds a system note telling the model not to reproduce the session context Claude Code injects (hook output, reminders) in its answer. |
| `observer/divergence` | Foreign routes, off until `hooks.observer.enabled`: `claudish hooks list` shows the severity it would act with (`fix`) and marks it `inactive` while that setting is off. Asks a small local model whether a watched tool call breaks one of claudish's conformance rules, and logs the verdict to `~/.claudish/behavior-divergences.jsonl`. Advisory only. |

Turn any of them down with a `severity` key, for example `{ "plan-mode/*": "warn" }`.

---

## The journal

Every decision is written to `~/.claudish/behavior-journal.jsonl`: one JSON line with the event, the
effective hook id, the action, the decision (`matched`, `warned`, `repaired`, `superseded`,
`invalid`, `timeout`, `error`, `disabled`, `dropped`, `queued`, `delivered`, `raw`, `skipped`, …) and
the model. `skipped` means the event's budget was used up before your hook's turn; a `timeout` with
detail `event_budget` means your hook's turn came with less time left than its own timeout, short by
more than that margin; a shorter cut is journaled with the milliseconds. The
journal is local and always on. It never stores argument values.

Behaviour telemetry is a separate opt-in (`hooks.telemetry.enabled`). It uploads one set of counts
per session. Built-in hook ids are uploaded as they are. **Your hook ids are uploaded as `user`**,
and an MCP tool name on one of your hooks' rows is withheld. Raw-tier rows and the new session
decisions stay local. `claudish hooks telemetry` prints what is sent and what never is.

---

## Moving from the `behavior` block

The hook system replaces the earlier `behavior` config block and the `claudish behavior` command.
claudish no longer reads `behavior` at all. If the global config still holds one, claudish prints
what to move, once per process, and otherwise ignores it:

```
[claudish] the "behavior" config block is no longer read. Move it to "hooks":
[claudish]   behavior.rules → hooks.severity
[claudish]   behavior.hooks → hooks.modules (modules must be rewritten to the claudish/hooks contract, apiVersion: 1)
```

It lists only the keys your block has. The full set:

| Old key | Now |
|---|---|
| `behavior.rules` | `hooks.severity`, same key syntax |
| `behavior.hooks` | `hooks.modules`. Each module must be rewritten for this contract: `apiVersion: 1` and handlers under `on`. |
| `behavior.observer` | `hooks.observer` |
| `behavior.telemetry` | `hooks.telemetry`. Consent is **not** carried over: set `hooks.telemetry.enabled` yourself. |
| `behavior.preset` | removed |

claudish leaves the old block in the file and does not drop it on save, so you can copy from it. Delete
it once you have moved it. `claudish behavior rules|corpus|telemetry` are now
`claudish hooks list|corpus|telemetry`.
