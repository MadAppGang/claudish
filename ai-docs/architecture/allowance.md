> The allowance model for a multi-subscription account pool: the usage ledger, the pure model under `auth/accounts/allowance/`, the one `Strategy` interface behind `sticky` / `ebr` / `lookahead`, the tournament and its gate (the default stays `sticky`), every adversarial trace with its figures, gap alerts and their measured cost, and why alerts under `lookahead` simulate `ebr`. Read before editing `auth/accounts/allowance/`, `ledger/`, `allowance-service.ts`, the pool's `rank` hook, or a surface that prints the allowance.

# The allowance model

A Codex account pool (`accounts.md`) holds several subscriptions, each with nested windows: a
weekly (7d) one and a 5h one, sometimes more. The pool's selection policy picks an account per
request from the headers' used fractions alone. The allowance model adds three things on top:

1. **A forecast** of demand by local hour of week, and of when the pool will be blocked (a gap).
2. **Alerts** before a gap, with a remedy ("cut to 60 % of the current rate until Sat 09:00, or
   pause 14 h"), on the stderr notice, the status line and the mod band.
3. **Optional selection strategies** that spend the allowance that expires first. They are opt-in;
   the default stays `sticky`, because no strategy has passed the gate (below).

The design and its two review rounds live in the session that built it
(`dev-feature-allowance-model-20261023-211643-3bfa7bbb`, gitignored). This file keeps what must
outlive it.

## Shape

```
            ┌──────────────── PURE (no I/O, injected now, seeded PRNG) ────────────────┐
ledger rows │ allowance/  observe/observeAll → AllowanceState → forecast / plan /       │
 + snapshots│   choose / gaps / alertStep / alerts / trajectory / contributions          │
            │   strategies/ sticky · ebr · lookahead — ONE Strategy interface, driven by │
            │   simulate.ts for alerts AND by pool.ts for requests                       │
            │ allowance/sim/  vendor emulator, traces, tournament, oracle (SAME API)     │
            └────────────────────────────────────────────────────────────────────────────┘
 I/O shell:  ledger/ (writer, reader) · allowance-service.ts (process singleton: lazy state,
             memo, plans off the request path, alert cadence, alert file, notice, label)
 seams:      ComposedHandler attempts → ledger · pool.evaluate() → SelectOptions.rank
 surfaces:   claudish account forecast [--json] · stderr notice · status line ·
             MCP allowance_status → mod band
```

**Purity is enforced, not hoped for.** Nothing under `allowance/` may import `node:*`, call
`Date.now()`, `Math.random()`, `process` or `fetch`, or import outside `allowance/` except
`../types.js` and `../policy.js` (only `request.ts`, `strategies/sticky.ts` and `sim/`).
`allowance/purity.test.ts` parses the import graph and greps the tokens. The point is that the
simulator, the alerts and the pool all drive the same code: a rule tuned in the simulator is the
rule that runs.

## The usage ledger

`~/.claudish/accounts/usage/raw/YYYY-MM-DD.jsonl` (one UTC day per segment, 0600, appended) and
`usage/hourly/YYYY-MM-DD.jsonl` (the rollup of one closed day, one atomic rename). One row per
attempt (`ComposedHandler`), with the account, the Claude Code session id (stored locally in full,
cut to 8 characters on every surface), the model, the
selection reason, the token counts and each window's reading. Rows are built **only** from numbers,
closed sets and pattern-checked identifiers (`ledger-row.ts`): the plan type maps to a closed
`PlanClass`, labels pass `ACCOUNT_LABEL_PATTERN` (a label may be an email: personal data, not a secret), a session id must match `^[A-Za-z0-9-]{1,64}$`,
a model id `^[A-Za-z0-9._:/@-]{1,80}$`, else `"other"`. No body text, no header text, no project.
That is why the ledger needs no redaction pass (`adapters.md`, sink table).

`parent` (optional, the session pattern) is the Claude Code conversation that delegated the session
through the MCP server. The server resolves it once per `create_session` / `team` call
(`parentSessionForCall`) and hands it to each pane child as `CLAUDISH_PARENT_SESSION`, a launch var
(deleted from Claude Code's environment, never settable from an env file); the child's
`AllowanceService` reads it once, only when `isPaneChild`, and drops a value that fails the pattern or
equals the row's own session. The key is omitted when null, so such rows are byte-identical to older
ones; a rollup takes its group's first non-null `parent` without changing its key or id. The report
cuts it to 8 characters (`sessions[].parent`). A day compacted by an older claudish loses it.

Raw days are kept 30 days and unlinked only once their hourly file exists; hourly files 180 days.
A day with an hourly file has its raw segment ignored, which makes every crash point safe without
an index. The writer never throws; its queue holds 1024 rows and drops the oldest. The ledger is
written whatever the strategy (the forecast needs it); `CLAUDISH_ALLOWANCE_LEDGER=off` writes
nothing.

## The `Strategy` interface

```ts
export interface Strategy {
  readonly name: StrategyName | "governing-fefo" | "water-fill"; // the last two: sim baselines only
  plan?(input: PlanInput, cfg: AllowanceConfig): Plan;            // pure; may be expensive; NEVER on the request path
  needsReplan?(plan: Plan | null, input: DecisionInput, cfg: AllowanceConfig): boolean; // pure, cheap
  decide(input: DecisionInput, plan: Plan | null, cfg: AllowanceConfig): Decision;     // pure, O(accounts × windows)
}
```

| Strategy | `plan` | `decide` |
|---|---|---|
| `sticky` (default) | none | the REAL `policy.ts` `selectAccount` with no `rank`. The simulator calls the production function. |
| `ebr` | none | the usable account whose BINDING window resets first, then config order; a live thread stays put for `SWITCH_DWELL` (30 min) after its last switch |
| `lookahead` | an event-branching, depth-bounded (4) search over account SEQUENCES, branching at every reset, demand step and the thread's expected end; branch-and-bound, 4096-node budget | the plan's best first account, switching only when the gain is at least `SWITCH_HYSTERESIS` (2) × the switch cost (the context rebuilt as cache writes); `sticky`'s decision whenever the plan is stale or absent |

**No rule is claimed optimal.** Two review rounds each built a trace that beat the rule of the
time (R1 beat first-expiry-first; gpt #1 beat the fixed-prefix look-ahead). Online selection over
nested, resetting, partially observed windows has no known closed-form optimum. The tournament is
the only judge.

The ranker is total: `pool.evaluate()` passes `rank: safeRanker(...)` only when the strategy is not
`sticky` and no pin applies, and the ranker DECLINES (sticky decides) whenever the model is not
loaded, the plan is stale, or anything throws. A plan is never computed on the request path; a
stale-plan request is decided by `sticky` and counted (`staleDecisions`).

`strategy` is set by hand in `~/.claudish/config.json` at
`subscriptionAccounts["openai-codex"].strategy`; `account status` prints it.

## Adversarial traces, with their figures

Served tasks. Hand figures were derived in the design and re-derived by `sim/oracle.ts` (exact
search, ≤ 12 requests × 3 accounts). The first tournament (below) executed every row and matched.

| Trace | Shape | sticky | ebr | lookahead | governing-fefo | oracle |
|---|---|---|---|---|---|---|
| R1 | A: 7d rem 2 (R h10), 5h rem 1 (R h5); B: 7d rem 2 (R h20), 5h rem 1 (R h1); order B, A; tasks at h0, h2, h3 | 3 | 3 | 3 | **2** | 3 |
| gpt #1 | A: 7d 2 (R h10), 5h 1 (R h2), 1h 1 (R h0.5); B: 7d 2.2 of 20 (89 % used), 5h 1 (R h1); tasks h0–h3 | 4 | **3** (gap h2→h6) | 4 | 3 | 4 |
| opus H1 | A: 7d 1 of 2 (R h100), 5h 1 (R h1); B: 7d 2 (R h5); tasks 1 at h0, 1 at h1, 3 at h50 | **4** (gap h50→h100) | **4** (gap h50→h100) | 5 | 5 | 5 |
| opus "choose" | X, Y, Z each with one 7d unit expiring at h1/h2/h3 and a fresh unit after; tasks at h0, h1, h2 and three at h10 (numbers built in step 2; the review gave none) | **4** (gap h10→h169) | 6 | 6 | 6 | 6 |

Gap and decision traces (every deployable strategy passes):

| Trace | Shape | Result |
|---|---|---|
| R2 | two weekly accounts, demand at 21 and 15 cu/h | 21: gaps [h9, h10] [h14, h100] [h104, h124]; 15: [h19–20, h100] [h106, h124]; CRITICAL on the long gap under every strategy (a short first gap never hides a long later one) |
| R3 | a 5h reset 1 min before the weekly reset | no switch onto the residual window (deliverable 0.0503) |
| gpt #8 | remaining 0.1, R h100, external drift 0.02 W/h, zero local demand | gap [h5, h100]; CRITICAL; remedy `not-addressable` / `external-use` |
| opus M4 | two disjoint 7d gaps (30 h at h20, 31 h at h60) whose lengths alternate between evaluations | one episode, one raise, no re-announcement |
| sliding release | a sliding 5h window releases each charge L later | remaining 0.6 at bucket 5 |
| window retired by complete snapshots | `observeAll` | 3 of 3 expectations hold |
| stripped headers | a response with no usable snapshot | the head stays 0.4 at h0; its 2000 cu still count as demand |

How to read opus H1: `ebr` spends A's only weekly unit at h0 (A's 5h binds first), so 3 tasks at
h50 meet one account: a 50 h gap until A's weekly reset. `lookahead` serves h0 and h1 from B, which
refills at h5 with nothing wasted, and serves all five. This is also the trace that shows why the
alert model must be the deployed strategy (next section but one).

## The tournament and its gate

`bun run sim:allowance` (`allowance/sim/cli.ts`) runs every contestant behind the one interface,
`sticky` as the real `selectAccount`, `ebr` and `lookahead` as the real `selectAccount` with `rank`
= the real `choose`. Every contestant sees only the rows a vendor emulator emits and its own
`observe` state; plans land `PLAN_LATENCY` late, as in production. Scenarios are a named list:
every adversarial trace; each demand profile (`steady`, `bursty`, `weekday-heavy`, `refactor-day`,
`over-subscribed`, `external-drift`) on two accounts whose weekly resets are 26 h apart; and
balance, size and window-semantics variants.

A contestant replaces `sticky` as the default only when ALL of these hold, per scenario, on paired
seeds: (1) every adversarial trace serves at least sticky's figure and the oracle's on R1, gpt #1
and opus H1, and every alert trace gives its expected result; (2) unserved cu ≤ sticky's at median
and p95, strictly lower on one `2× offset 26 h` steady or weekday-heavy; (3) demand-weighted blocked
hours ≤ sticky's; (4) waste is a tie-break only; (5) switches ≤ 1.2 × sticky + 1 per day; (6) on
`over-subscribed`, median WARN lead ≥ 24 h, false alarms ≤ 10 %, flaps 0 with clears > 0, missed
gaps 0; (7) plan time and `staleDecisions` reported. A trace found later joins `adversarial.ts` and
the gate reruns; a default that then fails goes back to `sticky` in that release.

**First result** (`ai-docs/benches/allowance-sim-2026-10-24/`, a smoke run of 1 seed × 7 days, not
the gate's 10 × 28): `lookahead` matches the oracle on every served trace; `sticky` loses opus H1
and opus "choose"; `ebr` loses gpt #1. On realistic scenarios the smart rules LOSE to sticky in most
cases:

| scenario (2 accounts) | sticky unserved Mcu | ebr Δ | lookahead Δ |
|---|---:|---:|---:|
| weekday-heavy · offset 26 h | 2.81 | −1.36 | −0.23 |
| over-subscribed · offset 26 h | 24.78 | −2.32 | −1.37 |
| steady · offset 26 h | 0.64 | +0.64 | +0.69 |
| steady · balanced | 0.64 | +0.64 | +0.81 |
| external-drift · offset 26 h | 0.87 | +0.60 | +0.87 |
| refactor-day · offset 26 h | 13.16 | +0.62 | +0.69 |
| weekday-heavy · 1 account | 1.53 | 0 | 0 |

Neither passes. They win where staggered resets meet real pressure and lose at moderate demand:
they switch to spend expiring allowance, pay the cache rebuild, and the moved demand then meets the
other account's tighter 5h window. Two suspected causes, to test before any tuning: forecast error
(22–40 %, and the plan stale on 4.6–8.9 % of `lookahead` decisions), and a simulated rebuild cost
above the model's prior. **The default stays `sticky`.** Next: the gate run (10 seeds × 28 days)
and a replay of the real ledger.

## Gap alerts

`alerts.ts` simulates demand `ρ·f_h` (the forecast's hour-of-week profile at the long and the short
burn rate) through `simulate` and returns every blocked run. WARN: a 7d gap ≥ 12 h starting within
72 h at both rates; CRITICAL: ≥ 24 h within 24 h. Entry needs two consecutive true evaluations,
exit two below the clear threshold for a hold time; a refire guard keys on the gap at raise, and
episodes are matched against every gap (opus M4). Monte Carlo paths (demand paths plus capacity
draws, one path set for every level) give `pGap` and the p10/p50/p90 of the gap's start, end and
length; the remedy is a scan over cut fractions and pauses. The evaluation runs every 5 minutes
off the request path, in slices (`alertsSliced` yields after each simulation), outside the lock on
`allowance-alerts.json`; the compare-and-set winner announces a transition once across processes.
A `GapEval` and the Monte Carlo payload are reused while their inputs key holds: the key holds each
burn rate at 1/8 octave (`rateBin`), because the open hour moved the short rate every minute and
the reuse never happened.

**The safe pace** (`burn.sustainable` in the report, `paceScan` in `alerts.ts`) is reported
whenever the status is `ok`, not only under an alert: the highest rate ρ whose `ρ·f` has no 7d gap
≥ 1 h over the alert horizon H, the remedy's own criterion. Under an active alert the shell takes
the top remedy (`cutToFraction × burn.long`, 0 for pause / not-addressable), so the band can check
`cutToPercent / 100 × burn.long` exactly. Without one: a gap at ρ_L runs the remedy's cut grid on
ρ_L (`cutScan`, shared with `remedyScan`), so the value does not jump when the alert is raised;
otherwise the anchor is max(ρ_L, ρ_C), ρ_C the pool's refill throughput (Σ capacity / governing
length). Anchoring at ρ_L alone made a light user's decaying rate pull the answer down with it
(64 × a tiny rate). A clean anchor doubles to 64 × and bisects 4 times (≈ 6 %); a gapping one
bisects down towards ρ_L. At most 11 `gapsOn`, only on the report's evaluation (`opts.pace`), and
reused while `inputsKey` holds; the result is kept as φ = rate / ρ_L and reported as φ × the
report's `burn.long`, which also converts W/h to cu/h in `account-fraction`.

**The alert model is the deployed strategy.** The design's first revision forecast with `ebr`
while selection ran its look-ahead: on opus H1 that raises a false 50 h WARN (ebr spends A's only
weekly unit; the look-ahead saves it), and hysteresis holding a0 where ebr would switch can miss a
gap. So `gaps`, `alerts`, the trajectory and the remedy simulate `STRATEGIES[...]`, the object the
ranker calls.

### Except under `lookahead`: alerts simulate `ebr`

Measured on a dense state (5 Codex accounts, 7d + 5h windows, 21 days of the over-subscribed
trace, this machine):

| | sticky | ebr | lookahead |
|---|---|---|---|
| first raised evaluation (WARN + CRIT, remedy) | 400 ms, longest slice 79 ms | 390–489 ms, longest slice 96 ms | **3 696 ms**, longest slice 187 ms (24 s unsliced before) |
| next 5-minute evaluations (payload reused) | 4–7 ms | 3–6 ms | 3–6 ms |
| nothing raised (gap evaluation only) | 6–22 ms | 1–16 ms | 197 ms |

Budget: ≤ 0.5 s per evaluation. One `lookahead` `simulate` costs 50–70 ms here because it replans
hourly over up to 216 buckets, and the remedy scans alone are ~20 simulations, so no path count
fits: at 8 paths it would still be ≈ 1.6 s. Slicing keeps the event loop moving but cannot bring a
slice under 20 ms while the unit is one whole `simulate`.

So, **when `strategy` is `lookahead`, alerts and the trajectory simulate `ebr`**
(`alertStrategy`/`alertModelConfig` in `constants.ts`); selection still uses `lookahead`. The
trajectory follows the alerts so that the graph and the alert line on one screen come from one
model. `account forecast` prints `alerts simulate ebr (lookahead alert model pending)` under the
header. This reopens, for `lookahead` users only, exactly the disagreement above: on an opus-H1
shape the alert reports ebr's 50 h gap that `lookahead` will in fact avoid (a false WARN, the safe
direction), and a gap only `lookahead`'s hysteresis creates is not forecast. Lifted when a
per-bucket generator `simulate` (yield per bucket, shared with the search and `sim/run.ts`) brings
a cold `lookahead` evaluation under 0.5 s; the follow-up ticket carries that. The path count is
then `LOOKAHEAD_TRAJ_PATHS` (40), whose p10/p90 band is about ±5 percentile points against ±2 at
200.

## Measured budgets

| What | Measured | Budget |
|---|---|---|
| fold 1 639 events (`observeAll`) | 7.5 ms | — |
| `forecast` (216 h) | 46 ms | off path |
| `trajectory` (168 h, 200 paths × 2 with `slower`), live 2-account pool | 58-61 ms (28-30 ms before `slower`) | report path, every poll |
| ranking call `choose` (overlay + decide + report), 500 calls | p50 0.65 ms, p95 1.37 ms | < 2 ms ✓ |
| `planFor`, `lookahead`, depth 4, 7d + 5h, 40 calls | p50 6.8 ms, p95 43 ms, max 54 ms | < 20 ms ✗; accepted, off path; `PLAN_LATENCY` = 43 ms |
| alert evaluation | see the table above | ≤ 0.5 s ✓ sticky/ebr; lookahead → ebr's model |

## Surfaces

- `claudish account forecast [--json] [--horizon <1h–7d>] [--provider codex]`: header, alerts with
  binding windows and remedy, a 60 × 10 graph, the top 10 sessions by share plus the unattributed
  row. `--json` prints the `claudish.allowance.v1` report (`allowance-report-schema.ts`), validated
  before it is returned.
- The stderr notice: one line per raised, escalated or cleared transition, headless runs only
  (`logStderr` is quiet under an interactive Claude Code).
- The status line: a token-file key `allowance` with epochs, formatted at render time.
- MCP `allowance_status` (`mcp-sessions.md`): the same report wrapped in the mod contract's meta;
  the `allowance` capability and the mod's discovery lifecycle are in `pane-session.md`. The answer
  is model-visible: no project, session ids cut to 8 characters.

### The switch likelihood curve (`trajectory.switches[].likelihood`)

Each predicted switch carries `p[]`, the relative likelihood of the account's FIRST takeover per
hour, built in `trajectory.ts` (`likelihoodOf`) from the takeover times the trajectory's paths
already hold: no second simulation.

- **Smoothed, because the raw count is spikes.** About 60 of 200 paths take over, spread over about
  80 hours: an hourly count of mostly 0 or 1. A Gaussian kernel with Silverman's bandwidth
  (`0.9 × min(sd, IQR/1.34) × n^-0.2`, about 12 h on the live pool) turns it into a hill.
- **Counted, not smoothed, when the IQR is zero** (or the bandwidth is under 0.5 h). That is a
  takeover at a fixed reset: most paths in one hour plus stragglers. Silverman's usual fallback to
  the sd would let the stragglers spread the point mass into the hours BEFORE the reset, which
  cannot happen. `likelihood-of.contract.test.ts` L8b is the test; it fails with the sd fallback.
- **Peak 1, not sum 1.** A sum-1 density over 80 hours is about 0.004 per hour, and the 3 decimals
  the report sends keep almost nothing. The mass is `probability`.
- **The argmax is noise; show `usual`.** On the live pool both hills stayed within 5 % of their
  peak for 15-20 h. Inside that plateau the highest hour is sampling noise: switch 2's argmax sat
  5 h before its own p50 and before switch 1's argmax, while the medians (86, 94) and means (84.1,
  93.8) kept the order. The schema says so, so a reader draws shape only.
- **Size.** About 1 KB per switch (169 values); `trajectory` grew from 33.8 KB to 36.2 KB. Claude
  Code 2.1.312 returned a 36,132-character `allowance_status` answer inline and refused a
  59,907-character one, so the persist threshold lies between them.

### The slower scenario (`trajectory.slower`)

The forecast panel's `slower` row and its "slow down and it lasts" sentence need the switch plan at
a lower demand. `trajectory.slower` reruns every Monte Carlo path with its demand × `SLOWER_FACTOR`
(2/3, the design's "a third less busy"), and reads `switches` and `blocked` from those runs through
the same `switchesOf` and `blockedRuns`.

- **Common random numbers.** The slower run takes each path's OWN demand draw and capacity draw,
  so a path is compared with itself: the difference between the two lists is the slowdown, not
  sampling noise. No rng call is added (`simulate` copies its views in `createWorld`), so every
  existing field is unchanged.
- **Not monotone, under any strategy.** A slower run can switch or block EARLIER than the
  current one, `sticky` included, and the field reports what the simulation does: it is never
  clamped to look better. `sticky` switches at `SELECTION_THRESHOLD` (0.90 used), not only on
  exhaustion, so the two runs can cross it on different sides of a short-window reset and then
  drain different accounts; from there no account's use is lower in the slower run. Measured with
  the production `simulate` and `sticky`: A has a 5 h window at 0.2 remaining that resets at +2 h,
  B a 168 h window at 1.0 that resets at +6 h, β 0.5, demand 0.5 cu/h for 18 h with 1.5 cu at
  hour 12. The current run has no gap; the slower run has a `7d` gap with 0.333 cu unserved at
  hour 16 (found by the external review of PR #371). Only the FIRST takeover from the starting
  account, before any reset, is never earlier. `ebr` (simulated with `lookahead`) also switches
  earlier on purpose. A reader compares the two scenarios; it never assumes the slower one is
  better.
- **Not a deterministic run.** One simulation at 2/3 of the mean rate (how the safe pace scans)
  costs under 1 ms, but it is a point estimate beside the 200-path `usual`, so "slow down and it
  lasts Y" could read shorter than "it switches in X". The user chose the second Monte Carlo pass
  on 2026-10-29 and accepted its cost.
- **Cost.** It doubles the trajectory on every report, the band's 60 s poll included: measured on a
  two-account pool, trajectory 28 → 59 ms, warm report 35 → 66 ms.

## Where to look

| Path | What |
|---|---|
| `auth/accounts/allowance/` | the pure model; `index.ts` lists its public API; `constants.ts` every default with its reason |
| `auth/accounts/allowance/strategies/` | `sticky`, `ebr`, `lookahead` (`search.ts`), the registry |
| `auth/accounts/allowance/sim/` | vendor emulator, `adversarial.ts`, `oracle.ts`, `tournament.ts`, `cli.ts` |
| `auth/accounts/ledger/` | row guards, writer, reader |
| `auth/accounts/allowance-service.ts` | load, memo, plans, alert cadence, `report()`, `safeRanker` |
| `account-forecast-render.ts`, `account-command.ts` | the CLI view |
| `ai-docs/benches/allowance-sim-*/` | tournament runs; a default changes only with one |
