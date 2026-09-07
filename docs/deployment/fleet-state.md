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
| Sidecar | `localhost:3002`, upstream `http://192.168.0.46:3000` (double-hop) | VERIFIED |
| Cascade | **NOT ARMED** (`.env` `CLAUDISH_FAILOVER_*` empty) — standing P1, awaits user GO (recreate cuts own traffic) | VERIFIED 07/09 |
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
| 2026-09-07 13:59 | po-2025 | incident repair: drained recreate with correct `--env-file`, cascades restored, OAuth file bind | startup line + `/health` (DECLARED, corroborated ai-01 14:05Z) |
| 2026-09-07 ~08:06 | po-2025 | restart (cause TBD — post-mortem pending) | uptime probe ai-01 |
