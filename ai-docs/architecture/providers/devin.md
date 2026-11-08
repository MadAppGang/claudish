> Connect-protocol protobuf transport, uid resolution, and the wire facts that cost money to get wrong.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Devin Provider (`dv@`) — many vendors' models on one Cognition subscription

The only **binary** wire in the pipeline: Connect-protocol envelopes carrying protobuf, on
`POST <server>/exa.api_server_pb.ApiServerService/GetChatMessage` with `authorization: Basic <k>-<k>`
(the key literally doubled), `content-type: application/connect+proto`, `connect-protocol-version: 1`.
Codec, request builder, credentials, live model discovery, and uid resolution live in `providers/devin/`;
Layer 1 is `adapters/devin-api-format.ts`, Layer 3 `providers/transport/devin.ts`, the parser
`handlers/shared/stream-parsers/devin-connect.ts`. Full reverse-engineering write-up:
`ai-docs/sessions/dev-arch-devin-subscription-20260806-120000-a1b2c3d4/protocol-spec.md` (write-up lost — predates the ai-docs tracking fix).

**Auth is the Devin CLI's own token, verbatim.** `~/.local/share/devin/credentials.toml`
(`windsurf_api_key = "devin-session-token$<JWT>"`), overridable with `WINDSURF_API_KEY`;
`WINDSURF_API_SERVER_URL` re-points the backend, which is also the cheapest way to capture traffic
(the CLI validates against the macOS **system** trust store and ignores `SSL_CERT_FILE`, so a
plain-HTTP forwarder beats a MITM CA). No exchange, no refresh, no keychain. There is **no
`claudish login devin`** — the Devin CLI mints the token; claudish only reads it. The read is
memoized by path AND file stamp (`credential-files.md`): a long-lived process picks up a new
`devin login` on its next request, and a file caught half-written keeps the last good key.

**`apiKeyEnvVar` MUST stay `""`.** proxy-server's credential-extraction block runs only for a
non-empty value and extracts the key by stripping `Bearer ` from `auth.headers.Authorization`.
Devin's artifact is `Basic <k>-<k>` on a LOWERCASE header, so that yields `""` → `return null` → the
handler is never built and the model **silently falls through to OpenRouter**. A wrong provider
quietly succeeding is worse than a crash. Same pattern as Antigravity: empty env var + a dedicated
`CredentialProvider` + transport-side `credentials.getRequestAuth()`.

**Access to a RE-SERVED model is always EXPLICIT — no colliding bare name ever routes to Devin.**
Its uids collide head-on with other providers' namespaces (`claude-opus-5-medium` matches
native-anthropic's `/^claude-/i`, `gpt-5-6-luna-medium` matches OpenAI's, `glm-5-2` GLM's,
`kimi-k3-high` Kimi's). The definition therefore declares exactly ONE `nativeModelPatterns`
entry, `/^swe-/i` — Cognition's own line, which collides with nothing — and that claim is the
only way a bare name reaches Devin. Nothing else can: Devin is a dynamic subscription, so it
publishes no catalog connection for `route-candidates.ts` to gather, and the
`DEFAULT_ROUTING_RULES` table that once held a `"swe-*": ["devin"]` entry is deleted. Same
reasoning as Alibaba Token Plan, which also re-serves other vendors' models.

**The reasoning tier is IN the model id — there is no effort parameter.** `dv@claude-opus-5` at
effort `high` resolves to the uid `claude-opus-5-high` via `resolveDevinModelUid` against the LIVE
dynamic models catalog (`getServedDevinModels` = `GetCliModelConfigs` ∩
`GetCliTeamSettings.allowed_model_uids`, minus `contextWindow === 0`, which is what drops the
`adaptive` router pseudo-model). No model list, window, family, or tier is ever hardcoded —
167 models on the developer's own account. Note the two
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
  rewrite checks the dynamic models catalog, names the uid and lists available families, but keeps
  the upstream text, because `permission_denied` was also the symptom of the wrong role enum.
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

**The supervisor hooks stay on for Devin.** The devin profile sets `forceForeignModel: true`, because
Devin serves uids like `claude-sonnet-5-medium` that match the `^claude-` "native Anthropic" test in
`RouteInfo.native` — which would switch the foreign-route built-in hooks (`plan-mode/*`,
`session-context/*`) OFF for exactly the models most likely to need them. The
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

## Raw model list for models-index (`claudish subscription models devin --raw --json`)

**Why it exists.** models-index publishes Devin connections with a fixed effort (the tier lives in
the uid), and its wire-probe runner (a macOS LaunchAgent, no TTY, no browser) needs the account's
dynamic models catalog inputs as evidence. Code: `subscription-devin-models.ts`, loaded by
`subscription-models-command.ts` only for a `devin` argv. The contract is the Antigravity one
(`antigravity.md`, "Raw model list for models-index"): one flushed JSON line on stdout on every exit,
the field-presence rule, the failure classes and exit codes, the secret guard, argv only, stdin never
read. `devin` is the only accepted spelling; the `dv` shortcut is a usage error, as `ag` is.

**It reuses discovery's rpcs; it does not copy them.** `postDevinUnaryRaw` (`devin-models.ts`) sends
`GetCliModelConfigs` and `GetCliTeamSettings` with the bare `application/proto` body and the six-field
unary metadata discovery uses, and returns what the wire did: unreachable, or the status plus the
2xx bytes (or a read failure). Discovery's fail-soft `postUnary` is built on it and still collapses
every failure to `null`. Decoding is the same code: `decodeModelConfigs` and `decodeAllowedUids`.
Each rpc is bounded at 30 s, fetch and read.

Sequence and outcomes:
1. `readDevinApiKey()` (env, then config, then `~/.local/share/devin/credentials.toml`). None:
   `credential_missing` / `devin_credential_absent`, exit 3. No platform check: the Devin CLI's
   file exists on Linux too.
2. `GetCliModelConfigs`. Unreachable: `network` / `model_configs_network_error`, or
   `model_configs_timeout` when the bound fired (also a 2xx body that could not be read). Non-2xx:
   exit 0 with `httpStatus` and no body; the status is the answer. 2xx with no decoded config:
   `list_incomplete` / `configs_empty`.
3. `GetCliTeamSettings`. Unreachable: `team_settings_network_error` / `team_settings_timeout`.
   Non-2xx: `list_incomplete` / `team_settings_http_error` with `failure.httpStatus` (configs without
   entitlement are half an answer). No allowed uid: `list_incomplete` / `allowed_uids_empty`.
4. Success: `body` is JSON TEXT `{"configs":[DevinModelConfig…],"allowedModelUids":[…]}`. Every
   decoded config row is listed UNFILTERED, the `adaptive` ctx-0 row and rows the account is not
   entitled to included: the consumer intersects, exactly as `getServedDevinModels` does.

**Why decoded JSON and not the protobuf as base64.** The guard's scope is literal text plus JSON
escaping. Base64 would carry a credential straight past it, and the decoded fields (uid, context
window, max output, family, the axes with the effort label) are what models-index needs anyway.
`GetCliTeamSettings` is reduced to `allowed_model_uids`, so no team or user field of that answer
reaches stdout.

Envelope keys, in order (`claudish.subscription-model-list.v1`):

```
schema, provider ("devin"), claudishVersion, fetchedAt?, sourceUrl?, clientVersion?,
tokenRefreshed (always false: Devin has no refresh), httpStatus?, teamSettingsUrl?,
teamSettingsHttpStatus?, failure?, body?
```

| Field | Present when |
|---|---|
| `sourceUrl`, `clientVersion` | `GetCliModelConfigs` was attempted. The URL honours `WINDSURF_API_SERVER_URL`, userinfo stripped; the version is `DEVIN_CLI_VERSION`, the one the metadata claims |
| `fetchedAt`, `httpStatus` | `GetCliModelConfigs` answered |
| `teamSettingsUrl` | `GetCliTeamSettings` was attempted (only after a 2xx configs answer with rows) |
| `teamSettingsHttpStatus` | `GetCliTeamSettings` answered |
| `clientVersionSource` | never on Devin |

**Secrets.** The api key, and the part after `devin-session-token$` when that prefix is present: a
vendor echo of the bare JWT must trip the guard too. The body text and the line are checked for both;
a hit exits 1 with the body-free `internal` / `secret_guard` line.

## Wire probe for models-index (`claudish subscription probe devin`)

```
claudish subscription probe devin --model <uid> --request-file <path> --raw --json
```

**Why it exists.** The runner must send ONE real `GetChatMessage` through the user's Devin login to
prove what a connection does on the wire (a `-low` uid against a `-max` uid of the same family),
without ever holding the key. Code: `subscription-devin-probe.ts`, loaded by
`subscription-probe-command.ts` only for a `devin` argv. The envelope, the run wrapper and the exit
codes are the Antigravity probe's (`antigravity.md`, "Wire probe for models-index"); the guard
helpers live in `subscription-secret-guard.ts`.

**The request goes through `dv@`'s own Layer 1, with the uid pinned.** The file holds one Anthropic
Messages body. It is read FIRST (same reader, 8 MiB cap, `request_file_unreadable` /
`request_file_invalid`, exit 2): a request that cannot be sent touches no credential. Then
`new DevinAPIFormat(uid)` runs as `ComposedHandler` drives it (`convertMessages` with the same
identity filter, `convertTools`, `buildPayload`, `prepareRequest`), and the payload's `modelUid` is
set to `--model` verbatim with `effort` deleted. `resolveDevinModelUid` is NOT called: it expands a
tier-less uid (`glm-5-2-1m`) with the request's `output_config.effort`, and the probe exists to test
the uid itself. `encodeDevinRequest`, `devinAuthHeaders` + `content-type: application/connect+proto`,
one `fetch` to `<server>` + `CHAT_PATH`, `redirect: "manual"`, a 300 s bound over the fetch and the
read. No retry, no supervisor hooks, no status-line token file, no stats.

**The answer is decoded, never printed as protobuf** (same reason as the model list):
- Unreachable: `network` / `get_chat_message_network_error`, or `get_chat_message_timeout` when the
  bound fired. A stream that fails with no error frame (the read broke), or that ends without the clean end-of-stream frame (a dropped socket: the parser closes such a turn as `end_turn`, `onEndOfStream` never fires), is the same failure: a truncated turn is never printed as an answer.
- Non-2xx: exit 0 with the body text, capped at 512 KiB and redacted: the vendor's error is evidence.
- 2xx: errors ride the 200, so `sniffDevinStreamHead` reads the head. An error frame is exit 0 with
  `streamError: {code, retryable}` (the `classifyDevinStreamError` verdict) and body
  `{"error":{"code","message"}}`. A clean head goes through `createDevinConnectStream` (the `dv@`
  parser) into `collectSseMessage`: body is the Messages object
  `{id,type,role,model,content,stop_reason,stop_sequence,usage}`. An error frame mid-stream sets
  `streamError` as well, and `content` is then empty.
- Over 512 KiB: `list_incomplete` / `body_too_large`. Not decodable to a fixed point:
  `body_unverifiable`.

Envelope keys, in order (`claudish.subscription-probe.v1`):

```
schema, provider ("devin"), claudishVersion, model, fetchedAt?, sourceUrl?, clientVersion?,
tokenRefreshed (false), httpStatus?, servedModel?, streamError?, failure?, bodyRedacted?, body?
```

`servedModel` is the uid the backend reports in field `7.9`, whenever it reports one, equal to `--model` or not: an equal value is the backend confirming the uid it served. `usage` is the
field-28 counters the parser reports through `onTokenUpdate`, never the collected SSE usage: the
collector keeps `message_start`'s seed (`input_tokens` 100, `message-start-usage.ts`) whenever the
real input count is 0, and that estimate is not evidence. An absent field-28 value prints as 0.

The secrets and the guard are the model list's, plus the probe's redaction: the body is redacted by
exact value (`[REDACTED]`, `bodyRedacted: true`), and the final line, the body and every
`jsonUnescapedForms` form are then checked for the key and the bare JWT.
