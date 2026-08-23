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
# Measured on the hub, 2026-08-23 17:10Z: 6 to 9 concurrent streams at any
# instant. A blind restart drops all of them.
#
# Since PR #37 the proxy reports the count:
#     GET /health -> {"status":"ok","activeStreams":8,"uptimeSec":1132}
# so a restart can wait for a quiet moment instead of guessing.
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
    [int]$MaxWaitSec = 120,
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
        Waits for in-flight streams to finish, then restarts the container.
        The wait is capped: a stuck stream must not defer a needed restart
        forever. When the cap wins, the log says how many clients were cut —
        the number is the point, since a silent restart looks identical to a
        clean one in the log.
    #>
    param(
        [string]$Reason = "unspecified",
        [string]$Container = $ContainerName,
        [string]$Url = $ProxyUrl,
        [int]$MaxWait = $MaxWaitSec
    )

    $active = Get-ClaudishActiveStreams -Url $Url
    if ($null -eq $active) {
        Write-DrainLog "RESTART ($Reason): no activeStreams signal from $Url/health (proxy down, or image predates #37) — restarting without drain"
    } else {
        $initial = $active
        $waited = 0
        while ($active -gt 0 -and $waited -lt $MaxWait) {
            Start-Sleep -Seconds 5
            $waited += 5
            $active = Get-ClaudishActiveStreams -Url $Url
            if ($null -eq $active) {
                Write-DrainLog "RESTART ($Reason): lost the activeStreams signal after ${waited}s — proceeding"
                break
            }
        }
        if ($null -eq $active) {
            # signal lost mid-drain; already logged
        } elseif ($active -gt 0) {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), drained ${waited}s, $active STILL in flight — restarting anyway (cap ${MaxWait}s). Those $active clients will see 'Connection lost mid-response'."
        } else {
            Write-DrainLog "RESTART ($Reason): started at $initial stream(s), drained ${waited}s, 0 in flight — no client interrupted"
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
