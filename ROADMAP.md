# Roadmap

Planned-but-unimplemented work for Claudish. Items here are deliberately scoped, with explicit **trigger conditions** — what needs to be true upstream or in our codebase before each item moves to active development. If a trigger condition isn't met, leave the item parked.

For shipped features and current architecture, see `CLAUDE.md`. For ad-hoc research and validation sessions, see `ai-docs/sessions/`.

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

## ~~Optional: `notifications/progress` as a secondary CLI-UI signal~~ — Parked

Status: **investigated, decisively parked, with a corrected rationale**. Not implementing.

We considered emitting `notifications/progress` from `team`'s child-completion callback as a richer terminal UI signal. Two issues, one of which we initially got wrong:

- ❌ **Claude Code does not render progress notifications anywhere observable.** Verified 2026-05-09 against Claude Code 2.1.133 with `progress-regression-mock.ts`'s `slow_with_many_progress` tool emitting 5 distinct progress messages over ~10s. Mid-flight pane capture showed no terminal-UI rendering. The agent reported verbatim: *"I did not observe any progress messages during the call... nothing was surfaced to the agent context."* Matches the Anthropic-attributed comment on `anthropics/claude-code#4157`: *"Claude Code doesn't currently have a generic UI for displaying real-time progress from custom MCP servers."*
- ❌ **The transport-kill regression is NOT fixed in 2.1.133 — earlier note that it was, was wrong.** A first test on 2026-05-09 (`progress-regression-mock.ts`'s `slow_ping_with_progress` + `simple_ping`) reported the regression resolved. **That test was insufficient.** It used sequential `await` ordering, putting all progress notifications strictly *before* the tool response, which avoids the race. The actual trigger documented in `GLips/Figma-Context-MCP#362` is **concurrent or quick-succession tool calls** where a progress notification arrives at the client *after* its `progressToken` cleanup has run. The MCP SDK then treats it as a protocol violation (`"Connection error: Received a progress notification for an unknown token"`) and tears down stdio. This bug is documented as still affecting Claude Code 2.1.x in the field. **The `team` use case (N concurrent child sessions, each with its own `progressToken`) is the exact pattern that triggers the bug.**

So implementing this not only adds code that fires into a void — it would actively destabilize `team`. Two independent reasons not to do it.

**Trigger condition for un-parking** (both must hold):
1. Claude Code's MCP SDK fixes the strict-token-validation bug (the underlying cause of `Figma-Context-MCP#362`); look for changes in `@modelcontextprotocol/sdk` Client to ignore unknown progress tokens instead of treating them as fatal.
2. Claude Code ships UI/agent rendering for progress notifications from custom MCP servers (issue `anthropics/claude-code#4157`).

**References**:
- Original empirical session: `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/`
- Community-research session that surfaced the corrected understanding: `ai-docs/sessions/dev-research-mcp-progress-community-20260509-213410-c058a909/`
- Test artifacts: `packages/cli/src/channel/test-helpers/progress-regression-mock.ts`
- Field evidence of the still-active bug: <https://github.com/GLips/Figma-Context-MCP/issues/362>

---

## Optional: submit `code-analysis` plugin to Anthropic's channel allowlist

Status: not started. Anthropic-gated.

Today, Claudish-via-`code-analysis@magus` requires users to launch with `--dangerously-load-development-channels plugin:code-analysis@magus` for channel notifications to work. Each session shows a confirmation prompt. The friction is small but real.

Anthropic's [official plugin marketplace](https://github.com/anthropics/claude-plugins-official) accepts plugin submissions for inclusion in the global channel allowlist. Once accepted, users can switch to plain `--channels plugin:code-analysis@magus` (no dev flag, no confirmation).

**Trigger condition**: a user explicitly asks for the friction to go away, OR Claudish becomes used widely enough outside MadAppGang that the per-session prompt becomes a meaningful onboarding cost.

**Counter-consideration**: submitting to Anthropic's allowlist invites security review and ties our release cadence partially to theirs. Not worth doing for a small team's internal use.

Reference: research findings under `ai-docs/sessions/dev-research-channel-config-alternatives-20260508-233443-3f43f254/` confirm this is the only documented path to remove the dev flag for individual users.

---

## Adaptive / shared backoff pacer for burst rate-limits

Status: not started. Deliberately deferred — current per-request backoff is judged sufficient for the present load.

**What ships today** (the in-stream rate-limit fix): when an `anthropic-sse` provider (notably Z.AI) delivers its burst/RPM limit as HTTP 200 + an in-stream `[1302]` SSE error, ComposedHandler peeks the stream start, detects it, and **temporizes with a per-request jittered exponential backoff** (1s/2s/4s + 0–750ms), retrying the same provider up to 3× before returning 429 so FallbackHandler switches providers (e.g. Z.AI → GLM Coding, a separate quota). The transport layer (`AnthropicProviderTransport.enqueueRequest`) adds a second jittered backoff on genuine HTTP 429. Both are **per-request and independent** — there is no shared, cross-request pressure gauge.

This produces *implicit* aggregate self-throttling: under a storm, more requests hit 429 → more requests back off → offered load drops. It does not, however, make *new arrivals* probe more cautiously while a storm is in progress — each new request still fires at full rate on its first attempt. With the stated load (≤50% of the 5h sustained quota even at peak; only the instantaneous burst limit is hit occasionally, and the cluster shares one key per provider), that residual gap is acceptable and a coordinated pacer would be over-engineering.

**What this item would add**: a shared per-provider pressure gauge (e.g. AIMD — additive-increase/multiplicative-decrease — with time decay) that admission-paces *new* requests as the recent error rate climbs, so the fleet spreads requests **more** under a sustained storm rather than only after each individual request fails. This is the "écarter encore plus les requêtes quand le taux d'erreurs augmente" idea — correct in principle, but only worth the complexity (shared state across 6 machines, or per-process approximation; tuning; new failure modes) if the simpler per-request backoff proves insufficient.

**Trigger conditions** (any one):
- Sustained-quota utilization regularly approaches its ceiling (not just the instantaneous burst limit) — i.e. the "we have headroom" premise stops holding.
- Capture/telemetry shows the in-stream-rate-limit fix's 3-retry budget is frequently exhausted (turns still failing over to fallback or to the client) despite the backoff — meaning synchronized full-rate probing during storms is the dominant remaining failure.
- The cluster grows enough that uncoordinated per-request backoff visibly re-collides on the burst limit even with jitter.

**Effort**: medium. A per-process AIMD gauge is small; a genuinely *shared* cross-machine gauge needs a coordination point (shared store or a designated pacer) and is the bulk of the cost.

**Reference**: in-stream rate-limit fix — `packages/cli/src/handlers/shared/stream-peek.ts`, `composed-handler.ts` (peek+retry block), `providers/transport/anthropic-compat.ts` (`enqueueRequest`). Root-cause analysis in this session's capture diagnosis.

---

## Adding a new roadmap item

Each item should follow the structure above:
- **Status**: `not started` / `blocked on upstream` / `in progress` / `shipped`
- **Trigger condition**: explicit and falsifiable. *"When X happens"* > *"Someday"*. If you can't write a trigger condition, the item probably isn't ready to be on the roadmap yet.
- **Reference**: pointer to the research session, issue, or design doc with detail. Do not duplicate that detail here.
- **Effort estimate** (optional): rough sizing if the item moves toward action.

If a trigger condition has been met, move the item to *In Progress* and create the implementation tasks. If a trigger condition becomes irrelevant or wrong, delete the item rather than leave it stale.
