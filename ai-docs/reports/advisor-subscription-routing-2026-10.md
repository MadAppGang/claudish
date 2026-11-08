# `--advisor` on subscription-aware routing — build and validation report (2026-10-20 … 2026-10-22)

Branch `worktree-investgiage-gpt-file`, released as claudish 14.0.0. ROADMAP trigger 1 ("migrate all to
subscription", owner, 2026-10-20). Rationale lives in `ai-docs/architecture/advisor.md` (panel routing,
the advisor handler set, the Claude rule) and `adapters.md` (signing-value registry, call abort, client
cancel). This file records what was built, what was measured, and what is still open.

## What changed for users

- Every `--advisor` panel member and the collector go through the same routing chain a main model
  would (`planAdvisorModel` + `buildAdvisorChains`, before the port). A bare `gpt-*` or `cx@` member is
  served by the Codex subscription, `grok-*` / `gk@` by the Grok subscription, `kc@k3` by Kimi Coding,
  `ag@gemini-*` by Antigravity. The old metered bare-fetch routes (`advisorRouteFor`) are gone
  (`feat(advisor)!`, `cb8c6bba`).
- A Claude member or collector signs with the user's Claude Code login, only on a launch where claudish
  controls the child's auth (`childAuthControl`), and only to `api.anthropic.com`.
- The startup notice and the runtime read the same plan; a call served by a hop with different billing
  warns (`5621fd46`).
- Billing follows the arm that signed each request (`RequestAuth.arm`), including `openai-codex` and
  retry legs (`da614153`, `7f47a921`).
- Every credential a request signed with is redacted by value in every log sink, telemetry and every
  body sent to Claude Code (signing-value registry, leases released when the body ends).
- An aborted internal call stops its fetch, queue and retry waits and does not advance the chain; a
  client cancel is recorded as `cancelled`, not as a truncation.
- **A rejected subscription key moves the routing chain on to the next hop, metered included** (owner,
  2026-10-21: an expired key must not block the chain; a configured metered key is consent), with a
  stderr notice naming the next hop and its billing (`9ace3fe5`, `2f282101`). A claudish connection
  fault still never advances onto a metered hop (`f8e09504`).
- The availability check resolves Antigravity ids the way the transport does, so `ag@gemini-3.8-flash`
  keeps its hop when the account lists only variants (`8452d275`).

## Measured

Live, subscriptions only, real Claude Code under madbench (`ai-docs/benches/advisor-subscription/`), on
the build merged with main 13.4.0 (run 4, 2026-10-22, one trial per Scenario):

| Scenario | Checks | Served by |
|---|---|---|
| routed-codex | 9/9 | `gpt-6.1-sol`, `cx@gpt-6.1-sol`: openai-codex, oauth, subscription; `kc@k3`: kimi-coding, subscription; main-session code mode resumed |
| routed-grok | 6/6 | `grok-4.7`, `gk@grok-4.7`: grok-subscription, subscription |
| claude-login | 7/7 | `sonnet` panel and `haiku` collector: native-anthropic, oauth, `claude-code-login`; 0 bearer values in the log |
| refusal | 3/3 | `ag@gemini-0-nonexistent` and `opusplan` refused with exit 1 before any `Calling API:` |
| routed-antigravity | 8/8 | `ag@gemini-3.8-flash`: antigravity, subscription; sent `gemini-3.8-flash-high` from a served list of four variants |

Hosts called across all five: `chatgpt.com/backend-api/codex`, `api.kimi.ai/coding/v1`,
`cli-chat-proxy.grok.com`, `api.anthropic.com/v1/messages`, `daily-cloudcode-pa.googleapis.com`. None to
generativelanguage.googleapis.com, api.openai.com, api.x.ai, OpenRouter or OpenCode Zen.

One earlier run (2026-10-21, `rejected-sub`) made one metered call: bare `gemini-4-argon` had no usable
subscription candidate on this machine (Antigravity did not serve it then; Zen Go was skipped as
`content-use opt-in id only`), so it was served by the Gemini API on the user's key, as the notice said
beforehand. The Scenario stays in the bench with a README warning; it is skipped in subscription-only runs.

Tests (all written blind by an external GPT writer through claudish on `cx@`, run by a separate runner):
114 tests for the core work (13/13 mutations red, negative control), plus 52 for fix round 4
(`fallback-handler.credential-advance`, `advisor-notice-text`, `model-availability.antigravity-resolve`),
every marked group mutation-proven. After the merge with main 13.4.0, 53 targeted test files: 704 + 121
child-process tests pass, 10 skip, 0 fail; typecheck and lint clean.

## Found on the way

- **The connection-fault 400 could advance onto a metered hop after D7** (blind writer T5, G2:
  `Expected [1, 0] Received [1, 1]`). `FallbackHandler.handle()` checked the D7 branch before the
  `x-claudish-connection-error` marker, which only `isRetryableError` read. Latent (today's producers put
  no upstream 401 in that body), fixed in `f8e09504`.
- **A log-flush race in a test**: the logger writes with async `appendFile`, so a log read right after a
  fake-timer flush saw 0 lines once in about 10 runs. The test now polls with a 2 s deadline.
- **Equivalent mutant**: removing the notice's own `redactForClient` call changes nothing observable,
  because `log` and `logStderr` redact signing values at the sink (`logger.ts`). Recorded, not a gap.
- **The Antigravity account's model list changes**: on 2026-10-21 it served only
  `gemini-3.8-flash-tiered`; on 2026-10-22 four variants and `gemini-4-argon-high/-medium/-low`. Two bench
  Checks that pinned ids broke; they now grade against the served list the transport logs.
- madbench 0.53.1 keeps only the last of several `--scenario` flags, silently; run one Scenario per
  invocation.
- The merge commit `982c1169` says "13.3.0" in its subject, but it contains main up to 13.4.0: another
  session's fetch moved the shared `origin/main` ref between the preflight and the merge.

## Open

- The `advisor_call` record's `routedModel` holds the planned wire id, not the id the Antigravity
  transport sent (`advisor.md` says so since `a6b27640`). Recording the sent id needs the transport to
  report it back.
- Code-mode replay after a proxy restart is abandoned when a hook repaired a nested tool call (from
  merging main 13.2.0's hooks layer); needs a hooks API change.
- From `model-failures-2026-10-21.md`: D1 (restart long-lived claudish MCP servers that hold a stale
  Grok token and old routing), D4, D5, D6 (preflight probes only hop 1), D9 (`go@` reported as missing
  credentials); renew the Zen Go key. D3 was fixed on main (`56df54b5`).
- A reasoning-only panel reply is still a stub (ROADMAP).
