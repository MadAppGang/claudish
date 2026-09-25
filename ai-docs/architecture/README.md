# Architecture — engineering rationale

Why the code is shaped the way it is: what was measured, what it cost, and what breaks if you
change it. None of this is recoverable by reading the source, which is the test for whether
something belongs here.

Extracted from `CLAUDE.md` in v7.64.0. That file is prepended to every session, so it had grown
to 1,531 lines — 156 KB of prompt on every turn, most of it needed only when working in one
specific area. It now holds only the operational core — commands, release steps, and the
invariants that fail silently — plus a list naming which document covers what.

Tracked deliberately, like `ai-docs/reports/`. These started life in `CLAUDE.md` precisely
because `ai-docs/sessions/` is gitignored and does not survive `git worktree remove` — the way
three earlier write-ups this material cites were lost.

## Documents

| Document | What it covers | Read it before you… |
|---|---|---|
| [`routing.md`](routing.md) | The `provider@model` syntax, the full provider-prefix table, local models, which names reach `route()` (`proxyRouteDecision` and the parse gate), where a bare name's chain comes from now that there is NO built-in rules table, the fallback hop and its three empty states, wire ids from the catalog's connections, route bindings vs the lookup-only names, the DERIVED picker provider list, and why subscription pricing is decided by billing rather than by `modelDiscovery` | change `proxyRouteDecision`, the parser's fallback, `explainBareName` or `explainRoute`, `route-candidates.ts`, `catalog-route-bindings.ts`, a `nativeModelPatterns` claim, `defaultProvider`, the picker, or `SUBSCRIPTION_PROVIDERS` |
| [`providers/devin.md`](providers/devin.md) | The only binary wire in the pipeline — Connect envelopes carrying protobuf, live uid resolution, errors that ride an HTTP 200, and the three wire facts that cost real money to get wrong | touch `providers/devin/`, the codec, or `dv@` model resolution |
| [`providers/grok-subscription.md`](providers/grok-subscription.md) | `gk@` on a SuperGrok / X Premium+ plan: RFC 8628 device flow, exact-scope matching, 6-hour token refresh with write-back, three mandatory client headers | touch `gk@`, `claudish login grok`, or its OAuth refresh |
| [`providers/antigravity.md`](providers/antigravity.md) | Gemini on an Antigravity subscription: the shared `agy` keychain token, runtime client-secret extraction, live discovery of the account's dynamic models catalog | touch `ag@`, `auth/antigravity-*`, or the keychain token |
| [`providers/qwen-alibaba.md`](providers/qwen-alibaba.md) | One service, two consoles, three isolated key+host products and account-discovery caveats | touch `qcode@`/`qtoken@`/`qpay@`, or assume anything about Alibaba's credentials |
| [`custom-endpoints.md`](custom-endpoints.md) | User-defined `customEndpoints`: schema, `${VAR}` expansion, and `authScheme: "none"` for endpoints that take NO credential | change `customEndpoints`, `config-schema.ts`, or `authScheme` handling |
| [`predefined-endpoints.md`](predefined-endpoints.md) | The 25-vendor bundled catalog: credential-gated activation, the single registration seam, evidence tiers (all `probe`, none `live`), and the no-model-data rule | add a vendor to `providers/predefined-catalog.ts`, or change endpoint registration |
| [`onepassword.md`](onepassword.md) | SDK-only secret resolution, the FOUR causes of an identical denial error, the cross-process handshake lock, parent-side route pinning, and the config TUI tab | touch `providers/onepassword*.ts`, credential pre-hydration, or the 1Password TUI tab |
| [`keychain.md`](keychain.md) | The macOS Keychain backend: the 17ms-vs-28ms measurement that split presence from values, the two `security` behaviours that are traps (hex reads, a "secure" write that stores nothing and exits 0), and why no new `CredentialSource` member | touch `providers/keychain.ts`, `keychain-source.ts`, or the Providers tab's key write/delete |
| [`adapters.md`](adapters.md) | Layers 1–3 (FormatConverter / ModelTranslator / ProviderTransport), stream-parser selection, errors that ride an HTTP 200, and the `upstream_status` remap with its downstream readers | add a provider, model translator, or stream parser; or change error classification and retry |
| [`network-recovery.md`](network-recovery.md) | The two-tier connection hold: why the deadline is DERIVED from `API_TIMEOUT_MS` (measured 359.607 s, a default and not a watchdog), why the tier-2 status is 503 and never 429, why the banner is magmux's `overlay` and never a pane of ours (closing a pane wedged Claude Code), why its lease is renewed on its own tick and not by ladder events, and the five sites where a network failure wore an auth status code | touch the retry ladder, `recovery/`, the tier-2 status, the recovery banner, or any `x-claudish-recovery` reader |
| [`behavior-layer.md`](behavior-layer.md) | Layer 4, the harness-convention SUPERVISOR: the rule engine, the four hooks, the 115-call plan-mode measurement it was built on, and opt-in telemetry | write a `behavior/` rule, or change harness-conformance handling |
| [`advisor.md`](advisor.md) | `--advisor` for any main model: why it is independent of `--monitor` yet keeps four of its launch bits, the decorator around the ROUTED handler, id capture by tool name (the `toolu_` prefix that made it a no-op on every foreign provider), the tee and retained session-keyed state, the ten stub paths and advice origin, Claude Code's advisor gates, metered panel billing, and the inherited-placeholder 401 | touch `--advisor`, `advisor-decorator.ts`, `native-handler-advisor.ts`, `advisor-startup.ts`, monitor-gated launch code, or native auth in `claude-runner.ts` |
| [`headless-vs-interactive.md`](headless-vs-interactive.md) | Why `-p` is NOT interactive-without-a-TTY: `--agent` validation is SILENTLY skipped under `--input-format stream-json` (measured, exit 0, no stream frame, `result: success`), upstream closed it as not planned, and why magmux is in the dependency tree | drive Claude Code headlessly, add a child-spawn flag, or assume a headless run behaves like an interactive one |
| [`settings-env.md`](settings-env.md) | A settings `env` block overwrites the environment claudish gives Claude Code (measured on 2.1.281, and documented); why a proxy-auth launch carries `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and an empty trust flag, and why a launch on the user's own login cannot (the marker makes Claude Code ignore a stored claude.ai login) | change the environment the runner builds for Claude Code, or the auth mode a launch takes |
| [`picker.md`](picker.md) | The OpenTUI model picker: why it is an inline dialog and not a dashboard (the density gate that manufactured the rejected build), the provider list as the default screen with nothing prefetched (3915 → 1436 ms), the discovery outcome that stopped `[]` meaning five things, the local served-by index (22 network queries measured at 10 018 ms), the no-terminal gate's complement law, and the capture and compile traps | change `picker/`, `selectModel`, discovery outcomes or fetchers, `should-open-picker.ts`, or a TUI test that asserts on a frame |
| [`context-window.md`](context-window.md) | Why setting one env lever accomplishes nothing, why the status line reports the ENFORCED window, and local-model token accounting | change context-window resolution, the status line, or token accounting |
| [`theming.md`](theming.md) | One detected theme for every surface, and the module-load palette-snapshot bug class it keeps producing (found six times) | add a colored CLI line or TUI surface |
| [`mcp-channel.md`](mcp-channel.md) | The 12-tool MCP surface, the channel wire format, the client-side conditions gating channel rendering, and the `notifications/progress` keepalive | add or rename an MCP tool, or change channel notifications |
| [`team-capture.md`](team-capture.md) | Why exit 0 proves nothing under `claude -p`, and the stream-json recovery that stopped discarding real answers | change how `team` spawns children or classifies their output |
| [`team-lifecycle.md`](team-lifecycle.md) | Why nothing kills a slot on a timer, the measurement that removed the deadline, the non-blocking `run` contract, and the duplicate supervision still owed to `StreamJsonReducer` | add a deadline, change when `team` returns, or touch per-slot liveness |
| [`debugging.md`](debugging.md) | Debug logging, `CLAUDISH_UPSTREAM_ERROR_LOG`, raw SSE capture, and the failed-translation workflow | diagnose a model producing wrong, empty, or garbled output |
| [`testing.md`](testing.md) | The SSE-replay format-translation harness and how to add a regression test | add a format-translation regression test |

## Neighbours

- **`ai-docs/reports/`** — measurement evidence these documents cite (probe results, live runs, protocol specs).
- **`ai-docs/benches/`** — reusable evals.
- **`ai-docs/sessions/`** — GITIGNORED scratch space. Work there; put conclusions here or in `reports/`.
- **`docs/`** — the published, user-facing site. `docs/three-layer-architecture.md` is a fuller
  treatment of Layers 1–3 under different names (`APIFormat`/`ModelDialect`) and carries its own
  name-mapping section; [`adapters.md`](adapters.md) is the shorter operational view.
