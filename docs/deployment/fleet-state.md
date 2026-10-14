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
| `ClaudishDailyRestart` 04:00 | **DELETED 08/10 10:09:58 local** (user UAC batch v2, gesture G1); last `daily-0400` → `OUTCOME success` 08/10 07:31 local | DECLARED 08/10 (po-2025; absence re-confirmed 10:19:35 local) |
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
| `ClaudishDailyRestart` 04:00 | DISABLED (05/09, user UAC) | VERIFIED 09/10 (po-2023: `State=Disabled`, `LastRunTime 05/09 04:00:01`, `LastTaskResult 0`) |
| Cascade | auto; haiku→DeepSeek v4 Flash PAYG observed armed + recovered 07/09 | VERIFIED (po-203 cycles) |
| Sidecar native `:8787` | restarted (fix #3388) | DECLARED 06/09 |
| **Client path** (live `~/.claude/settings.json`) | `env.ANTHROPIC_BASE_URL = http://127.0.0.1:3000` — **this relay**. The 06/10 contradiction is **resolved**: the user arbitrated "OK pour relai" (08/10, option a), executed 10/10 grain 4 (surgical 1-occurrence replace, rest byte-identical); `_intentional_diffs.ANTHROPIC_BASE_URL` now declares the same value and Q-20261006-1 is retired. Sessions launched before the switch kept their env; every Claude Code process since transits the relay | VERIFIED 10/10 21:34Z (live `settings.json` re-read; traffic corroborated — see Population row) |
| **WAN edge** `models.myia.io` (IIS site 49, hosted on po-2023) | reverse-proxy target `http://192.168.0.50:3000` — hub **direct**, relay bypassed. web.config mtime **2026-10-04 21:24 local**, sha256 `7ADE6AD6` — **unchanged since the 08/10 measurement** (no silent revert; the 30/09 state `localhost:3000` no longer holds) | VERIFIED 09/10 07:20Z (live web.config + `applicationHost.config`) |
| **Edge client population** (09/10 00:00→15:08Z — partial day, window closed at the 15:08Z reading; 9911 req) | 2 off-site `claude-cli` **cron** clients (2350 + 71 real `/v1/messages`) · the **hairpin** `Bun/1.3.14` instance (LAN-internal, ~10 s `/health` cadence until 10Z then ~5 s; it also issues `/v1/messages` — so it is a claudish instance, not a bare prober; **source still unattributable from po-203**) · ~40 internet scanner hits (Palo Alto Xpanse, `/.env`) | VERIFIED 09/10 (W3SVC49 log) |
| **WAN path has no fallback — measured cost** | 09/10 00:00→15:08Z (partial day): **41× 502** on the edge, incl. bursts 12:54–12:55Z and 13:05–13:08Z and 4× at 14:29–14:42Z, hitting **real inference** (`/v1/messages`) of our own cron clients and the hairpin instance. **Cause of the first two bursts** (arrived after the 15:08Z reading): **two deliberate, drained and logged hub restarts** (po-2025 `drain.log`, read 09/10 21:41Z) — **12:55Z** *coursia-pilot inbound key (config.json bind-mount reload)* and **13:07:29Z** *coursia-pilot key rotation (exposure hygiene)*, both `OUTCOME success`, the second announcing **6 in-flight streams cut**. The `instanceId` chain carries the intermediate link: `082ebb60` → *(instance of 12:55Z)* → **`5d09f9eb` (started 13:07:28Z)**. The **14:29–14:42Z burst (4×502) has no identified cause** — nothing in `drain.log`, no correlated restart known. **Corroborated by the relay's own log**: the relay on this same machine went `→ AUTONOMOUS` at **12:54:15Z** (back NOMINAL 12:56:04Z, 109 s) and **13:05:47Z** (back 13:08:08Z, 141 s) — the *same two windows*: the relay failed over and served locally, the edge had nothing to fail over to. **What the 41×502 measures is therefore the price of a hub drain on a path with no fallback — not an outage.** This inverts the "relay bypass costs nothing" reading of the 07:20Z measurement — nothing on a quiet day, 41×502 on a drain day | VERIFIED 09/10 15:08Z (W3SVC49 log + relay `→ AUTONOMOUS` transitions); cause attributed 09/10 21:41Z (po-2025 `drain.log`) |
| **Population served by this relay** | the machine's **entire local Claude Code traffic** + the watchdog probes. Measured 10/10 22:31Z: **244 forwards in 3 h** (138 `claude-sonnet-5-5` · 93 `claude-haiku-4-5` · 13 probe `glm-5.2` — 15-min cadence ≈ exact probe count); 23:21Z: **405 forwards in 50 min** (313 sonnet · 88 haiku · 4 probes — multiple concurrent CC cycles). The WAN edge still bypasses the relay (`.50` direct) | VERIFIED 10/10 22:31Z + 23:21Z (relay docker log `[ttft]`, timestamp-filtered) |
| **Proxy key (RX96)** | new cluster key live since the **12/10 13:36:24Z drained recreate** (P3; image unchanged `9e280fb3a939` — env-only rotation; cascades armed file=4/container=4 intact across the recreate, `OUTCOME success` ~4 s); old key kept in `CLAUDISH_PROXY_KEY_PREVIOUS` on the hub for the overlap window, rupture due **≤ 14/10 ~11:48Z**; consumers migrated: container env, compose `.env`, `settings.json`, and the RSM `.env` (sibling workspace, hot-reloaded — its host was the measured emitter of the po-203 old-key bucket) | VERIFIED 12-13/10 (env by value, sha256 fingerprint, `proxyKeyPreviousHits` hub-side) |
| **Watchdog proactive restart 13/10** | 03:01:03 local (01:01:06Z) — uptime 11.4 h, **0 streams cut** (`started at 0 stream(s), waited 0s`), `OUTCOME success`, post-restart canary OK. Container `Created` unchanged (12/10 13:36:24Z): a restart, not a recreate — log window preserved. Correlated: the hub's own watchdog restarted in the same quiet window (~01:02Z), the relay flipped `→ AUTONOMOUS` **01:02:29Z → 01:03:37Z (68 s)** on the heartbeat and recovered — the same scheduling-coincidence class as 10/10 (both watchdogs in the 03:00-06:00 local window) | VERIFIED 13/10 03:37Z (watchdog.log + relay docker log + `docker inspect` StartedAt/Created) |

## ai-01 — COORDINATOR + sidecar

| Item | Value | Status |
| --- | --- | --- |
| Sidecar | `localhost:3002` (+ NanoClaw portproxy `0.0.0.0:13000` → `127.0.0.1:3002`), upstream **`http://192.168.0.50:3000`** (direct to hub — double-hop removed); image `01454736`, built from `main` `61c3d2d` (carries the #218 native pin, predates #225/#226) | VERIFIED 23/09 04:16Z (drained recreate; `/health` `relay-nominal` on :3002 **and** :13000) |
| Deploy | compose in `D:\claudish` + override (SearXNG URL), env file `D:\claudish\.env`; recreate = `claudish-drain.ps1 -ContainerName claudish-sidecar -Recreate -EnvFile D:\claudish\.env`. ⚠ that `.env` is now armed: never run `bun test` from `D:\claudish` (Bun auto-loads it) | VERIFIED 23/09 |
| Client `ANTHROPIC_BASE_URL` | `http://192.168.0.50:3000` (direct) — `settings.json`; profile template `settings.claudish.json` realigned 22:12Z | VERIFIED 07/09 22:12Z |
| Cascade | **ARMED 23/09** — SONNET `qwen-token-plan@deepseek-v4-flash-0731 > kc@k3 > ds@deepseek-flash`, `ROLE_MODELS=glm-5.2:sonnet` (clients name `glm-5.2` bare, which `roleFromModelName()` cannot map), `AUTO=1`; **3 armed by value**; startup `[Failover] configured=1 armed=[none] auto=on`. Each step measured to resolve **on ai-01** before the gesture (throwaway HUB container on `127.0.0.1:3999`, 3/3 `message_stop`, removed after) | VERIFIED 23/09 04:16Z |
| Role map | profile `default`: opus `claude-opus-5-5` (was `claude-opus-4-8`), sonnet `glm-5.2`, haiku `mmc@MiniMax-M3`; native pin read in-container: `claude-opus-5` and `claude-opus-4-8` → `claude-opus-5-5`, `claude-opus-5-5` and `glm-5.2` unchanged | VERIFIED 23/09 |
| customEndpoints | `vllm-myia` (key rotated 06/09, fp only), `qwen-token-plan` | VERIFIED (config.json) |
| Capture | on (outage trail) | VERIFIED |

## po-2026 — SIDECAR (bypassed by its own client)

| Item | Value | Status |
| --- | --- | --- |
| Sidecar | `claudish-proxy`, `0.0.0.0:3000`, healthy, image pre-#159 (`role` absent from `/health`) | VERIFIED 23/09 (docker inspect + `/health`) |
| Compose dir | **`C:\dev\claudish` — a second clone, not the dev tree `D:\Dev\claudish`**; the `.env` that governs the container lives there | VERIFIED 23/09 (container label `com.docker.compose.project.working_dir`) |
| Upstream | `CLAUDISH_RELAY_UPSTREAM=http://192.168.0.46:3000` (po-2023, the pre-migration hub) in **both** the compose `.env` (mtime 26/07) **and** the live container env — the runbook's "repointed `.46`→`.50` by hand on 2026-09-13" never landed on this machine | VERIFIED 23/09 (file read + `docker inspect` env) |
| Cascades | **0 armed by value** (`grep -cE 'CLAUDISH_FAILOVER_[A-Z0-9_]+=.+'` on container env = 0); `ROLE_MODELS` empty | VERIFIED 23/09 |
| Client | `ANTHROPIC_BASE_URL=http://192.168.0.50:3000` **direct to hub** (settings.json + live process env) — the sidecar serves zero streams; the stale upstream is latent, not load-bearing | VERIFIED 23/09 (process env + `activeStreams=0`) |
| Plan | repoint `.46`→`.50` at the next **planned drained recreate**, via `[PROPOSAL]` + single ACK (coordinator arbitration 22/09 23:36Z) — never as an isolated gesture on an unused container | DECLARED (coordinator dispatch) |

## Other machines

| Machine | State | Status |
| --- | --- | --- |
| po-2024 | nominal, traffic on new hub | DECLARED |
| po-2027 | traffic captured on new hub | DECLARED |

## Change log

| Date (Z) | Machine | Change | Proof |
| --- | --- | --- | --- |
| 2026-10-13 05:16 → 20:05 | po-2023 | **Two Docker engine deaths (attributed) — relay down 05:16→~17:25Z and 18:01→19:16Z.** Death 1: a **WSL upgrade** (System log: `WSL Service` startup flipped to disabled 05:23:09Z, VmSwitch teardown, **7045 install of `C:\Program Files\WSL\wslservice.exe` 05:24:01Z**) killed the WSL2 VM and the engine with it; return ~17:25Z by an external gesture (not the watchdog). Death 2: **user reboot** (User32 1074, 18:08:32Z, `StartMenuExperienceHost.exe`, "Autre (non planifié)") — host back 18:09Z, GVCIDrv (GIGABYTE) driver install 18:10Z is post-boot noise, not causal; watchdog relaunched the container **19:16:58Z**. Relay post-relaunch: 2 short AUTONOMOUS flaps (hub still warming) then **NOMINAL 20:05:00Z** (deep probe OK). Hub po-2025 lost its own engine in the same 18:0xZ window — attribution po-2025's, common cause unproven. F4 #320 closure window truncated at 05:31Z accordingly (see #320 c.6154208697) | System log 05:15-05:35Z + 19:55-20:10Z (7045/7040/1074/6005-6008 + VmSwitch); watchdog.log; relay docker log transitions; `docker inspect` Created unchanged |
| 2026-10-12 13:36 → 2026-10-13 03:37 | po-2023 | **RX96 key rotation (P3, 12/10 13:36:24Z drained recreate)** — env-only rotation on unchanged image `9e280fb3a939`; new cluster key fp `6302afdc` live (container env, compose `.env`, client `settings.json`, RSM `.env` sibling — hot-reloaded), old key fp `780f0142` kept hub-side in `CLAUDISH_PROXY_KEY_PREVIOUS` until rupture (**≤ 14/10 ~11:48Z**); cascades armed by value intact across the recreate. **13/10 01:01:06Z**: watchdog proactive restart (uptime 11.4 h, 0 streams cut); relay `→ AUTONOMOUS` 01:02:29→01:03:37Z (68 s) on the hub's same-window restart, recovered — 10/10's scheduling-coincidence class | `docker inspect` Created/StartedAt + env by value; `drain.log` `OUTCOME success`; watchdog.log 13/10 03:01 local; relay log transitions |
| 2026-10-10 15:55→21:34 | po-2023 | **client switched onto the relay (grain 4, deepqueue 10/10)** — relay first: drained detached recreate 15:55:17Z on image `9e280fb3a939` (main `84fc14b3`, carries the #416 keyless gate; keyless `glm-5.3` probe → **401**, keyed → **200**; `SEARXNG_URL` forwarder preserved via the #141 by-value diff — it lived only in the container). Then the client: `env.ANTHROPIC_BASE_URL` `192.168.0.50:3000` → `127.0.0.1:3000` (surgical 1-occurrence replace, rest byte-identical), `_intentional_diffs` aligned, Q-20261006-1 retired. First live confirmation of real CC turns transiting the relay by 21:34Z | `drain.log` `deployed image` + `OUTCOME success`; live `settings.json` re-read; relay `[ttft]` counts (22:31Z cron cycle) |
| 2026-10-09 07:20 | po-2023 | **path witness re-read, read-only — no gesture applied** (#291 grain 3): edge backend `192.168.0.50:3000` unchanged (mtime 04/10 21:24, sha `7ADE6AD6`), client `env` still hub-direct vs the relay-declaring `_intentional_diffs`, relay serves probes only | live web.config + `applicationHost.config` + `settings.json` + W3SVC49 log + `/health` probes on both relay and hub |
| 2026-10-09 15:08 | po-2023 | **same-day correction, read-only**: the 07:20Z reading understated the day — edge closed at **41× 502** (bursts 12:54Z, 13:05–13:08Z, 14:29–14:42Z) on real `/v1/messages` traffic, after a **hub restart at 13:07:28Z** (`instanceId` `082ebb60`→`5d09f9eb`). The relay-bypass is free on a quiet day and costs 41× 502 on a bad one | `/health` instanceId change + full-day W3SVC49 log |
| 2026-10-09 21:41 | po-2025 | **attribution** (answers ai-01's CR on #429): the two 502 bursts match **two deliberate drained hub restarts** — 12:55Z *coursia-pilot inbound key (config.json bind-mount reload)*, 13:07:29Z *coursia-pilot key rotation (exposure hygiene)*, both `OUTCOME success`, 6 in-flight streams cut on the second. The 41×502 measures the **price of a hub drain on a fallback-less path**, not an outage; the 14:29–14:42Z burst (4×502) stays **unattributed** | po-2025 `drain.log`, read 09/10 21:41Z (dashboard claudish) |
| 2026-10-08 10:09:58 local | po-2025 | `ClaudishDailyRestart` (04:00) **deleted** — user UAC batch v2, gesture G1; the user arbitrated "no daily restart". Last run 08/10 07:31 local → `OUTCOME success` | DECLARED by po-2025; absence re-confirmed 10:19:35 local. With po-2023's disabled since 05/09, **no daily restart remains on the fleet** |
| 2026-09-23 04:16 | ai-01 | drained recreate under po-2025's `[ACK]` (single-ACK rule), plan posted 04:12Z: image rebuilt from `61c3d2d`, opus map → `claude-opus-5-5`, sonnet cascade armed (3 steps) + `ROLE_MODELS=glm-5.2:sonnet`. Drain: 0 in flight | precondition 3/3 on a throwaway container; `/health` :3002 + :13000; real tool-call turn to `message_stop` with local capture count unchanged (NOMINAL); in-container pin; armed by value = 3 |
| 2026-09-23 | po-2026 | state audited on-boarding (no change applied): sidecar still on pre-migration upstream `.46` (file + container), 0 cascades armed, client bypasses it direct to `.50`; runbook's 13/09 repoint claim corrected — it never landed; compose dir is a second clone (`C:\dev\claudish`) | section above (all items VERIFIED 23/09) |
| 2026-09-07 23:12 | ai-01 | sidecar recreated: `CLAUDISH_RELAY_UPSTREAM` `.46` → `.50`. Double-hop removed. Under the user's fleet-wide rollout GO (07/09 ~22:10Z) | startup `[Relay] sidecar mode: upstream=http://192.168.0.50:3000` + `docker inspect` env + `/health` + egress `curl` **from inside the container** to `.50` |
| 2026-09-07 22:16 | ai-01 | sidecar auto-restarted by the Docker daemon coming back up — **kept the OLD `.46` env**: a start does not reload `.env`, only a recreate does | `docker inspect` env vs on-disk `.env` (2 h of divergence, 17 header-timeout local fallbacks in the window) |
| 2026-09-07 21:33 | ai-01 | Docker Desktop back up after the deliberate stop (CoursIA runners) — 47 containers with `StartedAt` inside 0.4 s = host/daemon event, not a targeted gesture | `docker inspect .State.StartedAt` across all containers |
| 2026-09-07 13:59 | po-2025 | incident repair: drained recreate with correct `--env-file`, cascades restored, OAuth file bind | startup line + `/health` (DECLARED, corroborated ai-01 14:05Z) |
| 2026-09-07 ~08:06 | po-2025 | restart (cause TBD — post-mortem pending) | uptime probe ai-01 |
