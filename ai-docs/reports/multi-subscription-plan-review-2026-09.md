# Multi-subscription accounts — plan review and code review, September 2026

**Scope:** the three multi-model review rounds of the design (2026-09-12 and 2026-09-13), the
test/implementation alignment of 2026-09-18, and the code review of commit `3ec7762b` whose fixes
were applied on 2026-09-24. **Summarised, not reproduced:** the raw reviews, consolidations and
changelogs live in the gitignored session
`ai-docs/sessions/dev-feature-multi-subscription-20260912-000000-a1b2/`, which does not survive
`git worktree remove`.

The design these reviews shaped: [`../architecture/accounts.md`](../architecture/accounts.md). The
scenario matrix they rewrote: [`../architecture/accounts-validation.md`](../architecture/accounts-validation.md).

## At a glance

| | Round 1 | Round 2 | Round 3 | Code review |
|---|---|---|---|---|
| Date | 2026-09-12 | 2026-09-12 | 2026-09-13 | fixes 2026-09-24 |
| Reviewers | claude-internal, gemini-3.8-flash, gpt-5.6-sol (minimax-m3 uncounted) | claude-internal, gpt-5.6-sol, gemini-3.8-flash | claude-internal, gpt-5.6-sol | — |
| Verdicts | FAIL, FAIL, FAIL | FAIL, FAIL, CONDITIONAL | FAIL, FAIL | — |
| Consolidated (C / H / M / L) | 7 / 15 / 14 / 7 (43) | 6 / 15 / 9 / 4 (34) | 7 / 3 / 4 / 2 (16) | 15 findings (A1–A5, B1–B10) |
| Outcome | revision 1: 21 of 22 C+H accepted | revision 2: 19 of 21 C+H accepted in full | revision 3: 5 fixed, the rest carried with a settling test | 15 confirmed, one stated symptom corrected |
| Wall clock, external tokens, cost | 979 s, 512.1k, $10.85 | 1 064 s, 182.7k, $3.00 | 701 s, 194.3k, free | — |

Costs are the team runner's figures for the external models only. Round 1: gemini-3.8-flash
$10.08, minimax-m3 $0.77, gpt-5.6-sol reported free; round 2: gemini $3.00; round 3: gpt-5.6-sol
only, reported free. Every verdict followed the threshold rule "FAIL: any CRITICAL · CONDITIONAL:
any HIGH · PASS: otherwise".

## Round 1 — the first design

| Reviewer | Verdict | C | H | M | L |
|---|---|---|---|---|---|
| claude-internal | FAIL | 3 | 9 | 9 | 4 |
| gemini-3.8-flash | FAIL | 3 | 4 | 4 | 2 |
| gpt-5.6-sol | FAIL | 5 | 6 | 5 | 1 |
| minimax-m3 | uncounted | — | — | — | — |

**minimax-m3 was excluded from every consensus count.** Its slot ended `shape_mismatch`: no
`**Verdict**:` line, a serialized tool-parameter block instead of a review, truncated at
`### H-2. H-2`. Its stderr shows why the run degraded — the MiniMax Coding plan returned `HTTP 429
… Token Plan usage limit reached`, the routing chain advanced past it with the "billed PER TOKEN"
warning, Zen Go answered 400, and OpenRouter served the rest. A review of a feature for switching
spent subscriptions was itself cut short by a spent subscription. Its recoverable findings (C-1 to
C-3, H-1, H-2) were used as supporting material only.

The two unanimous findings (3/3):

1. **An exhausted pool could still sign on the metered key.** The transport's
   `refreshAuth()` was `try { … } catch { this.cachedAuth = null }`, and a null artifact meant
   `api.openai.com` with `OPENAI_CODEX_API_KEY`. The design never closed that catch, so the likeliest
   new throw — exhaustion — landed on the branch the codebase already reads as "use the metered key".
2. **The extracted lock was fail-open.** The design reused the 1Password handshake lock, which runs
   its work unlocked on timeout and on any non-`EEXIST` error — right for a desktop handshake,
   catastrophic for a rotating refresh token.

Strong (2/3): `account use` was not an atomic or acknowledged transfer; the verification could not
fail on the billing and token-safety paths it existed to protect; rotation persistence was unsafe
under stale reads, ambiguous writes and post-refresh crashes. Divergent CRITICALs (1/3): a handed-off
account dies about an hour later; the 12 s sniff budget contradicted F4's pre-content retry.

**Revision 1** dispositioned all 22 CRITICAL and HIGH findings, each checked against the source
first: 21 accepted (two with the proposed remedy replaced), 1 rejected on evidence. The rejection:
two reviewers asked for a credential-layer change so `CodexPoolHalf` could not fall through, but the
composite only diverts on `isAvailable() === false` or a matching `fallbackSignal`, and
`makeCodexCredential()` passes none — it already rethrows. The fix belonged in the transport, where
the catch was deleted by name.

Six findings were contested between reviewers and decided by the architect:

| Contest | Decision |
|---|---|
| Severity of the fail-open lock (CRITICAL ×2 against HIGH) | CRITICAL upheld; the fix applies either way |
| The `invalid_grant` re-read: sufficient (claude-internal) or a source of false permanent quarantine (gemini, gpt) | **Contested decision 1.** The objection accepted, both remedies rejected: quarantine deleted and replaced by a self-healing, gate-holder-only `needsReauth` |
| `account use`: "move, never copy" as a strength (claude-internal) or moving as a CRITICAL defect (gemini) | **Contested decision 2.** Both overruled: the material is shared, exactly one *refresher* is named |
| Fail-closed locking's own failure mode (from uncounted minimax H-1) | accepted: fail-closed only together with a TTL, dead-holder detection, an acquire timeout and a heartbeat |
| Severity of the verification gaps | CRITICAL upheld; verification rebuilt around "a check that cannot fail is not evidence", with a mutation column and a recording metered canary |
| Usage coalescing: flush on exit (gemini) or persist selection-relevant changes immediately (gpt) | gpt's remedy: flush-on-exit does not answer the cross-process case |

## Round 2 — revision 1

| Reviewer | Verdict | C | H | M | L |
|---|---|---|---|---|---|
| claude-internal | FAIL | 1 | 7 | 9 | 3 |
| gpt-5.6-sol | FAIL | 6 | 8 | 4 | 2 |
| gemini-3.8-flash | CONDITIONAL | 0 | 3 | 4 | 2 |

**What revision 1 closed**, by claude-internal's tabulation: of round 1's 7 CRITICALs, 3 closed and
4 partially; of 15 HIGHs, 13 closed and 2 partially; none still open. gemini found all seven
CRITICALs resolved or mitigated below CRITICAL and called both contested overrules "fully
defensible". gpt-5.6-sol's review was truncated inside its round-1 table, so the consolidator
inferred its round-1 dispositions.

The CRITICAL that mattered, raised by claude-internal and by gpt-5.6-sol (at MEDIUM), 2/3: **the
availability predicate was computed from stored token material.** `isAvailable()` is contractually
"never throws — resolves to false", so a locked Keychain, a denied ACL or an `EIO` became `false`,
and the composite signed with the metered key. The other five CRITICALs were gpt-5.6-sol's alone: `F8` cut without a
requirements change; lock release and steal on `pid` alone; ambiguous-write recovery overwriting a
committed rotation; the recurring dual-store refresh unspecified; a hard 30 s ceiling contradicting
F4. One HIGH was unanimous (3/3): the out-of-band rotation detector read only claudish's own store,
where Claude Code's rotation can never appear.

**Revision 2** dispositioned 21 CRITICAL and HIGH findings: 19 accepted in full, 1 accepted with its
remedy replaced, 1 rejected on the code.

- **Availability redefined as configuration presence**; token-store reads made to throw on failure.
- **All five solo CRITICALs accepted**, three of them inside sections the other two reviewers had
  called closed. The changelog's rule: being outvoted 1–2 is not evidence of being wrong when the
  claim is checkable, and each one was. Truncation weakened gpt's re-openings as votes, not its
  findings as findings. Results: a 16-byte ownership nonce with a fence and no cross-host stealing;
  "re-read uncached first" for ambiguous writes; the dual-store transaction; decision 9 recorded as
  an amendment pending the user.
- **Remedy replaced, not the finding:** the stream ceiling. gpt said 30 s was too narrow for F4;
  claude-internal said the extended watch was too broad for N6. Both were right and their remedies
  were exclusive, so the ceiling was deleted: an entry gate (extended mode only when a verdict is
  actionable) and a 12 s *idle* timeout.
- **Rejected:** gpt's position that `NeedsReauthError` should stop the routing chain as a bare
  terminal 400. `isRetryableError` does not advance on 400, and that is regression #148 — every
  single-account Codex user on a bare `gpt-*` route would silently lose the chain.
- **The mutation column audit**, unanimous: revision 1 had 12 rows of outright theatre, the flagship
  billing row among them, and 8 partial. 10 were rewritten, 2 deleted, 8 sharpened, and V4 was
  labelled `[unmutatable]` rather than given a decorative mutation. Row contests were settled by
  inspection: V2(c) moved to V2e (gpt overruled — its run excluded the Keychain store the mutation
  targeted); V7's mutation rewritten (gemini overruled — the old rule also returned `clean` at the
  content delta); V1b kept, with a new fault added so its precondition became reachable.

The revision 2 changelog closed with "the design is ready" and asked that remaining findings be
treated as noise unless they came with a `file:line` contradicting the text.

## Round 3 — revision 2, verification

| Reviewer | Verdict | C | H | M | L |
|---|---|---|---|---|---|
| claude-internal | FAIL | 1 | 3 | 4 | 2 |
| gpt-5.6-sol | FAIL | 5 | 3 | 1 | 0 |

Round 3 did bring a `file:line`, from both reviewers: **C1, the metered escape survived one layer
up.** The predicate was right and its two inputs were not — `loadConfig()` returns `DEFAULT_CONFIG`
on a parse failure (`profile-config.ts`) and `CodexOAuth.loadCredentials()` returns `null`
(`codex-oauth.ts`), so an unreadable `config.json` or legacy file still selected the metered key.
Both confirmed that an unreadable Keychain could no longer reach it.

Also unanimous: **C2**, V1 was internally unsatisfiable (its arithmetic, its expected message and
its mutation each contradicted the design); **C3**, `extendedQuotaWatch: false` was specified two
contradictory ways; **H1**, `mapAccountsError()` covered three of six taxonomy errors, so the
transient ones became a 500 at the new status-swap catch; **H2**, V10b and V1d were inert.

The panel disagreed on how much of round 2 was closed. For the five accepted solo CRITICALs:

| Round-2 item | claude-internal | gpt-5.6-sol | Became |
|---|---|---|---|
| Ambiguous single-store write | fixed | fixed | closed |
| `pid`-only lease | fixed | partially: a check/use window between the fence and the persist | **C4** |
| Dual-store transaction | fixed in structure | not fixed: the destination write precedes its durable marker | **C5** |
| Import and F8 | fixed; amendment correctly pending | partially: C2 was dropped too, with no amendment | **C6** |
| Stream ceiling | fixed as to F4 | partially: false mode contradictory, and no-alternate quota never marked | C3 and **C7** |

Severity disputes resolved upward at N = 2: C1 (CRITICAL/HIGH), C2 and C3 (HIGH/CRITICAL), H2
(MEDIUM/HIGH). Of the mutation rows, 10 remained in question: 3 unanimously ineffective (V1, V10b,
V1d), 5 directly contradicted (V7, U8, U2, V16, V12c), 1 unopposed (V7b), 1 conditional (V2e) —
against round 2's 12 theatre rows.

**Revision 3** was targeted: the coordinator closed the plan-review loop and moved to implementation.

- **Fixed (both reviewers):** C1 — the account list is read fail-closed, `isAvailable()` may throw,
  and `registry.ts` never calls `loadConfig()`; C2 — V1 rewritten as a pool of two with one
  pre-exhausted; C3 — false mode classifies and marks, never rotates; H1 — the mapper covers every
  taxonomy error; M2 (one reviewer) — the dual-store write preserves other keys and the ACL.
- **Rows:** V1, V1d and V10b rewritten; V1e, V16b and U9b added; two faults added.
- **Carried, each with a settling test:** C4 (T-C4), C5 (T-C5), C6 (a ratification, not a test), C7
  (T-C7), the five contradicted rows (T-V7, T-U8, T-U2, T-V16, T-V12c), M3, M4, L1, L2. The rule:
  a row whose two readers disagree about whether it can fire is settled by running it, not by a
  fourth prose pass.

Verdict: FAIL on the counts, ready for Phases 0–2 on the reasoning — the only finding with money
behind it was closed at both layers where it had been found. Phase 3 was gated on the user ratifying
decision 9 and C6; Phase 4's dual-store work on T-C5.

## Test/implementation alignment, 2026-09-18

Two disagreements between the Phase 1 tests and code, each settled against the design:

- **The test was wrong.** `registry.test.ts` expected the synthesized legacy account's id to be
  `default`. The design pins the *label* `default`; V15 forbids `default` as an id, which
  `^[a-z0-9]{12}$` excludes. The test now asserts `LEGACY_CODEX_ACCOUNT_ID` and keeps the label.
- **The code was wrong.** `usage/anthropic.ts` omitted `lengthMinutes`, a declared field the Codex
  parser fills. It is now parsed from the window name; an unrecognised shape yields `undefined`
  rather than a guess.

Recorded run: `45 pass, 0 fail, 149 expect() calls` across 11 files. Phase 1 had earlier been
checked against the built binary: a legacy-only user saw `default (legacy file)` with nothing
written; a truncated `config.json` produced a refusal, never "0 accounts"; and a seeded exhausted
account rendered with no reason, which is how the per-account `describe()` blocker bug was found.

## Code review of `3ec7762b`: 15 findings, all confirmed

Each finding was checked against `3ec7762b` before any change. All 15 were verified. One stated
consequence was wrong: **A3 produced a 503, not a garbled turn.**

**Request path (A1–A5):**

| # | Finding | Fix |
|---|---|---|
| A1 | A forced refresh cleared the single flight and exchanged with no cross-process gate, so N concurrent 401s presented one refresh token N times — `refresh_token_reused`, and reuse detection can revoke the grant | `CodexOAuth.forceRefresh()` joins an in-flight refresh and refreshes under the per-account gate, adopting a token another process rotated. Residual: the rejected bearer is approximated by "the token this process held" |
| A2 | A failed re-sign returned the raw 401/429, or a bare 401, where a Codex 401 used to be remapped to an inline 400 | the failed retry falls into the generic path (400, `upstream_status`, hint); a throw goes to `surfaceFailedReSign()`. The `forceRefreshAuth` providers were left as they were |
| A3 | The stream-head re-issue closed over the old endpoint and headers, so it re-sent the rejected bearer | `doFetch` reads `activeEndpoint`/`activeHeaders` at call time, which fixes the `forceRefreshAuth` transports too |
| A4 | A failed OAuth refresh carried no `terminal`, so it became a bare 401 | `CodexOAuthRefreshError` (terminal, `upstreamStatus: 401`, names `claudish login codex`); token-endpoint bodies redacted and capped at 200 characters; no metered fallback restored |
| A5 | `CodexOAuth` saved a four-key document, erasing the pool's `claudish_generation` and `claudish_journal`, and refreshed without the gate | read-merge-write that bumps the generation; the same gate as A1. `login()` deliberately stays ungated |

**The corrected symptom.** A3's report said the rejected re-issue's 401 body would be "sniffed as
clean and handed to the SSE parser" — an empty or garbled turn. The code refuted that:
`settleResponsesStreamHead` checks `!next.ok` on every re-issue and returns
`{kind: "exhausted", code: "http_401"}`, which the call site turns into a **503 `overloaded_error`**
("claudish retried 1× … HTTP 401"). The real symptom was a healthy re-signed turn reported as
upstream overload, which Claude Code then retried. The root cause stood; the fix was the same.

**User-visible consequence of A4**, stated in the fix: someone whose ChatGPT login has expired, with
`OPENAI_CODEX_API_KEY` set, used to be served silently on the metered key and now gets an inline
error naming the login command.

**Accounts core (B1–B10):**

| # | Finding | Fix |
|---|---|---|
| B1 | The registry accepted any id, label or threshold; the schema and id pattern were used nowhere; a hand-edited id such as `../../../tmp/x` resolved outside the accounts directory; the stamp was recorded before the read | schema plus the invariants, rejecting the whole read; stamp after read; `paths.ts` refuses unsafe segments. Found while fixing: `existsSync` read a permission-denied directory as absent |
| B2 | `state.json` was overwritten with an empty document on **any** read failure | absent, unreadable and corrupt kept apart; an unreadable file is never written; quarantine only under the lock |
| B3 | The cache was served forever; any successful write discarded marks dropped earlier; the `active` validator was never wired | stamp revalidation, a typed pending overlay merged under the lock, the validator wired to the account list |
| B4 | A steal was read, judge, `rm` — two waiters could both `rm`, the second deleting the first's new lock; no fence before the state rename | rename to a tombstone, compare, restore with `link()`. Found while fixing: release had the same race |
| B5 | A failed holder write left an empty lock file that could never be stolen; the heartbeat truncated before writing | unlink by inode on failure; stealable by mtime; fixed-width records rewritten through the descriptor |
| B6 | A forced refresh under the gate returned the rejected token whenever it did not look expired | the rejected token's fingerprint is carried through the gate and into the single-flight key |
| B7 | An ambiguous write was resolved by generation or fingerprint, which a journal write changes neither of, so every ambiguous journal write resolved as committed | a `writeId` minted per persist decides it |
| B8 | The pool leased one account and propagated its failure; quota wording appeared with nothing exhausted ("0 of N", or "N of N" for a disabled pool) | bounded failover with 60 s deprioritisation; errors chosen by the real blockers; `NoUsableAccountError` |
| B9 | The Codex exchange had no timeout, and the heartbeat kept its holder looking alive | `AbortSignal.timeout(10 s)`; an unusable answer takes the ambiguous path |
| B10 | Four fault names had no injection site, one fired in the wrong place, and the `persist-*` faults hit the journal | every accepted name has a live site; `persist-*` target the final write; two names withheld until their phase. Found while fixing: a holder that lost the gate threw `NeedsReauthError`, contradicting V10b |

Three departures from a finding's fix *intent*, not its diagnosis, each recorded with the reason:
B5's heartbeat writes through the descriptor rather than write-temp-and-rename, because `rename`
replaces whatever is at the path, a successor's lock included; B8 keeps the design's mixed-pool
rule, so exhaustion still dominates; A5 leaves `login()` ungated, because a completed browser login
must never be discarded for a busy lock, and a TUI parent holding the gate over its login child
would deadlock.

Left open by the review, and carried in `accounts.md`: the pool's final persist does not re-read for
a login that replaced the material; the rejected bearer is not yet passed through `SignRequestContext`.

## What the evidence says about the process

- **The same collapse of `failed` into `absent` was found at four layers**, each after the previous
  fix was declared complete: stored token material (round 2), the account-list accessors (round 3),
  `existsSync` on a permission-denied directory (B1), and `state.json` rewritten after an unreadable
  read (B2). A fix at one layer said nothing about the next.
- **Checkable solo findings were right.** All five of round 2's single-reviewer CRITICALs held up,
  three in sections the majority had called closed.
- **"Ready" was declared, then disproved.** Revision 2 called the design ready and asked for
  `file:line` evidence; round 3 supplied it for a unanimous CRITICAL in the same predicate.
- **A mutation column can be theatre too.** 12 dead rows after revision 1; 10 in question after
  revision 2; 3 rewritten in revision 3 and 5 carried to be settled by running them.
- **Three plan rounds did not catch B7.** The design's own commit test for an ambiguous write —
  compare generation and fingerprint — cannot tell a journal write from no write at all. It took
  code to see it.
- **A stated consequence can be wrong while the root cause is right** (A3). Checking both is what
  turned a garbled-turn report into the 503 that users would actually have seen.

## Provenance

- Per-reviewer counts come from each review's own *Verdict Details*; consolidated counts from the
  consolidations; dispositions from the three revision changelogs; costs from the team runner's
  status files.
- Round 2's consolidated report was overwritten by round 3's at the same path. Its counts and its
  disposition table survive in round 3's *What changed since round 2*.
- The session's `reviews/code-review/` directory is empty. The A and B findings are taken from the
  two *Review fixes* sections of the implementation log, which quote the evidence at `3ec7762b`
  for each.
