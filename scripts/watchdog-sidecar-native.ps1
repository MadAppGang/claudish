# Claudish sidecar watchdog — NATIVE-PROCESS variant (po-204 pattern)
#
# For a sidecar that is a bare OS process (bun launched by ~/.start-claudish-sidecar.ps1),
# not a docker container. The fleet watchdog (claudish-watchdog.ps1) closes a different
# failure: its Step 1 is `docker start`. Here the equivalent of "container not running"
# is "no process matching standalone-proxy on the port" — and the closer is the
# launcher script, which reads the cluster proxy key at runtime from
# ~/.claude/settings.json, so this file and the task definition carry no secrets.
#
# Decision table (Get-NativeWatchdogDecision):
#   process ABSENT            -> START immediately. Nothing is serving, so nothing is
#                                cut — the drain discipline that gates a container
#                                restart does not apply (there is no one to drain).
#   process alive + health OK -> OK, counter reset.
#   process alive + health KO -> WARN, no action, counter++. A single KO tick may be a
#                                boot in progress; killing on it would race the
#                                launcher. After UnhealthyKillThreshold consecutive KO
#                                ticks (~15 min at cadence 5) the process is a zombie
#                                that holds the port but serves nobody: KILL, then
#                                START. Clients of a zombie already have dead sockets;
#                                waiting longer only extends the outage.
#
# Install (current user, interactive — the launcher must run as the operator so
# homedir() resolves ~/.claudish/config.json):
#   schtasks /create /tn "ClaudishSidecarWatchdog" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Users\jsboi\.claudish\watchdog-sidecar-native.ps1" /sc minute /mo 5 /f
#
# Cadence 5 min bounds the kill-test recovery window at <=15 min (3 ticks), the same
# dimensioning po-2026 chose for its container watchdog.
#
# The script is committed here (fleet source of truth) and DEPLOYED as a copy in
# <ClaudishHome>, which the task points at: the repo checkout switches branches; the
# home copy does not. Each tick logs its own sha256 so "which revision is armed?" is
# a grep, not an archaeology.
#
# Logs to: <ClaudishHome>\watchdog-sidecar.log   State: <ClaudishHome>\watchdog-sidecar-state.json

param(
    [int]$Port = 3914,
    [string]$LauncherPath = "$env:USERPROFILE\.start-claudish-sidecar.ps1",
    [string]$ClaudishHome = "$env:USERPROFILE\.claudish",
    [int]$HealthTimeoutSec = 5,
    # Consecutive alive-but-unhealthy ticks before the kill-restart path. 3 ticks at
    # cadence 5 = ~15 min of tolerance for a slow boot, vs a zombie serving nobody.
    [int]$UnhealthyKillThreshold = 3,
    # Bounded wait for /health after a (re)start, polled every 2s.
    [int]$StartWaitSec = 30
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ClaudishHome)) {
    throw "ClaudishHome '$ClaudishHome' does not exist. Pass -ClaudishHome <path> in the scheduled-task command line."
}

$LogPath = Join-Path $ClaudishHome "watchdog-sidecar.log"
$StateFile = Join-Path $ClaudishHome "watchdog-sidecar-state.json"

function Write-WatchdogLog {
    param([string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss'Z'")
    # AppendAllText with an explicit no-BOM encoding: Add-Content -Encoding UTF8
    # writes a BOM on Windows PowerShell 5.1, which corrupts exactly the first
    # line for every greppable consumer (same trap as the docker-events collector).
    [System.IO.File]::AppendAllText($LogPath, "[$ts] $Message`r`n", [System.Text.UTF8Encoding]::new($false))
}

function Invoke-LogRotation {
    if ((Test-Path -LiteralPath $LogPath) -and ((Get-Item -LiteralPath $LogPath).Length -gt 5MB)) {
        Move-Item -LiteralPath $LogPath -Destination "$LogPath.old" -Force
    }
}

function Get-WatchdogState {
    if (Test-Path -LiteralPath $StateFile) {
        try { return (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch {}
    }
    return $null
}

function Set-WatchdogState {
    param([int]$ConsecutiveUnhealthy)
    $dir = Split-Path $StateFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    @{ consecutiveUnhealthy = $ConsecutiveUnhealthy } | ConvertTo-Json |
        Set-Content -Path $StateFile -Encoding UTF8
}

function Get-SidecarProcesses {
    # Match on the COMMAND LINE (standalone-proxy + --port N) AND on identity:
    # bun.exe with a live ProcessId. The command line alone is not identity — the
    # 27/09 kill-test caught a transient process whose command line matched the
    # pattern (ProcessId unreadable) while the real sidecar lay dead: the
    # watchdog read "alive but unhealthy" for three ticks and never started the
    # launcher. Any process can carry the string (a `git show`, a diagnostic
    # one-liner); only bun.exe with a ProcessId IS the sidecar.
    # Enumerating ALL Win32_Process rows and filtering in PowerShell is
    # deliberate — the WMI filter itself cannot express a regex on CommandLine
    # portably across 5.1/7. $Processes is injectable for the tests.
    # NOT named $matches: that is an AUTOMATIC variable PowerShell fills on every
    # -match — accumulating into it throws "can only add a hashtable to another
    # hashtable" the moment a row matches (caught by the first live tick, which
    # the probe-injected test suite could never see).
    param(
        [int]$Port,
        [object[]]$Processes = $null
    )
    if ($null -eq $Processes) {
        $Processes = Get-CimInstance -ClassName Win32_Process -Property @("ProcessId", "Name", "CommandLine")
    }
    $pattern = "standalone-proxy\.ts.*--port\s*$Port"
    $hits = @()
    foreach ($p in $Processes) {
        if ($p.Name -eq 'bun.exe' `
            -and $null -ne $p.ProcessId -and $p.ProcessId -gt 0 `
            -and $null -ne $p.CommandLine -and $p.CommandLine -match $pattern) {
            $hits += $p
        }
    }
    # NOT `return ,$hits`: wrapping an EMPTY array emits the array itself as one
    # output object, so the caller's @(...) counts 1 "process" whose ProcessId
    # reads $null — the watchdog then believes a sidecar is alive while it is
    # dead and never starts the launcher. This is the measured cause of the
    # 27/09 kill-test FAIL ((pid=) in the log). The caller already array-ifies
    # with @(), which is what guarantees the array shape here.
    return $hits
}

function Test-SidecarHealth {
    # 127.0.0.1 named explicitly, never `localhost`: the sidecar binds 127.0.0.1
    # only (launcher --host), and a name that resolves ::1 first could probe a
    # family nothing listens on and report a healthy sidecar down.
    param([int]$Port, [int]$TimeoutSec)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec $TimeoutSec -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-NativeWatchdogDecision {
    # Pure decision table — everything with a side effect lives in the caller.
    # ConsecutiveUnhealthy is the count BEFORE this tick (state), so the
    # kill-restart edge is ConsecutiveUnhealthy + 1 >= KillThreshold.
    param([bool]$ProcessAlive, [bool]$HealthOk, [int]$ConsecutiveUnhealthy, [int]$KillThreshold)
    if (-not $ProcessAlive) { return 'start' }
    if ($HealthOk) { return 'ok' }
    if (($ConsecutiveUnhealthy + 1) -ge $KillThreshold) { return 'kill-restart' }
    return 'warn'
}

function Start-SidecarDetached {
    # The launcher stays alive for the sidecar's lifetime (its Start-Process bun
    # runs with -Wait), so it must itself be detached from this watchdog: a
    # scheduled-task powershell that waits on it would stack a dead parent chain
    # on every recovery, and a task killed at its own timeout would take the
    # launcher — and the sidecar — down with it.
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        Write-WatchdogLog "FATAL: launcher not found at '$Path'"
        return $false
    }
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Path) `
        -WindowStyle Hidden
    return $true
}

function Invoke-NativeWatchdogCycle {
    # One full tick. Every side-effectful probe and action is injectable so the
    # wiring (state, logging, thresholds, exit codes) is testable without killing
    # a real process or binding a real port. Defaults are the live implementations.
    param(
        [int]$Port = 3914,
        [string]$LauncherPath = $LauncherPath,
        [int]$HealthTimeoutSec = 5,
        [int]$KillThreshold = 3,
        [int]$StartWaitSec = 30,
        [scriptblock]$ProcessProbe = $null,
        [scriptblock]$HealthProbe = $null,
        [scriptblock]$LauncherAction = $null,
        [scriptblock]$KillAction = $null
    )
    if (-not $ProcessProbe)  { $ProcessProbe  = { param($p) Get-SidecarProcesses -Port $p } }
    if (-not $HealthProbe)   { $HealthProbe   = { param($p, $t) Test-SidecarHealth -Port $p -TimeoutSec $t } }
    if (-not $LauncherAction){ $LauncherAction = { param($lp) Start-SidecarDetached -Path $lp } }
    if (-not $KillAction)    { $KillAction    = { param($procs) foreach ($pr in $procs) { Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue } } }

    Invoke-LogRotation
    $procs = @(& $ProcessProbe $Port)
    $alive = ($procs.Count -gt 0)
    $healthy = [bool](& $HealthProbe $Port $HealthTimeoutSec)
    $state = Get-WatchdogState
    $prev = 0
    if ($null -ne $state -and $null -ne $state.PSObject.Properties['consecutiveUnhealthy']) {
        $prev = [int]$state.consecutiveUnhealthy
    }

    $pidsTxt = (@($procs) | ForEach-Object { $_.ProcessId }) -join ','

    $decision = Get-NativeWatchdogDecision -ProcessAlive $alive -HealthOk $healthy `
        -ConsecutiveUnhealthy $prev -KillThreshold $KillThreshold

    # Try to name our own revision once per tick; observability must never kill
    # the cycle (same rule as the fleet watchdog's provenance line).
    $prov = "provenance n/a"
    try {
        $sha = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
        $prov = "sha256=$($sha.Substring(0, 12))"
    } catch {}

    switch ($decision) {
        'ok' {
            Write-WatchdogLog "OK (pid=$(@($procs)[0].ProcessId), prevKO=$prev). $prov"
            Set-WatchdogState -ConsecutiveUnhealthy 0
            return 0
        }
        'warn' {
            $n = $prev + 1
            Write-WatchdogLog "UNHEALTHY ${n}/${KillThreshold} (pid=$(@($procs)[0].ProcessId)): alive but /health KO — no action yet (may be booting). $prov"
            Set-WatchdogState -ConsecutiveUnhealthy $n
            return 0
        }
        'start' {
            Write-WatchdogLog "CRITICAL: no process on port $Port — starting via launcher. $prov"
            if (-not (& $LauncherAction $LauncherPath)) { return 1 }
        }
        'kill-restart' {
            Write-WatchdogLog "ZOMBIE CONFIRMED ${KillThreshold}/${KillThreshold} (pids=${pidsTxt}): alive but /health KO — killing, then restarting. $prov"
            & $KillAction $procs
            Start-Sleep -Seconds 2
            if (-not (& $LauncherAction $LauncherPath)) { return 1 }
        }
    }

    # Post-start confirmation, bounded: a watchdog that cannot conclude is not a
    # watchdog (02/09 lesson, same as the fleet one).
    Set-WatchdogState -ConsecutiveUnhealthy 0
    $deadline = (Get-Date).AddSeconds($StartWaitSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if ([bool](& $HealthProbe $Port $HealthTimeoutSec)) {
            Write-WatchdogLog "RECOVERED: sidecar healthy after restart"
            return 0
        }
    }
    Write-WatchdogLog "FATAL: sidecar not healthy ${StartWaitSec}s after restart — next tick retries"
    return 1
}

# Dot-sourcing loads the functions without running a cycle (same idiom as
# claudish-watchdog.ps1), which is what the Pester suite relies on.
if ($MyInvocation.InvocationName -eq '.') { return }

Write-WatchdogLog "=== sidecar watchdog check (port $Port, launcher $LauncherPath) ==="
exit (Invoke-NativeWatchdogCycle -Port $Port -LauncherPath $LauncherPath `
    -HealthTimeoutSec $HealthTimeoutSec -KillThreshold $UnhealthyKillThreshold -StartWaitSec $StartWaitSec)
