# Relay Sidecar Deployment Runbook

The relay/sidecar design (v7.2+, see `CLAUDE.md` → "Relay / Sidecar Mode") removes po-2023 as a single point of failure: each machine runs its own claudish container that **relays** to the hub in nominal mode and **takes over locally** (AUTONOMOUS) when the hub dies. The relay code lives in [`packages/cli/src/fork/server/relay.ts`](../../packages/cli/src/fork/server/relay.ts); the per-machine installer is [`scripts/install-sidecar.ps1`](../../scripts/install-sidecar.ps1).

This runbook deploys a sidecar on each cluster machine **except web1** (which keeps pointing at `models.myia.io` directly) and **except the hub machine** — po-2025 since the 2026-09 migration (`192.168.0.50`), po-2023 (`192.168.0.46`) before it.

## Architecture reminder — one binary, three modes

| `CLAUDISH_RELAY_UPSTREAM` | Mode | Behavior |
| --- | --- | --- |
| **unset** | HUB | Always local. Unchanged. |
| set + hub **alive** | **NOMINAL relay** | Forwards the raw request to the hub; response repiped through the never-hang passthrough. No local capture (hub captures centrally). |
| set + hub **dead** | **AUTONOMOUS** | Local pipeline + local capture. Leak-policy hard (never Anthropic on machines with `CLAUDISH_NO_ANTHROPIC=1`). |

Hysteresis: 2 consecutive heartbeat failures → AUTONOMOUS; recovery needs 3 OK heartbeats + 60s cooldown + a deep tool-call probe before returning to NOMINAL (anti-flap).

## Prerequisite — choose the client authentication contract

Every machine's Claude Code `settings.json` must carry the cluster proxy key in the **`x-proxy-key`** custom header (NOT `x-api-key` — that triggers the hub's native swap and strips OAuth, breaking Opus). Keep that real hub credential separate from Claude Code's local authentication fields.

### Hybrid / Anthropic pass-through

Use this contract only on a machine that already has the required Claude/Anthropic OAuth and is authorized to route a native Anthropic lane:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: <MACHINE>\nx-proxy-key: <CLUSTER_KEY>"
  }
}
```

The empty token deliberately lets local OAuth authenticate native requests. Do not add proxy-only placeholders or force Console login to this profile.

### Proxy-only / no Anthropic account

Use this contract for a client whose advertised roles all resolve through non-Anthropic providers on the hub:

```json
{
  "forceLoginMethod": "console",
  "disableClaudeAiConnectors": true,
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-api03-placeholder-not-used-proxy-handles-auth-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "ANTHROPIC_AUTH_TOKEN": "placeholder-token-not-used-proxy-handles-auth",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Claudish-Machine: <MACHINE>\nx-proxy-key: <CLUSTER_KEY>"
  }
}
```

The two constant placeholders only bypass Claude Code's local onboarding checks. They are not provider credentials and must never be replaced with the real cluster key. `x-proxy-key` is the sole real client credential in this example; upstream provider credentials remain on the hub. Do not advertise a `claude-*` target in a proxy-only role mapping.

After the sidecar is installed, repoint `ANTHROPIC_BASE_URL` to the **local** sidecar (`http://localhost:3000`) instead of the hub IP/subdomain.

## Per-machine sidecar config

| Machine | `-Upstream` | `-Compress` | `-NoAnthropic` | Note |
|---|---|---|---|---|
| myia-ai-01 | `https://models.myia.io` | — | **no** | The one Anthropic authority; Opus traverses the relay via the header fix (OAuth preserved). **Not the LAN IP** — this machine's Docker has no route to it (see "Docker cannot reach the LAN hub"). Also needs `-HostPort 3002 -ContainerName claudish-sidecar` (3000 taken by a third-party service). |
| myia-po-2024 | `http://192.168.0.50:3000` | — | yes | LAN — ⚠ **measured stale 2026-09-14**: the installed sidecar still carries `192.168.0.46` (see "A hub migration does not propagate") |
| myia-po-2025 | `https://models.myia.io` | yes | yes | WAN external — **this machine is the hub** |
| myia-po-2026 | `http://192.168.0.50:3000` | — | yes | LAN — ⚠ **measured stale 2026-09-23**: compose `.env` (mtime 26/07) AND live container still carry `192.168.0.46` (see "A hub migration does not propagate"); client bypasses the sidecar direct to `.50`, so the drift is latent |

- **web1**: no sidecar — stays on `https://models.myia.io` directly.
- **po-2023**: no longer the hub; it runs a relay sidecar like the others.

### A hub migration does not propagate to a sidecar's upstream

`CLAUDISH_RELAY_UPSTREAM` is a **literal baked into the sidecar's `.env` at install time**. Nothing re-resolves it: move the hub and every sidecar keeps forwarding to the old address until someone edits that file by hand.

The 2026-09 migration (hub po-2023 `192.168.0.46` → po-2025 `192.168.0.50`) exposed this on **po-2024**, where a standalone sidecar (`:3914`, auto-started from HKCU `Run` via `.start-claudish-sidecar.ps1`) still carries the hardcoded `http://192.168.0.46:3000`. It relays po-2024 → po-203 → hub, re-introducing po-203 into a path the sidecar design exists to remove. This document previously stated that **po-2026's `.env` was repointed to `.50` by hand on 2026-09-13 — that never landed**: measured 2026-09-23, the compose `.env` (`C:\dev\claudish\.env`, mtime 2026-07-26) and the live container env **both** still carry `.46`. Both machines are in the same drift state; po-2026's is latent only because its client points at the hub directly and the sidecar serves zero streams. The repoint is planned for the next drained recreate, via `[PROPOSAL]` + single ACK (coordinator arbitration 2026-09-22). Nothing flagged the drift on either machine until the live paths were cross-read — a settings file alone proves nothing about the container.

### The compose dir may be a different clone than the one you develop in

On po-2026 the sidecar's compose project lives in **`C:\dev\claudish`**, while the working/dev tree is `D:\Dev\claudish`. The `.env` that governs the container is the one **in the compose dir**, not the one nearest your editor — a repoint edited into the wrong clone is a silent no-op on the running container (and a plausible origin for "repointed" claims that never landed). Read the authoritative path from the container itself:

```powershell
docker inspect claudish-proxy --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
```

Then verify the change the same way the change is consumed: `docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | Select-String '^CLAUDISH_RELAY_UPSTREAM='` — **filter before anything is printed**: the unfiltered env carries `CLAUDISH_PROXY_KEY` in clear, and a console output tends to end up in a transcript, a capture or a dashboard. The **container env**, never the file alone, is the live path (a start does not reload `.env`; only a recreate does).

**Why a per-consumer verification misses it**: `ANTHROPIC_BASE_URL` on po-2024 reads `http://192.168.0.50:3000` — correct. The drift lives in a **second, independent consumer** (an auto-start process), not in the settings file. Verifying "where each client lands" therefore means **enumerating processes**, not reading `~/.claude/settings.json`:

```powershell
Get-NetTCPConnection -State Established | Where-Object RemotePort -in 3000,3001,3002 |
  ForEach-Object { "$($_.OwningProcess) -> $($_.RemoteAddress):$($_.RemotePort)" }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'claudish|sidecar|proxy' } |
  Select-Object ProcessId, CommandLine
```

Any hub move must walk this list on every machine. A machine whose only evidence of migration is its settings file is **unverified**, not migrated.

## Prerequisites on each sidecar machine

1. **Docker** + `docker compose`.
2. **`config.json`** at `~/.claudish/config.json` with provider keys (`ZAI_API_KEY` / `GLM_CODING_API_KEY` / `MINIMAX_CODING_API_KEY`, routing, profiles). The installer refuses to proceed without one — copy from the hub's `~/.claudish/config.json` and adjust per machine.
3. **Captures dir** (default `D:\claudish-captures`; override with `-CapturesDir` on machines without a D: drive).

## Install (run ON the target machine)

```powershell
# From a clone of the fork (or the installer clones it for you at C:\Dev\claudish)
cd D:\Dev\claudish   # if already cloned here; else the script clones to C:\Dev\claudish

# ai-01 (Anthropic authority — NO -NoAnthropic)
.\scripts\install-sidecar.ps1 -Machine myia-ai-01 `
    -Upstream https://models.myia.io -ProxyKey '<CLUSTER_KEY>'

# po-2025 (WAN external — Compress + NoAnthropic)
.\scripts\install-sidecar.ps1 -Machine myia-po-2025 `
    -Upstream https://models.myia.io -ProxyKey '<CLUSTER_KEY>' -Compress -NoAnthropic
```

The installer is **idempotent**: it pulls latest `main`, (re)writes the `.env`, and recreates the container. It will not clobber an existing `config.json` — and since #141 it will not clobber runtime-policy lines either: any `CLAUDISH_FAILOVER_*`, `CLAUDISH_QWEN_THINKING`, `CLAUDISH_GLM_THINKING`, `SEARXNG_URL` or set-but-empty `CLAUDISH_CAPTURE_DIR` lines already present in the `.env` are carried over verbatim on rewrite (before #141 the wholesale rewrite silently dropped them, so an armed cascade lived only in the container's Docker env record — and the installer's own `compose up` wiped it).

What it sets (in `<RepoDir>/.env`, consumed by `docker-compose.yml`):
- `CLAUDISH_PROXY_KEY` — the cluster gate key (same everywhere).
- `CLAUDISH_RELAY_UPSTREAM` — the hub URL.
- `CLAUDISH_RELAY_COMPRESS=1` (only with `-Compress`; WAN uplink gzip).
- `CLAUDISH_NO_ANTHROPIC=1` (only with `-NoAnthropic`; leak-policy local backstop).
- `CLAUDISH_CONFIG_DIR` / `CLAUDISH_CAPTURE_HOST_DIR` — the host bind-mount paths.
- `CLAUDISH_HOST_PORT` (`-HostPort`, default 3000) — the published host port. **Required on any machine where 3000 is already taken** (ai-01, where a third-party service holds it). The container side always stays 3000.
- `CLAUDISH_CONTAINER_NAME` (`-ContainerName`, default `claudish-proxy`) — give a sidecar its own name so logs and scripts never confuse it with the hub container.
- `CLAUDISH_CAPTURE_DIR=` (empty, only with `-NoCapture`) — disables capture writing. Escape hatch for disk-starved hosts only; it destroys the outage-capture trail that `reconcile-outage-captures.ps1` depends on.

### Recovering an armed cascade that exists only in the container (#141)

If the cascades were armed by hand (container env, never written to the `.env` — the pre-#141 default), **any recreate wipes them**. Two protections:

- **Refusals.** The installer **exits non-zero** before writing anything when the `.env` it is about to produce carries no armed `CLAUDISH_FAILOVER_*` while the live container has one; `claudish-drain.ps1 -Recreate` refuses the same condition against its `-EnvFile` (an env file can *exist* and still gut the cascades — it merely lacks them).
- **Recovery.** `install-sidecar.ps1 -RebuildEnvFromContainer` rebuilds the `.env` from the live container's env record (`docker inspect`), reports which armed vars were missing (names only), and verifies the write by reading it back — no pull, no compose, container untouched. The output file contains `CLAUDISH_PROXY_KEY`: local file only, never committed, never displayed. `-WriteEnvOnly` refreshes the `.env` (with the preserve rules above) without touching the container.

### An armed cascade is blind to bare model ids without `ROLE_MODELS` — measured both ways, 2026-09-22

Arming `CLAUDISH_FAILOVER_<ROLE>` is necessary but not sufficient: `roleFromModelName()` matches only `opus|sonnet|haiku|fable`, so a client naming the model directly (`model=glm-5.2` in an sdk-ts request, no role anywhere) resolves to `null` and the cascade never engages — the request walks the full retry ladder against the wall with nowhere to fall. Two measurements the same morning:

- **Without the mapping** (ai-01 sidecar, 08:35Z, *reported by ai-01*): 7 consecutive dead turns against the GLM 5h wall — every one a full ladder of retries, ~62s each, no fallback ever taken.
- **With it** (hub po-2025, 08:05Z): a bare `model=glm-5.2` request hit the same wall, `[Failover] ARMED sonnet → Mistral GLM — HTTP 429 from glm-5.2`, Mistral also walled (402), the session was pinned to step 2 (Kimi K3) and the **turn completed** (`resp … model=k3 … closed=true stop=tool_use`).

The line the hub runs (copy into the sidecar `.env` when arming, adjusting to the models its clients actually name — check the `[Request] model=` lines in the container log):

```
CLAUDISH_FAILOVER_ROLE_MODELS=glm-5.2:sonnet,glm-5.3:sonnet,minimax-m3:haiku
```

Once written it survives every installer rewrite (#141 carries `CLAUDISH_FAILOVER_*` verbatim); the gap is that nothing provisions it by default — `.env.sidecar.example` documents the var empty, and this runbook's arming checklist never mentioned it until now.

## Repoint the client

After the installer reports **SIDECAR INSTALLED … mode: NOMINAL relay**, edit this machine's `~/.claude/settings.json`:

```json
"ANTHROPIC_BASE_URL": "http://localhost:<HostPort>"
```

Keep the selected authentication contract intact: an empty `ANTHROPIC_AUTH_TOKEN` for hybrid/OAuth pass-through, or both non-secret placeholders plus `forceLoginMethod: "console"` for proxy-only. In both cases, keep the `x-proxy-key` + `X-Claudish-Machine` custom header. Restart Claude Code.

> **The repoint is the risky step, and it is the one that caused the 2026-08-10 ai-01 outage.** Stand the container up and validate it *before* touching `ANTHROPIC_BASE_URL`, so a failed install never costs the machine its agents. Keep the previous value at hand to roll back.

## Validation

1. **NOMINAL mode**: `docker logs <ContainerName> 2>&1 | Select-String 'Relay|NOMINAL|upstream'` should show the prober reporting the hub alive. A request through `http://localhost:<HostPort>` is relayed (the installer's end-to-end probe already confirms this).
2. **Native path (ai-01 only)**: the installer probe uses `glm-5.3` — the traffic class the relay header bug *spared*. It proves nothing about native passthrough. On ai-01 the real acceptance is **a live Opus turn from Claude Code after the repoint**: an HTTP probe cannot carry the OAuth that the bug destroyed, so it is blind by construction.
3. **Failover**: stop the hub (`docker stop claudish-proxy` **on po-2023**) → within ~20s this sidecar flips AUTONOMOUS → a glm/minimax request still succeeds (served locally). Restart the hub → after hysteresis the sidecar returns to NOMINAL. (Coordinate the hub-stop with the cluster — it briefly interrupts every direct-to-hub client too.)
4. **Attribution survives**: `traffic-live.ps1` / captures still show `machine=<MACHINE>` on this machine's requests — the relay preserves `X-Claudish-Machine` by design.

### Validation when the sidecar is a bun PROCESS, not a container

Some machines run the relay as a bare `bun packages/cli/src/fork/server/standalone-proxy.ts --port <P> --host 127.0.0.1` launched from `HKCU\...\Run`, because port 3000 is taken or Docker's egress cannot reach the LAN. `docker logs` does not exist there, so **the launcher has to create the log** — and if it does not, G2 silently becomes unverifiable.

That is not hypothetical. Measured on po-2024, 2026-09-21: the launcher invoked bun directly under a hidden `pwsh`, so the sidecar's **stdout was discarded entirely** — the process was healthy, relaying, and carried no log at all. From outside, "no `[ttft]` line" is indistinguishable from "the relay never forwarded anything", and `[ttft]` is the *only* instrument that sees forwarded volume on a sidecar (a relayed request writes no capture and emits no `[Request]`).

**Redirect with the child's file handle, never with a PowerShell pipe.** `*>>` is implemented through `Out-File` and buffers, so the line that proves forwarding can stay invisible for as long as the buffer holds — an instrument that reports late reads exactly like an instrument that reports nothing:

```powershell
$logPath = Join-Path $env:USERPROFILE ".claudish\sidecar-stdout.log"
$errPath = Join-Path $env:USERPROFILE ".claudish\sidecar-stderr.log"
foreach ($p in @($logPath, $errPath)) {   # rotation happens at LAUNCH only — see the third trap
    if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p).Length -gt 8MB)) {
        Move-Item -LiteralPath $p -Destination "$p.1" -Force
    }
}
$bunExe = Join-Path $env:APPDATA "npm\node_modules\bun\bin\bun.exe"
if (-not (Test-Path -LiteralPath $bunExe)) { $bunExe = (Get-Command bun.exe -ErrorAction Stop).Source }
Start-Process -FilePath $bunExe -ArgumentList 'packages/cli/src/fork/server/standalone-proxy.ts','--port','3914','--host','127.0.0.1' `
    -RedirectStandardOutput $logPath -RedirectStandardError $errPath -WindowStyle Hidden -Wait
```

**Redirect both streams or the fix is half a fix.** `-RedirectStandardError` is not optional here: claudish writes a large share of its operational markers to stderr, so a launcher that captures stdout alone reproduces the same blindness on the other half — and `Start-Process` *refuses* a null path (`Impossible de valider l'argument … L'argument est nul ou vide` / `Cannot validate argument … null or empty`), so an undefined `$errPath` is a hard binding failure at launch, not a silent degradation. That refusal is the good case: the launcher dies loudly instead of starting a blind sidecar.

Three traps found while making that change, all worth keeping:

- **`Start-Process -FilePath 'bun'` fails** with *"%1 is not a valid Win32 application"* (localized, e.g. *"%1 n'est pas une application Win32 valide"*) — the name resolves to a shim, not the exe. Resolve it (`Join-Path $env:APPDATA "npm\node_modules\bun\bin\bun.exe"`, falling back to `(Get-Command bun.exe).Source`); the same command line works fine when the shell resolves it, which is why the defect hides.
- **The instrument has to be proven while the process is ALIVE**, not after it exits: a redirect that only flushes at exit passes every post-mortem check and still leaves you blind in production. The check is a real turn followed by reading the file *before* stopping the sidecar — po-2024: `200` + `message_stop`, then `1` `[ttft]` line readable at 315 bytes with `0` `[Request]` (the correct NOMINAL signature).
- **The rotation above runs at launch, so it bounds nothing while the sidecar is up.** These launchers are `HKCU\...\Run` entries: they fire once per logon, and a relay that stays up for weeks writes one unbounded file the whole time (`uptimeSec` past 200 000 is ordinary on these machines). The 8 MB check is a floor against accumulation *across* logons, not a size cap — if the log has to stay bounded in production, that is a separate rotation, not this line.

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
