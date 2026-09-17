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
# 3. Deploying — a RESTART reloads neither the image nor .env, so shipping a
#    rebuilt image needs -Recreate (`docker compose up -d`) instead. Both forms
#    carry it (#124 — the standalone path used to drop the switch and silently
#    drain into a plain restart):
#      powershell -ExecutionPolicy Bypass -File scripts\claudish-drain.ps1 -Reason "deploy vX.Y" -Recreate -EnvFile "D:\claudish-shadow\.env"
#      . "$PSScriptRoot\claudish-drain.ps1"
#      Invoke-ClaudishDrainedRestart -Reason "deploy vX.Y" -Recreate -EnvFile "D:\claudish-shadow\.env"
#    Same drain, different action. Plain `docker compose up -d` would deploy
#    the image just as well, but at the cost of every in-flight agent turn.
#    -EnvFile is REQUIRED alongside -Recreate: docker compose interpolates
#    every ${VAR:-} in docker-compose.yml from its env file, and the hub keeps
#    the real one OUTSIDE the compose dir — a bare recreate re-created the
#    container with every CLAUDISH_FAILOVER_* empty (incident 2026-09-07,
#    cascades silently gutted). The compose dir's own .env is NOT trusted
#    either: on the hub it holds only CLAUDISH_PROXY_KEY. The script refuses
#    the recreate without a passing -EnvFile, before spending a drain.
#
# Targets PowerShell 5.1: scheduled tasks run `powershell`, not `pwsh`.
#
# READING drain.log
# - Timestamps are LOCAL time on the hub host (UTC+2 in summer), with no Z
#   marker — Get-Date at line 43. A Z-less local time is not a UTC time:
#   shift +2 before comparing against UTC-probe data.
# - "restarting at N in flight" is a LOWER BOUND on the clients interrupted,
#   not the cost. $active is a single 2s-poll sample, already stale when the
#   `docker restart` command runs: any stream started in the gap, or any
#   connection refused during the outage, is uncounted. Demonstrated live by
#   the first graceful restart (2026-08-27 02:05Z): drain.log wrote
#   "restarting at 2 in flight" while the probe measured 3 streams interrupted
#   across the same 12s outage — N is a minimum, the true cost is higher.
#
# RUNNING IT UNDER A SCHEDULED TASK
# The task's ExecutionTimeLimit must cover the drain budget, and the two move
# together. Incident 2026-08-26: with ObserveSec=300 and a PT5M limit, the
# scheduler killed the script exactly at the observe boundary — the adaptive
# phase and the `docker restart` NEVER ran, and the 04:00 restart silently
# did not happen (LastTaskResult=0, uptime 32h35). Raised to PT15M. Only the
# budget and the limit together reach `docker restart`; changing either alone
# recreates the silent non-restart.

param(
    [string]$ContainerName = "claudish-proxy",
    [string]$ProxyUrl = "http://localhost:3000",
    [int]$MaxWaitSec = 600,
    [string]$Reason = "manual",
    [string]$LogPath = "$env:USERPROFILE\.claudish\drain.log",
    # Interpolation env file for `docker compose` under -Recreate. See the
    # header: refusing beats silently recreating with empty ${VAR:-} values.
    [string]$EnvFile = "",
    # Standalone form of the function's deploy switch (#124): forwarded to
    # Invoke-ClaudishDrainedRestart below so `-File -Recreate` recreates
    # instead of silently draining into a plain `docker restart`.
    [switch]$Recreate
)

function Write-DrainLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    $dir = Split-Path $LogPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-ClaudishProbeUrl {
    <#
        Derives the probe URL from the container's published 3000/tcp mapping,
        or $null when docker cannot answer. Resolution must happen PER CALL on
        the container actually being drained (#110): $ProxyUrl defaults to
        :3000 (the hub), but sidecars publish other host ports (ai-01's
        listens on :3002), and a URL resolved at script/dot-source time binds
        to whatever $ContainerName held THEN — so a dot-sourced
        `Invoke-ClaudishDrainedRestart -Container <sidecar>` probed the hub's
        port, the health call answered nothing, Get-ClaudishActiveStreams
        returned $null ("no signal"), and the restart silently degraded to
        undrained. Measured on ai-01, 2026-09-14 and 2026-09-15.
    #>
    param([string]$Container)
    try {
        $published = (docker port $Container 3000/tcp 2>$null | Select-Object -First 1)
        if ($published -and $published -match ':(\d+)\s*$') {
            return "http://localhost:$($Matches[1])"
        }
    } catch { }
    return $null
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
        [int]$PollSec = 2,
        # A restart reloads NEITHER the image NOR .env: Docker restarts the
        # existing container, config and all. Deploying a rebuilt image or an
        # edited .env therefore needs a RECREATE, and without this switch the
        # only recreate available was an undrained `docker compose up -d` —
        # so every deployment cost every in-flight agent turn.
        [switch]$Recreate,
        # Interpolation env file for `docker compose up -d` ($Recreate only).
        [string]$EnvFile = "",
        [string]$ComposeDir = (Split-Path -Parent $PSScriptRoot)
    )

    # --env-file guard (incident 2026-09-07, EISDIR aftermath): docker compose
    # interpolates every ${VAR:-} in docker-compose.yml from its env file. The
    # hub's real values live OUTSIDE the compose dir (D:\claudish-shadow\.env),
    # so a bare `compose up -d` re-creates the container with every
    # CLAUDISH_FAILOVER_* empty — the cascades silently gutted, startup logs
    # `configured=0` instead of `configured=3`. Do NOT trust the compose dir's
    # own .env either: on the hub it holds only CLAUDISH_PROXY_KEY, so an
    # auto-detected "project .env" recreate would pass the guard and still gut
    # the cascades. -EnvFile is therefore REQUIRED with -Recreate, checked to
    # exist. Verified BEFORE the drain so a doomed recreate costs no
    # 10-minute drain wait.
    if ($Recreate) {
        if (-not $EnvFile) {
            Write-DrainLog "RECREATE REFUSED ($Reason): -Recreate requires -EnvFile — docker compose interpolates every `$\{VAR:-\} from it, and the hub's real file lives outside the compose dir (incident 2026-09-07: bare recreate emptied every CLAUDISH_FAILOVER_*). Pass -EnvFile D:\claudish-shadow\.env on the hub."
            return $false
        }
        if (-not (Test-Path -LiteralPath $EnvFile)) {
            Write-DrainLog "RECREATE REFUSED ($Reason): -EnvFile '$EnvFile' does not exist — nothing done (a recreate against a wrong or missing env file empties every CLAUDISH_FAILOVER_* variable)"
            return $false
        }
        Write-DrainLog "RECREATE ($Reason): interpolating from -EnvFile '$EnvFile'"
    }

    # Resolve the probe URL per call, from the container actually being
    # drained (#110): an explicit -Url wins; otherwise the container's
    # published 3000/tcp mapping overrides the :3000 default. Without this,
    # a dot-sourced call draining a sidecar probed the URL bound at
    # dot-source time (the hub's) and silently skipped the drain phase.
    if (-not $PSBoundParameters.ContainsKey('Url')) {
        $resolved = Get-ClaudishProbeUrl -Container $Container
        if ($resolved -and $resolved -ne $Url) {
            $Url = $resolved
            Write-DrainLog "DRAIN: probe URL derived from container '$Container' -> $Url"
        }
    }

    $active = Get-ClaudishActiveStreams -Url $Url
    if ($null -eq $active) {
        Write-DrainLog "RESTART ($Reason): no activeStreams signal from $Url/health for container '$Container' (wrong port? proxy down? image predates #37?) — restarting without drain"
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
    # -t must match stop_grace_period (120s, docker-compose.yml): the CLI flag
    # governs how long Docker waits between SIGTERM and SIGKILL, and without it
    # a docker-daemon default (10s) can truncate the graceful window #57 added.
    if ($Recreate) {
        Push-Location $ComposeDir
        try {
            $envArgs = @()
            if ($EnvFile) { $envArgs = @("--env-file", $EnvFile) }
            docker compose @envArgs up -d --timeout 120 2>&1 | ForEach-Object { Write-DrainLog "RECREATE ($Reason): $_" }
            $code = $LASTEXITCODE
        } finally { Pop-Location }
        if ($code -ne 0) {
            Write-DrainLog "RECREATE ($Reason): docker compose up -d FAILED (exit $code) in $ComposeDir"
            return $false
        }
        $verb = "docker compose up -d"
    } else {
        docker restart -t 120 $Container 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-DrainLog "RESTART ($Reason): docker restart $Container FAILED (exit $LASTEXITCODE)"
            return $false
        }
        $verb = "docker restart"
    }
    $restartDoneAt = Get-Date
    $restartSecs = [int](($restartDoneAt - $restartAt).TotalSeconds)
    Write-DrainLog "RESTART ($Reason): $verb returned in ${restartSecs}s — SIGTERM delivered within this window"
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
    $ok = Invoke-ClaudishDrainedRestart -Reason $Reason -Recreate:$Recreate -EnvFile $EnvFile
    exit $(if ($ok) { 0 } else { 1 })
}
