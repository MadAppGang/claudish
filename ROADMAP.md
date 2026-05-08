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

## Optional: `notifications/progress` as a secondary CLI-UI signal

Status: empirically validated as safe. Not started. Low priority.

Today the `team` tool blocks the orchestrator agent until all children finish. Channels surface intermediate completions to **agent context**. But the **terminal UI** shows nothing until the call returns.

The `notifications/progress` primitive (already in the MCP spec) renders to Claude Code's CLI progress display. Per Anthropic-attributed comment on `anthropics/claude-code#4157`: *"Claude Code doesn't currently have a generic UI for displaying real-time progress from custom MCP servers, though the protocol fully supports it."* — meaning there's no generic surface, but the primitive itself works.

Earlier a regression (`anthropics/claude-code#53617`, `#47378`) caused stdio servers emitting `notifications/progress` to be killed mid-call. **This regression is no longer reproducible on Claude Code 2.1.133** (verified 2026-05-09 with `progress-regression-mock.ts` — the second tool call after a progress emission survives cleanly).

If we ever want a richer terminal UI for `team` runs, we could emit `notifications/progress` from the same callback that fires channel events. Strictly additive; doesn't replace channels. Costs maybe an hour of work.

**Trigger condition**: a user (or you) reports the lack of mid-call CLI feedback for `team` as friction.

Reference: `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/`

---

## Optional: submit `code-analysis` plugin to Anthropic's channel allowlist

Status: not started. Anthropic-gated.

Today, Claudish-via-`code-analysis@magus` requires users to launch with `--dangerously-load-development-channels plugin:code-analysis@magus` for channel notifications to work. Each session shows a confirmation prompt. The friction is small but real.

Anthropic's [official plugin marketplace](https://github.com/anthropics/claude-plugins-official) accepts plugin submissions for inclusion in the global channel allowlist. Once accepted, users can switch to plain `--channels plugin:code-analysis@magus` (no dev flag, no confirmation).

**Trigger condition**: a user explicitly asks for the friction to go away, OR Claudish becomes used widely enough outside MadAppGang that the per-session prompt becomes a meaningful onboarding cost.

**Counter-consideration**: submitting to Anthropic's allowlist invites security review and ties our release cadence partially to theirs. Not worth doing for a small team's internal use.

Reference: research findings under `ai-docs/sessions/dev-research-channel-config-alternatives-20260508-233443-3f43f254/` confirm this is the only documented path to remove the dev flag for individual users.

---

## Adding a new roadmap item

Each item should follow the structure above:
- **Status**: `not started` / `blocked on upstream` / `in progress` / `shipped`
- **Trigger condition**: explicit and falsifiable. *"When X happens"* > *"Someday"*. If you can't write a trigger condition, the item probably isn't ready to be on the roadmap yet.
- **Reference**: pointer to the research session, issue, or design doc with detail. Do not duplicate that detail here.
- **Effort estimate** (optional): rough sizing if the item moves toward action.

If a trigger condition has been met, move the item to *In Progress* and create the implementation tasks. If a trigger condition becomes irrelevant or wrong, delete the item rather than leave it stale.
