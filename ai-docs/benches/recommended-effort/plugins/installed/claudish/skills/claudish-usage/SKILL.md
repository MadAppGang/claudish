---
name: claudish-usage
description: Runs models through the claudish MCP tools — team, create_session, run_prompt — and resolves model IDs against the live catalog. Use when the user mentions claudish, OpenRouter, or external AI models.
user-invocable: false
---

# Claudish Usage Skill

**Purpose:** How agents run models — external and native — through the claudish MCP tools
**Status:** Production Ready

## Everything runs through the MCP tools

There is no CLI tier and no "direct usage" tier. **Every model run goes through a claudish
MCP tool** — one model or a panel, external or native, inside `/team` and `/delegate` or
anywhere else. `Bash("claudish ...")` is not a fallback, not a shortcut for a small task,
and not acceptable "just this once".

| You need | Tool |
|---|---|
| A panel of models on one prompt, in parallel | `team` |
| One model, long task, its own tools and working directory | `create_session` |
| One model, one completion, no tools and no session | `run_prompt` |
| What models exist right now | `list_models`, `search_models` |
| Debugging claudish: the same prompt through several models' APIs | `compare_models` (debug tool) |
| Report a failure to claudish's developers | `report_error` |

Inside a session that claudish started, `team`, `create_session`, the session tools and
`report_error` are absent. See "Inside a claudish session (child mode)" below.

Two properties are why: MCP sessions run in their own process, so a model's transcript
never enters your context window; and every tool returns a **structured per-slot result**
with status and errors, so a failure is data you can act on rather than text you have to
parse. Both are lost the moment you shell out.

The only CLI that survives is a set of three read-only diagnostics — see
"Diagnostics: the only CLI left". They investigate the runtime. They never run a task.

## Inside a claudish session (child mode)

**How to tell.** Run exactly `echo "CLAUDISH_PANE_CHILD=${CLAUDISH_PANE_CHILD:-unset}"`,
with nothing appended. If it prints `CLAUDISH_PANE_CHILD=1`, claudish started this session,
and its MCP server runs in nested mode. `CLAUDISH_PANE_CHILD=unset` means it did not. That
variable is the deciding signal. Never read an exit status as its value: `printenv` exits 1
when the variable is unset, which once read as "child mode" and skipped a whole panel.

A missing tool is not enough on its own. Claude Code can defer MCP tools behind tool
search, so a parent session can list `create_session` only as a deferred name, and a
session without claudish has no claudish tools at all. Neither one is child mode. The tool
shape that does match child mode is `list_models` present while `create_session` and `team`
are absent, with deferred names counted as present. If claudish has no tools at all, claudish
is unreachable: follow the workflow's own path for that case, not this section.

**What it means.** You are the delegate. claudish allows one level of nesting, so no
session tier exists below you. The session that started you is waiting for your result.

**What to do.** Do the task yourself, with your own tools and subagents. If a workflow step
says to delegate to an external model, `create_session` or `team`, you already satisfy that
step by running it. Where the workflow names an internal path, take it (for example the
internal writer in `/dev:qa`), and say in your report that you took it because the session
is nested.

**What you still have.** `run_prompt` gives a one-shot second opinion from another model.
`list_models` and `search_models` still resolve IDs. `compare_models` is also there, but
it is a debug tool for claudish's developers, not a second opinion.

**Why the internal path is the right one.** Another agent CLI started from a shell or a
terminal pane (`codex exec`, `claude -p`, `claudish -p`) rebuilds the nesting that the limit
exists to prevent. It also hides the work from the session that asked for it: that session
sees neither the transcript nor a structured result. Your own tools keep the work visible
and the result in one place.

## Quick Start

### Step 1: Install the runtime (once)

```bash
npm install -g claudish     # or: bun add -g claudish
```

This installs the **runtime**, not a way to run tasks. The plugin's `.mcp.json` starts the
MCP server by launching this binary with `--mcp`, so it must be on `PATH` or the tools
below do not exist at all. Restart the session after installing so the server registers.

### Step 2: Find out what models exist right now

```
list_models()                      → current recommended set, pricing, capabilities, access lines
search_models({ query: "kimi" })   → every live variant in one family
```

Never skip this. Model IDs from memory are dead IDs — see "Model Alias Resolution".

### Step 3: Run something

```
// One completion, no tools, no session lifecycle
run_prompt(model="grok", prompt="Review this diff for security issues")

// A real Claude Code session with tools, in a working directory
create_session(model="grok", prompt=TASK_PROMPT, timeout_seconds=300,
  agent="dev:developer", work_dir=WORK_DIR)
→ the bounded wait fires ("Waiting for a run to end") → get_output(ID)

// A whole panel. `run` STARTS it and returns immediately — it does not wait.
team(mode="run", path=SESSION_DIR, models=["internal", "grok", "gemini"],
  input_file=SESSION_DIR + "/input.md", require_pattern="```vote", agent="dev:researcher")
→ wait until settled ("Waiting for a run to end") → team(mode="status") → read response-NN.md
```

## Model Alias Resolution

All commands that use external models (/team, /delegate, /dev:fix, etc.) MUST resolve model names through this three-step chain before calling claudish.

**The catalog is live, never committed.** Model IDs come from the `list_models` /
`search_models` MCP tools, which claudish serves from its own Firebase-backed
catalog with a 24-hour cache. There is no model-aliases file in this repo, and
you must not resolve model IDs from memory — training data carries dead IDs.

### Three-Step Resolution Chain

```
Step 1: INTERPRET (Claude Code LLM)
  User says anything → Claude infers what family/capability they mean
  "use Elon's model"     → xAI family
  "the Google one"       → Google family
  "kimi3"                → Moonshot family, major version 3
  "latest gpt"           → OpenAI family, newest version

Step 2: RESOLVE (live catalog lookup — list_models / search_models)
  Family/intent → an ID that EXISTS in the live catalog right now
  xAI family             → whatever grok-* the catalog currently lists
  "kimi3"                → kimi-k3   (matched in the catalog, not guessed)
  "latest gpt"           → highest gpt-* version the catalog lists

Step 3: ROUTE (Claudish)
  Live model ID → correct provider API endpoint
```

### Resolving a model name

1. Call `list_models` first — it is cheap, cached, and returns the current
   recommended set with pricing, capabilities and access prefixes.
2. If the user's request isn't covered there, call `search_models` with the
   family name (e.g. `search_models("kimi")`) to see every live variant.
3. Check `.claude/multimodel-team.json` → `customAliases` for a user-defined
   shorthand. A custom alias always wins on key conflict — but if it maps to an
   ID the catalog no longer lists, say so instead of using it silently.
4. `"internal"` and `"default"` select the host Claude tier, and `"opus"`/`"sonnet"`/
   `"haiku"` a specific one. They ARE sent to claudish and run through its native
   passthrough on the user's own subscription — no API key, no provider prefix, no
   translation. They are not catalog IDs, so `list_models` will not list them and a
   catalog check must not reject them. Requires `claudish >= 8.0.0` — native names have
   been runnable since 7.65.0, but the `team` contract in this skill needs 8.0.0.

### Use the resolver — do not do this by hand

`resolve-models.ts` performs the whole check and prints the disclosure. It ships **in this
plugin**, beside this skill, so `${CLAUDE_PLUGIN_ROOT}` resolves to it on every channel
claudish publishes to. Call `list_models` first, then hand it the IDs:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-models.ts" \
  --catalog "<comma-separated ids from list_models>" [--context review] [--json]
```

It verifies every model-bearing field, drops dead IDs individually, computes
provenance, and emits a receipt — **print that receipt verbatim.** Exit `3` means
nothing survived; `0` means proceed with what it selected.

Doing this in your head is what the rest of this section explains. That is the fallback for
paths the resolver does not cover, and for consumers that depend on claudish without
`multimodel` installed beside it. Measured over 30 benchmark runs, prose alone produced
the disclosure at best 14/15 times; the resolver produces it every time, because it is code.

### Verify every field of the preferences file

**Every field of the preferences file is untrusted.** `customAliases` is not the only place
a dead ID hides, and in practice it is the least likely — a file found in the wild had
`customAliases: {}` and six decommissioned IDs sitting in `defaultModels`. **Verify every
ID you take from this file against the live catalog, whichever field it came from:**

| Field | Verify? |
|---|---|
| `defaultModels` | yes |
| `contextPreferences[*]` | yes |
| `customAliases` values | yes |

No field is exempt. Drop each ID the catalog does not list, name the dropped IDs
in your reply, and **carry on with the survivors.**

**A dead entry invalidates that entry, never the request.** Resolving is the next
step, not a fallback:

- A stale `customAliases` mapping means *the alias* is wrong. If the user named a
  version, resolve that intent against the catalog and use what you find —
  `kimi3` with a dead `kimi3 → kimi-k2.5` alias still resolves to `kimi-k3` when
  the catalog lists it.
- Dead entries in `defaultModels` or `contextPreferences[*]` mean *those entries*
  are wrong. Run with whatever survives.

Returning "no models" is correct only when the catalog genuinely offers nothing
that satisfies the request. Refusing a run while a live model sits in the catalog
is the same failure as using a dead one — it just fails in the other direction.

### Report what the check found, not what the file claims

When you report your model choice, **state the result of the catalog check**:

> `3 of 7 saved model IDs are no longer in the catalog: <id-a>, <id-b>, <id-c>`

Report it every run, including when nothing was dropped — `all 5 saved IDs are
still live` is the same disclosure with a different value.

That count is derived from the comparison you just performed, so it **cannot be
silently wrong**. It is the disclosure that matters: the user's question is "are
my models alive and what did you actually use", not "what date is in my file".

### File age is secondary, and `lastUpdated` cannot carry it

If you state an age, take it from the **file's modification time** and say so:
`preferences file modified 12 days ago (filesystem mtime)`.

- **Never present `lastUpdated` as the file's age.** It is declared metadata and
  is not maintained by every write path — a file has been seen reporting March
  while its own `history[0].date` said July. Quoting it as an age is false
  precision.
- If `lastUpdated` and the newest `history[].date` disagree, report
  `freshness metadata inconsistent` and name both. Do not pick the newer one.
- If no trustworthy source exists, `freshness unknown` is a complete answer.
- `mtime` has its own limits — a checkout or copy resets it — which is exactly
  why the source is always labelled.

**Age never gates.** It never rejects a model (a 157-day-old file whose IDs are
all live is fine — use it) and never approves one (a file written today can be
entirely dead). Catalog membership is what decides; age is context for the human.

### Version intent is a hard constraint, not a hint

When the user names a version — `kimi3`, `gpt-5.6`, `sonnet 5` — that version is
a **requirement**. Resolve it against the catalog and use what you find.

- If the exact version exists → use it.
- If it does not exist → **say so and show the live alternatives.** Ask which
  one they want.
- **NEVER** fall back to a lower version because its name is closer as a string.
  `kimi3` resolving to `kimi-k2.5` is a bug, not a near-miss: string distance
  cannot tell a version bump from a typo, and silently downgrading a model is
  worse than erroring.

### Interpreting User Intent (Step 1)

| User says | Resolve by | Notes |
|---|---|---|
| "grok" | `search_models("grok")` | Take the current flagship, not a remembered ID |
| "Elon's AI" / "xAI model" | `search_models("grok")` | Company association |
| "Google's model" | `search_models("gemini")` | Company association |
| "the cheap one" | `list_models` → Quick picks → Budget | Cost intent |
| "something fast for coding" | `list_models` → Fast variants | Capability intent |
| "biggest context" | `list_models` → Quick picks → Large context | Capability intent |
| "kimi3" | `search_models("kimi")`, require major v3 | Version is a constraint |
| "LATEST_MINIMAX_MODEL" | Verify it's in the catalog, then pass through | Already a full ID |

When uncertain, show the live candidates and ask the user to pick. Listing real
options is always better than guessing one.

### Identity vs routing address

Every catalog record carries the model's **identity** and several **addresses** for
reaching it. Only the identity is the model. Addresses live in sibling fields, so it is
easy to copy the wrong one out of the same record:

| In the record | Example | What it is |
|---|---|---|
| `id` | `kimi-k3` | **the identity — this is the model** |
| `openrouterId` | `moonshotai/kimi-k3` | an address: route via OpenRouter |
| Access line | `kimi@kimi-k3` · `kc@kimi-k3` | addresses: same model, different accounts |

**Bare means no `@` AND no `/`.** `moonshotai/kimi-k3` is not a bare ID — the vendor
slug is a route, not part of the name. Both prefix forms pin the request to one
provider and bypass the subscription-aware backend selection and fallback that passing
`id` gives you. `z-ai/glm-5.2` is as wrong as `gc@glm-5.2`, for the same reason.

- If the user names an address (`cx@LATEST_GPT_MODEL`), pass it through **verbatim**.
- Otherwise pass `id`, and let claudish pick the backend.
- Never assemble an address yourself, and never substitute one field for another —
  "the catalog reports it" is not a licence to send it, because the catalog reports
  every address too.

### Responsibility Boundaries

| Responsibility | Owner |
|---|---|
| Understanding user intent → family/capability | **Claude Code** (LLM heuristic) |
| Which model IDs exist right now | **Claudish** (live catalog, 24h cache) |
| User custom aliases | **Magus** (`.claude/multimodel-team.json` `customAliases`) |
| Model ID → API endpoint | **Claudish** (provider routing) |
| API keys, backend fallbacks | **Claudish** |

### Rules

- ALWAYS resolve against the live catalog; NEVER from memory or a committed file
- NEVER invent a model ID — if nothing matches, show live options and ask
- NEVER silently downgrade to an older version than the user asked for
- ALWAYS send the catalog's `id`. NEVER send an address (`vendor/model`,
  `provider@model`) where a model belongs — not even one the catalog reports, since it
  reports `openrouterId` and every Access route alongside `id`. An address goes through
  only when the user named it themselves
- User `customAliases` override, but flag any that the catalog no longer lists

## MCP Tool Reference

Parameter names below are verified against claudish 8.0.0. Use them exactly.

### `team` — a panel of models, started in one call

**`run` starts the panel and returns immediately. It does not wait for the models, and
their answers are not in its response.** You start the run, poll `status` until it settles,
then read each slot's answer off disk. Requires **claudish >= 8.0.0**.

```
team(mode, path, models, judges, input, input_file,
     require_pattern, min_output_bytes, agent, claude_flags, slot)
```

| Parameter | What it does |
|---|---|
| `mode` | `"run"` · `"status"` · `"cancel"` · `"judge"` · `"run-and-judge"` |
| `path` | Session directory. **Must be within the current working directory.** |
| `models` | The panel. Native names are **ordinary entries** — see below. |
| `judges` | Models that judge the collected responses (`judge` / `run-and-judge`) |
| `input` | The prompt every slot receives, inline |
| `input_file` | The same prompt, read from a file. **Prefer this.** Passing both is a hard error. |
| `require_pattern` | Regex the response MUST match, or the slot is reported FAILED |
| `min_output_bytes` | Floor below which a response counts as empty |
| `agent` | Subagent every child runs as. Applies to EVERY child — there is no per-model form. |
| `claude_flags` | Any other Claude Code flags, space-separated. An `--agent` here loses to `agent`. |
| `slot` | `cancel` only — cancel one slot instead of the whole run |

**There is no `timeout` any more, and passing one is silently ignored.** The schema does
not set `additionalProperties: false`, so a leftover `timeout=180` raises no error — it
just does nothing, while the call still reads as though it set a deadline. Nothing
terminates a slot on a timer; see "Deciding whether a quiet slot is stuck" below.

**Prefer `input_file` over `input`.** A panel prompt is routinely 100+ lines, and an inline
`input` echoes the whole thing verbatim in the user's terminal, burying every other
argument in the call. Write the prompt to `<path>/input.md` first, then name that file. The
path must be inside the working directory.

**Native names are ordinary slots.** `internal` / `default` select the host Claude tier;
`opus` / `sonnet` / `haiku` / `claude-*` select a specific one. They go in the same `models`
array as Grok and Gemini and run on the user's Claude subscription through the native
passthrough — no API key, no translation. Because they go through the tool, they are
covered by `require_pattern` like every other slot.

**`require_pattern` is the success oracle, not the exit code.** A slot that exits 0 having
never produced the shape the prompt demanded is reported FAILED (state EMPTY, reason
`shape_mismatch`). Set it whenever the prompt mandates an output shape. Omitting it is how
a vote-less response gets counted as a vote.

**An `agent` with its own report format can override the shape your prompt asks for.** The
agent's definition is the child's system prompt, so its format wins over a format stated in
`input.md`. Measured: a `dev:reviewer` child answered in its reviewer format
(`**Verdict**: PASS`) and failed `require_pattern="VERDICT:"`, so a full review was reported
`shape_mismatch` (EMPTY), while two other slots happened to comply. Before you pair an `agent`
with `require_pattern`, read the agent's output section and make the pattern match a line
that format writes. If the two cannot agree, keep the pattern and run that panel without
`agent`. `shape_mismatch` therefore means "wrong format", not "no answer": the answer is
still in `response-<slot>.md`.

#### The three-step lifecycle

**Every caller of `mode="run"` follows these three steps.** There is no shortcut that skips
step 2 — a workflow that reads results straight out of the `run` response reads nothing.

**Step 1 — start the run.**

```
team(mode="run", path=SESSION_DIR,
  models=[...resolved models, native names included...],
  input_file=`${SESSION_DIR}/input.md`,
  require_pattern=<regex for the shape the prompt mandates>,
  agent=RESOLVED_AGENT)
```

It returns a slot map, not results:

```json
{
  "started": true,
  "team_session_id": "team-20260827-0015",
  "session_path": "/abs/path/to/SESSION_DIR",
  "monitor_record": "team-5e6f7a8b",
  "slots": { "<model-a>": "01", "<model-b>": "02", "internal": "03" },
  "next": { "status": "...", "cancel": "...", "judge": "..." }
}
```

`monitor_record` names the run's end record, the file step 2 waits on. It is not
`team_session_id`, though both start with `team-`. A claudish older than 10.4.0 returns no
`monitor_record`, and step 2 then waits on `<session_path>/status.json`. `slots` maps each
display model name to its anonymised slot id. Keep it — that id addresses everything else
on disk for that model:

| Path | Contents |
|---|---|
| `<session_path>/response-<slot>.md` | the model's answer — parse it from here |
| `<session_path>/stats/<slot>.json` | tokens, cost, tool counts |
| `<session_path>/errors/<slot>.log` | stderr and diagnostics, on failure |
| `<session_path>/errors/<slot>-upstream.jsonl` | raw provider error bodies, when any |

**Step 2 — wait until the run settles, then read `status`.** The wait is the record wait in
**Waiting for a run to end**, or its `status.json` wait when the result has no
`monitor_record`; then make one call:

```
team(mode="status", path=SESSION_PATH)
```

```json
{
  "startedAt": "...",
  "models": {
    "01": { "state": "COMPLETED", "exitCode": 0, "outputSize": 10988 },
    "02": { "state": "RUNNING",   "exitCode": null }
  },
  "idle_seconds_by_slot": { "02": 94 },
  "activity_by_slot":     { "02": "tool_executing" },
  "summary": "<rendered result card — present ONLY once the run has settled>"
}
```

**Settled means the run's end record exists** — the wait's line says so. With no `monitor_record` it means no slot in `status.json` is `PENDING` or
`RUNNING`. A slot going quiet is not the run settling.

`summary` is the rendered result card the old blocking `run` used to return — `N/M
succeeded`, `reason=shape_mismatch`, and the rest. A workflow that matched on that text
keeps working; it just reads it from a settled `status` instead.

**Bound the wait and fail loudly.** There is no server-side deadline any more, so an
unbounded wait is unbounded. Pick a wall-clock ceiling that suits the work, and on hitting it
report what is still running rather than waiting on. Wait with the bounded background wait in
**Waiting for a run to end**, never a foreground `sleep`.

**Step 3 — read the answers off disk.** For each entry in the `slots` map from step 1, read
`<session_path>/response-<slot>.md`. Slot ids are shuffled, so responses can be read blind
before the mapping is consulted. **Never write an example naming a file like
`grok-result.md`** — the tool does not produce those, and a workflow that expects one reads
nothing.

A slot whose `models[<slot>].state` is `FAILED` or `EMPTY` produced no usable answer;
`error.reason` says why.

#### Deciding whether a quiet slot is stuck

Nothing cancels on your behalf. `status` gives you two fields for this, and they are only
meaningful **read together**:

- `idle_seconds_by_slot` — seconds since that slot's child last wrote anything.
- `activity_by_slot` — `starting`, `running`, `tool_executing`, `finishing`, or a terminal
  state. `starting`: the child is still starting up. `finishing`: the slot's
  answer is complete and its child is exiting; nothing to do.

Ninety seconds of silence in `tool_executing` is a build or a test suite, and is completely
normal. The same ninety seconds in `running` is a model that stopped mid-answer. The reaper
this replaced had no activity signal at all, which is exactly why it killed slots that were
working: in one real session it killed three of five actively-working slots, because its
only progress signal was token flow — and token flow stops during a local tool call. A
model running `go test ./...` looked identical to a hung one.

To cancel, do it deliberately:

```
team(mode="cancel", path=SESSION_PATH, slot="02")   # one slot
team(mode="cancel", path=SESSION_PATH)              # the whole run
```

A cancelled slot records `error.reason === "cancelled"`, which is distinct from
`nonzero_exit`. Report it as a decision, not a crash.

**Default: do not cancel automatically.** Report the slot as still running and let the user
decide. Losing a vote to an impatient auto-cancel is the same failure the old deadline
caused.

#### `run-and-judge` — the blocking alternative

`mode="run-and-judge"` still blocks and still returns the verdict, so a panel that would
rather not poll can use it as a drop-in. The trade is that it holds the MCP tool call open
for the whole run, which is the shape that hit the client's 1800s idle abort. It also only
fits work that wants a judging stage — **a plain generation call has no blocking
equivalent and must poll.**

### `create_session` — one model, full session

```
create_session(model, prompt, timeout_seconds, agent, claude_flags, work_dir)
  → session_id
```

The child runs a full Claude Code session — plugins, skills, tools, its own working
directory — in its own process. Its transcript never reaches your context window. This is
the tool that replaces every hand-rolled instruction-file-plus-result-file pattern.

#### Waiting for a run to end

`cancel_session(ID)` stops a session; `list_sessions(include_completed=true)` lists them
all. `run_prompt` writes no session record, so there is nothing to wait on.

1. Before ending a turn with a run in flight, start a **bounded** wait on the run's end
   record: the `meta.json` claudish writes once, when the run ends, in its sessions directory.
   Use the `Monitor` tool (`timeout_ms`, at most 1800000), or for a ceiling under ten minutes
   `Bash` with `run_in_background` (`timeout`, at most 600000). Run:

   ```bash
   # a session: SESSION_ID is create_session's session_id
   f="${CLAUDISH_SESSIONS_DIR:-$HOME/.claudish/sessions}/SESSION_ID/meta.json"
   until grep -Eqs '"status": *"(completed|failed|timeout|cancelled)"' "$f"; do sleep 10; done; echo "claudish session SESSION_ID ended"
   # a team run: MONITOR_RECORD is the `monitor_record` field of the `run` result
   f="${CLAUDISH_SESSIONS_DIR:-$HOME/.claudish/sessions}/MONITOR_RECORD/meta.json"
   until grep -Eqs '"status": *"(completed|failed|cancelled)"' "$f"; do sleep 10; done; echo "claudish team run MONITOR_RECORD ended"
   ```

   The test is the end state, not the file's existence: a file that is missing, half
   written or unreadable fails it and is read again ten seconds later. `MONITOR_RECORD` is
   `monitor_record`, not `team_session_id`: both start with `team-`, and the wrong one names a
   directory that never appears, so the wait runs to its ceiling. So does a
   `CLAUDISH_SESSIONS_DIR` set only in the claudish server's `env` block: the wait expands the
   variable in Claude Code's environment, so it moves where claudish writes and not where the
   wait looks. While the result
   carries `monitor_record`, never wait on the run's `status.json`: it is rewritten in place,
   and a slot can stay `RUNNING` in it after the run has ended.

   **A `run` result with no `monitor_record`** comes from a claudish older than 10.4.0, which
   writes no end record. Do not stop waiting: run the same bounded wait, with the same tools
   and ceiling, on the run's `status.json` instead. It needs `bun` on `PATH`:

   ```bash
   # no monitor_record: SESSION_PATH is the `session_path` field of the `run` result
   f="SESSION_PATH/status.json"
   until F="$f" bun --env-file=/dev/null -e 'try{const m=Object.values(JSON.parse(require("fs").readFileSync(process.env.F,"utf8")).models??{});process.exit(m.length>0&&m.every(s=>!/^(PENDING|RUNNING)$/.test(s?.state))?0:1)}catch{process.exit(1)}'; do sleep 10; done; echo "claudish team run settled"
   ```

   It settles when the file parses and no slot in `models` is `PENDING` or `RUNNING`; a file
   that is missing, half written or unparseable is read again ten seconds later. On this path
   a start that failed or a whole-run cancel can leave a slot `RUNNING`, and the wait then runs
   to its ceiling. Tell the user a claudish of 10.4.0 or later ends the wait exactly, but
   collect the results either way.

   Ceilings: a team run, 30 minutes. A session, its `timeout_seconds` plus two minutes. Above
   30 minutes the wait cannot cover that in one go: when it times out and `get_output` still
   says the session is running, start the same wait again. The session's own timeout ends it.

2. When the wait's line arrives, make the one
   settled call: `get_output` / `get_diagnostics`, or `team(mode="status")`. A wait that
   times out is the ceiling: report what is still running.

Never `sleep` in the foreground between status calls: Claude Code blocks it, and it holds
the turn without waking anything.

claudish pushes nothing into the conversation. A `<channel source="claudish">` block never
arrives, so never wait for one. The one live view is
`list_sessions(include_completed=true)`: each row carries `state`, `activity`, `idle_seconds` and, on a failed or
timed-out row, `reason_detail`. One call every 10 seconds or so is enough.

A live row also carries `recent`: the current turn's last 20 steps, oldest first, each
`{at, kind, tool, summary}`. `kind` is `text`, `thinking`, `tool` or `ask`; `summary` is one
line naming the target (the file, the first line of a Bash command, the pattern or url), at
most 100 characters. It shows what the child did between two polls, which `activity` alone
cannot. It is `null` before the first step and on rows read from disk, which have no live
transcript to follow.

### `run_prompt` — one completion, no session

```
run_prompt(model, prompt, system_prompt)
```

One completion, straight to one model's API. No tools, no working directory, no session,
so it is never subagent work: a task that must read files, run commands or write code goes
through `create_session`, and a panel through `team`. Use `run_prompt` when you want an
opinion, not work. There is no `max_tokens` argument; never pass one.

### Catalog and reporting

```
list_models()                 // current recommended set — call this first, always
search_models(query)          // every live variant in a family
report_error(error_type, model, stderr_snippet, session_path, additional_context)
```

`compare_models` is a **debug** tool for claudish's own developers. It sends one prompt to
several models' APIs side by side. It never stands in for `team`: it runs no tools, keeps
no record and collects no votes.

### Tool groups

`CLAUDISH_MCP_TOOLS` in the server's environment limits which tools it exposes. The plugin
sets none, so every tool is there.

| Value | Tools |
|---|---|
| unset / `all` | all 14 |
| `low-level` | `list_models`, `run_prompt`, `search_models` |
| `agentic` | `preflight`, `report_error`, `team` |
| `session` | `cancel_session`, `capture_session`, `create_session`, `get_diagnostics`, `get_output`, `list_sessions`, `send_input` |
| `debug` | `compare_models` |

`channel` is not a group. A server given it warns once on stderr and exposes all 14 tools.

## Choosing between the tools

```
Does the task need a panel of independent opinions?
    → team(mode="run", ...) with require_pattern
      → poll team(mode="status", ...) until settled → read response-<slot>.md

Does it need one model to DO work — read files, write code, run commands?
    → create_session(...) → get_output(session_id)

Do you just need one model's answer to one question?
    → run_prompt(...)

Do you need to know what models exist?
    → list_models() / search_models(query)
```

Task size is not a factor in that choice, and never was. A "simple" prompt and a
multi-phase workflow both go through the same tools; a long prompt is just a long `prompt`
or `input` argument. There is no size at which shelling out becomes correct.

## 🤖 Agent Selection Guide

### Step 1: Find the Right Agent

**When user requests Claudish task, follow this process:**

1. **Check for existing agents** that suit the task type
2. **If no suitable agent exists:**
   - Suggest creating a new agent for this task type
   - Offer to proceed with the generic `general-purpose` agent if user declines
3. **If user declines agent creation:**
   - Proceed with `general-purpose` and say so

### Step 2: Agent Type Selection Matrix

> **Note:** Every model — native and external — is invoked via claudish MCP tools (`team`,
> `create_session`). The orchestrator resolves the agent and passes it in the tool's `agent`
> parameter, which applies to every child in the run. Task context still travels in the prompt.

| Task Type | Recommended Agent | Alternatives | Notes |
|-----------|----------------------|--------------|-------|
| **Investigation** | `code-search:analyze` | `dev:debugger` | Read-only code tracing; `dev:researcher` is for web research |
| **Code review** | `dev:reviewer` | — | Security, correctness, maintainability passes |
| **Architecture** | `dev:architect` | — | Design and planning tasks |
| **Implementation** | `dev:developer` | — | Building features |
| **Testing** | `dev:qa-engineer` | — | Test strategy and coverage |
| **Debugging** | `dev:debugger` | — | Error analysis and tracing |
| **Documentation** | `dev:docs` | `dev:researcher` | Writing or auditing documentation |
| **UI/Design** | `dev:frontend-developer` | `designer` plugin | Visual and UX tasks |

### Step 3: Agent Creation Offer (When No Agent Exists)

**Template response:**
```
I notice you want to use [Model Name] for [task type].

RECOMMENDATION: Create a specialized [task type] agent.

This would:
✅ Provide better task-specific guidance
✅ Reusable for future [task type] tasks
✅ Optimized prompting for [Model Name]

Options:
1. Create specialized agent (recommended) - takes 2-3 minutes
2. Use generic general-purpose agent - works but less optimized

Which would you prefer?
```

### Step 4: Example Agent Selection

**Example 1: User says "use Grok to implement authentication"**
```
Task: Code implementation (authentication)

Decision:
1. Resolve "grok" via list_models / search_models
2. Pick the agent: implementation → dev:developer
3. create_session(model=<resolved id>, prompt=TASK,
     timeout_seconds=300, agent="dev:developer", work_dir=REPO)
4. On completed → get_output(session_id) → summarise
```

**Example 2: User says "ask GPT to review my API design"**
```
Task: Code review (API design)

Decision:
1. Resolve the GPT family via search_models("gpt") — had the user named a version, it would be a hard constraint
2. Pick the agent: review → dev:reviewer
3. One reviewer → create_session(model=<resolved id>, prompt=REVIEW_PROMPT,
                    agent="dev:reviewer", timeout_seconds=300)
   A panel       → team(mode="run", path=SESSION_DIR, models=[...],
                    input_file=SESSION_DIR + "/input.md", agent="dev:reviewer")
                    → poll status until settled → read response-NN.md
```

**Example 3: User says "use Gemini to refactor this component"**
```
Task: Refactoring (component)

Decision:
1. Resolve "gemini" via search_models("gemini")
2. No specialised refactoring agent exists → offer to create one
3. User declines → agent="dev:frontend-developer", else "general-purpose"
4. create_session(model=<resolved id>, prompt=TASK, agent=<chosen>, work_dir=REPO)
```

## Team Mode Integration

When used with the `/team` command for multi-model blind voting, every model — native and
external — is started through the `team` MCP tool in a single call. Write the vote prompt
to `input.md` first, then:

```
team(mode="run", path=SESSION_DIR, models=["internal", "grok", "gemini"],
  input_file=`${SESSION_DIR}/input.md`, require_pattern="```vote", agent=RESOLVED_AGENT)
```

**That call starts the panel and returns a slot map. It does not return votes.** Poll
`team(mode="status", path=SESSION_DIR)` until no slot is `RUNNING`, then read each vote from
`response-<slot>.md`. The `slots` map in the `run` response gives the model-name-to-slot-id
mapping, so responses can still be read blind. Full procedure: **The three-step lifecycle**
under `team` above.

## Overview

**Claudish** is an external-model runtime: it runs Claude Code against any model a provider
catalog offers (Grok, GPT, MiniMax, Gemini, Kimi, …) by proxying through a local
Anthropic-API-compatible server, and it exposes that capability to Claude Code as an **MCP
server**. Magus talks to the MCP server. It does not talk to the binary.

Claudish:
- ✅ Runs Claude Code with **any catalogued model**, not just Anthropic's
- ✅ Supports **multiple backends** (OpenRouter, Gemini Direct, OpenAI Direct, Ollama, …)
- ✅ Runs native Claude tiers through a passthrough on the user's own subscription
- ✅ Supports 100% of Claude Code features inside a session
- ✅ Tracks cost and returns it in the session record
- ✅ Enables multi-model workflows via `team`

**Use Cases:**
- Run tasks with different models (fast coding, deep reasoning, vision)
- Compare model performance on the same task
- Reduce cost by routing simple tasks to cheaper models
- Reach models with specialised capabilities

## Routing is Claudish's, not ours

**Magus implements no routing.** Not provider prefixes, not fallback chains, not API-key
detection, not pre-flight reachability checks. Send the catalog's `id` (see "Identity vs
routing address" above) and let claudish resolve it. That is the whole contract.

**Never document a provider/prefix/env-var table or a routing troubleshooting guide here**,
for two reasons:

1. **Ownership.** The Responsibility Boundaries table above assigns "Model ID → API
   endpoint" and "API keys, backend fallbacks" to Claudish. A routing guide here
   contradicts that and invites plugin code to compensate for provider behaviour.
2. **Drift.** Routing detail copied into this repo goes stale and starts teaching the wrong
   thing — the backend separator is `@`, and which providers carry which models changes
   most releases.

**A model that will not route is a claudish bug, not a magus workaround.** Do not add
retry, probe, or fallback logic to a command, agent, or skill in this repo to route around
it. Report it instead — `report_error` via the claudish MCP server, which anonymises paths
and keys.

## Requirements

- **Claudish >= 8.0.0 on `PATH`** — `bun add -g claudish` (or `npm install -g claudish`).
  It is the runtime the MCP server runs inside; without it there are no tools.
- **Claude Code** — must be installed.

**8.0.0 is a hard floor for `team`, not a preference.** Below it, `run` blocks instead of
returning a handle and `input_file` does not exist, so a workflow written to this skill
starts a run and reads nothing. Check with `claudish --version`.

**Credentials are Claudish's, and are deliberately not listed here.** There is no single
required key: which providers a model can reach, and which env var each one reads, is
claudish's routing concern and changes most releases. Naming any of them here is how this
skill ends up teaching wrong routing.

The authoritative, always-current list is the ENVIRONMENT VARIABLES section of
`claudish --help` (a diagnostic — see below).

If a model fails for want of a credential, that is a claudish diagnosis. Do not add key
checks or provider detection to this repo.

## Diagnostics: the only CLI left

Exactly three CLI invocations remain permitted, and **only for investigating the runtime.**
They are read-only, they produce no work, and none of them may appear in a workflow that is
trying to accomplish a task:

| Command | Answers |
|---|---|
| `claudish --help` | Flags, and the authoritative ENVIRONMENT VARIABLES list |
| `claudish --version` | Which runtime is installed |
| `claudish --models [query]` | Ad-hoc catalog lookup **while debugging the catalog itself** |

**These are for a human debugging session, not for orchestration.** In particular,
`--models` is NOT how a workflow discovers models — `list_models` and `search_models` are,
because they return structured records the workflow can act on. Reaching for `--models` in
a task is the CLI habit sneaking back in through the one door left open.

Anything not on this list — `--model`, `--stdin`, `--json`, `--agent`, `--port`,
`--interactive`, `--quiet` — has an MCP equivalent above and must be used through it.

Do not encode a diagnostic's output as procedure in this repo. It describes claudish's
behaviour at one moment; restating it here is how the routing table went stale.

## Delegation Patterns

### Pattern 1: One model does a piece of work

```
// Resolve first (list_models / search_models), then:
create_session(model=RESOLVED_ID, prompt=TASK_PROMPT, timeout_seconds=300,
  agent="dev:developer", work_dir=REPO_PATH)
→ session_id : report "Delegating to {MODEL}…"
→ the bounded wait fires → get_output(ID) says completed : get_output(ID, tail_lines=200) → summarise for the user
→ get_output(ID) says `failed` / `timeout` after the wait : get_diagnostics(ID) → report → stop
```

A session started with a `prompt` never waits for input, so this pattern has no
`send_input` step.

The session's own transcript stays out of your context — that is the point, and it is why
no instruction file, no result file and no `/tmp` scratch is involved. Do not add any.

### Pattern 2: A long or structured prompt

Put it in the `prompt` (or `input`) argument. There is no command-line length limit to work
around, because there is no command line.

```
PROMPT = "# Code Review Task\n"
       + "\n## Files\n"      + files.map(f => "- " + f).join("\n")
       + "\n\n## Criteria\nCorrectness, maintainability, performance, security"
       + "\n\n## Required output shape\nEnd with a fenced `review` block containing "
       + "VERDICT and ISSUES."

create_session(model=RESOLVED_ID, prompt=PROMPT, timeout_seconds=300,
  agent="dev:reviewer", work_dir=REPO_PATH)
```

If the prompt mandates a shape, run it through `team` instead with
`require_pattern="```review"` so a shapeless response is reported FAILED rather than
accepted.

### Pattern 3: Several models on the same prompt

One `team` call starts them all. Not a loop, not one session per model — the tool
parallelises internally. The call returns a slot map immediately; you poll, then read.

```
team(mode="run", path=SESSION_DIR, models=["internal", "grok", "gemini"],
  input_file=`${SESSION_DIR}/input.md`, require_pattern="```review", agent="dev:reviewer")
```

Then poll `team(mode="status", path=SESSION_DIR)` until no slot is `RUNNING`, and read
`response-<slot>.md` for each slot in the `run` response's `slots` map. Per-slot status
comes back in `status.models`: check every one. See **The three-step lifecycle** above.

## Failure Handling

Failures arrive as **structured data**, not as text on stderr. There are exactly two shapes.

### From `team`: the per-model result object

Each slot reports its own status. Read every one — a run where three of five slots came
back is a partial success you must disclose, not a success.

Read them from `status.models[<slot>]` once the run has settled — not from the `run`
response, which returns before any slot has finished.

| What you see | What it means |
|---|---|
| state `FAILED` | The slot errored. `error.reason` carries the cause. |
| state EMPTY, reason `shape_mismatch` | The slot exited 0 but never matched `require_pattern`. Treat as failed. |
| reason `nonzero_exit` | The child process died. Check `errors/<slot>.log`. |
| reason `cancelled` | **You** cancelled it. Report it as a decision, not a crash. |
| below `min_output_bytes` | Effectively empty. Treat as failed. |
| state `RUNNING` at your poll ceiling | Not a failure. Report it as still running and let the user decide. |

Show failed slots as FAILED in your results table, proceed with the survivors, and name
what failed. No retry, no substitution.

### From `create_session`: the end state

The row's `state` in `list_sessions`, or `get_output`'s `status` after the wait, names the end
state. A failed or timed-out row also carries `reason_detail`: the provider's error message, or
the first line of the kept detail, at most 160 characters. Quote it in your report; it is `null`
when nothing readable was kept.

| End state | Meaning | Next call |
|---|---|---|
| `failed` | The child exited with an error, or claudish died before recording an end | `get_diagnostics(session_id)` |
| `timeout` | It hit `timeout_seconds` and was killed | `get_diagnostics(session_id)` |
| `completed` with empty or surprising output | Suspect a silent failure | `get_diagnostics(session_id)` |

`get_diagnostics` returns the child's stderr, upstream error bodies, recent event frames,
the resolved model chain, and paths to the full records — with no re-run and no debug flag.

### The escalation rule: STOP and REPORT

Never silently substitute. If the user asked for Gemini and Gemini failed, do not quietly
run GPT, and do not quietly fall back to the embedded Claude.

```
"{Model} failed.

What happened:
1. Tool: {team | create_session}
   Error: {error from the result object or from get_diagnostics after the failed line}

Options:
(1) Retry the same model
(2) Use a different model
(3) Skip this model, continue with the others
(4) Cancel
(5) Report this error to claudish developers

Which do you prefer?"
```

On (5), call `report_error(error_type, model, stderr_snippet, session_path,
additional_context)`. `error_type` is one of `provider_failure`, `adapter_error`,
`stream_error`, `team_failure`. **Consent is required** — always ask first. Data is
sanitised (keys, paths, emails stripped) before sending.

## Best Practices

### 1. ✅ Resolve models live, every run

Call `list_models` before you name a model, and `search_models` for a specific family.
Never a remembered ID, never a committed list.

### 2. ✅ Choose the tool by task shape, not task size

Panel → `team`. Work → `create_session`. An answer → `run_prompt`. Size never makes
shelling out correct.

### 3. ✅ Set `require_pattern` whenever the prompt demands a shape

It is the only thing standing between "exited 0" and "actually produced a vote".

### 4. ✅ Pass the agent in the `agent` parameter

Not in the prompt, and not via `claude_flags` — an `--agent` in `claude_flags` loses to
`agent`. It applies to every child in the run; there is no per-model form.

### 5. ✅ Let sessions carry the context

A `create_session` child runs in its own process, so its transcript costs you nothing.
Summarise its `get_output` for the user rather than pasting it.

### 6. ✅ Check every slot's status before you believe a result

Structured per-slot status is the reason to use these tools. Ignoring it throws away the
advantage. For `team` that status lives in a **settled** `status` response, never in the
`run` response.

### 7. ✅ Poll `team` to completion; never read results from the `run` response

`run` returns before any model has answered. A workflow that parses its response finds no
results and reports whatever its empty-case is — for a vote panel, INCONCLUSIVE on every
run. Poll `status` until no slot is `RUNNING`, bound the loop, then read off disk.

### 8. ✅ Write long prompts to `input.md` and pass `input_file`

An inline `input` echoes the entire prompt verbatim in the user's terminal, burying the
model list, the agent and the shape check inside a wall of text.

## Anti-Patterns (Avoid These)

### ❌ Don't Ignore Model Selection

**Wrong:** taking whatever the default is for every task.

**Right:** pick for the task — fast variants for iteration, reasoning models for analysis,
large-context models for whole-repo work — and resolve the choice against `list_models`.

### ❌ Don't Hardcode Model Lists

**Wrong:**
```typescript
const MODELS = ["grok", "gpt"];
```

**Right:** resolve from the live catalog at call time.

```
list_models()                    → current recommended set
search_models({ query: "kimi" }) → every live variant in a family
```

### ✅ Do Accept Custom Models From Users

**Problem:** the user provides a model ID that `list_models` does not return.

**Wrong (rejecting it):**
```typescript
const shortlist = ["grok", "gpt"];
if (!shortlist.includes(userModel)) {
  throw new Error("Model not in my shortlist"); // ❌ DON'T DO THIS
}
```

**Right:** pass it to the tool and let claudish validate it.

```
create_session(model=userModel, prompt=TASK, timeout_seconds=300)
```

Users legitimately have access to beta models, private fine-tunes, newly released models
not yet in the recommended set, and regional or enterprise endpoints. Say that the ID is
not in the recommended set if it is not, then run it anyway — claudish decides whether it
resolves.

### ❌ Don't Skip Error Handling

```
// On get_output reporting `failed` after the wait → get_diagnostics(ID), then STOP and REPORT
// "Grok failed: {error content}. Options: (1) Retry, (2) Different model, (3) Skip, (4) Cancel"
// On `completed` → get_output(ID)
```

**❌ NEVER do silent fallback.** If `create_session` fails for Gemini, do not silently run
with the embedded Claude instead. Report the failure and let the user decide.

## Troubleshooting

### The claudish MCP tools are not available

The plugin's `.mcp.json` starts the server by launching the claudish binary, so the binary
must be installed (`npm install -g claudish`) and on `PATH`. Restart the session so the MCP
server registers. Confirm with `claudish --version`.

### A slot reported FAILED, or came back empty

Read the error from the per-model result (`team`) or call `get_diagnostics` (`create_session`).
Common causes: rate limits, an ID the catalog no longer lists, a missing credential for that
provider. An empty response that exited 0 usually means `require_pattern` did its job.

### Every slot failed with `prompt_not_accepted`

`prompt_not_accepted` means the child's Claude Code never took its launch prompt: the prompt
sits typed in the input box and no transcript starts. In one slot it is a one-off. In every
slot it is the child's input mode, not the models, and a retry fails the same way.

The known cause is `"editorMode": "vim"` in the user's Claude Code settings. claudish 10.7.0
fixes it by starting every child in normal mode. Check with `claudish --version`. On an older
claudish, upgrade it, or pass `claude_flags='--settings {"editorMode":"normal"}'` to the
`team` or `create_session` call. The value holds no space, so the whitespace split of
`claude_flags` leaves it intact.

On claudish 10.7.0 or later, every slot failing this way is a claudish bug: report it with
`report_error` and stop.

### A model will not route

Report it with `report_error` and pick a different model from `list_models`. Do not
investigate the routing chain — routing is claudish's, and a caller that hands it a bare
name has no business knowing which provider was tried.

Note for the report, not for you to act on: a 401 from a provider often means "this
provider does not carry this model" rather than "your key is wrong". Either way the fix
belongs in claudish, never in a workaround here.

### The response is slow, or costs more than expected

Pick a different model — resolve alternatives with `list_models`, which carries pricing and
capability data, and check context sizes there rather than assuming. Cost per session comes
back in the session record; you do not need to parse anything to get it.

### Context window exceeded inside a session

Use a larger-context model from `list_models`, or split the task into several
`create_session` calls. Do not try to trim by moving work into files — the session already
keeps its own transcript out of your context.

## Additional Resources

- Claudish GitHub: https://github.com/MadAppGang/claudish
- Install the runtime: `npm install -g claudish`
- OpenRouter: https://openrouter.ai · Models: https://openrouter.ai/models

---

**Maintained by:** MadAppGang
**Last Updated:** August 22, 2026
