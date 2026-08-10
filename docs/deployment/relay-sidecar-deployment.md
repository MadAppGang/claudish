# Relay Sidecar Deployment Runbook

The relay/sidecar design (v7.2+, see `CLAUDE.md` → "Relay / Sidecar Mode") removes po-2023 as a single point of failure: each machine runs its own claudish container that **relays** to the hub in nominal mode and **takes over locally** (AUTONOMOUS) when the hub dies. The relay code lives in [`packages/cli/src/fork/server/relay.ts`](../../packages/cli/src/fork/server/relay.ts); the per-machine installer is [`scripts/install-sidecar.ps1`](../../scripts/install-sidecar.ps1).

This runbook deploys a sidecar on each cluster machine **except web1** (which keeps pointing at `models.myia.io` directly) and **except po-2023** (the hub).

## Architecture reminder — one binary, three modes

| `CLAUDISH_RELAY_UPSTREAM` | Mode | Behavior |
| --- | --- | --- |
| **unset** | HUB (po-2023) | Always local. Unchanged. |
| set + hub **alive** | **NOMINAL relay** | Forwards the raw request to the hub; response repiped through the never-hang passthrough. No local capture (hub captures centrally). |
| set + hub **dead** | **AUTONOMOUS** | Local pipeline + local capture. Leak-policy hard (never Anthropic on machines with `CLAUDISH_NO_ANTHROPIC=1`). |

Hysteresis: 2 consecutive heartbeat failures → AUTONOMOUS; recovery needs 3 OK heartbeats + 60s cooldown + a deep tool-call probe before returning to NOMINAL (anti-flap).

## Prerequisite — the client `x-proxy-key` fix

Every machine's Claude Code `settings.json` must carry the cluster proxy key in the **`x-proxy-key`** custom header (NOT `x-api-key` — that triggers the hub's native swap and strips OAuth, breaking Opus). See memory `proxy-key-custom-header-auth`:

```json
"ANTHROPIC_AUTH_TOKEN": "",
"ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: <MACHINE>\nx-proxy-key: <CLUSTER_KEY>"
```

After the sidecar is installed, repoint `ANTHROPIC_BASE_URL` to the **local** sidecar (`http://localhost:3000`) instead of the hub IP/subdomain.

## Per-machine sidecar config

| Machine | `-Upstream` | `-Compress` | `-NoAnthropic` | Note |
|---|---|---|---|---|
| myia-ai-01 | `https://models.myia.io` | — | **no** | The one Anthropic authority; Opus traverses the relay via the header fix (OAuth preserved). **Not the LAN IP** — this machine's Docker has no route to it (see "Docker cannot reach the LAN hub"). Also needs `-HostPort 3002 -ContainerName claudish-sidecar` (3000 taken by a third-party service). |
| myia-po-2024 | `http://192.168.0.46:3000` | — | yes | LAN |
| myia-po-2025 | `https://models.myia.io` | yes | yes | WAN external |
| myia-po-2026 | `http://192.168.0.46:3000` | — | yes | LAN |

- **web1**: no sidecar — stays on `https://models.myia.io` directly.
- **po-2023**: the hub (`RELAY_UPSTREAM` unset). Unchanged.

## Prerequisites on each sidecar machine

1. **Docker** + `docker compose`.
2. **`config.json`** at `~/.claudish/config.json` with provider keys (`ZAI_API_KEY` / `GLM_CODING_API_KEY` / `MINIMAX_CODING_API_KEY`, routing, profiles). The installer refuses to proceed without one — copy from the hub's `~/.claudish/config.json` and adjust per machine.
3. **Captures dir** (default `D:\claudish-captures`; override with `-CapturesDir` on machines without a D: drive).

## Install (run ON the target machine)

```powershell
# From a clone of the fork (or the installer clones it for you at C:\Dev\claudish)
cd D:\Dev\claudish   # if already cloned here; else the script clones to C:\Dev\claudish

# ai-01 (LAN, Anthropic authority — NO -NoAnthropic)
.\scripts\install-sidecar.ps1 -Machine myia-ai-01 `
    -Upstream http://192.168.0.46:3000 -ProxyKey b28622...full-cluster-key...

# po-2025 (WAN external — Compress + NoAnthropic)
.\scripts\install-sidecar.ps1 -Machine myia-po-2025 `
    -Upstream https://models.myia.io -ProxyKey b28622...full-cluster-key... -Compress -NoAnthropic
```

The installer is **idempotent**: it pulls latest `main`, (re)writes the `.env`, and recreates the container. It will not clobber an existing `config.json`.

What it sets (in `<RepoDir>/.env`, consumed by `docker-compose.yml`):
- `CLAUDISH_PROXY_KEY` — the cluster gate key (same everywhere).
- `CLAUDISH_RELAY_UPSTREAM` — the hub URL.
- `CLAUDISH_RELAY_COMPRESS=1` (only with `-Compress`; WAN uplink gzip).
- `CLAUDISH_NO_ANTHROPIC=1` (only with `-NoAnthropic`; leak-policy local backstop).
- `CLAUDISH_CONFIG_DIR` / `CLAUDISH_CAPTURE_HOST_DIR` — the host bind-mount paths.
- `CLAUDISH_HOST_PORT` (`-HostPort`, default 3000) — the published host port. **Required on any machine where 3000 is already taken** (ai-01, where a third-party service holds it). The container side always stays 3000.
- `CLAUDISH_CONTAINER_NAME` (`-ContainerName`, default `claudish-proxy`) — give a sidecar its own name so logs and scripts never confuse it with the hub container.
- `CLAUDISH_CAPTURE_DIR=` (empty, only with `-NoCapture`) — disables capture writing. Escape hatch for disk-starved hosts only; it destroys the outage-capture trail that `reconcile-outage-captures.ps1` depends on.

## Repoint the client

After the installer reports **SIDECAR INSTALLED … mode: NOMINAL relay**, edit this machine's `~/.claude/settings.json`:

```json
"ANTHROPIC_BASE_URL": "http://localhost:<HostPort>"
```

Keep `ANTHROPIC_AUTH_TOKEN` empty and keep the `x-proxy-key` + `X-Claudish-Machine` custom header. Restart Claude Code.

> **The repoint is the risky step, and it is the one that caused the 2026-08-10 ai-01 outage.** Stand the container up and validate it *before* touching `ANTHROPIC_BASE_URL`, so a failed install never costs the machine its agents. Keep the previous value at hand to roll back.

## Validation

1. **NOMINAL mode**: `docker logs <ContainerName> 2>&1 | Select-String 'Relay|NOMINAL|upstream'` should show the prober reporting the hub alive. A request through `http://localhost:<HostPort>` is relayed (the installer's end-to-end probe already confirms this).
2. **Native path (ai-01 only)**: the installer probe uses `glm-5.2` — the traffic class the relay header bug *spared*. It proves nothing about native passthrough. On ai-01 the real acceptance is **a live Opus turn from Claude Code after the repoint**: an HTTP probe cannot carry the OAuth that the bug destroyed, so it is blind by construction.
3. **Failover**: stop the hub (`docker stop claudish-proxy` **on po-2023**) → within ~20s this sidecar flips AUTONOMOUS → a glm/minimax request still succeeds (served locally). Restart the hub → after hysteresis the sidecar returns to NOMINAL. (Coordinate the hub-stop with the cluster — it briefly interrupts every direct-to-hub client too.)
4. **Attribution survives**: `traffic-live.ps1` / captures still show `machine=<MACHINE>` on this machine's requests — the relay preserves `X-Claudish-Machine` by design.

## Troubleshooting — Docker cannot reach the LAN hub

**Symptom**: the installer's probe returns 200 with `message_stop`, but the sidecar logs `[Relay] upstream … DOWN → AUTONOMOUS`, and every request shows a local `[claudish] [Request]` line plus a fresh capture file. The sidecar looks healthy while silently bypassing the hub.

**Cause**: Docker's egress is not the host's egress. On ai-01 (2026-08-10) `curl http://192.168.0.46:3000/health` returned `{"status":"ok"}` **from the host** while the same request **from inside the container** timed out and `ping` lost 100% of packets — internet egress worked fine. Docker Desktop on Windows routinely has no route to a physical LAN address.

**Diagnose from inside the container** (host-side tests prove nothing here):

```powershell
docker exec <ContainerName> wget -qO- --timeout=5 http://192.168.0.46:3000/health   # LAN
docker exec <ContainerName> wget -qO- --timeout=8 https://models.myia.io/health     # WAN
```

**Fix**: use the WAN endpoint as the upstream — it is the same hub, reachable from the container:

```powershell
.\scripts\install-sidecar.ps1 -Machine myia-ai-01 -Upstream https://models.myia.io ...
```

Leave `-Compress` off on a machine that is physically on the LAN: the uplink is not the constrained direction there, and the hub inflates either way.

**Related sharp edge — the first request after a restart may be served locally.** `forwardToUpstream` bounds the *header* phase at 5s; a cold DNS+TLS handshake to a WAN upstream can exceed that, so the request falls through to local (by design — never hang). It logs nothing, because `markFail` only logs on the 2-failure transition. Warm up before judging the mode; the installer now does exactly that.

**How to tell NOMINAL from AUTONOMOUS** (the only reliable test): in NOMINAL the relay branch sits *before* `logRequest`/capture, so a relayed request emits **no** `[claudish] [Request]` line and writes **no** capture file. Either artifact appearing means the request was served locally.

## Known limitation — NOMINAL leak policy is soft

`CLAUDISH_NO_ANTHROPIC=1` is a **local/autonomous** backstop: it reroutes bare native targets to the budget sonnet (glm) inside the sidecar's own pipeline. In NOMINAL mode the sidecar forwards the raw request to the hub, where `CLAUDISH_NO_ANTHROPIC` is **unset** (the hub must allow native so ai-01/po-2023 Opus works). So a relayed executor Opus is not hard-blocked at the hub — identical to today's direct-to-hub behavior. Leak prevention for executor Opus relies on **not selecting Opus on those machines** + the 6h surveillance cron / `traffic-anthropic.ps1`, exactly as before. This deployment does not change that posture.

## Pilot (already done on po-2023 before fleet rollout)

A sidecar on `:3001` → hub `:3000` validated: (1) NOMINAL relay of glm/minimax; (2) **Opus passthrough via the relay header fix** (client OAuth preserved → Anthropic 200); (3) failover AUTONOMOUS + hysteresis recovery; (4) never-hang on mid-stream hub kill. See the plan at `~/.claude/plans/expressive-bubbling-charm.md`.
