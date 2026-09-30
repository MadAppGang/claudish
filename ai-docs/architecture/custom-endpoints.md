> User-defined `customEndpoints` in config: schema, `${VAR}` expansion, and `authScheme: "none"`.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Custom Endpoints (v7.0.0+)

Define named custom endpoints in `~/.claudish/config.json` under the `customEndpoints` key. Each endpoint registers as a provider prefix usable with `@` syntax.

## Config schema

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
      "authScheme": "x-api-key",
      "headers": { "X-Team": "platform" },
      "streamFormat": "openai-sse",
      "modelPrefix": "",
      "models": ["gpt-4o", "claude-sonnet"]
    }
  }
}
```

Use as: `claudish --model my-vllm@llama3.1-70b "task"` or `claudish --model corp-proxy@gpt-4o "task"`.

## Key details

- **`${VAR_NAME}` expansion**: The `apiKey` field expands environment variables at startup. Use this instead of hardcoding secrets in config.
- **Zod validation**: Claudish validates all custom endpoints at proxy startup. Invalid entries emit a stderr warning and are skipped — they don't crash the proxy.
- **Runtime registration**: Endpoints call `registerRuntimeProvider()` and `registerRuntimeProfile()` to inject themselves into the provider resolver and transport layers.
- **`models` field** (optional): the ids claudish ADVERTISES for this endpoint — the only consumer is the proxy's own `/v1/models` route (`proxy-server.ts:1028`), which is what the nested Claude Code's `/model` command reads. It is not an allowlist: nothing filters a request against it, so `--model my-vllm@anything` reaches the endpoint whether the name is listed or not. It is also NOT the picker's list, which comes from the endpoint itself — see below. (This entry read "limits the endpoint to listed models" until the discovery change; no code ever did that.)
- **`modelPrefix` field** (optional): Prepended to the user-specified model name before sending to the API.
- **`authScheme` is a lowercase enum** — `"bearer"`, `"x-api-key"`, or `"none"` (`config-schema.ts`). A capitalized `"X-Api-Key"` fails Zod validation and the WHOLE entry is skipped with a stderr warning, which reads as "my endpoint disappeared" rather than as a typo. This doc carried the wrong spelling until v7.48.0; the example above is the validated one.

## The picker asks an `openai` endpoint what it serves

A custom endpoint carried no `modelDiscovery` descriptor, so
`PickerDataSource.providerList()` read `hasDiscovery: false` and **nothing ever asked the host
what it serves**. The consequence was the founding defect of [`picker.md`](picker.md), in the one
place the endpoint could have answered for itself: the provider row printed `0 models`, and `⏎`
opened an empty list with no explanation. The row's other phrasing — `lists its own models`,
written in `rows.tsx:315` for "a self-hosted vLLM" — was unreachable, because that branch needs
`hasDiscovery`.

`buildProviderDefinition` now derives one:

| declared | discovery path |
|---|---|
| `simple`, `format: "openai"` (`apiPath` is always `/chat/completions`) | `/models` |
| `complex`, `transport: "openai"`, default `apiPath` | `/v1/models` |
| `complex`, `transport: "openai"`, `apiPath: "/api/v2/chat/completions"` | `/api/v2/models` |
| `format`/`transport` anything else | none — unchanged |

**DERIVED FROM THE DECLARED FORMAT, never configured.** `format: "openai"` is already the user's
statement that the host speaks the OpenAI API, and `GET /models` is part of that API, published
as a sibling of `/chat/completions`. So the path is one RULE applied to the path the entry
already carries — not a pinned URL, which is what the "never hardcode a provider's models"
invariant forbids. All 27 rows of the bundled catalog travel this same function
(`predefined-catalog.ts` declares only `/v1/chat/completions` or `/chat/completions`, the version
segment being in `baseUrl`) and each lands on the path its vendor serves.

An endpoint that does not serve the path is now a `failed` outcome naming the URL and the status,
which is strictly more than the silent empty list it replaces. Discovery is still on demand: it
runs when the user scopes to that provider, never at startup.

Only `openai`. The `anthropic` transport's own `/v1/models` wants an `anthropic-version` header
and answers `created_at` where `openai-models-list` reads `created`; `litellm` and `gemini` are
different shapes again. Each is its own change, with its own live verification.

One gate had to move with it. `authScheme: "none"` reaches
`discoverProviderModelsCatalog` with static headers and no auth header at all
(`api-key-credential.ts:362`), which the blank-credential check read as an unset key — so a
keyless endpoint, the #139 shape below, was told `no-credentials` and its user sent to find a
variable they correctly do not have. The scheme is exempt from that check: it DECLARES that no
credential was ever expected.

## `authScheme: "none"` — endpoints that take NO credential (v7.64.0, #139)

A local router or an inference server on a trusted network wants no auth header at all, and
there was **no way to say so**. `apiKey` was `z.string().min(1)`, so `""` failed validation
(`Too small: expected string to have >=1 characters` — which reads as a claudish bug), and any
placeholder was sent as a real `Authorization: Bearer none`. The reporter's router rejected the
stray header, so the workaround did not work either.

```json
{ "customEndpoints": {
    "localrouter": {
      "kind": "simple", "format": "openai",
      "url": "http://127.0.0.1:8402/v1",
      "authScheme": "none" } } }
```

`apiKey` is now optional and **must be omitted** under `"none"`; both mistakes produce an error
that names the fix rather than describing a string length. Accepted on `simple` too — which
previously had no `authScheme` field at all — so a keyless endpoint does not have to be
rewritten as `complex` just to say "no auth".

**It is EXPLICIT, never inferred from an absent `apiKey`.** A misspelled key field (`apikey`,
`api_key`) would otherwise silently downgrade an endpoint to unauthenticated and send the
user's prompts out with no credential — a failure that looks like success.

**Four gates had to agree, and each is an independent revert risk:**

| gate | what rejected a keyless endpoint |
|---|---|
| `config-schema.ts` | `apiKey: z.string().min(1)` |
| `buildProviderDefinition` | the `simple` branch hardcoded `authScheme: "bearer"` |
| `api-key-credential.ts` | `isAvailable()` had no "needs no credential" answer |
| `proxy-server.ts` | the anti-poison `if (!apiKey) return null` |

The last one is the instructive one: a custom endpoint ALWAYS carries a synthesized
`CUSTOM_<NAME>_KEY`, so the variable's existence cannot be the test for whether it
authenticates. The block is skipped on `authScheme === "none"` instead.

**`"none"` is a SCHEME, not an empty key**, and that distinction is load-bearing. An empty key
means "a credential was expected and is missing" — the routing pre-flight is right to reject
that, since the request would 401. `"none"` means "no credential was ever expected". Encoding
it as an empty key also breaks on the wire: `AnthropicProviderTransport`'s `else` branch emits
`x-api-key` **unconditionally**, so an empty key there puts a literal `x-api-key: ` on the
request, and a gateway that ignores unknown auth may still reject a malformed one.

**Three inline `=== "x-api-key" ? "x-api-key" : "bearer"` ternaries had to go.** Each silently
collapsed every other value into bearer. Two were in `authority.ts` and one in
`registerEndpoint`; that third one is why the feature validated, registered, and then still
demanded a key. `normalizeAuthScheme()` is now the single mapping, so adding a scheme is one
edit rather than a hunt for ternaries.

Verified live against a header-inspecting mock — `authorization: null`, `x-api-key` **absent
from the request entirely** (not empty), and a declared `headers: {"X-Team":"platform"}` still
delivered, since for some gateways a custom header IS the credential.
