# Fleet cross-machine Docker inspection (read-only)

**Why:** coordinator mandate of 2026-09-07 — the coordinator (and peers) must verify
sibling deployment state (cascade env, container status, logs) without SSH-ing into
each other's hosts. Docker's native client facility is the **context system**; the
only design decision is the transport behind it:

| Transport | Native? | Access | Use |
| --- | --- | --- | --- |
| **A. Read-only socket-proxy** (this runbook) | community-standard pattern | **GET only** — inspect/ps/logs, no create/exec/kill | fleet standard for verification |
| **B. SSH context** (`host=ssh://…`) | built into Docker CLI | **full daemon control** | break-glass remote repair, user-approved per use, not armed by default |

Never expose the raw daemon (`2375` on Docker Desktop settings = unauthenticated
full control; the `--since`-era instinct to just flip that checkbox is the one thing
this document exists to prevent).

## Option A — per-machine read-only proxy

### On the TARGET machine (the one being inspected)

Preflight (non-elevated):

```powershell
Get-NetTCPConnection -LocalPort 2375 -State Listen -ErrorAction SilentlyContinue  # must return nothing
docker pull tecnativa/docker-socket-proxy:0.3.0
```

Run the proxy — **standalone container, never added to claudish's compose**
(orthogonal lifecycle: claudish deploys must not restart it, and its config must not
mix with the hub's `.env` — the exact confusion that voided the cascades on 07/09):

```powershell
docker run -d --name docker-inspect-ro --restart unless-stopped `
  -p 2375:2375 `
  -v /var/run/docker.sock:/var/run/docker.sock:ro `
  -e CONTAINERS=1 -e INFO=1 -e VERSION=1 -e PING=1 `
  tecnativa/docker-socket-proxy:0.3.0
```

`POST` stays `0` (default) → every non-GET is denied at the proxy. `EVENTS` and
`EXEC` stay `0`.

Local verification:

```powershell
curl http://localhost:2375/version                    # 200
curl "http://localhost:2375/containers/json?all=1"    # 200 — includes claudish containers
curl -X POST http://localhost:2375/containers/create  # MUST be denied (403)
```

LAN reachability: Docker Desktop publishes on `0.0.0.0`, so a peer test comes first
(`curl http://<machine-ip>:2375/version` from another fleet machine). Only if the
peer is blocked, add **one** scoped firewall rule — this is the runbook's only
elevated gesture (UAC discipline: announced on the dashboard beforehand, single pass):

```powershell
# elevated — scoped to the fleet subnet, or tighten to explicit fleet IPs
New-NetFirewallRule -DisplayName "docker-inspect-ro (fleet)" -Direction Inbound `
  -Protocol TCP -LocalPort 2375 -RemoteAddress 192.168.0.0/24 -Action Allow
```

Known fleet addresses: ai-01 `192.168.0.47` · po-2023 `192.168.0.46` ·
po-2025 `192.168.0.50` (fill po-2024/2026/2027 at rollout).

### On the CLIENT machine (ai-01 first)

```powershell
docker context create po-2025-ro --docker host=tcp://192.168.0.50:2375
docker context create po-2023-ro --docker host=tcp://192.168.0.46:2375
```

Daily verification gestures:

```powershell
docker --context po-2025-ro ps -a
docker --context po-2025-ro inspect claudish-proxy --format "{{json .Config.Env}}"  # cascade armed state
docker --context po-2025-ro logs claudish-proxy --tail 50
```

## Security notes

- GET-only, but `inspect` returns container `Env` **including secrets** — the
  dashboard rule is unchanged: fingerprints (sha256, 8 chars), never raw values.
- The port is reachable by anything inside the firewall scope — that is why the rule
  is scoped, never `Any`.
- Deploying the proxy is itself an infra gesture under the mandate:
  `[PROPOSAL]` → coordinator `[ACK]` → run → proofs posted (the three curls above).
- If the `/var/run/docker.sock` mount misbehaves on a given Docker Desktop host
  (per-machine variance exists), report on the dashboard — do **not** fall back to
  exposing the daemon directly.

## Option B — native SSH context (break-glass, not default)

```powershell
docker context create po-2025-ssh --docker host=ssh://user@192.168.0.50
```

Requires OpenSSH Server on the target (elevation to enable) and key exchange; a
forced `command="docker system dial-stdio"` in `authorized_keys` limits the key to
the Docker channel. It still grants **full** daemon control — reserve for
user-approved remote repair; do not arm fleet-wide.

## Rollout order

1. **po-2025** (hub — the machine the mandate watches)
2. **po-2023** (relay)
3. po-2024 / po-2026 / po-2027

Each machine's operator runs the runbook and posts the proofs; the coordinator
records the endpoint in `docs/deployment/fleet-state.md` and verifies cross-machine
(`ps -a` through the context, `POST` denied, `docker-inspect-ro` `Up` after a Docker
Desktop restart).
