# MTL-189: Muse Code routing — findings and live verification (2026-10-22)

Released in 13.3.0. Rationale lives in `ai-docs/architecture/providers/meta-muse-code.md`,
`routing.md` and `context-window.md`; this report keeps the evidence those files do not.

## The defect

A bare `muse-wonder-full` failed with `No provider in the catalog serves "muse-wonder-full"`,
and the other Muse Code models (`muse-wonder`, `muse-spark-1.3`, `muse-spark-1.2`) routed to
metered gateways, although catalog generation `g-20261021063612126-17350b71` maps all four on
`meta/muse-code-subscription`.

Cause: `CATALOG_ROUTE_BINDINGS` had no `meta-muse-code` row. The row was parked with a comment
until models-index published the profile (backend task M1); the catalog published it and nothing
checked the trigger. The ticket's hypothesis — that claudish maps the route through the
route-level `consumerProviderId` — was wrong: no code in `packages/cli/src` reads that field.
The `export META_API_KEY` hint in the error came from `meta`'s `nativeModelPatterns: /^muse-/i`.

Guard added: `catalog-route-bindings.coverage.test.ts` fails when a published `kind: subscription`
profile is neither bound nor listed in `UNBOUND_SUBSCRIPTION_PROFILES`. 13 of 13 were bound on
that generation. It reads a pinned copy of the registry, so it catches a new profile when that
copy is refreshed.

## A host leak the binding opened

Once bound, `muse@` is built by the generic catalog wire handler, which honoured a user `baseUrl`.
A test caught it before release:
`Expected: "https://api.meta.ai/v1/responses"  Received: "https://override.invalid/v1/responses"`.
The handler now pins `meta-muse-code` to `MUSE_CODE_BASE_URL`. The Muse login can be a copy of the
Muse CLI's Keychain token, so this is a credential boundary, not a preference.

## Live verification (built binary of this branch, 2026-10-22)

Run from the worktree as `bun packages/cli/dist/index.js`, never the installed claudish: the MCP
`preflight` tool runs the installed version and cannot test an unreleased fix.

- `--probe muse-wonder-full muse-spark-1.3 --json` (live): `muse-wonder-full` →
  `muse@muse-wonder-full-1.0`, tier subscription, `availability: serves`, `probe.state: live`,
  81 tokens, first token 2157 ms, `signedWith: Muse Code borrowed copy · Muse Code Power Usage`,
  wire `https://api.meta.ai/v1/responses`. `muse-spark-1.3` first hop `muse@muse-spark-1.3`, live.
- `--model muse-wonder-full -y -p "Reply with exactly the word PONG…"` → `PONG`, exit 0.

## A second defect only a live launch showed

The bare-name run above printed `Claude Code doesn't recognize the model "muse-wonder-full", so it
assumes a context window of 200k tokens.`; the same prompt with `--model muse@muse-wonder-full-1.0`
printed nothing. That one-variable comparison located it: `resolveLocalContextWindow` asked live
discovery for the canonical id while discovery lists the wire id (`muse-wonder-full-1.0`; `k3` for
bare `kimi-k3`). It now asks for the routed wire id; the slim catalog is still read by canonical id
first, because a wire id can equal another catalog row's id (`qwen3.8-flash-next` on OpenRouter is
`qwen/qwen3.8-flash`). Unit tests could not see this: routing was correct, and the window is
decided on the launch path by a different function. After the fix the bare-name run printed no
warning.

## contentUse coverage (generation g-20261021063612126-17350b71)

The catalog publishes `contentUse` (`standard` | `contributor`) on 735 of 1924 connections,
including all 11 `-contributor` connections (`meta/direct-api` 2, `meta/muse-code-subscription` 4,
`opencode/go-subscription` 3, `openrouter/gateway` 2). On every connection carrying the field, the
field and the suffix rule agree. Decision (Jack, 2026-10-22): the field decides; a connection
without it keeps the suffix rule. Remove the fallback when every connection carries the field.

## Open

MTL-200: a `team` reviewer slot forked a worktree-isolated subagent and drove it with
`SendMessage` and `TaskStop` before voting; `team status` showed a clean `COMPLETED`.
