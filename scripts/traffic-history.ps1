#!/usr/bin/env pwsh
<#
.SYNOPSIS
Analyze historical claudish traffic from 7z archives.

.DESCRIPTION
Extracts and analyzes capture data from compressed archives in the
archive directory. Supports single-day or multi-day lookback.

.PARAMETER Date
Specific date to analyze (format: yyyy-MM-dd).

.PARAMETER Days
Number of days to look back (default: 1).

.PARAMETER Dir
Capture directory (default: D:\claudish-captures).

.EXAMPLE
.\traffic-history.ps1 -Date 2026-06-06
.\traffic-history.ps1 -Days 7
#>
[CmdletBinding()]
param(
    [string]$Date,
    [int]$Days = 1,
    [string]$Dir = 'D:\claudish-captures'
)

Import-Module (Join-Path $PSScriptRoot 'CaptureUtils.psm1') -Force

# Determine which archive days to process
$archives = @(Get-ArchivedDays -Dir $Dir)

if ($Date) {
    $targetDate = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)
    $archives = $archives | Where-Object { $_.Date.Date -eq $targetDate.Date }
} elseif ($Days -gt 0) {
    $cutoff = (Get-Date).Date.AddDays(-$Days)
    $archives = $archives | Where-Object { $_.Date.Date -ge $cutoff }
}

if ($archives.Count -eq 0) {
    Write-Host "No archives found for the requested period."
    Write-Host "Available archives:"
    $allArchives = @(Get-ArchivedDays -Dir $Dir)
    if ($allArchives.Count -eq 0) {
        Write-Host "  (none)" -ForegroundColor DarkGray
    } else {
        $allArchives | ForEach-Object {
            Write-Host ("  {0}  {1:N1} MB" -f $_.Date.ToString('yyyy-MM-dd'), ($_.Size / 1MB))
        }
    }
    exit 0
}

Write-Host ""
Write-Host "=== Claudish Historical Traffic ===" -ForegroundColor Cyan
Write-Host "Archives to process: $($archives.Count)" -ForegroundColor Gray
Write-Host ""

$tempDirs = @()

try {
    foreach ($arch in $archives) {
        Write-Host ("Processing {0} ({1:N1} MB)..." -f $arch.Date.ToString('yyyy-MM-dd'), ($arch.Size / 1MB)) -ForegroundColor Yellow

        $extractDir = Expand-ArchiveDay $arch.File
        if (-not $extractDir) {
            Write-Host "  Failed to extract archive." -ForegroundColor Red
            continue
        }
        $tempDirs += $extractDir

        $requests = @(Get-CaptureRequests -Dir $extractDir -All)

        if ($requests.Count -eq 0) {
            Write-Host "  No requests found in archive." -ForegroundColor DarkGray
            continue
        }

        Write-Host ("  {0} requests" -f $requests.Count)

        # Summary by machine
        $byMachine = $requests | Group-Object Machine | Sort-Object Count -Descending
        foreach ($g in $byMachine) {
            $models = ($g.Group | Group-Object Model | Sort-Object Count -Descending |
                ForEach-Object { "$($_.Name) ($($_.Count))" }) -join ', '
            $workspaces = ($g.Group | Where-Object { $_.Workspace -ne '(no workspace)' } |
                Select-Object -ExpandProperty Workspace -Unique) -join ', '
            $sessions = ($g.Group | Where-Object { $_.SessionId } |
                Select-Object -ExpandProperty SessionId -Unique).Count

            Write-Host ("    {0,-16} {1,4} reqs  {2} sessions  models: {3}" -f $g.Name, $g.Count, $sessions, $models)
            if ($workspaces) {
                Write-Host ("    {0,16}         workspaces: {1}" -f '', $workspaces) -ForegroundColor DarkGray
            }
        }
        Write-Host ""
    }

    # Cross-day session summary
    Write-Host "--- Cross-Day Sessions ---" -ForegroundColor Yellow
    $allRequests = @()
    foreach ($td in $tempDirs) {
        $allRequests += @(Get-CaptureRequests -Dir $td -All)
    }

    $crossSessions = $allRequests | Where-Object { $_.SessionId } |
        Group-Object SessionId |
        Where-Object { $_.Count -gt 5 } |
        Sort-Object Count -Descending |
        Select-Object -First 20

    if ($crossSessions) {
        foreach ($s in $crossSessions) {
            $latest = $s.Group | Sort-Object FileTime -Descending | Select-Object -First 1
            $oldest = $s.Group | Sort-Object FileTime | Select-Object -First 1
            $shortSid = if ($s.Name.Length -gt 8) { $s.Name.Substring(0, 8) + '…' } else { $s.Name }
            $duration = $latest.FileTime - $oldest.FileTime
            $durationStr = if ($duration.TotalHours -ge 1) { "{0:N1}h" -f $duration.TotalHours } else { "{0:N0}m" -f $duration.TotalMinutes }
            $models = ($s.Group | Select-Object -ExpandProperty Model -Unique) -join ', '

            Write-Host ("  {0}  {1,4} reqs  {2,6}  {3}  {4}" -f $shortSid, $s.Count, $durationStr, $models, $latest.Workspace)
        }
    } else {
        Write-Host "  (no sessions with > 5 requests)" -ForegroundColor DarkGray
    }

} finally {
    # Cleanup temp directories
    foreach ($td in $tempDirs) {
        Remove-Item $td -Recurse -Force -ErrorAction SilentlyContinue
    }
}
