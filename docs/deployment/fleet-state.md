# Fleet State Manifest (non-secret)

Change-control surface for the claudish fleet coordinator (user mandate 2026-09-07).
Each machine's **effective** deployment state lives here, updated by its operator after
every change, corroborated by the coordinator where measurable.

Rules:

- **No secrets.** API keys, proxy keys, OAuth tokens: never. Fingerprints only (sha256, 8 chars max).
- Every armed-state change (cascade, upstream, ports, capture, image) = a commit to this
  file **plus** a note on the workspace dashboard.
- Qualifiers: `VERIFIED` (who measured, when) vs `DECLARED` (operator statement, date).
  A declaration is accepted until contradicted; the coordinator corroborates what is
  measurable from ai-01 (`/health` of hub/relay/sidecar, sidecar logs).
- The coordinator validates infra/traffic-affecting changes **ex-ante** (`[PROPOSAL]` →
  `[ACK]` on the dashboard); emergencies are validated ex-post with a post-mortem ≤ 1h.
  Post-restart/recreate proof obligations (≤ 15 min): startup line
  `[Failover] configured=N auto=on`, `/health`, `test -f` on every file bind,
  relay NOMINAL as seen by po-203.

## po-2025 — HUB (canonical since 05/09 cutover)

| Item | Value | Status |
| --- | --- | --- |
| Role | Hub, central capture | VERIFIED (traffic attribution) |
| Image | `2fe342f` | DECLARED 06/09 |
| Endpoint | `192.168.0.50:3000` (LAN) | VERIFIED 07/09 14:05Z (ai-01 `/health`) |
| Deploy dir | `D:\claudish-shadow` | DECLARED 07/09 |
| Recreate command | drained recreate with `--env-file D:\claudish-shadow\.env` | DECLARED 07/09 |
| ⚠ Trap | plain `up -d` loads `D:\dev\claudish\.env` (1 line) → **cascades EMPTY** | VERIFIED by incident 07/09 |
| Cascades | configured=3, auto=1 — SONNET mistral→qwen→PAYG · OPUS qwen→gc→PAYG · HAIKU qwen→PAYG · `ROLE_MODELS` set · `QWEN_THINKING=budget:4096` | DECLARED 07/09 14:01Z (startup line quoted) |
| Codex OAuth | file bind, 2165 B, expiry ~12-13/09 | DECLARED 07/09 |
| Restart epochs 07/09 | ~08:06Z · 13:59Z (incident repair) | VERIFIED (uptime probes) |

Incident 07/09: bind source `codex-oauth.json` recreated as an empty **directory** by
Docker → EISDIR → Codex 401s; repair bind file-over-directory → container
Created-never-started → fleet down 13:26→13:59Z; first repair `up -d` silently emptied
the cascades. Post-mortem: workspace dashboard 14:01Z (format of reference).

## po-2023 — RELAY

| Item | Value | Status |
| --- | --- | --- |
| Role | Relay → po-2025 via host TCP forwarder `:18182` | VERIFIED (settings + relay logs) |
| Endpoint | `192.168.0.46:3000` (LAN) | VERIFIED 07/09 (ai-01 `/health`) |
| `ClaudishDailyRestart` 04:00 | DISABLED (05/09, user UAC) | DECLARED |
| Cascade | auto; haiku→DeepSeek v4 Flash PAYG observed armed + recovered 07/09 | VERIFIED (po-203 cycles) |
| Sidecar native `:8787` | restarted (fix #3388) | DECLARED 06/09 |

## ai-01 — COORDINATOR + sidecar

| Item | Value | Status |
| --- | --- | --- |
| Sidecar | `localhost:3002`, upstream **`http://192.168.0.50:3000`** (direct to hub — double-hop removed) | VERIFIED 07/09 23:12Z (startup line + container env + egress from container) |
| Client `ANTHROPIC_BASE_URL` | `http://192.168.0.50:3000` (direct) — `settings.json`; profile template `settings.claudish.json` realigned 22:12Z | VERIFIED 07/09 22:12Z |
| Cascade | **NOT ARMED** (`.env` `CLAUDISH_FAILOVER_*` empty, no `[Failover]` startup line) — standing P1, awaits user GO. The "recreate cuts own traffic" objection is **void since 07/09**: the client no longer transits the sidecar | VERIFIED 07/09 23:12Z |
| customEndpoints | `vllm-myia` (key rotated 06/09, fp only), `qwen-token-plan` | VERIFIED (config.json) |
| Capture | on (outage trail) | VERIFIED |

## Other machines

| Machine | State | Status |
| --- | --- | --- |
| po-2024 | nominal, traffic on new hub | DECLARED |
| po-2026 | sidecar active (rebuilt 04/09) | DECLARED |
| po-2027 | traffic captured on new hub | DECLARED |

## Change log

| Date (Z) | Machine | Change | Proof |
| --- | --- | --- | --- |
| 2026-09-07 23:12 | ai-01 | sidecar recreated: `CLAUDISH_RELAY_UPSTREAM` `.46` → `.50`. Double-hop removed. Under the user's fleet-wide rollout GO (07/09 ~22:10Z) | startup `[Relay] sidecar mode: upstream=http://192.168.0.50:3000` + `docker inspect` env + `/health` + egress `curl` **from inside the container** to `.50` |
| 2026-09-07 22:16 | ai-01 | sidecar auto-restarted by the Docker daemon coming back up — **kept the OLD `.46` env**: a start does not reload `.env`, only a recreate does | `docker inspect` env vs on-disk `.env` (2 h of divergence, 17 header-timeout local fallbacks in the window) |
| 2026-09-07 21:33 | ai-01 | Docker Desktop back up after the deliberate stop (CoursIA runners) — 47 containers with `StartedAt` inside 0.4 s = host/daemon event, not a targeted gesture | `docker inspect .State.StartedAt` across all containers |
| 2026-09-07 13:59 | po-2025 | incident repair: drained recreate with correct `--env-file`, cascades restored, OAuth file bind | startup line + `/health` (DECLARED, corroborated ai-01 14:05Z) |
| 2026-09-07 ~08:06 | po-2025 | restart (cause TBD — post-mortem pending) | uptime probe ai-01 |
