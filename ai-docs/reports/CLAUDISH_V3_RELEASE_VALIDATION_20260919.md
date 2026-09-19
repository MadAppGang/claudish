# Claudish catalog v3 release validation — 2026-09-19

The release candidate is 9.8.0. The live Models Index generation read in this
session is `g-20260919013346169-feffb8ad`: 886 slim models and 19 plans, read
with the v3 media type and pinned to the same generation. The published
Alibaba memberships are 10 Coding Plan, 20 Token Plan Individual, and 31
Token Plan Team Edition models. The client reads all pages before caching a
model/plan snapshot and rejects changed generations, incomplete pages, and
unsupported contracts.

Alibaba transport identities and credentials:

| Product | Client prefix | Credential | Catalog route/profile |
| --- | --- | --- | --- |
| Coding Plan | `qcode@` | `QWEN_CODING_PLAN_API_KEY` | `qwen/modelstudio-coding-plan` |
| Token Plan | `qtoken@` | `QWEN_TOKEN_PLAN_API_KEY` | `qwen/qwencloud-token-plan` |
| PAYG | `qpay@` | `DASHSCOPE_API_KEY` | `qwen/dashscope-direct` |

The current Zen pricing rows in this generation match the [OpenCode model
table](https://opencode.ai/v2/docs/console/models/), in USD per million tokens:

| Model | Input | Output | Cached read | Cached write |
| --- | ---: | ---: | ---: | ---: |
| Qwen3.7 Max | 2.50 | 7.50 | 0.50 | 3.125 |
| Qwen3.7 Plus | 0.40 | 1.60 | 0.04 | 0.50 |
| Qwen3.6 Plus | 0.50 | 3.00 | 0.05 | 0.625 |
| Qwen3.5 Plus | 0.20 | 1.20 | 0.02 | 0.25 |

The client maps all five requested subscription profiles: Grok, MiniMax
Coding, Sakana Fugu, Devin, and Antigravity. An authenticated account discovery
read returned 30 OpenCode Go, 8 MiniMax Coding, 2 Grok, 8 Sakana, 209 Devin,
and 21 Antigravity entries. Dedicated local probes returned live inference for
OpenCode Go Kimi, Grok, Sakana, Devin, and Antigravity. MiniMax Coding
authenticated but its request received HTTP 429, provider code 2056, stating
that the Token Plan usage limit was reached. The reader retains both verified
and explicitly unavailable probe maps, rather than promoting an unavailable
probe selection to an account entitlement.

OpenCode documents the [Zen](https://opencode.ai/v2/docs/console/models/)
and [Go](https://opencode.ai/v2/docs/console/go) Qwen families on Anthropic
Messages. This candidate pairs the Messages payload, parser, endpoint, session
header, and API-key header for those routes. Go MiniMax also uses Messages;
metered Zen MiniMax uses Chat Completions. Local `--probe` returned live
inference for `zengo@qwen3.7-plus` and `zengo@minimax-m3` after fixing the
Messages-specific API-key header. The explicit Qwen and gateway wire IDs are
resolved from mapped v3 connections.

Poe now has a handler factory; Vertex chooses a configured project before an
Express key. Composition and project-selection tests pass, but authenticated
requests for those routes have not been run because this local environment has
neither Poe credentials nor Vertex project access. The three Alibaba
credentials and a metered OpenCode Zen key are also absent locally, so their
account entitlements and live inference cannot yet be claimed. A public plan
roster or public model endpoint is not evidence of access to those accounts.

Candidate validation: `bun run typecheck`, `bun run lint`, and `bun run build`
passed. The guarded full suite passed after the Zen endpoint correction:
3,545 CLI tests, 20 macOS bridge tests, and 4 guard tests; zero failures.
Release remains pending the missing authenticated product checks and the
merged-source release workflow.
