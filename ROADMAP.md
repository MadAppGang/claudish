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

**A third transport reaches the polling orchestrator** (v9.2.0). The two above reach an agent's
context and a human's terminal; neither reaches a caller polling `team(mode:"status")`, which is
how every review panel actually watches a run. That caller had only `outputSize`, which is written
once at completion and so reads 0 for a slot's whole life — and orchestrators read it as progress
and reported working slots as dead. `live_output_bytes_by_slot` now carries the same live count
`status.txt` shows, in the same unit `outputSize` ends up holding. See
`ai-docs/architecture/team-lifecycle.md`.

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

## The two bundled `claudish-usage` SKILL.md copies are stale and never mention `team`

Status: not started.

`skills/claudish-usage/SKILL.md` and `packages/cli/skills/claudish-usage/SKILL.md` (the
latter shipped in the npm package's `files` array and installed into a project by
`cli.ts:2408`) were last touched at v4.5.1. Neither mentions `team` at all, and they have
drifted from each other on model ids (`openai/gpt-5` vs `openai/gpt-5.3`).

They are NOT the plugin skill. The skill agents actually load is
`plugins/claudish/skills/claudish-usage/SKILL.md` in the magus-src repo, which is current
and which carries the `team` lifecycle documentation. So these two copies cannot teach a
wrong `team` procedure — they say nothing about `team` — but a user who runs the
install-skill path gets a document that is four major versions behind on everything else.

Found while fixing the `outputSize`-as-progress misreading (v9.2.0); deliberately left
alone there, because rewriting an unrelated stale document inside a bug fix is scope creep.

**Trigger condition**: someone reports confusion from the installed skill, OR the
install-skill path is touched for any other reason. Whoever picks it up must first decide
whether these copies should exist at all — a third copy of a document whose real home is
another repo is the actual defect, and deleting them plus pointing the CLI at the plugin
may be the correct fix rather than syncing a third copy forever.

**Effort**: small to decide, medium if the answer is "sync", small if the answer is "delete".

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

---

## Route `--advisor` panel calls through subscription-aware routing

Status: not started. Deliberately out of scope for the any-model advisor work.

Every `--advisor` panel model and collector is called through `advisorRouteFor`
(`handlers/native-handler-advisor.ts`) with a raw metered API key: api.openai.com with
`OPENAI_API_KEY`, the direct Gemini API with `GEMINI_API_KEY`, api.anthropic.com with
`ANTHROPIC_API_KEY` for a Claude collector, and OpenRouter with `OPENROUTER_API_KEY` for
everything else. It never calls `route()`. So a Codex, SuperGrok or Antigravity subscriber pays
per token for panel calls, and a `cx@` or `gk@` panel spec goes to OpenRouter.

This is visible, not silent: the startup notice prints each panel model's host and key with
"billed per token" under "panel calls never use a subscription", and a panel model with no key
is refused at startup.

**Why parked.** Making the panel subscription-aware means sending each panel call through the
routing chain (the credential authority's OAuth arms, per-provider transports,
`SUBSCRIPTION_PROVIDERS` billing) instead of one bare `fetch` per model. That rewrites the advice
retrieval path, which the stub paths and origin records were built around, and the feature's
out-of-scope list protected panel behaviour.

**Trigger condition** (either is sufficient):

1. A user asks to run the panel on their subscription, or reports unexpected metered spend from
   panel calls.
2. The panel's advice retrieval path is being reworked for another reason.

**Must still hold after the change:** origin records still separate `upstream` from `stub` per
model; billing is decided by the credential that signed (`RequestAuth.arm`), never by the
provider name (CLAUDE.md invariants); the startup refusal and notice keep reading the same single
routing function as the runtime.

**Effort**: medium to large.

Reference: `ai-docs/architecture/advisor.md` ("Panel routing and billing");
`ai-docs/reports/advisor-scope-decisions-20260910.md`.

---

## `--advisor`: a reasoning-only panel reply is recorded as a stub

Status: not started. Recorded as a known limitation of the any-model advisor work.

`extractChatCompletionText` (`packages/cli/src/handlers/native-handler-advisor.ts:2179-2187`)
reads only `choices[0].message.content`, as a string or as an array of text parts. If a
reasoning model answers HTTP 200 with its text in a reasoning field and `content` null or empty,
the check at `:2152` records `origin: "stub"` with "HTTP 200 but the response carried no advice
text". The main model then receives a failure, not advice, for a call that was billed.

This is visible, not silent: the failure text names the model, the call raises one warning, and
the `advisor_call` record says `stub`.

**Why parked.** Two questions come first. The field that carries reasoning differs between
providers, so the shape must come from a real captured response, never a guessed one (fixtures
come from real debug logs). And reasoning without a final answer is the model's working, not its
conclusion; whether it counts as advice is a product decision.

**Trigger condition**: a real run shows a panel model returning reasoning with empty content, or
a user reports stub advice from a reasoning model.

**Must still hold after the change:** a reply with no text at all stays `stub`; if reasoning is
accepted as advice, the `advisor_call` record says so, so a reader can tell it apart from an
answer.

**Effort**: small.

Reference: `ai-docs/reports/advisor-build-report-20260911.md` ("Known limitations").

---

## `openai-sse` parser: one `catch` drops every per-chunk error without a log line

Status: not started. Found during the any-model advisor work; not specific to the advisor.

In `packages/cli/src/handlers/shared/stream-parsers/openai-sse.ts`, the `try` at `:534` opens
with `JSON.parse(dataStr)` and closes at `:896` with `} catch (e) {}`. It covers the parse and
all chunk handling after it: usage, text deltas, reasoning, and tool calls. Any exception in
those 360 lines is dropped, and the loop moves to the next line. A malformed chunk, or a bug in
tool-call handling, can drop a tool call while the turn still ends with `end_turn`.

The raw chunk is logged verbatim at `:528` under `--debug`, so the input survives. The fact that
it was dropped does not. `openai-sse` is the default stream format for every adapter that does
not override it (`packages/cli/src/adapters/base-api-format.ts:605`), so the effect reaches most
foreign providers. During the advisor work this cost a full investigation of the SSE log
truncation defect.

The catches at `:267` and `:270` are different: they guard `enqueue` and `close` on a stream
that can already be closed, and are correct.

**Why parked.** Out of scope for the advisor work, and the file is shared by every OpenAI-shaped
provider, so a change needs its own test run across the stream-format fixtures.

**Trigger condition**: the next edit to `openai-sse.ts`, or any report of a tool call that
vanished or a turn that ended early on an OpenAI-shaped provider.

**Must still hold after the change:** one bad chunk still does not end the stream; the error is
logged with enough context to find the chunk in a debug log; the replayed fixtures in
`format-translation.test.ts` stay green.

**Effort**: small for a log line; medium if the `try` is narrowed to the parse.

---

## Local `bun run test` skips the macOS bridge suite

Status: not started. Local only; CI is not affected.

`package.json:23` runs `bun run --cwd packages/cli test && bun run --cwd packages/macos-bridge
test`. On `bun` 1.4.0 the two `displayWidth` Unicode-oracle tests in
`packages/cli/src/tui/viz/color.test.ts` fail, the CLI suite exits non-zero, and `&&` stops
before the bridge suite starts. A local `bun run test` therefore reports nothing about the
bridge.

CI pins `bun` 1.3.10 (`.github/workflows/test.yml:58`), where the CLI suite is green and the
bridge suite runs: run `34544453952` on the `v9.3.0` merge printed `Ran 3257 tests across 211
files`, then `Ran 20 tests across 1 file`.

**Why parked.** Nothing is unguarded in CI today. The risk arrives when the CI pin moves to a
`bun` version where the two tests fail: CI then goes red and, the same way, stops running the
bridge suite.

**Trigger condition**: the CI `bun` pin is raised, or someone relies on a local run to check a
bridge change.

**Must still hold after the change:** the root `test` script still fails when either suite
fails; both suites report even when the first one fails.

**Effort**: small.

---

## Regression test: a Responses stream that dies mid tool-call

Status: DONE. Fix shipped, unit test written and mutation-proven, and the client-side
behaviour verified end to end against a real Claude Code run (see
`ai-docs/reports/truncated-toolcall-live-verification.md`). Kept here for the method,
which is reusable for any "does the harness honour this wire signal" question.

The fix is in `openai-responses-sse.ts`: when `openToolBlocks` is non-empty in the
parser's catch block, the turn ends with an SSE `error` event instead of `end_turn`,
so Claude Code cannot execute a tool call whose argument JSON was cut mid-object.
Rationale and the evidence behind it: `ai-docs/architecture/adapters.md`, section
"A stream that dies mid tool-call".

**Trigger condition**: a stable connection to the Codex backend. Nothing else blocks it.

**The spec** (kept here because `ai-docs/sessions/` does not survive a fresh clone):

Append one `describe` block to
`packages/cli/src/handlers/shared/stream-parsers/openai-responses-sse.test.ts`, reusing
its `createMockContext` / `parseClaudeSseStream` helpers. Derive the upstream body from
the REAL capture `test-fixtures/sse-responses/gpt-5.6-sol-responses-turn1.sse` — do not
hand-write SSE. In that fixture the first `function_call` item is added at line 94, its
first argument delta is line 97, and it completes at line 103.

- Test 1 — cut the fixture just after line 97, then `controller.error(new TypeError("The
  socket connection was closed unexpectedly"))`, which is the production error text.
  Assert: an `event: error` frame with `error.type === "api_error"`; NO `message_delta`
  carrying `stop_reason: "end_turn"`; a `tool_use` `content_block_start` WAS emitted (or
  the test can pass vacuously by the tool never starting); every block start has exactly
  one matching stop.
- Test 2 — cut during `response.output_text.delta`, before any `function_call` item, and
  error the stream identically. Assert `stop_reason: "end_turn"` and a text block
  containing `[Stream error:`. This pins the branch that must NOT change.

**Acceptance criterion**: mutation-test it. Force the `if (toolCallCutOff)` condition to
`false`, confirm test 1 goes red and test 2 stays green, then restore the file by copy —
never `git checkout` or `git stash`, the index is shared with sibling worktrees.

**VERIFIED 2026-09-10**: Claude Code DOES discard a partial tool block on a mid-stream
`error` event. Measured before/after against the same mock upstream: released v9.0.8
executed the truncated `Write` and returned `InputValidationError`, while the fixed build
executed no tool at all and retried the turn. Method and raw evidence:
`ai-docs/reports/truncated-toolcall-live-verification.md`.

## Picker: the `all-filtered` notice must say "no capability data", not "not chat-capable"

Status: not started. Found in the v10.1.1 release review (merge of the strict chat rule with v10.1.0's picker outcome states).

`buildDiscoveredModelOutcome` (`model-selector.ts`) returns `all-filtered` whenever every served row fails `isReportedChatCapable`, and `DiscoveryNotice.tsx` renders it as "served N models, none of them chat-capable". That wording dates from when an undescribed model counted as chat. Under the strict rule it also fires when nobody DESCRIBED the rows: LM Studio's picker path reads `/v1/models` (no `type` field) while `--probe` reads `/api/v0/models` and its `type`, so the two screens disagree about the same daemon. Hiding the rows is correct; the sentence is false. Carry the undescribed count (`unavailableForMissingCapability` already computes it for the probe path) on the variant and word the notice from it; optionally read LM Studio's `type` in the picker fetcher too.

**Trigger condition**: the next change to `buildDiscoveredModelOutcome` or `DiscoveryNotice.tsx`, or the first user report of a picker notice calling local models not chat-capable.

## Picker tests: cover admission by catalog evidence alone

Status: not started. Found in the same review.

No picker-level test covers an `openai-models-list` provider (13 builtins plus LM Studio), whose discovered rows carry no `reported` and are admitted by the catalog alone; only the negative case is tested. `model-selector-discovery.test.ts` also now uses `mock.module("…/all-models-cache.js")` (contained, restored in `afterAll`), and its STATE C endpoint assertion is circular because the fixture sets the endpoint. Add a positive case (a served id the catalog fixture knows by alias is kept with no `reported`), assert the endpoint on a path the fixture does not control, and replace the module mock with a test-only catalog hook like `catalog-client`'s `_setCatalogEntriesForTest`.

**Trigger condition**: before the next change to the discovered-row admission path, or with the item above.

## MCP pane children: follow-ups deferred from the 10.4.0 migration

Status: not started. Deferred during code review of the pane migration (PR #288); each line names the
finding id in `ai-docs/reports/mcp-magmux-panes/session-record/implementation-log.md` ("Code-review fixes
(iteration 1)"), where the reason is recorded.

- **Background-shell orphan between refreshes.** A shell started and orphaned between two 2 s group refreshes
  is never recorded in the pane's group file, so the watcher cannot reap it. Trigger: any report of a
  leftover process after a pane closed, or the next change to `pane-registry.ts` group snapshots.
- **A-L2 — shutdown reap ≈ 6–7 s instead of ≈ 3 s.** Watchers already cover an early SIGKILL. Trigger: an MCP
  host that kills the server before ~7 s on shutdown.
- **A-L5 — spurious re-wake after a screen-only settle.** Needs a deterministic degraded-mode fixture.
  Trigger: a degraded (no-transcript) turn reported as a model re-wake in the field.
- **A-L9 — a prompt starting `/word ` is typed as a slash command.** Needs a product decision (escape it, or
  document it). Trigger: the first prompt that starts with a slash but is not a command.
- **B-L4 — `run_id` falls back to the basename before the first flush.** Needs the id minted before
  prehydrate. Trigger: the next change to `team(mode="run")` start-up ordering.
- **C-L1 — an `invalid_args` spawn model is recorded as `pane_lost`.** Trigger: the next change to
  `create_session` argument handling.
- **C-L5 — accounting freezes at the terminal transition.** The Magus monitor reads `tokens.json`, so it is
  unaffected today. Trigger: a consumer that reads final tokens from the session row instead.
- **gpt-5-mini cost is estimated** (`stats/*.json` prices it at $2/$8 per M with `is_estimated:true`), so
  `cost_usd` may be overstated for it. Trigger: the catalog publishing real gpt-5-mini pricing.
- **`proxy-server.test.ts` "keyless custom endpoint" timed out at 5 s in CI** (once, on PR #288; it
  passes 3/3 locally; main's own CI also failed once on 2026-09-26, cause not checked). Trigger: a second
  CI failure of that test.
