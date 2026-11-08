# OpenCode key expiry, Zen Go host split, and the provider link audit — 2026-10-20

Findings from one debugging session that started with `zengo@` answering 401. Each claim
names how it was measured.

## OpenCode expired personal API keys

Around 2026-10-17/18 OpenCode expired every personal API key. A Zen Go request with such a
key answers:

```
HTTP 401
{"error":{"type":"authentication_error","code":"api_key_expired","message":"This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key."}}
```

Measured with `GET https://opencode.ai/zen/go/v1/models` and the same call on
`/inference/go/v1/models`, for two different keys (claudish's and the opencode CLI's own in
`~/.local/share/opencode/auth.json`): both expired. Signing in again does not help, as the
message says.

The console no longer shows an API Keys page. The old keys appear under
**Settings → Service accounts** as `Legacy: <email>` with N keys and 0 active. A new key is
created there, on a new or existing service account. New keys use an `oc_sk_` prefix.
OpenCode's docs (`/docs/go/`) still say "copy your API key" from the console; the UI moved
ahead of the docs. No official statement explains the expiry; GitHub issues
anomalyco/opencode#56556 and #56560 report it, and a third-party blog links it to a console
breach (unconfirmed).

OpenCode documents no third-party OAuth flow. `opencode auth login opencode` signs in the
opencode CLI only. Service-account keys are the path for claudish.

**Open:** whether a service-account key draws on the Go subscription or on workspace credits
is not measured. claudish labels `zengo@` subscription by name, so if it bills credits the
spend is under-reported. Check the console's Go "Rolling usage" against the credit balance
after real use.

## Zen Go hosts split by API family (2026-10-12)

The route registry's `opencode` / `go-subscription` profile publishes:

| API | base URL |
|---|---|
| chat-completions, responses | `https://opencode.ai/inference/go/openai/v1` |
| anthropic-messages | `https://opencode.ai/inference/go/anthropic/v1` |
| gemini | `https://opencode.ai/inference/go/google/v1beta` |

The model list is NOT under any of those. Measured with a valid key:

```
404            https://opencode.ai/inference/go/openai/v1/models
200 37 models  https://opencode.ai/inference/go/v1/models     (documented)
200 37 models  https://opencode.ai/zen/go/v1/models           (definition URL, still live)
```

`registryModelsEndpoint` derives `<chat base>/models`, which holds for Zen
(`inference/v1`) but not for Go. claudish now retries the definition URL once on a 404
(`model-discovery.ts`, `discoverEveryServedModel`). That fallback breaks if OpenCode
retires `/zen/go`. The durable fix is a model-list URL published on the route profile by
the models-index backend.

Every chat request also needs `x-opencode-session`; without it both hosts answer
`400 MissingSessionID`. claudish already sends it (`transport/opencode-zen.ts`).

## Provider link audit

An HTTP check of every `BUILTIN_PROVIDERS` `apiKeyUrl` and `baseUrl` with a browser
User-Agent:

- Broken key links, now fixed: `lmstudio` (404), `ollamacloud` `ollama.com/account` (404).
  Home pages instead of key pages, now fixed: OpenCode, `glm`/`z-ai`. `kimi-coding` held
  prose inside the URL field.
- 403 from `platform.openai.com`, `console.x.ai`, `x.ai/cli` and `poe.com` is a Cloudflare
  "Attention Required" challenge to scripts. Those links work in a browser.
- `console.mistral.ai` answers `103 Early Hints` then `302` to sign-in. Bun's `fetch` stalls
  on the 103 and times out; curl shows the real answer.
- API base URLs are not web pages: 17 of 28 answer a browser with 404 or 421. The provider
  detail panel now prints them as `API: host/path`, without a scheme, so terminals do not
  make them clickable.

To repeat the audit, fetch each URL with `redirect: "follow"` and a browser User-Agent,
treat 404 and DNS failure as broken, treat 401/403/sign-in redirects as fine, and confirm
any 403 by reading the page title for a Cloudflare challenge.
