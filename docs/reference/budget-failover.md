# Budget failover + Qwen thinking — full reference

**Deferred from `CLAUDE.md` (v7.2+ section).** The config table and the arming/quota gotchas stay in `CLAUDE.md`; this file holds the rationale and the measurements. Canonical env template with inline comments: `.env.sidecar.example`.

## Not the same thing as `FallbackHandler`

`FallbackHandler` swaps *providers* for the *same* model when a provider is unhealthy — a transport concern. Budget failover substitutes the *model itself* for a whole **role** (`opus`/`sonnet`/`haiku`) when that role's metered plan is exhausted — a subscription concern. They compose: a failover target still gets the normal provider fallback chain.

## Why it exists

The cluster runs on weekly-metered plans (Anthropic, MiniMax, Z.AI). When a plan burns faster than its reset window, the choice is to stop working or to serve the role from another pool. Serving it *silently* is the dangerous option: the agent keeps assuming capabilities it no longer has, or — in the MiniMax→DeepSeek direction — fails to use capabilities it just gained. So every substitution is announced.

## Where the notice goes: condensation

`ComposedHandler` appends it to the collected message on the non-streaming path (`stream: false`), which in practice is `/compact`. That boundary is chosen because it is the only moment in an agentic session where the context is rebuilt from scratch anyway — the notice costs nothing there, is guaranteed to survive into the continuing context, and the prompt cache is already cold so re-routing is free. `appendFailoverNoticeToMessage` targets the **trailing** text block (clients may read `content[0]`) and **never throws**: a thrown error would turn a working condensation into a failed one, and a session that cannot condense eventually stalls.

## Configuration (env, read at proxy startup)

| Var | Meaning |
|---|---|
| `CLAUDISH_FAILOVER_<ROLE>` | Routing target for the role. Any spec `getHandlerForRequest` accepts. |
| `..._LABEL` | Human name used in the notice. Defaults to the target string. |
| `..._DIRECTION` | `degraded` (default) · `improved` · `lateral`. Unset means degraded — never flatter the substitute. |
| `..._NOTE` | Extra guidance appended to that role's notice line. |
| `CLAUDISH_FAILOVER_ACTIVE` | Roles armed **now**, comma-separated, or `none`. Use to conserve a plan *before* it dies. |
| `CLAUDISH_FAILOVER_AUTO` | `1` = also arm on genuine upstream quota exhaustion. |

**With nothing set, every code path is inert** — no routing change, no notice, zero added bytes. Configuring a target does **not** activate it; arming is separate and deliberate.

**`isQuotaExhaustion` is deliberately narrower than `FallbackHandler.isRetryableError`.** 402 arms on status alone; 429 arms only when the body names a quota/credit/balance/weekly/plan wall — a plain per-minute rate limit must **not** burn the weekly switch because a burst hit a 60-second window. 401 and 404 **never** arm: those are wiring mistakes, and swapping the model would hide a bad key or a bad model id behind a plausible-looking answer.

**Placement.** These belong on the machine that actually *calls* the models. A NOMINAL sidecar only relays, so on a sidecar they matter solely for AUTONOMOUS (hub-down) mode — the hub is the normal home. A failover target must be resolvable *on that machine*: pointing a sidecar at a custom endpoint defined only in the hub's `config.json` configures a fallback that fails exactly when it is needed.

## `CLAUDISH_QWEN_THINKING`

Qwen reasons by default, so an unset `thinking` is not neutral — it means "think, at length", and the Token Plan bills on **output**. Values: `disabled` (default) · `passthrough` · `budget:<n>`. Re-read on **every request**, deliberately: the fleet flips this during a budget crunch, and a cached value would require restarting the proxy that is at that moment the thing keeping everyone working.

The subtlety this encodes: Qwen exposes **two switches on two wires, and each endpoint ignores the other's form**. The OpenAI-compatible endpoint takes `enable_thinking` + `thinking_budget`; the Anthropic-compatible one takes the native `thinking` object. `QwenModelDialect.prepareRequest` therefore branches on `ctx.wireFormat` (`PrepareRequestContext`, threaded from `ComposedHandler.resolveStreamFormat()`). Before this, the adapter converted `thinking` → `enable_thinking` unconditionally, which on the Anthropic wire **deleted the only switch that works**.

Measured against Qwen Token Plan, `max_tokens: 400`, prompt `"Reponds exactement: ok"` (2026-08-11): baseline `67 in / 43 out` with a thinking block; `enable_thinking: false` → `67 / 48`, still thinking; `thinking: {type: "disabled"}` → `31 / 1`. Note the **input** count moves too (67 → 31) — Alibaba appears to inject a reasoning preamble when thinking is on. That makes a crisp post-deploy check: **if `input_tokens` drops from 67 to 31 on that prompt, the native switch reached Qwen.**

---

# Cascade, notices and backoff (merged from `CLAUDE.md`, 2026-08-23)

Detail deferred from the decision layer when `CLAUDE.md` was restructured. Source commits:
`823e614` (transitive cascade + recovery notices), `7a94e23` (stream notice + `NativeHandler`
status propagation), `30a974f`, `a84f509` (auto-arm TTL), `65e1822`/`d211972`
(`CLAUDISH_FAILOVER_ROLE_MODELS`), `6bd6f7a` (fail-forward), `b8e47ba`/`ffb7f39` (reset-time),
`ca97e58` (`CLAUDISH_GLM_THINKING`).

## Transitive cascade of degradations (2026-08-12)

A role's failover is an **ordered list of substitute steps**, not a single target. When the nominal
walls, serve step 0; when step 0 *also* walls, serve step 1; and so on. Opus to GLM today is not a
special route — it is Opus to Qwen where Qwen is also dead, so the walk falls to Qwen's own successor
GLM. The last step (typically PAYG) is always served when everything above is down, because PAYG has
no weekly wall.

**GLM is a rolling ~5h window** — it dies AND restarts every 5h, not a consumable pool like the Qwen
weekly quota; DeepSeek PAYG fills GLM's holes. Modeling the cascade as a walk means the expected
end-of-week state (GLM down 3-4h, PAYG holding everyone for ~1h until the GLM reset) needs no new
routing: each step simply walls in sequence.

## Environment, per step

All `>`-separated fields are position-preserving against the step list.

| Variable | Meaning |
|---|---|
| `CLAUDISH_FAILOVER_<ROLE>` | Ordered cascade of substitutes, `>`-separated. Step 0 serves when the nominal walls, step 1 when step 0 also walls. No separator = single-step (backward compatible). The nominal itself is NOT in the list. Any spec `getHandlerForRequest` accepts, per step. |
| `..._LABEL` | Human name(s) for the notice. Missing/padded entries default to the step's target string. |
| `..._DIRECTION` | Per step: `degraded` (default) · `improved` · `lateral`. Unset means degraded — never flatter the substitute. |
| `..._NOTE` | Extra guidance appended to that step's notice line. |
| `..._RESET` | Operator-declared wall-lift time per step, ISO 8601 (empty entry = none). While set and in the future the step is skipped entirely — no probe — then probed the moment it passes, so recovered budget is consumed rather than stranded. For walls whose body carries no date (Mistral's subscription 402). A body-parsed date (Qwen names its reset instant, MiniMax counts down — `parseResetAtFromBody`) **wins over** the declared one. Log surface: `ttl=until <ISO>` instead of `ttl=<N>min`. |
| `CLAUDISH_FAILOVER_ROLE_MODELS` | Deployment-specific `pattern:role,pattern:role` aliases (lowercase substring match) so clients naming the nominal model directly (`glm-5.3`, `MiniMax-M3`) instead of a role keyword (`claude-sonnet-4-6`) still get cascade protection. Role keywords win when both match; unset = keywords only. Used by `roleFromModelName`, the single role-detection source shared by the swap and the cascade loop. |

⚠ **Compose passes these one by one.** `_RESET` was missing from the passthrough until `ffb7f39`,
so only the body-parsed path (Qwen) worked; Mistral's silent 402 fell back to a 10-60 min backoff and
was re-probed in a loop instead of being held until its real reset date. Verify with
`docker exec <container> printenv CLAUDISH_FAILOVER_SONNET_RESET`.

## Resolution and the cascade loop

**Resolution is a single source of truth.** `resolveFailoverTarget(role)` walks the rule's steps,
skipping TTL-failed ones, returning the first live step (or the last step anyway, since PAYG is meant
to always work). It is the ONLY resolution path — used by BOTH the swap in `getHandlerForRequest`
AND the `handleWithCascade` loop. The loop never passes an override target in: it mutates failover
state (`armFailover` / `markStepFailed`), and the next iteration re-reads through the same resolver.

**`handleWithCascade`** (`proxy-server.ts`, on both `/v1/messages` and `/v1/chat/completions`)
replaces the old single-shot retry with a bounded loop: nominal, then step 0, then step 1, and so on,
capped at `steps.length + 1` attempts.

- On `response.ok`: nominal success resets all step failures for the role (fresh episode); step
  success resets just that step.
- On `!ok` plus `isQuotaExhaustion`: a nominal wall arms the role; a step wall marks that step failed.
- Non-quota errors (401/404/wiring) return as-is without advancing.

Bounded, no `while(true)`, never hangs. The **c-reuse invariant** is load-bearing: handlers must not
mutate the Hono `Context` before returning a non-ok `Response`, so re-calling `handler.handle(c, body)`
across iterations is safe.

## Per-step backoff (cascade TTL)

Each step tracks its own failure count plus last-failure timestamp in
`stepFailures: Map<role, StepFailure[]>`. `stepTtlMs(count)` indexes
`BACKOFF_MS = [10m, 30m, 1h, 4h, 24h]` (caps at 24h). A TTL-failed step is skipped by
`resolveFailoverTarget` until its TTL elapses.

**Reset-time dominance.** The backoff assumes the wall's duration is unknown. When it IS known —
body-parsed, or declared via `..._RESET` — `StepFailure.resetAt` holds the step skipped until that
instant, overriding the backoff entirely (a 24h-capped re-probe cycle against an 11-day wall is pure
waste). The moment the reset passes, the step becomes probeable again, so a recovered budget is
consumed rather than stranded behind its own backoff. Success on the step, or nominal recovery,
clears `resetAt` with the rest of the failure state.

**Critical invariant: `stepFailures` survives the role-arm TTL cycle.** The role-level auto-arm TTL
(10 min) re-probes the nominal on expiry — but it must NOT re-probe a TTL-failed step. Without this,
the 10-min nominal re-probe would re-probe a weekly-walled Qwen every 10 minutes, defeating the
backoff that caps it at ~6 probes over 6 days. The schedule fits both failure shapes: Qwen's weekly
wall is probed a handful of times then left alone; GLM's 10m+30m+1h+4h is about 5h30, which naturally
lands a probe shortly after its 5h window resets. `stepFailures` IS cleared (whole role) when the
**nominal** recovers — a healthy nominal means a fresh episode.

## The three notice moments

Notices are centralized in `applyFailoverNotices` (`proxy-server.ts`), covering `ComposedHandler`
AND `NativeHandler` — moving them out of `composed-handler` closed the gap where Opus-on-native
recovered silently.

1. **Condensation** (`appendFailoverNoticeToMessage`, non-streaming / `/compact` path). Appended to
   the collected message. That boundary is chosen because it is the only moment in an agentic session
   where the context is rebuilt from scratch anyway — the notice costs nothing there, is guaranteed to
   survive into the continuing context, and the prompt cache is already cold so re-routing is free.
   Targets the **trailing** text block (clients may read `content[0]`) and **never throws**: a thrown
   error would turn a working condensation into a failed one, and a session that cannot condense
   eventually stalls. Fires at every condensation while a role is armed, naming the
   **currently-resolved step** with depth ("the 2nd fallback") plus which prior steps are exhausted.

2. **Moment of failover** (`consumeStreamNotice` plus `prependNoticeToAnthropicStream`, streaming
   path). The FIRST streamed response a session receives under an active role failover gets a notice
   prepended as content block 0, with every real block's `index` shifted by `+1`. The substitute model
   then reads its own prior turn — starting with this notice — on the next turn's history.
   **Depth-aware re-notify:** `notifiedSessions` is `Map<role, Map<sessionKey, stepIndex>>`, so when the
   resolved step changes mid-session the notice fires *again* naming the new depth — one notice per
   resolved step per session. Never-throws: any stream parse anomaly degrades to passthrough; the
   worst case is a missing notice, never a broken stream. Zero bytes on non-failover traffic. Tests:
   `handlers/shared/failover-stream-notice.test.ts`.

3. **Recovery** (`buildFailoverNotice` / `buildStreamRecoveryText`, same two channels). When a role
   returns to nominal, a symmetric notice fires. Detection is the auto-arm TTL probe (no background
   timer): when the 10-min TTL expires, the next request probes nominal; on success,
   `onNominalSuccess` seeds a `recovering` state (`RECOVERY_CONDENSATIONS=3`) carrying the step it WAS
   serving. Re-arming a role clears stale recovery — we are back in failover, and a stale recovery
   notice would mislead. Config-arms do not self-probe, so their recovery is the operator lifting them.

The three compose: one stream notice at the moment of failover (per resolved step), then one at each
condensation for the rest of the window, then recovery notices when nominal returns.

### ⚠ Open defect — the recovery notice reads as a prompt injection

On recovery from a `degraded` step, `failover.ts` emits, under the header
`**[claudish] Nominal model restored.**`, in content block 0:

> The context you inherit was built under a weaker model (LABEL) — recalibrate upward: resume your
> normal capability and risk appetite, and clean up any over-conservative decisions made under the
> substitute.

On **2026-08-23** a fleet agent reported this as a suspected prompt injection in its own invocation
context, and was right to: nothing in the frame lets a recipient distinguish "my proxy is talking to
me" from "someone wrote this into my context". The `[claudish]` prefix is a naming convention, not
evidence. Two specific problems:

- **"risk appetite"** names a *safety* posture, while the intent is *capability* calibration. An agent
  applying security rules must treat "resume your normal risk appetite" as suspect — and should.
- **"clean up any over-conservative decisions"** asks the agent to **undo** decisions already taken.
  That is the phrasing closest to an actual injection.

Direction for the fix: keep the notice **factual** (which role, which model, which direction), express
capability or working scope rather than risk posture, and never instruct an agent to reverse prior
decisions.

## `CLAUDISH_GLM_THINKING` measurements

Probed 2026-08-20 against the `gc@` Coding Plan (`glm-5.3`, prompt "Reponds exactement: ok",
`max_tokens: 500`):

| `thinking` sent | HTTP | output tokens | reasoning chars |
|---|---|---|---|
| absent | 200 | 37 | 131 — **GLM thinks by default** |
| `{"type":"enabled"}` | 200 | 41 | 148 |
| `{"type":"disabled"}` | 200 | **3** | **0** — the switch works |
| enabled plus `budget_tokens` | 200 | 35 | tolerated, **ignored** |

History this encodes: `GLMModelDialect` used to delete `thinking` unconditionally (a GLM-4.x-era
artifact), and the OpenAI `buildPayload` never emitted the field either. Net effect: GLM silently
thought by default on **every** request, the client's ask was meaningless, and no lever existed to
stop it while the Coding Plan's 5h window burned. `passthrough` preserves the effective historical
behavior; the `zai@` anthropic wire is unprobed, so only an explicit `disabled` sets the field there
(mirroring Qwen's anthropic-wire bet).
