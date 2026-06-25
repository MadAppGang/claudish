#!/usr/bin/env pwsh
<#
.SYNOPSIS
List active claudish sessions with full detail from captures.

.DESCRIPTION
Groups requests by session_id and shows workspace, machine, model,
CC version, timing, and request statistics for each session.

.PARAMETER Hours
Session activity window: only show sessions with a request in the last N hours (default: 2).

.PARAMETER All
Show all sessions found in capture files (no time filter).

.PARAMETER Dir
Capture directory (default: D:\claudish-captures).

.EXAMPLE
.\traffic-sessions.ps1
.\traffic-sessions.ps1 -All
#>
[CmdletBinding()]
param(
    [int]$Hours = 2,
    [switch]$All,
    [string]$Dir = 'D:\claudish-captures'
)

Import-Module (Join-Path $PSScriptRoot 'CaptureUtils.psm1') -Force

$requests = @(Get-CaptureRequests -Dir $Dir -Hours $Hours -All:$All)

if ($requests.Count -eq 0) {
    Write-Host "No capture files found."
    exit 0
}

# Group by session
$sessions = $requests | Where-Object { $_.SessionId } |
    Group-Object SessionId |
    Sort-Object { ($_.Group | Sort-Object FileTime -Descending | Select-Object -First 1).FileTime } -Descending

if ($sessions.Count -eq 0) {
    Write-Host "No sessions found (metadata.user_id may be missing)."
    exit 0
}

Write-Host ""
Write-Host "=== Claudish Sessions ===" -ForegroundColor Cyan
Write-Host "Total: $($sessions.Count) sessions from $($requests.Count) requests" -ForegroundColor Gray
Write-Host ""

# Also group requests without session for accounting
$noSession = $requests | Where-Object { -not $_.SessionId }
if ($noSession) {
    Write-Host "($($noSession.Count) requests without session_id)" -ForegroundColor DarkGray
    Write-Host ""
}

foreach ($s in $sessions) {
    $latest = $s.Group | Sort-Object FileTime -Descending | Select-Object -First 1
    $oldest = $s.Group | Sort-Object FileTime | Select-Object -First 1
    $sid = $s.Name
    $shortSid = if ($sid.Length -gt 8) { $sid.Substring(0, 8) + '…' } else { $sid }

    # Resolve machine: prefer explicit header, fall back to device_id
    $machine = $latest.Machine
    if ($machine -eq '(unknown)' -and $latest.DeviceId) {
        $machine = Resolve-MachineFromDevice $latest.DeviceId
    }

    # Compute session duration
    $duration = $latest.FileTime - $oldest.FileTime
    $durationStr = if ($duration.TotalHours -ge 1) {
        "{0:N1}h" -f $duration.TotalHours
    } else {
        "{0:N0}m" -f $duration.TotalMinutes
    }

    # Token estimate (sum of request body sizes as proxy)
    $totalSize = ($s.Group | Measure-Object Size -Sum).Sum
    $avgMsgs = [math]::Round(($s.Group | Measure-Object MsgCount -Average).Average)
    $maxMsgs = ($s.Group | Measure-Object MsgCount -Maximum).Maximum

    # Model transitions
    $modelSeq = $s.Group | Sort-Object FileTime | Select-Object -ExpandProperty Model -Unique
    $modelStr = $modelSeq -join ' → '

    # Workspaces used
    $wsList = $s.Group | Select-Object -ExpandProperty Workspace -Unique

    # Time gap analysis
    $sorted = $s.Group | Sort-Object FileTime
    $gaps = @()
    for ($i = 1; $i -lt $sorted.Count; $i++) {
        $gap = $sorted[$i].FileTime - $sorted[$i-1].FileTime
        if ($gap.TotalMinutes -gt 30) {
            $gaps += $gap
        }
    }

    $isActive = ($latest.FileTime -gt (Get-Date).AddHours(-1))

    Write-Host ("Session {0}  {1}" -f $shortSid, $(if ($isActive) { '[ACTIVE]' } else { '[idle]' })) -ForegroundColor $(if ($isActive) { 'Green' } else { 'Gray' })
    Write-Host ("  Machine:     {0}" -f $machine)
    Write-Host ("  Workspace:   {0}" -f ($wsList -join ', '))
    Write-Host ("  Model:       {0}" -f $modelStr)
    Write-Host ("  CC:          {0} ({1})" -f $latest.CCVersion, $latest.Entrypoint)
    Write-Host ("  First req:   {0}" -f $oldest.Timestamp)
    Write-Host ("  Last req:    {0}" -f $latest.Timestamp)
    Write-Host ("  Duration:    {0}" -f $durationStr)
    Write-Host ("  Requests:    {0}  (avg {1} msgs, max {2} msgs)" -f $s.Count, $avgMsgs, $maxMsgs)
    Write-Host ("  Total data:  {0:N1} KB" -f ($totalSize / 1KB))
    if ($gaps.Count -gt 0) {
        Write-Host ("  Long gaps:   {0} gaps > 30min" -f $gaps.Count) -ForegroundColor DarkGray
    }
    Write-Host ""
}
