#Requires -Version 5.1
<#
.SYNOPSIS
    Host-side watchdog for the Claudish sidecar on Docker Desktop (Windows).

.DESCRIPTION
    The container's own healthcheck cannot see the two failure classes that
    took every lane on a host down (myia-po-2028, 21/10 and 24/10). This
    script watches them from the HOST, opt-in gated, with bounded actuators
    whose rebuild halves were MEASURED on myia-po-2028 (2026-10-24: kill of
    the orphaned wslrelay restored service on 21/10 and 24/10; `wsl
    --terminate docker-desktop` was followed by an unassisted Desktop
    respawn, container healthy and relay-nominal, in under 3 minutes).

    It reuses the fleet-tested primitives from scripts/lib/claudish-engine.psm1:
      - Test-HttpAlive: ANY HTTP status proves the pipe alive (the 09-20
        lesson: a 200-only check invents a wedge on a healthy machine under
        the production interpreter - HTTP 400 under 5.1, 200 under pwsh 7).
      - Test-ClaudishOptIn: consent = a file that exists AND carries the
        literal token 'enabled'; an empty file does not arm.

    Probes and rungs (each bounded, journalized to sidecar-host-watchdog.log;
    the decision half is PURE in scripts/lib/claudish-engine.psm1 -
    Get-EngineWatchdogDecision / Select-WslrelaySquatters / Get-LoopbackVerdict /
    Get-CurlHttpProbeVerdict / the state codec - pinned by scripts/tests/ on
    both interpreters):
      R1 - wslrelay wedge: probe http://[::1]:<port>/health EXPLICITLY (a
           'localhost' probe reads healthy straight through this outage -
           measured: wslrelay owns [::1] alone while the backend wildcard
           keeps serving 127.0.0.1; Node clients resolve ::1 first and die).
           R1 fires ONLY on the measured wedge shape - [::1] dead AND
           127.0.0.1 alive (any HTTP status counts): both dead is another
           class (engine down, a drained -Recreate, a container crash) where
           killing the relay fixes nothing. When the shape matches and a
           wslrelay process holds the loopback listeners for the port: kill
           exactly those PIDs. The Docker backend's 0.0.0.0/[::] wildcard
           then serves loopback again (measured 21/10 + 24/10). Only
           wslrelay is ever killed - never the backend, never the VM.
      R1B - the MIRROR shape (added 25/10): one loopback family serves while
           the other accepts TCP and never answers. No actuator: the measured
           remedy is a container restart, and it belongs to the Docker-owning
           lane on this host (Maintenance). The rung emits
           R1B_ESCALATE_V4_DEAD naming the port holder. Because the relay's
           process never changed across the repair, killing it is NOT a fix -
           that is why this rung has no kill branch at all. Ownership per
           family is episode-dependent: never assume it.
      R2 - docker engine wedge: the Docker Desktop backend runs but the
           docker-desktop WSL distro answers HTTP 500 (or hangs the CLI) -
           "docker refuses to restart after a kill". Remediation
           `wsl --terminate docker-desktop` fires only when: 2 consecutive
           failing runs have passed, the engine cooldown (30 min) has
           elapsed, no claudish-drain is in flight, AND com.docker.backend
           is running - the respawn precondition measured on 24/10. Without
           the backend there is nobody to respawn the distro: that is R3.
           A probe that cannot even LAUNCH (docker.exe unresolvable, PATH
           drift) reads 'unknown' - no increment, no actuation: two
           'down'-on-launch-failure runs would terminate the distro of a
           healthy engine. When the host already runs the SYSTEM
           ClaudishWatchdog task, R2 stands down (single observer per
           failure path); R1 and the escalation lines stay.
           ONCE PER OUTAGE EPISODE: the unassisted respawn held on the
           24/10 morning occurrence (engine back < 3 min) and FAILED on the
           11:00Z one (distro never returned, CLI then answered "Docker
           Desktop is unable to start"; only a full chain stop + GUI
           relaunch recovered it). A rung whose rebuild half holds 1 time
           out of 2 gets one shot, then escalates - never a repeated
           teardown of a component it cannot rebuild.
      R3 - engine down AND no Docker Desktop backend: ESCALATE log line
           only. Deliberately no actuator: the rebuild half of an
           engine-relaunch has never been proven here (the po-2025 2026-09-20
           lesson: a teardown whose rebuild half was broken caused an outage
           worse than the wedge; #172 AC4). The log line names the manual
           gesture; the worker cycle relays it.

      R3 also covers a THIRD class, measured 2026-10-24 afternoon: the WSL
      SERVICE itself is wedged. A plain `wsl -d <distro> -- /bin/true` times
      out while `wsl --list --running` still answers (a metadata call) and
      vmmemWSL keeps its RAM; Docker's backend log says `bootstrapping main
      distribution: Wsl/Service/WSAETIMEDOUT`. No Docker rung can reach that
      layer - a distro termination returned, and the GUI was relaunched, and
      the engine still answered `Docker Desktop is unable to start`. Detected
      here by a bounded 20 s probe, escalated with the measured recipe
      (`wsl --shutdown`, then stop the Desktop chain and relaunch the GUI),
      never acted: `wsl --shutdown` tears down every distro on the host and
      one measured rebuild is not a proven one.

    Single-observer rule: this script is THE watcher for the
    localhost-path / docker-engine condition on a sidecar host. Do not add a
    second one; extend this file instead. Where the host already runs the
    SYSTEM ClaudishWatchdog task, R2 stands down MECHANICALLY (detected via
    schtasks - access denied counts as present) - one observer per failure
    path, not a promise in a docblock. R1 and the escalation lines stay:
    they cover paths the SYSTEM watchdog does not see. It is INERT until an
    operator writes the consent file (no consent = not even measured, no
    log line).

.PARAMETER Port
    Published host port of the sidecar (default 3000).

.PARAMETER ClaudishHome
    State/log directory (default ~/.claudish). The consent file
    'sidecar-host-watchdog.enabled' (content: the literal 'enabled') lives
    here.

.PARAMETER ConsecutiveEngineFailures
    Failing runs required before R2/R3 (default 2 = ~10 min at the /5 min
    scheduled cadence).

.PARAMETER EngineCooldownMin
    Minutes between R2/R3 attempts (default 30).

.PARAMETER DryRun
    Probes run for real (read-only); remediations print [DRYRUN] instead of
    executing.

.NOTES
    Interpreter: Windows PowerShell 5.1 (the interpreter scheduled tasks
    actually use). Per-user scheduled task, no UAC.

    DEPLOY A STABLE COPY, never the repo path: on 2026-10-24 a branch switch
    removed this file from the working tree and every scheduled run died at
    launch (`powershell -File` on an absent path exits -196608 = 0xFFFD0000)
    with not one log line for 2.5 h. Copy the script to
    <ClaudishHome>\bin\ and the module to <ClaudishHome>\bin\lib\, then
    register with stdout captured - the scheduler discards it, and the
    launch diagnostics are the only thing that names a module that did not
    import:

      Copy-Item scripts\claudish-sidecar-host-watchdog.ps1 $HOME\.claudish\bin\ -Force
      New-Item -ItemType Directory -Force $HOME\.claudish\bin\lib | Out-Null
      Copy-Item scripts\lib\claudish-engine.psm1 $HOME\.claudish\bin\lib\ -Force
      schtasks /Create /TN ClaudishSidecarHostWatchdog /TR "cmd.exe /c
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File
        %USERPROFILE%\.claudish\bin\claudish-sidecar-host-watchdog.ps1
        1>>%USERPROFILE%\.claudish\sidecar-host-watchdog.task.out 2>&1"
        /SC MINUTE /MO 5 /F

    Refresh the copy after any change to this file or the module; the log's
    `copy_mtime=` field names WHICH file actually executed.
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [string]$ClaudishHome = (Join-Path $env:USERPROFILE '.claudish'),
    [int]$ConsecutiveEngineFailures = 2,
    [int]$EngineCooldownMin = 30,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$LogPath = Join-Path $ClaudishHome 'sidecar-host-watchdog.log'
$StatePath = Join-Path $ClaudishHome 'sidecar-host-watchdog.state.json'
$ConsentFileName = 'sidecar-host-watchdog.enabled'
$LogMaxBytes = 2MB

function Write-WdLog {
    param([string]$Message)
    # ASCII only - Add-Content encoding stability across 5.1 seats.
    $line = ('{0} {1}' -f ([DateTimeOffset]::UtcNow).ToString('o'), ($Message -replace '[^\x20-\x7E]', '?'))
    try {
        if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt $LogMaxBytes)) {
            Move-Item -Path $LogPath -Destination ($LogPath + '.old') -Force
        }
        Add-Content -Path $LogPath -Value $line -Encoding Ascii
    } catch { }
    Write-Output $line
}

function Read-WdState {
    # Decode via the pure codec (claudish-engine.psm1). Returns $null when the
    # file exists but cannot be decoded: a state that cannot be read must
    # surface as state_read_error + an inert run (main), NEVER a silent reset
    # — a fresh-looking state re-arms R2 inside an episode it already acted
    # on (review #639 point 1: the old silent catch reset EngineFailures to 0
    # on every run, R2/R3 unreachable on a fresh host).
    if (-not (Test-Path $StatePath)) {
        return @{ EngineFailures = 0; LastEngineActionUtc = [datetime]::MinValue; EngineActionsSinceDown = 0 }
    }
    try {
        $json = Get-Content $StatePath -Raw
    } catch { return $null }
    try {
        return ConvertFrom-WatchdogStateJson -Json $json
    } catch {
        return $null
    }
}

function Write-WdState {
    param([hashtable]$State)
    try {
        New-Item -ItemType Directory -Force -Path $ClaudishHome | Out-Null
        [System.IO.File]::WriteAllText($StatePath, (ConvertTo-WatchdogStateJson -State $State), [System.Text.UTF8Encoding]::new($false))
    } catch { Write-WdLog "state_write_error $($_.Exception.Message)" }
}

function Get-LoopbackSquatters {
    # wslrelay PIDs listening on the loopback pair for $Port, via the PURE
    # selector in the module (pinned: nothing unless IPv4 is alive, loopback
    # only, wslrelay only — the Docker backend is never returned). The
    # process table is built here because Get-Process is the machine-touching
    # half the pure function must not own.
    param([bool]$Ipv4Alive)
    $squatters = @()
    if (-not $Ipv4Alive) { return $squatters }
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
    } catch { return $squatters }
    $procs = @{}
    foreach ($c in $conns) {
        if (-not $procs.ContainsKey([int]$c.OwningProcess)) {
            $gp = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($gp) { $procs[[int]$c.OwningProcess] = $gp }
        }
    }
    return @(Select-WslrelaySquatters -Connections $conns -Processes $procs -Ipv4Alive:$Ipv4Alive)
}

function Test-DockerEngine {
    # Returns 'up', 'down', 'hang' or 'unknown'. Bounded with a .NET Process
    # handle: the Start-Process -PassThru wrapper never populates ExitCode on
    # 5.1 (Refresh() is not enough - a healthy engine read as 'down'; caught
    # in dry-run on myia-po-2028). Output is tiny, reading pipes after exit is
    # safe.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'docker'
    $psi.Arguments = 'version --format {{.Server.Version}}'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        # A LAUNCH failure is not a liveness verdict (PATH drift after a
        # Desktop update, docker.exe unresolvable for this user). Reporting
        # 'down' here was the actuating direction: two such runs and R2
        # terminated the distro of a healthy engine (review #639 point 3).
        # 'unknown' never increments and never actuates — the same posture as
        # Test-WslServiceResponsive's launch guard.
        Write-WdLog "engine_probe_launch_error $($_.Exception.Message)"
        return 'unknown'
    }
    if (-not $p.WaitForExit(15000)) {
        try { $p.Kill() } catch { }
        return 'hang'
    }
    if ($p.ExitCode -eq 0) { return 'up' }
    return 'down'
}

function Test-DrainInFlight {
    # A drain owns the container lifecycle while it runs; R2 must not race it
    # (drain = deliberate gesture, watchdog = recovery of an abandoned state).
    # powershell.exe = the detached drain; pwsh.exe = a hand-run drain from
    # PowerShell 7 (review #639 point 7: matching only powershell% missed it).
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name LIKE 'powershell%' OR Name LIKE 'pwsh%'" -ErrorAction Stop
        foreach ($pr in $procs) {
            if ($pr.CommandLine -and $pr.CommandLine -match 'claudish-drain') { return $true }
        }
    } catch { }
    return $false
}

function Test-DesktopBackendPresent {
    # com.docker.backend running = the respawn precondition measured on
    # 24/10 (Desktop respawned the terminated distro unassisted).
    return [bool](Get-Process -Name 'com.docker.backend' -ErrorAction SilentlyContinue)
}

function Test-HostWatchdogTaskPresent {
    # Single-observer rule, made mechanical (review #639 point 6): when the
    # host already runs the SYSTEM ClaudishWatchdog task, R2 stands down -
    # two organs acting on the same engine condition is two observers on one
    # failure path, whatever the .DESCRIPTION says. R1 and the escalation
    # lines stay: they cover paths the SYSTEM watchdog does not see.
    #
    # Instrument note: a SYSTEM task is INVISIBLE to Get-ScheduledTask under
    # a standard token. schtasks /query tells the two cases apart by OUTPUT,
    # not exit code alone: exit 0 = exists; "access denied" (ACCES REFUSE /
    # Access is denied) = exists (it is there, we just cannot read it);
    # not-found wording or a silent non-zero = absent.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'schtasks'
    $psi.Arguments = '/query /tn ClaudishWatchdog'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        # cannot even ask: treat as absent (the standdown is a quieting, not
        # a safety interlock - absent keeps our R2, which is the current
        # documented behavior everywhere but this host).
        return $false
    }
    if (-not $p.WaitForExit(15000)) {
        try { $p.Kill() } catch { }
        return $false
    }
    if ($p.ExitCode -eq 0) { return $true }
    $combined = "$($p.StandardOutput.ReadToEnd()) $($p.StandardError.ReadToEnd())"
    if ($combined -match '(?i)refus|denied') { return $true }
    return $false
}

function Test-WslServiceResponsive {
    # 'ok' | 'timeout'. Separate class, measured 2026-10-24 13:0x local: the
    # engine would not start at all (`Docker Desktop is unable to start`, backend
    # log: bootstrapping main distribution: Wsl/Service/WSAETIMEDOUT) while a
    # plain `wsl -d Ubuntu -- ps` ALSO timed out - the host<->VM channel was
    # wedged, with `wsl --list --running` still answering (metadata call) and
    # vmmemWSL holding 24.5 GB. `wsl --terminate docker-desktop` cannot fix that
    # class, and neither could a GUI relaunch; `wsl --shutdown` then a Desktop
    # chain restart brought the engine up in ~10 s.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl'
    $psi.Arguments = '-d docker-desktop -- /bin/true'
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return 'ok'   # cannot even launch: not this class, do not divert
    }
    if (-not $p.WaitForExit(20000)) {
        try { $p.Kill() } catch { }
        return 'timeout'
    }
    return 'ok'
}

# Dot-sourced by the Pester suite (scripts/tests/claudish-sidecar-host-watchdog.Tests.ps1):
# define the functions above, run nothing below. Everything past this point
# either calls `exit` (which, in a dot-sourced script, kills the test
# runner's whole session) or touches the machine, so the guard sits AFTER the
# last function definition and BEFORE the first guard block.
if ($MyInvocation.InvocationName -eq '.') { return }

# Module resolution: the scheduled task runs a STABLE COPY outside the repo
# (~/.claudish/bin + ~/.claudish/bin/lib), so a branch switch cannot remove
# the script mid-day; `lib\` next to the copy is the first candidate, then
# the in-repo layouts for manual runs from a checkout.
$moduleCandidates = @(
    (Join-Path $PSScriptRoot 'lib\claudish-engine.psm1'),
    (Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1')
)
$EngineModule = $null
foreach ($cand in $moduleCandidates) {
    if (Test-Path $cand) { $EngineModule = $cand; break }
}
if (-not $EngineModule) {
    # LOUD to the LOG FILE too, not stdout alone: a scheduled task discards
    # stdout, and on 2026-10-24 exactly this failure left 2.5 h of silence
    # with every run dying before its first log line.
    $msg = 'sidecar-watchdog module_missing inert_exit candidates=' + ($moduleCandidates -join ',')
    try { Add-Content -Path $LogPath -Value (('{0} {1}' -f ([DateTimeOffset]::UtcNow).ToString('o'), $msg)) -Encoding Ascii } catch { }
    Write-Output $msg
    exit 1
}
try {
    Import-Module $EngineModule -Force -ErrorAction Stop
} catch {
    $msg = 'sidecar-watchdog module_import_failed inert_exit ' + $_.Exception.Message
    try { Add-Content -Path $LogPath -Value (('{0} {1}' -f ([DateTimeOffset]::UtcNow).ToString('o'), $msg)) -Encoding Ascii } catch { }
    Write-Output $msg
    exit 1
}

# Consent BEFORE any probe: a machine that never opted in is not even
# measured (the 09-20 lesson: a guard that armed by accident armed on every
# machine in the fleet).
if (-not (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -FileName $ConsentFileName)) {
    exit 0
}

# ---------------- main ----------------

New-Item -ItemType Directory -Force -Path $ClaudishHome | Out-Null
$State = Read-WdState
if ($null -eq $State) {
    # Unreadable state: NEVER a silent reset - a fresh-looking state re-arms
    # R2 inside an episode it already acted on. Loud line, inert run; the
    # operator deletes the file or fixes the stamp (any ISO form is valid).
    Write-WdLog "state_read_error inert_exit path=$StatePath hint=delete the file or write lastEngineActionUtc null"
    exit 1
}
$actions = @()

# --- R1: loopback path (wslrelay squatter). Explicit [::1] - see .DESCRIPTION.
$ipv6Alive = Test-HttpAlive -Url "http://[::1]:$Port/health" -TimeoutSec 8

# THE IPv4 PROBE IS THE GATE (review #639 point 4): R1 fires only on the
# MEASURED wedge shape - [::1] dead while 127.0.0.1 still serves. Both dead
# is a different class (engine down, a drained -Recreate, a container crash):
# killing the relay there fixes nothing and tears down a listener that may be
# legitimate - a recreate makes both dead, which is exactly why this gate
# also covers the drain race. Any HTTP status counts as alive (Test-HttpAlive).
$ipv4Alive = Test-HttpAlive -Url "http://127.0.0.1:$Port/health" -TimeoutSec 8

# Belt BEFORE declaring v6 dead (peer review, po-2028 Maintenance, 2026-10-24).
# .NET sends a Host header that a literal IPv6 address does not satisfy on
# some builds - Invoke-WebRequest returns 400 where curl.exe returns 200 on
# the same address, same second. Test-HttpAlive already treats any status as
# alive, so that class cannot fire here; this is the belt for the NEXT
# variant, because a probe that lies in the DOWN direction costs a phantom
# R1 kill. Anything that answers with a 3-digit status is alive.
$curlHttp = ''
if (-not $ipv6Alive) {
    try {
        # --globoff is load-bearing: without it curl reads the brackets of a
        # literal [::1] URL as a glob range and never connects, returning
        # '000' on every single tick (measured 2026-10-24 -> 2026-10-25). This
        # belt never fired for its whole life.
        $raw = & curl.exe -s --globoff -o NUL -w '%{http_code}' --max-time 8 "http://[::1]:$Port/health" 2>$null
        $curlHttp = (($raw | Out-String).Trim())
    } catch { }
    # '000' is curl's NO-RESPONSE code and must never read as alive: the old
    # test (^\d{3}$) matched it, so a probe that answered nothing kept
    # ipv6Alive=$true. Pinned in Get-CurlHttpProbeVerdict.
    if ((Get-CurlHttpProbeVerdict -Raw $curlHttp) -eq 'alive') {
        $ipv6Alive = $true
        $actions += "PROBE_DOTNET_BLIND curl_http=$curlHttp"
    }
}

if (-not $ipv6Alive -and $ipv4Alive) {
    $squatters = Get-LoopbackSquatters -Ipv4Alive:$ipv4Alive
    foreach ($s in $squatters) {
        if ($DryRun) {
            $actions += "DRYRUN_R1_KILL_WSLRELAY pid=$($s.ProcId) addr=$($s.LocalAddress) relay_start=$($s.StartTime.ToString('o'))"
        } else {
            $actions += "R1_KILL_WSLRELAY pid=$($s.ProcId) addr=$($s.LocalAddress) relay_start=$($s.StartTime.ToString('o'))"
            try { Stop-Process -Id $s.ProcId -Force -Confirm:$false -ErrorAction Stop } catch { }
        }
    }
    if (-not $DryRun -and $squatters.Count -gt 0) {
        Start-Sleep -Seconds 3
        $ipv6After = Test-HttpAlive -Url "http://[::1]:$Port/health" -TimeoutSec 8
        $actions += "R1_REPROBE ipv6_alive=$ipv6After"
        if ($ipv6After) { $ipv6Alive = $true }
    }
}

# --- R1B: the DEAD loopback leg (added 2026-10-25, po-2028 third wedge in three
# days). Mirror shape of R1 - one family serves, the other accepts TCP and never
# answers. This is the dangerous half: the connection ESTABLISHES, so a client
# whose base URL names the dead family gets no error and no timeout to trip, and
# the agent hangs for hours. Measured 2026-10-25: 127.0.0.1:3000 timed out at 4 s
# while [::1]:3000 answered 200 in 8 ms - and the verdict read HEALTHY for
# 80 minutes because it only looked at IPv6.
#
# PORT OWNERSHIP IS NOT STABLE ACROSS EPISODES - never assume it. On
# 2026-09-20/24 wslrelay held [::1] alone while the backend wildcard served
# 127.0.0.1; on 2026-10-25 wslrelay held BOTH 127.0.0.1 and [::1] while the
# backend held only the wildcard - and it was IPv4 that died. Hence the probe
# covers both families every tick and this rung NAMES the holder instead of
# assuming one.
#
# ESCALATE ONLY - no actuator here, deliberately:
#   - the measured remedy is a CONTAINER restart (po-2028 2026-10-25: after the
#     restart the loopback answered again while the relay process never changed
#     - so killing the relay is not the fix, and a distro teardown is strictly
#     heavier than needed);
#   - the actuator belongs to the lane that owns Docker on this host
#     (Maintenance: watch_sidecar_loopback.ps1 + Maintenance-SidecarLoopbackGuard,
#     gated on this exact shape). Two actuators on one condition is the
#     double-shooter class: it wins nothing and races the drain window.
if ($ipv6Alive -and -not $ipv4Alive) {
    $holders = @()
    try {
        $conns4 = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        $holders = @($conns4 | ForEach-Object {
            $hn = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            "$($_.LocalAddress):$($_.LocalPort)/$hn#$($_.OwningProcess)"
        })
    } catch { }
    $actions += "R1B_ESCALATE_V4_DEAD holders=$($holders -join ',') remedy=container_restart owner=Maintenance guard=Maintenance-SidecarLoopbackGuard"
}

# --- R2/R3: docker engine. The LADDER is pure (Get-EngineWatchdogDecision in
# claudish-engine.psm1 - every branch pinnable without touching the machine);
# this block only gathers inputs and maps the action to a line or an actuator.
# The probes below are paid only while the engine is already failing.
$engine = Test-DockerEngine
$wslVerdict = 'ok'
if ($engine -eq 'down' -or $engine -eq 'hang') {
    $wslVerdict = Test-WslServiceResponsive
}
$preFailures = [int]$State.EngineFailures
$decision = Get-EngineWatchdogDecision -State $State -EngineVerdict $engine `
    -DrainInFlight (Test-DrainInFlight) `
    -BackendPresent (Test-DesktopBackendPresent) `
    -WslVerdict $wslVerdict `
    -HostWatchdogPresent (Test-HostWatchdogTaskPresent) `
    -NowUtc ([DateTimeOffset]::UtcNow).UtcDateTime `
    -ConsecutiveEngineFailures $ConsecutiveEngineFailures `
    -EngineCooldownMin $EngineCooldownMin -DryRun:$DryRun
$State = $decision.NextState

switch ($decision.Action) {
    'reset' {
        if ($preFailures -gt 0) { $actions += 'ENGINE_RECOVERED' }
    }
    'engine_unknown' {
        $actions += 'ENGINE_PROBE_UNKNOWN no_increment no_act (launch error - see engine_probe_launch_error line)'
    }
    'pending' {
        $actions += "ENGINE_FAILURE pending failures=$($preFailures + 1)/$ConsecutiveEngineFailures"
    }
    'guard_drain' {
        $actions += "ENGINE_GUARD_DRAIN_IN_FLIGHT failures=$($preFailures + 1)"
    }
    'guard_cooldown' {
        $actions += "ENGINE_GUARD_COOLDOWN failures=$($preFailures + 1) since_last_action_min=$([int]$decision.SinceActionMin)"
    }
    'r3_wsl_service_wedged' {
        # The WSL service wedge preempts every Docker rung: a distro termination
        # cannot reach a wedged host<->VM channel (measured: terminate + GUI
        # relaunch both failed, `wsl --shutdown` then a chain restart fixed it).
        # ESCALATE only - `wsl --shutdown` tears down EVERY distro on the host,
        # and one measured rebuild is not a proven one (#172 AC4).
        $actions += 'R3_ESCALATE_WSL_SERVICE_WEDGED operator_gesture=wsl --shutdown ; stop com.docker.backend+com.docker.build+Docker Desktop+wslrelay ; relaunch "C:\Program Files\Docker\Docker\Docker Desktop.exe"'
    }
    'r3_after_r2' {
        # R2 is ONCE per outage episode, never a repeated teardown. Measured on
        # this host 2026-10-24: the morning termination WAS followed by an
        # unassisted Desktop respawn (<3 min), the 11:00Z one was NOT. A rung
        # whose rebuild half holds 1 time out of 2 may fire once per episode,
        # then the human gesture (#172 AC4).
        $actions += 'R3_ESCALATE_ENGINE_DOWN_AFTER_R2 operator_gesture=stop com.docker.backend/building/Docker Desktop then relaunch "C:\Program Files\Docker\Docker\Docker Desktop.exe"'
    }
    'r2_standalone' {
        # Single observer per failure path (review #639 point 6): the host's
        # SYSTEM ClaudishWatchdog owns the engine condition here. R1 and the
        # escalation lines stay.
        $actions += 'R2_STANDDOWN_HOST_WATCHDOG_PRESENT ClaudishWatchdog owns the engine path - single observer per failure path'
    }
    'r2_terminate' {
        # R2 - the READ path, not a guaranteed one: the Desktop respawned the
        # distro unassisted on the 24/10 morning occurrence and did not on the
        # 11:00Z one - hence once per episode (branch above).
        # BOUNDED, and logged BEFORE the action: on 2026-10-24 the unbounded
        # `-Wait` could hold a task instance with the distro wedged, and a log
        # written only at the end of a run leaves a hang invisible.
        if ($DryRun) {
            $actions += "DRYRUN_R2_WSL_TERMINATE_DOCKER_DESKTOP failures=$($preFailures + 1)"
        } else {
            Write-WdLog "action=R2_WSL_TERMINATE_DOCKER_DESKTOP_BEGIN failures=$($preFailures + 1)"
            $actions += "R2_WSL_TERMINATE_DOCKER_DESKTOP failures=$($preFailures + 1)"
            try {
                $wp = Start-Process -FilePath 'wsl' -ArgumentList @('--terminate', 'docker-desktop') -PassThru -NoNewWindow
                if (-not $wp.WaitForExit(60000)) {
                    try { $wp.Kill() } catch { }
                    $actions += 'R2_TERMINATE_KILLED_AFTER_60s'
                }
            } catch {
                $actions += "R2_TERMINATE_LAUNCH_ERROR $($_.Exception.Message)"
            }
        }
    }
    'r3_no_backend' {
        # R3 - ESCALATE ONLY. No engine-relaunch actuator: the rebuild half
        # has never been proven here (po-2025 2026-09-20; #172 AC4). The
        # worker cycle relays this line.
        $actions += 'R3_ESCALATE_ENGINE_DOWN_NO_BACKEND operator_gesture=start Docker Desktop manually'
    }
}

# A dry run measures; it must not move the state machine (its failure counters
# and cooldown would then fire on the next real run as if work had been done).
# The decision layer already returns the input state unchanged under -DryRun;
# this guard is the belt on the write half.
if (-not $DryRun) { Write-WdState -State $State }
# The verdict must see BOTH families (2026-10-25): a dead IPv4 leg while
# [::1] serves is the shape that hangs every agent whose base URL is
# http://127.0.0.1:3000 - TCP establishes, nothing answers, no timeout trips.
# Read as HEALTHY for 16 h before this fix.
$verdict = Get-LoopbackVerdict -Ipv4Alive $ipv4Alive -Ipv6Alive $ipv6Alive
$detail = ($actions -join '; ')
# copy_mtime names WHICH file executed: on 2026-10-24 a branch switch removed
# the script from the working tree and every scheduled run died at launch
# (powershell -File on an absent path) with no line to show for it.
$copyMtime = ''
try { $copyMtime = (Get-Item $PSCommandPath).LastWriteTimeUtc.ToString('o') } catch { }
Write-WdLog ("verdict=$verdict v6=$ipv6Alive v4=$ipv4Alive engine=$engine curl=$curlHttp port=$Port pid=$PID copy_mtime=$copyMtime" + $(if ($detail) { " actions=$detail" } else { '' }))
