# Traffic analysis — full reference

**Deferred from `CLAUDE.md`.** The script table and the container/sidecar traps stay in `CLAUDE.md`; this file holds the capture format, attribution, and leak-diagnosis detail.

**Use the scripts, not hand-rolled grep.** The proxy log format has traps that produce false positives when grepped naively (see `proxy-log-monitoring` memory: `bytes=NNNN` matching error codes, timestamp digits matching `429`, `[msg:N]` body previews matching keywords). The scripts encode the precise filters.

## Pick the level

| Need | Script | Source | Speed |
|------|--------|--------|-------|
| **Live surveillance** (cron, quick health check) | `traffic-live.ps1` | `docker logs` stdout | fast |
| **Rich detail** (workspace, session, CC version, tokens) | `traffic-summary.ps1` / `traffic-sessions.ps1` | `req-*.json` captures | slower |
| **"Where's the Anthropic traffic from?"** (recurring leak question) | `traffic-anthropic.ps1` | `req-*.json` captures | slower |
| **History** (past days from compressed archives) | `traffic-history.ps1` | `captures-*.7z` | slow |

## Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `traffic-live.ps1` | **Live analysis from docker logs** — model/machine/handler distribution, precise error counts, never-hang check, Anthropic leak check, session-loop detection. This is what the 6h surveillance cron runs. **`-Container` defaults to `claudish-proxy` (the hub name) — on a sidecar machine you MUST pass `-Container claudish-sidecar`, otherwise the script exits 1 with `No such container`.** | `.\scripts\traffic-live.ps1 [-Hours N] [-Container name] [-AnthropicMachines 'host1,host2']` |
| `traffic-summary.ps1` | Overview from captures: machines, models, workspaces, sessions | `.\scripts\traffic-summary.ps1 [-Hours N]` |
| `traffic-sessions.ps1` | Detailed session list with timing, models, data volume | `.\scripts\traffic-sessions.ps1 [-Hours N] [-All]` |
| `traffic-anthropic.ps1` | **Answers "where does the Anthropic traffic come from?"** — attributes every Anthropic-native (opus/fable) request by **machine + workspace** (workspace = proof, from the system prompt; not stdout). Per-request verdict: `[OK]` ai-01 · `[REVIEW]` po-2025 · `[INFO]` fable during a `-FableOverrideActive` window · `[LEAK-SUBAGENT]` rogue Opus sub-agent (`cc_is_subagent=true`, **exit 1**) · `[REVIEW-INTERACTIVE]` user-driven non-ai-01 session (exit 0). sonnet-4-6 shown separately (remapped to glm → not Anthropic). | `.\scripts\traffic-anthropic.ps1 [-Hours N] [-FableOverrideActive]` |
| `traffic-history.ps1` | Historical analysis from 7z archives | `.\scripts\traffic-history.ps1 [-Date yyyy-MM-dd] [-Days N]` |
| `compress-captures.ps1` | Nightly 7z compaction + GDrive backup + 30d local purge (scheduled task) | Runs automatically at 04:17 |
| `claudish-watchdog.ps1` | Proxy health: tool-call stream test + proactive restart (uptime >11h) + auto-recovery on hang. Scheduled every 15min. | Runs automatically |
| `CaptureUtils.psm1` | Shared module (capture parsing, device mapping, 7z extraction) | Imported by the scripts above |

## Quick commands

```powershell
# Live health check — what's happening right now?
.\scripts\traffic-live.ps1 -Hours 1

# Standard 6h surveillance window (cron default)
.\scripts\traffic-live.ps1 -Hours 6

# On a SIDECAR machine (ai-01, po-2024...) the container is not named claudish-proxy.
# Expect ~0 requests when the sidecar is NOMINAL: a relayed request writes no capture
# and emits no [Request] line, so local traffic analysis is blind by construction.
.\scripts\traffic-live.ps1 -Hours 3 -Container claudish-sidecar

# Rich detail: which workspace/session is active?
.\scripts\traffic-summary.ps1 -Hours 2
.\scripts\traffic-sessions.ps1

# Historical analysis from compressed archives
.\scripts\traffic-history.ps1 -Days 7
```

## Capture format

- **`req-*.json`** — Single-line JSON with full Anthropic request body (messages, system, tools, metadata). Extractable: machine (X-Claudish-Machine header), workspace (from system prompt), session_id (from metadata.user_id), CC version (from billing header). Written to `/captures` inside the container, bind-mounted to `D:\claudish-captures` (persists across container recreates).
- **`resp-*.sse`** — Response SSE with metadata header (elapsed_ms, stop_reason, event count). Correlates with req via shared counter (req-1-0042 → resp-1-r0042).
- **Archives** — `D:\claudish-captures\archive\captures-YYYY-MM-DD.7z` (LZMA2, ~100-130:1 ratio), mirrored to `G:\Mon Drive\MyIA\backups\claudish-captures\` via Google Drive Desktop (plain Windows file copy, no API). Local purge >30 days (only after confirming the GDrive copy).
- **Heavy analysis is host-saturating — schedule it.** Decompressing a weeks-old 7z and parsing 100k+ `req-*.json` pegs the hub host and produces the HUB-LENT signature (event-loop stall, gateway latency still clean) for minutes at a time. Measured: same signature as a crisis wave, yet with streams ≈ 1 it costs nobody anything. Rule: heavy capture analysis runs in the **05-07Z trough**, extracts to **D: never C:**, and is *expected + attributed* there — not a crisis.

## Machine attribution

Machines are identified by the `X-Claudish-Machine` header (set via `ANTHROPIC_CUSTOM_HEADERS` in Claude Code settings). When missing, `CaptureUtils.psm1` falls back to device_id fingerprinting. Known device IDs are hardcoded in the module's `$DeviceMap` (currently partial — po-2023 + ai-01 only; update when new machines are seen without the header).

## Anthropic leak diagnostics

By cluster policy, **Anthropic-billed models (Opus, Fable, Sonnet) must come from `myia-ai-01` only**.

**For the recurring "where is the Anthropic traffic coming from (machine + workspace)?" question, use `traffic-anthropic.ps1`** — it attributes each Anthropic-native request to its machine AND workspace (the workspace is the proof, read from the system prompt in the capture, not stdout), and — crucially — it splits a non-ai-01 hit into `[LEAK-SUBAGENT]` (a rogue Opus sub-agent, `cc_is_subagent=true`, the dangerous kind → exit 1) vs `[REVIEW-INTERACTIVE]` (a user driving their own interactive session on their own machine → exit 0, not alarmed). That split is what stops the tool from crying wolf on legitimate dev sessions.

`traffic-live.ps1` gives the faster stdout-only pass and flags Anthropic traffic from other machines automatically:

- **[OK]** — authorized machine (`-AnthropicMachines`, default `myia-ai-01`).
- **[REVIEW]** — `myia-po-2025`: may run an authorized Safari workflow (agent-sdk / VS Code) under Anthropic. **Do not auto-flag as leak** — confirm with the user first (lesson 2026-06-21: 6 false WARNs raised on po-2025 before learning Safari was authorized).
- **[LEAK]** — any other machine on Anthropic. Investigate.

**Sub-agent leaks vs legitimate sessions** — the distinction that matters:
- **Real sub-agent leak** = requests carry `cc_is_subagent=true` (in the billing header, *not* on the stdout `[Request]` line) + Anthropic model + non-authorized machine. The Agent tool spawns sub-agents that default to "best available" = Opus.
- **Legitimate Anthropic session** = `agent-sdk/X` + entrypoint `claude-vscode` + same source IP across requests + `msgs=60+` (large context = main session, not sub-agent). No `cc_is_subagent`.

`cc_is_subagent` lives in the request body, not stdout — so it's not visible via `docker logs` alone. To confirm a sub-agent leak, inspect a capture:
```bash
# Find the billing header in a suspect capture
docker exec claudish-proxy sh -c "head -c 500 /captures/req-1-NNNN-*.json"
# Look for: cc_is_subagent=true  → sub-agent. Absent → main session (not a leak).
```

**Fix for a confirmed leak:** add a global rule in `~/.claude/rules/` instructing the model to always specify `model: "sonnet"` (or equivalent) when spawning sub-agents, reserving Opus for genuinely complex tasks. This is client-side behavior — not fixable in the proxy.
