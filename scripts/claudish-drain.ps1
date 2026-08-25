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
# max 10, mean 5.1 — a loaded half-hour that never reached 0. A ~2-day
# population probe (2026-08-25, 92 364 samples) corrects that window: min 0,
# 4.62% of samples at zero, P(activeStreams hits 0 within 300s) = 57.5%
# (73.4% within 600s). The floor IS zero; lulls are just brief (mean 5.9s),
# so the drain must fire on the FIRST zero sample, without confirmation.
#
# Since PR #37 the proxy reports the count:
#     GET /health -> {"status":"ok","activeStreams":8,"uptimeSec":1132}
# which lets a restart pick its moment instead of guessing.
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
    [int]$MaxWaitSec = 600,
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

        Phase 1 — wait for a TRUE zero. The hub's floor is zero (92 364-sample
        population probe, 2026-08-25: min 0, 4.62% of samples at zero) and a
        zero arrives within 300s on 57.5% of restarts (73.4% within 600s).
        During $ObserveSec the target stays at -1, so ONLY an activeStreams==0
        sample breaks the loop — a zero-cost restart. Lulls are brief (mean
        5.9s), so we fire on the first zero sample without confirmation:
        confirming costs a whole lull.

        Phase 2 — adaptive fallback for the ~43% unfavorable draws. After
        $ObserveSec with no zero, the target becomes the observed $seenMin and
        each subsequent miss relaxes it by one every $RelaxSec, which bounds
        the wait: the restart lands at a below-average moment instead of a
        random one. Replaying the 2026-08-23 samples, this adaptive stage
        alone shaved per-restart cost from mean 5.19 (blind docker restart)
        to 3.65, worst 10 -> 6. Relaxing faster undoes the gain (mean 4.67).

        Budget: $MaxWaitSec defaults to 600 — 300s of true-zero wait, then
        ~300s of adaptive search. The 04:00 daily restart can afford 10 min.
    #>
    param(
        [string]$Reason = "unspecified",
        [string]$Container = $ContainerName,
        [string]$Url = $ProxyUrl,
        [int]$MaxWait = $MaxWaitSec,
        [int]$ObserveSec = 300,
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
                    Write-DrainLog "RESTART ($Reason): no zero within ${ObserveSec}s — giving up the zero wait, quietest was $seenMin stream(s); waiting for a moment at or below that"
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
        # Decision instant: loop exit. Instrumented 2026-08-25 per the replay
        # study (msg 14:41/14:47) — the decision->action delay d dominates the
        # zero-loss rate (5.9s mean lulls), so we measure it instead of
        # inferring it: script share exactly, Docker share bounded.
        $decisionAt = Get-Date
        $decisionCount = $active
        if ($null -eq $active) {
            # signal lost mid-drain; already logged
        } elseif ($active -gt 0) {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), waited ${waited}s, restarting at $active in flight (quietest seen: $seenMin). Those $active clients will see 'Connection lost mid-response'."
        } else {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), waited ${waited}s, 0 in flight — no client interrupted"
        }
    }

    # Latency probe: last sample + clock just before the SIGTERM window.
    # decision->action (script share of d) is exact; the docker restart
    # brackets below bound the SIGTERM window (docker share of d).
    if ($null -ne $decisionCount) {
        $preRestartCount = Get-ClaudishActiveStreams -Url $Url
        $preRestartAt = Get-Date
        $scriptDelayMs = [int](($preRestartAt - $decisionAt).TotalMilliseconds)
        Write-DrainLog "RESTART ($Reason): decision->action ${scriptDelayMs}ms; streams at decision $decisionCount, at action $($preRestartCount)"
    }
    $restartAt = Get-Date
    docker restart $Container 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-DrainLog "RESTART ($Reason): docker restart $Container FAILED (exit $LASTEXITCODE)"
        return $false
    }
    $restartDoneAt = Get-Date
    $restartSecs = [int](($restartDoneAt - $restartAt).TotalSeconds)
    Write-DrainLog "RESTART ($Reason): docker restart returned in ${restartSecs}s — SIGTERM delivered within this window"
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
