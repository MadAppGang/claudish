> The `gk@` subscription sibling of metered `x-ai`: device-flow OAuth, 6h token refresh, mandatory client headers.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Grok Build Provider (`gk@`) — Grok on your SuperGrok / X Premium+ plan

The subscription sibling of the metered `x-ai`: same models, billed by the user's plan instead
of per token. Full verified protocol: `ai-docs/reports/grok-subscription/protocol-spec.md`.

| | `x-ai` (`grok@`, `xai@`) | `grok-subscription` (`gk@`) |
|---|---|---|
| Auth | `XAI_API_KEY` | `claudish login grok` (own OAuth), else the Grok CLI's token |
| Backend | `api.x.ai/v1/chat/completions` | `cli-chat-proxy.grok.com/v1/chat/completions` |
| Billing | pay-per-token | SuperGrok / X Premium+ subscription |

**claudish owns the login: `claudish login grok`, no Grok CLI required.** This is the deliberate
opposite of Antigravity, and the difference is structural. Google registered Antigravity as a
CONFIDENTIAL client, so its rotating `GOCSPX-` secret has to be extracted from the user's own `agy`
binary at runtime; xAI registered the Grok CLI as a **PUBLIC** client (`"none"` in
`token_endpoint_auth_methods_supported`), which is correct for a CLI because a distributed secret
is not a secret. Nothing rotates, so nothing needs chasing. The client id is published in xAI's own
installer, and a local `auth.json`'s id wins when present so a rotation needs no release.

Flow is **RFC 8628 device authorization**, not authorization-code + loopback: claudish frequently
runs where a localhost redirect cannot be received (MCP child, `team` fan-out, remote shell).
`slow_down` raises the poll interval PERMANENTLY per §3.5 — a one-shot bump is rejected on the very
next iteration.

**A clean login is NOT a working credential.** Requesting a sensible-looking subset of the issuer's
`scopes_supported` produced a token the IdP issued happily and the resource server refused:
`403 OAuth2 token missing required scope: api:access`. The authorization server and the resource
server disagree, and only the latter matters. Scopes are therefore matched EXACTLY to the CLI's own
`scope` claim (`…grok-cli:access api:access conversations:read/write workspaces:read/write`), with
`offline_access` load-bearing for the refresh token.

**Credential order is claudish's own store → the CLI's file**, so an existing `grok login`
(`~/.grok/auth.json`) is still reused for free. Own-store first because claudish owns that file
outright — refresh and write-back carry none of the lost-update risk of writing a file the Grok CLI
also owns. Verified live: minting a claudish token does NOT invalidate an existing CLI session.

**The `x-grok-client-version` value is discovered, not pinned.** The gate is a MINIMUM, so a
constant works only until xAI raises the floor — then every request 426s and it takes a release to
fix. Resolution is local install → `https://x.ai/cli/stable` (the same channel pointer xAI's
installer reads, shape-validated so an HTML error page can never be signed into a header) →
constant.

**The file is keyed by an OIDC SCOPE string, not a fixed name** (`https://auth.x.ai::<client_id>`,
with a `https://accounts.x.ai/sign-in` legacy form still parsed by xAI's own installer). The scope
EMBEDS the client id and can rotate, so the entry is selected by `auth_mode === "oidc"` → legacy
scope → lone entry, never by matching a hardcoded literal.

**The token lives 6 hours, so refresh is mandatory** — measured, create→expire exactly 6h. This is
the one structural difference from Devin, whose token is static and whose credential module is
therefore fully synchronous. Refresh is a standard OIDC **public-client** exchange against
`https://auth.x.ai/oauth2/token`: `auth.x.ai`'s discovery document lists `"none"` among its
supported token-endpoint auth methods and the `client_id` is a field in the credential file, so
**no secret is needed** — strictly simpler than Antigravity, which extracts a client_id/secret pair
out of the user's local `agy` binary at runtime.

**Write-back is not optional.** An OIDC server may rotate the refresh token on use, so refreshing
without persisting would leave the user's own `grok` CLI holding a dead token — claudish would have
broken a tool it does not own. The whole file is read-modify-written atomically (temp + rename,
mode 0600) so unrelated scopes and fields survive. Refresh is also **single-flight**: two concurrent
refreshes would have the second present a token the first just invalidated.

**Three client-identity headers are ALL mandatory.** The proxy enforces a minimum CLI version and
answers anything without them `{"error":"Your Grok CLI version (none) is outdated..."}` — on both
surfaces, so it is not a per-endpoint quirk:

```
Authorization: Bearer <key>
x-grok-client-version: <the installed version>
x-grok-client-identifier: grok-shell
```

Header names were recovered from the shipped binary (`strings`, adjacent to `1.0.4`, `grok-shell`,
`cli-chat-proxy`) — the same technique used for Antigravity. **The version is READ from the local
install** (`~/.grok/version.json` → `models_cache.json`'s `grok_version` → a floor constant), never
pinned: the gate is a *minimum* and the user's CLI self-updates, so a literal would guarantee a
future silent breakage of exactly the kind the gate exists to cause.

**Chat Completions is used even though the models declare `api_backend: "responses"`.** Both
surfaces work live. Chat Completions wins because claudish already has a Layer-2 `GrokModelDialect`
(model dialect + reasoning-effort mapping) that applies on that path only; choosing `responses`
would route through the Codex adapter and strand it, for no measured benefit. `--probe grok-4.6`
shows the composition: `openai-sse · GrokModelDialect · 500K`.

**`apiKeyEnvVar` MUST stay `""`.** Unlike Devin — where the reason is that a `Basic <k>-<k>` artifact
cannot survive proxy-server's `Bearer `-stripping extraction — here the extraction would *succeed*
and then CACHE a bearer token past the six hours it actually lives. Empty makes proxy-server skip
the block, so every request goes through the credential authority, the only place expiry is checked.

**`XAI_API_KEY` is deliberately NOT aliased.** That key is the metered `x-ai` credential; honouring
it here would let a pay-per-token key authenticate a provider claudish reports as flat-rate `SUB` —
the exact ambiguity that keeps `openai-codex` out of `SUBSCRIPTION_PROVIDERS`. Because this provider
has no metered path, it is *not* dual-mode and **is** in that set. `GROK_DEPLOYMENT_KEY` (enterprise)
is out of scope for v1 for the same reason: it would reintroduce the ambiguity.

**Bare `grok-*` routes subscription-FIRST** — `["grok-subscription", "x-ai", "openrouter"]`, matching
every other split family. Unlike Devin and Qwen Plan, which are explicit-access-only because their
uids collide with other vendors' namespaces, these ids are xAI's own, so a bare name is safe here.
The provider declares **no `nativeModelPatterns`** (`x-ai` already owns `/^grok-/i`, and patterns are
first-wins on array order); bare-name reachability comes from the routing chain instead.

**The roster is discovered, never pinned.** `/v1/models` is genuinely authenticated (401 without a
token — unlike Alibaba's `coding-intl` roster, where a 200 proves nothing) and the served set is
account-scoped. Note the per-model effort ladders differ — `grok-4.6` offers `xhigh`, `grok-4.5`
does not — which is exactly the drifting per-account data that must not be hardcoded.

Models Index represents this as the `xai-supergrok` commercial plan, routed through provider UID
`grok-subscription` with `modelDiscovery: "client"`. Its public `includedModels` value is therefore
only an account-roster limitation note, not a static allow-list. Claudish keeps the subscription
candidate when a Grok model is absent from the public slim catalog and lets the authenticated
provider discovery decide the actual roster.
