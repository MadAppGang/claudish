#requires -Version 5.1
<#
.SYNOPSIS
  Nightly compaction of claudish diagnostic captures with 7-Zip.

.DESCRIPTION
  The claudish proxy writes raw request/response captures (req-*.json /
  resp-*.sse) into a flat directory bind-mounted from the container
  (CLAUDISH_CAPTURE_DIR=/captures -> D:\claudish-captures). These are text
  with massive cross-request redundancy (the same large system prompts and
  conversation histories repeat across thousands of files), so 7-Zip LZMA2
  compresses them ~30:1 or better.

  Left uncompressed, ~3-8 GB/day of loose files would fill the disk within
  months. This script packs every COMPLETED past day (UTC) into a single
  per-day .7z under <CaptureDir>\archive\, verifies the archive integrity,
  and ONLY THEN deletes the loose originals. The current day (and any extra
  days requested via -KeepDays) is left untouched so live analysis still has
  fresh loose files to work with.

  Designed to run unattended (Windows Task Scheduler). Idempotent: re-running
  appends stragglers to an existing day archive, re-verifies, and removes the
  loose copies. Never deletes anything without a verified archive (7z t == 0).

.PARAMETER CaptureDir
  Directory holding the loose req-*/resp-* capture files.

.PARAMETER ArchiveDir
  Where per-day .7z archives are written. Default: <CaptureDir>\archive.

.PARAMETER SevenZip
  Path to 7z.exe.

.PARAMETER KeepDays
  Number of most-recent UTC days to leave loose (including today).
  1 = archive everything strictly before today (default).

.PARAMETER WhatIf
  Show what would be archived/deleted without changing anything.

.NOTES
  Installed on this machine as the nightly Task Scheduler job
  "ClaudishCaptureCompaction" (daily 04:17 local, runs as the interactive
  user, StartWhenAvailable to catch up missed runs). Re-create it with:

    $action  = New-ScheduledTaskAction -Execute 'C:\Program Files\PowerShell\7\pwsh.exe' `
                 -Argument '-NoProfile -ExecutionPolicy Bypass -File "d:\Dev\claudish\scripts\compress-captures.ps1"'
    $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]'04:17')
    $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
                 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                 -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
    $princ   = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'ClaudishCaptureCompaction' -Action $action `
                 -Trigger $trigger -Settings $set -Principal $princ -Force

  Remove it with:  Unregister-ScheduledTask -TaskName 'ClaudishCaptureCompaction' -Confirm:$false
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$CaptureDir = "D:\claudish-captures",
  [string]$ArchiveDir = "",
  [string]$SevenZip   = "D:\Apps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe",
  [int]   $KeepDays   = 1,
  # Off-site backup via Google Drive Desktop (mounted drive, no API/auth).
  # Empty = skip GDrive entirely (local compaction only). The path is the local
  # mount point of the Drive, so this is just a Windows file copy.
  [string]$GDriveDir  = "G:\Mon Drive\MyIA\backups\claudish-captures",
  # Local retention: archives older than this (in days) are purged from the
  # local ArchiveDir, BUT only after confirming the copy exists on GDrive.
  # GDrive keeps everything; this only bounds local disk usage.
  [int]   $KeepLocalDays = 30
)

$ErrorActionPreference = "Stop"
if (-not $ArchiveDir) { $ArchiveDir = Join-Path $CaptureDir "archive" }
$logFile = Join-Path $CaptureDir "compaction.log"

function Log([string]$msg) {
  $line = "{0:yyyy-MM-ddTHH:mm:ssZ} {1}" -f (Get-Date).ToUniversalTime(), $msg
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch {}
}

# --- preconditions -----------------------------------------------------------
if (-not (Test-Path -LiteralPath $SevenZip))   { Log "FATAL: 7z not found at $SevenZip"; exit 2 }
if (-not (Test-Path -LiteralPath $CaptureDir)) { Log "FATAL: capture dir not found: $CaptureDir"; exit 2 }
if (-not (Test-Path -LiteralPath $ArchiveDir)) { New-Item -ItemType Directory -Path $ArchiveDir -Force | Out-Null }

# Cutoff: archive any day strictly older than (todayUTC - (KeepDays-1)).
$cutoff = (Get-Date).ToUniversalTime().Date.AddDays(-([Math]::Max(0, $KeepDays - 1)))
Log "START compaction CaptureDir=$CaptureDir KeepDays=$KeepDays cutoff(UTC)=$($cutoff.ToString('yyyy-MM-dd'))"

# --- enumerate loose captures, group by their filename date (UTC) ------------
$rx = '^(req|resp)-.*?(?<d>\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}'
$loose = Get-ChildItem -LiteralPath $CaptureDir -File | Where-Object { $_.Name -match $rx }
if (-not $loose) { Log "nothing to do (0 loose capture files)"; Log "END"; exit 0 }

$byDay = @{}
foreach ($f in $loose) {
  if ($f.Name -match $rx) {
    $d = $matches['d']
    if (-not $byDay.ContainsKey($d)) { $byDay[$d] = New-Object System.Collections.ArrayList }
    [void]$byDay[$d].Add($f)
  }
}

$daysToArchive = $byDay.Keys | Where-Object { [datetime]::ParseExact($_, 'yyyy-MM-dd', $null) -lt $cutoff } | Sort-Object
if (-not $daysToArchive) { Log "nothing to do (no completed past days; newest is kept loose)"; Log "END"; exit 0 }

$totalRaw = 0L; $totalArch = 0L; $totalFiles = 0; $errors = 0

foreach ($day in $daysToArchive) {
  $files = $byDay[$day]
  $rawBytes = ($files | Measure-Object -Property Length -Sum).Sum
  $archivePath = Join-Path $ArchiveDir "captures-$day.7z"

  if ($PSCmdlet.ShouldProcess("$($files.Count) files for $day", "7z archive -> $archivePath then delete loose")) {
    # Write an exact file list (bare names, no BOM) for 7z's @listfile.
    $listFile = Join-Path $env:TEMP ("claudish-compact-$day-{0}.lst" -f $PID)
    [System.IO.File]::WriteAllLines($listFile, ($files | ForEach-Object { $_.Name }), (New-Object System.Text.UTF8Encoding($false)))

    Push-Location $CaptureDir
    try {
      # LZMA2, max compression. -md=128m dictionary spans the cross-request
      # redundancy while keeping the unattended job memory-safe (~1.5 GB).
      # NB: no `--` here — 7-Zip's `--` stops @listfile parsing too, which would
      # make it treat the list as a literal filename. The archive path and the
      # @list arg are both safe (no leading `-`), so `--` is unnecessary.
      & $SevenZip a -t7z -m0=lzma2 -mx=9 -md=128m -mfb=273 -mmt=on -bso0 -bsp0 "$archivePath" "@$listFile" | Out-Null
      $addRc = $LASTEXITCODE
      & $SevenZip t -bso0 -bsp0 "$archivePath" | Out-Null
      $testRc = $LASTEXITCODE
    } finally {
      Pop-Location
      Remove-Item -LiteralPath $listFile -Force -ErrorAction SilentlyContinue
    }

    if ($addRc -eq 0 -and $testRc -eq 0 -and (Test-Path -LiteralPath $archivePath)) {
      $archBytes = (Get-Item -LiteralPath $archivePath).Length
      # Verified archive exists -> safe to delete the loose originals.
      $files | Remove-Item -Force
      $ratio = if ($archBytes -gt 0) { [Math]::Round($rawBytes / $archBytes, 1) } else { 0 }
      Log ("OK  {0}: {1} files, {2:N1} MB -> {3:N1} MB ({4}:1), loose deleted" -f `
           $day, $files.Count, ($rawBytes/1MB), ($archBytes/1MB), $ratio)
      $totalRaw += $rawBytes; $totalArch += $archBytes; $totalFiles += $files.Count

      # --- off-site backup (Google Drive Desktop mount, plain file copy) ------
      # Non-fatal: if the Drive isn't mounted (laptop offline, G: missing) or
      # the copy fails, we log a WARN and continue. The local archive already
      # exists (verified), so we never lose data — only the off-site copy is
      # deferred. The purge-30d block below will NOT delete local archives that
      # aren't confirmed on GDrive, so a missed upload retries the next night.
      if ($GDriveDir) {
        if (Test-Path -LiteralPath $GDriveDir) {
          try {
            Copy-Item -LiteralPath $archivePath -Destination $GDriveDir -Force -ErrorAction Stop
            # Confirm the copy landed with matching size before trusting it.
            $dest = Join-Path $GDriveDir (Split-Path $archivePath -Leaf)
            if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq $archBytes) {
              Log ("GDRIVE {0}: uploaded ({1:N1} MB)" -f $day, ($archBytes/1MB))
            } else {
              $errors++
              Log ("WARN  {0}: GDrive copy size mismatch -> local kept, retry next run" -f $day)
            }
          } catch {
            $errors++
            Log ("WARN  {0}: GDrive copy failed: {1} -> local kept, retry next run" -f $day, $_.Exception.Message)
          }
        } else {
          Log ("WARN  GDriveDir not mounted ({0}) -> off-site deferred, local kept" -f $GDriveDir)
        }
      }
    } else {
      $errors++
      Log ("ERROR {0}: 7z add rc={1} test rc={2} -> KEEPING loose files (not deleted)" -f $day, $addRc, $testRc)
    }
  }
}

# --- local retention purge: delete archives older than KeepLocalDays, ONLY if
# confirmed present (and same size) on GDrive. This bounds local disk; GDrive
# keeps the full history. If GDriveDir is unset or not mounted, purge is
# skipped entirely (safe default — never delete without an off-site copy).
if ($KeepLocalDays -gt 0 -and $GDriveDir -and (Test-Path -LiteralPath $ArchiveDir) -and (Test-Path -LiteralPath $GDriveDir)) {
  $purgeCutoff = (Get-Date).ToUniversalTime().Date.AddDays(-$KeepLocalDays)
  $purged = 0; $purgeSkipped = 0
  foreach ($arch in (Get-ChildItem -LiteralPath $ArchiveDir -Filter 'captures-*.7z' -File)) {
    if ($arch.Name -notmatch 'captures-(\d{4}-\d{2}-\d{2})\.7z') { continue }
    $dayDate = [datetime]::ParseExact($matches[1], 'yyyy-MM-dd', $null)
    if ($dayDate -ge $purgeCutoff) { continue }   # within retention window
    $dest = Join-Path $GDriveDir $arch.Name
    # Require off-site copy to exist AND match local size before deleting.
    if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq $arch.Length) {
      if ($PSCmdlet.ShouldProcess($arch.FullName, "purge local (>{0}d, confirmed on GDrive)" -f $KeepLocalDays)) {
        Remove-Item -LiteralPath $arch.FullName -Force
        $purged++
      }
    } else {
      $purgeSkipped++
    }
  }
  if ($purged -gt 0 -or $purgeSkipped -gt 0) {
    Log ("PURGE >{0}d: {1} local archive(s) deleted, {2} kept (not yet on GDrive)" -f $KeepLocalDays, $purged, $purgeSkipped)
  }
}

if ($totalArch -gt 0) {
  $tr = [Math]::Round($totalRaw / $totalArch, 1)
  Log ("SUMMARY: {0} day(s), {1} files, {2:N1} MB -> {3:N1} MB ({4}:1)" -f `
       $daysToArchive.Count, $totalFiles, ($totalRaw/1MB), ($totalArch/1MB), $tr)
}
Log "END (errors=$errors)"
exit $errors
