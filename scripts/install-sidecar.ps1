<#
.SYNOPSIS
  Idempotently installs (or updates) a claudish relay sidecar on this machine.

.DESCRIPTION
  One binary, three modes (see CLAUDE.md "Relay / Sidecar Mode"): a machine with
  CLAUDISH_RELAY_UPSTREAM set relays to the hub in NOMINAL mode and falls back to
  the local pipeline (AUTONOMOUS) when the hub dies. This script stands up that
  sidecar: clones/pulls the fork, writes the per-machine .env, builds+starts the
  container, and probes it end-to-end.

  Run this ON the target sidecar machine (all cluster machines except po-2023 the
  hub, and except web1 which stays on models.myia.io directly). It does NOT touch
  any other machine.

  After it succeeds, repoint THIS machine's Claude Code to its local sidecar:
    ANTHROPIC_BASE_URL = http://localhost:3000
  (keep the existing x-proxy-key custom header + X-Claudish-Machine).

.PARAMETER Machine
  Machine name for attribution (e.g. myia-po-2024). Required.

.PARAMETER Upstream
  Hub URL. LAN machines: http://192.168.0.46:3000. WAN externals: https://models.myia.io.

.PARAMETER ProxyKey
  The cluster proxy gate key (shared across the cluster). NOT hardcoded; pass it
  explicitly or export CLAUDISH_PROXY_KEY in the environment.

.PARAMETER Compress
  Set CLAUDISH_RELAY_COMPRESS=1 (WAN externals only: po-2025).

.PARAMETER NoAnthropic
  Set CLAUDISH_NO_ANTHROPIC=1 (every machine except ai-01 — leak-policy backstop).

.PARAMETER HostPort
  Host port published by the container. Default 3000. Set this when 3000 is already
  taken on the target machine (e.g. ai-01, where another service holds 3000) — the
  container side always stays 3000, only the host binding moves.

.PARAMETER ContainerName
  Docker container name. Default claudish-proxy. Give a sidecar its own name
  (e.g. claudish-sidecar) so logs/scripts never confuse it with the hub container.

.PARAMETER NoCapture
  Disable capture writing entirely (sets CLAUDISH_CAPTURE_DIR empty). Escape hatch
  for disk-starved hosts ONLY. By default a sidecar KEEPS capture on: NOMINAL relay
  writes nothing, so any loose capture file is by construction an AUTONOMOUS-mode
  outage capture — the trail reconcile-outage-captures.ps1 needs.

.PARAMETER RepoDir
  Where the fork lives / will be cloned. Default C:\Dev\claudish. Pass explicitly if
  the machine already has a clone elsewhere, otherwise a second one is created.
  NB: an existing clone is hard-reset to origin/main — commit local work first.

.PARAMETER ConfigDir
  Host dir mounted as /root/.claudish (must contain config.json with provider keys).
  Default %USERPROFILE%\.claudish.

.PARAMETER CapturesDir
  Host dir mounted as /captures. Default D:\claudish-captures.

.EXAMPLE
  # ai-01 (LAN, Anthropic authority — NO NoAnthropic)
  .\install-sidecar.ps1 -Machine myia-ai-01 -Upstream http://192.168.0.46:3000 -ProxyKey b28622...

  # po-2025 (WAN external — Compress + NoAnthropic)
  .\install-sidecar.ps1 -Machine myia-po-2025 -Upstream https://models.myia.io -ProxyKey b28622... -Compress -NoAnthropic
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Machine,
    [Parameter(Mandatory)][string]$Upstream,
    [Parameter(Mandatory)][string]$ProxyKey,
    [switch]$Compress,
    [switch]$NoAnthropic,
    [switch]$NoCapture,
    [int]$HostPort     = 3000,
    [string]$ContainerName = "claudish-proxy",
    [string]$RepoUrl   = "https://github.com/jsboige/claudish.git",
    [string]$RepoDir   = "C:\Dev\claudish",
    [string]$ConfigDir = (Join-Path $env:USERPROFILE ".claudish"),
    [string]$CapturesDir = "D:\claudish-captures"
)

$ErrorActionPreference = "Stop"
$ProxyPort = $HostPort
$ClusterKey = $ProxyKey  # alias for readability

function Write-Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Die($msg)        { Write-Host "   XX  $msg" -ForegroundColor Red; exit 1 }

# ── 1. Repo: clone or pull ──────────────────────────────────────────
Write-Step "Repo → $RepoDir"
if (Test-Path (Join-Path $RepoDir ".git")) {
    Write-Ok "exists, pulling latest main"
    git -C $RepoDir fetch origin main --quiet
    git -C $RepoDir checkout main --quiet 2>$null
    git -C $RepoDir reset --hard origin/main --quiet
    if ($LASTEXITCODE -ne 0) { Die "git pull failed in $RepoDir" }
} else {
    Write-Ok "not found, cloning $RepoUrl"
    New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
    git clone --branch main --depth 1 $RepoUrl $RepoDir 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "git clone failed" }
}

# ── 2. Host dirs ────────────────────────────────────────────────────
Write-Step "Host dirs"
if (-not (Test-Path $ConfigDir)) {
    Die "ConfigDir $ConfigDir missing and holds no config.json. Copy a provider-keyed config.json (see the hub's ~/.claudish/config.json) before re-running."
}
if (-not (Test-Path (Join-Path $ConfigDir "config.json"))) {
    Die "No config.json in $ConfigDir — the sidecar needs provider keys (ZAI/GLM_CODING/MINIMAX_CODING). Copy one before re-running."
}
Write-Ok "config.json present in $ConfigDir"
if (-not (Test-Path $CapturesDir)) {
    Write-Warn "CapturesDir $CapturesDir missing — creating it"
    New-Item -ItemType Directory -Force -Path $CapturesDir | Out-Null
} else {
    Write-Ok "captures dir $CapturesDir"
}

# ── 3. Per-machine .env ─────────────────────────────────────────────
Write-Step "Writing .env (machine=$Machine  upstream=$Upstream)"
$lines = @(
    "# Generated by install-sidecar.ps1 for $Machine",
    "CLAUDISH_PROXY_KEY=$ClusterKey",
    "CLAUDISH_RELAY_UPSTREAM=$Upstream"
)
if ($Compress)    { $lines += "CLAUDISH_RELAY_COMPRESS=1" }
if ($NoAnthropic) { $lines += "CLAUDISH_NO_ANTHROPIC=1" }
$lines += "CLAUDISH_CONFIG_DIR=$ConfigDir"
$lines += "CLAUDISH_CAPTURE_HOST_DIR=$CapturesDir"
$lines += "CLAUDISH_HOST_PORT=$HostPort"
$lines += "CLAUDISH_CONTAINER_NAME=$ContainerName"
# Set-but-empty disables capture writing (compose uses ${CLAUDISH_CAPTURE_DIR-/captures},
# single-dash = "unset" only, so an empty value here really means "write nothing").
if ($NoCapture)   { $lines += "CLAUDISH_CAPTURE_DIR=" }
$envContent = ($lines -join "`r`n") + "`r`n"
# UTF-8 no BOM (PS 5.1 Set-Content adds BOM → breaks parsers).
[void][System.IO.File]::WriteAllText((Join-Path $RepoDir ".env"), $envContent, (New-Object System.Text.UTF8Encoding $false))
$tag = @($Machine, $Upstream, "port=$HostPort", "container=$ContainerName")
if ($Compress)    { $tag += "COMPRESS" }
if ($NoAnthropic) { $tag += "NO_ANTHROPIC" }
if ($NoCapture)   { $tag += "NO_CAPTURE" }
Write-Ok ".env written: $($tag -join ' | ')"

# ── 4. Build + start ────────────────────────────────────────────────
Write-Step "docker compose up -d --build"
Push-Location $RepoDir
try {
    docker compose up -d --build 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "docker compose up failed" }
} finally { Pop-Location }

# ── 5. Healthcheck ──────────────────────────────────────────────────
Write-Step "Waiting for /health on :$ProxyPort"
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest "http://localhost:$ProxyPort/health" -TimeoutSec 3 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) { Die "container did not become healthy on :$ProxyPort (check 'docker logs $ContainerName')" }
Write-Ok "healthy"

# ── 6. End-to-end probe (NOMINAL relay → hub → provider) ────────────
Write-Step "End-to-end tool-call probe (glm-5.2 via sidecar)"
$body = @{
    model = "glm-5.2"; max_tokens = 100; stream = $true
    tools = @(
        @{ name = "Bash"; description = "Run a shell command"
           input_schema = @{ type = "object"; properties = @{ command = @{ type = "string" } }; required = @("command") } }
    )
    messages = @(@{ role = "user"; content = "Reply with the single word OK." })
} | ConvertTo-Json -Depth 10
try {
    $r = Invoke-WebRequest "http://localhost:$ProxyPort/v1/messages" -Method POST `
        -ContentType "application/json" -Headers @{ "x-proxy-key" = $ClusterKey; "X-Claudish-Machine" = $Machine } `
        -Body $body -TimeoutSec 60 -UseBasicParsing
    if ($r.Content -match "message_stop") {
        Write-Ok "stream completed with terminal message_stop (NOMINAL relay works)"
    } else {
        Write-Warn "probe returned $($r.Content.Length) bytes but no message_stop — inspect 'docker logs $ContainerName'"
    }
} catch {
    Write-Warn "probe failed: $($_.Exception.Message) — if the hub is reachable this needs investigation"
}

# ── 7. Repoint instruction ──────────────────────────────────────────
Write-Host ""
Write-Host "SIDECAR INSTALLED for $Machine" -ForegroundColor Green
Write-Host "  mode         : NOMINAL relay → $Upstream (autonomous on hub outage)" -ForegroundColor White
Write-Host "  container    : $ContainerName on :$ProxyPort" -ForegroundColor White
Write-Host ""
Write-Host "  Now repoint THIS machine's Claude Code (~/.claude/settings.json):" -ForegroundColor White
Write-Host "    ANTHROPIC_BASE_URL = http://localhost:$ProxyPort" -ForegroundColor White
Write-Host "  keep the existing custom header (machine name already correct):" -ForegroundColor White
# NEVER interpolate $ClusterKey into console output: this block is routinely
# captured into terminal transcripts, CI logs and agent context, which would leak
# the cluster gate key to every reader of those artifacts.
Write-Host "    ANTHROPIC_CUSTOM_HEADERS = `"X-Claudish-Machine: $Machine\nx-proxy-key: <cluster key, unchanged>`"" -ForegroundColor White
Write-Host "  (the machine already carries the key — leave that header exactly as it is)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Verify relay mode in logs:  docker logs $ContainerName 2>&1 | Select-String 'Relay|NOMINAL|upstream'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  NOTE — the glm-5.2 probe above does NOT validate the native (Opus) path:" -ForegroundColor DarkGray
Write-Host "  it is the traffic class the relay header bug spared. On ai-01 (the only" -ForegroundColor DarkGray
Write-Host "  Anthropic-native machine) the real acceptance is a live Opus turn from" -ForegroundColor DarkGray
Write-Host "  Claude Code after the repoint — an HTTP probe cannot carry the OAuth." -ForegroundColor DarkGray
