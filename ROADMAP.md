# Roadmap

Planned-but-unimplemented work for Claudish. Items here are deliberately scoped, with explicit **trigger conditions** — what needs to be true upstream or in our codebase before each item moves to active development. If a trigger condition isn't met, leave the item parked.

For shipped features see `CLAUDE.md`; for the engineering rationale behind them see `ai-docs/architecture/`. For ad-hoc research and validation sessions, see `ai-docs/sessions/`.

---

## Channel notifications

### Phase 1 — SEP-1686 forward-compat fields ✅ Shipped

Status: complete (this branch).

The channel bridge now emits `task_id`, `status` (5-value SEP-1686 enum), `created_at`, `last_updated_at` alongside our existing fields. Wire format pinned by `channel-wire-format.test.ts` (8 tests, perturbation-verified). No consumer behavior change.

See: `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md`

### Phase 2 — `notifications/tasks/status` behind a flag

Status: blocked on upstream. Not started.

When ready, we add a `CLAUDISH_NOTIFY_VIA_TASKS=1` env var. When set, the bridge emits `notifications/tasks/status` with a restructured payload (flatten `meta.task_id → params.taskId`, etc.) alongside the existing `notifications/claude/channel`. Add a parallel test fixture pinning the new wire format.

**Trigger conditions** (all must hold):
- Claude Code ships a release whose CHANGELOG mentions SEP-1686 / `notifications/tasks/status` receiver support, AND the new method surfaces task notifications into the **agent's context** (not just CLI UI).
- The TypeScript MCP SDK ships a server-side helper for emitting `notifications/tasks/status`. Reference impl is `modelcontextprotocol/typescript-sdk#1041` (currently OPEN as of 2026-05).
- We've manually verified per-child completion notifications surface in the orchestrator agent's context during a `team` run.

**Effort**: small. Most work is already done in Phase 1 (the data is in `meta`); Phase 2 is mainly a payload-reshape function + new test fixture + env-var gate.

Reference: same migration schema doc as Phase 1.

### Phase 3 — Flip default + drop the legacy method

Status: blocked on Phase 2.

Default to `notifications/tasks/status`. Keep emitting `notifications/claude/channel` for one major version as a fallback for users still on older Claude Code versions. Then remove.

**Trigger condition**: 6+ months after Phase 2 ships AND > ~80% of Claudish users are on Claude Code versions with Tasks receiver support (heuristic — measure via `--probe` telemetry if we ever add it, otherwise judgment call).

---

## `notifications/progress` — shipped as a KEEPALIVE; the CLI-UI use case is still parked

Status: **shipped 2026-08-14, on grounds the original parking decision never weighed.** This item used to read *"Optional: `notifications/progress` as a secondary CLI-UI signal — Parked"*. That feature is still not viable. What shipped is a different feature wearing the same notification.

The parking decision was **right about rendering and wrong about relevance**. Progress notifications render nowhere — that finding stands, re-confirmed on 2.1.231 — but they also reset the client's MCP idle timer, and nothing else claudish emits does. The old note's own footnote, *"not entirely inert — it still resets the client's request timeout"*, turned out to be the whole reason to build it.

### What re-opened it: measured 2026-08-14 against Claude Code **2.1.231**

A real `team` call died with `MCP server "plugin:claudish:claudish" tool "team" sent no response or progress for 1800s; aborting`. Probe: three tools, identical 90s duration, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=30000` throughout, differing only in what they put on the transport while working.

| Tool emits during the 90s | Outcome |
|---|---|
| nothing | **aborted at 30s** |
| `notifications/progress` every 10s | **survived 90s** → returned normally |
| `notifications/claude/channel` every 10s | **aborted at 30s** |

The silent/progress pair is the decisive comparison: same duration, same window, same server, same transport, one variable. The channel arm emitted 3 frames with no emit errors before being killed, so its abort is not an emission failure.

Channel and progress are therefore **complementary, not alternatives** — channel is the visible surface with no keepalive, progress is the invisible keepalive:

| | visible to agent/human | resets idle timer |
|---|---|---|
| `notifications/claude/channel` | ✓ | ✗ |
| `notifications/progress` | ✗ | ✓ |

**Shipped**: `packages/cli/src/mcp/progress-heartbeat.ts` — a time-driven 10s heartbeat, armed by the CallTool dispatch on `team`, `run_prompt`, and `compare_models`. Time-driven and not event-driven because `team` already emitted a channel frame on every state change and still died at exactly 1800s: a model that thinks for 30 minutes produces no state changes. Knobs, degradation rules, and the idle-window defaults are in CLAUDE.md ("The `notifications/progress` keepalive").

**`anthropics/claude-code#58687` is STALE.** It reports that the client sends no `_meta.progressToken`, and was closed as not planned. On 2.1.231 the token **is** sent — observed value `2`, in every probe arm, including runs against the older `progress-regression-mock.ts`.

### Still open: rendering — original trigger condition #2 remains UNMET

1. ~~Claude Code's MCP SDK fixes the strict-token-validation bug~~ — **met 2026-07-29** (verified on 2.1.220).
2. **Claude Code ships UI/agent rendering for progress notifications from custom MCP servers** (`anthropics/claude-code#4157`, `#51713`) — **still unmet**, and this stays a live watch item. Progress displays nowhere, so the "secondary CLI-UI signal" this item was originally about does not exist yet. Re-run both probes on each client upgrade. If rendering returns, the heartbeat's `message` field becomes user-visible for free, at which point its content rules (structural only — tool name, elapsed seconds, counts; never prompt text or paths) stop being a privacy precaution and start being a UX decision.

### Measurement trail — how the conclusion was reached

Kept in full: the 2026-08-14 finding only overturns the *relevance* verdict, not the evidence underneath it.

**2026-05-09, Claude Code 2.1.133 — two blockers, both fatal on the evidence then available:**

- ❌ **Claude Code does not render progress notifications anywhere observable.** Verified 2026-05-09 against Claude Code 2.1.133 with `progress-regression-mock.ts`'s `slow_with_many_progress` tool emitting 5 distinct progress messages over ~10s. Mid-flight pane capture showed no terminal-UI rendering. The agent reported verbatim: *"I did not observe any progress messages during the call... nothing was surfaced to the agent context."* Matches the Anthropic-attributed comment on `anthropics/claude-code#4157`: *"Claude Code doesn't currently have a generic UI for displaying real-time progress from custom MCP servers."*
- ❌ **The transport-kill regression is NOT fixed in 2.1.133 — earlier note that it was, was wrong.** A first test on 2026-05-09 (`progress-regression-mock.ts`'s `slow_ping_with_progress` + `simple_ping`) reported the regression resolved. **That test was insufficient.** It used sequential `await` ordering, putting all progress notifications strictly *before* the tool response, which avoids the race. The actual trigger documented in `GLips/Figma-Context-MCP#362` is **concurrent or quick-succession tool calls** where a progress notification arrives at the client *after* its `progressToken` cleanup has run. The MCP SDK then treats it as a protocol violation (`"Connection error: Received a progress notification for an unknown token"`) and tears down stdio. This bug is documented as still affecting Claude Code 2.1.x in the field. **The `team` use case (N concurrent child sessions, each with its own `progressToken`) is the exact pattern that triggers the bug.**

The conclusion drawn at the time — that this would both fire into a void and destabilize `team` — followed correctly from those two bullets. Both have since moved: the transport kill was fixed (below), and the `team`-concurrency premise was a misreading. `team`'s N children are OS processes spawned by `team-orchestrator.ts`, not MCP requests; they carry no `progressToken` at all, so a `team` call has exactly **one** token and emits at most one frame per interval. The shipped heartbeat additionally keys no state by token, so parallel `tools/call` requests have nothing to collide over.

### Re-measured 2026-07-29 against Claude Code **2.1.220** — one blocker is gone, one is confirmed harder

Probes: `packages/cli/src/channel/test-helpers/capability-probe.ts` (agent context, `-p`) and
`progress-regression-mock.ts` driven through an interactive tmux session (terminal UI).
Full findings: `ai-docs/sessions/dev-arch-20260729-171308-1dad34b5/capability-findings.md`.

- ✅ **Blocker 2 (transport kill) is FIXED.** Emitting 3 progress notifications no longer tears down
  stdio: the immediately-following `probe_ping` call returned `pong`, with no `STDIN_END` and no emit
  errors. The stated reason for parking — that `team`'s concurrent `progressToken`s would destabilize
  the transport — no longer holds. **Caveat:** the probe emitted from ONE tool call; true N-concurrent
  emission across simultaneous children is still unproven.
- ❌ **Blocker 1 (no rendering) CONFIRMED, now on both surfaces.** Previously only agent context was
  tested. Now both:
  - *Agent context* (`-p`): agent answered **NO** to seeing any of `PROBE-STEP-1/2/3` while the server
    log shows all 3 emitted.
  - *Interactive terminal UI*: sampled the screen every 1.2 s for 31 s, spanning the full 7.5 s
    emission window of `slow_with_many_progress`. The tool row rendered as a static
    `⏺ pmock - slow_with_many_progress (MCP)` across 20 consecutive samples. **Not one** of the five
    messages ("scanning files", "parsing AST", "running checks", "aggregating results",
    "writing output") ever appeared.

This matches `anthropics/claude-code#51713` — MCP tool calls are unconditionally collapsed, showing
only the server/tool name with no streaming output. Per that issue, progress DID render up to
**2.1.101** and regressed by **2.1.116**; our original 2.1.133 measurement therefore landed inside the
regression window. **#51713 is closed, but the regression is still live in 2.1.220.**

Note `notifications/progress` is not entirely inert — it still resets the client's request timeout.
It simply has no display.

↑ **That footnote was the whole answer, and it sat here unread for two weeks.** A line written as a
caveat to a rejection was in fact the only reason to build the thing; the 2026-08-14 probe above
exists because a `team` run died at 1800s and sent someone back to re-read it. Worth generalising:
when parking an item, state what the mechanism *does* do, not only what it fails to do — the residual
capability is the part a future failure will need.

**Superseded on the DISPLAY axis by**: `team` reports live per-model stats over
`notifications/claude/channel` (measured working) plus a `status.txt` in the session directory. See
"Live team progress" below. That remains true and unchanged — channel is still the only mechanism
that reaches a reader. It is not, however, a substitute on the *liveness* axis, which is what the
2026-08-14 measurement settled.

**References**:
- Original empirical session: `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/` (lost — session dirs are gitignored and died with their worktree)
- Community-research session that surfaced the corrected understanding: `ai-docs/sessions/dev-research-mcp-progress-community-20260509-213410-c058a909/` (lost — same)
- Re-measurement against 2.1.220: `ai-docs/sessions/dev-arch-20260729-171308-1dad34b5/capability-findings.md` (lost — same)
- Idle-timeout measurement against 2.1.231 (the three-arm probe): `ai-docs/reports/mcp-progress-keepalive/findings.md`
- Keepalive implementation design: `ai-docs/reports/mcp-progress-keepalive/architecture.md`
- Test artifacts: `packages/cli/src/channel/test-helpers/progress-regression-mock.ts`, `capability-probe.ts`, `capability-probe-2.ts`
- Field evidence of the transport-kill bug the latch defends against: <https://github.com/GLips/Figma-Context-MCP/issues/362>
- Stale `progressToken` claim: <https://github.com/anthropics/claude-code/issues/58687>

---

## Live team progress — shipped

`team` runs take minutes and, in `--quiet` print mode, children emit nothing until they finish. There
was previously no signal at all between "started" and "done". Two transports now carry live per-model
stats, chosen because they are the two that actually reach a reader:

| Transport | Reaches | Requires |
|---|---|---|
| `notifications/claude/channel` | the agent's context (renders as a `<channel>` block) | the channel gating in CLAUDE.md — `--channels`, interactive, `.mcp.json` |
| `<session>/status.txt` | a human, via `tail -f` | nothing; works headless and in CI |

`notifications/progress` carries none of this — it renders nowhere (2.1.220, unchanged on 2.1.231).
It now runs alongside as a pure keepalive, on the separate liveness grounds established above.

**How per-model attribution works.** `token-tracker.ts` writes tokens/cost to
`~/.claudish/tokens-<port>.json`, keyed to a port each child picks for itself, so an orchestrator
spawning N children could not tell which file belonged to which model. `CLAUDISH_TOKEN_FILE` now
overrides that path, and `runModels` points each child at `<session>/stats/<id>.json`.

**Format** — plain ASCII, no ANSI (channel frames render escapes literally):

```
team: 2 models, 2 done, 7s, 102.9k tok, $0.104
  01 or@gemini-3.6-fla… done    160B    48.1k/234  $0.049
  02 grok-4.5           done    118B     54.6k/19  $0.055
```

**Knobs**: `onProgress` (callback) and `progressIntervalSeconds` (default 5) on `TeamRunOptions`.

**Implementation**: `packages/cli/src/team-stats.ts`, wired in `team-orchestrator.ts` (ticker +
child env) and `mcp-server.ts` (`ChannelNotifier` passed into `defineTools`).

---

## Optional: submit `code-analysis` plugin to Anthropic's channel allowlist

Status: not started. Anthropic-gated.

Today, Claudish-via-`code-analysis@magus` requires users to launch with `--dangerously-load-development-channels plugin:code-analysis@magus` for channel notifications to work. Each session shows a confirmation prompt. The friction is small but real.

Anthropic's [official plugin marketplace](https://github.com/anthropics/claude-plugins-official) accepts plugin submissions for inclusion in the global channel allowlist. Once accepted, users can switch to plain `--channels plugin:code-analysis@magus` (no dev flag, no confirmation).

**Trigger condition**: a user explicitly asks for the friction to go away, OR Claudish becomes used widely enough outside MadAppGang that the per-session prompt becomes a meaningful onboarding cost.

**Counter-consideration**: submitting to Anthropic's allowlist invites security review and ties our release cadence partially to theirs. Not worth doing for a small team's internal use.

Reference: research findings under `ai-docs/sessions/dev-research-channel-config-alternatives-20260508-233443-3f43f254/` confirm this is the only documented path to remove the dev flag for individual users.

---

## ~~Gemini Code Assist: use `fetchAvailableModels` for the served set~~ (CLOSED — moot)

**Status**: CLOSED as moot (2026-08-05). The `gemini-codeassist` provider was
removed entirely, so there is no longer a `getServedCodeAssistModels()` to
migrate. The endpoint's request shape — the trigger condition below — WAS
captured in the meantime (body `{ project }`, not `{ metadata }`) and is in
production use on the Antigravity path (`getServedAntigravityModels` in
`auth/antigravity-user.ts`). Retained for the record only.

**Original status**: not started

`getServedCodeAssistModels()` in `auth/gemini-oauth.ts` infers which models a
tier serves by reading the bucket list from `retrieveUserQuota`. That is an
inference, not an answer: it only reports models that have a quota bucket, and it
costs a quota round-trip on the auth path.

The backend exposes a purpose-built endpoint, `v1internal:fetchAvailableModels`.
Probing on 2026-08-01 confirmed it exists on both `cloudcode-pa.googleapis.com`
and `daily-cloudcode-pa.googleapis.com` — both answered HTTP 400 *"Unknown name
metadata: Cannot find field"* rather than 404, so the method is real and only its
request shape is unknown. Antigravity's logs show it in normal use.

**Trigger condition**: the quota-bucket inference produces a wrong served set in
practice (a served model missing from the list, or a listed model that 404s), OR
someone captures the correct `fetchAvailableModels` request shape.

**Effort estimate**: small once the payload shape is known — one function swap
behind the existing `getServedCodeAssistModels()` seam, with the quota-bucket
path kept as the fallback.

---

## Gemini Code Assist: individuals/Ultra tier needs an Antigravity-issued token

**Status**: SHIPPED — the `antigravity` provider (`ag@`) reuses the Antigravity
CLI's own token. See CLAUDE.md → "Antigravity Provider (ag@)".

The finding that unblocked it: the two backend checks are independent —
`loadCodeAssist` gates on request IDENTITY (`User-Agent` + `metadata.ideType`),
but `streamGenerateContent` gates on the TOKEN'S OAuth CLIENT (headers can't fake
it — 403 PERMISSION_DENIED for a gemini-cli token no matter the identity). So
claudish does NOT spoof its way in; it **reuses the user's own Antigravity token**
(the same one the `agy` CLI mints) from the shared macOS keychain store, and
self-refreshes with client creds extracted at runtime from the user's local `agy`
binary — never shipped. Verified end-to-end on Google AI Ultra with
`gemini-3.6-flash-high`.

**Remaining follow-up**: Linux/Windows keyring backends (macOS `security` only
today). Still genuinely open.

**Closed follow-up — a `claudish login antigravity` that does its own OAuth.**
Not deferred: *impossible*. Antigravity's client secret is baked per `agy`
release and rotates on auto-update (proven — the extracted secret was revoked
within a day, and there is no dynamic client registration), so claudish can
never hold one. v7.33.0 ships the reachable version instead: `claudish login
antigravity` installs and delegates to `agy`, which owns the whole credential
lifecycle. Refresh delegates the same way (`agy models`). Do not re-open this
expecting a claudish-native OAuth flow.

---

## Adding a new roadmap item

Each item should follow the structure above:
- **Status**: `not started` / `blocked on upstream` / `in progress` / `shipped`
- **Trigger condition**: explicit and falsifiable. *"When X happens"* > *"Someday"*. If you can't write a trigger condition, the item probably isn't ready to be on the roadmap yet.
- **Reference**: pointer to the research session, issue, or design doc with detail. Do not duplicate that detail here.
- **Effort estimate** (optional): rough sizing if the item moves toward action.

If a trigger condition has been met, move the item to *In Progress* and create the implementation tasks. If a trigger condition becomes irrelevant or wrong, delete the item rather than leave it stale.

---

## Consolidate the two channel test-helper stand-ins

`packages/cli/src/channel/test-helpers/` now holds **two** helpers that can echo argv:

- `fake-claudish.ts` — the original; consumed by BOTH `channel/session-manager.test.ts` and
  `team-orchestrator.test.ts`, the latter via `--print-argv` to assert the exact spawn
  contract *including flag order*
- `fake-channel-stream-json.ts` — added 2026-08-22 during the stream-json transport rewrite,
  with its own `--print-argv`

**Why this is parked rather than ignored.** The duplication already caused one outage of the
guard it exists to protect. Migrating the channel tests to the new helper made `--print-argv`
look dead in the old one; removing it turned the two `runModels — pinned spawn identity`
tests red — and they failed EMPTY rather than asserting, so the assertions pinning the
`--verbose`-before-`--quiet` invariant silently stopped RUNNING at exactly the moment the
argv change made that invariant most likely to break. A guard that cannot execute reads as
coverage. Restored the same day; a header comment on `fake-claudish.ts` now names both
consumers, which stops the specific recurrence but not the class.

**Proposed shape** (assessed 2026-08-22, not executed): keep `fake-channel-stream-json.ts`,
give it an explicit raw/immediate argv mode distinct from its framed mode, move the two
orchestrator tests onto it, then delete `fake-claudish.ts` after a repository-wide reference
check.

**Trigger conditions — all must hold:**

1. No session is concurrently editing `team-orchestrator.test.ts` (it moved twice on
   2026-08-22 alone; this work rewrites two of its tests).
2. A repository-wide reference check finds no consumer of `fake-claudish.ts` beyond the two
   known test files — a third consumer changes the answer from "consolidate" to "document".
3. The seven channel regression guards (G1–G7) are green BEFORE starting, so any red during
   the move is attributable to the move.

**Do not start if** the only motivation is tidiness. The comment already prevents the known
failure; this is worth doing when someone is in these files anyway, not as its own errand.

---

## Ultracode pro-preset: broaden past the OpenRouter-only roster

Status: shipped, deliberately narrow.

`--pro-on-ultracode` applies a model's catalog provider-preset while a Claude Code
session is in ultracode. It reads BOTH halves of the fact from the slim catalog's
`routeVariant` — `baseModelId` says which model the preset applies to, `preset`
(`reasoning.mode=pro`) says what to send — via `lookupVariantPresets()` in
`adapters/model-catalog.ts`. There is no model name regex and no hardcoded payload;
the `--model-params` parser doubles as the preset parser.

The gate is PROVIDER-SCOPED, and today that means OpenRouter only. Measured against
the live catalog on 2026-08-27 (`queryModels?catalog=slim`), exactly 3 of 753 entries
carry a `routeVariant`, all three of them `gpt-5.6-*-pro`, all recorded on
`provider: "openrouter"`. The base models are served much more widely —
`gpt-5.6-sol` lists openai, openrouter, opencode-zen and openai-codex — but each
`-pro` SKU exists on OpenRouter's roster alone.

**Why scoped rather than applied everywhere — now measured, not assumed.** Sending
`reasoning.mode=pro` to `gpt-5.6-sol` on each vendor (2026-08-27, real requests):

| Vendor | Result |
|---|---|
| `openrouter` | accepted (200) |
| `openai` (`api.openai.com/v1/responses`) | accepted (200) |
| `openai-codex` (ChatGPT OAuth backend) | **400** — `` `reasoning.mode` is not supported with this model `` |

So the parameter is neither OpenRouter-only nor universal. Applying it unscoped would
hard-400 every ultracode turn on `cx@`, which is the single most likely route for this
model family. The provider gate is what prevents that.

`oai@` accepting it means the CATALOG under-reports reality — the fix belongs in
models-index, not in a client-side exception list.

**Trigger conditions** (either is sufficient):

1. models-index records a `routeVariant` preset (or an equivalent per-vendor preset
   field) on a non-OpenRouter vendor row for the same base model. The client change is
   then zero — `lookupVariantPresets(model, provider)` already returns it.
2. A live run proves the parameter is accepted on another host, at which point the
   fact belongs in the catalog first (see `TASK_pro_preset_vendor_coverage.md` in the
   models-index repo), NOT in a claudish-side exception list.

**Do not** work around this by dropping the provider argument or adding a per-provider
allowlist in the CLI. That reintroduces exactly the hardcoded roster this design
removed, and `feedback_backend_repo_boundary` puts the data gap in the backend's repo.

**Effort**: none in claudish if trigger 1 lands. The gate already reads whatever the
catalog says.

Reference: `TASK_pro_preset_vendor_coverage.md` (models-index repo).

---

## `--effort-override` accepts only the seven canonical levels

Status: shipped, deliberately narrow.

`--effort-override <level>` pins reasoning effort verbatim and skips
`clampToAdvertisedEffort()`. It is NOT `--effort` — that name belongs to Claude Code
and claudish forwards it untouched in `claudeArgs` (pinned by
`cli-passthrough.test.ts`). The two compose: `--effort` says what to ask for,
`--effort-override` says do not clamp what I asked for.

It accepts only `none|minimal|low|medium|high|xhigh|max`, because the value flows
through the `EffortLevel`-typed pipeline in `base-api-format.ts`. A provider-specific
value outside that set has an existing escape hatch that needs no new flag:
`--model-params reasoning_effort=<value>`, which lands on the payload after every
adapter has finished.

**Trigger condition**: a provider ships a native effort vocabulary that is neither one
of the seven nor reachable by a single `--model-params` key — e.g. an effort knob whose
parameter NAME differs per dialect AND whose values are provider-specific. Only then
does a dialect-aware native-value path earn its complexity.

**Do not** widen `EffortLevel` itself to accommodate one provider. It is the canonical
vocabulary Claude Code emits, and the clamp table is what maps it onto each provider.
