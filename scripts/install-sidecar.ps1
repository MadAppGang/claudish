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

.PARAMETER Force
  Allow the hard-reset of an existing clone that has uncommitted changes or unpushed
  commits. Without it the script refuses and tells you what it would have destroyed.

.PARAMETER RebuildEnvFromContainer
  #141: rebuild <RepoDir>/.env from the LIVE container's env record (docker
  inspect), then exit — no pull, no compose, container untouched. Use this on a
  machine whose armed CLAUDISH_FAILOVER_* exist only in the container (they were
  added by hand after install; the installer never wrote them, so any recreate
  would wipe them). Merge semantics: container values win for overlapping vars,
  file-only lines are kept. The output contains CLAUDISH_PROXY_KEY: local file
  only, never committed, never displayed.

.PARAMETER WriteEnvOnly
  Write/refresh the .env (preserving any runtime-policy block, see #141) and
  exit — no compose up, container untouched. Deploy seam: lets an operator (or a
  test) exercise the preserve/guard path without recreating anything.

.PARAMETER RepoDir
  Where the fork lives / will be cloned. Default C:\Dev\claudish. Pass explicitly if
  the machine already has a clone elsewhere, otherwise a second one is created.
  NB: an existing clone is hard-reset to origin/main — the script now refuses when
  that would destroy uncommitted work or unpushed commits (override with -Force).

.PARAMETER ConfigDir
  Host dir mounted as /root/.claudish (must contain config.json with provider keys).
  Default %USERPROFILE%\.claudish.

.PARAMETER CapturesDir
  Host dir mounted as /captures. Default D:\claudish-captures.

.EXAMPLE
  # ai-01 (LAN, Anthropic authority — NO NoAnthropic)
  .\install-sidecar.ps1 -Machine myia-ai-01 -Upstream http://192.168.0.46:3000 -ProxyKey '<CLUSTER_KEY>'

  # po-2025 (WAN external — Compress + NoAnthropic)
  .\install-sidecar.ps1 -Machine myia-po-2025 -Upstream https://models.myia.io -ProxyKey '<CLUSTER_KEY>' -Compress -NoAnthropic
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Machine,
    [Parameter(Mandatory)][string]$Upstream,
    [Parameter(Mandatory)][string]$ProxyKey,
    [switch]$Compress,
    [switch]$NoAnthropic,
    [switch]$NoCapture,
    [switch]$Force,
    [switch]$RebuildEnvFromContainer,
    [switch]$WriteEnvOnly,
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

# ── .env runtime-policy preservation (#141) ─────────────────────────
# docker-compose.yml interpolates runtime-policy vars this script never writes:
# CLAUDISH_FAILOVER_*, CLAUDISH_QWEN_THINKING, CLAUDISH_GLM_THINKING, SEARXNG_URL,
# and set-but-empty CLAUDISH_CAPTURE_DIR (= capture disabled). Before #141 a rerun
# rewrote .env wholesale and silently dropped them, so an armed cascade lived only
# in the container's Docker env record — and the very `compose up` this script
# runs wiped it (measured on ai-01 18/09: 6 vars in the file, 23 armed
# CLAUDISH_FAILOVER_* in the live container; the 07/09 hub incident requalified
# as default tool behavior, not operator error).
$PreservedEnvPattern = '^(CLAUDISH_FAILOVER_[A-Z0-9_]+|CLAUDISH_QWEN_THINKING|CLAUDISH_GLM_THINKING|SEARXNG_URL)='

function Get-ClaudishContainerEnv {
    # CLAUDISH_*/SEARXNG_URL lines from the live container's env record, or $null
    # when docker cannot answer (no such container, docker down). Callers fail
    # OPEN on $null: the guard protects an existing armed state, it must never
    # block a fresh install. NB: stderr is redirected while $ErrorActionPreference
    # is Stop, which arms PS 5.1's NativeCommandError trap — lowered around the call.
    param([string]$Container)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Container 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
    } finally { $ErrorActionPreference = $prev }
    return @($raw | Where-Object { $_ -match '^(CLAUDISH_[A-Z0-9_]+|SEARXNG_URL)=' })
}

function Get-ArmedCascadeCount {
    # Non-empty CLAUDISH_FAILOVER_* assignments — the armed state that must
    # survive a recreate. (Empty assignments are inert: compose's `:-` default.)
    param([string[]]$EnvLines)
    if (-not $EnvLines) { return 0 }
    return @($EnvLines | Where-Object { $_ -match '^CLAUDISH_FAILOVER_[A-Z0-9_]+=.+' }).Count
}

function Test-RecreateWouldGutCascades {
    # #141 point 3: true when the env content about to be written carries no
    # armed cascade while the live container has one. Refusing loudly here is
    # the only point that protects an operator who never reads the issue.
    param([string[]]$NewEnvLines, [string]$Container)
    if ((Get-ArmedCascadeCount $NewEnvLines) -gt 0) { return $false }
    $containerEnv = Get-ClaudishContainerEnv $Container
    if ($null -eq $containerEnv) { return $false }
    return (Get-ArmedCascadeCount $containerEnv) -gt 0
}

# ── 0. -RebuildEnvFromContainer: recover armed state, exit (#141 point 2) ──
if ($RebuildEnvFromContainer) {
    Write-Step "Rebuilding .env from live container '$ContainerName' (no pull, no compose, container untouched)"
    $envPath = Join-Path $RepoDir ".env"
    $existingLines = @()
    if (Test-Path -LiteralPath $envPath) { $existingLines = [System.IO.File]::ReadAllLines($envPath) }

    $containerEnv = Get-ClaudishContainerEnv $ContainerName
    if ($null -eq $containerEnv) {
        Die "cannot docker inspect '$ContainerName' (not running? docker down?) — nothing written, nothing lost"
    }

    $fileMap = [ordered]@{}
    foreach ($l in $existingLines) { if ($l -match '^([A-Z0-9_]+)=(.*)$') { $fileMap[$Matches[1]] = $Matches[2] } }
    $contMap = [ordered]@{}
    foreach ($l in $containerEnv) { if ($l -match '^([A-Z0-9_]+)=(.*)$') { $contMap[$Matches[1]] = $Matches[2] } }

    # Merge: container wins for non-empty values. CLAUDISH_CAPTURE_DIR carries
    # meaning even empty (set-but-empty = capture disabled — compose's single-dash
    # `${VAR-/captures}` default skips only UNSET, so the empty assignment must
    # survive or a rebuild would silently re-enable capture).
    $merged = [ordered]@{}
    foreach ($k in $fileMap.Keys) { $merged[$k] = $fileMap[$k] }
    foreach ($k in $contMap.Keys) {
        if ($contMap[$k] -ne '' -or $k -eq 'CLAUDISH_CAPTURE_DIR') { $merged[$k] = $contMap[$k] }
    }

    # Stable order: installer base vars first, then everything else sorted.
    $baseOrder = @('CLAUDISH_PROXY_KEY','CLAUDISH_RELAY_UPSTREAM','CLAUDISH_RELAY_COMPRESS','CLAUDISH_NO_ANTHROPIC',
                   'CLAUDISH_CONFIG_DIR','CLAUDISH_CAPTURE_HOST_DIR','CLAUDISH_HOST_PORT','CLAUDISH_CONTAINER_NAME','CLAUDISH_CAPTURE_DIR')
    $out = [System.Collections.Generic.List[string]]::new()
    $out.Add("# Rebuilt from live container '$ContainerName' by install-sidecar.ps1 -RebuildEnvFromContainer for $Machine")
    $out.Add("# Container values won over file values for overlapping vars; file-only lines kept (#141).")
    $seen = @{}
    foreach ($k in $baseOrder) { if ($merged.Contains($k)) { $out.Add("$k=$($merged[$k])"); $seen[$k] = $true } }
    foreach ($k in @($merged.Keys | Sort-Object)) { if (-not $seen.ContainsKey($k)) { $out.Add("$k=$($merged[$k])") } }

    # Diff report — NAMES only, never values (a partially-filled env file masks
    # the defect: 16 lines look recreatable, only the 7 missing ones refute it).
    $armedNames = @($contMap.Keys | Where-Object { $_ -match '^CLAUDISH_FAILOVER_' -and $contMap[$_] -ne '' })
    $wasMissing = @($armedNames | Where-Object { -not $fileMap.Contains($_) -or $fileMap[$_] -eq '' })

    $dir = Split-Path $envPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [void][System.IO.File]::WriteAllText($envPath, ($out -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding $false))

    # Read-back verification: the written file must reproduce every armed cascade.
    $backMap = @{}
    foreach ($l in [System.IO.File]::ReadAllLines($envPath)) { if ($l -match '^([A-Z0-9_]+)=(.*)$') { $backMap[$Matches[1]] = $Matches[2] } }
    $stillMissing = @($armedNames | Where-Object { -not $backMap.ContainsKey($_) -or $backMap[$_] -eq '' })

    Write-Ok ".env rebuilt: $($armedNames.Count) armed CLAUDISH_FAILOVER_* var(s) recovered from the container, $($wasMissing.Count) were missing from the previous file"
    if ($wasMissing.Count -gt 0) { Write-Host "     recovered: $($wasMissing -join ', ')" -ForegroundColor DarkGray }
    if (-not $backMap.ContainsKey('CLAUDISH_PROXY_KEY')) { Write-Warn "CLAUDISH_PROXY_KEY absent from rebuilt file" }
    if ($backMap.ContainsKey('CLAUDISH_CAPTURE_DIR') -and $backMap['CLAUDISH_CAPTURE_DIR'] -eq '') {
        Write-Warn "capture DISABLED (carried from container) — the outage-capture trail stays off; remove the CLAUDISH_CAPTURE_DIR= line from $envPath to re-enable"
    }
    if ($stillMissing.Count -gt 0) { Die "read-back failed — still missing after write: $($stillMissing -join ', ')" }
    Write-Ok "read-back verified — the file reproduces the container's armed cascades"
    Write-Host ""
    Write-Host "ENV REBUILT for $Machine — container untouched; the next compose up/recreate interpolates from this file" -ForegroundColor Green
    exit 0
}

# ── 1. Repo: clone or pull ──────────────────────────────────────────
Write-Step "Repo → $RepoDir"
if (Test-Path (Join-Path $RepoDir ".git")) {
    Write-Ok "exists, pulling latest main"
    # `reset --hard` below is a deletion, and a deletion must prove what it destroys.
    # The default RepoDir is a REAL checkout on several machines (po-2024's clone;
    # ai-01's D:\Dev\claudish, from which a sidecar is actually running), so a run
    # with the default path would silently discard whatever local work sits there.
    $dirty = @(git -C $RepoDir status --porcelain)
    if ($dirty.Count -gt 0 -and -not $Force) {
        Write-Host ($dirty | Select-Object -First 10 | Out-String) -ForegroundColor Yellow
        Die "$RepoDir has $($dirty.Count) uncommitted change(s) that 'reset --hard' would destroy. Commit/stash them, point -RepoDir at a fresh path, or pass -Force to discard them deliberately."
    }
    $ahead = @(git -C $RepoDir log --oneline "origin/main..HEAD" 2>$null)
    if ($ahead.Count -gt 0 -and -not $Force) {
        Write-Host ($ahead | Out-String) -ForegroundColor Yellow
        Die "$RepoDir holds $($ahead.Count) commit(s) not on origin/main and would lose them. Push them, point -RepoDir at a fresh path, or pass -Force."
    }
    if ($Force -and ($dirty.Count -gt 0 -or $ahead.Count -gt 0)) {
        Write-Warn "-Force: discarding $($dirty.Count) local change(s) and $($ahead.Count) unpushed commit(s) in $RepoDir"
    }
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
$envPath = Join-Path $RepoDir ".env"
# #141 point 1: carry over runtime-policy lines from the existing file — the
# rewrite below must never clobber an armed cascade, a thinking-policy override,
# a custom SEARXNG_URL, or a set-but-empty CLAUDISH_CAPTURE_DIR (capture disabled).
$preserved = @()
if (Test-Path -LiteralPath $envPath) {
    $preserved = @([System.IO.File]::ReadAllLines($envPath) |
        Where-Object { $_ -match $PreservedEnvPattern -or $_ -eq 'CLAUDISH_CAPTURE_DIR=' })
}
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

# Dedupe: a base line generated above wins over the same var in $preserved
# (only CLAUDISH_CAPTURE_DIR can collide — the installer never emits the others).
$baseNames = @{}
foreach ($l in $lines) { if ($l -match '^([A-Z0-9_]+)=') { $baseNames[$Matches[1]] = $true } }
$preserved = @($preserved | Where-Object { $_ -match '^([A-Z0-9_]+)=' -and -not $baseNames.ContainsKey($Matches[1]) })
if ($preserved.Count -gt 0) {
    $lines += "# --- runtime-policy lines preserved from previous .env (#141: never clobber an armed state) ---"
    $lines += $preserved
}

# #141 point 3 — the guard, BEFORE writing anything: step 4 below recreates the
# container, and if what we are about to write carries no armed cascade while the
# live container has one, that recreate would wipe an armed state that exists
# nowhere else on disk. Die here so the old file stays intact.
if (Test-RecreateWouldGutCascades -NewEnvLines $lines -Container $ContainerName) {
    Die @"
REFUSED (#141): this recreate would wipe the armed cascades. The .env about to be
written carries no CLAUDISH_FAILOVER_* while container '$ContainerName' has an armed
cascade that exists only in its Docker env record (the install tool never wrote it).
Recover it into the file first, then re-run:
  .\install-sidecar.ps1 -RebuildEnvFromContainer -Machine $Machine -Upstream $Upstream -ProxyKey <key> -ContainerName $ContainerName -RepoDir $RepoDir
Nothing was written; the container was not touched.
"@
}

$envContent = ($lines -join "`r`n") + "`r`n"
# UTF-8 no BOM (PS 5.1 Set-Content adds BOM → breaks parsers).
[void][System.IO.File]::WriteAllText($envPath, $envContent, (New-Object System.Text.UTF8Encoding $false))
$tag = @($Machine, $Upstream, "port=$HostPort", "container=$ContainerName")
if ($Compress)    { $tag += "COMPRESS" }
if ($NoAnthropic) { $tag += "NO_ANTHROPIC" }
if ($NoCapture)   { $tag += "NO_CAPTURE" }
if ($preserved.Count -gt 0) {
    $failoverKept = @($preserved | Where-Object { $_ -match '^CLAUDISH_FAILOVER_' }).Count
    $tag += "preserved=$($preserved.Count) line(s) ($failoverKept CLAUDISH_FAILOVER_*)"
}
# The ONLY preserved state that destroys something (#144 review follow-up):
# a set-but-empty CLAUDISH_CAPTURE_DIR keeps capture DISABLED across a rerun
# that did NOT ask for it — name it loudly instead of leaving it deducible
# from the preserved-line count. (Under -NoCapture the installer generates its
# own line, so $preserved no longer holds it and this stays silent.)
if ($preserved -contains 'CLAUDISH_CAPTURE_DIR=') {
    Write-Warn "capture DISABLED (preserved from previous .env) — the outage-capture trail stays off though this run did not pass -NoCapture; remove the CLAUDISH_CAPTURE_DIR= line from $envPath to re-enable"
}
Write-Ok ".env written: $($tag -join ' | ')"

if ($WriteEnvOnly) {
    Write-Host ""
    Write-Host "ENV WRITTEN for $Machine (-WriteEnvOnly: no compose, container untouched)" -ForegroundColor Green
    exit 0
}

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

# ── 6. End-to-end tool-call probe + MODE assertion ──────────────────
# A 200 with message_stop proves the sidecar answers — it does NOT prove it
# relayed: in AUTONOMOUS mode the local pipeline answers just as well, which is
# precisely how a sidecar that cannot reach the hub looks healthy while silently
# bypassing it (observed on ai-01, 2026-08-10: Docker had no route to the LAN
# hub). So assert the mode from the logs: in NOMINAL the relay branch sits BEFORE
# logRequest, so a relayed request emits NO "[Request]" line; a local one always does.
$body = @{
    model = "glm-5.2"; max_tokens = 100; stream = $true
    tools = @(
        @{ name = "Bash"; description = "Run a shell command"
           input_schema = @{ type = "object"; properties = @{ command = @{ type = "string" } }; required = @("command") } }
    )
    messages = @(@{ role = "user"; content = "Reply with the single word OK." })
} | ConvertTo-Json -Depth 10
$hdr = @{ "x-proxy-key" = $ClusterKey; "X-Claudish-Machine" = $Machine }
function Invoke-Probe { Invoke-WebRequest "http://localhost:$ProxyPort/v1/messages" -Method POST `
        -ContentType "application/json" -Headers $hdr -Body $body -TimeoutSec 60 -UseBasicParsing }

# Warm-up: the forward bounds its HEADER phase (5s). A cold DNS+TLS handshake to a
# WAN upstream can exceed that, so the very first request may legitimately fall
# through to local. Don't judge the mode on it.
Write-Step "End-to-end tool-call probe (glm-5.2 via sidecar) — warm-up"
try { [void](Invoke-Probe) ; Write-Ok "warm-up answered" } catch { Write-Warn "warm-up failed: $($_.Exception.Message)" }

Write-Step "Asserting relay mode (NOMINAL vs AUTONOMOUS)"
try {
    $r = Invoke-Probe
    if ($r.Content -match "message_stop") {
        Write-Ok "stream completed with terminal message_stop"
    } else {
        Write-Warn "probe returned $($r.Content.Length) bytes but no message_stop — inspect 'docker logs $ContainerName'"
    }
    $servedLocally = (docker logs --since 90s $ContainerName 2>&1 | Select-String -SimpleMatch "[Request]")
    if ($servedLocally) {
        Write-Warn "served LOCALLY → the sidecar is AUTONOMOUS: it cannot reach $Upstream."
        Write-Warn "  Check egress FROM THE CONTAINER, not from the host — they differ:"
        Write-Warn "    docker exec $ContainerName wget -qO- --timeout=5 $Upstream/health"
        Write-Warn "  Docker on Windows often has no route to a LAN IP while the host does."
        Write-Warn "  In that case use the WAN endpoint as upstream: -Upstream https://models.myia.io"
    } else {
        Write-Ok "no local [Request] line → request was RELAYED to $Upstream (NOMINAL)"
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
