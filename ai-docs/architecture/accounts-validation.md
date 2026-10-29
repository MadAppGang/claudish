> The scenario matrix for multi-subscription accounts: every row id the code, the tests and the
> design cite (V*, U*, T-*), each with the mutation that must turn it red, and what each row still
> needs before it can run.
>
> Rationale: [`accounts.md`](./accounts.md). Review history, including why rows were rewritten:
> [`../reports/multi-subscription-plan-review-2026-09.md`](../reports/multi-subscription-plan-review-2026-09.md).

# Multi-subscription accounts: validation matrix

**Status:** matrix revision 3 (2026-09-13), with rows restated against built code on 2026-09-24
(V10, V16b, V18) and on 2026-10-22 for Phase 2a (V1, V1b, V1e, V8b, V16b, U14, U16). Phases 0, 1
and **2a** are built and the Codex pool is on the request path. Phase 2a **shipped in v14.5.0**
and is loopback-verified: its acceptance cases run the production credential factory, transport and
`ComposedHandler` in an isolated child process against loopback OAuth, token and metered listeners
(an in-process proxy, **not** the built binary the harness section below describes). The plan's
acceptance ids (E1–E20, C1–C7, S1–S3) map onto these rows in *Phase 2a coverage* below. **D8 gates
Phase 2b**, and every row marked `D8` stays unrun. **Last updated:** 2026-10-29.

**Superseded mutation wording.** Rows written before v13 cite `mapAccountsError`, a catch "around
the `:695` swap" and "400 + `upstream_status 401` advances the chain". `mapAccountsError` was never
built; the shared classifier answers instead (`accounts.md`, *The error surface, as built*). Those
cells still name the property; the mutation actually executed is the one in the coverage table.

## How to read it

**A check that cannot fail is not evidence.** Every safeguard names the mutation that must turn its
row red, and the mutation column is itself checked:

- a mutation must be one that would really turn the row red, traced against the design and source;
- a mutation must compile against the design as written — "restore the deleted catch" is not a
  mutation once the symbol is gone;
- where no mutation can exist the row says **`[unmutatable]`** and why. A decorative mutation is
  worse than an honest label, because it launders an unchecked assertion as a checked one;
- each mutation is executed once during review to prove the row is live.

Revision 1's column was never checked, and round 2 found twelve rows that were outright theatre —
the flagship billing row among them — plus eight partial ones.

**The "Needs" column** names what must exist before the row can run: `P2` the Codex pool on the
request path plus the harness, `P3` the Claude pool, `P4` the handoff (ships under the switch rule: Phase V measured D2 positive on
2026-10-29; its dual-store refresh rows V12, V12b, V12c and T-C5 apply only on the D1/D2 table's
fallback branch), `D8`
the real in-stream capture. `P2a: done in-process` marks a row whose property the 2a in-process
acceptance tests now pin; the built-binary run is still owed. **"Covered today"** names a test that
pins the property now, or `—`.

**Line numbers** in the mutation cells are the design's, from the pre-feature baseline `d70eb8fd`.
They have drifted; they name sites:

| Cited | Site | At `3ec7762b` + review fixes |
|---|---|---|
| `:695` | the Codex status swap: `this.capturePlanUsage(response)` immediately before `if (!response.ok)` | `composed-handler.ts:765` |
| `:591`, `:754` | the two redundant-net sites: the first Codex fetch, and the 401 re-sign fetch | around `:675` and `:870` |
| `:961` | the terminal-remap block, after `logStderr`/`reportError`/`recordStats` | around `:1126` |
| `proxy-server.ts:1144-1152` | the route's generic catch, `wrapAnthropicError(500, String(e))` | `proxy-server.ts:1165` |

Since 2a the swap is the top of `ComposedHandler`'s bounded dispatch loop (`pooledHttpQuota` beside
`capturePlanUsage`), and the two nets are the transport's pre-record check in `signRequest` and the
pre-fetch check in `attempt()`. Find them by name; the 2a line numbers will drift too.

## The mock-upstream harness (Phase 2)

- **Fake server:** `Bun.serve` on 127.0.0.1 serving `/v1/messages`, `/v1/responses`, the token
  endpoint and the usage endpoint. The token endpoint **counts** exchanges, revokes the presented
  token immediately and answers reuse with `invalid_grant`.
- **The metered canary:** a second loopback listener registered for `api.openai.com` that
  **records and 500s** every request, so contacting the metered path is an observed event, not an
  absence. `OPENAI_CODEX_API_KEY=sk-canary-must-never-be-used` on every run. **Zero canary requests
  is a standing assertion on every row**, V17 excepted.
- **Host override** (built): `CLAUDISH_TEST_UPSTREAM`, loopback only, per-host form for the canary.
- **Binary pinning:** every command runs this worktree's built artifact by absolute path and records
  `--version` and the startup identity **before** any result is read.
- **Title requests:** Claude Code fires a session-title request on turn 1. The fake classifies by
  payload size and prompt shape and never counts one as request #1; every row asserts its main-turn
  attempt count.
- **Separate temp HOMEs** for native and Codex rows, **except V15**, which needs one shared HOME.

```bash
HOME=<tmp> CLAUDE_CONFIG_DIR=<tmp> CLAUDISH_ACCOUNT_STORE=file CLAUDISH_DISABLE_KEYCHAIN=1 \
CLAUDISH_DISABLE_OP=1 CLAUDISH_ACCOUNTS_LOG=<tmp>/accounts.jsonl \
CLAUDISH_TEST_UPSTREAM=api.openai.com=http://127.0.0.1:<canary>,default=http://127.0.0.1:<fake> \
  <worktree>/packages/cli/dist/… -y -q -p "<prompt>" --model <spec>
```

Two rows change that environment on purpose: V2e runs Keychain-backed, and V15 shares one HOME. A
row whose mutation targets a component the default environment excludes cannot fire, which is what
made two revision-1 rows dead.

### The fault vocabulary

`CLAUDISH_ACCOUNTS_FAULT`, armed **only** with a valid `CLAUDISH_TEST_UPSTREAM` (`test-upstream.ts`).
A fault that cannot produce a row's precondition makes that row unrunnable — the same defect as an
ineffective mutation, one level down. So every accepted name has a live injection site, and an
unknown name is logged and ignored.

| Fault | Site | Rows |
|---|---|---|
| `persist-throw` | the FINAL persist throws, after a successful exchange | V9 |
| `persist-timeout-committed` | the final persist commits, then reports a timeout | V9b |
| `persist-timeout-uncommitted` | the final persist times out before committing | V9b |
| `journal-persist-throw` | the journal write throws; no exchange may follow | — |
| `journal-persist-timeout-committed` | the journal commits, then reports a timeout; the exchange proceeds | — |
| `journal-persist-timeout-uncommitted` | the journal times out before committing; no exchange | — |
| `crash-after-refresh` | the process exits between the exchange and the persist | V9 |
| `lock-hold-forever` | the holder keeps the gate, heartbeating, and never proceeds | V2c |
| `store-read-throws` | every token-store read throws | V1d |
| `account-list-read-throws` | the account-list read (`config.json` or the legacy file) throws | V1e, V16b |
| `steal-lock-mid-exchange` | the gate is re-created under another nonce while the exchange is in flight | V2f, V10b |
| `steal-lock-after-fence` | the same, between the final write's fence and the write | T-C4 |
| `non-oauth-artifact` | replace a pooled artifact with an API-key artifact for the metered canary immediately before the Codex transport's pre-record arm check; valid loopback upstream required | V1b / E17 |

Not accepted until its site exists: `crash-after-first-store-write` (Phase 4, the dual-store
refresh; V12c). The
`persist-*` faults target the final write since code-review fix B10; before it they fired on the
journal, the first persist, and V9 could not have been produced.

## Phase 2a coverage (2026-10-22)

Session evidence: `ai-docs/sessions/dev-feature-multi-subscription-20260912-000000-a1b2/tests/test-plan.md`,
sections "Phase 2a tests", "Phase 2a tests — pass 2" and "Phase 2a stale-test updates". The session
directory is gitignored; this table is the durable summary. Paths are under `packages/cli/src/`.
File keys: **H** `handlers/composed-handler-accounts-2a.test.ts` (138 tests), **M**
`auth/accounts/management-2a.test.ts` (27), **O2** `auth/accounts/outcomes-pass2.test.ts` (17),
**Q2** `auth/quota/sources/codex-accounts-pass2.test.ts` (5), **PB**
`auth/credentials/codex-pinned-baseline-2a.test.ts` (8, removed before the v14.5.0 merge; see V16), **L**
`auth/credentials/codex-pool-legacy-2a.test.ts` (3), **B** `auth/credentials/billing-probe.test.ts`,
**P** `profile-config-subscription-accounts.test.ts`.

A green test is not a mutation proof. "Executed" names a mutation that was armed in the test child
or in a scratch copy, reached its site and turned the row red; production files were never patched.

| Matrix row | Plan case | Test | Mutation executed | Still open |
|---|---|---|---|---|
| V1, V8 | E3, E4-disabled | H `E3 …`, `E4-disabled …` | add a verdict to true exhaustion → `terminal` received | literal deletion of the rotation-sign catch |
| V1c | E2 | H `E2 true exhaustion preserves pinned reset lines without an auth verdict` | same verdict mutant | — |
| V1b | E17 | H `E17-<initial\|replacement\|forced\|remove-quota\|remove-401> …`, `E17-backstop …` | guard escape → canary received 1 (100/1); post-record force-SUB → subscription-next contacted (137/1) | independent removal of each net; legacy-logout variant |
| V1d, V1e, V16b (pool half) | E10 | H `E10-<config-io\|config-invalid\|config-schema\|legacy-io\|legacy-invalid> …`; `E10 <config\|legacy> <EACCES\|EMFILE\|EIO> <cold\|last-good> …` (12) | projection-false (E11 run, 136/2) | real OS parent `EACCES`; unreadable token store; routing-drop and failed-stamp mutants |
| V8b | E4 | H `E4 spent rotation with expired eligible C answers transient 429 without leasing C` | query reads C's store → C appears in reads (137/1) | heal/acquire/`setActive` variants; next-request C selection; B lease failure → C; mixed blockers |
| V11 | E1 | H `E1 production factory rotates A quota to B …` (asserts no red stderr line) | five: no-rotation, reuse-A, change-bytes, bare-fetch, skip-mark | — |
| V14 | E11 | B `E11/M4 registry presence overrides the singleton in both directions`, `E11 a registered throwing Codex projection is conservatively subscription`; H `E11-<disabled\|pool-disabled> …` | projection-false (136/2) | cross-process `serve` reload (P2 binary) |
| V16 | E20 | PB `E20 pinned structural components preserve <legacy\|api-key\|refresh-rejection> request/remap` + five pinned-dependency tests (8 pass at `69854a9f`, then removed); L `E20 synthesized legacy delegates verbatim …` (kept) | endpoint, header, payload, remap: each red | **two built binaries never compared**; component evidence only. PB read git history (`6b572b7f`, `merge-base HEAD origin/main`): a shallow CI checkout has neither, and on main after the merge the merge-base is HEAD, so the dependency tests compare a file with its own Phase 0 hunks. It was a pre-merge check only |
| V17 | E5, E20 | H `E5 API-key insufficient_quota neither reads pool tokens nor rotates`; PB api-key case (pre-merge, see V16) | — | — |
| U9 | E11 | H `E11-<disabled\|pool-disabled>` | projection-false | — |
| U10 | E7 | H `E7 bare-name exhaustion reaches the metered socket with its cost warning; explicit cx stops` | verdict on exhaustion → bare chain stops (80/4) | template-wording mutant |
| U11 | E18 | H `E18 one transport keeps interleaved A/B artifacts, pins, contexts and forced-sign budgets separate` | shared artifact → turn 1 got `Bearer access-B` (137/1) | quota-rotation interleavings |
| U13, T-M4 | E11 | B (as V14) | — | — |
| U14 | E8 | H `E8 <initial\|rotation\|forced\|headers\|query> <class> …` | transient-401 → 503 expected, 401 received (56/45) | later-recovery and cloned-body catches |
| U15 | E19 | O2 `E19 <persist\|report\|log> failure retains pending quota/status …`; H `E8 reporter failure preserves successful rotation and pending exhaustion` | — | full next-request after a persistent failure |
| U16 | E8 | `auth/accounts/errors-regression.test.ts` (U16 rows, restated: default 503, explicit 429 kept, `RangeError` for 401) | — | — |
| U18 | C3 | M `C3 stale saveConfig preserves an account published after the TUI loaded`; P | scratch `profile-config.ts` without disk preservation (16/3) | reverse-order and two-process commits |
| — | E5 | H `E5 pooled HTTP 403 quota rotates …`; `E5-<rpm\|forbidden\|model\|region> …` | — | status-only and gate-removal mutants |
| — | E6 | O2 eight precedence rows; `E6 estimates persist 15/30/60/120/240/300/300 minutes across actual process restarts`; counter-reset rows | estimate count forced to 0 (16/1) | priority/unit swaps |
| — | E9 | H 15 `E9 … continues only to subscription candidates` permutations + transient-behind-404 | — | verdict-drop and display-name mutants |
| — | E12, E13 | H `E12-<refused\|reset\|slow> …`, `E13-<429\|503\|invalid-grant\|invalid-2xx> …` | — | handler hold and later recovery; unreadable-body variants |
| — | E14–E16 | H `E14-…`, `E15-…`, `E16 parameter rewrite quota rotates …` | — | overload-stream HTTP re-issue; second complaint |
| — | E19 reader | Q2 `E19 actual fetchExplicit <single\|multi\|suppressed\|unknown\|legacy> …` | guard authorizes legacy → 4 rows read once (1/4) | — |
| — | C1, C2 | M `C1/C4/C7 <add\|add-legacy> …`, `C1 <wrong-state\|cancel\|timeout\|decline> …`, `C2 duplicate-…`, `C2/C3 concurrent-…` | duplicate check removed (25/2) | real callback/timer; ambiguous-store read-back |
| — | C5 | M `C5/R5/R12 <suppression-…\|crash-…> keeps suppression durable before legacy cleanup`, `C5 disable is idempotent …` | stale-save scratch copy (above) | publication-time concurrent reader |
| — | C6 | M `C6 login-refresh-<old-mark\|newer-mark> …`, `C6 finished browser login waits …`, `C6 refresh pre-persist reread adopts newer material …`, `C6 parked browser holds no account gate …` | baseline dropped from the guarded clear (26/1) | mid-exchange disable and config I/O |
| — | C7 | M `C7 disabled Keychain selects files …`; O2 `C7 outcome JSONL has only allowlisted metadata, mode 0600 …` | — | throwaway Keychain; lock-order matrix |
| T-C7 (wiring) | S1 | H `S1-<one\|eligible\|after-http> false-mode stream quota marks without rotating or leasing capacity` | — | **D8**; does not close T-C7 |

The stale-test pass updated 27 existing expectations to the 2a contracts (transient defaults of
503, `AccountListInvalidError` for malformed config, registry 503 for an unreadable legacy file,
request-scoped sign contexts, the 13-name fault list) and re-ran a 28th
(`codex-reset-logout.test.ts`) unchanged after the `CodexPoolHalf` login/logout fix. No row moved
from red to green by weakening an assertion.

**Open, and gating:**

- **D8** and every row that needs it: V5, V5b, V6, V7, V7b, T-C7 (closure), T-M3, T-L1, plan cases
  S2 and S3. Gates Phase 2b; Phase 2a shipped in v14.5.0 without it.
- **The built-binary harness** below has not been run for any row: no `--version` pinning, no
  Claude Code transcript, no `accounts.jsonl` three-source agreement. E20's executable parity is
  unverified.
- **Real logins:** done on 2026-10-22: a second owned Codex login, `second` (plaintext 0600
  store), added beside the legacy `default`; legacy enrollment by `account disable codex default`
  and the `claudish logout codex` refusal while the pool is configured; an owner-run two-account
  exercise (`default` read `7d 41%` after one turn; with `switchAt` at 30% the next turn selected
  `second`, `5h 0% · 7d 0%  active`). Still open: a real re-login (`account login codex <label>`)
  and rotation on a real quota 429, which is never forced.
- Rows outside 2a's scope are unchanged: P3/P4 rows (V4, V12–V13c, V15, V18 request half),
  V2–V2f and V9–V10b as two-process runs, V3/V3b as concurrent processes, T-C4, T-C5, T-U2, T-U8.

## Scripted scenarios

| Row | Scenario and what must hold | Mutation that must turn it red | Needs | Covered today |
|---|---|---|---|---|
| **V1** | **The rotation sign throws** (Codex). Pool of two: A fresh, B pre-exhausted. A returns a quota 429. Exactly **1** main-turn attempt; A marked exhausted; `signRequest({exclude:[A]})` finds nothing and throws `AllAccountsExhaustedError` **inside the `:695` catch**; the quota seam (`respondAccountsQuotaFailure`) returns **400** with `upstream_status` 429, no verdict header, and the pinned F5 message listing A's and B's resets; `signed_arm: subscription` throughout | **Remove the `try/catch` around the `:695` swap** → the throw reaches `proxy-server.ts` and ends as `wrapAnthropicError(500, …)`. The row asserts 400-versus-500 explicitly. (Rewritten in revision 3; the earlier V1 was dead three ways) | P2 | the pool now names every account's real state, the excluded one included (B8) |
| **V1c** | **Already-exhausted pool** — the *initial* sign throws. Every account seeded `exhaustedUntil` in the future; one turn. The initial `signRequest` throws; **zero** upstream main-turn attempts; canary zero; the transcript carries the pinned message | **Wrap `signRequest`'s `getRequestAuth` in `try { … } catch { return apiKeyArtifact }`** → the canary records one request. The flagship transport-sited billing row | P2 | `pool.test.ts`: "stays true when every configured account is exhausted and never reads token material" (the predicate half) |
| **V1d** | **Token-store read FAILS**, not empty: `store-read-throws`, one account, valid api-key canary. `isAvailable()` stays **true**; canary zero; the run fails with `RefreshUnavailableError` → 401-class, never a metered success | **Put the swallow inside `CodexPoolHalf.isAvailable()`** — `try { read material } catch { return false }`, where the never-throws contract pushes an implementer — **and require the canary to record exactly one**. (Re-sited in revision 3: `CredentialAuthority.isAvailable` is not on the sign path) | P2 | `token-store.test.ts`: "a keychain read failure throws and is never reported as absence" |
| **V1b** | **The redundant net fires**: guarded `non-oauth-artifact` supplies an `arm: "api-key"` artifact for the metered canary before the pre-record check, at initial, rotation and forced signing independently. `MeteredEscapeError`, terminal 400, no poisoned arm record and zero canary contacts. Separately exercise the handler backstop with an actually recorded metered arm: exact 400 returned, no continuation | Remove the exercised pre-record check; separately remove the handler backstop or OAuth latch/composite dispatch. An escape mutation must actually contact its canary, not merely lose the arm while retaining the OAuth endpoint | P2a: done in-process | H `E17-*` (see *Phase 2a coverage*): guard-escape and post-record mutants executed |
| **V1e** | **Account-list read FAILS — `config.json`**: a pooled Codex account is configured, then `config.json` is truncated, then `chmod 000`. The registry reports **failed**, not absent; with a last-known-good list the turn proceeds on the pool; a fresh process with none fails with `AccountListInvalidError` (truncated: terminal 400, `upstream_status: 400`, naming the file) or `AccountListUnavailableError` (`chmod 000`: transient 503, `upstream_status: 503`). Canary zero in **both** passes | **Have `registry.ts` read through `loadConfig()`** → its catch returns `DEFAULT_CONFIG`, the predicate is false, and the canary records one | P2a: done in-process (E10) | H `E10-config-*` and `E10 config <EACCES\|EMFILE\|EIO> …`; `registry.test.ts`: "keeps present, absent, and failed config outcomes distinct", "serves the last-known-good config account list after truncation", "throws rather than returning an empty account list when config.json is unreadable"; `account-command.test.ts`: "status refuses to describe an unreadable account list as zero accounts" |
| **V16b** | **The legacy file is unreadable**: no `subscriptionAccounts`; `codex-oauth.json` present but unusable (truncated `{`, empty, `chmod 000` on the file, `chmod 000` on `~/.claudish`, and an `EMFILE` through the seam). Enforced in **two places**. **The live request path (built):** `CodexOAuth.hasCredentials()` stays **true**, so `CodexOAuthHalf` keeps the composite on the OAuth half, and the turn fails with an inline 400, `upstream_status: 401`, naming the file and `claudish login codex`. A transient failure clears on the next request with no restart. **The pool (built in 2a, and consulted first):** the registry reports **failed**, serves the last-known-good list, or throws `AccountListUnavailableError`, a transient 503 with `upstream_status: 503` naming the source (the disclosed N6 exception; the singleton's 400 no longer reaches the client). In both, absent (`ENOENT`/`ENOTDIR`, or a file naming no refresh token) stays distinct from failed, and the canary records zero in every pass | Live half: **revert `hasCredentials()` to `credentials !== null && !!refresh_token`**, which drops the recorded-failure disjunct → the failed file reads as absent, the api-key half signs, and the canary records one. Second mutant: **restore `existsSync(credPath)` as the absence test** in `readRawCredentialFile` → the `chmod 000 ~/.claudish` pass reads as absent and the canary records one. Pool half: **collapse `failed` into `absent` in `registry.ts` `refreshLegacy`** → the predicate is false and the canary records one. The revision-3 mutant, "route the legacy disjunct through `hasCredentials()`", is **dead** since the V16b fix: that method now answers true, and the turn fails before any vendor is contacted | Live half: none at unit level; the canary run needs the harness (P2). Pool half: P2 | Live half: no test yet (seam `_setCredentialFileReaderForTests`). Pool half: `registry.test.ts`, "keeps absent and failed legacy credential outcomes distinct" and "serves the last-known-good legacy account list after the file becomes unreadable" |
| **V2** | **Refresh race, N = 4 independently spawned OS processes** in one 200 ms window against a seeded expired token. Exchange count **=== 1**; all four exit 0; final generation = seed + 1; zero `needsReauth` | **Make `acquire()` succeed without `O_EXCL`** → 4 exchanges, 3 `invalid_grant`. (Revision 1's "proceed unlocked on acquire timeout" is deleted: four contenders serialize without timing out; V2c owns that property) | P2 | `file-lock.test.ts`: "serializes four independently spawned OS processes"; `token-manager.test.ts`: "serializes four OS processes against a rotating endpoint and never refreshes unlocked" |
| **V2b** | **Dead lock holder**: the lock seeded with a not-running pid, `at` well inside the 60 s TTL. The next process steals **immediately**, inspects the journal, completes one exchange; wall clock < 5 s and a successful turn | **Remove dead-holder detection** → it waits the full 20 s and fails with `RefreshUnavailableError` — visible as both delay and failure | P2 | `file-lock.test.ts`: "steals a fresh same-host lock when its process is provably dead" |
| **V2c** | **Acquire timeout**: `lock-hold-forever` pins the gate with a live, heartbeating holder past 20 s. The waiter re-reads uncached; with no newer generation it fails with `RefreshUnavailableError` (no quota wording). **Zero exchanges from the waiter** at the counting endpoint | **Let a timeout fall through to an unlocked refresh** → the waiter's exchange appears and the holder's token is revoked under it | P2 | `token-manager.test.ts`: "fails closed when the refresh gate is unavailable and never exchanges unlocked" |
| **V2d** | **Unwritable lock directory** (`chmod 0500` on `locks/`). Refresh is **disabled**: `RefreshUnavailableError` ("refresh disabled"), zero exchanges | **Restore "any non-`EEXIST` error → degrade to unlocked"** → an exchange occurs with no exclusion | P2. The design also has `account status` print "refresh disabled: <reason>"; the read-only CLI does not yet | `file-lock.test.ts`: "withFileLock fails closed or proceeds unlocked only when explicitly requested" |
| **V2e** | **Keychain memo bypass**, run with `CLAUDISH_KEYCHAIN_FILE` on a throwaway keychain (created **and unlocked**) and **without** `CLAUDISH_DISABLE_KEYCHAIN`. Two processes; the second's post-acquire re-read lands < 3 s after its first read. Exchange count === 1; the second reads the **new** generation | **Route `KeychainTokenStore`'s token reads through the memoizing helper** (`MEMO_TTL_MS = 3000`) → the second exchanges a revoked token. Deterministic CI sibling: U4b | P2 and a throwaway keychain. **Conditional**: the memo is per-process, so the timing precondition must be pinned | — |
| **V2f** | **Fencing**: `steal-lock-mid-exchange` re-creates the holder's lock under a different nonce while its exchange is in flight. The holder's fence fails before persisting; it **does not write** and throws `RefreshUnavailableError`; the store holds one coherent generation | **Release and fence on `pid` alone** → the stolen-from holder persists over its successor's rotation | P2 | `file-lock.test.ts`: "fence and release compare host, pid, and nonce" |
| **V3** | **Threshold switch, genuinely concurrent**: process A's turn observes 0.92; **1 s later** an independently spawned B starts a turn. B selects a **different** account, with the same `prompt_cache_key`/session id as A and a different bearer | **Restore blanket 5 s coalescing for selection-relevant changes** → B reads the pre-crossing state | P2 | `policy.test.ts`: "switches when any live window crosses its own threshold" (the policy half) |
| **V3b** | **Staleness does not resurrect an over-threshold account**: A seen at 0.92, then 20 min, no window reset. A is still skipped and does not become `unknown` | **Restore "snapshots older than 15 min count as unknown, and unknown is eligible"** → A is re-selected before its window resets | P2 | `policy.test.ts`: "does not decay a stale over-threshold reading into unknown before reset" |
| **V4** | **429 retry byte-identity** (native): B returns 429 + `unified-status: rejected` + reset; C serves. **Same body hash, different bearer**; exactly 2 main-turn attempts; B's `exhaustedUntil` equals the header reset | **`[unmutatable]`**: re-`JSON.stringify` of an unchanged object is byte-identical by language guarantee, and `transformPayload` is idempotent. Kept as a regression detector against a future non-idempotent transform (a nonce or timestamp in the payload) | P3 | Phase 0 (f) hoisted `const body`; that hoist is also unmutatable until Phase 3 adds a second send |
| **V5** | **In-stream quota** (Codex, pooled, second account eligible): metadata events, then `usage_limit_reached`, before any delta. Exactly 2 upstream connections; only the **second** connection's SSE bytes form a complete stream head; no `[API Error]`; no duplicated prefix; the first reader cancelled | **Drive the retry from `settleResponsesStreamHead`'s captured `doFetch` closure** → the second connection carries the **same** bearer. Re-check when Phase 2 lands: fix A3 made `doFetch` read `activeEndpoint`/`activeHeaders` at call time, so the mutation fires only if the quota path does not re-bind them | P2, D8 | — |
| **V5b** | **Sniffer ordering**: the frame reads "You've hit your usage limit. Try again after 14:32". Classified `quota` and rotated; elapsed < 5 s | **Move the quota test after `isRetryableStreamError`** → the row goes red. The predicted failure mode is provisional (T-L1): "Try again after" matches no alternative of the retryable regex, so the mutant returns `clean` and surfaces inline rather than burning 3 s + 15 s + 30 s and a 503 | P2, D8 | `stream-head-sniffer-quota.test.ts`: "classifies usage quota before the retryable api_error type" |
| **V6** | **Quota past the old wall clock**: the quota event arrives after ~40 s of metadata events 3 s apart. Still classified `quota`, still rotated | **Restore a hard 30 s wall-clock ceiling** → the stream is handed to the parser at 30 s and the error lands in the transcript | P2, D8 | — |
| **V7** | **Content before quota, negative**: a content delta, then `usage_limit_reached`. **No** rotation, **no** duplicated prefix; the error surfaces inline | **Remove the "quota verdict is unreachable after a content delta" guard** → the row rotates and duplicates the emitted prefix. **Contested** (T-V7): the sniffer returns `clean` at the delta, so the quota frame may never be read | P2, D8 | `stream-head-sniffer-quota.test.ts`: "replays an ordinary content event byte-for-byte". The Phase 0 test author found deleting only the `sawOutput` guard is a dead mutation against the built sniffer |
| **V7b** | **N6 latency negative**: a **non-pooled** Codex stream (one account) emits an unrecognised metadata event, then normal content. Headers reach the client within the 12 s budget; behaviour is byte-identical to today | **Apply the extended watch unconditionally** → headers are withheld until the first delta on a healthy turn. **Contested**: "within 12 s" can pass in both modes unless the next event is held past the idle interval (T-M3) | P2 | — |
| **V8** | **Second HTTP attempt also 429**, pool of two. The second account is marked exhausted; no third send; the F5 message lists **both** resets | **Read "treat the retry as final" as "do not record its outcome"** → the second account stays eligible and is re-selected next turn | P2 | — |
| **V8b** | **Retry budget spent with an account still eligible (Phase 2a R4)**, pool of three; the first two quota-reject. Exactly two inference contacts; both accounts marked; return 429 `rate_limit_error`, upstream 429, `x-claudish-auth-verdict: transient`, fixed non-quota message `Codex account retry deferred; retry this request.` No pinned message or per-token warning. Seed the third account with an expired token: the read-only query makes zero token-store reads/exchanges/leases and leaves active=B; the next request may select C. With C disabled instead, return the real mixed exhausted error including C and denominator `(3 of 3)` | Independently **return B's vendor quota wording** → metered-next contact despite remaining capacity; **emit exhaustion on retry count** → a false all-accounts claim; **call acquire/refresh/heal/setActive in the query** → expired C exchanges or active changes; **drop disabled rows/request lease-failure evidence** → incorrect blockers/denominator | P2a: done in-process | H `E4 spent rotation …`, `E4-disabled …`; the store-read mutant executed, the heal/acquire/`setActive` and lease-failure variants not |
| **V9** | **Persistence faults**: `persist-throw`, `crash-after-refresh`. A later process recovers through the journal, or reports `needsReauth` with `lastReason === "a token rotation was interrupted"` — exactly | **Remove the journal** → the follow-up process reuses the revoked token and records a generic `needsReauth`, failing the exact-reason assertion | P2 | `token-manager.test.ts`: "does not retain a refreshed token in memory when its final persist fails" (U5) |
| **V9b** | **Ambiguous write, both directions**: `persist-timeout-committed` and `persist-timeout-uncommitted`. Committed → re-read uncached, see it, clear the journal, **return the new token**; uncommitted → `journal.state = "unknown"` and `PersistOutcomeUnknownError`. No full record is written before the re-read | **Write the pre-write record back with only `journal.state` changed** (revision 1) → the committed case loses the rotation and the next process gets `invalid_grant`. Built detail: the commit test is the per-persist `writeId` (fix B7), not generation or fingerprint | P2 | — |
| **V10** | **`needsReauth` self-heals against a baseline**: seed `needsReauth` with `failedFingerprint` F1 and `failedGeneration` g, retry NOT due. **(a)** The store holds F2, as after a re-login: the next `acquire()` selects the account with **zero** exchanges, and `state.json` no longer carries the mark. **(b)** Another process persists F1 at generation g + 1, a non-rotating refresh: the same. **(c)** The store still holds F1 at g: the account stays blocked until its retry is due, then exchanges exactly once. **(d)** Another process records a new failure against F2 between the heal's read and its write: that mark survives | **Make `reauthMaterialMoved` return false** → (a) and (b) stay blocked for the retry interval. **Remove `healReauthMarks()` from `acquire()`** → (a) waits for the retry, because the token manager's own check runs only on a leased account. **Drop the `failedAgainst` guard from `mergeNeedsReauth`** → (d)'s newer failure is erased. **Drop `failedGeneration`/`failedFingerprint` from the record** → nothing ever heals, since a missing baseline is no evidence | The two-process run: P2. The unit half runs today against `AccountPool` with a fake store and a temp `StateStore`. **Built** 2026-09-24 | — |
| **V10b** | **`needsReauth` is gate-holder-only**: A takes the gate and begins an exchange the fake answers `invalid_grant`; `steal-lock-mid-exchange` replaces A's nonce during it. A writes **no** `needsReauth` (its fence fails) and throws `RefreshUnavailableError` | **Remove the gate-ownership check on the `needsReauth` write** → A, now a non-holder, writes the flag while the new owner rotates. (Revision 2 used `lock-hold-forever`, under which nobody exchanges, so the row was dead) | P2 | built by fix B10; no unit test |
| **V11** | **`:695` emits no false failure**: a quota 429 retried successfully on another account. stderr has **no** `Error [Codex]: HTTP 429` and no `Auth/health check failed`; `recordStats` records `success: true` | **Move quota detection to the terminal-remap block (`:961`)** → a red line on the shared file descriptor and a false failure. Second mutation: **call `mapAccountsError()` after the catch's `logStderr`/`reportError` instead of first** | P2 | — |
| **V12** | **SUPERSEDED** for the account in Claude Code's item by the switch rule (2026-10-29): claudish never refreshes that account. This row applies only if a later Claude Code build stops honouring the locks (the D1/D2 table's fallback branch); MTL-263 must replace it with switch-rule cases. **Named refresher, no live `claude`**: X has `owner: "claude-code"`, an expired access token, nothing holding `.oauth_refresh.lock`. claudish refreshes X after taking `.oauth_refresh.lock` and writes **both** stores; X stays eligible | **Restore "delete claudish's refresh token; only Claude Code refreshes it"** → X is skipped from its first expiry. On the branch that cancels `account use`, assert instead that `use` and `import` both refuse with the manual instruction | P4 | — |
| **V12b** | **SUPERSEDED** for the account in Claude Code's item by the switch rule (2026-10-29), as V12; MTL-263 must replace it with switch-rule cases. **Out-of-band rotation found in the RIGHT store**: a rotation seeded into Claude Code's item only. The re-read reads **both** stores, adopts the new material, retries once, writes **no** `needsReauth` | **Re-read only claudish's own record** (revision 1) → the case is classified "revoked" and a working shared account is marked `needsReauth` with no self-healing trigger | P4 (the detector's `secondaryStore` seam is built; the Claude Code store is not) | `token-manager.test.ts`: "recovers an invalid_grant rotation race by re-reading and retrying the new material" (the single-store half) |
| **V12c** | **SUPERSEDED** for the account in Claude Code's item by the switch rule (2026-10-29), as V12; MTL-263 must replace it with switch-rule cases. **Dual-store refresh crash**: `crash-after-first-store-write` during a post-handoff refresh. Recovery reads `journal.committed`, copies from the committed destination to the uncommitted one, clears the journal; both stores end on one generation and fingerprint | **Omit `journal.committed` from the dual-store journal** → recovery cannot tell which store committed | P4. **Contested**: its baseline is undefined until T-C5 runs (T-V12c) | — |
| **V13** | **Handoff abort on decline**: the user declines adopting Y. The handoff aborts; Claude Code's item unchanged; Y intact; no in-flight handoff reported | **Restore "adopt or ask, then write X regardless"** → Y is overwritten after a decline | P4 | — |
| **V13b** | **A crashed handoff resumes**: killed between the adopt and the write. `account status` reports "handoff 2/4 — pending write"; the next `account use` completes idempotently | **Remove the handoff journal** → the crash is invisible and the next run starts from an inconsistent state | P4 | — |
| **V13c** | **No lock is held across a human**: the prompt instrumented to take 90 s. No gate is held while it is open; a concurrent request that must refresh X succeeds; the handoff then re-reads X uncached and writes the **current** material | **Acquire the gates before prompting** (revision 1) → the concurrent refresh steals the 60 s-stale gate, and the handoff writes a stale X whose read-back still passes | P4 | — |
| **V14** | **Account-list reload**: a `serve` process runs; another process disables an account. `serve` stops selecting it within one request, **and** the billing probe in that process stops reporting it | **Refresh the probe's oracle only on this process's own mutations** → `serve` keeps signing a disabled account and the picker still shows `SUB` for a removed pool | P2 (the probe does not read the registry yet) | the registry re-stats both documents on every answer; `AccountRegistry.invalidate()` forces a re-read |
| **V15** | **Vendor isolation in ONE HOME**: one temp HOME, both claudish providers configured, the **same generated 12-character id seeded under both**. Lock and token paths do not collide; a Codex refresh does not block a Claude refresh; neither token file is overwritten | **Drop the provider namespace from the lock and token paths** → the two accounts share a lock and a token file. (The row cannot use the id `default`, which `^[a-z0-9]{12}$` forbids) | P3 | the provider-namespaced paths are built (`paths.ts`); no test |
| **V16** | **N6 baseline, legacy single Codex OAuth**: `codex-oauth.json` only, no `subscriptionAccounts`. Endpoint, headers, payload transform and error shape are byte-identical to the baseline build on the same fixture | Four named mutants (T-V16), each asserted separately: **remove the OAuth endpoint override**; **omit an OAuth header**; **drop the payload transform**; **change the terminal-error remap** | P2. The baseline must be the post-A4 build: fixes A2 and A4 changed the legacy error shape on purpose (a failed refresh is an inline 400, never metered) | — |
| **V17** | **N6 baseline, Codex api-key only**: no pool, no legacy file, `OPENAI_CODEX_API_KEY` set (the canary is off; the key is the subject). `isAvailable()` false; the api-key half signs; `api.openai.com`; `recordSignedArm` records `metered` | **Make `isAvailable()` true when no account is configured** → a pooled path is attempted for a metered user | P2 | — |
| **V18** | **N6 baseline, native pass-through with no pool**: zero Claude accounts configured. The inbound `authorization` is forwarded verbatim. On the response, every `anthropic-ratelimit-*` header (the discovered `unified-<window>-*` names included), plus `retry-after`, `request-id` and `x-request-id`, is **passed through on both the streaming and the JSON branch** (Phase 0 fix (f)), with the upstream status unchanged; any other upstream header is not. Revision 3 required these headers to be DROPPED. Phase 0 (f) reversed that, because the Phase 3 pool reads them | Request half: **activate the pool when zero Claude accounts are configured** → the inbound header is stripped and a pool bearer substituted. Response half, each red on its own: **collect the pass-through set on one branch only** → the other branch drops the plan-window headers; **match a fixed list of window names instead of the `anthropic-ratelimit-` prefix** → a discovered window such as `unified-7d` is dropped; **forward every upstream header** → a header outside the set, such as `x-private-upstream`, reaches Claude Code | Request half: P3. Response half: runs today at unit level | Response half: `native-handler.test.ts`, "passes rate-limit, retry, and request ids through the JSON branch" and "passes the same header set through the streaming branch". The request half: no test asserts the forwarded `authorization` |

Each scenario fails once and then serves a complete turn, so a retry loop cannot pass by accident.

### Acceptance: three independent sources must agree

1. `accounts.jsonl` (`CLAUDISH_ACCOUNTS_LOG`, Phase 2) records
   `{req, provider, account, reason, prev, signed_arm}` for the switch.
2. The fake server's log shows the change reached the wire, by row class:
   - **retry rows (V1, V4, V8):** the same body hash with a different bearer;
   - **threshold rows (V3):** the same `prompt_cache_key`/session id with a different bearer — the
     switch happens before the next turn, whose body necessarily differs;
   - **in-stream rows (V5):** the SSE bytes emitted per connection, where only the second forms a
     complete stream head.
3. The Claude Code transcript shows a normal answer with no error text and no truncated turn —
   except V1, V1c and V8, which must show the pinned all-accounts message, and V8b, which must show
   the marked transient non-quota 429 from V8b and **not** the vendor quota or pinned message.
   Phase 2a stream verdicts follow the same capacity rule after marking, without a rotation;
   the two-connection stream rows above remain Phase 2b/D8-only contracts.

**Standing on every row:** the metered canary recorded zero requests.

## Unit rows

| Row | Property | Mutation that must turn it red | Covered today |
|---|---|---|---|
| **U1** | `policy`: sticky; threshold; soft threshold; all-exhausted; reset-passed; unknown eligible; a known over-threshold reading survives staleness; **`unknown-failed` eligible but ranked last** | remove the last-rank rule → an unreadable account outranks a known-good one | `policy.test.ts`, all eight tests |
| **U2** | `state-store`: field-wise read-modify-write **re-read inside the lock**; `exhaustedUntil = max()`; `owner`/`handoff`/`active` compare-and-set | **persist the snapshot taken before acquiring the lock** → A's `exhaustedUntil` is erased by B's usage write | `state-store.test.ts`: "two writers preserve independent fields and newest observedAt wins" — sequential; T-U2's barrier not added |
| **U2b** | a reapplied `active` whose target another process deleted | skip the account-list existence check on reapply → `active` names a deleted account | `state-store.test.ts`: "active compare-and-set re-reads and refuses to reapply a deleted target" |
| **U3** | unreadable and corrupt files read as `unknown-failed`, never "all fresh", and are never overwritten; a corrupt file moves to `state.json.corrupt-<ts>` | collapse the read-failure branch into "nothing is exhausted" | built (fix B2); no test |
| **U3b** | `state.lock` failure drops a coalescible update **silently** and surfaces a selection-relevant one in `account status` | make both silent → an unpersisted exhaustion leaves no diagnostic; make both fail the turn → a late usage write kills a request | `file-lock.test.ts`: "refresh gate fails closed while state lock returns null" (the null half) |
| **U4** | `token-manager`: generation short-circuit | remove the post-acquire uncached re-read → an extra exchange | `token-manager.test.ts`: "re-reads uncached after taking the gate and skips an exchange another holder completed" |
| **U4b** | uncached reads bypass the 3 s memo, via `setKeychainTestDeps` and a recorded transcript returning a stale value inside the window | route token reads through the memoizing helper → the stale token is exchanged. Deterministic sibling of V2e | built (`readKeychainItem(…, {uncached})`); no test |
| **U4c** | journal recovery from `refreshing` and from `unknown` | remove the recovery branch → a crashed predecessor's journal is ignored and the revoked token re-exchanged | built; no test |
| **U4d** | a fingerprint change ⇒ retry once with the new material | remove the retry → out-of-band rotation is classified as revocation | `token-manager.test.ts`: "recovers an invalid_grant rotation race by re-reading and retrying the new material" |
| **U4e** | a rejected exchange closes its journal: after a plain `invalid_grant` the store holds the presented material with no `journal` and the same `fingerprint` and `generation`; the due retry exchanges once even with a fresh-looking access token, and `lastReason` stays "the vendor rejected the refresh token …", never "a token rotation was interrupted". A recovery's `invalid_grant` records the interrupted reason and keeps it on the next retry | **drop `closeAnsweredJournal` from the cause-3 branch** → the second attempt reports "a token rotation was interrupted". **Drop `markedDead` from `resolve`** → the due retry returns the stored bearer with zero exchanges. **Recompute the reason on every failure** → the interrupted rotation's second attempt reads "the vendor rejected" | built 2026-09-24; no test |
| **U5** | a persist that throws leaves **no** usable token in the caller's hands, in the same process: the promise rejects and the in-memory record is unchanged | cache and return the new token on persist failure. (One process on purpose: no process can observe another's heap) | `token-manager.test.ts`: "does not retain a refreshed token in memory when its final persist fails" |
| **U6** | `needsReauth` requires **gate ownership** | write it without checking ownership → a non-holder can set it | built (fix B10); no test |
| **U6b** | `needsReauth` requires an **uncached read of every store** holding the account first | read only the cached claudish record → V12b's defect at unit level | built through `secondaryStore`; wired in Phase 4 |
| **U6c** | the retry schedule is exactly **1 min → 5 min → 30 min floor** | collapse it to a flat 30 min; the row asserts each interval | built (`reauthRetryDelayMs`); no test |
| **U7** | `refresh-lock`: acquire timeout ⇒ `RefreshUnavailableError` and zero exchanges; dead-pid steal; 60 s stale steal; heartbeat over the **whole** hold; **a cross-host holder is never stolen from** | each of the five, individually | `file-lock.test.ts` ("steals a fresh same-host lock…", "steals a stale same-host holder…", "never steals a foreign-host holder", "heartbeat renews the holder for the entire hold"); `token-manager.test.ts` (fail-closed) |
| **U7b** | release and fence compare **`{host, pid, nonce}`** | compare `pid` alone → a stolen-from holder frees its successor's lock and persists over it | `file-lock.test.ts`: "fence and release compare host, pid, and nonce" |
| **U8** | construct **`new KeychainTokenStore()` directly** under `CLAUDISH_DISABLE_KEYCHAIN=1` and assert zero `run` calls | remove the store's own disable check → `run` is called. **Contested** (T-U8): construction alone need not call `security` | `token-store.test.ts`: "KeychainTokenStore honors its own disable flag without invoking security" — a read is asserted; T-U8's write is not |
| **U8b** | under `CLAUDISH_KEYCHAIN_FILE`, with no disable flag, the store stays **Keychain-backed** and every `security` call carries the file as its trailing argument | make `CLAUDISH_KEYCHAIN_FILE` select `FileTokenStore` (revision 1) → a macOS user setting the isolation variable silently gets plaintext, and V2e becomes impossible | built; no test |
| **U8c** | a read failure **throws**; only a confirmed absence returns `null` | return `null` on failure → V1d's defect at unit level | `token-store.test.ts`: "a keychain read failure throws and is never reported as absence" |
| **U9** | `hasConfiguredAccounts()` stays true when every account is exhausted, when every account needs re-auth, **and when every store read throws** | compute it from stored material → the throwing case returns false | `pool.test.ts`: "stays true when every configured account is exhausted and never reads token material" (the exhausted case) |
| **U9b** | `registry`: a read **failure** is distinct from **absence** for **both** inputs — `ENOENT` ⇒ absent ⇒ false; any read, parse or schema error ⇒ failed ⇒ last-known-good, else **throw** `AccountListUnavailableError` | **collapse failed into absent** for either input. Second mutation: **return `false` instead of throwing when there is no last-known-good** | `registry.test.ts` (five tests); `pool.test.ts`: "throws on an unreadable account list instead of returning false" |
| **U10** | wording: `hasQuotaExhaustionWording(buildExhaustedMessage(f)) === true` **and** `isRetryableError(400, buildExhaustedMessage(f)) === true` | edit "usage limit" out of the template → a bare chain stops dead and the cost warning never fires | H `E7 bare-name exhaustion reaches the metered socket …` pins the advance end to end; no unit test of the template wording itself |
| **U11** | concurrent identity: two `handle()` calls with **explicit barriers** forcing A signs, B signs, A reports, B reports | store account identity on the handler or transport → A's outcome lands on B's account | the signing half: `composed-handler-auth.test.ts`, "keeps auth identity request-scoped under an explicit two-request barrier". The reporting half is Phase 2 |
| **U12** | sniffer: quota classified before `isRetryableStreamError`; the verdict cancels the reader and carries no response; unreachable after a content delta; **`extendedQuotaWatch: false` differs from today in exactly one way** — a quota frame is classified, reported and marked, never rotated — and is otherwise byte-identical | each of the four. The fourth takes two, one per direction: **make false mode pure-legacy** (drop the quota test) → the second stream never marks the second account; **make false mode rotate** → a one-account user's quota triggers a rotation with nowhere to go | `stream-head-sniffer-quota.test.ts` (four tests); `composed-handler-quota.test.ts`. The rotation direction is Phase 2 |
| **U13** | probe: returns `boolean`, spawns nothing over 1 000 calls, **`true` for a pool-only account and `false` after it is removed** | replace the probe with `() => false` → it passes type and zero-spawn checks and fails the positive case | B `E11/M4 …` (presence both ways); the 1 000-call zero-spawn half not written |
| **U14** | billing: `signRequest` propagates `AllAccountsExhaustedError`; the quota seam returns 400 with `upstream_status === 429` and no verdict; every other accounts error gets its terminal/transient verdict without the billing probe being called | **wrap `getRequestAuth` in a catch returning the api-key artifact** → the error never propagates | H `E8 <site> <class> …` at five sites (2a). Related: `openai-codex-request-auth.test.ts` |
| **U15** | a failed `state.json` write from outcome reporting is **logged and surfaced**, never swallowed | route reporting through `capturePlanUsage`, whose body is `try { … } catch { /* Non-fatal */ }` → no diagnostic | O2 `E19 <persist\|report\|log> failure …` (2a) |
| **U16** | taxonomy: each error's `terminal`, `transient`, `upstreamStatus` and wording match `accounts.md`'s table: the three transient classes default to upstream 503, keep an explicit 429/5xx, reject 401 with `RangeError`, and a marked transient response does not advance (`isRetryableError` false); `hasQuotaExhaustionWording(refreshUnavailableMessage) === false`. (Restated 2026-10-22: the earlier "401 so the chain advances" half is superseded by the verdict header) | restore a fixed 401 default → `Expected: 503, Received: 401` (executed in E8); give `RefreshUnavailableError` quota wording → a transient disk error passes for exhaustion | `errors-regression.test.ts` U16 rows (updated 2026-10-22); `pool.test.ts` no-quota-wording rows |
| **U17** | `usage/codex`: a real header set with non-zero `window-minutes` yields `slot: "primary"` **and** `displayId: "7d"`; `switchAtByWindow` keys on `slot` | key thresholds on the formatted id → per-window Codex thresholds never match production headers | `usage/codex.test.ts`: "keeps slot identity separate from the reported window duration" |
| **U18** | config read-modify-write: a corrupt config under the lock is a **refusal to write**; unknown and unrelated fields survive a successful write | reuse `loadConfig()` inside the write → the corrupt document reads as `DEFAULT_CONFIG` and `account add` overwrites every profile | Phase 2 (`account add`). Related: `profile-config-subscription-accounts.test.ts`, "survives load followed by an unrelated save" |

## Settling tests carried from plan review

Round 3 left findings where the two reviewers disagreed, or where running code is a cheaper arbiter
than prose. The rule for each: **the test decides, not the document and not either reviewer.** The
letter in each id is the round-3 finding it settles (`T-C4` settles C4).

| Id | What it settles | The test | Status |
|---|---|---|---|
| **T-C4** | Does "fence immediately before the persist" close the window, or must the persist consume the nonce atomically? | `steal-lock-after-fence` replaces the nonce **between** the fence read and the write (V2f steals earlier and cannot see this window). Assert one coherent generation and that the fenced-out holder wrote nothing. If it fails: rename onto a path that embeds the nonce | fault wired; not run. The current code writes in that window by construction and logs "(T-C4 window)" |
| **T-C5** | Must `journal.committed` be appended **before** each destination write? | Extend V12c with a crash before and after each `committed` append (four points). Both stores must end on one generation and neither may hold a revoked token. Expected outcome: `committed` is redundant, reduce it to an `open` flag and reconcile from each destination's real fingerprint | **SUPERSEDED** for the account in Claude Code's item by the switch rule (2026-10-29): runs only if a later Claude Code build stops honouring the locks (the D1/D2 table's fallback branch). MTL-263 must replace it with switch-rule cases |
| **T-C7** | May the entry gate suppress **marking** when no other account is eligible? | A pooled run with **one** account and an in-stream quota frame: `exhaustedUntil` is written and the F5 message can list it | wiring passes on scripted frames (H `S1-one …`); closure waits on D8 |
| **T-V7** | Does V7's mutation name the content boundary or a downstream guard? | Run the mutation as written and observe whether the sniffer ever reaches the quota frame. If not, the mutation becomes "treat a content delta as non-decisive and keep sniffing" | evidence so far: dead against the Phase 0 sniffer |
| **T-U8** | Does constructing the store prove anything? | After construction, perform a **read and a write**, then assert zero `run` calls and file-store behaviour | the read is asserted; the write is not |
| **T-U2** | Is U2's interleaving enforced? | Add the barrier — B reads, blocks, A writes, B acquires — and assert the order before asserting A's `exhaustedUntil` survived | not added |
| **T-V16** | V16's mutation was a description, not a mutant | Replace it with the four named mutants in V16 | adopted in the row; not run |
| **T-V12c** | V12c's crash can land where recovery is undefined | Settled by T-C5; rewrite V12c against what T-C5 establishes | waits on T-C5 |
| **T-M3** | The pooled population has no latency assertion, and extended mode has no ceiling | Pooled, two eligible accounts, a healthy stream with an unrecognised metadata event then normal content: headers within the budget. Sharpen V7b to hold the next event past the idle interval. If real streams show long delta-free runs, add a logged 60 s ceiling | Phase 2, with D8 |
| **T-M4** | Can the billing probe and `isAvailable()` drift? | Assert they agree for a pool-only account, a legacy-only account, and a legacy file removed mid-process. Likely fix: the probe reads the registry's legacy term, not the singleton | **settled in 2a**: both read the registry's presence fact; B `E11/M4 …` |
| **T-L1** | Is the quota-before-retryable justification right? | D8's real capture settles the wording; correct V5b's predicted failure mode to match | at the D8 gate |
| **T-L2** | `RetryBudgetSpentError` is named but never surfaces | Give it a caller or delete it; verify the design's drifted citations | resolved in Phase 1 by not creating it; the citations have drifted further (see *How to read it*) |

## Phase 0 regression tests

The nine Phase 0 fixes (a)–(i) in [`accounts.md`](./accounts.md) sit outside the V/U matrix. Their
tests, written under the author/runner split:

| Fix | Tests | A mutation each catches |
|---|---|---|
| (a) atomic token save | `auth/accounts/atomic-write.test.ts` (three) | remove the explicit `chmod` → mode `0000` under the injected umask; restore `openSync(path, "w")` before `JSON.stringify` → a serialization fault empties the file |
| (b) file locks | `auth/accounts/file-lock.test.ts` (eight) | remove `O_EXCL` → four real child processes overlap; give both callers one implicit unavailable policy |
| (c) Codex 401 re-sign | `composed-handler-auth.test.ts`, `openai-codex-request-auth.test.ts`, `codex-credential.test.ts` | omit `forceRefresh: true`; keep the stale endpoint; re-sign the api-key arm |
| (d) request-scoped signing | `composed-handler-auth.test.ts`: the two-request barrier test | restore one shared cached artifact → request A carries B's bearer |
| (e) usage limit and quota verdict | `codex-usage-limit.test.ts`, `stream-head-sniffer-quota.test.ts`, `composed-handler-quota.test.ts` | move quota after the retryable classifier; make false mode pure legacy; drop the handler's quota mapping |
| (f) native headers | `native-handler.test.ts` (two) | spread headers on one branch only; enumerate fixed window names |
| (g) `count_tokens` | `proxy-server-count-tokens.test.ts` (three) | restore api-key-only signing; drop `res.status`; preserve a 401 instead of estimating |
| (h) Keychain service | `auth/claude-code-facts.test.ts` (four) | hardcode the unsuffixed service; hash the default directory; remove candidate breadth |
| (i) loopback override and faults | `test-upstream.test.ts` | accept a non-loopback target; keep half of a mixed-invalid map; arm a fault without a valid override |

Recorded as **not** mutation-covered, rather than covered decoratively:

- serializing the native body once is unmutatable while `NativeHandler` sends once (the V4 reason);
- deleting only the sniffer's `sawOutput` guard is a dead mutation (see T-V7);
- durability across a real power loss needs a syscall seam or a destructive crash harness;
- the two OAuth token-endpoint rewrite sites: removing their override would send a fake refresh
  credential to the real vendor.

`test-upstream.test.ts` pins the vocabulary: 13 unique names (`non-oauth-artifact` added in 2a),
every one of which arms, and none without a valid loopback override. Fix B10 changed the list from
its original 11 names, so a test that pins it by name must change with it.

## Live run on real accounts (Phase 5)

1. `account add` twice per claudish provider; a duplicate identity is refused; where `import` ships,
   the first `account add claude` must be the imported login; where it does not, the disjoint-pool
   startup line appears.
2. `account status` shows usage for an idle account, or `unknown` if idle polling stays off (D7
   measured positive on 2026-10-29, so the choice is open).
3. A forced switch with `switchAt: 0.01`, and the startup line naming the signing account.
4. `account use` while a real `claude` session runs: the switch holds `.oauth_refresh.lock`, the
   legacy lock and `.storage-write.lock` and finishes inside 7.5 s. The case is request-driven:
   send a request after the session's 30 s item cache has expired; it signs with the new account
   (D2 and D5 measured 2026-10-29).
5. **Four** concurrent claudish sessions produce exactly **one** refresh. Two sessions pass even
   when the lock is a no-op and are not evidence.
6. A `claudish serve` session with an account disabled from another process mid-session.
7. The all-accounts message on a genuinely spent account, with reset rendering and an `estimated`
   reset labelled.
8. **Keychain work targets a throwaway keychain** (`security create-keychain`, selected by
   `CLAUDISH_KEYCHAIN_FILE`) — never the login keychain.

## Gates and fixtures

Quality gates: `bun run format`, `bun run lint`, `bun run typecheck`, `bun run test:safe`,
`bun run build`, and `claudish --probe cx@<model>` from the built artifact showing the pooled
credential, with `--version` and the startup identity recorded before any result is read.

**Fixture rule.** Quota bodies and headers start PROVISIONAL. Phase V ran on 2026-10-29 and D8
remains open (MTL-261), so real captures from D8 and the live run replace them before release. **D8 — a real Codex `usage_limit_reached` frame with its
metadata prefix — gates Phase 2b**: a hand-written fixture without
the vendor's "try again" wording passes V5/V5b while real traffic fails, and the capture defines the
widened event set V6, V7 and V7b depend on.
