# First-party sessions

Claude Code treats its base URL as Anthropic's own API only when the host is
`api.anthropic.com`, or when `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` is in its
environment. A `--monitor` session sends every request to that host unchanged, so a launcher
can set the variable in the environment it starts claudish with, which the child environment
carries, and get Claude Code's first-party behaviour through the proxy. The proxy then has to
behave like the host it stands in for.

The trust is the launcher's to grant, because only the launcher knows which session it is
starting, and a session routed to another provider must not claim it. The proxy's side is
decided by `isPassthroughSession(config)` in `claude-runner.ts`, true for `--monitor` without
`--advisor`, which `index.ts` passes to the proxy as `passthrough`. The advisor is excluded
because its decorator rewrites requests on the way through, so an advisor session is not one
to trust this way either.

## What the trust changes

Measured on Claude Code 2.1.280 by capturing the same request with and without the variable:

- A plain model id gets its native window: `claude-opus-5-5` reports a `contextWindow` of
  200000 untrusted and 1000000 trusted. Only a `[1m]` id reaches 1M without the trust.
- Requests carry `x-claude-code-request-class` and `x-client-request-id`, and
  `anthropic-usage-limit` where Claude Code's own gate for it holds.
- The beta list gains `advanced-tool-use-2025-11-20`, `cache-diagnosis-2026-04-07`,
  `server-side-fallback-2026-07-01` and `thinking-binding-controls-2026-08-01`, on 2.1.281 as
  on 2.1.280, in `-p` and background sessions alike.
- The billing block in the system prompt gains fields Claude Code completes after it has
  serialised the body.
- The static part of the system prompt is marked with the `global` cache scope, which
  Anthropic accepts only when Claude Code's stock identity line is the system block before it.
  A client whose identity line is replaced, or removed, is refused on every request with a 400
  (`cache_control.scope: "global"` is only valid when every preceding block is also globally
  scoped). Builds carrying one override each located the check: a replaced tool description,
  a different tool set, and edited text inside the globally cached block are all accepted.

## What the proxy owes a first-party session

- Every request header except the hop-by-hop ones
  ([RFC 9110 §7.6.1](https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1)), auth and betas
  included (`requestHeadersToForward`).
- The query string: Claude Code posts to `/v1/messages?beta=true`.
- The body as the bytes that arrived whenever claudish did not change it (`bodyToForward`).
  Claude Code marks its own prefix for caching: over two turns through the proxy, each sent 10
  uncached input tokens against a 23,556-token prefix read from cache.
- The upstream status and headers on the way back (`responseHeadersToReturn`), among them the
  `anthropic-ratelimit-unified-*` headers Claude Code reads for its usage state.
- `count_tokens` with Claude Code's own auth.
- Any other path, forwarded to Anthropic as sent: the catch-all route registered last in
  `proxy-server.ts`. One arrives at every start: Claude Code sends `HEAD /api/hello` to its base
  URL whether it trusts it or not.

`first-party-passthrough.integration.test.ts` drives the real proxy against a stubbed Anthropic
and asserts each of these on the wire.
