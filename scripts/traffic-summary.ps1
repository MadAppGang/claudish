#!/usr/bin/env pwsh
<#
.SYNOPSIS
Summarize claudish proxy traffic from capture files.

.DESCRIPTION
Reads req-*.json capture files from the last N hours and produces a
structured summary: by machine, by workspace, by model, by session.

.PARAMETER Hours
Look back window in hours (default: 2).

.PARAMETER Dir
Capture directory (default: D:\claudish-captures).

.EXAMPLE
.\traffic-summary.ps1
.\traffic-summary.ps1 -Hours 24
#>
[CmdletBinding()]
param(
    [int]$Hours = 2,
    [string]$Dir = 'D:\claudish-captures'
)

Import-Module (Join-Path $PSScriptRoot 'CaptureUtils.psm1') -Force

$requests = @(Get-CaptureRequests -Dir $Dir -Hours $Hours)

if ($requests.Count -eq 0) {
    Write-Host "No capture files found in the last $Hours hours."
    exit 0
}

Write-Host ""
Write-Host "=== Claudish Traffic Summary (last ${Hours}h) ===" -ForegroundColor Cyan
Write-Host "Capture files processed: $($requests.Count)" -ForegroundColor Gray
Write-Host ""

# ── By Machine ──────────────────────────────────────────────
$byMachine = $requests | Group-Object Machine | Sort-Object Count -Descending

Write-Host "--- By Machine ---" -ForegroundColor Yellow
foreach ($g in $byMachine) {
    $models = ($g.Group | Group-Object Model | Sort-Object Count -Descending |
        ForEach-Object { "$($_.Name) ($($_.Count))" }) -join ', '
    $workspaces = ($g.Group | Select-Object -ExpandProperty Workspace -Unique) -join ', '
    $latest = ($g.Group | Sort-Object FileTime -Descending | Select-Object -First 1).Timestamp

    Write-Host ("  {0,-16} {1,4} reqs  models: {2}" -f $g.Name, $g.Count, $models)
    Write-Host ("  {0,16}         workspaces: {1}" -f '', $workspaces) -ForegroundColor DarkGray
    Write-Host ("  {0,16}         last: {1}" -f '', $latest) -ForegroundColor DarkGray
}
Write-Host ""

# ── By Model ────────────────────────────────────────────────
$byModel = $requests | Group-Object Model | Sort-Object Count -Descending

Write-Host "--- By Model ---" -ForegroundColor Yellow
foreach ($g in $byModel) {
    $machines = ($g.Group | Select-Object -ExpandProperty Machine -Unique) -join ', '
    Write-Host ("  {0,-20} {1,4} reqs  machines: {2}" -f $g.Name, $g.Count, $machines)
}
Write-Host ""

# ── Active Workspaces ───────────────────────────────────────
$byWorkspace = $requests | Where-Object { $_.Workspace -ne '(no workspace)' } |
    Group-Object Workspace | Sort-Object Count -Descending

Write-Host "--- Active Workspaces ---" -ForegroundColor Yellow
foreach ($g in $byWorkspace) {
    $machines = ($g.Group | Select-Object -ExpandProperty Machine -Unique) -join ', '
    $sessions = ($g.Group | Where-Object { $_.SessionId } | Select-Object -ExpandProperty SessionId -Unique).Count
    $latest = ($g.Group | Sort-Object FileTime -Descending | Select-Object -First 1).Timestamp
    $models = ($g.Group | Group-Object Model | Sort-Object Count -Descending |
        ForEach-Object { $_.Name }) -join ', '

    Write-Host ("  {0,-40} {1,3} reqs  {2} sessions" -f $g.Name, $g.Count, $sessions)
    Write-Host ("  {0,40}         machines: {1}" -f '', $machines) -ForegroundColor DarkGray
    Write-Host ("  {0,40}         models: {1}" -f '', $models) -ForegroundColor DarkGray
    Write-Host ("  {0,40}         last: {1}" -f '', $latest) -ForegroundColor DarkGray
}
Write-Host ""

# ── Active Sessions ─────────────────────────────────────────
$activeSessions = $requests | Where-Object { $_.SessionId } |
    Group-Object SessionId | Sort-Object { ($_.Group | Sort-Object FileTime -Descending | Select-Object -First 1).FileTime } -Descending

Write-Host "--- Active Sessions ---" -ForegroundColor Yellow
foreach ($g in $activeSessions) {
    $latest = $g.Group | Sort-Object FileTime -Descending | Select-Object -First 1
    $oldest = $g.Group | Sort-Object FileTime | Select-Object -First 1
    $models = ($g.Group | Group-Object Model | Sort-Object Count -Descending |
        ForEach-Object { $_.Name }) -join ' → '
    $sid = $g.Name
    $shortSid = if ($sid.Length -gt 8) { $sid.Substring(0, 8) + '…' } else { $sid }

    Write-Host ("  Session {0}" -f $shortSid) -ForegroundColor White
    Write-Host ("    Machine:    {0}" -f $latest.Machine)
    Write-Host ("    Workspace:  {0}" -f $latest.Workspace)
    Write-Host ("    Models:     {0}" -f $models)
    Write-Host ("    CC version: {0}" -f $latest.CCVersion)
    Write-Host ("    Entrypoint: {0}" -f $latest.Entrypoint)
    Write-Host ("    First req:  {0}" -f $oldest.Timestamp)
    Write-Host ("    Last req:   {0}" -f $latest.Timestamp)
    Write-Host ("    Requests:   {0}  (avg {1} msgs/req)" -f $g.Count,
        [math]::Round(($g.Group | Measure-Object MsgCount -Average).Average))
    Write-Host ""
}
