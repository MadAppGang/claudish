# Claudish - Development Notes

For planned but not-yet-implemented work — including the SEP-1686 channel migration, optional `notifications/progress` for terminal UI, and the Anthropic plugin allowlist consideration — see `ROADMAP.md`. Each item there has an explicit trigger condition; if a condition is met, the item moves to active development.

## Release Process

**Releases are handled by CI/CD** - do NOT manually run `npm publish`.

1. Bump version in `package.json`
2. Commit with conventional commit message (e.g., `feat!: v3.0.0 - description`)
3. Create annotated tag: `git tag -a v3.0.0 -m "message"`
4. Push with tags: `git push origin main --tags`
5. CI/CD will automatically publish to npm

## Build Commands

- `bun run build` - Build CLI and macOS bridge bundles
- `bun run dev` - Development mode

## Model Routing (v4.0+)

### New Syntax: `provider@model[:concurrency]`

```bash
# Explicit provider routing
claudish --model google@gemini-2.0-flash "task"
claudish --model openrouter@deepseek/deepseek-r1 "task"

# Native auto-detection (no prefix needed)
claudish --model gpt-4o "task"          # → OpenAI
claudish --model gemini-2.0-flash "task" # → Google
claudish --model llama-3.1-70b "task"   # → OllamaCloud

# Local models with concurrency
claudish --model ollama@llama3.2:3 "task"  # 3 concurrent requests
```

### Provider Shortcuts
- `g@`, `google@` → Google Gemini (direct API, `GEMINI_API_KEY`)
- `ag@`, `antigravity@` → Antigravity (Gemini via your Antigravity subscription — see "Antigravity Provider" below)
- `go@` → **deprecated alias → `ag@`** (Gemini Code Assist for individuals was retired by Google; prints a one-line deprecation notice)
- `oai@` → OpenAI Direct
- `cx@`, `codex@` → OpenAI Codex (Responses API)
- `or@`, `openrouter@` → OpenRouter
- `mm@`, `mmax@` → MiniMax
- `mmc@` → MiniMax Coding Plan
- `kimi@`, `moon@` → Kimi
- `glm@`, `zhipu@` → GLM
- `gc@` → GLM Coding Plan
- `sakana@`, `fugu@` → Sakana Fugu
- `sc@` → Sakana Fugu Subscription
- `qc@` → Qwen Plan (Alibaba Cloud Model Studio)
- `dv@`, `devin@` → Devin (Cognition/Codeium subscription — see "Devin Provider" below)
- `llama@`, `oc@` → OllamaCloud
- `litellm@`, `ll@` → LiteLLM (requires LITELLM_BASE_URL)
- `ollama@` → Ollama (local)
- `lmstudio@` → LM Studio (local)
- Custom endpoint names also work as provider prefixes (e.g., `my-vllm@model-name`) — see "Custom Endpoints" below

### Devin Provider (`dv@`) — many vendors' models on one Cognition subscription

The only **binary** wire in the pipeline: Connect-protocol envelopes carrying protobuf, on
`POST <server>/exa.api_server_pb.ApiServerService/GetChatMessage` with `authorization: Basic <k>-<k>`
(the key literally doubled), `content-type: application/connect+proto`, `connect-protocol-version: 1`.
Codec, request builder, credentials, live roster, and uid resolution live in `providers/devin/`;
Layer 1 is `adapters/devin-api-format.ts`, Layer 3 `providers/transport/devin.ts`, the parser
`handlers/shared/stream-parsers/devin-connect.ts`. Full reverse-engineering write-up:
`ai-docs/sessions/dev-arch-devin-subscription-20260806-120000-a1b2c3d4/protocol-spec.md`.

**Auth is the Devin CLI's own token, verbatim.** `~/.local/share/devin/credentials.toml`
(`windsurf_api_key = "devin-session-token$<JWT>"`), overridable with `WINDSURF_API_KEY`;
`WINDSURF_API_SERVER_URL` re-points the backend, which is also the cheapest way to capture traffic
(the CLI validates against the macOS **system** trust store and ignores `SSL_CERT_FILE`, so a
plain-HTTP forwarder beats a MITM CA). No exchange, no refresh, no keychain. There is **no
`claudish login devin`** — the Devin CLI mints the token; claudish only reads it.

**`apiKeyEnvVar` MUST stay `""`.** proxy-server's credential-extraction block runs only for a
non-empty value and extracts the key by stripping `Bearer ` from `auth.headers.Authorization`.
Devin's artifact is `Basic <k>-<k>` on a LOWERCASE header, so that yields `""` → `return null` → the
handler is never built and the model **silently falls through to OpenRouter**. A wrong provider
quietly succeeding is worse than a crash. Same pattern as Antigravity: empty env var + a dedicated
`CredentialProvider` + transport-side `credentials.getRequestAuth()`.

**Access is always EXPLICIT — no bare name ever routes to Devin.** Its uids collide head-on with
other providers' namespaces (`claude-opus-5-medium` matches native-anthropic's `/^claude-/i`,
`gpt-5-6-luna-medium` matches OpenAI's, `glm-5-2` GLM's, `kimi-k3-high` Kimi's), so the definition
declares **no `nativeModelPatterns`** and there is **no `DEFAULT_ROUTING_RULES` entry**. Same
reasoning as Qwen Plan, which also re-serves other vendors' models.

**The reasoning tier is IN the model id — there is no effort parameter.** `dv@claude-opus-5` at
effort `high` resolves to the uid `claude-opus-5-high` via `resolveDevinModelUid` against the LIVE
roster (`getServedDevinModels` = `GetCliModelConfigs` ∩ `GetCliTeamSettings.allowed_model_uids`,
minus `contextWindow === 0`, which is what drops the `adaptive` router pseudo-model). No roster,
window, family, or tier is ever hardcoded — 167 models on the developer's own account. Note the two
metadata rpcs are **unary and BARE** (`application/proto`, no envelope), field 1 is `"chisel"` there
versus `"devin-cli"` on `GetChatMessage`, `GetCliTeamSettings` lives on `SeatManagementService` not
`ApiServerService`, and metadata field 7 is required (dropping it → HTTP 400).

**Three wire facts that cost real money to get wrong:**

- **Errors ride an HTTP 200.** The fault is a `flags=2` frame carrying
  `{"error":{"code","message"}}`; the status code alone NEVER signals failure. `sniffDevinStreamHead`
  settles it while the status is still ours to choose — retryable (`unavailable`/`internal`/
  `deadline_exceeded`, non-quota `resource_exhausted`, prose overloads) retries on the shared
  3s→15s→30s schedule then 503; terminal (`permission_denied`/`unauthenticated`/`invalid_argument`/
  `not_found`, quota-worded `resource_exhausted`) goes straight to a **400 rendered inline**. An
  UNRECOGNIZED code is terminal on purpose: guessing "retryable" costs 48s of backoff and still hides
  the reason. An **unserved uid comes back as `permission_denied`, not `not_found`** — the transport's
  served-set-aware rewrite names it and lists available families, but keeps the upstream text, because
  `permission_denied` was also the symptom of the wrong role enum.
- **Field 28 usage is float32 LITTLE-endian** at `28→2→4→2`, selected by the STRING key at `28→2→5`.
  Field 28 is repeated with the groups in unspecified order, so select by key, never by index; an
  absent value means zero. LE reads 16185 tokens where BE reads 2.09e-38.
- **Field 5 (stop_reason) can be ABSENT** (GPT sends none) and is family-specific where present
  (2 on GLM, 4 on Claude, both meaning ordinary completion). A `stop_reason: undefined` is rejected by
  Claude Code, and a numeric→name table would be hardcoded per-model data, so it is DERIVED: any
  tool_use block emitted → `tool_use`, else `end_turn`. Likewise **field 9 (reasoning) is
  family-dependent** — GPT emits it, the Claude family does not even at `-high` — so the thinking
  block must be genuinely optional.

**`max_tokens` is deliberately NOT sent.** Request field 8 fails EVERY request as a length-delimited
message (`invalid_argument` even when empty, while unknown fields 9/11 with the same shape return
200 — so it is field-8 type validation), and as a varint it is accepted and silently ignored: a
budget of 16 produced a complete 326-token answer on claude-sonnet-5-medium and 430 on glm-5-2. Since
Claude Code sends `max_tokens` on essentially every request, encoding the originally-documented
`{2: n}` shape would have broken 100% of Devin turns. Measurements are pinned in
`devin-request.ts`'s header; revisit only with a capture showing field 8 truncating a turn.

**Role enum: 1 = USER, 2 = ASSISTANT, 4 = TOOL_RESULT — never 3.** Public prior art
(`opencode-windsurf-auth`, documenting Windsurf's `LanguageServerService`) says 3, and a 3 here
produces FAMILY-SPECIFIC failures that look transient: `permission_denied` on Claude, "third-party
model provider is experiencing issues" on GLM, while `gpt-5.6-luna` silently tolerates it. An
assistant turn with text *and* N tool calls is encoded as **N+1** messages (one text, then one per
call); a pure tool call carries field 6 and no field 3.

**Layer 4 is force-armed.** The devin profile sets `forceForeignModel: true`, because Devin serves
uids like `claude-sonnet-5-medium` that match ComposedHandler's `^claude-` "native Anthropic" test —
which would switch the behavior supervisor OFF for exactly the models most likely to need it. The
87/87 plan-mode measurement behind that rule is about Claude reached through Anthropic's own harness
and says nothing about a `claude-*` uid re-served over a reverse-engineered endpoint. The flag is
opt-in per profile; every other provider is untouched.

`ProviderTransport.serializeBody?()` is the seam that lets a binary body exist at all, and it is
**default-preserving by construction**: ComposedHandler computes it once and applies
`serialized?.body ?? JSON.stringify(payload)` / `serialized?.contentType ?? "application/json"` at
BOTH fetch call sites (the main request and the 401-retry twin), so the other ~15 transports execute
the identical instruction sequence they always did. It lives on Layer 3, not Layer 1, because the
encoded body embeds the credential — the same reason `transformPayload` is a transport hook.
`supportsVision()` is false, which routes images through the existing vision-proxy path for free.

### Antigravity Provider (`ag@`) — Gemini via your Antigravity subscription

Two separate Gemini flows, deliberately split:

| Flow | Prefix | Auth | Backend | Billing |
|---|---|---|---|---|
| Direct Gemini API | `g@` / `google@` | `GEMINI_API_KEY` | `generativelanguage.googleapis.com` | pay-per-use |
| **Antigravity** | `ag@` / `antigravity@` | your Antigravity OAuth token (shared with the `agy` CLI) | `cloudcode-pa.googleapis.com/v1internal` | your Antigravity subscription (free / Pro / Ultra) |

`go@` is a **deprecated alias → `ag@`**. Google retired the old "Gemini Code Assist for individuals" tier for gemini-cli's OAuth client (`UNSUPPORTED_CLIENT`); that product is dead, so `go@` now routes to Antigravity with a one-line deprecation notice.

**Why not just spoof the identity:** the backend has two independent gates. `loadCodeAssist` gates the visible *tier* on request identity (`User-Agent` + `metadata.ideType: ANTIGRAVITY`), but `streamGenerateContent` gates *generation* on the OAuth **client that minted the token** — headers can't fake it (403 PERMISSION_DENIED). So claudish does not spoof; it **reuses the user's own Antigravity token**.

**Token lifecycle** (`auth/antigravity-token.ts`, macOS):
- **Shared store**: the same keychain item the `agy` CLI uses — `service=gemini, account=antigravity`, value `go-keyring-base64:<base64(JSON)>` (zalando/go-keyring). claudish reads AND writes it, so both tools reuse one live token.
- **Self-refresh**: when the token is expired, POST `oauth2/token` with `grant_type=refresh_token`. The Antigravity client_id/secret are **never shipped** — they're extracted at runtime from the user's own local `agy` binary (`strings` for the `…apps.googleusercontent.com` id + `GOCSPX-` secret; the working combo is discovered by first-200 and cached). The refreshed (and possibly rotated) token is written back to the shared store.
- **Degradation**: no store (agy not installed / not signed in) or non-macOS → actionable error pointing at `g@` + `GEMINI_API_KEY`.

**Model ids — LIVE discovery, no hardcoded map**: the Antigravity backend requires a reasoning-tier suffix (bare `gemini-3.6-flash` → 404), but which variants a subscription serves is **per-account and drifts**, so claudish never hardcodes a roster. `getServedAntigravityModels()` fetches the live set from the backend's own `v1internal:fetchAvailableModels` (body `{project}`) — the served ids are the response `models` keys, plus a backend `defaultAgentModelId` — cached with a TTL. `resolveAntigravityModelId(requested, servedIds, defaultId)` then resolves against that LIVE set: exact match passes through; a bare family (e.g. `gemini-3.6-flash`) resolves to the backend's `defaultAgentModelId` when it's a variant of that family, else to the strongest reasoning tier by a *rank rule* (`high>medium>low>extra-low>tiered` — a rule, like `rankCodeAssistModel`, not pinned ids); anything else passes through to the F1–F7 404 rewrite. The only literals are the tier-rank ordering and endpoint strings — no concrete model ids in source.

**Identity strings**: `User-Agent: antigravity/cli/<ver> (aidev_client; os_type=<platform>; arch=<arch>; auth_method=consumer)` + `metadata: { ideType: "ANTIGRAVITY" }`. The transport keeps all the F1–F7 improvements from the old codeassist path (terminal-error → 400 surfaced inline, served-set-aware 404 rewrite, `rankCodeAssistModel`). Full reverse-engineering write-up: `ai-docs/sessions/antigravity-refactor-20260803-125333-d0791562/architecture.md`.

### Default Provider Configuration (v7.0.0+)

`defaultProvider` is a **last-resort fallback** appended to every bare-name routing chain. It is not a "front of the line" override — specific patterns (`gpt-*`, `gemini-*`, etc.) still try their normal providers first. `defaultProvider` only catches models whose explicit chain has zero credentialed providers, or models that match no rule at all.

Set it via:

- **Config file**: `"defaultProvider": "openrouter"` in `~/.claudish/config.json`
- **Env var**: `CLAUDISH_DEFAULT_PROVIDER=openrouter`
- **CLI flag**: `claudish --default-provider openrouter "task"`

**Precedence** (highest to lowest):
1. CLI flag `--default-provider`
2. `CLAUDISH_DEFAULT_PROVIDER` env var
3. `defaultProvider` in config file
4. `OPENROUTER_API_KEY` present → `"openrouter"`
5. Hardcoded `"openrouter"`

**Example config**:
```json
{
  "defaultProvider": "openrouter",
  "customEndpoints": { ... }
}
```

Valid values: any built-in provider name (`"openrouter"`, `"openai"`, `"google"`, `"litellm"`, etc.) or a custom endpoint name defined in `customEndpoints`.

**How it interacts with routing rules**: For each bare-name model, `route()` matches against the rules table, builds the candidate chain, then **appends `defaultProvider` to the end** if it isn't already in the chain (deduped against shortcuts — `or` and `openrouter` are treated as the same provider). The combined chain is then credential-filtered. Explicit `provider@model` specs are not affected — `defaultProvider` only applies to bare names.

**No more LiteLLM auto-promotion** (removed in commit 5 of the model-catalog and routing redesign): Setting `LITELLM_BASE_URL` + `LITELLM_API_KEY` no longer makes LiteLLM the default. Users who want LiteLLM as the catch-all must set `defaultProvider: "litellm"` explicitly.

### Vendor Prefix Auto-Resolution (ModelCatalogResolver)

API aggregators (OpenRouter, LiteLLM) require vendor-prefixed model names that users shouldn't need to know. The `ModelCatalogResolver` interface searches each aggregator's dynamic model catalog to find the correct prefix automatically.

**How it works**: User types bare model name → resolver searches the provider's already-fetched model list → finds the exact match with vendor prefix → sends the prefixed name to the API.

**Current resolvers**:
- **OpenRouter**: `or@qwen3-coder-next` → searches catalog → sends `qwen/qwen3-coder-next`
- **LiteLLM**: `ll@gpt-4o` → searches model groups → finds `openai/gpt-4o` (prefix-strip match)
- **Static fallback**: `OPENROUTER_VENDOR_MAP` for cold starts when catalog isn't loaded yet

**Key design rules**:
- Exact match only — no fuzzy/normalized matching. Find the right prefix, don't guess the model.
- Dynamic catalogs (from provider APIs) are PRIMARY. Static map is cold-start fallback only.
- Resolution happens BEFORE handler construction (in `proxy-server.ts`), not inside adapters.
- Sync entry point (`resolveModelNameSync()`) — uses in-memory caches + `readFileSync`, no async propagation.

**Firebase slim catalog** (v7.0.0+): The `aggregators[]` field on model documents provides a typed multi-provider routing index. Each entry is `{ provider, externalId, confidence }`. Claudish only consumes this hosted catalog at runtime. Catalog extraction, recommendation generation, portal hosting, and API documentation live in the [models-index](https://github.com/MadAppGang/models-index) repo.

**Adding a new aggregator resolver**: Implement `ModelCatalogResolver` interface in `providers/catalog-resolvers/`, register in `model-catalog-resolver.ts`. No changes to proxy-server or provider-resolver needed.

**Architecture doc**: `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md`

## Local Model Support

Claudish supports local models via:
- **Ollama**: `claudish --model ollama@llama3.2` (or `ollama@llama3.2:3` for concurrency)
- **LM Studio**: `claudish --model lmstudio@model-name`
- **Custom URLs**: `claudish --model http://localhost:11434/model`

### Context Tracking for Local Models

Local model APIs (LM Studio, Ollama) report `prompt_tokens` as the **full conversation context** each request, not incremental tokens. The `writeTokenFile` function uses assignment (`=`) not accumulation (`+=`) for input tokens to handle this correctly.

## Context Window and Auto-Compaction (v7.24.0+, status line v7.28.0+)

Claude Code resolves its compaction point as `min(CLAUDE_CODE_AUTO_COMPACT_WINDOW, maxContextTokens(model))`, and `maxContextTokens` falls back to a hardcoded **200,000** for any model name it does not recognise — which is every model claudish proxies. Setting only the first lever therefore accomplishes nothing: the real window is accepted and then thrown away by the `min()`. `resolveContextWindowEnv()` (`claude-runner.ts`) sets **both**, and Claude Code honours `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only for model names not starting with `claude-`, i.e. exactly the pure-proxy case.

**The env is read at SPAWN and never revisited.** A long-running claudish process keeps whatever window it was launched with; upgrading the package on disk does nothing for a live session. Diagnosing this is easy once you know the tell: inside ONE pre-fix process, subagents pinned to `model: "opus"` (a name Claude Code knows as 1M) compact at ~340K while the main thread on the proxied model compacts at ~170K. Ground truth is `compactMetadata.preTokens` in the Claude Code transcript.

**The status line reports the ENFORCED window, not the spec window.** `TokenTracker.writeFile` derives `context_left_percent` from `inputTokens` alone — folding in the session-CUMULATIVE `outputTokens` made the value decay with session AGE and pin at 0 forever once lifetime output passed the window (measured: input 94,018 of a 372,000 window reporting 0% left). Both generated status-line variants then recompute against `min(spec window, CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? 200000, CLAUDE_CODE_AUTO_COMPACT_WINDOW)` and render `18% (164k/200k of 372k)` when those disagree, so a clamp is visible on day one instead of costing days of half-context work.

The status line is a generated **shell one-liner** (and a generated JS file on Windows), so TypeScript cannot catch a typo in it — test the generated artifact by executing it (`status-line-context.test.ts`). `CLAUDISH_TOKEN_FILE` redirects `TokenTracker`'s output path for hermetic tests; do NOT try to move `HOME`, since `homedir()` cannot be re-pointed at runtime in Bun. Bash integer division truncates where JS `Math.round` rounds, so the bash variant uses `((x*200/w)+1)/2` to keep both platforms on the same number.

## Custom Endpoints (v7.0.0+)

Define named custom endpoints in `~/.claudish/config.json` under the `customEndpoints` key. Each endpoint registers as a provider prefix usable with `@` syntax.

### Config schema

**Simple endpoint** (most common):
```json
{
  "customEndpoints": {
    "my-vllm": {
      "kind": "simple",
      "url": "http://gpu-box:8000",
      "format": "openai",
      "apiKey": "${VLLM_API_KEY}",
      "modelPrefix": "my-org/",
      "models": ["llama3.1-70b", "qwen2.5-72b"]
    }
  }
}
```

**Complex endpoint** (full control):
```json
{
  "customEndpoints": {
    "corp-proxy": {
      "kind": "complex",
      "displayName": "Corporate LLM Proxy",
      "transport": "openai",
      "baseUrl": "https://llm.corp.internal",
      "apiPath": "/api/v2/chat/completions",
      "apiKey": "${CORP_LLM_KEY}",
      "authScheme": "X-Api-Key",
      "headers": { "X-Team": "platform" },
      "streamFormat": "openai-sse",
      "modelPrefix": "",
      "models": ["gpt-4o", "claude-sonnet"]
    }
  }
}
```

Use as: `claudish --model my-vllm@llama3.1-70b "task"` or `claudish --model corp-proxy@gpt-4o "task"`.

### Key details

- **`${VAR_NAME}` expansion**: The `apiKey` field expands environment variables at startup. Use this instead of hardcoding secrets in config.
- **Zod validation**: Claudish validates all custom endpoints at proxy startup. Invalid entries emit a stderr warning and are skipped — they don't crash the proxy.
- **Runtime registration**: Endpoints call `registerRuntimeProvider()` and `registerRuntimeProfile()` to inject themselves into the provider resolver and transport layers.
- **`models` field** (optional): When present, limits the endpoint to listed models. Omit to allow any model name.
- **`modelPrefix` field** (optional): Prepended to the user-specified model name before sending to the API.

## 1Password Integration (v7.6.0+)

All 1Password logic lives in `packages/cli/src/providers/onepassword.ts` (dependency-light: imported by `index.ts` before heavy deps; uses only node built-ins at module load). Secret operations are **SDK-only** — the `@1password/sdk` is **dynamically imported** (`await import` inside `defaultSdkClientFactory`) only when SDK auth is present AND a secret/field/environment is actually needed — a normal run never loads the ~10MB WASM. **Requires the beta** `@1password/sdk@0.4.1-beta.1` (exact pin): the stable 0.4.0 has no `environments` API.

### Resolution model: SDK-ONLY (no `op` CLI for secrets)
- **All three operations** — resolving `op://` refs (`secrets.resolveAll`), glob field discovery (`vaults.list` → `items.list` → `items.get`), and Environments (`environments.getVariables`) — go through the SDK. There is **no `op` CLI fallback**.
- Public async entry points: `resolveSecrets()`, `readEnvironment()`, `discoverItemFields()`/`resolveGlobImport()`. All accept `{ sdkFactory?, auth?, env? }`; `acquireSdkClient()` is the shared "resolve auth → build client → hard-fail if no auth" helper.
- **Hard-fail** on any failure including no-auth (explicit opt-in via `op://` or `--op-env`); **zero cost** (no SDK/`op` touched) when no op:// source is present.
- The **one** remaining `op` binary touch is an **optional, read-only `op account list --format=json`** (`defaultOpAccountLister`) used SOLELY for the multi-account picker — it never sees a secret and degrades to an actionable error when `op` is absent.

### Auth resolution (DesktopAuth account selection)
`detectSdkAuth(env)` is env-only: `OP_SERVICE_ACCOUNT_TOKEN` → token; else `OP_ACCOUNT` → DesktopAuth. The richer `resolveSdkAuth(opts)` (async, called once by `index.ts` and memoized via `getSdkAuth()`, so a multi-account user is prompted at most once per run) resolves in order: **token → `OP_ACCOUNT` → `onepasswordAccount` config (global `~/.claudish/config.json`, local `.claudish.json` wins) → single auto-detected account (`op account list`) → interactive picker (multiple accounts + TTY; the choice is saved to global config) → hard-fail** (multiple accounts non-interactive, or `op` absent). The account **URL** (e.g. `my-team.1password.com`) is the saved/`OP_ACCOUNT` value — it's unique even when two accounts share an email. The SDK cannot reuse an interactive `op signin` session, so an `op signin`-only setup must now set `OP_ACCOUNT` (DesktopAuth) or a service-account token.

### Locked-screen denial recovery (v7.20.0+)
1Password returns the SAME error for two different situations: the user saw the desktop approval dialog and clicked **Cancel** (a decision), and the Mac was **locked** so the dialog could not be shown at all and 1Password auto-denied (an environmental condition). Both read `Denied authorization for SDK client`, which is why `isTransientSdkError` pins any denial as TERMINAL — retrying a Cancel re-opens the dialog the user just dismissed (the "second dialog" bug, commit `aa71ce3`). That guard is **unchanged**.

The ambiguity is resolved from OUTSIDE the error, by probing screen-lock state: `defaultScreenLockProbe` runs `ioreg -n Root -d1 -a` and matches `CGSSessionScreenIsLocked` (present only while locked; ~15ms; darwin-only — other platforms return false and keep terminal behavior). `isLockedDenial(err, env)` = denial **&&** no `OP_SERVICE_ACCOUNT_TOKEN` (token auth never shows a desktop prompt, so waiting would be theatre) **&&** screen locked. `withSdkRetry` now **wraps** the transient-IPC loop (`withSdkTransientRetry`) in an OUTER lock-round loop, keeping the two time domains separate: the inner loop owns millisecond-scale IPC blips (150ms·attempt), the outer owns the human-scale "go unlock your Mac" wait. Every non-locked-denial error propagates from the inner loop unchanged.

On a locked denial the user gets a friendly explanation (printed ONCE, on round 1 — re-explaining every 10s reads as nagging) plus a 10-second countdown, up to `LOCK_RETRY_ROUNDS` (3) → 3 retries ≈ 30s. The countdown **breaks early** the moment the probe reports unlocked, so approving is immediately followed by the prompt. Cancellation degrades by CAPABILITY, not by mode (interactive and non-interactive must behave identically — an explicit product decision): TTY stdin → Esc/q/Ctrl-C; otherwise Ctrl-C via SIGINT. The live `\r\x1b[2K` redraw and ANSI styling apply ONLY when `process.stderr.isTTY` (checked at call time, not module load) — under an MCP host or channel session stderr is a captured pipe, which gets one static line per round instead. Test seams: `setScreenLockProbe()` and `setLockRetryTiming({seconds, tickMs})` — the latter is MANDATORY in tests or the suite gains 30 real seconds.

### Concurrent-spawn denial prevention (v7.22.0+)

A THIRD situation produces the same `Denied authorization for SDK client`, and unlike the two above it is neither a decision nor a lock state: **several claudish processes racing the DesktopAuth handshake at once**. 1Password arbitrates that handshake across the whole MACHINE, not per process — it authorizes ONE client and instantly denies every concurrent peer. `runSdkExclusive` serializes SDK calls WITHIN a process (the `-4` IPC fix), but `team-orchestrator.ts` and channel `create_session` spawn N sibling PROCESSES, each building its own client, and no in-process queue can span those.

Measured on a real 7-model `team` run (session `team-20260729-163623`): all seven children spawned within 6ms, five hit the denial, and only the models whose key was already in the shell env survived — `errors/01.log` shows a model that COMPLETED while still logging two denials. Reduced repro with lock state held constant (unlocked in both arms): 6 children in a tight loop → **5 denied**; the same 6 staggered 4s apart → **0 denied**; a single child → fine. So this is not the locked-screen case and the lock probe does not fire for it (`isLockedDenial` requires a locked screen, and a denial while unlocked stays TERMINAL).

The fix PREVENTS the race rather than recovering from it: `auth/credentials/prehydrate.ts`'s `prehydrateCredentialsForSpawn(models)` runs `validateApiKeysForModels` in the PARENT before any child is spawned. The authority write-throughs each resolved op:// key into `process.env` (api-key-credential.ts), children inherit `process.env`, so they find the key in step 1 of the chain and never construct an SDK client at all — exactly the state the surviving models were already in. One serialized resolve, one handshake, regardless of model count (a 1Password Environment is fetched once per process via the single-flight memo). Called at both spawn sites; NEVER throws (a credential that cannot be pre-resolved just stays missing and the child reports it as before — failing the spawn would turn "one model has no key" into "the whole team run died").

This covers every spawn site claudish owns, but it is not the whole fix — see the next section.

### The denial is SELF-AMPLIFYING, and the handshake lock (v7.25.0+)

Measured 2026-07-31 with a bare `@1password/sdk` probe — no claudish in the picture, screen unlocked, app unlocked (`ai-docs/sessions/op-denial-rootcause-20260731-153357-90bf2332/`): 1 process → authorized; **6 concurrent → 1 authorized, 5 denied in 945–1029ms**; 6 concurrent behind a cross-process lock → **6 authorized, 0 denied**. Two structural facts came out of it: the denial fires on **`createClient()` — the handshake**, not the secret fetch; and an already-authorized client is **not** revoked when a peer authorizes. So the lock needs to cover the handshake ONLY.

1Password's own log names the mechanism:

```
WARN  [1P:op-automated-unlock/src/lib.rs:620] Suppressing Automated Unlock for 15s.
      Too many denied attempts in a short time period.
```

The handshake is gated by **Automated Unlock**, and a burst of denials trips a **15-second global suppression** during which EVERY request is denied instantly — including sequential ones from unrelated processes. One race poisons the next 15 seconds for all of claudish, which is why the failures looked erratic and why a single collision could cost a team run several models. It also confounds naive A/B measurement: an arm run seconds after a failing arm measures the penalty box, not the change. **Separate measurement arms by ≥40s.** Denial latency is a real discriminator — suppression returns in ~190ms, a successful authorization takes ~1.5–1.9s, a human Cancel takes seconds.

Two additions, both preventive:

- **`providers/onepassword-handshake-lock.ts`** — `withHandshakeLock()` wraps `createClient()` in `defaultSdkClientFactory`, **DesktopAuth only** (a service-account token is authorized by its value; there is nothing to arbitrate). `O_CREAT|O_EXCL` at `~/.claudish/op-handshake.lock`, jittered poll, dead-holder detection via `kill(pid, 0)`, 120s stale-steal (generous ON PURPOSE — the handshake can block on a human clicking Authorize, and stealing mid-approval recreates the race), 45s acquire timeout then proceed unlocked. Never throws, never blocks a run indefinitely: the lock is an optimisation of WHEN, not a gate on WHETHER. `CLAUDISH_NO_OP_HANDSHAKE_LOCK=1` bypasses; `CLAUDISH_OP_LOCK_TRACE=1` emits one stderr line per transition — added because a lock that silently fails to engage is indistinguishable from no lock, which is exactly how the confounded arm above was caught. This closes the INDEPENDENT-process case that no parent/child protocol can reach. Test seams: `setHandshakeLockTestSeams({path, timing})` — MANDATORY in tests or the suite inherits the 45s timeout.
- **The `CLAUDISH_OP_UNAVAILABLE` skip-list** — pre-hydration only covers keys 1Password CAN supply. A bare model name filters a CHAIN; the parent short-circuits at the first credentialed candidate while each child walks the chain from the top, so candidates 1Password has nothing for still send every child to the SDK. `op-source.ts` records the names a CLEAN resolve came back empty for; `prehydrateCredentialsForSpawn` publishes them to children, and children drop those names before resolving. **Published ONLY when `getOpFailures()` is empty** — a denial also produces an empty resolve, and publishing that would teach every child that a key the user really does store in 1Password is permanently absent, turning one transient denial into a run-wide outage. Children apply the INHERITED list only; within a process a miss stays uncached, as `api-key-credential.ts` intends.

Concretely, on the developer's own config the Environment holds CODING-PLAN credentials — `GLM_CODING_API_KEY` (claudish's `gc@` GLM Coding Plan provider, alias `ZAI_CODING_API_KEY`) and `GOOGLE_GEMINI_API_KEY` — while the chain for a bare `glm-*` / `gemini-*` name also probes the PAYG names `ZHIPU_API_KEY` / `GLM_API_KEY` / `GEMINI_API_KEY`. Those are **different credentials on different billing plans, not misspellings of each other**: they are absent from the Environment because they genuinely do not belong there, and aliasing one onto the other would silently bill the wrong plan. So the PAYG lookups can never resolve, and before the skip-list every child opened an SDK client to chase them.

**Not built:** retrying a denial once the 15s suppression expires. `isTransientSdkError` pins denials as TERMINAL to prevent the "second dialog" bug (`aa71ce3`), and relaxing that needs its own decision; the ~190ms latency signature is the evidence that would justify it.

### 1Password failure provenance
Every op-source failure is deliberately NON-FATAL (warn + skip, so a broken import can never lock the user out). That meant a denied authorization surfaced downstream as a plain "missing key" error telling the user to `export` a credential they already store in 1Password. `recordOpFailure()` / `getOpFailures()` / `renderOpFailureNotice(envVar)` in `onepassword.ts` are the negative counterpart to `recordOpHydratedVars` (same run-scoped, in-memory rationale), recorded at all four non-fatal catch sites in `op-source.ts`. `getMissingKeyError` splices the notice ABOVE the generic remediation and switches its header to "Or set the key directly:" — when a key lives in 1Password, approving is the fix and exporting a literal is the bypass. The record is deliberately COARSE (run-scoped, not per-env-var): an Environment fetch is all-or-nothing, so when it fails claudish genuinely cannot know which variables it would have supplied. Output is byte-identical to the old error when no failure was recorded, so non-1Password users see no change.

### Glob field import
A top-level `onepassword: string[]` config array holds glob paths. `isGlobImport()` detects a `*` in the post-item path segment(s); `resolveGlobImport()` does three phases: **discover** field names via the SDK (`vaults.list` → `items.list` → `items.get`, matching by title; duplicate titles → first-match + stderr warn) → **filter** by section-glob + field-glob (`globToRegExp`) → **resolve** only survivors via `resolveSecrets` (batched, in-memory). The SDK's `ItemField` has no ready-made `reference`, so each field's `op://` ref is **synthesized** from the vault/item/section/field titles. The SDK decrypts every field value to list names — no different from `op item get`, which also decrypts everything in-process; we keep only a `hasValue` flag, never the value. Field labels are trimmed; invalid env-var names are skipped with a warning.

### Custom-endpoint op:// apiKeys (pre-resolved at startup)
Provider construction is **synchronous** and can't await the async SDK, so a custom endpoint's `op://` `apiKey` is **pre-resolved in `index.ts` `applyCustomEndpointOpKeys()`** into `CUSTOM_<sanitize(name)>_KEY` (UPPERCASE, non-alphanumerics → `_`). `custom-endpoints-loader.ts`'s `createHandler` reads `process.env[apiKeyEnvVar]` **first**, falling back to `resolveCustomEndpointApiKey()` (which now only expands `${VAR}`/literals — it no longer touches 1Password).

### CLI surface (`onepassword-command.ts`)
- `claudish --op "op://.../*" --list` → `opPreviewCommand(glob, { auth })`: lists matching field names via SDK `items.get`, **never values**.
- `claudish --op "op://.../*" [...args]` → `applyOpImport()`: resolves glob → hydrates `process.env` → runs a normal session with the remaining args (inline mode is glob-only; single refs go in config).
- `--op-env <id>` → 1Password Environments via the SDK `environments.getVariables` (beta-only). **Point-of-need since v7.16.0**: registered as a lazy op source (like config `onepasswordEnvironments[]`) and resolved by the credential authority ONLY when a routed provider's key misses env/config — no longer resolved eagerly at startup (which prompted on `--update`/`--version`/OAuth-only sessions and stormed across spawned children), no longer a highest-priority overwrite (env/config already set wins).

### TUI surface — the "1Password" tab (`claudish config`, tab 5)
The OpenTUI config interface (`packages/cli/src/tui/`) exposes a dedicated **1Password tab** managing, at both **global** (`~/.claudish/config.json`) and **project** (`./.claudish.json`) scope: the `onepasswordAccount`, per-item `op://` refs + glob imports (`onepassword[]`), and 1Password **Environments** (`onepasswordEnvironments[]`, a NEW persisted config field mirroring `--op-env`).

- **Persistence**: `providers/onepassword-config.ts` — scope-aware, **config-only** (no SDK at module load), all SYNC with an injectable `OpConfigPaths` test seam. Both scopes use a **raw read-modify-write** (preserves unrelated keys; never routes global through profile-config's cached-`homedir()` `CONFIG_FILE`, so global is hermetically testable). `index.ts`'s `readConfiguredOnepasswordAccount`/`saveOnepasswordAccount` now delegate here. **Point-of-need (v7.16.0):** `applyOpEnvironment()` no longer resolves anything — it only **validates** the `--op-env` flag shape; both `onepasswordEnvironments[]` config and the `--op-env` flag are discovered + resolved LAZILY by `auth/credentials/op-source.ts` (`registeredEnvironmentIds` = seam-aware config env ids + argv `--op-env`; `resolveEnvironmentShared` = single-flight, whole-environment `getVariables` cached into `resolvedCache`) only when a routed provider key misses env/config. `onepasswordEnvironments` is added to `profile-config.ts`'s `loadConfig` allowlist so global round-trips preserve it, and to `op-source.ts`'s `SniffedConfig` so tests can inject it through the existing seam.
- **TUI wiring**: tab/mode/types in `tui/types.ts` (`OpEntry`/`OpScope`/`OpKind`); `tui/components/OnepasswordContent.tsx` (auth card + merged scope-marked scrollable list — ▴ project / • global / · env), `OnepasswordDetail.tsx` (browse-only entry detail), and `OnepasswordModal.tsx` (the centered **absolute-overlay** add-wizard — `position="absolute"` + `zIndex`, painted as the topmost sibling of the root box, NOT crammed in the bottom strip). `App.tsx` owns state + the keyboard handler. Scope model mirrors Routing; pickers follow the Profiles `<select>` pattern (focused `<select>` owns ↑↓ via `onChange`; `useKeyboard` owns Enter/Esc).
- **Add wizard flow** (`a` key) — **browse, don't type**: Step 1 **scope** (global/project) → Step 2 **account** picker (shown ONLY when `!detectSdkAuth()` AND `resolveDesktopAccount()` returns `needsPicker`, i.e. >1 account & not authed; auto-skipped otherwise) → Step 3 **kind** (intent-labeled `<select>` with descriptions ON: "API key from an item" / "Environment") → Step 4 **value**:
  - **API key** → per-level pickers `pick_op_vault` → `pick_op_item` → `pick_op_field` (from `listVaults`/`listItems`/`discoverItemFields` — two tiny new engine exports `listVaults`/`listItems` mirror `discoverItemFields`' `acquireSdkClient`). The `op://Vault/Item/[Section/]Field-or-*` path is **built from the literal titles** (`buildFieldOptions` in the modal) — the user never types `op://`. Globs always target ONE concrete vault+item (the grammar forbids multi-vault/item globs). Each level shows a "◌ Loading…" state while the async SDK call runs; Esc steps back one level (field→item→vault→browse). **Inline fuzzy filter**: the vault/item/field (and account) pickers are MANUALLY rendered (not `<select>`) so App owns ↑↓ + a shared `opFilter` string — typing narrows the list via `fuzzyMatch` (case-insensitive subsequence, in `OnepasswordModal.tsx`), backspace widens, a "filter: … N matches" header + "no matches" empty state show state, and the filter resets on every level entry/exit. `*` is excluded from filter input (`isFilterChar`) — it'd match literally in the subsequence filter and exclude every concrete-field row.
  - **Grouped field picker** (`buildFieldOptions` → `FieldPickerOption` with a `selectable` flag): rows are `★ Import everything (all N fields)`, then per-SECTION groups — a non-selectable **header** = the section title (often the user's key name, e.g. `GOOGLE_GEMINI_API_KEY`), then a nested `↳ import all N fields` glob, then each concrete field — then a `(no section)` group for top-level fields. This replaced the confusing flat `section 'X' — all fields (*)` rows (when a user keeps one key per section, the header now reads as the key group, not gibberish). The cursor SKIPS header rows (App's `nextSelectable`/`firstSelectable` + a `useEffect` cursor-snap; Enter guards on `chosen.selectable`). The selected option's full `op://` path renders on ONE fixed "saves: …" footer line, mid-truncated (`midTruncate`) so it never wraps/overlaps rows.
  - **Environment** → typed ID (the SDK has **no** way to enumerate Environments — only `getVariables(id)`) with a **two-Enter NAME preview**: Enter#1 → `readEnvironment` → render variable names (no values); Enter#2 → persist.
- **Importable-only, FLAT field list** (`buildFieldOptions`): only **importable** fields are shown — concealed (SDK `fieldType === "Concealed"`, case-insensitive) AND a valid env-var name; everything else (notes/username/`credential`) is hidden, and sections with zero importable fields are omitted. The list is **flat and uniform** (no headers/gaps — earlier grouped/collapsed layouts made single-key and multi-key sections look like different items): one selectable key row per field, rendered `ENVNAME  ·  section` (env-var name green, section a dim aligned tag). A MULTI-key section additionally gets one `↳ all of <section> (N, auto-updates)` glob row after its keys; the sectionless `★ All top-level keys (N, auto-updates)` glob is appended only when importable top-level keys exist. `renderFieldPicker` renders this in a bordered scroll region with `▲/▼ more` indicators; the selected option's full `op://` path shows on the fixed "saves: …" footer (`midTruncate`d, `dialogW - 16`, so it never wraps).
- **SDK call SERIALIZATION (`-4` fix)**: the 1Password SDK's WASM↔desktop-app IPC bridge is **NOT safe for concurrent calls on a shared client** — two ops in flight at once corrupt the channel → `IPC operation failed: -4`. The config TUI fires overlapping calls (e.g. a post-save confirm AND the main-list glob-expansion at the same instant), which reliably triggered it. Fix in `onepassword.ts`: a process-wide `runSdkExclusive` queue chains every SDK op so **at most one runs at a time**, plus `withSdkRetry` (cache-reset + 150ms·attempt backoff, up to 3 attempts) for genuinely transient blips, plus the per-auth client cache (`defaultSdkClientFactory`, one desktop handshake reused). `isTransientSdkError` also matches **stale-desktop-session** errors (`invalid client id` / `invalid session` / `session expired` / `unauthorized` / `token expired`) — after an idle period 1Password expires the SDK session and the cached client's id goes invalid; these are retryable (reset cache → rebuild client = fresh DesktopAuth handshake → retry), so claudish self-heals after idle instead of surfacing `invalid client id`. (The desktop app's re-authorization prompt after idle is 1Password's own session-timeout behavior — claudish can't suppress it, but now auto-retries once approved.) ALL TUI SDK calls (`loadOpVaults/Items/Fields`, `runOpAdd` confirm, `testOpEntry`, `previewOpEnvironment`, the `opExpansions` effect) go through `withSdkRetry` → serialized. Serialization is the PRIMARY fix; the client cache + retry are secondary. Tests: `withSdkRetry` serialization (max-concurrency=1), retry-then-succeed, give-up-after-3, no-retry-on-genuine-error.
- **Field-load speed**: the field picker uses `discoverItemFieldsById(vaultId, itemId, vaultTitle, itemTitle)` — ONE `items.get` SDK call instead of `discoverItemFields`' three (`vaults.list` → `items.list` → `items.get`), ~3× faster on the 1Password desktop-app IPC path. Results are **cached per `${vaultId}:${itemId}`** in `opFieldsCache` (a `useRef` Map), so re-entering an item is instant (no spinner). The latency is desktop-app IPC + WASM load + decrypt (not a network call), so caching + the single-call path are the real wins. `discoverItemFields` (title-based, 3 calls) is retained for `runOpAdd`'s confirm + the main-list glob expansion, which don't have the IDs handy.
- **User-facing terms (no jargon)**: the main list + detail use **key** (single ref), **set** (a glob = many keys), **environment** — never "ref"/"glob". The KIND column color-codes them (key=blue, set=yellow, env=cyan); the auth card summarizes "N keys / M sets / K environments".
- **Sets auto-expand in the main list**: each glob entry resolves its key names + a MASKED value tail lazily via a cached `opExpansions` effect (`discoverItemFields`+`filterGlobFields`, keyed by glob value) and renders them as dim `↳ NAME   ••••XXXX` sub-rows (with `◌ resolving…` / `✗ error` states). The tail is `DiscoveredField.valueTail` — the LAST 4 chars of the value, captured at discovery (where the SDK has already decrypted in-process) via the exported `valueTail()` helper; the full value is never stored/returned/logged. This is the standard "••••1234" identification pattern so the user can confirm WHICH credential is wired up. (The op keys themselves ARE applied to providers — they hydrate `process.env` at startup via `loadStoredApiKeys`, and the Providers tab reads `process.env[apiKeyEnvVar]`; an earlier "providers show not set" report was the `-4` concurrency bug, now fixed by SDK serialization.) Both the main list and the field picker render selected rows as a height-1 highlight box and **non-selected rows as bare `<text>`** (transparent → no dark/blue strips; the earlier `flexGrow` row box painted the whole panel). The field picker's list sits in a **bordered scroll region** with `▲ N above` / `▼ N below` indicators.
- **Glob grammar (claudish-side only — 1Password rejects `*`/`**` outright, so it never sees them)**: `op://V/Item/*` = sectionless/top-level fields only; `op://V/Item/Section/*` (or `*/*`, `M*/*`, `*_KEY/*`) = fields in matching section(s) only; **`op://V/Item/**` = the WHOLE item — every importable field, sectioned AND sectionless** (the `matchAll` flag on `GlobImport`, added because no `*`/`*/*` form unions both axes). `parseGlobImport` maps a lone single-segment `**` → `{sectionGlob:null, fieldGlob:"*", matchAll:true}`; `filterGlobFields` short-circuits the section check when `matchAll`. `**` is purely additive — `*`'s sectionless-only meaning (and its pinned test) is unchanged.
- **`★` rows in the field picker** (`buildFieldOptions`): **`★ All keys in this item (N)` → `op://V/Item/**`** is shown first whenever the item has ≥1 importable key — ONE config entry covers every item shape (no-sections / all-sectioned / mixed). A second **`★ All top-level keys → op://V/Item/*`** appears ONLY for a MIXED item (has sections AND top-level keys), as a narrower pick; it's suppressed for a no-sections item (where `**` already equals `*`). Both counts reflect importable fields only. This replaced an earlier `★ All top-level keys`-only design that couldn't express "the whole item" when keys live in sections.
- **Startup glob failures are NON-FATAL** (`index.ts` `loadStoredApiKeys`): a saved glob that matches nothing (e.g. after a 1Password item edit) now warns + skips per-glob instead of `process.exit(1)` — a bad import must never lock the user out of claudish (especially `claudish config`, where they'd go to fix it). Genuine auth/token failures still hard-fail via the single-ref `resolveSecrets` path.
- **Hydrate-on-add (keys apply WITHOUT a restart)**: after a successful add, `runOpAdd` resolves the new ref/set/environment and **gap-fills the values into the running process's `process.env`** (env already set wins, same rule as startup), then drops all probe handler caches (`invalidateProbeProxyHandlers()`) and `refreshConfig()`. The Providers tab reads `process.env[apiKeyEnvVar]`, so the imported keys light up **immediately** in the same session — previously they only appeared after relaunching claudish (the import only hydrated env at startup). Sets use `resolveGlobImport` (returns the `{envVar:value}` map directly — one resolution both confirms and hydrates); refs use `resolveSecrets` + `envNameFromOpRef`; environments use `readEnvironment`. The status line reports "N keys applied".
- **`runOpAdd` is PERSIST-FIRST**: it writes the ref/glob/env to config **immediately** (the picked option is valid by construction — it came from an SDK-discovered list), then runs a **non-fatal** confirmation test (`resolveSecrets`/`discoverItemFields`+`filterGlobFields`/`readEnvironment`) that only annotates the status line (masked value / key count / var count) — a flaky second SDK round-trip can no longer silently lose the save. A genuine persist failure (or the confirm error) is logged to stderr and shown in the status line. (Earlier bug: re-validating before persist meant a thrown confirm left `onepassword[]` empty — "Imports: 0" despite a successful pick.) Auth still resolves via `resolveSdkAuth` (in-TUI multi-account picker via `pick_op_account` + deferred-promise `onNeedsPicker`); the heavy SDK/WASM stays lazy.

### Tests
`onepassword.test.ts` — hermetic via injectable `SdkClientFactory` (fake client answering `vaults`/`items`/`secrets`/`environments`) and `OpAccountLister` (fake account list) seams; neither the `op` binary nor the real SDK is ever invoked. The SDK-shaped item fixture is **derived** from the real-captured CLI item fixture (no hand-crafted secret-like data). Covers no-auth hard-fail and `resolveDesktopAccount`/`resolveSdkAuth` (env / config / single-auto / multi-picker / multi-error).
`onepassword-config.test.ts` — hermetic via the `OpConfigPaths` seam pointing global/project at temp files (`homedir()` can't be re-pointed at runtime in Bun); covers scope-independent account/imports/environments read-write, project-then-global precedence, idempotent add, empty-list key deletion, `readAllOnepasswordEnvironments` dedup, raw-merge preservation of unrelated fields, and garbled-file tolerance.

## Three-Layer Adapter Architecture (v5.14.0+)

The translation pipeline has three decoupled layers:

### Layer 1: FormatConverter — wire format translation
Translates between Claude API format and target model's wire format (messages, tools, payload).
Each converter declares its stream format via `getStreamFormat()`.
- **Interface**: `adapters/format-converter.ts`
- **Implementations**: OpenAIAdapter, AnthropicPassthroughAdapter, GeminiAdapter, CodexAdapter, OllamaCloudAdapter, LiteLLMAdapter
- **Message/tool conversion**: `handlers/shared/format/openai-messages.ts`, `openai-tools.ts`

### Layer 2: ModelTranslator — model dialect translation
Translates model-specific dialect differences (context windows, thinking→reasoning_effort, vision rules).
- **Interface**: `adapters/model-translator.ts`
- **Implementations**: GLMAdapter, GrokAdapter, MiniMaxAdapter, DeepSeekAdapter, QwenAdapter, CodexAdapter
- **Selection**: `AdapterManager` auto-selects based on model ID

### Layer 3: ProviderTransport — HTTP transport
Handles auth, endpoints, headers, rate limiting. Optionally overrides stream format for aggregators.
- **Interface**: `providers/transport/types.ts`
- **Stream format override**: LiteLLM and OpenRouter implement `overrideStreamFormat()` → `"openai-sse"`

### Composition in ComposedHandler
```
ComposedHandler = FormatConverter (explicit adapter) + ModelTranslator (auto-selected) + ProviderTransport
```

**Stream parser selection** (3-tier priority):
```typescript
transport.overrideStreamFormat() ?? modelAdapter.getStreamFormat() ?? providerAdapter.getStreamFormat()
```

**Adding a new provider**: Add one entry to `PROVIDER_PROFILES` table in `providers/provider-profiles.ts`.
**Adding a new model**: Create a ModelTranslator adapter, register in `adapters/adapter-manager.ts`.
**Verifying wiring**: `claudish --probe <model>` shows the full adapter composition.

### Stream Parsers
Located in `handlers/shared/stream-parsers/`:
- `openai-sse.ts` — OpenAI SSE → Claude SSE (used by most providers)
- `anthropic-sse.ts` — Anthropic SSE passthrough (MiniMax, Kimi direct)
- `gemini-sse.ts` — Gemini SSE → Claude SSE
- `ollama-jsonl.ts` — Ollama JSONL → Claude SSE
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex)

### Errors that ride an HTTP 200 stream (`stream-head-sniffer.ts`)

The Codex backend (`chatgpt.com/backend-api/codex/responses`) reports capacity faults **inside** a 200 body, not via the status code:

```
200 OK
data: {"type":"response.created", ...}
data: {"type":"response.in_progress", ...}
data: {"type":"error","error":{"code":"server_is_overloaded", ...},"sequence_number":2}
```

Every retry hook in claudish keys off the HTTP **status** (`anthropic-compat.ts`'s 429 loop, `gemini-codeassist.ts`'s 429 classifier), so this class of failure bypassed all of them. The parser turned it into an assistant **text block** with `stop_reason: "end_turn"` and `onApiError` only flagged stats — so a transient, textbook-retryable fault became a permanent, successful-looking answer reading `[API Error: server_is_overloaded]`.

`sniffResponsesStreamHead()` peeks at the stream head in `composed-handler.ts` step **7b**, which is the only window where the status code is still ours to choose (once Hono flushes the 200, a 503 is no longer expressible):

- **Retryable** (`server_is_overloaded`, `server_error`, `service_unavailable_error`, prose "overloaded"/"try again later") → re-issue upstream with **progressive** backoff `3s → 15s → 30s` (`STREAM_RETRY_DELAYS_MS`). Progressive, not tight: the outage that motivated this ran ~6.5 minutes, so only the late attempts recover anything.
- **All retries exhausted** → HTTP **503** `overloaded_error`. Safe specifically because `fallback-handler.ts`'s `isRetryableError` does NOT list 503 — it cannot silently switch the user off a pinned model, it reaches Claude Code, which runs its own retry loop.
- **Terminal** in-stream errors (`context_length_exceeded`, `invalid_request_error`) are NOT retried — they keep the existing inline-text treatment, which is the actionable path for them.
- **Anything else** (any content event) → `clean`, and the consumed bytes are **replayed byte-identically** so the real parser sees an unchanged stream.

This is the one place the 400-not-503 doctrine (`composed-handler.ts` ~line 461) is deliberately inverted. That rule exists because a 503 makes Claude Code show "API error · Retrying · attempt N/10" with the real reason buried — correct for **terminal** faults, where retrying is theatre. An upstream overload is the opposite: genuinely transient, and the retry banner is the appropriate behaviour because retrying is the actual remedy. Terminal → 400 inline; transient-after-our-own-retries → 503.

**Trade-off to know:** sniffing withholds response headers until the first decisive event, capped by `DEFAULT_SNIFF_BUDGET_MS` (12s, chosen above the 0.85s–7.7s error latencies observed in the real log). On a healthy xhigh-reasoning turn that delays `message_start` by however long the model thinks before its first output item. No content is lost or reordered — the client shows a spinner either way — but time-to-first-byte is genuinely later than before. Past the budget claudish flushes and degrades gracefully to the inline-text path.

`latency_ms` for a retried turn includes the backoff waits by design: the honest figure is time-to-usable-response.

## Layer 4: Behavior Compatibility Layer (`behavior/`)

Layers 1-3 translate the wire format, the model dialect, and the transport. Layer 4 translates **harness behavioral conventions** — the unwritten protocols Claude Code expects an agent to follow. A foreign model can speak the wire format perfectly, use every tool correctly, and still break Claude Code by violating one.

**The motivating case.** CC 2.1.220's `ExitPlanModeV2` takes **no** `plan` parameter — its advertised schema is `{allowedPrompts?}` and its description says "This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote". `normalizeToolInput` injects `plan` from disk at the session's assigned path. So `ExitPlanMode({})` is **correct**; the failure is upstream. gpt-5.6-sol wrote a complete 12.9 KB plan under a filename it invented, CC read the assigned path, found nothing, and returned `plan: null` — which downgrades the approval dialog from the rich form (`Yes, and bypass permissions` / `Yes, auto-accept edits` / `Yes, manually approve edits`) to a bare "Exit plan mode?" yes/no. That rich dialog is the **only** surface offering permission elevation on exit, so the session always falls back to `prePlanMode ?? "default"` = manual approval.

Measured over 115 recorded `ExitPlanMode` calls: native Claude 87/87 carried a plan, Kimi-via-claudish 4/4, gpt-5.6-sol 17/24 empty. The discriminator is exact — sessions that wrote to the assigned path got the rich dialog 7/7, sessions that did not got the degraded one 17/17 — and failures ran at ~1.75x the context (178K vs 102K median input tokens). **Not a translation bug**: the same model through the same proxy got the random CC slug right in a shorter session.

### Two pipeline defects this required fixing first

- **`beforeRequest` ran after `buildPayload`.** It is now step **3b**, before step 4. On Chat Completions the old order worked only by accident (`payload.messages = messages` aliases); on **Codex/Responses** `buildPayload` deep-copies both arrays and lifts system into `payload.instructions`, so every middleware mutation was silently discarded on exactly the path gpt-5.x uses. Keep 3b ahead of 4.
- **`openai-responses-sse.ts` had no hooks at all** — no middleware, no `tool-call-recovery`, while `openai-sse.ts` had both. Now wired.

### Design

Rules **return** actions; the engine applies them. Nothing else in the layer mutates the request, which is what makes severity levels meaningful and every change attributable to a rule id.

- **Severity is linter semantics**: `off` / `warn` (log, don't apply) / `fix` (apply). Config resolution is exact id → longest glob → the rule's own default, so `{"plan-mode/*": "off", "plan-mode/plan-file-path": "fix"}` works.
- **`RuleAction` is a closed union** (`injectSystemNote`, `rewriteToolDescription`, `repairToolArgs`, `warn`). An open "run this callback" action would make rule effects unauditable and defeat severity.
- **Sessions, not instance state.** `ComposedHandler` is cached per model and can serve overlapping requests, so detected harness facts live on a per-request `BehaviorSession` captured by the stream-parser closure. Two in-flight turns cannot read each other's plan path.
- **`armed(facts)` gates buffering.** `repairToolArgs` is only possible if a tool's arguments are withheld until the call completes (the Responses parser streams `input_json_delta` the instant each fragment arrives). Buffering is therefore opt-in per tool AND per request: outside plan mode nothing is buffered and streaming is byte-for-byte unchanged. Without `armed`, intercepting `Write` would suppress incremental file-content delivery on every foreign-model request.
- **Repair is wired into every stream format that carries tool calls**, so it is not a Codex-only feature:

| Parser | Providers | How repair lands |
|---|---|---|
| `openai-sse` | GLM, Kimi, Grok, DeepSeek, Qwen, OpenRouter, LiteLLM | Already buffers whenever the request carries tools (`toolSchemas`), so repair hooks the 6 sites that emit a COMPLETE argument object. The incremental `partial_json` fragment path is deliberately **not** hooked — repairing a fragment would emit malformed JSON. |
| `openai-responses-sse` | Codex / gpt-5.x | Streams fragments immediately, so buffering is opt-in per tool via `shouldBufferTool`. |
| `anthropic-sse` | MiniMax, Kimi direct, Z.AI | Byte-level passthrough, so interception is strictly opt-in: only a named tool has its `input_json_delta` frames withheld and rewritten. Verified byte-identical output for untargeted tools. |
| `gemini-sse` | Gemini | No buffering needed — Gemini delivers each `functionCall` with complete `args` in one part. Uses `repairToolArgs`, deliberately separate from the pre-existing `onToolCall` thought-signature hook. |
| `ollama-jsonl` | Ollama local | Not wired — this parser has no tool-call handling at all. |
- **Off for native Claude** (`claude-*` or provider `anthropic`) — a naming rule, not a pinned roster.
- **Anchors live in `harness.ts` only.** `PLAN_MODE_HINT` is a cheap pre-test and **must stay a superset of the anchors** — an earlier version omitted "create your plan at" and short-circuited a valid anchor away. Never assume `~/.claude/plans`: CC has a `planDir` setting, so the path is always taken from the reminder.

### Why the layer is a SUPERVISOR, not a hint system

Claudish routes **arbitrary models, in arbitrary combinations** — a `team` run mixes vendors in one session, and any of them may be swapped tomorrow. There is no capability floor to design against. Specifically, none of the following can be assumed of a model claudish is asked to drive:

- that it follows an instruction it was given many turns ago, under context pressure
- that it invokes a skill, plugin, or tool that is merely *available* to it
- that it knows Claude Code's conventions at all, let alone the current release's
- that it honours the user's own rules (CLAUDE.md, project conventions) rather than taking a shortcut
- that a capability present in one model of a team is present in its siblings

So conformance cannot be delegated to the model's judgement. That is what makes this a supervisor: it enforces from outside rather than asking nicely from inside.

**The measurement this is built on** (plan mode, 115 recorded `ExitPlanMode` calls across 8 models): the plan-file path was in the conversation the whole time — CC re-injects it every turn — and gpt-5.6-sol still wrote to a self-invented filename in 17 of 24 calls, while native Claude was 87/87 correct and Kimi 4/4. The discriminator was context pressure: failures ran at ~178K median input tokens against ~102K for successes. The information was present and the model stopped acting on it, and *which* model it was mattered more than anything else.

The design rule that follows:

> **Put the fact where the decision is made, deterministically. Do not ask the model to go and get it.**

Hence `plan-mode/plan-file-path` rewrites the **ExitPlanMode tool description** rather than re-stating the reminder: a tool description is re-read at the instant the model decides to call the tool, while a system reminder sits 178K tokens away.

Practical consequences for future rules:

- Prefer **injecting content** over instructing the model to fetch it. If a skill matters for the task, inline what it says rather than telling the model to load it.
- Prefer **deterministic repair** over guidance whenever the correct value is knowable.
- Treat "the model was told" as **no evidence** of compliance. Rules are validated by outcome — did the plan file exist at the assigned path — never by whether the instruction was delivered.
- Assume **nothing transfers between models**. A rule proven on one model is a hypothesis on the next; the corpus is per-model for that reason.
- Scoped to **foreign models**. Native Claude honours CC's own mechanisms (hooks, skills, output styles), so the layer stays off for `claude-*` rather than competing with a harness that already works.

*Related reading, as one illustration of the same class from another team: Vercel's [AGENTS.md outperforms Skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) found a skill went uninvoked in 56% of cases, with always-in-context docs scoring 100% against 53% for skills. Single model, and a narrow eval targeting APIs absent from training data — so it is an anecdote about one symptom, not a basis for this design.*

### The four surfaces a rule can observe

| Hook | When | Can it change the turn? |
|---|---|---|
| `onRequest` | before `buildPayload` | yes — `injectSystemNote`, `rewriteToolDescription` |
| `onToolCall` | tool arguments fully accumulated | yes — `repairToolArgs` (requires buffering) |
| `onModelOutput` | after the response stream completes | **no** — the turn is already on the wire |
| `armed(facts)` | gate | decides whether the rule participates at all |

`onModelOutput` receives **normalized** text, reasoning, and the ordered list of tool names the turn called — never raw stream events. The four parsers deliver four different shapes (a Chat Completions `delta`, a Responses API event, an Anthropic frame, a Gemini part); making every rule understand all four would produce rules that silently work on some providers and not others. Each parser knows its own shape, rules see prose.

Because the response has already reached the client, an `injectSystemNote` returned from `onModelOutput` is **queued for the next request** rather than applied. This is what makes shortcut detection actionable: "you claimed the tests pass but called no command this turn" can only be judged once the turn is over.

**Cross-turn state is keyed by the Claude Code session id.** CC sends it nested inside `metadata.user_id`, which is itself a JSON *string*:

```
metadata.user_id = '{"device_id":"073c…","account_uuid":"","session_id":"ce7d…"}'
```

`extractSessionId()` returns only `session_id`. **`device_id` is a stable machine identifier and must never be journalled or uploaded** — it would defeat the journal's entire no-paths design in a single field. Queued corrections live on the engine keyed by session id (not per-model, or two concurrent conversations against the same model would leak into each other), bounded to 64 conversations with oldest-first eviction.

### Reading the system prompt

`BehaviorContext.systemText` and `harness.skills` expose what already arrives on every request: CLAUDE.md, the user's project rules, and the skill listing. A rule reads these to decide a skill or user rule applies, then **injects the relevant content** — it does not tell the model to go and load a skill, for the reason set out above. `extractAvailableSkills()` returns `[]` when no listing is present, which means *unknown*, not "the user has no skills".

### Config

```json
{ "behavior": {
    "rules": {
      "plan-mode/*": "warn",
      "gpt-5.6-*:plan-mode/plan-file-path": "fix"
    },
    "hooks": ["./.claudish/hooks/my-rule.ts"],
    "observer": { "enabled": true, "mode": "suggest" },
    "telemetry": { "enabled": false } } }
```

Rule keys may be **model-scoped** as `modelGlob:ruleId`. Scoped keys beat unscoped ones, and within each tier an exact id beats a glob and a longer glob beats a shorter one. This exists because nothing transfers between models — a rule proven on one is a hypothesis on the next — so a rule can be armed for the model that needs it without arming it everywhere. (`hook:` ids also contain a colon and are deliberately *not* parsed as model-scoped.)

Hooks are user modules exporting `BehaviorRule`s, namespaced `hook:<file>/<id>` so they can never shadow a built-in; load failures warn and skip. The **observer** is a small local model (vision-proxy contract: hard timeout, `null` on failure, never blocks) that sees only a **digest** — tool names, harness facts, the proposed call's argument keys plus path-like values — never conversation text. Its model is **discovered** via `ollama-discovery` (smallest non-embedding), never pinned, and ids outside the rule vocabulary are discarded as hallucinations.

`behavior/observer/corpus.ts` replays recorded CC transcripts offline to build a **labelled** divergence corpus with no live traffic: CC records `toolUseResult.filePath` (the path it actually read) and `plan: null` (whether it found anything), so every replayed session is known-good or known-degraded for free. Over 1129 local transcripts it independently reproduced the diagnosis — 11 degraded, all gpt-5.6-sol, all four Claude models and all three Kimi models clean, and the rule would have caught 11/11.

### Telemetry — the cross-user corpus (v7.35.0+)

The corpus above is one developer's models on one developer's projects. A rule for a model the maintainer never runs needs evidence from someone who does, which is what `POST https://claudish.com/v1/behavior` collects. Contract and intent: `docs/specs/behavior-telemetry-backend.md`; server-side retention is 12 months, then non-identifying weekly aggregates.

**Opt-in, default off**, via `behavior.telemetry.enabled` or `claudish behavior telemetry --enable`. Deliberately NOT sharing `stats.enabled` — that consent was granted for usage statistics, and reusing it for behavioural records would be consent laundering. Local journalling is unaffected and always on.

- **Session aggregates, not decision records.** One payload per session, counters only, so the server never holds a raw per-decision row. Emitted by `telemetry/aggregate.ts` alongside the local journal write at the same call site, so the two can never disagree.
- **Safety is structural, not promised.** `toUploadable()` is an allow-list projection — a field a future contributor adds to the journal cannot leak, it has to be added explicitly. `pathRelation` is the pattern: `same_dir_wrong_name` is the exact discriminator the plan-mode rule keys off and carries no path. Categorical instead of literal, everywhere.
- **`session_id` is a salted SHA-256** (the server rejects a raw CC UUID). The salt is **per-process and never persisted** — strictly stronger than a stored one: no key on disk to steal, and no way for anyone including us to reverse a delivered id. The model id is folded in, so a session routing to several models yields one aggregate per model rather than colliding on an id the server would treat as a duplicate.
- **`context_bucket` is a CLOSED set** (`0-50k` … `200k+`) validated server-side. Adding a value — e.g. splitting `200k+` for 1M-context models — is a spec change, not a client change.
- **Delivery is spool-then-upload, and it has to be.** A session ends when claudish exits, and `process.on("exit")` is SYNCHRONOUS — a `fetch` started there never completes, and blocking shutdown on a round-trip is not an option when the user is waiting on their prompt. So exit does the one thing it reliably can (`appendFileSync` to `~/.claudish/behavior-outbox.jsonl`) and a LATER run drains it in the background. Same trade `stats-buffer.ts` makes, and a hard kill loses nothing.
- **The drain timeout is 15s, not the 3s `/v1/report` uses.** That endpoint is fire-and-forget on the request path where slowness costs the user; this one blocks nothing. Measured against the deployed service: warm ≈600ms, but a **cold start exceeds 3s** — at 3s the first drain after any idle period fails every time and reports only ever land on a second run. Found by running the real client against the real endpoint; the payload was never the problem.
- 429 is **not** honoured by waiting. A background drain must not sit on a 60s timer, and deferring to the next run is the same outcome, later.

## Debug Logging

Debug logging is behind the `--debug` flag and outputs to `logs/` directory. It's disabled by default.
Keep full debug logging (including empty chunks, raw deltas) in log files — needed to understand real model streaming behavior. Suppress noise at the registration/initialization level (e.g., conditional middleware), not at the streaming data level.

### Raw SSE Capture (v5.14.0+)

When `--debug` is active, both stream parsers log raw SSE events:
- `[SSE:openai] {...}` — every OpenAI SSE data line
- `[SSE:anthropic] {...}` — every Anthropic SSE data line

These are greppable and extractable into test fixtures for regression testing.

## Debugging Failed Model Translations

When a model produces wrong output (0 bytes, garbled, wrong format), use this workflow:

### 1. Reproduce with --debug
```bash
claudish --model minimax-m2.5 --debug "say hello"
# Debug log written to logs/claudish_YYYY-MM-DD_HH-MM-SS.log
```

### 2. Verify wiring with --probe
```bash
claudish --probe minimax-m2.5
# Shows: transport, format adapter, model translator, stream format, overrides
```

### 3. Analyze the debug log
Use the `/debug-logs` slash command in Claude Code:
```
/debug-logs logs/claudish_2026-03-17_09-41-32.log
```

This command:
1. Reads the log and counts text chunks, tool calls, HTTP errors, fallback chains
2. Diagnoses the failure mode (no SSE content, text but 0 stdout, wrong parser, etc.)
3. Extracts SSE fixtures from `[SSE:*]` lines using `test-fixtures/extract-sse-from-log.ts`
4. Adds a regression test to `format-translation.test.ts`
5. Runs tests to confirm the regression is captured

### 4. Extract fixtures manually (alternative)
```bash
bun run packages/cli/src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
# Creates: test-fixtures/sse-responses/<model>-<format>-turn<N>.sse
```

### 5. Run format translation tests
```bash
bun test packages/cli/src/format-translation.test.ts
```

## Channel Mode (v6.4.0+)

The MCP server supports a channel mode that enables async model sessions with push notifications.

### Architecture

Uses the low-level `Server` class (not `McpServer`) from `@modelcontextprotocol/sdk/server/index.js` to declare `experimental: { 'claude/channel': {} }` capability. The SDK's `assertNotificationCapability()` has no default case — custom notification methods like `notifications/claude/channel` pass through.

### Components (`packages/cli/src/channel/`)

- **SessionManager** — spawns `claudish --model X --stdin --quiet` child processes, tracks lifecycle, enforces timeouts
- **SignalWatcher** — per-session state machine (starting→running→tool_executing→waiting_for_input→completed/failed/cancelled)
- **ScrollbackBuffer** — in-memory ring buffer (2000 lines) for session output

### MCP Tools (11 total)

- **Low-level** (4): `run_prompt`, `list_models`, `search_models`, `compare_models`
- **Agentic** (2): `team`, `report_error`
- **Channel** (5): `create_session`, `send_input`, `get_output`, `cancel_session`, `list_sessions`

Tool gating via `CLAUDISH_MCP_TOOLS` env var: `all` (default), `low-level`, `agentic`, `channel`.

### Tool Registration Pattern

Uses a `ToolDefinition[]` registry with raw JSON Schema (not Zod). Two `setRequestHandler` calls replace McpServer's ergonomic API:
- `ListToolsRequestSchema` → returns filtered tool list
- `CallToolRequestSchema` → dispatches to handler by name

### Channel Notifications

`server.notification({ method: "notifications/claude/channel", params: { content, meta } })` — pushed by SessionManager's `onStateChange` callback on state transitions. The method, capability, and params shape match Anthropic's [Channels reference](https://code.claude.com/docs/en/channels-reference) byte-for-byte.

The wire format is contractually pinned by `channel-wire-format.test.ts`:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<string>",
    "meta": {
      "session_id": "<8-char hex>",
      "event": "starting|running|tool_executing|waiting_for_input|completed|failed|cancelled",
      "model": "<model-id>",
      "elapsed_seconds": "<numeric string>",
      "task_id": "<same as session_id>",
      "status": "working|input_required|completed|failed|cancelled",
      "created_at": "<ISO 8601 from session start>",
      "last_updated_at": "<ISO 8601 at notification time>"
    }
  },
  "jsonrpc": "2.0"
}
```

When rendered by Claude Code, each notification arrives in the agent's context as:

```
<channel source="claudish" session_id="…" event="…" model="…" elapsed_seconds="…">
<content here>
</channel>
```

`meta` keys must match `[a-zA-Z0-9_]+` — Claude Code silently drops keys with hyphens or other characters. Our schema uses underscore-only keys (`session_id`, `elapsed_seconds`, etc.); when adding new `extraMeta` keys via `SignalWatcher`, keep this constraint.

The `task_id` / `status` / `created_at` / `last_updated_at` fields are SEP-1686 (MCP Tasks) forward-compatibility — additive only, no current consumer behavior change. The 7-value `event` collapses to the 5-value `status` per `EVENT_TO_TASK_STATUS` in `mcp-server.ts`. When Claude Code ships `notifications/tasks/status` receiver support, the migration is a method-name swap + payload restructure; see `ROADMAP.md` (Channel notifications → Phase 2) and `ai-docs/sessions/dev-research-mcp-tool-progress-20260508-235612-8d9da3e8/sep-1686-migration-schema.md` for the full plan.

### Enabling channel rendering in Claude Code

The Claudish MCP server emits the documented wire format, but Claude Code gates channel **registration** behind several conditions that have nothing to do with the wire contract. All of these must be satisfied for `<channel>` blocks to surface in the agent's context:

| Requirement | Why |
|---|---|
| Claude Code v2.1.80 or later | Channels feature minimum version |
| Anthropic auth via claude.ai OR Console API key | Channels are NOT supported on Bedrock, Vertex, or Foundry |
| Interactive session (no `-p` / `--print`) | Channel registration is bound to the interactive event loop. Empirically verified: in `-p` mode the registration codepath never runs and frames are silently dropped |
| Server defined in project `.mcp.json` or `~/.claude.json` | `--mcp-config` is NOT consulted by the channel resolver. Tools loaded via `--mcp-config` work; channels declared by the same server do not register |
| Server explicitly named in `--channels` OR `--dangerously-load-development-channels` | Being in MCP config alone is not enough. Per Anthropic docs: *"a server also has to be named in `--channels`"* |
| Org policy `channelsEnabled: true` (Team/Enterprise only) | Pro/Max users without an org skip this check |

**Launch command — bare server**:

```bash
# in a directory with .mcp.json containing a "claudish" entry
claude --dangerously-load-development-channels server:claudish
```

**Launch command — via the Magus `code-analysis` plugin** (Claudish is bundled there as an MCP server):

```bash
claude --dangerously-load-development-channels plugin:code-analysis@magus
```

The `--dangerously-load-development-channels` flag triggers a one-time confirmation prompt per session. To remove that prompt, the plugin would need to be added to Anthropic's curated channel allowlist (security review required) or to your org's `allowedChannelPlugins` managed setting.

### Diagnostic tracing — `CLAUDISH_CHANNEL_TRACE=1`

When the channel pipeline appears broken (e.g., client never renders `<channel>` blocks), set `CLAUDISH_CHANNEL_TRACE=1` before starting the MCP server. The diagnostics module (`packages/cli/src/channel/diagnostics.ts`) then emits `[channel-trace] …` lines to stderr at three checkpoints:

1. `fired sid=… type=… model=… elapsed=…s` — onStateChange callback entered (producer side fires)
2. `callback returned sid=… type=…` — bridge invoked `server.notification()` without throwing
3. `WIRE-OUT {…json…}` — the JSON-RPC frame literally hit stdout

If you see (1) but not (2): the bridge is throwing or rejecting silently.
If you see (1)+(2) but not (3): the SDK's transport is dropping the frame.
If you see all three but the client doesn't render the notification: the issue is client-side — most often one of the gating conditions in "Enabling channel rendering in Claude Code" above is unmet.

Off by default. Zero overhead in production.

When the MCP server is spawned by a host that captures stderr (e.g. Claude Code), set `CLAUDISH_CHANNEL_TRACE_FILE=/path/to/log` alongside `CLAUDISH_CHANNEL_TRACE=1` to mirror trace lines to a file you can `tail` from outside the host process. The file is opened with `appendFileSync` so multiple sessions append safely.

Two diagnostic scripts:
- `packages/cli/src/channel/test-helpers/channel-diagnostic.ts` — drives the MCP server with raw JSON-RPC against the OpenRouter free model. Confirms the producer→bridge→wire pipeline.
- `packages/cli/src/channel/test-helpers/client-diagnostic.ts` — spawns `claude -p` against the instrumented MCP server and compares what the server sent vs. what the client surfaced. Useful for diagnosing client-side gating.
- `packages/cli/src/channel/test-helpers/claudish-mock.ts` — a standalone mock MCP server that exposes a single `start_mock_session` tool, then emits a scripted sequence of 6 channel notifications over ~9 seconds. Decouples channel-rendering tests from real-model behavior.

### Testing

```bash
bun test --cwd . ./packages/cli/src/channel/*.test.ts
```

65 tests across 5 files: scrollback-buffer (11), signal-watcher (12), session-manager (21), e2e-channel (15), channel-wire-format (6). The wire-format tests run without an API key by using the fake-claudish PATH shim, so they execute on every CI run.

E2E tests use `--strict-mcp-config --bare --dangerously-skip-permissions` for isolation. SessionManager tests use a fake-claudish PATH shim (`channel/test-helpers/fake-claudish.ts`).

**`--bare` defers the MCP connection past `system/init` — do not assert MCP discovery under it.** Measured 2026-08-01 with a 20-line dependency-free stdio MCP server, so this is Claude Code behaviour, not a claudish one:

| flags | `system/init` `mcp_servers` | MCP tools in the init `tools` array | what the model did |
|---|---|---|---|
| `-p --strict-mcp-config --bare` | `status: "pending"` | none | two `Bash` calls first, then *sometimes* the MCP tool |
| `-p --strict-mcp-config` | `status: "connected"` | present | `ToolSearch` → the MCP tool |

Under `--bare` the tools are not in the model's toolset when it decides what to do, so it improvises with `Bash` — with the real claudish server it answered *"I don't have access to a tool called `mcp__claudish__list_models`. My available tools are `Bash`, `Edit`, and `Read`."* Any test asserting that a tool was DISCOVERED or CALLED must drop `--bare`; `--strict-mcp-config` alone still restricts MCP to the temp config, which is the isolation that matters. Keep `--bare` for tests that only drive the server directly over JSON-RPC.

Assert on the protocol, never on prose: `--output-format stream-json --verbose` exposes the `init` server status, the `tools` array, and the `tool_use`/`tool_result` pair. An assertion like `stdout.includes("Recommended Models")` passes for the wrong reason — it matched output the model produced via `Bash` while MCP discovery was silently broken. Also `proc.stdin.end()` on the spawned `claude`, or every run stalls 3s on "no stdin data received".

## Test Infrastructure

### Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## Version Bumping Checklist

When releasing a new version, update ALL of these locations:
1. `package.json` (root monorepo version)
2. `packages/cli/package.json` (npm-published package - **CI/CD publishes from here**)
3. `packages/cli/src/version.ts` (fallback VERSION constant — moved from cli.ts in v7.0.0)

The fallback VERSION in version.ts ensures compiled binaries (Homebrew, standalone) display the correct version when package.json isn't available. The `packages/cli/package.json` version is what npm publishes - if it's not updated, npm publish will fail.

## Session Artifacts

Write research/planning artifacts to `ai-docs/sessions/{task-slug}-{YYYYMMDD-HHMMSS}-{hash}/` — not `/tmp` (cleared on reboot). Referenced docs live there, e.g. `ai-docs/sessions/dev-arch-20260305-104836-a48a463d/architecture.md`.

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
