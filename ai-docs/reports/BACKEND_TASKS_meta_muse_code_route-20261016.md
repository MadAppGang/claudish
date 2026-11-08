# Tasks for models-index: a route for the Muse Code subscription (claudish, 2026-10-16)

Read against generation `g-20261015133900604-fb6199b5` (registry 3.7.0), after models-index
PR #356 ("Meta Model API and Muse Code from Meta's own docs", 2.0.21).

## Why

claudish is adding the claudish provider `meta-muse-code` (provider shortcut `muse@`), which signs
requests with the Muse Code subscription credential, and a metered claudish provider `meta` for
`META_API_KEY` on route `meta`/`direct-api`. Jack's decision: the subscription's models come from
**catalog membership**, the same as `qwen-token-plan`. claudish never hardcodes the list.

Today the catalog cannot give that membership a route:

| Fact (live) | Value |
|---|---|
| plan `meta-muse-code` `routeStatus` | `unsupported`, `routeReason: no_reviewed_consumer_route`, no `route` |
| registry route `meta` profiles | `direct-api` only |
| connections on a Muse Code subscription route | none |
| plan inclusion `Muse Wonder Full` | its `externalModelId` is a display string; no model record `muse-wonder-full` exists |

`resolveSubscriptionRouting` only gates on a `supported` plan with a bound route, and
`gatherFromConnections` only gathers `mapped` connections. So with this generation `muse@` gets no
candidates for a bare name, and membership gates nothing.

**Reviewed consumer route.** The reason `unsupported` holds, that the subscription is "for use
with Muse Code only", is now a decision Jack has taken for claudish, as with Devin, Antigravity and
the Grok subscription. claudish reads the credential that `muse login` stores; it does not ask the
backend to hold one.

## Where the data comes from

Do not use the docs pages for this route. The subscription has its own model endpoint, measured on
2026-10-16 with a Power Usage account:

```
GET https://api.meta.ai/muse-code/models
Authorization: Bearer <Muse Code login token>      # opaque "LLM|<digits>|<chars>", 49 chars
```

Each entry looks like this:

```jsonc
{ "id": "muse-wonder-full-1.0", "object": "model", "owned_by": "meta",
  "metadata": { "muse-code": {
    "name": "...", "family": "avocado", "release_date": "...", "is_hidden": false,
    "attachment": true, "reasoning": true, "tool_call": true,
    "modalities": { "input": ["text", "image"], "output": ["text"] },
    "limit": { "context": 1007997, "output": 128000 },
    "options": { "reasoningEffort": "high", "forceReasoning": true },
    "variants": { "minimal": {...}, "low": {...}, "medium": {...}, "high": {...}, "xhigh": {...}, "max": {...} },
    "background_agent_model": "muse-spark-1.3" } } }
```

The measured list, which is the membership as one Power Usage account sees it:

| wire id | hidden | context / output | efforts (`variants` keys) | input |
|---|---|---|---|---|
| `muse-wonder-full-1.0` | no | 1007997 / 128000 | minimal, low, medium, high, xhigh, max | text, image |
| `muse-wonder-full-1.0-contributor` | no | 1007997 / 128000 | minimal..max | text, image |
| `muse-wonder-1.0` | no | 1007997 / 128000 | minimal..max | text, image |
| `muse-wonder-1.0-contributor` | no | 1007997 / 128000 | minimal..max | text, image |
| `muse-spark-1.3` | no | 1007997 / 128000 | minimal..max | text, image |
| `muse-spark-1.3-contributor` | no | 1007997 / 128000 | minimal..max | text, image |
| `muse-spark-1.2` | no | 1007997 / 128000 | minimal..xhigh | text, image |
| `muse-spark-1.2-contributor` | no | 1007997 / 128000 | minimal..xhigh | text, image |
| `muse-image-1.0` | **yes** | — | — | text, image (not a chat model for this route) |

The cached copy muse keeps is `~/.local/share/muse/model-catalog/6d657461__p746268.json`. The
capture is in claudish `ai-docs/sessions/dev-feature-muse-code-*/research/muse-wire.md`, §4–§6.

## Tasks

**M1. Publish a subscription route profile.** For example `meta`/`muse-code-subscription` (the
name is yours, and claudish copies it verbatim into `CATALOG_ROUTE_BINDINGS`):
- `kind: subscription`, base URL `https://api.meta.ai/v1`.
- `apis`: `responses` only. It is what muse itself sends (`POST /v1/responses`), and it is the
  only stream that reports the subscription quota (a Meta-only `response.subscription_usage`
  event). `/v1/chat/completions` and `/v1/messages` also answer 200 to this token, but whether they
  count against the subscription or are billed per token is unverified, so do not publish them
  for this profile.
- Its own credential profile, distinct from `meta-api-key`. These are two silos, and
  `META_API_KEY` must never satisfy this route.

**M2. Flip plan `meta-muse-code` to `supported`** with that `route`, keeping
`modelDiscovery: "catalog"`.

**M3. Map one connection per member** on the new profile (`routeStatus: "mapped"`), with the
`externalModelId` exactly as `/muse-code/models` spells it:
- `muse-wonder-1.0` → `muse-wonder`
- `muse-spark-1.3` → `muse-spark-1.3`, and `muse-spark-1.2` → `muse-spark-1.2`
- `muse-wonder-full-1.0` → `muse-wonder-full` (see M4)
- Contributor ids (`*-contributor`) are second connections of the same model, as you already do
  on `direct-api`. Contributor mode means "content may be used for product improvement".
  claudish will not pick it unless the user asks, so please mark it in a way a reader can tell
  apart (for example a route variant or a flag), not only by the suffix.
- Leave out `is_hidden` entries (`muse-image-1.0`).

**M4. Create the model record `muse-wonder-full`.** Its wire id is `muse-wonder-full-1.0`, not
the display string `Muse Wonder Full`. It has no Model API id, so its only connection is the M3
subscription one. Meta lists it only on the Power Usage and Maximum Usage tiers, and the Power
account above does serve it.

**M5. Limits and effort per connection, from `/muse-code/models`, not from the docs:**
- context 1,007,997 and output 128,000 on this route. The `direct-api` records publish 1,048,576
  context. Both numbers can be true, but they belong to different routes, so put the subscription
  one on the connection or a route variant, not on the model.
- effort values = the `variants` keys. On the wire, `none` returns 400 (`reasoning_effort 'none'
  is not supported for model 'muse-spark-1.3'. Supported values: [minimal, low, medium, high,
  xhigh, max]`), and so does `ultra` (`unknown variant`). The default is `high`, with
  `forceReasoning: true`.
- `wire.api: responses`, with `max_output_tokens`, as on `direct-api`.

**M6. Membership varies by tier.** Wonder Full is Power and Maximum only. If one plan id keeps all
four tiers, publish the per-tier membership (or split the plans) so a lower tier does not get
`muse-wonder-full` as a candidate that answers 4xx.

## What claudish does meanwhile

- An explicit `muse@<wire id>` (for example `muse@muse-wonder-full-1.0`) works with no route:
  claudish passes the wire id through unchanged.
- claudish adds the binding row for the M1 profile name once you publish it. Until then a bare
  `muse-*` name routes to the metered `meta` provider (if `META_API_KEY` is set) and then to a
  gateway.

Please name the generation that carries M1–M5. claudish verifies it the same way as the
2026-09-21 delivery: live through its own reader, with no gating until that generation.
