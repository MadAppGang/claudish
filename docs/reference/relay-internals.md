# Relay / sidecar mode — internals

**Deferred from `CLAUDE.md` (v7.2+ section).** The mode table, env vars and hard gotchas stay in `CLAUDE.md`; this file holds the mechanism. Operational runbook: `docs/deployment/relay-sidecar-deployment.md`.

## Motivation (historical)

Historically every cluster machine pointed Claude Code's `ANTHROPIC_BASE_URL` directly at po-2023's proxy container. That made po-2023 a **single point of failure** — when it crashed (2026-07-02), the whole cluster stalled. The relay design removes that: each capable machine runs its own claudish container (a **sidecar**) that relays to the central hub in nominal mode but takes over locally when the hub dies.

## Components (`packages/cli/src/fork/server/relay.ts`)

- `forwardToUpstream(c, body, state)` — builds outbound headers (copies inbound minus hop-by-hop, **preserves `X-Claudish-Machine`** so central attribution survives the relay, then **injects the cluster key as `x-proxy-key`** — NOT `x-api-key` — and **keeps the client `authorization`**). The `x-proxy-key` form passes the hub's auth gate without triggering `NativeHandler`'s proxyKey→Anthropic swap, so a relayed native (Opus) request from ai-01 passes through to Anthropic on ai-01's own OAuth (the hub stores no Anthropic key). `x-api-key` would arm the swap → strip auth → 401. Optionally gzips the request body, `fetch`es `${upstream}/v1/messages`. Pre-stream failure → returns `null` (caller falls through to local for that request). Success streaming → repiped via `createAnthropicPassthroughStream(…, { capture: false })` (ping keepalive + `finalizeWithError`, so a mid-stream hub death still emits a terminal `message_stop`).
- `startUpstreamProber(state)` — heartbeat `GET /health` every 10s. **Hysteresis:** 2 consecutive failures → AUTONOMOUS (fast failover); recovery needs 3 OK heartbeats **+ 60s cooldown + a deep tool-call probe** (`glm-5.2`, must complete with `message_stop`) before returning to NOMINAL (anti-flap).
- `readRequestBody(c)` — inflates a gzipped request body on the hub (detects gzip magic bytes, so it's correct whether or not the runtime auto-inflates). Zero cost on the uncompressed LAN path.

## Wiring

The relay branch sits in the `/v1/messages` route **before** `interceptWebTools` / `getHandlerForRequest` / `logRequest` — so nominal forwards bypass local capture automatically (mode-aware capture for free). `standalone-proxy.ts` reads the env, builds `RelayState`, passes it in `ProxyServerOptions.relay`, and starts the prober.

## Leak-policy backstop (defense in depth)

`CLAUDISH_NO_ANTHROPIC=1` (set on every machine ≠ ai-01) makes `getHandlerForRequest` reroute any bare native (`isNative`) target to the budget `modelMap.sonnet` instead of real `api.anthropic.com`. Depth-guarded recursion + a fail-closed refusal handler prevent both infinite loops and leaks on a misconfigured mapping. See memory `leak-policy-binary-by-machine`.

## Compression (Phase B, WAN only)

LAN sidecars do **not** compress (the hub decompresses to proxy anyway; the LAN isn't the bottleneck). WAN externals (po-2025, web1 → models.myia.io) set `CLAUDISH_RELAY_COMPRESS=1` → native `Content-Encoding: gzip` on the **request body only** (never the SSE response — gzip buffering would risk a hang). The uplink (system + history + tools) is the constrained asymmetric direction.

## Outage capture reconciliation (Phase C)

On a sidecar, loose captures exist *only* because an outage forced AUTONOMOUS mode — so any loose `req-*/resp-*` files ARE outage captures. `scripts/reconcile-outage-captures.ps1` packs them into `reconcile/outage-<machine>-<start>_<end>.7z` (machine-namespaced, no collision with daily `captures-YYYY-MM-DD.7z`), uploads to GDrive `reconcile/`, and deletes loose only after a verified archive + confirmed off-site copy. The hub merges them nightly; attribution is correct because each `req-*.json` body carries `machine` (commit 141d160). `CaptureUtils.psm1` → `Get-OutageArchives`.

## Tests

`relay.test.ts` (16 — hysteresis, header build incl. ai-01 Opus passthrough, gzip, never-hang delegation). Budget-free resilience E2E: `bun run packages/cli/src/fork/server/relay-e2e.ts` (real prober + mock hub: NOMINAL → FAILOVER → RECOVERY over real HTTP, ~2-3 min).

## Fleet deployment

`scripts/install-sidecar.ps1` idempotently stands up a sidecar on a target machine (clone/pull, per-machine `.env`, `docker compose up --build`, end-to-end probe). Runbook + per-machine config table: `docs/deployment/relay-sidecar-deployment.md`. Sidecars go on every machine except po-2023 (hub) and web1 (stays on `models.myia.io`). The client prerequisite — the `x-proxy-key` custom header — is documented in memory `proxy-key-custom-header-auth`.

## Compose environment surface

`docker-compose.yml` carries a default for every relay variable, so the hub runs with **no `.env` at
all**: `CLAUDISH_RELAY_UPSTREAM`, `CLAUDISH_RELAY_COMPRESS`, `CLAUDISH_NO_ANTHROPIC`,
`CLAUDISH_HOST_PORT`, `CLAUDISH_CONTAINER_NAME`, `CLAUDISH_CAPTURE_HOST_DIR`,
`CLAUDISH_CAPTURE_DIR`, plus the `CLAUDISH_FAILOVER_*` family.

`CLAUDISH_CONTAINER_NAME` is what lets one host run hub and sidecar side by side (`claudish-proxy`
vs `claudish-sidecar`); `scripts/install-sidecar.ps1` sets it per machine. Pass-through is
**per-variable** in compose — a variable absent from the list silently never reaches the container,
which is how `CLAUDISH_FAILOVER_*_RESET` was inert until `ffb7f39`.
