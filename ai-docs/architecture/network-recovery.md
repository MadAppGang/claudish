> Two-tier connection recovery: the in-request retry ladder, the banner drawn with magmux's own
> `overlay`, and the 503 handoff that lets Claude Code's own retry loop carry an outage the socket
> cannot.
>
> Indexed in [`README.md`](./README.md). Status-code neighbours: [`adapters.md`](adapters.md).

# Network recovery — why "retry forever" is two tiers and not one loop

A transport-unreachable failure used to end a turn. `classifyConnectionError` returned non-null,
`respondConnectionError` answered `400 connection_error`, and the transcript carried a dead turn the
user had to retype. VPN flaps, a Tailscale MagicDNS outage, a stopped `ollama serve`, a laptop lid
closing between two tool calls — all of them, terminal.

The fix is **not** an unbounded retry loop, and this document exists mostly to record *why not*,
because the reasons are measurements that the source cannot show you.

---

## 1. The client's clock is the real constraint, and it is a KNOB

The obvious design is to hold the inbound request open and retry until the network returns. Phase 0
measured what actually happens when you do.

**Claude Code aborts the connection at 359.607 s** — reproduced at 359.4 / 360.1 / 360.1 across two
processes, against a custom `ANTHROPIC_BASE_URL`. The important part is what that number *is*:

> It is **not** a fixed watchdog. It is `API_TIMEOUT_MS`'s default of 360 000 ms. Setting
> `API_TIMEOUT_MS=20000` produced six aborts at **exactly 20.000 s**.

That single fact decides the shape of the feature twice.

1. **A hold has a hard ceiling.** Whatever we do, the socket dies at the client's timeout. "Retry
   forever inside one request" is not implementable — not as a trade-off, as an impossibility.
2. **The deadline must be DERIVED, never written down.** A user with `API_TIMEOUT_MS=60000` gets a
   client that gives up at 60 s. A hardcoded 270 s deadline means *every* episode on that machine
   ends in `client_gone` and recovery never engages — silently, and only on their machine. So:

```
TIER1_DEADLINE_MS = max(FLOOR, min(API_TIMEOUT_MS ?? 360_000, 300_000) − 30_000)
```

`recovery/settings.ts` owns that computation and logs a `[Recovery]` line whenever the environment
shortens the budget, so a short hold is visible rather than mysterious. This is CLAUDE.md's
*"a default is a rule, never a pinned id"* arriving in the time domain.

The other two ceilings the derivation clears:

| ceiling | value | where |
|---|---|---|
| Bun's per-request idle timeout | 255 s | `proxy-server.ts`'s `idleTimeout` |
| attempt 1 | the remaining budget | `deadlineClamp`, armed before the primary fetch |

### The deadline is only a deadline if attempt 1 is inside it — and twice it was not

Both halves of this were found by a black-box contract test, and neither is visible to a suite built
on refused loopback ports, because a 1 ms attempt cannot cross a deadline in the middle of itself.

**The zero point was set by the first READER, not by the request.** `inboundStartedAtPerf` memoises
on `c.req.raw`, and on the fetch path the first caller was `tier1DeadlineAt(c)` *inside the catch* —
after attempt 1 had already failed. Measured against the unrouted `192.0.2.1` with
`API_TIMEOUT_MS=60000` (a 30 s budget): attempt 1 spent macOS's 75 s connect timeout, the budget then
started counting from t+75 s, and **the client was answered at 108 s**. The budget had not been
exceeded — it had never been applied. `handle()` now stamps the zero point on entry.

**Attempt 1 had no ceiling at all.** `DEADLINE_MARGIN_MS`'s 30 s was supposed to reserve room for its
tail; the OS's connect timeout is 75 s, so the reserve is wrong by 45 s for a slow connect and wrong
by more than the whole budget whenever `API_TIMEOUT_MS ≤ 105 s`. It is now bounded by `deadlineAt` —
and by `deadlineAt` specifically, **not** by `PER_ATTEMPT_CONNECT_CAP_MS`:

- 45 s is a plausible time-to-first-byte for a thinking model behind a long prompt, and this ceiling
  sits on a possibly-HEALTHY call. Clamping it at 45 s would re-open RISK-6's first leak — a latency
  event reclassified as "the host is unreachable". At the default settings the ceiling is 270 s,
  which no provider's first byte approaches, and it shortens only as the user's own knob does;
- firing AT the deadline is what makes it safe: there is by construction no budget left when the
  abort is classified, so `shouldSkipTier1`'s `no-budget` gate fires and the request answers. **This
  ceiling can never cause a re-issue.** An earlier firing time would not have that property.

Bun's 255 s stops binding because `c.env.timeout(c.req.raw, 0)` **works** — measured, a request
given `0` survived **6×** its `idleTimeout` where the un-disarmed control died at 1.6×. That call is
made inside the `catch`, never on a healthy request.

### Claude Code's retry budget is a COUNT, not a duration

The second tier hands the retry back to the client. What the client will then spend is:

- **~11 attempts** on its default budget, spanning **~174 s** for a 503 chain (backoff caps at
  38.4 s per gap, and `retry-after` is honoured verbatim);
- **~300 attempts** with `CLAUDE_CODE_RETRY_WATCHDOG=1`, which claudish sets only when recovery is
  enabled, the UI is allowed, AND this launch runs inside a magmux it can draw a banner on —
  reaching **~a day** of
  unattended recovery on a hung connection. All three gates, because the watchdog amplifies EVERY
  503 the session sees and is worth its cost only where a surface can exist (§7).

It is a count, not a clock. That is why `EPISODE_GRACE_MS` is 120 s: the client's worst gap is
38.4 s, so 120 s is 3.1× inside it and a returning client always finds its episode still open.

**The watchdog is a deliberate, informed acceptance of RISK-6** — see §7.

---

## 2. The two tiers, and the episode that makes them one thing

```
POST /v1/messages ──► ComposedHandler.handle()   startTime = performance.now()
                        attempt 1 = today's expression, BYTE-IDENTICAL ──► success
                          │ throws
                          ▼
                      classifyConnectionError()  ── null ──► rethrow, unchanged
                          │ non-null
                          ▼
                      shouldSkipTier1()?  probe header · recovery disabled ·
                                          no budget left
                          │ no
      ┌───────────────────▼──────────────────────────────────────────┐
      │ TIER 1 — in-request, PRE-FLUSH, deadline derived from §1      │
      │   joinEpisode(key)   ONE episode per target, N waiters        │
      │   5 → 10 → 30 → 60 → 60 … on a SHARED clock                   │
      │   re-issue THROUGH provider.enqueueRequest, re-classified     │
      │   success ─► return the upstream Response ────────────────────┼──►
      └───────────────────┬──────────────────────────────────────────┘
                          │ deadline reached
      ┌───────────────────▼──────────────────────────────────────────┐
      │ TIER 2 — hand the retry back                                  │
      │   uiLeaseValid(episodeId) ? 503 overloaded_error              │
      │                             + x-should-retry: true            │
      │                             + x-claudish-recovery: 1          │
      │                           : 400 connection_error  (as before) │
      │   the episode stays OPEN for EPISODE_GRACE_MS                 │
      └───────────────────┬──────────────────────────────────────────┘
                          │ Claude Code's own retry re-POSTs and JOINS
                          │ the same episode — one continuous banner
```

**The episode is what makes two tiers read as one recovery.** It is a process-level singleton keyed
by `${provider}|${host}`. A handoff leaves it open; the client's re-issued request finds it,
increments `clientRetries`, and continues the *same* attempt counter, ladder position and banner —
while getting a *fresh per-request deadline*, because the deadline belongs to the socket and the
socket is new.

Three lifetimes, and none of them is the state machine. Conflating them was the largest defect of
the superseded design:

| lifetime | scope | owner | ends when |
|---|---|---|---|
| the **deadline** | one inbound request | the waiter | its own `deadlineAt` passes — *that waiter alone* answers and leaves |
| the **ladder** | one episode (`key`) | the coordinator | the last waiter leaves, or an attempt succeeds |
| the **lease** | one episode | the banner (`magmux-ui.ts`) | `UI_LEASE_MS` after magmux last acknowledged an overlay write painting that episode |

When one waiter's deadline moved the *shared* episode into `handoff` — a state with no timer — every
other parked waiter silently stopped being retried and answered having attempted nothing. The
visible symptom was a banner reading `waiters: 4` with one of them actually being retried.

### The measured ladder

Real clock, real refused loopback socket, through `ComposedHandler.handle()`:

| attempt | fires at | gap |
|---|---|---|
| 1 | t+0 | — |
| 2 | t+5.002 s | 5002 ms |
| 3 | t+15.004 s | 10002 ms |
| 4 | t+45.009 s | 30005 ms |
| 5 | t+105.010 s | 60001 ms |
| 6 | t+165.011 s | 60001 ms |
| 7 | t+225.012 s | 60001 ms |
| — | handoff at t+225.018 s, deadline 270 s | |

18 ms of drift over 225 seconds. **The last array element repeats and the DEADLINE ends the
schedule** — which inverts `STREAM_RETRY_DELAYS_MS`, where the array running out *is* the budget.
The two schedules are deliberately separate: merging them would couple the sniffer's 12 s budget and
a duration quoted verbatim in a user-facing message to this one.

On a tier-2 rejoin the ladder does **not** reset. The target has been down for the whole of it, and
restarting at 5 s would hammer a dead host harder the longer the outage lasted.

### …but a carried rung may be TRUNCATED once, or the re-ask retries nothing

The ladder index belongs to the **episode**; the deadline belongs to the **socket**, and a re-ask
gets a fresh — possibly much shorter — one. Once the carried rung outgrew that deadline, the
no-budget gate fired on the first iteration and the request answered **in 8 ms having re-issued
nothing**. Measured at the upstream socket with `API_TIMEOUT_MS=60000`:

| `API_TIMEOUT_MS` | deadline | request 1 | request 2 (before) | request 2 (now) |
|---|---|---|---|---|
| 120 000 | 90 s | 0/5/15/45 s | 0/60 s | unchanged |
| 60 000 | 30 s | 0/5/15 s | **one attempt, 8 ms** | 0/27 s |
| 40 000 | 10 s | 0/5 s | 0/10 s | unchanged |

And it was permanent: with no banner the answer is a 400, which Claude Code does not re-ask, so
recovery was over for that endpoint for the rest of the outage. Invisible at the 270 s default, where
the terminal 60 s rung always fits — it bites every `API_TIMEOUT_MS ≤ 90 s`, a value
`docs/advanced/environment.md` invites.

So a waiter that has **not yet re-issued anything** shortens the wait to the budget it actually has
(floor `MIN_ATTEMPT_SLOT_MS`), makes its one attempt, and only then hands off. The condition is
`requestRetries === 0`, which is why request 1's shape above is untouched: by the time ITS rung stops
fitting it has re-issued two or three times already. It is not a hammer — at most one truncated rung
per request, and the gap between two client re-asks is the client's own backoff (up to 38.4 s), not
ours.

### Four places watch the client's abort, and a mutation that survived does not make them redundant

Disabling all three abort paths in `transient-retry.ts` — the loop-top check, `untilAborted`, and
`mergeSignalIntoInit`'s threading — left client-disconnect handling working. The surviving path is
`coordinator.ts`'s `waitForNextAttempt`, which registers its own listener on the same signal; against
a refused loopback port the ladder spends ~100% of its wall clock parked in that wait, so the wait
answered. Each covers a window no other one does, and a slow connect inverts the arithmetic (45 s of
attempt to 5 s of wait):

| # | site | the window only it covers |
|---|---|---|
| 1 | the loop's `if (ctx.signal.aborted)` | between an attempt settling and the next wait starting; and the first iteration, before any wait exists |
| 2 | `coordinator.waitForNextAttempt` | during the wait — and it is the only one that can DETACH the waiter from the shared episode timer |
| 3 | `untilAborted` | during an attempt whose operation cannot take a signal at all: `refreshAuth()`/`getHeaders()` accept no arguments, so on the auth path this is the only unwind there is |
| 4 | `mergeSignalIntoInit` | inside `fetch`, so the SOCKET closes. The other three unwind the waiter and leave the connect running |

### `PER_ATTEMPT_CONNECT_CAP_MS` is 45 s because 75 s collides with the OS

macOS gives up on its own TCP connect at **75.004 s** (measured against the unrouted `192.0.2.1`; a
refused loopback port is 5 ms). A 75 000 ms clamp races the operating system by **4 ms** and is
decided differently on different runs, which makes every assertion keyed on "the attempt ended at
the clamp" flaky by construction. 45 s clears the collision by 30 seconds and always wins.

**Slow and fast connect failures are indistinguishable BY CODE on macOS.** `192.0.2.1:443` reports
`ECONNREFUSED` / `ConnectionRefused` — the same code a loopback port refuses instantly with. Only
elapsed time separates them, so nothing may branch on the code to tell them apart. `isLoopback(endpoint)`
is the only honest discriminator, and it reads the address, not the error.

---

## 3. The status table — and why 503 and not 429

| condition | status | headers | why |
|---|---|---|---|
| recovered inside tier 1 | the upstream's own | — | the caller carries on as if the first attempt had worked |
| exhausted, **a lease is valid** | **503** `overloaded_error` | `x-should-retry: true`, `x-claudish-recovery: 1` | the reason is legible on the banner, so the retry may be handed back |
| exhausted, **no lease** | **400** `connection_error` | — | nothing can display the reason, so it must ride the status |
| client disconnected (Esc in Claude Code) | 499 (unread) | — | the socket is already gone |
| unclassifiable throw on any attempt | rethrown unchanged | — | recovery must not widen what "transient" means |

### There are no keys, and that is a trade

The first banner was a pane of claudish's own, with `[r] try now` and `[q] give up`. Closing that
pane wedged Claude Code's renderer (§4), so the banner became magmux's `overlay`, which magmux draws
itself and which therefore cannot read a keystroke. Both keys went with it, and so did the code only
they reached: the coordinator's `tryNow` and `giveUpAll`, and a process-level "the user gave up"
fact that `shouldSkipTier1` read as a skip reason.

What is left is enough. The ladder retries on its own, so `[r]` only ever collapsed a wait. Esc in
Claude Code aborts the held request, which the handler already treats as a client disconnect — the
waiter leaves and, if it was the last, the episode closes. What Esc does NOT do is what `[q]` did:
suppress the hold for the NEXT request. That request holds again, with the banner explaining why.
Status-line control and key forwarding are requested of magmux in its
`ai-docs/feature-request-status-line.md`; if that lands, the keys can come back.

### 429 would have been a live billing bug

`fallback-handler.ts` contains, verbatim:

```ts
// Rate limited — per-provider limit, a different provider may have capacity
if (status === 429) return true;
```

A 429 from the exhausted network path makes `FallbackHandler` **advance to the next provider**.
During a network outage the next provider is unreachable for the same reason, so the chain burns
every candidate — each paying its own multi-minute budget — and per CLAUDE.md's standing invariant,
an advance off a `SUBSCRIPTION_PROVIDERS` candidate onto a metered one quotes real money for a fault
no provider caused.

503 was chosen because, at the time, `isRetryableError` had **no 503 branch**. Since 2026-09-24 it
has one: an upstream 502/503/504 advances a bare-name chain (`adapters.md`, "An unavailable endpoint
advances the chain"). The recovery 503 is unaffected, because the status was never its guarantee:
the `x-claudish-recovery` marker below is checked before any status is read.

529 was considered and rejected: it is absent from `exhaustedChainStatus`'s transient set and would
add a status this codebase has never carried, re-opening every `status ===` under `handlers/`.

### Chain-safety is STRUCTURAL, not wording-based — and ORDER is the property

A 503 stopping the chain is not enough, twice over:

- **`isRetryableError`'s FIRST statement is `hasQuotaExhaustionWording(errorBody)`**, deliberately
  status-agnostic (it exists *because* of the 400 remap), and its phrase list contains the **bare
  substring `"quota"`**. A 503 whose *message* happened to carry that word advanced the chain and
  spent the user's money.
- **`exhaustedChainStatus` could demote it.** With an earlier candidate already failed, a
  non-retryable response goes to `formatCombinedError`, whose status is 503 only if *every*
  accumulated error is transient. One earlier auth or 404 failure turns our 503 into a terminal 400
  and the client never re-POSTs.

So the marker is a **header**, `x-claudish-recovery: 1`, checked in two independent places:
`handle()` returns a marked response VERBATIM before reading the body (defeating the combining), and
`isRetryableError` returns `false` on it **above** the quota match (defeating the wording).

### One marker was not enough: it was minted on the 503 arm ONLY

Which made chain-safety a property of **which arm answered**. Exhaustion answers 400 whenever no
banner is attached — `-p`, `--no-recovery`, CI, any machine without magmux, i.e. *every headless
run* — and that 400 carried no marker at all, so the wording check decided again. A black-box test
reproduced it from outside: candidate 1 unreachable at a host named `quota-exceeded-…`, and
**candidate 2's own socket served the client**. `insufficient-credits` and `rate-limit` in the same
position did not reproduce it, so the variable really was the word — and the error text quotes the
endpoint host and full URL, so the word is user-influenced.

The 400 arm now carries its own marker, `x-claudish-connection-error: 1`, and `isRetryableError`
asks one predicate — `isClaudishConnectionVerdict` — that is true of either. The invariant is
stated in terms of the request rather than of the response:

> **A connection-failure response from this feature never advances the fallback chain — regardless
> of its status, its message, or whether a banner was attached.**

It is deliberately a SECOND header rather than the same one on both arms, because the two facts
differ and one is load-bearing elsewhere: `x-claudish-recovery` means "the retry was handed back",
and `FallbackHandler` returns anything wearing it **verbatim** so `formatCombinedError` cannot demote
its 503. A 400 has nothing handed back and must stay foldable into the combined chain error, which is
where the user reads what every candidate did. Round 1's quota mutation tested the 503 path and
passed; nobody tested the 400 path.

> **Moving the marker check below the quota match — present, but LATE — is a live billing bug.**
> It is mutation-covered as one, and the mutation that kills it is the quota-wording variant
> specifically. A test whose 503 body says nothing about quota cannot see the defect at all.

The marker cannot be forged: every non-ok exit from `ComposedHandler` is `c.json(...)`, which builds
headers from nothing, and the only path that copies upstream headers verbatim
(`stream-head-sniffer.ts`'s `replayResponse()`) runs after `!response.ok` has already returned.
**If a future edit ever returns an upstream `Response` object on a non-ok path, the marker must be
stripped there.**

---

## 4. The banner and its lease

The generalisable rule the two exhaustion arms encode:

> **A retryable status is permissible exactly when claudish still has a surface on which the reason
> is legible.** Absent such a surface, the reason must ride the status, which means 400.

### The banner is magmux's `overlay`, because a pane of our own wedged Claude Code

The first banner was a pane: `open_pane` split Claude Code's pane at the start of an outage and
`close_pane` removed it after. Opening a stacked pane shrinks Claude Code; closing it grows Claude
Code back — and Claude Code 2.1.272 does not survive the grow. Six rows of its bottom chrome collapse
onto one line and the input box is destroyed, and nothing done from outside repairs it: Escape, a
keystroke, `Ctrl-L`, `SIGWINCH` at the same size, and a full shrink-then-grow cycle were each
measured and each failed. magmux is not at fault — the survivor's pty is resized to exactly the full
terminal — and the reflow is the trigger. It shipped through eight phases of validation because every
capture was taken while the pane was still open
(`reports/network-recovery-pane-close-wedges-host-tui-20260915.md`).

`overlay` draws a styled box OVER a pane and changes no layout, so there is no reflow to survive.
Measured on the replacement, in a 214×29 pane: Claude Code's `❯` composer sat on row 26 during the
outage, under the recovered banner, and after the overlay cleared, and typed text landed in it
(`reports/network-recovery-overlay-validation/`). It also retired a pane process, an NDJSON socket,
a wire protocol and a cross-process lock, because magmux is the renderer now — and in a
`team --grid`, every claudish draws on its own pane instead of one slot winning the only banner.

magmux's status bar stays hidden (`--no-status`). A controller cannot show it on demand over the
socket — only the `Ctrl-G s` key can — which is what claudish's request to magmux asks to change.

### The lease, for a renderer claudish does not own

The gate is not a boolean and not a latch. A latch set once and never cleared stays true after a dead
magmux and after a socket EOF, and the exhaustion arm then answers 503 with the reason visible
nowhere, *which is strictly worse than the bug this feature exists to remove*. It is a **lease**:

```
uiLeaseValid(episodeId)
  ⇔ claudish holds a magmux control connection and knows its pane
  ∧ magmux ACKNOWLEDGED an overlay write painting THIS episode within UI_LEASE_MS
```

*Painting this episode* makes it episode-scoped, so two concurrent episodes cannot borrow one
banner's legitimacy. *Acknowledged*, not *sent*: magmux replies only to a message that carries an
`id`, and a reply means it accepted the text for a pane it is drawing. *Within `UI_LEASE_MS`* makes
it self-clearing when magmux dies or stops answering, with no cleanup path to forget. A closed control
socket drops every lease at once.

**The renewal must not depend on the ladder — this is the single most consequential property here,
and a superseded design had it wrong.** Frames were once emitted only while the episode was
`waiting`, with no tick during `attempting`. A real `unreachable` connect takes 20–75 s (`192.0.2.1`
measured at **75 005 ms**), 2×–7.5× `UI_LEASE_MS`, so the lease expired *while the banner was alive
and painted*, and the exhaustion arm answered 400 for exactly the failure class that motivated the
feature. The banner therefore redraws on its own `FRAME_TICK_MS` (1 s) timer in every live state, and
each acknowledged write renews the lease. **Every loopback-only test passed over the original bug**: a
refused loopback connect resolves in ~1 ms, so the ladder is all `waiting` and frames never stopped.

**The overlay is re-asserted every tick, never written once.** magmux writes the same overlay from
its own Claude Code state tracker — `CtrlError` paints `✗ …` over whatever is there
(`magmux/mux/mux.go`) — so a banner written once can be replaced mid-outage. The countdown needs a
write per second anyway, and that write restores ours within a second.

**The residual forbidden window is exactly `UI_LEASE_MS` wide, and that is a property of a lease
rather than a gap in it.** If magmux dies just after acknowledging a write, the lease reads valid for
up to 10 s with nothing on screen, and an exhaustion in that window answers 503. The cost is bounded
and self-repairing — the client re-asks, finds no lease, and that request answers 400 — which is why
10 s is affordable. Anyone tightening the window should move `UI_LEASE_MS`, not add a second liveness
test beside it, and must keep `FRAME_TICK_MS` well under whatever they choose.

No transition in the episode's table touches the lease, and the lease never causes a transition. The
retry loop is not the banner's business, and the banner's liveness is not the deadline's business.

---

## 5. A connection failure can wear an AUTH status code — at five separate sites

This is the half of the work that shipped on its own merits and would have been worth doing with no
recovery ladder at all.

`fallback-handler.ts` reads **401 as retryable**. So a network outage during a token refresh did not
fail the request — it **advanced the chain**, moving a subscription user onto a per-token candidate
mid-outage, for a fault that had nothing to do with their credentials. Reproduced:

```
[Fallback] Sakana Fugu failed (HTTP 401), trying next provider...
[Fallback] Metered Fallback succeeded after 1 failed attempt(s)
```

An *unclassified throw* leaving `handle()` is the same bug one layer out: it lands in
`fallback-handler.ts`'s catch, which pushes `{ status: 0 }` and advances **unconditionally** —
without even the per-token cost warning, which sits on the non-throwing branch. On a single-candidate
route no `FallbackHandler` exists, so it lands in `proxy-server.ts` as a bare 500 instead.

The inventory — every outbound call in `ComposedHandler` that can throw without a `Response`:

| # | site | before | after |
|---|---|---|---|
| 1 | `refreshAuth()` catch | classified **never** — unconditional **401** | classify FIRST, before `err.terminal` |
| 2 | `forceRefreshAuth()` catch (wraps the 401-retry `fetch` too) | classified **never** — unconditional **401** | classify FIRST |
| 3 | parameter-recovery re-fetch | **no `try` at all** — escaped `handle()` → `{status: 0}` + advance | wrapped; classified → 400, unclassified → rethrown |
| 4 | `getHeaders()` | **outside every `try`** — escaped `handle()`, or a bare 500 | wrapped; classified → 400, unclassified → rethrown |
| 5 | primary `fetch` / `enqueueRequest` | already classified — the control | unchanged, refactored onto the shared helper |

**Site 4 is worth a paragraph.** `getHeaders()` looks like a pure accessor and is not one. For `gk@`
it is the request's *first* network touch: `grok-subscription.ts` → `grok-credential.ts` →
`resolveGrokAccessToken()` → `fetch(auth.x.ai/oauth2/token)`. The touch is **refresh-conditional**,
which makes the escape rare — not safe. Rarity is what kept it alive through three reviews.

The rule all five now obey: **classify first, or rethrow unchanged; none may invent a status.** There
is exactly one way to answer "claudish could not reach the host" — `respondConnectionError()` — and
it answers 400 `connection_error`, never 401 and never a bare 500.

Local transports needed evidence preservation before any of this could reach them: `local.ts` used
to swallow its connect error in `catch (e: any) { log(…) }` and throw a bare
`Error("Cannot connect to Ollama at …")`. `findConnectionCode` found no `.code`, no `.cause` and no
message match, so `classifyConnectionError` returned **null** and a stopped Ollama — the single most
common local failure — never reached tier 1 at all. Same class of fix in `vertex-oauth.ts`
(discarded `code`), `openai.ts` (neither `code` nor `cause` on its error classes) and
`antigravity.ts` (the banner must name the *auth* host, not the eventual inference endpoint).

`healthChecked` latches on **success only**, so a retried `refreshAuth()` re-probes instead of
returning a false success to attempt two.

### Three things the auth path needs that the fetch path gets for free

- **The clamp has to be ENFORCED, not handed over.** `op` takes the per-attempt signal, and the fetch
  path threads it into `fetch`. `refreshAuth()` and `getHeaders()` take no arguments, so
  `() => this.provider.refreshAuth!()` discards it — and Grok's token exchange then performs an
  unbounded `fetch(auth.x.ai/oauth2/token)`. A swallowed connection there outlived both the 45 s cap
  and the client's own disconnect while `withConnectionRetry` awaited a promise nothing could settle:
  the unbounded hold this feature exists to remove, reached from inside the machinery that removes
  it. `untilAborted` now enforces the ceiling at the one place that owns it. The operation is
  *abandoned*, not cancelled — threading a real signal through every transport's auth call is the
  deeper fix and is still worth doing.

  **Abandoning is only bounded if the operation is.** Grok and Codex refresh behind a single-flight
  latch (both servers ROTATE the refresh token, so two concurrent refreshes produce `invalid_grant`).
  With no ceiling on the refresh `fetch`, a half-open socket held the latch until the kernel's
  retransmit timeout — minutes — and every attempt `untilAborted` abandoned was followed by one that
  re-entered the latch and joined the same dead promise: attempts in the banner and the log that
  never reached the network. Both refreshes now carry `TOKEN_REFRESH_TIMEOUT_MS` (20 s), BELOW the
  45 s per-attempt cap, so a hung refresh fails inside its own attempt and the latch clears; the
  latch itself stays. Its `TimeoutError` is tagged `markOwnTimeout`, because a token host that does
  not answer in 20 s is a reachability fact — measured: untagged it classifies `null`, tagged it
  classifies `unreachable`, and for Codex `null` would mean the metered fallback. Antigravity's
  refresh already ran under a 12 s subprocess timeout.

  **The reserve that buys this cost the auth path its whole budget below `API_TIMEOUT_MS = 75 s`,
  silently — fixed.** The auth catches use `refreshDeadlineAt(tier1DeadlineAt(c))`, which reserved a
  flat 45 s against a deadline of `max(15 s, min(API_TIMEOUT_MS, 300 s) − 30 s)` — so at 60 000 the
  auth deadline was −15 s, `shouldSkipTier1` answered `no-budget` before attempt 1, and a failed token
  exchange got the immediate 400 while the FETCH path on the same machine still recovered (measured:
  `[Recovery] skipped (no-budget) … site=refreshAuth` at t+0). The reserve is now capped at half the
  budget: unchanged at the default (45 s), 22.5 s of auth budget at 75 000 where there was none. What
  the reserve still buys is the primary fetch's right to a real attempt after a slow refresh — the
  request ceiling (`deadlineClamp`) already stops that fetch outliving the deadline on its own.
- **The error must name the host that actually failed.** `connectionEndpointFor` falls back to the
  MODEL endpoint when the error carries no `claudishEndpoint`, so an `auth.x.ai` outage was reported
  — in the banner, in the log and in the episode key — as `api.x.ai`. Grok's and Codex's refresh
  wrappers now attach it, as `local.ts` already did.
- **A transport can swallow the failure before any of the five sites sees it.** `openai-codex.ts`'s
  `refreshAuth` caught EVERY throw from the credential authority and fell through to the api-key
  path — the METERED `api.openai.com`. That fallback is meant for a REJECTED refresh; a refresh that
  merely could not reach `auth.openai.com` took it too, billing a subscriber per token for an outage.
  It now rethrows a classified connection failure, so the `refreshAuth` site holds it like any other.
  The credential's own error said "OAuth credentials invalid. Please run `claudish login codex`
  again" for a network failure; it now says "Could not reach …", with `{ cause }`. When auditing a
  new transport, look for a `catch` in `refreshAuth`/`getHeaders` that returns normally.
- **`noteTargetReachable` closes by PROVIDER, not by host.** Because an auth episode can be keyed on
  a different host than the one a later success reaches, a strict key lookup missed it and the banner
  painted "waiting for Claude Code to retry" over a working session for the full 120 s grace. A
  request that reached the model endpoint had to authenticate first, so it has proved every host it
  touched is answering — and a `handoff` episode holds no waiters, so nothing is closed from under
  anyone.

---

## 6. Stats — and the one step whose omission is silent

Five optional fields on `StatsEvent`, absent on every healthy request:

| field | scope | what it answers |
|---|---|---|
| `retry_attempts` | **request** | how many times *this request* re-issued against the same provider. Not `fallback_attempts`, which counts different providers |
| `recovery_ms` | **request** | how much of this record's `latency_ms` was backoff and failed connects |
| `recovery_episode_id` | episode | the correlation key — `count(distinct …)` is the only honest answer to "how often" |
| `recovery_client_retry` | episode | which tier-2 re-entry this request is; 0 = the original |
| `recovery_outcome` | episode | `recovered` / `handoff` / `client_gone` / `gave_up` |

**`latency_ms` continues to INCLUDE the waits**, per the standing decision in `adapters.md` ("the
honest figure is time-to-usable-response"). `recovery_ms` exists so the resulting skew is explicable
rather than mysterious: `latency_ms: 246_000, recovery_ms: 201_900` reads as a 44-second turn behind
a three-and-a-half-minute outage. Without the second field, the same record reads as a four-minute
model.

**Why two scopes.** The episode's cumulative counters cannot stand in for the per-request ones: N
concurrent requests share one episode, so each would report the sum of all of them, and a tier-2
re-entry inherits counters from a request that already recorded its own. Summing `retry_attempts`
across an outage would multiply it by the number of waiters and again by the number of re-entries.
The episode-scoped figures are what the *banner* quotes, because the banner is about the outage.

**The cardinality rule.** `stats-otlp.ts` says verbatim "one per LLM request". A request that hits
both an auth-path episode and a fetch-path episode carries the id of the episode that **decided its
status** — the later one. An auth episode that *recovered* emits no record of its own: its attempts
fold into the same request's `retry_attempts` and its waits into the same `recovery_ms`. The
coordinator emits **no lifecycle records at all**; a `grace_expired` event with no request behind it
would be a phantom distorting request counts, success rate and latency percentiles in the very
stream that is supposed to answer the question. Episode lifecycle is a `[Recovery]` structural log
line instead.

### `[Recovery]` is OUTPUT, not a debug aid — and for a while it was neither

The lifecycle lines were on `log()`, which writes to two FILES: the `--debug` log and the always-on
structural log under `~/.claudish/logs/`. That satisfies "it is written down" and fails the thing it
was written down for. A hold runs for up to the derived deadline (~4.5 minutes at the default) and in
a run with no banner — which is *every headless run* — the user saw nothing at all while it did. A
silent multi-minute hold with the reason legible nowhere is the state §3 calls "strictly worse than
the bug this feature exists to remove"; a file the user does not know to open is not a surface.

They now go through `logRecovery()` → `logStderr`, which is why the noise objection does not bite:
in an interactive session `logStderr` routes to `DiagOutput` (a file) rather than to the client's
TUI, and in quiet mode it is suppressed — so the lines land on a terminal exactly where a terminal is
the only surface there is. Both log files still receive them.

The line is drawn at the **episode's lifecycle** — opened, rejoined, each attempt, each wait, handed
off, closed, recovered, exhausted: the six-to-ten lines from which a reader can reconstruct the
ladder. The banner's magmux connection and pane lookup, a skipped ladder and `client_gone` stay on
`log()`.

### The trap: `eventToLogRecord` is a hand-written allowlist

A field added to the `StatsEvent` interface and populated by `stats.ts` but **not pushed in
`eventToLogRecord`** is typed, type-checked, buffered, and written to
`~/.claudish/stats-buffer.json` — and never leaves the machine. Nothing throws. The number is simply
absent from every dashboard built to read it, and the loss surfaces a quarter later when someone
asks a question the data cannot answer.

The guard is in `stats-otlp.test.ts` and has two layers:

1. `satisfies Record<OptionalStatsKey, …>` makes its table **exhaustive over `StatsEvent`'s optional
   fields at COMPILE TIME**. Add an optional field to the interface and the test file stops
   compiling until it is listed.
2. The table then drives emit-when-set and omit-when-unset per field, so listing a field without
   pushing it is red.

Layer 1 is the load-bearing one — it is what stops this being a checklist someone has to remember to
read. Both directions are mutation-proven: deleting the `recovery_episode_id` push, and swapping one
`!== undefined` for a truthiness check (which drops `retry_attempts: 0`, the record that says "an
episode existed and this request added nothing to it").

`retryAttempted` on the error report is now **derived**, not hand-set. It had been a literal `false`
on the connection path since before the ladder existed, so every recovered-then-failed outage was
reported as a first-and-only attempt.

---

## 7. Risks accepted, explicitly

**RISK-6 — duplicate charges on a re-issue.** A retry after `ECONNRESET`/`EPIPE` may re-run
inference the provider already started billing. The user accepted this at the scale of our own
ladder, and then accepted it again, with the arithmetic in front of them, at the watchdog's scale:

| | watchdog dropped | **watchdog restored (chosen)** |
|---|---|---|
| client retry budget | ~11 attempts | ~300 attempts |
| unattended reach, hung connection | ~66 min | **~a day** |
| worst-case retry attempts per turn | ~46 | **~2,100** |
| RISK-6 exposure | as originally accepted | **≈30× that** |

`recovery_episode_id` is what makes the exposure *attributable* — without it, attribution breaks
exactly across a tier-2 handoff, which is the highest-exposure path.

**What RISK-6 does NOT extend to, and the two ways it leaked past its own boundary.** Both were
found in review and closed; both are the same mistake — applying the accepted arithmetic to a case
the user was never shown.

1. **A LATENCY event is not a network fault.** `classifyConnectionError` mapped the NAME
   `TimeoutError` to `unreachable`. That name is also what `AbortSignal.timeout` on a transport's own
   *inference* request rejects with — `vertex-oauth.ts` puts a 30 s ceiling on the model call itself.
   A `vx@` turn whose time-to-first-byte exceeded 30 s (ordinary for a thinking model) was therefore
   classified as "the host is unreachable", entered the ladder, took the tier-2 handoff, and was
   re-POSTed ~300 times — **each one running one more real billed inference against a host that had
   answered the TCP connect and was already generating.** The discriminator is now the SIGNAL'S
   ORIGIN, not the name: our per-attempt clamp and our reachability probes carry a `markOwnTimeout`
   own-property and classify; everything else keeps its pre-recovery route out, unclassified and
   rethrown. The user-facing sentence was wrong too — it told the user to check VPN and DNS for a
   host that was mid-generation.
2. **The watchdog needs three gates, not one.** `CLAUDE_CODE_RETRY_WATCHDOG=1` was exported from the
   UI preference alone, so `-p`, `--no-recovery`, a pipe and a machine without magmux all expanded
   every UNRELATED 503 to ~300 client attempts while being structurally incapable of holding the
   lease a recovery 503 requires. It now requires `recoverySurfaceAllowed()` — which is
   `resolveRecoveryEnabled() && resolveRecoveryUi()` — **and** `magmuxPaneCapability() !== none`,
   the last asked BEFORE the child environment is finalised, which is why that predicate is
   side-effect free and is the same one `planMagmuxWrap` consumes.

   **The first two gates were a function for the watchdog and a hand-written expression at the two
   places that decide the WRAP, and the expression was missing a term** — which is how
   `--no-recovery` shipped suppressing the watchdog correctly while still wrapping the session.
   Two statements of one rule is one too many: `recoverySurfaceAllowed()` is now the single
   predicate, read by `retryWatchdogEnv()`, by the wrap ternary and by the ambient-socket branch.
   Anything else that decides whether a launch may PAY for a surface reads it too.

**A pane child is never eligible (D22).** An MCP `team` slot or `create_session` runs claudish
inside a headless magmux pane (`pane-session.md`), so it inherits `MAGMUX_SOCK` and would have
read as `ambient`: watchdog exported, recovery UI installed, an overlay drawn on the very screen the
pane classifier reads — and nobody watching, because a headless pane has no viewer. The accepted
~300-attempt exposure was shown to the user only for a launch a person can see. So
`magmuxPaneCapability()` answers `{kind:"none", reason:"pane-child"}` when `CLAUDISH_PANE_CHILD=1`,
checked BEFORE its ambient branch, and the ambient-install branch in `claude-runner.ts` reads
`paneCapability.kind === "ambient"` instead of restating its own `MAGMUX_SOCK` test — one predicate,
per the rule above. `applyRetryWatchdog` also deletes a claudish-owned `CLAUDE_CODE_RETRY_WATCHDOG`
inherited from a wrapped parent. Tier 1's hold still runs, bounded by the derived deadline; an
exhausted episode answers an inline 400, Claude Code writes an API-error entry, and the slot or
session is FAILED `api_error`. Pinned by `recovery/settings.test.ts`.

**The transport's `getRequestInit()` is re-minted per attempt.** It was hoisted once, before the
primary fetch, and spread into every re-issue. A transport that returns a one-shot
`AbortSignal.timeout` therefore poisoned the whole ladder the moment it fired:
`AbortSignal.any([fired, live])` is ALREADY ABORTED, so every later attempt rejected without opening
a socket. For `vx@` that made tier 1 silently dead past t+30 s — the request held the full deadline
making **zero** real connect attempts while the log and the banner counted attempts that never left the
process. `mergeSignalIntoInit` now also drops an `own` that is already aborted, as the belt behind
that brace.

**RISK-7 — a CI run holding a dead endpoint for the full deadline.** `--no-recovery` /
`CLAUDISH_RECOVERY=0` withdraws the hold AND the launch: `shouldSkipTier1` answers
`recovery-disabled` on the first classified failure, and `recoverySurfaceAllowed()` — which is
`resolveRecoveryEnabled() && resolveRecoveryUi()` — drops the magmux wrap, the recovery-UI install
and `CLAUDE_CODE_RETRY_WATCHDOG` together. `--no-recovery-ui` / `CLAUDISH_RECOVERY_UI=0` keeps the
retries and drops only the banner (and with it the 503 arm, since the lease can never be valid).

**This paragraph used to claim "byte for byte", and that claim was wrong twice.** It is recorded
here rather than quietly corrected, because both halves were read as true by reviewers:

1. **It was false about the LAUNCH, which is the half a user sees.** The wrap was gated on
   `resolveRecoveryUi()` alone, so `--no-recovery` still started `magmux --id claudish-<pid>` —
   observed in the OS process table on a real launch. The switch that turns the feature off left
   behind its most user-visible cost (magmux's ring replaces the emulator's native scrollback,
   RISK-4) plus ~89 ms of launch and a generated launcher script, for a banner that
   `recovery-disabled` guarantees can never draw. Fixed; the four-arm live matrix is
   `validation/c8/c8-no-recovery-wrap-live-fixed.txt`, and a source guard in
   `recovery/settings.test.ts` fails if either call site is reverted.
2. **It is still not literally byte-for-byte about the RESPONSE**, and the two differences are
   deliberate. Measured against a detached worktree at `3c1fa26` — the commit before this feature —
   with the same request through the same handler shape:

   | | branch, `CLAUDISH_RECOVERY=0` | baseline `3c1fa26` |
   |---|---|---|
   | refused port: status / body | **400**, 174 bytes, identical text | **400**, 174 bytes |
   | refused port: elapsed | 12 ms | 7 ms |
   | refused port: headers | **+ `x-claudish-connection-error: 1`** | — |
   | hung upstream, `API_TIMEOUT_MS=45000` | **400 at 15.0 s** (the derived floor) | **no answer; the client gave up at 60.0 s** |

   The extra header stays on purpose: `isRetryableError` reads it *above* the quota-wording match,
   and that hazard — a connection error whose message happens to contain "quota" advancing the
   fallback chain onto metered billing — does not go away because the user disabled the ladder.
   Removing it under the switch would hand the opt-out user the billing bug back. The clamp stays
   for the reason §1 gives: a budget nothing enforces on attempt 1 is not a budget, and the
   pre-recovery build's alternative is visible in that last row — it held a hung socket until the
   client's own timeout and answered nothing at all.

   So the honest statement is: **the opt-out restores the pre-recovery OUTCOME (an immediate 400
   `connection_error`, the same status and the same bytes of message) and the pre-recovery LAUNCH
   (no wrap, no banner, no watchdog); it does not restore the missing marker header, and it does not
   restore an unbounded first attempt.** Both exceptions make the opt-out path strictly better
   than what it replaced.

**There is NO loopback carve-out, and its absence is a decision.** An earlier design skipped the
ladder for a refused loopback address on the reasoning that a stopped local server will not start
itself. It was cut for two reasons. The narrow one: the predicate was a regression generator — every
revision of it either fired universally (skipping recovery everywhere) or fired never, and both
times the defect was invisible because the *same rule* decided the tests. The broad one, which is
the real one, in the user's words: *"why are we talking about ollama at all? we are not building a
solution for ollama, it is a general one."* A user who restarts their server mid-ladder gets their
turn back, exactly as a user whose VPN reconnects does.

**The probe path must fail fast.** Every probe POSTs through `ComposedHandler`, so without a gate
`--probe` and the config TUI's Test All would each hold an unreachable link open for the full
deadline and then misreport it as a `timeout` — breaking the two tools that exist to diagnose this
exact fault, and multiplying a Test All run by the probe timeout per unreachable link.
`probe-live.ts` sends `x-claudish-no-recovery: 1` and `shouldSkipTier1` honours it.

**The MCP path is deadline-bounded only.** `mcp-server.ts` passes `method`, `headers` and `body` but
**no `signal`**, so when Claude Code cancels the MCP *tool call*, the proxy socket stays open,
`c.req.raw.signal` never fires, and the ladder runs its full deadline. `client_gone` covers only the
MCP server process dying outright.

---

## 8. What a healthy request pays

**Three statements, and the guarantee around them is still placement rather than a flag**: the entire
retry apparatus — episode, ladder, waiters, banner — is constructed inside the `catch`, after
classification has already returned non-null. The `enqueueRequest` ternary that issues attempt 1 is
byte-identical to what it was before recovery existed. What a healthy request now pays, outside that
catch, is exactly:

| | cost | why it cannot be moved into the catch |
|---|---|---|
| `inboundStartedAtPerf(c)` at `handle()` entry | one clock read, one `WeakMap.set` | the deadline's zero point must be the request's start; asking for it later is what produced the 108 s answer in §1 |
| `tier1DeadlineAt(c)` before the fetch | arithmetic over one env read | the ceiling has to exist before the call it bounds |
| `deadlineClamp(deadlineAt)` | one `AbortController`, one timer, one `AbortSignal.any` | same |

The timer is disarmed in a `finally` the instant the call settles — before a byte of the body is
read — so it can only ever bound connect-and-headers, never cut a response already arriving. This
replaces an earlier, stronger claim ("nothing, and the primary fetch expression is byte-identical"):
that claim was true and the feature was not, because a budget nothing enforces on attempt 1 is not a
budget.

The re-issue goes through that **same ternary**. Six transports implement `enqueueRequest`, and what
they implement is not decoration: a bounded 429 loop with `Retry-After`, a model-fallback chain
drawn from the dynamic models catalog, and the local concurrency gate that stops `ollama@llama3.2:3` running four inferences at once.
Skipping it would make the attempt that finally *connects* behave differently from the one that
failed — and at the moment a network returns, N woken waiters would stampede unqueued into a
provider that has just come back.

The one measured cost is launch: wrapping the session in a magmux pane adds **+107 ms median**
(login shell +47, magmux +60; worst wrapped sample 718 ms), which is 4.7× inside the 500 ms bar the
design set for itself. Default-on survives on that evidence.

---

## 9. Evidence

| report | what it establishes |
|---|---|
| [`network-recovery-phase0-measurements.md`](../reports/network-recovery-phase0-measurements.md) | the 359.607 s client abort and its `API_TIMEOUT_MS` cause; `c.env.timeout(req,0)`; `Request.signal` firing in 0.49–0.86 ms; the 75.004 s macOS connect; magmux's +107 ms |
| [`network-recovery-phase2-verification-20260911.md`](../reports/network-recovery-phase2-verification-20260911.md) | the measured 5/10/30/60/60/60 ladder with 18 ms drift over 225 s; the four modules that shipped with no tests |
| [`network-recovery-phase3-pane-20260911.md`](../reports/network-recovery-phase3-pane-20260911.md) | SUPERSEDED design (the recovery pane). Still the record of the lease and the frame-driven-heartbeat CRITICAL |
| [`network-recovery-pane-close-wedges-host-tui-20260915.md`](../reports/network-recovery-pane-close-wedges-host-tui-20260915.md) | why the pane went: closing it wedged Claude Code's renderer, measured row by row, and why eight phases of validation missed it |
| [`network-recovery-overlay-validation/`](../reports/network-recovery-overlay-validation/) | the overlay banner, live: captures during the outage, at recovery and after teardown, with the recovery log and the forwarder traffic |
| [`network-recovery-phase4-status-flip-20260911.md`](../reports/network-recovery-phase4-status-flip-20260911.md) | the 503 flip through a real interactive session; the chain-safety mutations, including the quota-wording one |
| [`network-recovery-phase7-validation-20260912.md`](../reports/network-recovery-phase7-validation-20260912.md) | all nineteen acceptance criteria against HEAD: C-17 through a real stopped `ollama serve` with the probes COUNTED per attempt; the `--no-recovery` wrap regression and its four-arm live matrix; the §7 "byte for byte" comparison against a `3c1fa26` control; and three findings — **`API_TIMEOUT_MS ≤ 75 000` disables the auth-path ladder outright**, the 503-without-banner window is `UI_LEASE_MS` wide, and Bun's `os.homedir()` ignores `$HOME` |

Auth-path detail — the five-site inventory with per-site line references and the reproduced
`[Fallback]` advance — is in the Phase-1 half of the same body of work, summarised in §5 above.
