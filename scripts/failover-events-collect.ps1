# Claudish failover-events collector — writes the proxy's [Failover] lines to
# a file, because a recreate destroys both the docker log and process memory.
#
# WHY (jsboige/claudish#347, from #331 Q2). The hub's failover markers (ARMED /
# DISARMED / walled / failed / DWELL / CLOSED / RECOVERED) live only in
# `docker logs` and in the failover state's process memory. A recreate
# destroys both, walls and all: the 04/10 window that produced the "408 walls
# on haiku[1]" was lost at the 05/10 07:58:44Z recreate, so the breakdown
# #331 asks for can no longer be rebuilt — and failed cascade attempts leave
# no resp-* capture either (0 *kimi* files on 04/10 and 05/10 although the
# Kimi step walled on both days). Any past-window question about walls dies at
# the next recreate. This file is where they survive.
#
# IT WRITES `[Failover]` LINES ONLY, AND THAT IS A SECURITY PROPERTY (the
# #192 lesson, applied from the start rather than after an incident): a
# `docker logs` window contains request lines, body previews with user text,
# and Authorization-looking strings. The allowlist is the exact token
# `[Failover]` — enforced at the SINK (Select-FailoverLines), testable with no
# docker at all, so a line without the marker never reaches the file whatever
# the daemon hands back. Widening the capture to other markers is deliberately
# out of scope: each marker needs its own allowlist review.
#
# THERE IS NO ACTUATOR HERE, deliberately. Collecting is not acting (#173).
# A static test in scripts/tests/claudish-failover-events.Tests.ps1 walks
# this file's AST and refuses any Restart-*/Stop-*/docker stop|restart|kill|
# rm|compose/-Verb RunAs.
#
# RECREATE-SAFE BY NAME + ID: the container is addressed by NAME (the recreate
# keeps the name), and each tick probes /health for the per-process
# `instanceId` (#156) — a change is recorded in the state file's tick record,
# so a window that spans a recreate is visible from the file.
#
# DRY RUN before installing (Register-ScheduledTask has no -WhatIf):
#   powershell -ExecutionPolicy Bypass -File <this file> -ClaudishHome $env:TEMP\fe-dry
# then inspect %TEMP%\fe-dry\failover-events.log + -state.json — the values
# are the ones the task will write, from the same code path. Only then:
#   schtasks /create /tn "ClaudishFailoverEvents" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Dev\claudish\scripts\failover-events-collect.ps1" /sc minute /mo 15 /ru SYSTEM /rl HIGHEST /f
# and verify by RE-READING the registered task (not by trusting the create):
#   schtasks /query /tn "ClaudishFailoverEvents" /v /fo list
# On a machine whose operator is not `jsboi`, append
#   -ClaudishHome C:\Users\<op>\.claudish  (and -HealthUrl when not :3000)
#
# Outputs, both under <ClaudishHome>:
#   failover-events.log         append-only NDJSON, one kept line per record:
#                               {ts, line, container, instanceId}
#   failover-events-state.json  last tick + bounded history + dedup ring
#
# The state file is what makes a DEAD collector distinguishable from a QUIET
# proxy: an empty log means nothing on its own (the grep -L-over-zero-bytes
# trap). One tick record per run, bounded — that history answers "was the
# collector even running at 03:49Z?" from a file.
#
# Targets PowerShell 5.1 (the scheduled task runs powershell, not pwsh).

param(
    # See the install block above for why this cannot be derived at runtime.
    [string]$ClaudishHome = "C:\Users\jsboi\.claudish",

    # Addressed by NAME: a recreate keeps the name, so the tick after a
    # recreate simply reads the new container (its log starts over — the file
    # and the dedup ring are what carry the history across).
    [string]$Container = "claudish-proxy",

    # Where /health is probed for the per-process instanceId. '' disables the
    # probe (instanceId recorded as '').
    [string]$HealthUrl = "http://127.0.0.1:3000/health",

    # First-run lookback and fallback on an unreadable watermark. Unlike
    # `docker events` there is no ~35 min ring: --since over a log that holds
    # more simply returns more. 30 min bounds the FIRST window only.
    [int]$LookbackMinutes = 30,

    # docker logs self-terminates; this bound only guards a wedged CLI.
    [int]$DockerTimeoutSec = 60,

    [long]$MaxLogBytes = 5242880,
    [int]$KeepRotated = 5,

    # Bounded tick history (96 ticks = 24 h at 15 min) and dedup ring size.
    [int]$HistoryCap = 96,
    [int]$SeenCap = 200
)

$ErrorActionPreference = "Stop"
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture

if (-not (Test-Path -LiteralPath $ClaudishHome)) {
    throw "ClaudishHome '$ClaudishHome' does not exist. Pass -ClaudishHome <path> in the scheduled-task command line."
}

Import-Module (Join-Path $PSScriptRoot 'lib\claudish-engine.psm1') -Force

$LogPath   = Join-Path $ClaudishHome 'failover-events.log'
$StatePath = Join-Path $ClaudishHome 'failover-events-state.json'

function Read-CollectorState {
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        # A corrupt state file must not stop collection: losing the watermark
        # costs one lookback window, losing the tick costs the wall history.
        return $null
    }
}

function Write-CollectorState {
    param($State)
    try {
        $json = $State | ConvertTo-Json -Depth 6
        # No BOM: Add-Content/-Encoding UTF8 writes one on file creation under
        # 5.1, and a BOM in front of the first `{` makes the state file
        # unparseable by ConvertFrom-Json — the collector would then re-read a
        # 30-minute lookback on every tick, forever, with no error.
        [System.IO.File]::WriteAllText($StatePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        Write-Output ("[failover-events] state write failed: {0}" -f $_.Exception.Message)
    }
}

function Get-InstanceId {
    # Per-process id published at /health (#156). A probe failure is not a
    # collection failure: the id is recorded as '' and the tick carries on.
    if ([string]::IsNullOrWhiteSpace($HealthUrl)) { return $null }
    try {
        $h = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 5
        if ($null -ne $h -and $h.PSObject.Properties['instanceId']) {
            return ([string]$h.instanceId)
        }
        return $null
    } catch { return $null }
}

# ---- one tick ---------------------------------------------------------------

$tickStart = (Get-Date).ToUniversalTime()
$state = Read-CollectorState

# NEVER `[string]$state.SinceUtc` — the culture round-trip broke the
# docker-events collector on its second tick (measured 2026-09-20):
# ConvertFrom-Json hands back a [datetime], [string] renders it in the
# ambient culture, and docker refuses it. Render invariant or fall back.
$sinceUtc = ''
$sinceSource = 'lookback'
if ($null -ne $state) {
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

# `docker logs` self-terminates (unlike `docker events`), so the bound is a
# guard, not the window close. --timestamps prefixes BOTH container streams.
#
# WATERMARK = THE INSTANT BEFORE THIS CALL, NOT AFTER IT (measured 05/10).
# `docker logs --since` (no --follow) snapshots the log when the daemon is
# ASKED, but the process only RETURNS seconds later while it streams the dump
# out. Taking the watermark at return opened a permanent hole: on the live run
# a burst written at 15:57:18-25Z (22 markers) was absent from the 15:57:16
# snapshot yet EARLIER than the 15:57:29 return instant, so the next tick's
# `--since 15:57:29` excluded it — read by neither window, ever. Anchoring on
# the pre-invocation instant instead makes the next window overlap this one by
# the call's own latency, and Select-NewFailoverLines' ring drops the re-read.
$windowStartUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $Invariant)
$res = Invoke-DockerEventsBounded -DockerArgs @('logs', $Container, '--since', $sinceUtc, '--timestamps') -TimeoutSec $DockerTimeoutSec

# Container stderr lands in ErrorText (the hub's [Failover] markers are
# logStderr-class): merge it into the line pool ONLY on a successful
# invocation — on a failure the pool is not trusted and nothing is written.
# The merged pool feeds the coherence probe too (never the sink: the
# allowlist still gates every write).
$pool = @($res.Lines)
if ($res.Ok -and -not [string]::IsNullOrWhiteSpace($res.ErrorText)) {
    $pool += @($res.ErrorText -split "`r?`n" | Where-Object { $_ })
}
$pool = @($pool | Where-Object { $_ })

# STALE-SEGMENT COHERENCE PROBE (review of PR #357, 2026-10-06): the third
# path into the "collector dead / proxy calm" ambiguity. On the json-file
# driver after a rotation, `docker logs --since` can serve the PREVIOUS
# segment instead of the current one — no error, no warning (measured on
# ai-01 and po-2025 on 06-07/09, three epochs, three times; reproduced on
# .46 on 04/10; po-203 does not have the defect; traffic-live.ps1 GOTCHA #2
# carries a tail-depth fallback against the same signature). The collector
# then receives old lines or nothing, Invoke-DockerEventsBounded renders Ok,
# an open-instant watermark ADVANCES, and the tick certifies a window nobody
# read. The discriminator is the one traffic-live.ps1 measured reliable: a
# SHORT tail probe (`--tail 1 --timestamps`, the only mode that never lies
# where --since can). The verdict is pure logic
# (Test-DockerLogsSinceCoherence) and receives the RAW probe result — the
# transport truth there is the exit code, not the events-verdict Ok, because
# a healthy one-line tail can land entirely on the container's stderr.
# 'stale' or an inconclusive probe both hold the watermark and exit 1 — a
# tick not measured costs one tick, a swallowed window costs the history.
$coherence = @{ Verdict = 'untested'; Reason = 'not run' }
if ($res.Ok) {
    $tailProbe = Invoke-DockerEventsBounded -DockerArgs @('logs', $Container, '--tail', '1', '--timestamps') -TimeoutSec $DockerTimeoutSec
    $coherence = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines $pool -SinceUtc $sinceUtc
}
$measured = $res.Ok -and ($coherence.Verdict -eq 'coherent' -or $coherence.Verdict -eq 'coherent-silent')

# SPLIT FIRST, ALLOWLIST SECOND — both are pure functions from the module:
# the split drops docker's own non-prefixed noise, the allowlist drops
# everything that is not a [Failover] line (request lines, body previews,
# Authorization-looking strings: counted, never written).
# PIPELINE, not `+=`: a catch-up window (long collector gap) hauls tens of
# thousands of lines, and array-append in a loop is quadratic — the 400-min
# first-run window wedged past 120 s on exactly that (measured 05/10).
$parsed = @($pool | ForEach-Object { ConvertFrom-DockerLogLine -Line $_ } | Where-Object { $null -ne $_ })
$sel = Select-FailoverLines -Events $parsed
$failover = @($sel.Kept)

$seen = @()
if ($null -ne $state) {
    try { $seen = @($state.Seen) } catch { $seen = @() }
}
$new = Select-NewFailoverLines -Events $failover -Seen $seen -SeenCap $SeenCap

$instanceId = Get-InstanceId
$prevInstance = ''
if ($null -ne $state) { try { $prevInstance = [string]$state.InstanceId } catch { $prevInstance = '' } }
$instanceChanged = ($null -ne $instanceId -and $prevInstance -ne '' -and $instanceId -ne $prevInstance)

# NDJSON, one record per kept line: the LINE's own docker timestamp (not the
# collect instant), the line verbatim, the container name, the instanceId the
# proxy reported when the tick ran.
$written = 0
if ($measured -and $new.Kept.Count -gt 0) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($e in @($new.Kept)) {
        $rec = @{
            ts         = $e.Ts
            line       = $e.Rest
            container  = $Container
            instanceId = "$instanceId"
        }
        [void]$sb.AppendLine(($rec | ConvertTo-Json -Compress))
    }
    try {
        # UTF8 no BOM — a BOM corrupts exactly the first record, and the first
        # record of a rotation is the one a reader is most likely to want.
        [System.IO.File]::AppendAllText($LogPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
        $written = @($new.Kept).Count
    } catch {
        Write-Output ("[failover-events] append failed: {0}" -f $_.Exception.Message)
        $written = 0
    }
}

$watermark = Get-FailoverNextSince -InvocationOk $res.Ok -WindowStartUtc $windowStartUtc -PreviousSinceUtc $sinceUtc -CoherenceVerdict $coherence.Verdict

$record = [PSCustomObject]@{
    AtUtc            = $tickStart.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', $Invariant)
    Ok               = $measured
    Reason           = $res.Reason
    Coherence        = $coherence.Verdict
    # The probe's own reason carries the tail-1 instant — the one number that
    # separates "stale segment served" from "quiet log" when reading this
    # record days later.
    CoherenceReason  = $coherence.Reason
    SinceUtc         = $sinceUtc
    SinceSource      = $sinceSource
    LinesSeen        = $pool.Count
    FailoverLines    = $failover.Count
    # Dropped = allowlist refusals. Counted, never written: a number here says
    # "the filter worked", distinguishable from a simply quiet proxy.
    Dropped          = $sel.Dropped
    Written          = $written
    Skipped          = @($new.Skipped).Count
    InstanceId       = "$instanceId"
    InstanceChanged  = $instanceChanged
}

$newState = Add-DockerEventsTickRecord -State $state -Record $record -HistoryCap $HistoryCap
$newState | Add-Member NoteProperty SinceUtc $watermark.SinceUtc -Force
$newState | Add-Member NoteProperty WatermarkReason $watermark.Reason -Force
# The ring advances ONLY on a measured tick. Ingesting fingerprints from a
# window whose lines were never written (probe untested, stale segment, failed
# invocation) would make the re-read a skip on the next tick — the window
# swallowed exactly the way the CR of #357 forbids: a tick not measured costs
# one tick, a swallowed window costs the history.
if ($measured) {
    $newState | Add-Member NoteProperty Seen @($new.Seen) -Force
} else {
    $newState | Add-Member NoteProperty Seen @($seen | Where-Object { $null -ne $_ }) -Force
}
$newState | Add-Member NoteProperty InstanceId "$instanceId" -Force
Write-CollectorState -State $newState

# Rotation, same discipline as docker-events (size-based, newest N kept,
# sorted by the timestamp in the name — no filesystem date to trust).
if (Test-Path -LiteralPath $LogPath) {
    $bytes = 0
    try { $bytes = (Get-Item -LiteralPath $LogPath).Length } catch { $bytes = 0 }
    $plan = Get-DockerEventsRotationPlan -CurrentBytes $bytes -MaxBytes $MaxLogBytes -ExistingRotatedCount 0 -KeepRotated $KeepRotated
    if ($plan.Rotate) {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ', $Invariant)
        $target = Join-Path $ClaudishHome ("failover-events-{0}.log" -f $stamp)
        try {
            Move-Item -LiteralPath $LogPath -Destination $target -Force
            Write-Output ("[failover-events] rotated: {0} bytes -> {1}" -f $bytes, (Split-Path -Leaf $target))
            if ($KeepRotated -gt 0) {
                $rotated = @(Get-ChildItem -LiteralPath $ClaudishHome -Filter 'failover-events-*.log' -File -ErrorAction SilentlyContinue |
                    Sort-Object Name -Descending)
                if ($rotated.Count -gt $KeepRotated) {
                    foreach ($old in $rotated[$KeepRotated..($rotated.Count - 1)]) {
                        try { Remove-Item -LiteralPath $old.FullName -Force } catch { }
                    }
                }
            }
        } catch {
            Write-Output ("[failover-events] rotation failed: {0}" -f $_.Exception.Message)
        }
    }
}

if ($measured) {
    Write-Output ("[failover-events] ok since={0}({1}) lines={2} failover={3} dropped={4} written={5} skipped={6} instance={7} changed={8} coherence={9} -> next={10}" -f `
        $sinceUtc, $sinceSource, $pool.Count, $failover.Count, $sel.Dropped, $written, @($new.Skipped).Count, ("$instanceId").Substring(0, [Math]::Min(8, ("$instanceId").Length)), $instanceChanged, $coherence.Verdict, $watermark.SinceUtc)
    exit 0
}
# A failed invocation OR an incoherent window is NOT a measurement: the
# watermark was held, the window stays unread for the next tick, and the
# scheduler sees a non-zero exit. The stale-segment verdict is FATAL (never
# swallowed): a "measured" tick built on the previous rotation's segment is
# strictly worse than a held one — it certifies a window nobody read.
Write-Output ("[failover-events] NOT MEASURED — watermark held ({0}); coherence={1}; docker said: {2}; probe said: {3}" -f $watermark.Reason, $coherence.Verdict, $res.Reason, $coherence.Reason)
exit 1
