# Claudish docker-events collector — writes down container lifecycle events
# while they are happening, because `docker events` forgets them in ~35 min.
#
# WHY (jsboige/claudish#169). During the 2026-09-20 hub incident (5-6 restart
# windows 03:49Z→09:07Z plus a recreate at 09:13Z) nobody could attribute a
# single gesture: the daemon's ring buffer had evicted the `die` events with
# their exit codes, and RestartCount stayed 0 because the gestures were manual
# `compose up/start`, not the restart policy. The information existed while it
# was happening. This writes it to a file. Success criterion from the issue:
# the next unexplained restart window is attributable within one cycle, from a
# FILE, with no forensics archaeology.
#
# THERE IS NO ACTUATOR HERE, deliberately and by mandate. Collecting is not
# acting. A collector that "helpfully" restarts something on a suspicious event
# is how a remediation tore a host's Docker engine down on 2026-09-20 (#173):
# the teardown half was tested, the rebuild half never was. A static test in
# scripts/tests/claudish-docker-events.Tests.ps1 walks this file's AST and
# refuses any Restart-*/Stop-*/`docker stop|restart|kill`/-Verb RunAs.
#
# Install (run as admin), a 15-minute tick against a ring buffer of ~35 minutes:
#   schtasks /create /tn "ClaudishDockerEvents" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Dev\claudish\scripts\docker-events-collect.ps1" /sc minute /mo 15 /ru SYSTEM /rl HIGHEST /f
# On a machine whose operator is not `jsboi`, append the home:
#   ... -File <path>\docker-events-collect.ps1 -ClaudishHome C:\Users\<op>\.claudish
#
# Outputs, both under <ClaudishHome>:
#   docker-events.log         append-only NDJSON, one docker event per line
#   docker-events-state.json  last tick + a bounded history of ticks
#
# The state file is what makes a DEAD collector distinguishable from a QUIET
# daemon: an empty log means nothing on its own (same trap as a grep -L over a
# zero-byte capture, which reads as a violation when it is an absence of data).

param(
    # Root of the .claudish directory this writes into. Cannot be derived at
    # runtime: the scheduled task runs as SYSTEM, whose $env:USERPROFILE is the
    # system profile, where no .claudish exists. Default keeps existing installs
    # byte-identical.
    [string]$ClaudishHome = "C:\Users\jsboi\.claudish",

    # How long one window stays open. The process is KILLED at this bound, and
    # the kill IS the window close — measured 2026-09-20 on Docker Desktop
    # 29.8.0 (po-2024): `docker events` did not self-terminate in any of four
    # argument forms, including an explicit past `--until`. Kept comfortably
    # under the tick interval so two runs cannot overlap.
    [int]$WindowSec = 20,

    # First-run lookback, and the fallback whenever the stored watermark is
    # unreadable. Deliberately under the ~35 min ring buffer: asking for more
    # than the daemon still holds returns nothing, silently.
    [int]$LookbackMinutes = 30,

    # Rotation cap for docker-events.log, and how many rotated files to keep.
    [long]$MaxLogBytes = 5242880,
    [int]$KeepRotated = 5,

    # Bounded history of ticks kept in the state file (48 ticks ≈ 12h at 15 min).
    [int]$HistoryCap = 48
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ClaudishHome)) {
    throw "ClaudishHome '$ClaudishHome' does not exist. Pass -ClaudishHome <path> in the scheduled-task command line."
}

Import-Module (Join-Path $PSScriptRoot 'lib\claudish-engine.psm1') -Force

$LogPath   = Join-Path $ClaudishHome 'docker-events.log'
$StatePath = Join-Path $ClaudishHome 'docker-events-state.json'
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture

function Read-CollectorState {
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        # A corrupt state file must not stop collection: losing the watermark
        # costs one lookback window, losing the tick costs the incident.
        return $null
    }
}

function Write-CollectorState {
    param($State)
    try {
        $json = $State | ConvertTo-Json -Depth 6
        # No BOM. Add-Content/-Encoding UTF8 writes one on file creation under
        # Windows PowerShell 5.1, and a BOM in front of the first `{` makes the
        # state file unparseable by ConvertFrom-Json — the collector would then
        # re-read a 30-minute lookback on every tick, forever, with no error.
        [System.IO.File]::WriteAllText($StatePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Output ("[docker-events] state write failed: {0}" -f $_.Exception.Message)
    }
}

function Write-EventsAppend {
    param([string[]]$JsonLines)
    if ($null -eq $JsonLines -or $JsonLines.Count -eq 0) { return 0 }
    $sb = New-Object System.Text.StringBuilder
    foreach ($l in $JsonLines) {
        if ([string]::IsNullOrWhiteSpace($l)) { continue }
        [void]$sb.AppendLine($l)
    }
    $text = $sb.ToString()
    if ($text.Length -eq 0) { return 0 }
    try {
        # UTF8 without BOM, for the same reason as the state file: a BOM on the
        # first line of an NDJSON file corrupts exactly the first event, and the
        # first event of a rotation is the one a reader is most likely to want.
        [System.IO.File]::AppendAllText($LogPath, $text, (New-Object System.Text.UTF8Encoding($false)))
        return ($text -split "`r?`n" | Where-Object { $_ }).Count
    } catch {
        Write-Output ("[docker-events] append failed: {0}" -f $_.Exception.Message)
        return 0
    }
}

function Invoke-RotationIfNeeded {
    $plan = Get-DockerEventsRotationPlan -CurrentBytes 0 -MaxBytes $MaxLogBytes -ExistingRotatedCount 0 -KeepRotated $KeepRotated
    if (-not (Test-Path -LiteralPath $LogPath)) { return }
    $bytes = 0
    try { $bytes = (Get-Item -LiteralPath $LogPath).Length } catch { return }
    $plan = Get-DockerEventsRotationPlan -CurrentBytes $bytes -MaxBytes $MaxLogBytes -ExistingRotatedCount 0 -KeepRotated $KeepRotated
    if (-not $plan.Rotate) { return }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ', $Invariant)
    $target = Join-Path $ClaudishHome ("docker-events-{0}.log" -f $stamp)
    try { Move-Item -LiteralPath $LogPath -Destination $target -Force } catch {
        Write-Output ("[docker-events] rotation failed: {0}" -f $_.Exception.Message)
        return
    }
    # Keep the newest N rotations, delete the rest. Sorted by name, which is the
    # timestamp — no filesystem date to trust.
    if ($KeepRotated -gt 0) {
        try {
            $rotated = @(Get-ChildItem -LiteralPath $ClaudishHome -Filter 'docker-events-*.log' -File |
                Sort-Object Name -Descending)
            if ($rotated.Count -gt $KeepRotated) {
                foreach ($old in $rotated[$KeepRotated..($rotated.Count - 1)]) {
                    try { Remove-Item -LiteralPath $old.FullName -Force } catch { }
                }
            }
        } catch { }
    }
    Write-Output ("[docker-events] rotated: {0} bytes -> {1}" -f $bytes, (Split-Path -Leaf $target))
}

# ---- one tick ---------------------------------------------------------------

$tickStart = (Get-Date).ToUniversalTime()
$state = Read-CollectorState

$sinceUtc = ''
$sinceSource = 'lookback'
if ($null -ne $state) {
    # NEVER `[string]$state.SinceUtc`. ConvertFrom-Json hands back a [datetime],
    # and [string] renders it in the ambient culture ("09/20/2026 17:34:59"),
    # which docker refuses with "failed to parse value as time or duration" —
    # measured on the first live tick, 2026-09-20. It only breaks from tick 2 on,
    # after state has been written, so tick 1 looks perfect.
    $candidate = $null
    try { if ($state.SinceUtc) { $candidate = ConvertTo-DockerSinceInstant -Value $state.SinceUtc } } catch { }
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
        $sinceUtc = $candidate
        $sinceSource = 'watermark'
    } else {
        $sinceSource = 'lookback-unreadable-watermark'
    }
}
if ([string]::IsNullOrWhiteSpace($sinceUtc)) {
    $sinceUtc = $tickStart.AddMinutes(-1 * $LookbackMinutes).ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $Invariant)
}

# Bounded. The kill closes the window; see -WindowSec.
$res = Invoke-DockerEventsBounded -DockerArgs @('events', '--since', $sinceUtc, '--filter', 'type=container', '--format', '{{json .}}') -TimeoutSec $WindowSec
$killInstant = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $Invariant)

# The window END is measured BEFORE parsing, so a slow parse cannot make the
# watermark jump past events the daemon had already emitted.
$parsed = @()
foreach ($line in @($res.Lines)) {
    $e = ConvertFrom-DockerEventLine -Line $line
    if ($null -ne $e) { $parsed += $e }
}

$seen = @()
if ($null -ne $state) {
    try { $seen = @($state.Seen) } catch { $seen = @() }
}
$sel = Select-NewDockerEvents -Events $parsed -Seen $seen -SeenCap 200

# Only the NEW events are appended; the fingerprint ring rides forward.
$written = 0
if ($sel.Kept.Count -gt 0) {
    $keptLines = @($res.Lines | Where-Object { $null -ne (ConvertFrom-DockerEventLine -Line $_) })
    # Match kept events back to their raw lines by fingerprint, so the file keeps
    # the provider's own bytes rather than a re-serialization of ours.
    $keepFp = @{}
    foreach ($k in $sel.Kept) { $keepFp[(Get-DockerEventFingerprint -Event $k)] = $true }
    $linesToWrite = @()
    foreach ($line in $keptLines) {
        $e = ConvertFrom-DockerEventLine -Line $line
        if ($null -eq $e) { continue }
        if ($keepFp.ContainsKey((Get-DockerEventFingerprint -Event $e))) {
            $linesToWrite += $line
            $keepFp.Remove((Get-DockerEventFingerprint -Event $e))
        }
    }
    $written = Write-EventsAppend -JsonLines $linesToWrite
}

$watermark = Get-DockerEventsNextSince -Events $sel.Kept -KillInstantUtc $killInstant -PreviousSinceUtc $sinceUtc -InvocationOk $res.Ok

# The group verdict is recorded as EVIDENCE, never as an attribution. It says
# whether many distinct containers moved together — the 2026-08-30 error was
# reading exactly that as a targeted action and naming a lane.
$verdict = Get-DockerEventGroupVerdict -Events $parsed -GroupSpanMs 1000 -MinContainers 5

$record = [PSCustomObject]@{
    AtUtc        = $tickStart.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $Invariant)
    Ok           = $res.Ok
    Reason       = $res.Reason
    SinceUtc     = $sinceUtc
    SinceSource  = $sinceSource
    EventCount   = $parsed.Count
    Written      = $written
    Skipped      = $sel.Skipped.Count
    Verdict      = $verdict.Verdict
    VerdictNote  = $verdict.Reason
}

$newState = Add-DockerEventsTickRecord -State $state -Record $record -HistoryCap $HistoryCap
$newState | Add-Member NoteProperty SinceUtc $watermark.SinceUtc -Force
$newState | Add-Member NoteProperty WatermarkReason $watermark.Reason -Force
$newState | Add-Member NoteProperty Seen @($sel.Seen) -Force
Write-CollectorState -State $newState

Invoke-RotationIfNeeded

Write-Output ("[docker-events] ok={0} reason={1} since={2}({3}) events={4} written={5} skipped={6} verdict={7} -> next={8}" -f `
    $res.Ok, $res.Reason, $sinceUtc, $sinceSource, $parsed.Count, $written, $sel.Skipped.Count, $verdict.Verdict, $watermark.SinceUtc)

if (-not $res.Ok) { exit 1 }
exit 0
