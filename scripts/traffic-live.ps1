#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Live traffic analysis from claudish-proxy docker logs.

.DESCRIPTION
  Standardized analysis of `docker logs claudish-proxy --since Nh`. This is the
  FAST path for surveillance (the 6h cron): it reads stdout logs directly,
  avoiding the cost of parsing thousands of req-*.json captures.

  Use this script instead of hand-rolled grep commands — it encodes the
  precise filters that avoid the false-positive traps documented in
  proxy-log-monitoring (bytes=NNNN matching error codes, timestamp digits
  matching 429, [msg:N] previews matching keywords).

  For richer detail (workspace, session_id, CC version, token usage) use
  traffic-summary.ps1 / traffic-sessions.ps1 against the capture files.
  For historical analysis use traffic-history.ps1 against the 7z archives.

.PARAMETER Hours
  Look-back window in hours (default: 6, matches the surveillance cron).

.PARAMETER Container
  Docker container name (default: claudish-proxy).

.PARAMETER AnthropicMachines
  Comma-separated machine names authorized for Anthropic models
  (Opus/Fable/Sonnet). Requests from other machines are flagged for review.
  Default: 'myia-ai-01'. (po-2025 may run an authorized Safari workflow —
  review, do not auto-flag.)

.EXAMPLE
  .\scripts\traffic-live.ps1
  .\scripts\traffic-live.ps1 -Hours 1
  .\scripts\traffic-live.ps1 -Hours 24 -AnthropicMachines 'myia-ai-01,myia-po-2025'
#>
[CmdletBinding()]
param(
    [int]$Hours = 6,
    [string]$Container = 'claudish-proxy',
    [string]$AnthropicMachines = 'myia-ai-01'
)

$ErrorActionPreference = 'Stop'

# --- gather logs -------------------------------------------------------------
# --timestamps prepends ISO8601 to each line → enables temporal analysis
# (e.g. detecting whether an anomaly is recent vs residual).
$raw = docker logs --timestamps --since "${Hours}h" $Container 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: cannot read docker logs from '$Container' (is the container running?)." -ForegroundColor Red
    Write-Host $raw
    exit 1
}

# Filter to actual log lines (docker injects some non-log output on stderr).
$lines = $raw | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}T' }
if ($lines.Count -eq 0) {
    Write-Host "No log lines in the last $Hours hours (container may have just started)." -ForegroundColor Yellow
    exit 0
}

$requests = $lines | Where-Object { $_ -match '\[Request\]' }
$responses = $lines | Where-Object { $_ -match '\[resp\]' }

Write-Host ""
Write-Host "=== Claudish Live Traffic (last ${Hours}h) ===" -ForegroundColor Cyan
Write-Host "Container: $Container  |  Log lines: $($lines.Count)  |  Requests: $($requests.Count)  |  Responses: $($responses.Count)" -ForegroundColor Gray
Write-Host ""

# --- by model ----------------------------------------------------------------
Write-Host "--- By Model (requests) ---" -ForegroundColor Yellow
$requests | Select-String -Pattern 'model=([^\s]+)' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
    Group-Object | Sort-Object Count -Descending | ForEach-Object {
        Write-Host ("  {0,-22} {1,5}" -f $_.Name, $_.Count)
    }
Write-Host ""

# --- by machine --------------------------------------------------------------
Write-Host "--- By Machine (requests, via X-Claudish-Machine header) ---" -ForegroundColor Yellow
$requests | Select-String -Pattern 'machine=([^\s]+)' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
    Group-Object | Sort-Object Count -Descending | ForEach-Object {
        Write-Host ("  {0,-22} {1,5}" -f $_.Name, $_.Count)
    }

# Source IPs — for header-less attribution (ai-01 cron agents, legacy CC versions)
Write-Host "  (header-less source IPs):" -ForegroundColor DarkGray
$requests | Select-String -Pattern 'src=([\d.]+)' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
    Group-Object | Sort-Object Count -Descending | Select-Object -First 5 | ForEach-Object {
        Write-Host ("    {0,-18} {1,5}" -f $_.Name, $_.Count) -ForegroundColor DarkGray
    }
Write-Host ""

# --- handlers ----------------------------------------------------------------
Write-Host "--- By Handler ---" -ForegroundColor Yellow
$requests | Select-String -Pattern 'handler=([A-Za-z]+)' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
    Group-Object | Sort-Object Count -Descending | ForEach-Object {
        Write-Host ("  {0,-22} {1,5}" -f $_.Name, $_.Count)
    }
Write-Host ""

# --- errors (PRECISE filters — see proxy-log-monitoring memory) --------------
Write-Host "--- Errors (precise) ---" -ForegroundColor Yellow

$realRateLimit = ($lines | Select-String -Pattern '\[RateLimit\]|\[130[0-9]\]|HTTP 429').Count
$emptyBytes0   = ($responses | Select-String -Pattern 'bytes=0 ').Count
$finalizeErr   = ($lines | Select-String -Pattern 'finalizeWithError').Count
$http5xx       = ($lines | Select-String -Pattern 'status=5\d\d|HTTP 5\d\d').Count
$fallback      = ($lines | Select-String -Pattern '\[Fallback\]').Count
$exhausted     = ($lines | Select-String -Pattern 'giving up|chain exhausted|all providers').Count

Write-Host ("  rate-limit (REAL):   {0}" -f $realRateLimit)
Write-Host ("  empty (bytes=0):     {0}" -f $emptyBytes0)
Write-Host ("  finalizeWithError:   {0}" -f $finalizeErr)
Write-Host ("  HTTP 5xx:            {0}" -f $http5xx)
Write-Host ("  [Fallback] events:   {0}  (absorbed, check exhausted=0)" -f $fallback)
Write-Host ("  chain exhausted:     {0}  (>0 = requests lost)" -f $exhausted)
Write-Host ""

# --- never-hang (priority #1) ------------------------------------------------
Write-Host "--- Never-Hang (priority #1) ---" -ForegroundColor Yellow
$closedTrue = ($responses | Select-String -Pattern 'closed=true').Count
$notClosed  = $responses | Where-Object { $_ -notmatch 'closed=true' }
Write-Host ("  [resp] total: {0}  |  closed=true: {1}  |  NOT closed: {2}" -f $responses.Count, $closedTrue, $notClosed.Count)
if ($notClosed.Count -gt 0) {
    Write-Host "  !!! HANG SUSPECTS — investigate these responses:" -ForegroundColor Red
    $notClosed | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
} else {
    Write-Host "  All responses closed cleanly." -ForegroundColor Green
}
Write-Host ""

# --- Anthropic leak check ----------------------------------------------------
# Opus + Fable + Sonnet are the Anthropic-billed models. By cluster policy
# these must come from the authorized machine(s). po-2025 may have an
# authorized Safari workflow — flagged REVIEW, not LEAK (lesson 2026-06-21).
Write-Host "--- Anthropic Distribution (Opus/Fable/Sonnet) ---" -ForegroundColor Yellow
$authorized = $AnthropicMachines.Split(',') | ForEach-Object { $_.Trim() }

$anthropicReqs = $requests | Where-Object { $_ -match 'claude-opus|claude-fable|claude-sonnet' }
if ($anthropicReqs.Count -eq 0) {
    Write-Host "  No Anthropic-model traffic this window." -ForegroundColor Green
} else {
    $byMachine = $anthropicReqs | Select-String -Pattern 'machine=([^\s]+)' -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
        Group-Object | Sort-Object Count -Descending
    foreach ($g in $byMachine) {
        $tag = if ($authorized -contains $g.Name) { 'OK (authorized)' }
               elseif ($g.Name -eq 'myia-po-2025') { 'REVIEW (Safari workflow may be authorized)' }
               else { 'LEAK (not authorized for Anthropic)' }
        $color = if ($tag -like 'OK*') { 'Green' } elseif ($tag -like 'REVIEW*') { 'Yellow' } else { 'Red' }
        Write-Host ("  {0,-22} {1,5}  [{2}]" -f $g.Name, $g.Count, $tag) -ForegroundColor $color

        # Sub-breakdown by model for this machine
        $modelBreakdown = ($anthropicReqs | Where-Object { $_ -match "machine=$($g.Name)" } |
            Select-String -Pattern 'model=(claude-opus-4-8|claude-fable\S*|claude-sonnet-4-6)' -AllMatches |
            ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
            Group-Object | Sort-Object Count -Descending |
            ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', '
        Write-Host ("    models: {0}" -f $modelBreakdown) -ForegroundColor DarkGray
    }
}
Write-Host ""

# --- session loop detection --------------------------------------------------
# Same reqN repeated many times = possible stuck loop. Normal requests produce
# 2-3 lines (req + resp + stream marker); counts >= 6 across a wide window
# warrant a look. Lower counts are just the normal multi-line traces of one req.
Write-Host "--- Session Loop Check (reqN repeated >= 6 times = review) ---" -ForegroundColor Yellow
$reqNGroups = $lines | Select-String -Pattern 'reqN=(\d+)' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
    Group-Object | Sort-Object Count -Descending
$suspects = $reqNGroups | Where-Object { $_.Count -ge 6 }
if ($suspects) {
    foreach ($g in $suspects | Select-Object -First 5) {
        Write-Host ("  reqN={0,-8} x{1}  (review for loop)" -f $g.Name, $g.Count) -ForegroundColor Yellow
    }
} else {
    Write-Host "  No reqN repeated >= 6 times — no loop pattern." -ForegroundColor Green
    $reqNGroups | Select-Object -First 3 | ForEach-Object {
        Write-Host ("  (normal) reqN={0,-8} x{1}" -f $_.Name, $_.Count) -ForegroundColor DarkGray
    }
}
Write-Host ""
