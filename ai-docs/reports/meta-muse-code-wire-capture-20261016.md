# Muse Code (Meta) wire protocol: reverse-engineering notes

Muse Code CLI v1.4.8 (`muse-bin-1.4.8-R6256.1`, Mach-O arm64, Rust, build `d1d1e4cfebba63e3f842b6b469dfd6722a799bfd`).
The launcher `~/.local/bin/muse` execs `~/.local/bin/muse-bin-$(cat ~/.local/bin/.muse-version)`.
Captured 2026-10-15 ~14:14Z UTC through a local logging reverse proxy (`proxy.ts`) via `muse exec --base-url http://127.0.0.1:18777/v1`,
plus direct probes (`probe.ts`, `probe2.ts`, `probe3.ts`) using the in-flight Authorization value. That value lived in a 0600 file
during the session and has been deleted. Every secret below is redacted.

Files in this directory:
- `proxy.ts`: logging reverse proxy. `analyze.ts` and `inspect.ts`: capture summarizers. `probe*.ts`: direct endpoint probes.
- `capture.log`: PONG run. `cap2/`: one-tool-call run. `cap3/`: contributor-mode run. `capture.log.reqN.json` holds the full request bodies.
- `strings.txt`: `strings -n 6` of the binary.

## TL;DR for claudish

| Item | Value |
|---|---|
| Base host | `https://api.meta.ai` (`api_base_url` in auth.json is `https://api.meta.ai/v1`) |
| Endpoint muse uses | `POST /v1/responses` (OpenAI Responses API), `stream: true`, `store: false` |
| Also accepted with the subscription token | `POST /v1/chat/completions` (OpenAI chat) and `POST /v1/messages` (Anthropic Messages, with streaming, tool_use and redacted_thinking). All three return 200. |
| Model discovery | `GET /muse-code/models` (rich metadata) and `GET /v1/models` (plain ids) |
| Auth | `Authorization: Bearer LLM\|<17-digit numeric>\|<27 chars>`: an opaque Meta `LLM\|…` token (49 chars), not a JWT |
| Keychain | generic password, service `ai.meta.dev.credentials`, account `meta`, login keychain |
| Login | device code at `https://auth.meta.com/oidc/device/authorization/` and `/oidc/device/token/` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) |
| Contributor mode | header `x-tbh-contributor-mode: 1` and model id suffix `-contributor` |
| Subscription quota | custom SSE event `response.subscription_usage` (5-hour window and weekly, `used_percent`). Seen on `/v1/responses` and `/v1/chat/completions` streams, not on `/v1/messages` |

## 1. Keychain

`security dump-keychain` (metadata only) and `security find-generic-password -s ai.meta.dev.credentials` (no `-w`/`-g`):

```
keychain: "~/Library/Keychains/login.keychain-db"
class: "genp"
    0x00000007 <blob>="ai.meta.dev.credentials"      (label = service)
    "acct"<blob>="meta"
    "svce"<blob>="ai.meta.dev.credentials"
    "cdat"<timedate>="20261015131848Z"
    "mdat"<timedate>="20261015131850Z"
    "desc"/"gena"/"icmt"/"crtr"/"type" = <NULL>
```

This is the only Muse item. The account `meta` matches the `providers.meta` key in `~/.config/muse/auth.json` (`"storage":"keychain"`).
The secret value was NOT read.

Secret payload schema, from binary strings (one serde struct, field names in declaration order):
`access_token, obtained_via, refresh_token, expires_at, api_key, api_base_url, user_full_name, user_email, user_avatar_url, subs_active, secret_schema_version`.
The payload is JSON with these fields, so it carries a `refresh_token` and an `expires_at`. The `mechanism`, `record_version`, `server_name` and
`resource_url_sha256` names belong to a neighbouring MCP-OAuth record (`mcp_oauth:keychain payload exceeds the 16 KiB cap`).

Credential lanes named in the binary: `env_api_key` (META_API_KEY), `stored_api_key` (`muse auth set --api-key-stdin`), `unsaved_api_key`, `subscription`.
Off macOS, or when the keychain fails, muse stamps `credential_backend: "file"` / `keychain_fallback_file`. Fallback reasons include `interaction_not_allowed`.
Env var `TBH_CREDENTIAL_BACKEND` exists.

## 2. Wire capture

### 2.1 Requests muse makes (PONG run)

1. `GET /muse-code/models`. This is the host ROOT, not `{base}/models`: muse strips `/v1` from `--base-url` for this call.
2. `POST /v1/responses`, sent twice in parallel at turn start: `x-tbh-agent-role: main` plus `reminder:skill-reminder` (a reminder agent; `--disable-reminders` removes it).
3. A follow-up `POST /v1/responses` per tool round trip.

### 2.2 Headers (exact names)

`GET /muse-code/models`:
```
accept: */*
accept-encoding: gzip,deflate,br
authorization: Bearer LLM|2…[len=56]          # "Bearer " + 49-char token
user-agent: muse-build/1.4.8 (non-interactive; macos-aarch64; build d1d1e4cfebba63e3f842b6b469dfd6722a799bfd)
x-client-id: tbh:exec
```

`POST /v1/responses`:
```
accept: text/event-stream
accept-encoding: gzip,deflate,br
authorization: Bearer LLM|2…[len=56]
content-type: application/json
traceparent: 00-01a13fe9e4437be298889a2b6577345e-7358145d089e89ee-01   # W3C; trace-id = session uuid hex
user-agent: muse-build/1.4.8 (non-interactive; macos-aarch64; build d1d1e4…)
x-client-id: tbh:exec                       # "tbh:exec" for `muse exec`; the TUI likely sends another tbh:* value
x-meta-ai-gateway-session-id: 01a13fe9-dfde-7002-95fa-945be900c7ec   # UUIDv7, one per session/agent
x-tbh-agent-role: main                      # or reminder:skill-reminder
x-tbh-session-id: 01a13fe9-dfde-7002-95fa-945be900c7ec   # same value as the gateway session id
x-tbh-contributor-mode: 1                   # ONLY when contributor mode is on
```

Header names in the binary that this capture did not exercise: `x-fb-routing-control`, `x-api-version` (value `1.0.0`, near auth/OAuth code),
`x-tbh-invocation-kind`, `x-meta-ai-gateway-error-code` (a response header carrying the gateway error code), `MUSE_CUSTOM_HEADERS` (env, extra headers).

Direct probes with ONLY `authorization` + `content-type` (no user-agent, no x-client-id, no session headers) also return 200. The token alone is sufficient.

### 2.3 Request body (`/v1/responses`, main agent)

Top-level keys: `model, input, instructions, max_output_tokens, store, tools, reasoning, include, prompt_cache_key, stream`.

```json
{
  "model": "muse-wonder-full-1.0",
  "instructions": "You are Muse Code, an agentic coding CLI … powered by Muse Spark … [46 KB]",
  "input": [
    {"type": "message", "role": "developer", "content": "<system-reminder source=\"workspace-identity\">… [44 KB]"},
    {"type": "message", "role": "user", "content": "reply with the word PONG"}
  ],
  "max_output_tokens": 128000,
  "store": false,
  "tools": [ {"type": "namespace", "name": "muse", "description": "Muse Code tool set.", "tools": [
      {"type": "function", "name": "read_file", "description": "…", "parameters": {…}, "strict": false}, … 27 functions ] } ],
  "reasoning": {"effort": "high", "summary": "auto"},
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "tbh:main:01a13fe9-dfde-7002-95fa-945be900c7ec",
  "stream": true
}
```

- Tools use a NON-STANDARD `{"type":"namespace","name":"muse","tools":[…function…]}` wrapper, and the model calls them as `muse.read_file`.
  Plain OpenAI `{"type":"function","name":…,"parameters":…}` tools also work (probe: `get_weather` was called).
- `reasoning.effort` comes from `--reasoning-effort` (default `high`; settings.json `model_reasoning_efforts`). `--reasoning-effort low` sent `"low"`.
- No `temperature`/`top_p` is sent. The catalog's `options` lists `temperature: 0.9, top_p: 0.9` but `temperature: false`; the server echoes `temperature: 1.0`.

Tool round trip (second request of the cap2 run). The `input` grows by:
```json
{"type":"reasoning","id":"rs_6ad0e007…:rs_01a13feb…","encrypted_content":"Q-PaDg…[1553]"},
{"type":"function_call","id":"fc_01a13feb2107…","call_id":"call_01a13feb2107…","name":"muse.read_file","arguments":"{\"path\":\"note.txt\"}"},
{"type":"function_call_output","call_id":"call_01a13feb2107…","output":"Read text file `note.txt`.\n1|The secret word is MANGO-42."}
```
With `store:false`, the encrypted reasoning items are replayed statelessly. Reasoning item ids have the shape `rs_<respid>:rs_<uuid>`.

### 2.4 Response stream (`/v1/responses`, SSE)

Response headers: `content-type: text/event-stream`, `x-route: model-api-rust`, `x-request-id: <uuid>`, `access-control-allow-origin: *`.
`/muse-code/models` instead answers through the FB edge (`x-fb-debug`, `x-fb-request-id`, `x-fb-trace-id`, `x-fb-rev`, zstd encoding).

Every frame is `event: <type>` + `data: {json}` with a `sequence_number`, and the stream ends with `data: [DONE]`. Event types seen:
```
response.created, response.in_progress,
response.output_item.added / .done                (reasoning, message, function_call)
response.reasoning_summary_part.added / .done, response.reasoning_summary_text.delta / .done
response.content_part.added / .done, response.output_text.delta
response.function_call_arguments.delta / .done
response.completed                                 (usage: input_tokens, input_tokens_details.cached_tokens,
                                                    output_tokens, output_tokens_details.reasoning_tokens)
response.subscription_usage                        (Meta-specific, after completed)
```
Sample `response.subscription_usage`:
```json
{"type":"response.subscription_usage","subscription":{"tier":"<tier-id>",
 "weekly":{"resets_at":1792368000,"used_percent":0},
 "window":{"resets_at":1792088451,"used_percent":2,"window_duration_mins":300}}}
```
Message output items may carry `"phase":"commentary"` (preamble text before a tool call).

## 3. Token format, lifetime, refresh, login

- Format: `LLM|<17-digit numeric>|<27-char secret>` (segment lengths 3/17/27, 49 chars total). It is NOT a JWT, so there are no claims, no `exp` and no `iat` to decode.
  This is the same shape as a Meta Llama-API key, so the subscription login mints an API-key-shaped bearer.
  The 17-digit middle segment does not appear in the binary strings (not a compiled-in app id).
- Expiry: not observable from the wire. The keychain payload has an `expires_at` and a `refresh_token`
  (schema in section 1). Reading the actual values needs `security find-generic-password -s ai.meta.dev.credentials -a meta -w`,
  which raises a Keychain approval prompt for the user. NOT done.
- Device-code login (from strings; `muse login` was not run):
  - `POST https://auth.meta.com/oidc/device/authorization/` with form `client_id`. The response must carry `device_code`, `user_code`,
    `verification_uri` (`verification_uri_complete` optional, `expires_in`, `interval`). Error text: "device authorization response missing user_code or verification_uri".
  - `POST https://auth.meta.com/oidc/device/token/` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`.
  - Token response struct: `access_token, token_type, expires_in, refresh_token, scope`. "the token response was not a Bearer grant".
  - Default auth base string: `https://auth.meta.com` ("default base url parses").
  - client_id: NOT found as a literal string. Directly next to these paths the binary has a Dynamic Client Registration body
    (`client_name: "Muse Code"`, `redirect_uris`, `grant_types`, `response_types`, `token_endpoint_auth_method`,
    "the registration response carried an empty client_id"). The client_id is therefore either obtained by RFC 7591 registration or stored as a non-string constant.
    That registration code may belong to the MCP OAuth flow (it uses `127.0.0.1` callbacks), so this is unconfirmed.
- Refresh: the binary contains NO Meta-specific refresh path (the only `/oidc/` paths are the two device endpoints).
  `grant_type=refresh_token` appears only next to the MCP OAuth (authorization-server-metadata) code. Best inference: refresh is
  `POST https://auth.meta.com/oidc/device/token/` with `grant_type=refresh_token`, `refresh_token`, `client_id`. UNVERIFIED.
  On failure, user-facing messages say "provider auth expired" / "run `muse login`" (`workflow_provider_auth_expired`, `provider-auth-expired`).
- Bad token: `401 {"error":{"code":"invalid_api_key","message":"Unauthorized","param":null,"type":"authentication_error"}}`, no `www-authenticate`.

## 4. Model discovery

`GET https://api.meta.ai/muse-code/models` (subscription token, 200). Each entry is `{id, object:"model", created, owned_by:"meta", metadata:{"muse-code":{name, family,
release_date, is_hidden, attachment, reasoning, temperature, tool_call, modalities{input,output}, limit{context,output}, options{reasoningEffort, forceReasoning,
include, temperature, top_p}, description, variants{<effort>:{reasoningEffort}}, background_agent_model}}}`.

| id | hidden | context / output | efforts (variants) | input |
|---|---|---|---|---|
| muse-wonder-full-1.0-contributor | no | 1007997 / 128000 | minimal..max | text, image |
| muse-wonder-full-1.0 | no | 1007997 / 128000 | minimal, low, medium, high, xhigh, max | text, image |
| muse-wonder-1.0-contributor | no | 1007997 / 128000 | minimal..max | text, image |
| muse-wonder-1.0 | no | 1007997 / 128000 | minimal..max | text, image |
| muse-spark-1.3-contributor | no | 1007997 / 128000 | minimal..max | text, image |
| muse-spark-1.3 | no | 1007997 / 128000 | minimal..max | text, image |
| muse-image-1.0 | yes | — | — | text, image |
| muse-spark-1.2-contributor | no | 1007997 / 128000 | minimal..xhigh | text, image |
| muse-spark-1.2 | no | 1007997 / 128000 | minimal..xhigh | text, image |

All muse-wonder entries have `family: "avocado"` and `background_agent_model: "muse-spark-1.3"`. The default effort is `high`, with `forceReasoning: true`.
The contributor ids carry the description "Your content, including inter-session messages, may be used for product improvement."

`GET https://api.meta.ai/v1/models` (200, ids only, `created: 0`): the above plus `sam-3.1`, `muse-voice-transcribe-1.0`, `muse-spark-1.1`.

Effort values sent to `/v1/responses` (model muse-spark-1.3): `minimal`, `xhigh` and `max` → 200. `none` → 400
"reasoning_effort 'none' is not supported for model 'muse-spark-1.3'. Supported values: [minimal, low, medium, high, xhigh, max]".
`ultra` → 400 "unknown variant `ultra`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`". The CLI's `ultra` therefore never reaches the wire as `ultra`.
The authoritative per-model effort list is the catalog's `variants` keys.

`muse model-profile show <model> [--effort <tier>]` shows client-side tuning knobs only (`base_instructions_variant`, `measured_tuning_cell`,
`plugin_text_variant`, `default_reasoning_effort`). It does not list models. Cached catalog: `~/.local/share/muse/model-catalog/6d657461__p746268.json`.

## 5. Standard endpoints with the subscription token

All three work with `Authorization: Bearer LLM|…` and no other header:

| Endpoint | Result |
|---|---|
| `POST /v1/responses` (non-stream and stream) | 200. Usage, reasoning `encrypted_content`, function_call items |
| `POST /v1/chat/completions` (non-stream and stream, tools) | 200. OpenAI chunks, `tool_calls` deltas, `finish_reason: tool_calls`, usage with `reasoning_tokens` and `cached_tokens`. The stream ALSO emits `event: response.subscription_usage` before `[DONE]` |
| `POST /v1/messages` (`anthropic-version: 2023-06-01`, non-stream and stream, tools, `thinking`) | 200. Full Anthropic SSE: `message_start`, `content_block_start{redacted_thinking{data}}`, text, `tool_use` + `input_json_delta`, `message_delta{stop_reason:"tool_use", usage{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens_details.thinking_tokens}}`, `message_stop`. Enforces `thinking.budget_tokens < max_tokens` (400 otherwise). Emits no subscription_usage event |

Sample `/v1/messages` stream with tool use (muse-spark-1.3, thinking enabled):
```
{"type":"message_start","message":{"id":"msg_6ad0e14f…","model":"muse-spark-1.3","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}
{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"[…]"}}
{"type":"content_block_stop","index":0}
{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_01a13ff0…","name":"get_weather","input":{}}}
{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"Paris\"}"}}
{"type":"content_block_stop","index":1}
{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"cache_creation_input_tokens":0,"cache_read_input_tokens":113,"input_tokens":422,"output_tokens":880,"output_tokens_details":{"thinking_tokens":788}}}
{"type":"message_stop"}
```
Note: `message_start.usage` is zeroed, and the real usage arrives only in `message_delta`.

Billing caveat: all of these were accepted with the subscription credential. Whether `/v1/messages` and `/v1/chat/completions` count against the subscription quota
or against metered API billing was NOT verified. `used_percent` (integer %) is too coarse to see a tiny request. Only the Responses and chat streams report `subscription_usage`.
The binary also references `/v1/messages/count_tokens`, `/v1/responses/input_tokens`, `/v1/chat/completions/input_tokens`, `/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/rerank`.

## 6. Contributor mode

`muse exec --contributor-mode on` (per run; `settings.json` stayed `contributor_mode_enabled: false`). Exactly two wire changes:
1. Header `x-tbh-contributor-mode: 1` is added. When off, the header is absent (not `0`).
2. `model` becomes `muse-wonder-full-1.0-contributor` (catalog id + `-contributor`).

Nothing else changed: same headers, body keys, effort, `prompt_cache_key` scheme. The subscription_usage tier and percent were the same within the run.
Env equivalents: `MUSE_CONTRIBUTOR_MODE`, `MUSE_EXPERIMENTAL_CONTRIBUTOR_MODE`.

## Other relevant strings

- Env: `META_API_KEY` (wins over login), `MUSE_MODEL`, `MUSE_CUSTOM_HEADERS`, `MUSE_TRANSPORT_TRACE`, `MUSE_WEB_SEARCH_MODE`, `TBH_CREDENTIAL_BACKEND`.
- Other muse-code endpoints on api.meta.ai: `/muse-code/config`, `/muse-code/searchprovider`, `/muse-code/feedback`, `/muse-code/telemetry/traces`, `/muse-code/telemetry/logs`, `/muse-code/browser_open`.
- Account/billing pages: `https://accountscenter.meta.com/muse_code/?ep=no_payg`, `https://dev.meta.ai` (onboarding, payment method).

## 7. Mint / remint

New fact (from coordinator): the keychain item `ai.meta.dev.credentials`/`meta` is JSON
`{secret_schema_version:1, api_key:"LLM|…"(49), access_token:"dca:…"(282)}`, with NO `refresh_token`
and NO `expires_at`. So the DURABLE credential is the 282-char `dca:` access_token; the `LLM|…`
api_key sent to `/v1/responses` is a SHORT-LIVED key MINTED from that access_token and re-minted on 401.

### What the 401 experiment showed

Method: re-ran the logging proxy with `FAIL_FIRST=1`, which answers the FIRST `POST /v1/responses`
with a synthetic `401 {"error":{"type":"invalid_api_key","message":"Unauthorized"}}` and forwards
everything else (later `/v1/responses` included) to the real `api.meta.ai`. In parallel, a plain
CONNECT proxy (`connect-proxy.ts`, host logging only, NO TLS interception) was set as
`HTTPS_PROXY`, with `127.0.0.1` in `NO_PROXY` so the base-url proxy traffic stayed visible.
Run: `cap4/` (`capture.log`, `connect.log`).

Base-url proxy sequence (`cap4/capture.log`):
```
#1 GET  /muse-code/models          -> 200
#2 POST /v1/responses              -> SYNTHETIC 401   (auth: Bearer LLM|27…[len=56])
#3 POST /v1/responses              -> 200             (auth: Bearer LLM|27…[len=56])   retry, SUCCEEDED
```

CONNECT host log (`cap4/connect.log`), all entries `CONNECT … HTTP/1.1`:
```
02:36:14.187  api.meta.ai:443
02:36:14.933  api.meta.ai:443
02:36:19.158  api.meta.ai:443     <- between the 401 (02:36:19.154) and the retry #3 (02:36:20.210)
02:36:19.162  api.meta.ai:443
02:36:30.061  api.meta.ai:443
```

Keychain mdat moved `20261015131850Z` -> `20261016023620Z` (02:36:20Z), i.e. a credential WRITE
happened at the instant of the retry. `muse exec "say PONG"` with no proxy afterwards still works.

### Conclusions

1. On 401 muse RE-MINTS and retries transparently (the user never sees the 401). This matches the
   strings `remint_attempts`, `mint_failed`, `credential.refresh`, `mint returned an empty api key`,
   `startup mint skipped`.
2. The remint request goes DIRECT to `api.meta.ai:443` — it does NOT traverse the `--base-url`
   override (nothing but `/muse-code/models` and the two `/v1/responses` hit the base-url proxy),
   and it does NOT contact `auth.meta.com` or `graph.meta.ai` (only `api.meta.ai:443` appears in the
   CONNECT log). So the device-code server is NOT re-contacted on a 401; the `dca:` access_token is
   reused to mint a fresh api_key at `api.meta.ai`.
3. Because the mint bypasses the OpenAI-compatible base URL and runs over TLS, its exact
   method/path/headers/body CANNOT be captured without TLS interception, which the task forbids.
   The host is `api.meta.ai`. The path is built at runtime (no contiguous mint-path literal in the
   binary; the only base-URL literals are `https://api.meta.ai[/v1]` and `https://auth.meta.com`).
4. The minted api_key keeps the `LLM|<17-digit account id>|<27 chars>` shape; the 17-digit account
   id is stable, so a re-minted key shows the same `LLM|27…` prefix (not evidence it is unchanged —
   the keychain mdat proves a new value was stored).

### Mint vocabulary in the binary (format-string prefixes; URLs substituted at runtime)

`default mint base url: `, `invalid mint url: `, `key mint protocol error: `,
`key mint transport error: `, `unexpected mint response `, `mint returned an empty api key`,
`startup mint skipped`, `mint_failed`, `remint_attempts`, `credential.refresh`,
`no_stored_login`, `masked_by_environment` (META_API_KEY overrides the minted key),
`your saved login is no longer valid. Log in again or use a different account.`,
`your Meta account isn't set up for Model API yet`.
Credential-op endpoints under the base host: `muse-code/logout` (revoke; "remote token revocation
could not be confirmed"), and `muse-code/keydevice` appears as a login-METHOD name
("muse-code/keydevice login isn't available yet"), not a confirmed path.

### client_id / scope

NOT recoverable from strings. No literal `client_id` value and no OAuth `scope` string. Adjacent to
the device paths the binary carries an RFC 7591 Dynamic Client Registration body
(`client_name: "Muse Code"`, `redirect_uris`, `grant_types`, `response_types`,
`token_endpoint_auth_method`, error "the registration response carried an empty client_id"), but that
code sits with the `127.0.0.1` callback / authorization-server-metadata logic that also serves MCP
OAuth, so it is not confirmed to be the Meta device-code client. Getting the real client_id/scope
would require either running `muse login` (forbidden — replaces the user's login) or decrypting the
TLS to `auth.meta.com`.

### Implication for claudish

claudish cannot rely on muse's remint. To call Meta with the subscription it must EITHER read the
`LLM|…` api_key straight out of the keychain (`ai.meta.dev.credentials`/`meta`) and send it as
`Authorization: Bearer LLM|…` to `https://api.meta.ai/v1/responses` (and re-read it when muse
re-mints, since the value rotates on 401), OR reproduce the mint call from the `dca:` access_token,
whose exact shape is not yet known. The read-the-current-api_key path is the only one proven here.

## 8. Mint and device login — decrypted capture (user-approved interception, 2026-10-16)

Method: mitmdump (`research/mitm_log.py`, tokens redacted at write time) as HTTPS_PROXY with
SSL_CERT_FILE=mitmproxy CA (muse honours it; no pinning), plus the FAIL_FIRST base-url proxy.
Captures: `cap5-mitm.log` (remint), `cap6-login.log` (login, killed before approval; keychain
mdat unchanged 20261016033337Z).

### Mint (`dca:` access token → `LLM|` api key)
```
POST https://api.meta.ai/muse-code/key
authorization: Bearer dca:…[len=282]
x-api-version: 1.0.0
content-type: application/json
user-agent: muse-build/0.1.0
{"onboard":false}
→ 200 application/json
{"api_key":"LLM|…[len=49]","base_url":"https://api.meta.ai/v1","has_payment_method":true,
 "require_payment":false,"is_subs_active":true,"can_subscribe":false,"show_subs_upsell":true,
 "user_full_name":"…","user_email":"…","user_avatar_url":null,"payment_method":"…","action_url":null,
 "subs_tier_id":"<tier-id>","subs_tier_name":"Muse Code Power Usage","is_subs_upgrade_available":true,
 "subs_usage":{"window":{"used_percent":1,"window_duration_mins":300,"resets_at":1792136182},
               "weekly":{"used_percent":0,"resets_at":1792368000},"tier":"<tier-id>"}}
```
- Called on 401 of /v1/responses (remint), then the retry used the new key and muse wrote it to the Keychain.
- `is_subs_active` / `require_payment` / `action_url` drive muse's "Muse Code requires a payment method — subscribe at
  https://accountscenter.meta.com/muse_code/?ep=no_payg" message. `subs_tier_name` names the tier (membership varies by tier).

### Device-code login (RFC 8628)
```
POST https://auth.meta.com/oidc/device/authorization/   (form)  client_id=1031625952748946
→ 200 {"device_code":"…[43]","user_code":"XXXX-XXXX","verification_uri":"https://auth.meta.com/oauth/device/",
       "verification_uri_complete":"https://auth.meta.com/oauth/device/?code=XXXX-XXXX","expires_in":600,"interval":5}
POST https://auth.meta.com/oidc/device/token/   (form)
  grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=1031625952748946
→ 400 {"error":"authorization_pending",...} | 400 {"error":"slow_down",...}  (standard; back off +5 s on slow_down)
```
- No scope parameter. The success body was not captured (approval not given); strings name
  `access_token token_type expires_in refresh_token scope`, and the Keychain keeps only `access_token` (`dca:`, 282 chars).
  Treat `expires_in`/`refresh_token` as optional; with none, the `dca:` token is used until /muse-code/key answers 401,
  then the user must log in again.
- muse auto-updated to 1.4.9 (binary `muse-bin-1.4.9-R6297.1`) during the session.
