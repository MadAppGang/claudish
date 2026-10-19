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
  "ClaudishCaptureCompaction" (daily 02:47 local — moved off 04:17 on
  2026-08-20: the 60-70 min run collided with the 04:00 container restart —
  runs as the interactive user, StartWhenAvailable to catch up missed runs).
  Re-create it with:

    $action  = New-ScheduledTaskAction -Execute 'C:\Program Files\PowerShell\7\pwsh.exe' `
                 -Argument '-NoProfile -ExecutionPolicy Bypass -File "d:\Dev\claudish\scripts\compress-captures.ps1"'
    $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]'02:47')
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
  # 7z binary. Empty (the default) = resolve from the built-in candidate list
  # (#214): the historical single hardcoded default was wrong on this machine
  # AND a second, different hardcoded value in the launcher was wrong too, so the
  # 2026-09-22 night died with the binary sitting on disk under a third path. An
  # explicit value that exists is used as-is; one that does not exist is warned
  # about and the candidate list is tried instead.
  [string]$SevenZip   = "",
  # Kill the candidate fallback: an explicit (or absent) 7z that cannot be
  # resolved is then a hard FATAL, which is what a caller that insists on one
  # exact binary wants - and what the precondition pins exercise.
  [switch]$NoSevenZipFallback,
  # Extra 7z candidates, appended AFTER the built-ins (a fallback of last resort).
  [string[]]$SevenZipCandidates = @(),
  [int]   $KeepDays   = 1,
  # Off-site backup via Google Drive Desktop (mounted drive, no API/auth).
  # Empty = skip GDrive entirely (local compaction only). The path is the local
  # mount point of the Drive, so this is just a Windows file copy. Files land
  # online-only by default (DriveFS does not hydrate what it wrote) — never
  # pin this folder for offline access, that would re-hydrate the whole
  # history onto local disk.
  [string]$GDriveDir  = "G:\Mon Drive\Backups-Cloud\claudish",
  # Local retention: archives older than this (in days) are purged from the
  # local ArchiveDir, BUT only after confirming the copy exists on GDrive.
  # GDrive keeps everything; this only bounds local disk usage.
  # 0 = GDrive is the only home: every local archive is deleted as soon as
  # its GDrive copy is confirmed (same run, right after the upload).
  # Negative = keep all local archives (escape hatch).
  [int]   $KeepLocalDays = 0,
  # Machine qualifier for the archive name: captures-<day>-<tag>.7z.
  # GDriveDir is a SHARED namespace across the fleet and the upload is a forced
  # overwrite, so two producers writing captures-<day>.7z destroy each other's
  # day (see Get-CaptureArchivePolicy). A tag makes the collision structurally
  # impossible. Empty is allowed ONLY with -AllowUntaggedSharedArchive.
  [string]$MachineTag = "",
  # Opt-in for the ONE machine that owns the legacy untagged namespace, so its
  # existing archive names — and every reader matching captures-<day>.7z —
  # are unchanged. Any other machine must pass -MachineTag instead.
  [switch]$AllowUntaggedSharedArchive,
  # #389: how many manifest entries the nightly sha re-check verifies per run
  # (deterministic rotation; 3 by default, 0 disables). Each entry re-hashed is
  # one DriveFS hydration, so keep this small.
  [int]$ShaCheckCount = 3
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot 'lib\claudish-engine.psm1') -Force -DisableNameChecking
if (-not $ArchiveDir) { $ArchiveDir = Join-Path $CaptureDir "archive" }
$logFile = Join-Path $CaptureDir "compaction.log"

function Log([string]$msg) {
  $line = "{0:yyyy-MM-ddTHH:mm:ssZ} {1}" -f (Get-Date).ToUniversalTime(), $msg
  Write-Host $line
  try { Add-Content -LiteralPath $logFile -Value $line -Encoding utf8 } catch {}
}

# --- preconditions -----------------------------------------------------------
# Namespace policy FIRST: refuse before archiving, never after uploading. A run
# that joins the shared off-site directory anonymously overwrites another
# machine's archive for the same day and then purges its own local copy, so the
# day is lost everywhere — and that is the DEFAULT configuration, which is why
# the refusal has to be the default too.
$archivePolicy = Get-CaptureArchivePolicy -GDriveDir $GDriveDir -MachineTag $MachineTag `
                   -AllowUntaggedSharedArchive:$AllowUntaggedSharedArchive
if (-not $archivePolicy.Ok) { Log ("FATAL: {0}" -f $archivePolicy.Reason); exit 3 }
$MachineTag = $archivePolicy.MachineTag
Log ("NAMESPACE {0}" -f $archivePolicy.Reason)

# 7z resolution (#214): never a single hardcoded path. An explicit -SevenZip is
# honoured when it exists; when it does not, the built-in candidates are tried
# (and the miss is warned about) so a churned launcher cannot kill the night.
# The failure path NAMES every path probed - a bare "7z not found at <path>" left
# the 2026-09-22 operator guessing which of two hardcodes was the live one.
$candidates = @(Get-SevenZipCandidates -Extra $SevenZipCandidates)
$sevenZipOnPath = Get-Command 7z -ErrorAction SilentlyContinue
if ($sevenZipOnPath -and $sevenZipOnPath.Source) { $candidates += $sevenZipOnPath.Source }
$sevenZipResolved = Resolve-SevenZipPath -Explicit $SevenZip -Candidates $candidates -NoFallback:$NoSevenZipFallback
if (-not $sevenZipResolved.Path) {
  Log ("FATAL: 7z not found - tried: {0}" -f (($sevenZipResolved.Tried) -join '; ')); exit 2
}
if ($sevenZipResolved.ExplicitMissing) {
  Log ("WARN  -SevenZip '{0}' does not exist -> resolved to {1}" -f $SevenZip, $sevenZipResolved.Path)
}
$SevenZip = $sevenZipResolved.Path
Log ("SEVENZIP {0} (source={1})" -f $SevenZip, $sevenZipResolved.Source)

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
  $archivePath = Join-Path $ArchiveDir (Get-CaptureArchiveName -Day $day -MachineTag $MachineTag)

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
      # deferred. The retention purge block below will NOT delete local archives that
      # aren't confirmed on GDrive, so a missed upload retries the next night.
      if ($GDriveDir) {
        if (Test-Path -LiteralPath $GDriveDir) {
          # Read the destination AS IT EXISTS PRIOR TO THE WRITE (#208). The forced
          # overwrite below must never replace a different producer's file: a
          # different size on a name this run owns means someone else wrote it, and
          # the post-copy confirmation cannot catch it (it would compare against
          # the very bytes this run just wrote). Refuse -> no copy; the retention
          # purge below requires an exact size match, so the local archive
          # survives and the next run re-runs the decision.
          $dest = Join-Path $GDriveDir (Split-Path $archivePath -Leaf)
          $destItem = Get-Item -LiteralPath $dest -ErrorAction SilentlyContinue
          $destBytes = 0L
          if ($destItem) { $destBytes = $destItem.Length }
          $verdict = Get-OffsiteWriteVerdict -DestExists ([bool]$destItem) -DestBytes $destBytes -LocalBytes $archBytes
          if ($verdict.Action -eq 'refuse') {
            $errors++
            Log ("REFUSE {0}: off-site {1} -> local kept, purge will skip, NOT overwritten" -f $day, $verdict.Reason)
          } elseif ($verdict.Action -eq 'idempotent') {
            Log ("GDRIVE {0}: already current ({1} bytes), idempotent - no copy needed" -f $day, $archBytes)
          } else {
            try {
              Copy-Item -LiteralPath $archivePath -Destination $GDriveDir -Force -ErrorAction Stop
              # Confirm the copy landed with matching size before trusting it.
              if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq $archBytes) {
                # #389: size equality is not content equality. Hash BOTH sides at
                # deposit and refuse on mismatch (bytes corrupted in flight land
                # with the right size), then record the DESTINATION hash as the
                # off-site reference - the rotating re-check below compares the
                # live Drive file against exactly this, so drift at equal size
                # stops being invisible.
                $shaLocal  = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
                $shaDest   = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
                if ($shaLocal -ne $shaDest) {
                  $errors++
                  Log ("WARN  {0}: GDrive copy SHA mismatch after size-equal copy (local {1}.. vs dest {2}..) -> local kept, retry next run" -f $day, $shaLocal.Substring(0,8), $shaDest.Substring(0,8))
                } else {
                  $manifestPath = Get-ShaManifestPath -GDriveDir $GDriveDir -MachineTag $MachineTag
                  $null = Update-ShaManifest -Path $manifestPath -Archive (Split-Path $archivePath -Leaf) `
                           -Sha256 $shaDest -Bytes $archBytes `
                           -RecordedUtc ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
                  Log ("GDRIVE {0}: uploaded ({1:N1} MB, sha256 {2}.. recorded)" -f $day, ($archBytes/1MB), $shaDest.Substring(0,8))
                }
              } else {
                $errors++
                Log ("WARN  {0}: GDrive copy size mismatch -> local kept, retry next run" -f $day)
              }
            } catch {
              $errors++
              Log ("WARN  {0}: GDrive copy failed: {1} -> local kept, retry next run" -f $day, $_.Exception.Message)
            }
          }
        } else {
          Log ("WARN  GDriveDir not mounted ({0}) -> off-site deferred, local kept" -f $GDriveDir)
        }
      }
    } else {
      $errors++
      # #322: a failed pack leaves a PARTIAL archive on disk, and the re-upload
      # pass below ships whatever carries the canonical name — measured 04/10:
      # captures-2026-09-30.7z truncated mid-pack (93 MB standing in for 22 GB
      # of input) went off-site as a valid archive, and the next nights kept
      # retrying against the corpse. Quarantine the partial the moment the pack
      # fails: rename (reversible, never delete), suffix AFTER ".7z" so the
      # captures-*.7z filter, the day parser and every reader exclude it
      # structurally. The loose files are kept below, so the next run re-packs
      # the day from scratch instead of appending to a corpse. If the rename
      # itself fails, the partial keeps its canonical name — but the re-upload
      # pass now tests every archive with `7z t` before shipping it, so the two
      # guards cover each other.
      if (Test-Path -LiteralPath $archivePath) {
        $qTs = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmss')
        $qPath = "$archivePath.partial-$qTs"
        $n = 1
        while (Test-Path -LiteralPath $qPath) { $n++; $qPath = "$archivePath.partial-$qTs-$n" }
        try {
          Rename-Item -LiteralPath $archivePath -NewName (Split-Path $qPath -Leaf) -ErrorAction Stop
          Log ("QUARANTINE {0}: partial archive renamed to {1} (add rc={2} test rc={3}) - loose files kept for re-pack" -f $day, (Split-Path $qPath -Leaf), $addRc, $testRc)
        } catch {
          Log ("WARN  {0}: quarantine rename failed ({1}) - partial LEFT under canonical name, the 7z t re-upload gate must catch it" -f $day, $_.Exception.Message)
        }
      }
      Log ("ERROR {0}: 7z add rc={1} test rc={2} -> KEEPING loose files (not deleted)" -f $day, $addRc, $testRc)
    }
  }
}

# --- stranded archive in the capture ROOT (#418, the same shape as the partial)
# Every pass above walks $ArchiveDir, and the compress loop enumerates only
# req-*/resp-* loose files — so a canonical captures-<day>.7z that ends up in
# $CaptureDir ITSELF is invisible to all three: never re-uploaded, never
# re-packed, never purged. Measured on the hub 2026-10-08: a 500 MB
# captures-2026-09-30.7z sitting in the root, byte-identical to its off-site copy.
# Relocate it into $ArchiveDir — a REVERSIBLE move, never a delete — so the
# re-upload, sha re-check and retention passes below own it from this line on and
# apply their own proof gates. Placed here, after the compress loop: moving an
# archive for a day that still has loose files could make `7z a` APPEND to it.
# A name this run does not own, or a collision with a file already in the
# archive dir, is left exactly where it is and said out loud — never guessed at.
if (Test-Path -LiteralPath $ArchiveDir) {
  foreach ($stray in (Get-ChildItem -LiteralPath $CaptureDir -Filter 'captures-*.7z' -File)) {
    if (-not (Get-CaptureArchiveDay -Name $stray.Name)) { continue }
    if ((Get-CaptureArchiveMachineTag -Name $stray.Name) -ne $MachineTag) { continue }
    $strayTarget = Join-Path $ArchiveDir $stray.Name
    if (Test-Path -LiteralPath $strayTarget) {
      Log ("WARN  stranded archive {0} in the capture root has a namesake in the archive dir - LEFT in place, resolve by hand" -f $stray.Name)
      continue
    }
    if ($PSCmdlet.ShouldProcess($stray.FullName, ("relocate stranded archive into the archive dir: {0}" -f $stray.Name))) {
      Move-Item -LiteralPath $stray.FullName -Destination $strayTarget
      Log ("RELOCATE stranded archive {0} from the capture root into the archive dir (the retention/re-upload passes own it from here)" -f $stray.Name)
    }
  }
}

# --- re-upload pass: retry any local archive whose GDrive copy is MISSING. A
# destination that exists at a DIFFERENT size is not retried — it is refused
# (#208): that file belongs to another producer on this name, and re-uploading
# would silently destroy it (the pre-#208 code copied blind exactly then).
# Without the missing-copy retry, a night where the Drive was unmounted strands
# the archive locally forever: with KeepLocalDays=0 the compress loop above
# never revisits an already-archived day, so nothing would ever retry the copy
# and the purge would (correctly) refuse to delete it. Ported from PR #64,
# which otherwise duplicated #63 but kept the pre-migration GDrive path.
if ($GDriveDir -and (Test-Path -LiteralPath $ArchiveDir) -and (Test-Path -LiteralPath $GDriveDir)) {
  foreach ($arch in (Get-ChildItem -LiteralPath $ArchiveDir -Filter 'captures-*.7z' -File)) {
    # Only ever re-upload archives this run OWNS. A machine that once ran
    # untagged and now carries a tag still has those old names on disk; pushing
    # them would walk straight back into the collision the tag exists to close.
    if ((Get-CaptureArchiveMachineTag -Name $arch.Name) -ne $MachineTag) { continue }
    $dest = Join-Path $GDriveDir $arch.Name
    $destItem = Get-Item -LiteralPath $dest -ErrorAction SilentlyContinue
    $destBytes = 0L
    if ($destItem) { $destBytes = $destItem.Length }
    $verdict = Get-OffsiteWriteVerdict -DestExists ([bool]$destItem) -DestBytes $destBytes -LocalBytes $arch.Length
    if ($verdict.Action -eq 'refuse') {
      $errors++
      Log ("REFUSE {0}: off-site {1} -> local kept, NOT overwritten" -f $arch.BaseName, $verdict.Reason)
      continue
    }
    if ($verdict.Action -eq 'idempotent') {
      Log ("GDRIVE {0}: already current ({1} bytes), idempotent - no re-upload needed" -f $arch.BaseName, $arch.Length)
      continue
    }
    # #322: the verdict only compares SIZES — it cannot know the local archive
    # itself is unreadable (the 04/10 incident: a pack truncated mid-run, left
    # under the canonical name, shipped off-site as valid). Whatever produced
    # the file, it must pass its own integrity test before leaving the machine.
    # Refuse + error (non-zero night for the scheduler), never rename here:
    # for an OLD day the loose originals are long gone, so renaming its only
    # copy on a possibly-transient test failure would hide the day from every
    # reader without helping anyone — the log line is the escalation.
    & $SevenZip t -bso0 -bsp0 "$($arch.FullName)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $errors++
      Log ("REFUSE {0}: local archive fails 7z t (rc={1}) -> NOT uploaded, kept local for review" -f $arch.BaseName, $LASTEXITCODE)
      continue
    }
    try {
      Copy-Item -LiteralPath $arch.FullName -Destination $GDriveDir -Force -ErrorAction Stop
      if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq $arch.Length) {
        # #389: same deposit discipline as the in-loop upload - hash both sides,
        # refuse on drift, record the destination hash as the off-site reference.
        $shaLocal = (Get-FileHash -LiteralPath $arch.FullName -Algorithm SHA256).Hash
        $shaDest  = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
        if ($shaLocal -ne $shaDest) {
          $errors++
          Log ("WARN  {0}: re-upload SHA mismatch after size-equal copy (local {1}.. vs dest {2}..) -> kept local, retried next run" -f $arch.BaseName, $shaLocal.Substring(0,8), $shaDest.Substring(0,8))
        } else {
          $manifestPath = Get-ShaManifestPath -GDriveDir $GDriveDir -MachineTag $MachineTag
          $null = Update-ShaManifest -Path $manifestPath -Archive $arch.Name `
                   -Sha256 $shaDest -Bytes $arch.Length `
                   -RecordedUtc ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
          Log ("GDRIVE {0}: re-uploaded ({1:N1} MB, was missing, sha256 {2}.. recorded)" -f $arch.BaseName, ($arch.Length/1MB), $shaDest.Substring(0,8))
        }
      } else {
        $errors++
        Log ("WARN  {0}: re-upload size mismatch -> kept local, retried next run" -f $arch.BaseName)
      }
    } catch {
      $errors++
      Log ("WARN  {0}: re-upload failed: {1} -> kept local, retried next run" -f $arch.BaseName, $_.Exception.Message)
    }
  }
}

# --- rotating off-site sha re-check (#389): every night, re-hash a small,
# deterministically rotating sample of the manifests this machine owns and
# compare against the hash recorded at deposit. This is the ONLY guard that can
# see content drift at EQUAL size on the off-site copy - #208 compares sizes,
# #322 tests readability, and neither knows what the bytes should be. Drift
# surfaces as a loud ERROR and a non-zero night (the scheduler's escalation
# path), never as a deletion: the manifest names the expected hash, the log
# names both hashes, and the operator arbitrates.
# Cost note: re-hashing reads the file through DriveFS, which hydrates it into
# the local content cache - bounded to -ShaCheckCount files a night, and DriveFS
# evicts under pressure. 0 disables the re-check (escape hatch, like every knob).
if ($GDriveDir -and (Test-Path -LiteralPath $GDriveDir) -and $ShaCheckCount -gt 0) {
  $manifestPath = Get-ShaManifestPath -GDriveDir $GDriveDir -MachineTag $MachineTag
  $m = Read-ShaManifest -Path $manifestPath
  if ($m.BadLines -gt 0) {
    Log ("WARN  sha manifest has {0} unparseable line(s) ({1}) - skipped, other entries still checked" -f $m.BadLines, $manifestPath)
  }
  $names = @($m.Entries.Keys | Sort-Object)
  if ($names.Count -gt 0) {
    $sample = Select-ShaRotation -Names $names -Count $ShaCheckCount -SeedDateUtc (Get-Date).ToUniversalTime()
    foreach ($name in $sample) {
      $rec = $m.Entries[$name]
      $live = Join-Path $GDriveDir $name
      if (-not (Test-Path -LiteralPath $live)) {
        $errors++
        Log ("ERROR SHA-CHECK {0}: recorded in manifest but ABSENT off-site (recorded {1}, {2} bytes) - never overwritten here, investigate" -f $name, $rec.recorded, $rec.bytes)
        continue
      }
      $liveSha = (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash
      if ($liveSha -ne $rec.sha256) {
        $errors++
        Log ("ERROR SHA-CHECK {0}: CONTENT DRIFT at destination (recorded {1}.., live {2}.., {3} bytes recorded vs {4} live) - equal-size drift is invisible to every other guard" -f $name, $rec.sha256.Substring(0,8), $liveSha.Substring(0,8), $rec.bytes, (Get-Item -LiteralPath $live).Length)
      } else {
        Log ("SHA-CHECK {0}: OK (matches deposit hash {1}..)" -f $name, $liveSha.Substring(0,8))
      }
    }
  }
}

# --- local retention purge: delete archives older than KeepLocalDays, ONLY if
# confirmed present (and same size) on GDrive. This bounds local disk; GDrive
# keeps the full history. With KeepLocalDays=0 the purge runs on every local
# archive — including the one just uploaded this run — so GDrive (online-only)
# is the single home of history. If GDriveDir is unset or not mounted, purge is
# skipped entirely (safe default — never delete without an off-site copy;
# a DriveFS outage just lets local archives accumulate until it returns).
if ($KeepLocalDays -ge 0 -and $GDriveDir -and (Test-Path -LiteralPath $ArchiveDir) -and (Test-Path -LiteralPath $GDriveDir)) {
  $purgeCutoff = (Get-Date).ToUniversalTime().Date.AddDays(-$KeepLocalDays)
  $purged = 0; $purgeSkipped = 0
  foreach ($arch in (Get-ChildItem -LiteralPath $ArchiveDir -Filter 'captures-*.7z' -File)) {
    if ((Get-CaptureArchiveMachineTag -Name $arch.Name) -ne $MachineTag) { continue }
    $archDay = Get-CaptureArchiveDay -Name $arch.Name
    if (-not $archDay) { continue }   # unparseable name: skip, never guess before deleting
    $dayDate = [datetime]::ParseExact($archDay, 'yyyy-MM-dd', $null)
    if ($dayDate -ge $purgeCutoff) { continue }   # within retention window
    $dest = Join-Path $GDriveDir $arch.Name
    # Require off-site copy to exist AND match local size before deleting.
    if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq $arch.Length) {
      if ($PSCmdlet.ShouldProcess($arch.FullName, "purge local (retention={0}d, confirmed on GDrive)" -f $KeepLocalDays)) {
        Remove-Item -LiteralPath $arch.FullName -Force
        $purged++
      }
    } else {
      $purgeSkipped++
    }
  }
  if ($purged -gt 0 -or $purgeSkipped -gt 0) {
    Log ("PURGE retention={0}d: {1} local archive(s) deleted, {2} kept (not yet on GDrive)" -f $KeepLocalDays, $purged, $purgeSkipped)
  }
}

# --- quarantined-partial purge (#418): the missing other half of #322 --------
# #322 renames a failed pack's partial to captures-<day>[-<tag>].7z.partial-<ts>
# precisely so the `captures-*.7z` selector skips it. But the retention purge
# above uses that SAME selector, so a quarantined corpse is unreachable by both
# scans — never re-uploaded (correct) and never removed (not intended by
# anyone). Measured on the hub 2026-10-08: a 97 MB corpse written 10-05 was
# still there 7 days later, unreadable (`7z l` answers "Cannot open the file as
# archive"). This pass is the explicit, narrowly-scoped selector the quarantine
# naming needs: `-Filter 'captures-*.7z.partial-*'`.
#
# What it deletes — and only that: a partial whose DAY is already preserved
# off-site under its canonical tagged name AND whose off-site copy matches the
# size recorded at deposit. The manifest is written only after a verified
# upload, so a matching record proves the day survived the pack that failed.
# A partial whose day is not provably off-site is KEPT: that is the whole point
# of quarantining instead of deleting, and a failed pack is exactly when the day
# is least likely to be safe yet. It is independent of $KeepLocalDays — a corpse
# is dead weight the moment its day is safe, whatever the retention window.
if ($GDriveDir -and (Test-Path -LiteralPath $ArchiveDir) -and (Test-Path -LiteralPath $GDriveDir)) {
  $qPurged = 0; $qNotOffsite = 0; $qUnproven = 0
  $qManifest = Read-ShaManifest -Path (Get-ShaManifestPath -GDriveDir $GDriveDir -MachineTag $MachineTag)
  foreach ($q in (Get-ChildItem -LiteralPath $ArchiveDir -Filter 'captures-*.7z.partial-*' -File)) {
    $qInfo = Get-CapturePartialInfo -Name $q.Name
    if (-not $qInfo) { continue }                    # not a quarantine of ours: skip, never guess
    if ($qInfo.Tag -ne $MachineTag) { continue }     # another producer's partial on a shared mount
    $qDestItem = Get-Item -LiteralPath (Join-Path $GDriveDir $qInfo.Canonical) -ErrorAction SilentlyContinue
    if (-not $qDestItem) { $qNotOffsite++; continue }
    $qRec = $qManifest.Entries[$qInfo.Canonical]
    if (-not $qRec -or $qRec.bytes -ne $qDestItem.Length) { $qUnproven++; continue }
    # Parenthesised: in a METHOD argument list the comma separates arguments, so
    # a bare `-f $a, $b` here would bind only $a and strand the {1} placeholder.
    if ($PSCmdlet.ShouldProcess($q.FullName, ("purge quarantined partial (day {0} confirmed off-site at {1} bytes)" -f $qInfo.Day, $qDestItem.Length))) {
      Remove-Item -LiteralPath $q.FullName -Force
      $qPurged++
    }
  }
  if ($qPurged -gt 0 -or $qNotOffsite -gt 0 -or $qUnproven -gt 0) {
    Log ("QUARANTINE purge: {0} partial(s) deleted, {1} kept (day not off-site), {2} kept (no matching deposit record)" -f $qPurged, $qNotOffsite, $qUnproven)
  }
}

if ($totalArch -gt 0) {
  $tr = [Math]::Round($totalRaw / $totalArch, 1)
  Log ("SUMMARY: {0} day(s), {1} files, {2:N1} MB -> {3:N1} MB ({4}:1)" -f `
       $daysToArchive.Count, $totalFiles, ($totalRaw/1MB), ($totalArch/1MB), $tr)
}
Log "END (errors=$errors)"
exit $errors
