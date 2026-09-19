> Connect-protocol protobuf transport, uid resolution, and the wire facts that cost money to get wrong.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Devin Provider (`dv@`) — many vendors' models on one Cognition subscription

The only **binary** wire in the pipeline: Connect-protocol envelopes carrying protobuf, on
`POST <server>/exa.api_server_pb.ApiServerService/GetChatMessage` with `authorization: Basic <k>-<k>`
(the key literally doubled), `content-type: application/connect+proto`, `connect-protocol-version: 1`.
Codec, request builder, credentials, live roster, and uid resolution live in `providers/devin/`;
Layer 1 is `adapters/devin-api-format.ts`, Layer 3 `providers/transport/devin.ts`, the parser
`handlers/shared/stream-parsers/devin-connect.ts`. Full reverse-engineering write-up:
`ai-docs/sessions/dev-arch-devin-subscription-20260806-120000-a1b2c3d4/protocol-spec.md` (write-up lost — predates the ai-docs tracking fix).

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
reasoning as Alibaba Token Plan, which also re-serves other vendors' models.

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
