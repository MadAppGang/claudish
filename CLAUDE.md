# Claudish - Development Notes

CLI proxy that runs Claude Code against non-Anthropic models.

Engineering rationale lives in `ai-docs/architecture/` — **read the relevant file before editing
that area**; it records measurements the source cannot show you. Filenames below are relative to
that directory, whose `README.md` is the full index. Parked work with explicit trigger conditions
lives in `ROADMAP.md`.

## Where the rationale lives — all files below are in `ai-docs/architecture/`

- `routing.md` — `provider@model` syntax, every provider prefix, `DEFAULT_ROUTING_RULES`, `defaultProvider`, the derived picker roster, `SUBSCRIPTION_PROVIDERS`, local models
- `adapters.md` — Layers 1–3, stream parsers, error classification and retry, the 400 remap
- `behavior-layer.md` — Layer 4, the harness-conformance supervisor
- `providers/devin.md`, `providers/grok-subscription.md`, `providers/antigravity.md`, `providers/qwen-alibaba.md` — one per reverse-engineered provider
- `headless-vs-interactive.md` — `-p` is not interactive-minus-a-TTY; an UNKNOWN `--agent` name is
  silently unvalidated under `--input-format stream-json` (a VALID one is applied correctly); why magmux
- `custom-endpoints.md`, `predefined-endpoints.md` — user config; the 25-vendor bundled catalog
- `onepassword.md` — secret resolution, the four denial causes, the handshake lock, route pinning
- `keychain.md` — the macOS Keychain backend: enumerate-for-presence vs read-for-value, the `security` traps, the Providers-tab write/delete
- `mcp-channel.md` — MCP tool surface, channel wire format, progress keepalive
- `team-capture.md` — why `team`'s exit 0 proves nothing
- `team-lifecycle.md` — why no slot is ever killed on a timer, why `run` returns before its
  children finish, idle time as information, and why `keepUnrecognizedJson` is an option
  rather than one rule for both the channel and `team`
- `context-window.md`, `theming.md`, `debugging.md`, `testing.md`

Evidence behind them: `ai-docs/reports/`. Evals: `ai-docs/benches/`. User-facing site: `docs/`.

## Invariants — each of these fails SILENTLY

- A new provider needs entries in BOTH `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES`; a missing profile routes to OpenRouter with no error.
- `apiKeyEnvVar` stays `""` for `devin`, `antigravity`, `grok-subscription` — non-empty means the handler is never built and the model falls through to OpenRouter.
- Never hardcode rosters, context windows, `maxOutputTokens`, or pricing. Discover live; a default is a rule, never a pinned id.
- Terminal errors are remapped to 400, so any `status ===` under `handlers/` is suspect — recover the real one with `extractUpstreamStatus`.
- Read `C.*` / `tokens.*` at RENDER time; a module-level `const` snapshots the dark palette before detection runs.
- A provider absent from `SUBSCRIPTION_PROVIDERS` quotes flat-rate users a per-token price and accrues fictional spend.
- `openai-codex` bills by the CREDENTIAL that signed, never by its name, so it is in `CREDENTIAL_DECIDED_PROVIDERS` and must never also be in `SUBSCRIPTION_PROVIDERS` — the name check short-circuits the probe. The probe is installed only as a side effect of importing `auth/credentials/authority.ts`; unregistered, `cx@` silently reports metered (safe as money, but it also suppresses the `routing-rules.ts:413` cost warning). Probe with `CodexOAuth.hasCredentials()`, never `hasOAuthCredentials`/`describeSourceSync`.
- What makes an arm the SUBSCRIPTION arm is `RequestAuth.arm === "oauth"`, set by the credential half itself — never "the composite returned an artifact". `CompositeCredentialProvider` falls through to the api-key half, which ALWAYS returns an object (`{headers:{}}` even with no key), so a truthiness test on the cached artifact labels every metered request SUB and accrues $0. Absent `arm` ⇒ metered. This shipped once and three reviewers read it as correct.
- Providers whose uids collide with another vendor's namespace (`devin`, `qwen-cloud`) declare no `nativeModelPatterns` and no routing rule — explicit `provider@model` access only.
- `gk@` is the Grok SUBSCRIPTION; `grok@`/`xai@` is the metered `x-ai`. `moonshot-cn@` is a different service from `moonshot@`.
- A new `ClaudishProfileConfig` field MUST be added to `loadConfig`'s allowlist in `profile-config.ts`; otherwise it survives on disk until the first global save and is then dropped. Bit `onepasswordEnvironments`, then `keychain`.

## Commands

- `bun run build` — CLI and macOS bridge bundles. `bun run dev` — development mode.
- `bun run test` — full suite. `bun run test:safe` — same, guarded against touching the real config.
- `bun run typecheck`, `bun run lint`, `bun run format`
- `claudish --probe <model>` shows the adapter composition; `--debug` writes a log to `logs/`.
- Model syntax is `provider@model[:concurrency]` (`google@gemini-2.0-flash`, `ollama@llama3.2:3`); a bare name auto-routes by pattern. Prefix meanings: `routing.md`.

## Releasing

**CI/CD publishes — do NOT run `npm publish`.** Bump ALL THREE of `package.json`,
`packages/cli/package.json` (what npm publishes; a stale value fails the publish) and
`packages/cli/src/version.ts` (the fallback compiled binaries display). Then commit with a
conventional message, `git tag -a v3.0.0 -m "message"`, `git push origin main --tags`.

## Session artifacts

`ai-docs/` is TRACKED; `ai-docs/sessions/{task-slug}-{YYYYMMDD-HHMMSS}-{hash}/` is GITIGNORED and
does not survive a fresh clone or `git worktree remove`. Work there — scratch notes, raw runs,
probe scripts — rather than `/tmp`, but put anything meant to outlive the session somewhere
tracked: `ai-docs/reports/` for findings, `ai-docs/benches/` for evals, `ai-docs/architecture/`
for rationale. Three write-ups already died this way.

## Learned Preferences

### Tools & Commands
<!-- learned: 2026-03-28 session: 03cd7cc5 source: repeated_pattern -->
- Use `bun` for all package management and scripts (`bun run build`, `bun test`, etc.) — not npm or yarn
<!-- learned: 2026-04-06 session: df311293 source: repeated_pattern -->
<!-- revised: 2026-07-26 — root cause was a missing Ollama embedding model, not mnemex itself -->
- Prefer mnemex AST lookups over grep for symbol/caller questions: `mnemex --agent symbol|callers|callees "Name"`
- Semantic search is `mnemex --agent search "concept"` — NOT `map`, which ignores its argument entirely and always dumps the same PageRank overview
- `search` needs Ollama serving `nomic-embed-text` — without it embeddings are zero-length, so search is useless and `status` panics with a lance divide-by-zero. Fix: `ollama pull nomic-embed-text` → `rm -rf .mnemex/vectors` → `mnemex index`

### Workflow
<!-- learned: 2026-04-06 session: df311293 source: explicit_rule -->
- Don't run claudish directly in main bash — use dedicated channel sessions or `/delegate`
<!-- learned: 2026-09-02 source: near_miss -->
- NEVER `git stash` from a worktree. The stash stack is shared with the main checkout and
  every sibling worktree, and concurrent sessions push and pop it. A bare push/pop pair is
  not symmetric: another session can push between yours, so your `pop` takes THEIR work and
  buries yours where nobody is looking. Both trees then look plausible and neither errors.
  Set work aside with a temporary WIP commit, or copy the file out and back. To revert a
  file for a mutation test, copy it — do not use git.
- Deep rationale goes in `ai-docs/architecture/`, not here. Add it there and name the trigger in the list above.
