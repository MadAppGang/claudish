# Claudish — drain-then-restart (shared)
#
# A bare `docker restart` kills every in-flight SSE stream mid-body. Each client
# then reports:
#
#     API Error: Connection lost mid-response. The response above may be incomplete.
#
# and that agent turn is lost. The proxy never breaks a stream itself (there is
# no controller.error() in the codebase; every terminating path emits
# message_stop), so a client-visible mid-response drop means the process went
# away under it. Restarts are the main way that happens.
#
# Measured on the hub, 2026-08-23, 906 samples over 30 min: min 1, p50 5, p90 7,
# max 10, mean 5.1. It never reached 0 — the hub is never idle. So a restart
# always costs turns here; the only question is how many.
#
# Since PR #37 the proxy reports the count:
#     GET /health -> {"status":"ok","activeStreams":8,"uptimeSec":1132}
# which lets a restart pick its moment instead of guessing. It cannot wait for
# silence, because silence does not come.
#
# TWO WAYS TO USE IT
#
# 1. Standalone — replace `docker restart claudish-proxy` in a scheduled task:
#      powershell -ExecutionPolicy Bypass -File scripts\claudish-drain.ps1 -Reason "daily 04:00"
#
# 2. Dot-sourced — reuse the functions from another script:
#      . "$PSScriptRoot\claudish-drain.ps1"
#      Invoke-ClaudishDrainedRestart -Reason "confirmed hang"
#
# Targets PowerShell 5.1: scheduled tasks run `powershell`, not `pwsh`.

param(
    [string]$ContainerName = "claudish-proxy",
    [string]$ProxyUrl = "http://localhost:3000",
    [int]$MaxWaitSec = 300,
    [string]$Reason = "manual",
    [string]$LogPath = "$env:USERPROFILE\.claudish\drain.log"
)

function Write-DrainLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    $dir = Split-Path $LogPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-ClaudishActiveStreams {
    <#
        Returns the number of SSE responses currently streaming, or $null when
        the proxy cannot answer or predates PR #37. $null means "no signal" —
        callers must degrade to an undrained restart rather than block on a
        number that will never arrive.
    #>
    param([string]$Url = $ProxyUrl)
    try {
        $r = Invoke-WebRequest -Uri "$Url/health" -TimeoutSec 5 -UseBasicParsing
        $j = $r.Content | ConvertFrom-Json
        if ($null -eq $j.activeStreams) { return $null }
        return [int]$j.activeStreams
    } catch {
        return $null
    }
}

function Invoke-ClaudishDrainedRestart {
    <#
        Restarts the container at the quietest moment it can find.

        NOT "waits for zero". Measured on the hub 2026-08-23, 906 samples over
        30 min: activeStreams never once reached 0 (min 1, seen twice; p50 5,
        p90 7, max 10; the longest lull at <=2 lasted 6 seconds). A drain that
        waits for 0 on this hub can only time out and then restart at an
        arbitrary moment — which is what the first version of this function did.

        So the target is relative, not absolute. We watch for $ObserveSec to
        learn what "quiet" means for this hub right now, then fire on the first
        sample at or below that observed minimum. Each subsequent miss relaxes
        the target by one, which bounds the wait without a timeout deciding for
        us: the restart lands at a below-average moment instead of a random one.

        Replaying those 906 real samples through both versions, per restart:

            blind `docker restart`   mean 5.19   p90 7   worst 10
            this function            mean 3.65   p90 5   worst  6

        The defaults are the knee of that curve. A longer cap buys nothing
        (600s scored identically to 300s), and relaxing the target faster
        undoes the whole gain — at one step per poll the target outruns the
        hub and the mean goes back to 4.67.

        This shaves the cost; it does not remove it. On a hub that is never idle
        every restart cuts several agent turns, so the real mitigation is
        restarting less often, not draining better.
    #>
    param(
        [string]$Reason = "unspecified",
        [string]$Container = $ContainerName,
        [string]$Url = $ProxyUrl,
        [int]$MaxWait = $MaxWaitSec,
        [int]$ObserveSec = 60,
        [int]$RelaxSec = 30,
        [int]$PollSec = 2
    )

    $active = Get-ClaudishActiveStreams -Url $Url
    if ($null -eq $active) {
        Write-DrainLog "RESTART ($Reason): no activeStreams signal from $Url/health (proxy down, or image predates #37) — restarting without drain"
    } else {
        $initial = $active
        $waited = 0
        $seenMin = $active
        # -1 = still observing. Once set, it is the count we are willing to cut.
        $target = -1
        $sinceRelax = 0
        while ($waited -lt $MaxWait) {
            if ($active -le 0) { break }
            if ($target -ge 0 -and $active -le $target) { break }

            Start-Sleep -Seconds $PollSec
            $waited += $PollSec
            $sinceRelax += $PollSec
            $active = Get-ClaudishActiveStreams -Url $Url
            if ($null -eq $active) {
                Write-DrainLog "RESTART ($Reason): lost the activeStreams signal after ${waited}s — proceeding"
                break
            }
            if ($active -lt $seenMin) { $seenMin = $active }

            if ($target -lt 0) {
                if ($waited -ge $ObserveSec) {
                    $target = $seenMin
                    $sinceRelax = 0
                    Write-DrainLog "RESTART ($Reason): observed ${ObserveSec}s, quietest was $seenMin stream(s) — waiting for a moment at or below that"
                }
            } elseif ($sinceRelax -ge $RelaxSec) {
                # Missed it. Relax by one so the wait ends on a chosen moment
                # rather than on the cap. Relaxing slowly is what pays: at one
                # step per poll the target outran the hub and the gain vanished
                # (4.67 vs 3.65 mean, replaying the 906 real samples).
                $target++
                $sinceRelax = 0
            }
        }
        if ($null -eq $active) {
            # signal lost mid-drain; already logged
        } elseif ($active -gt 0) {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), waited ${waited}s, restarting at $active in flight (quietest seen: $seenMin). Those $active clients will see 'Connection lost mid-response'."
        } else {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), waited ${waited}s, 0 in flight — no client interrupted"
        }
    }

    docker restart $Container 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-DrainLog "RESTART ($Reason): docker restart $Container FAILED (exit $LASTEXITCODE)"
        return $false
    }
    Start-Sleep -Seconds 20

    $after = Get-ClaudishActiveStreams -Url $Url
    if ($null -eq $after) {
        Write-DrainLog "RESTART ($Reason): container restarted, but /health not answering yet after 20s"
    } else {
        Write-DrainLog "RESTART ($Reason): container restarted, /health answering (activeStreams=$after)"
    }
    return $true
}

# Standalone mode: run the restart. Dot-sourced, define the functions only.
if ($MyInvocation.InvocationName -ne '.') {
    $ok = Invoke-ClaudishDrainedRestart -Reason $Reason
    exit $(if ($ok) { 0 } else { 1 })
}
