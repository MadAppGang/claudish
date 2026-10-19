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
#
# WORST-CASE WALL TIME (#233 AC4)
# ObserveSec 300 + adaptive up to 300 + compose stop grace 120 + settle 20
# ≈ 12.5 min — beyond a typical agent tool-call cap (10 min). Agent callers
# MUST run this DETACHED via -Detach, never inline inside a capped tool call:
# a caller killed mid-compose leaves the old container stopped with no
# rename/start ever issued — the 2026-09-23 09:35Z gap (16 min) is exactly
# that shape (#233). Full invocation:
#
#   powershell -ExecutionPolicy Bypass -File scripts\claudish-drain.ps1 `
#       -Detach -Reason <why> [-Recreate -EnvFile <path>] [-ClaudishHome <dir>]
#
# -Detach relaunches this script as a hidden child (always powershell.exe,
# the interpreter the scheduled tasks run) with every argument quoted,
# captures the child's stdout+stderr to drain-detach-*.log under the Claudish
# home, and returns on the child's own `START pid <pid>` line in drain.log:
#   exit 0 = child alive (poll for the first OUTCOME line AFTER that START —
#            OUTCOME lines carry no pid and older ones belong to past runs),
#   exit 3 = no drain is running — the child died (rc + stdout/stderr tails
#            printed) or the launch itself failed (start-failed); relaunching
#            is safe,
#   exit 4 = no START line within -DetachStartupTimeoutSec while the child
#            may STILL be running — do NOT relaunch, inspect the stderr
#            capture named in the output.
# Known limit, loud by design: a -Reason VALUE that starts like a parameter
# name ("-Recreate …") makes the child die at parameter binding — exit 3 with
# the binding error in the stderr capture, never a silent no-op.
# ⚠ Sandboxes: -ClaudishHome alone is NOT enough — without -LogPath, the
# drain log resolves to $USERPROFILE\.claudish\drain.log, i.e. PRODUCTION.
# Pass both, always (same trap class as the dot-source note at the -Detach
# parameter).
# Every child exit writes a terminal `OUTCOME` line, and a later run that
# finds a RECREATE with no OUTCOME after it logs `PREVIOUS RUN INTERRUPTED`.

param(
    [string]$ContainerName = "claudish-proxy",
    [string]$ProxyUrl = "http://localhost:3000",
    [int]$MaxWaitSec = 600,
    [string]$Reason = "manual",
    [string]$LogPath = "$env:USERPROFILE\.claudish\drain.log",
    # Where base-url.txt is looked up. Same default as $LogPath's directory, so
    # an existing dot-source or scheduled invocation needs no change.
    [string]$ClaudishHome = "$env:USERPROFILE\.claudish",
    # Interpolation env file for `docker compose` under -Recreate. See the
    # header: refusing beats silently recreating with empty ${VAR:-} values.
    [string]$EnvFile = "",
    # Standalone form of the function's deploy switch (#124): forwarded to
    # Invoke-ClaudishDrainedRestart below so `-File -Recreate` recreates
    # instead of silently draining into a plain `docker restart`.
    [switch]$Recreate,
    # #233 AC2: auto-remove leftover Created-state compose twins before a
    # recreate. Off by default — the default path REFUSES and names the exact
    # removal command, because deleting containers is the operator's call.
    [switch]$RemoveCreatedTwins,
    # #312 — detached launch for agent callers: re-launch this script as a
    # hidden child with EVERY argument quoted, stdout+stderr captured to
    # per-run files under $ClaudishHome, and return on the child's proof of
    # life (its `START pid` line: exit 0), death or launch failure (exit 3 —
    # no drain is running, relaunch is safe), or silence past the startup
    # window (exit 4 — the child may still be running; do NOT relaunch, a
    # second drain would race the first). Replaces the hand-rolled
    # `Start-Process` whose unquoted -ArgumentList join killed a detached
    # launch silently on 02/10 (measured on one machine; two others
    # suspected the same shape, unconfirmed — #312).
    # NOTE: dot-sourcing this file (the watchdog does) injects $Detach and
    # $DetachStartupTimeoutSec into the caller's scope — keep the caller's
    # own variables off those names (a $detach assignment IS the switch and
    # throws on conversion; review #338 B1).
    [switch]$Detach,
    # How long -Detach waits for the child's `START pid` line before
    # reporting a mute child. The child writes that line BEFORE any network
    # or container call, so a healthy child reports in ~1-2 s even when the
    # proxy is busy — a busy proxy delays every other drain.log line until
    # the first zero sample, up to the whole observe window (review #338 B2).
    [int]$DetachStartupTimeoutSec = 45
)

Import-Module (Join-Path $PSScriptRoot 'lib\claudish-engine.psm1') -Force

# #368 — the pre-gesture failover-events tick runs THIS collector against the
# old container. Script-scope (not a function default expression) so the test
# suite can neutralize it after dot-sourcing (same pattern as $LogPath): every
# suite test then skips the tick instead of spawning a real child, and the
# dedicated #368 tests bind -FailoverTickCollectorPath to a fixture.
$DrainFailoverTickCollector = Join-Path $PSScriptRoot 'failover-events-collect.ps1'

function Write-DrainLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    $dir = Split-Path $LogPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # Bounded retry (#338 re-review e2e, 5.1): a concurrent reader holding
    # the log (a Get-Content poll, a monitor) can make Add-Content fail with
    # a sharing violation ONCE — non-terminating, so the line is simply
    # never written and the log ends on REFUSED with no OUTCOME (the exact
    # "PREVIOUS RUN INTERRUPTED" false-positive shape). Three short retries
    # close the window.
    for ($try = 1; $try -le 3; $try++) {
        try {
            Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction Stop
            break
        } catch {
            if ($try -eq 3) { Write-Host "drain log write failed after 3 tries: $($_.Exception.Message)" }
            else { Start-Sleep -Milliseconds 50 }
        }
    }
    Write-Host $line
}

function Write-DrainOutcome {
    <#
        #233 AC3 — a terminal line on EVERY exit. The 09:35Z run of
        2026-09-23 has a RECREATE line and no outcome: the log could not tell
        "still running" from "died mid-compose". Every path out of
        Invoke-ClaudishDrainedRestart now writes exactly one OUTCOME line.
    #>
    param([string]$Kind, [string]$Detail)
    Write-DrainLog "OUTCOME ${Kind} ($Detail)"
}

function Test-DrainPreviousRunInterrupted {
    <#
        #233 AC3 — called at the start of a -Recreate run. compose output
        lines are logged with the same `RECREATE (...)` prefix as the start
        line, so the invariant is simply: no OUTCOME line after the last
        RECREATE line means the previous run never reached an exit. A caller
        killed mid-compose (the 09:35Z shape) is detected here, by the NEXT
        run, because the killed process itself can log nothing.
    #>
    if (-not (Test-Path -LiteralPath $LogPath)) { return }
    $lines = @()
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try { $lines = @(Get-Content -LiteralPath $LogPath) } finally { $ErrorActionPreference = $prevEap }
    $lastStart = -1
    $lastOutcome = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match 'RECREATE \(') { $lastStart = $i }
        elseif ($lines[$i] -match 'OUTCOME ') { $lastOutcome = $i }
    }
    if ($lastStart -gt $lastOutcome) {
        $ts = ''
        if ($lines[$lastStart] -match '^\[([^\]]+)\]') { $ts = $Matches[1] }
        Write-DrainLog "PREVIOUS RUN INTERRUPTED — last trace at $ts has no OUTCOME line (killed mid-compose? see #233)"
    }
}

function Invoke-DrainRollback {
    <#
        #233 AC1 — after a failed `docker compose up -d`, bring the previous
        container back up. Returns one of:
          'started'          — docker start issued, /health re-probed
          'already-running'  — compose failed before stopping anything
          'start-failed'     — docker start itself failed (escalate by hand)
          'inspect-failed'   — docker inspect could not answer
        Never throws: a rollback path that throws would hide the failure it
        is recovering from.
    #>
    param([string]$Reason, [string]$Container, [string]$Url)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $running = docker inspect --format '{{.State.Running}}' $Container 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-DrainLog "ROLLBACK ($Reason): docker inspect $Container failed — cannot tell if the old container is stopped"
            return 'inspect-failed'
        }
        if ($running -match 'true') {
            Write-DrainLog "ROLLBACK ($Reason): container '$Container' still running — compose failed before stopping it, nothing to roll back"
            return 'already-running'
        }
        $null = docker start $Container 2>$null   # echoes the name; keep the verdict a single string
        if ($LASTEXITCODE -ne 0) {
            Write-DrainLog "ROLLBACK ($Reason): docker start $Container FAILED (exit $LASTEXITCODE) — container left stopped, start it by hand"
            return 'start-failed'
        }
        # Give the proxy a moment to bind before probing; /health usually
        # answers within seconds of container start.
        $health = 'unreachable'
        foreach ($attempt in 1..3) {
            Start-Sleep -Seconds 3
            $after = Get-ClaudishActiveStreams -Url $Url
            if ($null -ne $after) { $health = "ok (activeStreams=$after)"; break }
        }
        Write-DrainLog "ROLLBACK started $Container — health $health"
        return 'started'
    } catch {
        Write-DrainLog "ROLLBACK ($Reason): EXCEPTION — $($_.Exception.Message)"
        return 'inspect-failed'
    } finally { $ErrorActionPreference = $prevEap }
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

        The HOST authority is resolved separately, from <ClaudishHome>\base-url.txt
        when that file exists (#wedge, 2026-09-20): on a machine whose Docker
        Desktop loopback forwarder has wedged, localhost is dead while the LAN
        binding still serves, and a drain that reads activeStreams through the
        dead door gets $null — "no signal" — and silently degrades to an
        undrained restart, killing every in-flight stream. The port still comes
        from `docker port`, never from the override, so a per-machine base URL
        can never point a sidecar at the hub's container (#110).

        No base-url.txt = localhost = byte-identical behaviour.
    #>
    param([string]$Container)
    try {
        $published = (docker port $Container 3000/tcp 2>$null | Select-Object -First 1)
        if ($published -and $published -match ':(\d+)\s*$') {
            return (Resolve-ClaudishProbeUrl -ClaudishHome $ClaudishHome -Port ([int]$Matches[1]))
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

function Get-DrainFreezeProxyState {
    <#
        #306 review (ai-01, 03/10) — the FREEZE line must attest what the
        PROXY saw, not what the drain wrote. The drain writes the flag in its
        own ClaudishHome; the proxy reads it in homedir()/.claudish, which in
        a container is the bind mount of CLAUDISH_CONFIG_DIR — three
        independent settings decide whether those are the same directory, and
        a VM clock skew can expire a fresh flag on sight. /health now carries
        admissionFreeze ("flag" | "no-consent" | "no-flag" | "expired"); this
        probe returns it, or $null when the proxy cannot answer (/health
        down, non-JSON) — $null means "not honored", never "unknown, assume
        fine". A proxy that ANSWERS but carries no admissionFreeze field is
        a pre-#306 image and gets its own token "absent": that is the shape
        the first freeze-capable -Recreate meets on every machine, because
        it probes the container it is about to replace (review 03/10, D3 —
        reading the absent field as "flag" must turn a test red, it was the
        false-attestation vector of the first deploy).
    #>
    param([string]$Url = $ProxyUrl)
    try {
        $r = Invoke-WebRequest -Uri "$Url/health" -TimeoutSec 5 -UseBasicParsing
        $j = $r.Content | ConvertFrom-Json
        if ($null -eq $j.PSObject.Properties['admissionFreeze']) { return 'absent' }
        return [string]$j.admissionFreeze
    } catch {
        return $null
    }
}

function Invoke-ClaudishDrainedRestartImpl {
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
        [string]$ComposeDir = (Split-Path -Parent $PSScriptRoot),
        # #306 — home for the admission-freeze flag; same dynamic-default
        # pattern as $Container/$Url above (the watchdog restores the script
        # param around its dot-source precisely so these read right).
        [string]$FreezeClaudishHome = $ClaudishHome,
        # #233 AC2 — auto-remove leftover Created-state compose twins instead
        # of refusing. Never removes a twin that ever ran.
        [switch]$RemoveCreatedTwins,
        # #368 — collector script for the pre-gesture failover-events tick.
        # Default reads the script-scope $DrainFailoverTickCollector (the
        # suite sets it to '' after dot-sourcing, skipping the tick).
        [string]$FailoverTickCollectorPath = $DrainFailoverTickCollector,
        # #368 — hard bound on the tick: the drain must never wait on a
        # wedged collector invocation. Tests shrink it to prove the kill.
        [int]$FailoverTickTimeoutSec = 120
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
        Test-DrainPreviousRunInterrupted
        if (-not $EnvFile) {
            Write-DrainLog "RECREATE REFUSED ($Reason): -Recreate requires -EnvFile — docker compose interpolates every `$\{VAR:-\} from it, and the hub's real file lives outside the compose dir (incident 2026-09-07: bare recreate emptied every CLAUDISH_FAILOVER_*). Pass -EnvFile D:\claudish-shadow\.env on the hub."
            Write-DrainOutcome "refused" "${Reason}: -Recreate without -EnvFile — nothing stopped"
            return $false
        }
        if (-not (Test-Path -LiteralPath $EnvFile)) {
            Write-DrainLog "RECREATE REFUSED ($Reason): -EnvFile '$EnvFile' does not exist — nothing done (a recreate against a wrong or missing env file empties every CLAUDISH_FAILOVER_* variable)"
            Write-DrainOutcome "refused" "${Reason}: -EnvFile missing — nothing stopped"
            return $false
        }
        # #141 point 3, second surface: an env file can EXIST and still gut the
        # cascades — it merely lacks them (po-203 measured 16 in file vs 23 in
        # container: the 16 present mask the 7 that would be lost). If the file
        # carries no armed CLAUDISH_FAILOVER_* cascade while the live container
        # does, the recreate would wipe an armed state that exists nowhere
        # else. Refuse before spending the drain. An inspect MISS is no
        # signal, never "0 armed" (#372): the pre-#372 fail-open let a
        # recreate through against a container the drain could not even see —
        # ai-01, 2026-10-06: file=1, container=0, but that 0 was an ABSENT
        # container (the hub default probed on a sidecar machine), not an
        # unarmed one, and the guard could never refuse. The guard's whole
        # job is to compare against the container compose is about to
        # replace; when docker cannot produce it, stop.
        # #304 discrimination: only the four cascade-carrying names count as
        # armed. Knobs (ARM_AFTER, SESSION_DWELL_MS, ...) and decorators
        # (_LABEL/_RESET/_ACTIVE/...) are injected since #304 — counting any
        # FAILOVER name let a knob-only file pass as "armed" and gut a live
        # cascade undetected. Keep in sync with Get-ArmedCascadeCount in
        # install-sidecar.ps1 (pinned by claudish-drain.Tests.ps1).
        $armedPattern = '^CLAUDISH_FAILOVER_(OPUS|SONNET|HAIKU|FABLE)=.+'
        $envArmed = 0
        $contArmed = 0
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $inspectMissed = $false
        try {
            $envArmed = @([System.IO.File]::ReadAllLines($EnvFile) |
                Where-Object { $_ -match $armedPattern }).Count
            $contEnv = docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Container 2>$null
            if ($LASTEXITCODE -eq 0) {
                $contArmed = @($contEnv | Where-Object { $_ -match $armedPattern }).Count
            } else {
                $inspectMissed = $true
            }
        } finally { $ErrorActionPreference = $prevEap }
        if ($inspectMissed) {
            Write-DrainLog "RECREATE REFUSED ($Reason): docker inspect could not read container '$Container' (exit $LASTEXITCODE — absent, or docker itself failed) — cannot verify its armed cascades; nothing stopped (#372)."
            Write-DrainOutcome "refused" "${Reason}: container '$Container' unreadable by inspect — nothing stopped"
            return $false
        }
        if ($contArmed -gt 0 -and $envArmed -eq 0) {
            Write-DrainLog "RECREATE REFUSED ($Reason): -EnvFile '$EnvFile' carries no armed CLAUDISH_FAILOVER_* while container '$Container' has $contArmed — the recreate would wipe an armed state that exists nowhere on disk. Recover it with install-sidecar.ps1 -RebuildEnvFromContainer, then retry (#141)."
            Write-DrainOutcome "refused" "${Reason}: env file carries no armed cascade while container has $contArmed — nothing stopped"
            return $false
        }

        # #233 AC2 — leftover-twin preflight, BEFORE anything is stopped. An
        # interrupted `compose up` leaves a `<id>_claudish-proxy` twin behind
        # (Created state); its name conflict then fails every later recreate
        # AFTER compose has stopped the old container — on 2026-09-23 each
        # retry was a fresh outage and recovery waited on the 15-min watchdog.
        # Refuse by default and name the exact removal command; auto-removal
        # only via -RemoveCreatedTwins and only for twins that never ran.
        # (The --format deliberately separates fields with a SPACE, not "|":
        # PowerShell does not quote a "|" argument when handing it to a .cmd
        # shim, and cmd.exe re-parses it as a pipe operator — measured while
        # building this suite's docker.cmd shim. The real docker.exe is
        # unaffected either way.)
        $twinLines = @()
        $prevEap2 = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $psLines = docker ps -a --filter "name=$Container" --format '{{.Names}} {{.State}}' 2>$null
            if ($LASTEXITCODE -eq 0 -and $psLines) {
                # Only compose's own temporary shape is a twin: `<ID[:12]>_<name>`.
                # The name filter is a substring match, so a container that
                # merely CONTAINS the target name must not be reported — the
                # refusal below prints `docker rm <it>` as the fix.
                $twinRe = '^[0-9a-f]{12}_' + [regex]::Escape($Container) + '$'
                $twinLines = @($psLines | Where-Object { $_ -and ((($_.Trim() -split '\s+')[0]) -match $twinRe) })
            }
        } finally { $ErrorActionPreference = $prevEap2 }
        if ($twinLines.Count -gt 0) {
            $createdTwins = @($twinLines | Where-Object { (($_.Trim() -split '\s+')[1] -eq 'created') })
            $nonCreatedTwins = @($twinLines | Where-Object { (($_.Trim() -split '\s+')[1] -ne 'created') })
            if ($RemoveCreatedTwins -and $nonCreatedTwins.Count -eq 0) {
                foreach ($t in $createdTwins) {
                    $tname = ($t.Trim() -split '\s+')[0]
                    # `$null =`: docker rm echoes the name on stdout. Uncaptured,
                    # it joins this function's output and a later `return $false`
                    # reaches the caller as @('<twin>', $false) — truthy, so the
                    # standalone form exited 0 on a failed deploy.
                    $null = docker rm $tname 2>$null
                    if ($LASTEXITCODE -ne 0) {
                        Write-DrainLog "RECREATE REFUSED ($Reason): could not remove twin '$tname' (docker rm exit $LASTEXITCODE) — nothing stopped"
                        Write-DrainOutcome "refused" "${Reason}: twin removal failed — nothing stopped"
                        return $false
                    }
                    Write-DrainLog "RECREATE ($Reason): removed Created-state twin '$tname' (-RemoveCreatedTwins — never ran, holds no state)"
                }
            } else {
                if ($RemoveCreatedTwins -and $nonCreatedTwins.Count -gt 0) {
                    Write-DrainLog "RECREATE REFUSED ($Reason): -RemoveCreatedTwins only covers Created-state twins; non-Created twin(s) present — refusing"
                }
                foreach ($t in $twinLines) {
                    $tparts = $t.Trim() -split '\s+'
                    Write-DrainLog "RECREATE REFUSED ($Reason): leftover twin '$($tparts[0])' (state=$($tparts[1])) — remove it first: docker rm $($tparts[0])"
                }
                Write-DrainOutcome "refused" "${Reason}: leftover twin(s) present — nothing stopped"
                return $false
            }
        }
        Write-DrainLog "RECREATE ($Reason): interpolating from -EnvFile '$EnvFile' (armed cascades: file=$envArmed container=$contArmed)"
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
    # #306 — opt-in admission freeze for the gesture window: new admissions
    # get 503 + Retry-After from the proxy while the restart runs. Consent-
    # gated (drain-freeze.enabled, token 'enabled'): a machine that never
    # opted in freezes nothing. Cleared by the WRAPPER's finally on every
    # exit; the proxy's own 900 s mtime expiry is the crashed-drain backstop.
    $script:DrainFreezeArmed = Enable-DrainAdmissionFreeze -ClaudishHome $FreezeClaudishHome
    $script:DrainFreezeConfirmed = $false
    if ($script:DrainFreezeArmed) {
        $script:DrainFreezeAt = Get-Date
        # #306 review — the FREEZE line must attest what the PROXY saw. The
        # flag we wrote lives in the drain's home; the proxy reads it through
        # the container's mount, and the two can differ (three independent
        # settings) or a VM clock skew can expire the flag on sight. Ask the
        # proxy itself, once, right here: on "flag" the window below is real;
        # anything else is recorded as NOT HONORED and the gesture carries on
        # unfrozen — exactly as today without consent. Never abort the restart
        # over it: an unfrozen restart is the status quo ante, not an outage.
        $proxyFreezeState = Get-DrainFreezeProxyState -Url $Url
        if ($proxyFreezeState -eq 'flag') {
            $script:DrainFreezeConfirmed = $true
            Write-DrainLog "FREEZE armed — proxy confirms"
        } else {
            $shown = if ($null -ne $proxyFreezeState) { $proxyFreezeState } else { 'no-signal' }
            # absent = the proxy ANSWERED but publishes no admissionFreeze —
            # a pre-#306 image, i.e. the very first freeze-capable recreate
            # on each machine. Mount mismatch is not the suspect there.
            $hint = if ($shown -eq 'absent') { 'proxy predates #306 — freeze takes effect on the NEXT deploy' } else { 'drain home and container mount differ?' }
            Write-DrainLog "FREEZE NOT HONORED (proxy=$shown) — $hint"
        }
    }

    # #368 — pre-gesture failover-events tick: the OLD container's log is
    # about to die (a recreate destroys it) or its failover state to reset
    # (any restart); persist the final markers first. Runs AFTER the freeze
    # arming so new admissions are already gated while the tick runs, and its
    # default 120 s bound fits the proxy's 900 s freeze expiry. Never blocks
    # the gesture — see Invoke-DrainFailoverEventsTick's own bounds.
    # #422 CR — normalize localhost -> 127.0.0.1 so a :3000 seat stays on the
    # collector's OWN default host. $Url is derived as "http://localhost:$port"
    # (Get-ClaudishProbeUrl), while the collector defaults to 127.0.0.1 — under
    # PS 5.1 localhost may resolve ::1 first (the wslrelay shape: ::1 listens
    # but is wedged while 127.0.0.1 serves), which is the very failure #422
    # fixes, reintroduced on the port that was exempt. An explicit non-localhost
    # -Url (LAN host) passes through unchanged.
    $tickHealthUrl = "$Url/health" -replace '^http://localhost:', 'http://127.0.0.1:'
    Invoke-DrainFailoverEventsTick -CollectorPath $FailoverTickCollectorPath -Container $Container `
        -ClaudishHome $FreezeClaudishHome -TimeoutSec $FailoverTickTimeoutSec -HealthUrl $tickHealthUrl

    $restartAt = Get-Date
    # -t must match stop_grace_period (120s, docker-compose.yml): the CLI flag
    # governs how long Docker waits between SIGTERM and SIGKILL, and without it
    # a docker-daemon default (10s) can truncate the graceful window #57 added.
    if ($Recreate) {
        Push-Location $ComposeDir
        try {
            $envArgs = @()
            if ($EnvFile) { $envArgs = @("--env-file", $EnvFile) }
            # #257 — under PS 5.1 with EAP 'Stop' in the caller's scope, compose
            # stderr lines become ErrorRecords and the 2>&1 pipeline terminates
            # with a RemoteException AFTER a successful recreate (hub, twice on
            # 2026-09-25): the post-restart /health attestation is skipped.
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                docker compose @envArgs up -d --timeout 120 2>&1 | ForEach-Object { Write-DrainLog "RECREATE ($Reason): $_" }
                $code = $LASTEXITCODE
            } finally { $ErrorActionPreference = $prevEap }
        } finally { Pop-Location }
        if ($code -ne 0) {
            Write-DrainLog "RECREATE ($Reason): docker compose up -d FAILED (exit $code) in $ComposeDir"
            # #233 AC1 — rollback. compose may already have stopped the old
            # container before failing (name conflict 2026-09-23, killed
            # caller). A failed deploy must leave the hub SERVING the previous
            # image, never stopped: recovery time otherwise falls to the
            # 15-min watchdog or a human.
            $rollback = Invoke-DrainRollback -Reason $Reason -Container $Container -Url $Url
            if ($rollback -eq 'started') {
                Write-DrainOutcome "failed" "${Reason}: compose exit $code — ROLLBACK started, hub serving previous image"
            } elseif ($rollback -eq 'already-running') {
                Write-DrainOutcome "failed" "${Reason}: compose exit $code — container still running, no rollback needed"
            } elseif ($rollback -eq 'start-failed') {
                Write-DrainOutcome "failed" "${Reason}: compose exit $code — ROLLBACK FAILED, container stopped: manual 'docker start $Container' needed"
            } else {
                Write-DrainOutcome "failed" "${Reason}: compose exit $code — rollback indeterminate ($rollback), verify container state by hand"
            }
            return $false
        }
        # #257 — `-Recreate` never builds: compose deploys whatever image it
        # already has, and a stale image deployed silently (2026-09-25, first
        # pass recreated on a 24 h-old image). Recording the deployed image's
        # build timestamp makes that visible in drain.log at attest time.
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            # Capture BEFORE selecting: piping a native command into
            # `Select-Object -First` stops the pipeline early and kills the
            # process, and 5.1 then reports $LASTEXITCODE = -1 — the guard below
            # swallowed every attestation on the hub (measured 2026-09-25: two
            # recreates, zero 'deployed image' lines).
            $inspectOut = @(docker inspect --format '{{.Image}}' $Container 2>$null)
            $inspectCode = $LASTEXITCODE
            $imgSha = [string]($inspectOut | Select-Object -First 1)
            if ($inspectCode -eq 0 -and $imgSha) {
                $imgCreated = [string](@(docker image inspect --format '{{.Created}}' $imgSha 2>$null) | Select-Object -First 1)
                if ($imgSha.Length -ge 19) { $imgSha = $imgSha.Substring(7, 12) }
                Write-DrainLog "RECREATE ($Reason): deployed image ${imgSha} created ${imgCreated}"
            }
        } finally { $ErrorActionPreference = $prevEap }
        $verb = "docker compose up -d"
    } else {
        $null = docker restart -t 120 $Container 2>$null   # echoes the name; keep the result a single bool
        if ($LASTEXITCODE -ne 0) {
            Write-DrainLog "RESTART ($Reason): docker restart $Container FAILED (exit $LASTEXITCODE)"
            Write-DrainOutcome "failed" "${Reason}: docker restart exit $LASTEXITCODE"
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
        Write-DrainOutcome "success" "${Reason}: $verb returned; /health not answering yet after 20s"
    } else {
        Write-DrainLog "RESTART ($Reason): container restarted, /health answering (activeStreams=$after)"
        Write-DrainOutcome "success" "${Reason}: $verb returned; /health answering (activeStreams=$after)"
    }
    return $true
}

function Invoke-ClaudishDrainedRestart {
    <#
        #233 AC3 public wrapper. Every exit of the implementation writes a
        terminal OUTCOME line; this wrapper guarantees the exception path too
        — an unhandled throw now logs its outcome instead of dying with the
        same log shape as the interrupted 09:35Z run.
    #>
    param(
        [string]$Reason = "unspecified",
        [string]$Container = $ContainerName,
        [string]$Url = $ProxyUrl,
        [int]$MaxWait = $MaxWaitSec,
        [int]$ObserveSec = 300,
        [int]$RelaxSec = 30,
        [int]$PollSec = 2,
        [switch]$Recreate,
        [string]$EnvFile = "",
        [string]$ComposeDir = (Split-Path -Parent $PSScriptRoot),
        [string]$FreezeClaudishHome = $ClaudishHome,
        [switch]$RemoveCreatedTwins,
        # #368 — forwarded to the impl when bound (unbound callers fall to
        # the impl's own defaults, which read the script-scope collector path).
        [string]$FailoverTickCollectorPath,
        [int]$FailoverTickTimeoutSec = 120
    )
    # #306 — armed by the impl right before its gesture; cleared HERE on every
    # exit (success, failure, exception), so a crashed run cannot outlive its
    # own flag (the proxy's 900 s mtime expiry is the belt to these
    # suspenders). The window line is emitted ONLY when the proxy confirmed
    # the freeze (review 03/10): an unconfirmed arm already logged NOT HONORED
    # — a window line for a freeze nobody enforced would blame the turns cut
    # in that window on bad luck instead of on the instrument.
    $script:DrainFreezeArmed = $false
    $script:DrainFreezeConfirmed = $false
    $script:DrainFreezeAt = $null
    try {
        return Invoke-ClaudishDrainedRestartImpl @PSBoundParameters
    } catch {
        Write-DrainLog "RESTART ($Reason): EXCEPTION — $($_.Exception.Message)"
        Write-DrainOutcome "exception" "${Reason}: $($_.Exception.GetType().Name)"
        return $false
    } finally {
        if ($script:DrainFreezeArmed) {
            $null = Disable-DrainAdmissionFreeze -ClaudishHome $FreezeClaudishHome
            $end = Get-Date
            if ($script:DrainFreezeConfirmed) {
                $secs = if ($null -ne $script:DrainFreezeAt) { [int](($end - $script:DrainFreezeAt).TotalSeconds) } else { -1 }
                Write-DrainLog "FREEZE ($Reason): admissions frozen $($script:DrainFreezeAt.ToString('HH:mm:ss')) -> $($end.ToString('HH:mm:ss')) (${secs}s) — flag cleared"
            }
        }
        $script:DrainFreezeArmed = $false
        $script:DrainFreezeConfirmed = $false
        $script:DrainFreezeAt = $null
    }
}

function Resolve-DrainTargetsFromEnvFile {
    <#
        #372. A sidecar recreate that passes only -EnvFile drains, guards and
        attests against the HUB defaults (container claudish-proxy, port 3000)
        while compose recreates the machine's real container — on ai-01
        (2026-10-06) the #141 guard's `docker inspect claudish-proxy` failed
        (no such container), fail-open counted 0 armed, and the guard could
        never refuse anything. install-sidecar.ps1 writes
        CLAUDISH_CONTAINER_NAME and CLAUDISH_HOST_PORT into every sidecar env
        file, so the file already names the truth: derive unset targets from
        it, and REFUSE explicit values that disagree with it (a disagreement
        means draining one container while recreating another).

        Pure — reads the file, decides, never touches docker. Callers pass
        the SCRIPT-level PSBoundParameters flags: at function level an
        operator's explicit -ContainerName only ever flows in as a dynamic
        default, which is indistinguishable from "nobody said anything".
    #>
    param(
        [string]$EnvFilePath,
        [string]$PassedContainerName,
        [bool]$ContainerNameExplicit,
        [string]$PassedProxyUrl,
        [bool]$ProxyUrlExplicit
    )
    $out = [pscustomobject]@{ ContainerName = $null; ProxyUrl = $null; Refusal = $null }
    if (-not $EnvFilePath -or -not (Test-Path -LiteralPath $EnvFilePath)) { return $out }

    # Same empty-means-absent convention as the armed-cascade guard: compose
    # injects `${VAR:-}` placeholders, so an empty value is not a target.
    $fileContainer = $null
    $filePort = $null
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFilePath)) {
        if ($line -match '^CLAUDISH_CONTAINER_NAME=(\S.*)$') { $fileContainer = $Matches[1].Trim() }
        elseif ($line -match '^CLAUDISH_HOST_PORT=(\d+)\s*$') { $filePort = $Matches[1] }
    }

    if ($fileContainer) {
        if (-not $ContainerNameExplicit) { $out.ContainerName = $fileContainer }
        elseif ($PassedContainerName -ne $fileContainer) {
            $msg = "explicit -ContainerName '$PassedContainerName' disagrees with -EnvFile '$EnvFilePath' (CLAUDISH_CONTAINER_NAME=$fileContainer) — draining one container while recreating another"
            $out.Refusal = if ($out.Refusal) { "$($out.Refusal); $msg" } else { $msg }
        }
    }
    if ($filePort) {
        if (-not $ProxyUrlExplicit) {
            $out.ProxyUrl = "http://localhost:$filePort"
        } else {
            # The file names a PORT, the caller passes a URL: compare ports,
            # not strings — 'http://127.0.0.1:3010' and the derived
            # 'http://localhost:3010' target the same listener.
            $passedPort = if ($PassedProxyUrl -match ':(\d+)(/)?$') { $Matches[1] } else { $null }
            if ($passedPort -ne $filePort) {
                $msg = "explicit -ProxyUrl '$PassedProxyUrl' disagrees with -EnvFile '$EnvFilePath' (CLAUDISH_HOST_PORT=$filePort) — probing one port while recreating another"
                $out.Refusal = if ($out.Refusal) { "$($out.Refusal); $msg" } else { $msg }
            }
        }
    }
    return $out
}

function Invoke-DrainFailoverEventsTick {
    <#
        #368 — one collection tick against the OLD container, right before the
        gesture, so the final minutes of its [Failover] markers survive the
        recreate that destroys the container log (the founding loss of #347:
        the 04/10 window died at the 05/10 07:58:44Z recreate). At the PT15M
        cadence every recreate loses up to one tick interval — and that
        interval is exactly the interesting one: drain cutover, recovery
        probes, first walls of the new instance.

        The drain's critical path gains NO dependency here: the tick is
        bounded ($TimeoutSec, then the child is killed), every collector exit
        code is swallowed-and-logged — and so is a FAILED LAUNCH: preparation,
        Start-Process, handle, wait and cleanup all sit under one catch, so
        the collector's own NOT-MEASURED / held-watermark semantics never hold
        the drain and neither does a powershell.exe that cannot even start —
        and the tick writes only the collector's own state, which the drain
        never reads back.
    #>
    param(
        [string]$CollectorPath,
        [string]$Container,
        [string]$ClaudishHome,
        # #422 — the address the collector should probe for the per-process
        # instanceId. Empty leaves the collector's own default, which is what
        # the tick used to get unconditionally on the one call path that
        # already knows the derived port. The call site passes the
        # #372-derived "$Url/health" with the host normalized to 127.0.0.1
        # (the collector's own default host — a derived localhost:3000 is NOT
        # byte-identical to it, see the call site's #422 CR note).
        [string]$HealthUrl,
        [int]$TimeoutSec = 120
    )
    if (-not $CollectorPath -or -not (Test-Path -LiteralPath $CollectorPath)) {
        Write-DrainLog "FAILOVER-TICK skipped — no collector at '$CollectorPath'"
        return
    }
    # Review 09/10 (c6070969008): the three swallowed shapes below (absent
    # collector, exit != 0, timeout) only cover a launch that SUCCEEDED — a
    # throwing Start-Process escaped to the wrapper as OUTCOME exception, so a
    # collector failure BLOCKED the drain, the exact coupling this function
    # exists to prevent. One catch wraps preparation, launch, handle, wait and
    # cleanup alike: every step here is the passenger's, never the drain's.
    try {
        if (-not (Test-Path -LiteralPath $ClaudishHome)) { New-Item -ItemType Directory -Path $ClaudishHome -Force | Out-Null }
        # Retention (R2, file 09/10): the tick's per-run capture pair accumulates
        # without bound otherwise — two files per drain run, and the home is never
        # rotated. This is the SAME 7-day best-effort rule the detach launcher
        # already applies to its own pair under this home (Start-DrainDetached,
        # #338 review), applied to the tick's pair; the tick pair sits under the
        # same directory but carries a different prefix, so neither filter can
        # take the other's files. Best-effort by construction (-ErrorAction
        # SilentlyContinue) — a locked or vanished file is not a launch blocker.
        Get-ChildItem -Path $ClaudishHome -Filter 'drain-failover-tick-*.log' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $tickOut = Join-Path $ClaudishHome "drain-failover-tick-$stamp.out.log"
        $tickErr = Join-Path $ClaudishHome "drain-failover-tick-$stamp.err.log"
        # Quote every argument through the same Windows rule the detach launcher
        # uses — 5.1's -ArgumentList array join quotes nothing, so a home path
        # with a space must not split (02/10 lesson).
        $tickArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $CollectorPath,
            '-Container', $Container, '-ClaudishHome', $ClaudishHome)
        # #422 — forward the DERIVED probe address, so the collector never falls
        # back to its hardcoded :3000 default on a call path that already knows
        # the real port. On a machine whose host port is not 3000 that fallback
        # makes the probe fail, Get-InstanceId returns $null, and the collector
        # overwrites the state's instanceId with '' — which disarms
        # InstanceChanged for the very tick that spans the gesture (the
        # pre-gesture tick writes '' immediately before it). A :3000 seat is a
        # strict no-op only because the CALL SITE normalizes localhost to
        # 127.0.0.1 first — the derived "http://localhost:3000/health" is NOT
        # byte-identical to the collector's default (see the call site's #422
        # CR note).
        if (-not [string]::IsNullOrWhiteSpace($HealthUrl)) {
            $tickArgs += @('-HealthUrl', "$HealthUrl")
        }
        $argString = Join-DrainDetachArguments $tickArgs
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argString `
            -WindowStyle Hidden -RedirectStandardOutput $tickOut -RedirectStandardError $tickErr -PassThru
        # 5.1: without a held handle, ExitCode reads empty after the child dies
        # (#338 round-1 lesson).
        $null = $p.Handle
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            try { $p.Kill() } catch { }
            Write-DrainLog "FAILOVER-TICK killed after ${TimeoutSec}s bound (wedged collector invocation) — swallowed, drain proceeds"
            return
        }
        $code = $p.ExitCode
        if ($code -eq 0) {
            Write-DrainLog "FAILOVER-TICK ok — the old container's final markers persisted before the gesture"
        } else {
            Write-DrainLog "FAILOVER-TICK collector exit $code (its own NOT-MEASURED / held-watermark semantics) — swallowed, drain proceeds"
        }
    } catch {
        # Log safely: the drain log is line-shaped, so keep the first line of
        # the exception message and cap its length — a multi-line or very long
        # message must not break the log the wrapper's OUTCOME depends on.
        $first = ($_.Exception.Message -split "`r?`n")[0]
        if ($first.Length -gt 160) { $first = $first.Substring(0, 160) }
        Write-DrainLog "FAILOVER-TICK failed ($($_.Exception.GetType().Name): $first) — swallowed, drain proceeds"
    }
}

function Join-DrainDetachArguments {
    <#
        #312 AC1/AC3, #338 review B3. Quote EVERY argument and join with
        single spaces. Windows PowerShell 5.1 joins a -ArgumentList ARRAY on
        spaces without quoting anything, so a value with a space splits into
        N parameter bindings — the established cause of the 02/10 silent
        deaths. Building ONE pre-quoted string carries the quoting through.
        Inside the quotes, the Windows argument rule (CommandLineToArgvW):
        a backslash is special only before a double quote or at the closing
        quote, so those runs are doubled, and every double quote is escaped
        as \". Doubling quotes (the old claim, "the -File escape form") is
        NOT the rule the child's parser applies: a trailing backslash
        merged with the closing quote and swallowed the NEXT parameter
        (ClaudishHome), and an embedded quote swallowed everything after it
        (Recreate lost) — both measured in review of #338. The escaping is
        ONE pass — `(\\*)"` matches empty runs too, so a bare quote is
        escaped by the same replace (a second quote-escaping pass would
        re-escape the `\" it just produced; that double escape corrupted
        mixed backslash+quote values, re-review of #338, 4 entries
        measured with a real child).
        Mutation target for the Pester pin: reverting to a bare -join, the
        doubling form, or the two-pass escape must turn the real-child B3
        tests red.
    #>
    param([string[]]$Arguments)
    ($Arguments | ForEach-Object {
        $a = $_
        # Every double quote in ONE pass: double the (possibly empty) run of
        # backslashes before it, escape the quote.
        $a = $a -replace '(\\*)"', '$1$1\"'
        # Trailing backslashes sit against OUR closing quote: double them.
        $a = $a -replace '(\\+)$', '$1$1'
        '"' + $a + '"'
    }) -join ' '
}

function Get-WatchLogAddition {
    <#
        #338 re-review bloquant 1. Returns ONLY the bytes of $WatchLogPath
        # appended after $OffsetBytes — never the whole file. drain.log is
        # never rotated and gains a `START pid N` line on every launch, and
        # Windows reuses PIDs: scanning the whole log lets an OLD line
        # naming the current child's pid fake a proof of life for a child
        # that died at binding (demonstrated deterministically in review).
        # Reading from the offset bounds the poll too — it re-read the
        # entire file every 400 ms before. A file shorter than the offset
        # (truncated/replaced) is read whole: toward the signal, never
        # toward missing it. Pure read: missing/locked file -> ''.
    #>
    param([string]$WatchLogPath, [long]$OffsetBytes)
    if (-not (Test-Path -LiteralPath $WatchLogPath)) { return '' }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $fs = [System.IO.File]::Open($WatchLogPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $start = if ($fs.Length -lt $OffsetBytes) { 0 } else { $OffsetBytes }
            $fs.Position = $start
            $sr = New-Object System.IO.StreamReader($fs)
            return $sr.ReadToEnd()
        } finally { $fs.Dispose() }
    } catch {
        return ''
    } finally { $ErrorActionPreference = $prev }
}

function Start-DrainDetached {
    <#
        #312 AC1/AC2, #338 review B2. Launch a child with stdout+stderr
        captured to per-run files under the Claudish home, then return once
        the child proves itself by writing `START pid <child pid>` to the
        watch log — matched on THIS child's pid, so any other drain.log
        writer inside the window (the 04:00 scheduled drain, the watchdog)
        is never mistaken for it:
          (a) the START line for THIS pid is seen   -> Ok, Status alive;
          (b) the child exits first                 -> Status exited (+ ExitCode);
          (c) $TimeoutSec with no line: child dead  -> exited;
              child alive -> timeout (the child may be slow to its first
              write — the caller must NOT relaunch, a second drain would
              race the first; the entry block says so);
          (d) the launch itself threw               -> Status start-failed.
        The log is checked BEFORE the exit status each poll: a child that
        proved life and then died still got past parameter binding — the
        launch succeeded, which is the only thing this function judges.
        $FilePath stays powershell.exe (5.1) even under a pwsh 7 parent, on
        purpose: production scheduled tasks run 5.1 and the child must
        exercise that interpreter.
        Zero actuator (#312 AC5): this function starts $FilePath and reads
        files. No container-engine call, no Restart-*, no Stop-*.
    #>
    param(
        [string]$FilePath = 'powershell.exe',
        [Parameter(Mandatory)] [string]$ArgumentString,
        [Parameter(Mandatory)] [string]$ClaudishHomeDir,
        [Parameter(Mandatory)] [string]$WatchLogPath,
        [int]$TimeoutSec = 45,
        [int]$PollMs = 400
    )
    if (-not (Test-Path $ClaudishHomeDir)) { New-Item -ItemType Directory -Path $ClaudishHomeDir -Force | Out-Null }
    # Retention (#338 review): the per-run capture files accumulate without
    # bound otherwise. 7 days, best-effort, never a launch blocker.
    Get-ChildItem -Path $ClaudishHomeDir -Filter 'drain-detach-*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    # Two launches inside one second would share a second-resolution stamp
    # and one redirection set: add the launching process's pid (#338 review).
    $stamp = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID
    $outPath = Join-Path $ClaudishHomeDir "drain-detach-$stamp.out.log"
    $errPath = Join-Path $ClaudishHomeDir "drain-detach-$stamp.err.log"
    # Offset BEFORE the launch (re-review bloquant 1): the handshake match
    # runs only over bytes the child itself appends — an OLD `START pid N`
    # line from a previous run can never fake this child's proof of life,
    # Windows pid reuse included.
    $baseline = if (Test-Path $WatchLogPath) { (Get-Item -LiteralPath $WatchLogPath).Length } else { 0 }
    try {
        $child = Start-Process -FilePath $FilePath -ArgumentList $ArgumentString `
            -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $outPath -RedirectStandardError $errPath
    } catch {
        return [pscustomobject]@{
            Ok = $false; Status = 'start-failed'; ChildPid = $null; ExitCode = $null
            StdoutPath = $outPath; StderrPath = $errPath
            StdoutTail = @(); StderrTail = @(); FailureReason = $_.Exception.Message
        }
    }
    # 5.1 quirk (measured, parent powershell.exe): the -PassThru object does
    # not retain the process handle, so .ExitCode reads EMPTY after the child
    # dies — pwsh 7 parents are unaffected, which is why probes there lie.
    # Touching .Handle while the child is young caches it in the object.
    $null = $child.Handle
    $startPattern = 'START pid {0}\b' -f [regex]::Escape($child.Id)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $status = 'timeout'
    while ((Get-Date) -lt $deadline) {
        $added = Get-WatchLogAddition -WatchLogPath $WatchLogPath -OffsetBytes $baseline
        if ($added -match $startPattern) { $status = 'alive'; break }
        if ($child.HasExited) { $status = 'exited'; break }
        Start-Sleep -Milliseconds $PollMs
    }
    # Post-loop re-check: the line and the exit can land inside one poll window.
    if ($status -ne 'alive' -and ((Get-WatchLogAddition -WatchLogPath $WatchLogPath -OffsetBytes $baseline) -match $startPattern)) { $status = 'alive' }
    elseif ($status -eq 'timeout' -and $child.HasExited) { $status = 'exited' }
    # ExitCode needs the handle synchronized: HasExited alone can race the
    # object's internal state and read empty (measured on 5.1 — the smoke run
    # printed EXIT= for a child that had just exited 7).
    if ($child.HasExited) { $null = $child.WaitForExit() }
    $result = [pscustomobject]@{
        Ok         = ($status -eq 'alive')
        Status     = $status
        ChildPid   = $child.Id
        ExitCode   = if ($child.HasExited) { $child.ExitCode } else { $null }
        StdoutPath = $outPath
        StderrPath = $errPath
        StdoutTail = @()
        StderrTail = @()
    }
    if (-not $result.Ok) {
        if (Test-Path $errPath) { $result.StderrTail = @(Get-Content -Path $errPath -Tail 12 -ErrorAction SilentlyContinue) }
        if (Test-Path $outPath) { $result.StdoutTail = @(Get-Content -Path $outPath -Tail 6 -ErrorAction SilentlyContinue) }
    }
    return $result
}

function Get-DrainDetachForwardedArguments {
    <#
        #312. The child re-invokes THIS script WITHOUT -Detach (no recursion),
        carrying every operator parameter. Explicit and complete rather than
        $PSBoundParameters-derived: the quoting is the point, and defaults are
        forwarded too, so the child sees exactly what the caller asked for.
    #>
    param(
        [Parameter(Mandatory)] [string]$ScriptPath,
        [string]$Reason,
        [string]$ContainerName,
        [string]$ProxyUrl,
        [int]$MaxWaitSec,
        [string]$LogPath,
        [string]$ClaudishHome,
        [string]$EnvFile,
        [switch]$Recreate,
        [switch]$RemoveCreatedTwins
    )
    $parts = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath,
        '-Reason', $Reason,
        '-ContainerName', $ContainerName,
        '-ProxyUrl', $ProxyUrl,
        '-MaxWaitSec', "$MaxWaitSec",
        '-LogPath', $LogPath,
        '-ClaudishHome', $ClaudishHome,
        '-EnvFile', $EnvFile)
    if ($Recreate) { $parts += '-Recreate' }
    if ($RemoveCreatedTwins) { $parts += '-RemoveCreatedTwins' }
    return $parts
}

# Standalone mode: run the restart. Dot-sourced, define the functions only.
if ($MyInvocation.InvocationName -ne '.') {
    # #372 — resolve the drain's targets from the env file BEFORE any dispatch
    # branch, and deliberately OUTSIDE the <drain-detach-entry> slice the
    # zero-actuator guard scans (that slice must launch and read, nothing
    # else). A sidecar recreate that passed only -EnvFile used to drain and
    # guard the HUB defaults while compose recreated the machine's real
    # container (ai-01, 2026-10-06). Explicitness is read at SCRIPT level:
    # at function level an operator's explicit -ContainerName only ever
    # arrives as a dynamic default, indistinguishable from unset. The
    # detached child re-runs this with the forwarded (derived) values and
    # agrees idempotently — the derivation is a fixpoint after one hop.
    if ($EnvFile -and (Test-Path -LiteralPath $EnvFile)) {
        $targetFix = Resolve-DrainTargetsFromEnvFile -EnvFilePath $EnvFile `
            -PassedContainerName $ContainerName -ContainerNameExplicit:($PSBoundParameters.ContainsKey('ContainerName')) `
            -PassedProxyUrl $ProxyUrl -ProxyUrlExplicit:($PSBoundParameters.ContainsKey('ProxyUrl'))
        if ($targetFix.Refusal) {
            Write-DrainLog "RESTART REFUSED ($Reason): $($targetFix.Refusal)"
            Write-DrainOutcome "refused" "${Reason}: explicit target disagrees with -EnvFile — nothing stopped"
            exit 1
        }
        if ($targetFix.ContainerName -and $targetFix.ContainerName -ne $ContainerName) {
            Write-DrainLog "DRAIN: -ContainerName derived from -EnvFile '$EnvFile' -> $($targetFix.ContainerName)"
            $ContainerName = $targetFix.ContainerName
        }
        if ($targetFix.ProxyUrl -and $targetFix.ProxyUrl -ne $ProxyUrl) {
            Write-DrainLog "DRAIN: -ProxyUrl derived from -EnvFile '$EnvFile' -> $($targetFix.ProxyUrl)"
            $ProxyUrl = $targetFix.ProxyUrl
        }
    }
    # <drain-detach-entry> — the slice the zero-actuator Pester guard scans
    # (the detach branch must launch and read, nothing else).
    if ($Detach) {
        # #312 — detached launch: judge only that the child STARTED, proven
        # by the child's own `START pid <pid>` line (written below, before
        # any network or container call). The drain's own outcome keeps
        # living in drain.log (OUTCOME line), which the caller polls as
        # before — now guaranteed to exist. The result is named
        # $detachResult, NOT $detach: PowerShell variables are
        # case-insensitive and $detach IS the [switch] parameter above —
        # assigning a pscustomobject to it throws a conversion error, the
        # result is lost, and EVERY launch then reports failure (review B1
        # of #338: a caller that believes the failure relaunches, and two
        # drains race — the 23/09 twin shape).
        $detachParts = Get-DrainDetachForwardedArguments -ScriptPath $PSCommandPath `
            -Reason $Reason -ContainerName $ContainerName -ProxyUrl $ProxyUrl `
            -MaxWaitSec $MaxWaitSec -LogPath $LogPath -ClaudishHome $ClaudishHome `
            -EnvFile $EnvFile -Recreate:$Recreate -RemoveCreatedTwins:$RemoveCreatedTwins
        $detachResult = Start-DrainDetached -ArgumentString (Join-DrainDetachArguments $detachParts) `
            -ClaudishHomeDir $ClaudishHome -WatchLogPath $LogPath -TimeoutSec $DetachStartupTimeoutSec
        if ($detachResult.Ok) {
            Write-Host ("[DrainDetach] child PID {0} alive — START pid {0} line present in {1}; poll for the first OUTCOME line AFTER that START (older OUTCOME lines belong to previous runs)" -f $detachResult.ChildPid, $LogPath)
            exit 0
        }
        if ($detachResult.Status -eq 'exited') {
            Write-Host ("[DrainDetach] child PID {0} EXITED rc={1} — launch FAILED — stderr evidence: {2}" -f $detachResult.ChildPid, $detachResult.ExitCode, $detachResult.StderrPath)
        } elseif ($detachResult.Status -eq 'start-failed') {
            # No child exists in this branch — nothing may still be draining,
            # so it ranks with 'exited' (exit 3), never with the live-child
            # timeout (re-review of #338).
            Write-Host ("[DrainDetach] launch FAILED to start — {0}" -f $detachResult.FailureReason)
        } else {
            Write-Host ("[DrainDetach] child PID {0} still running but wrote no START line within {1}s — do NOT relaunch (a second drain would race the first); inspect {2}" -f $detachResult.ChildPid, $DetachStartupTimeoutSec, $detachResult.StderrPath)
        }
        foreach ($l in $detachResult.StdoutTail) { Write-Host "  stdout: $l" }
        foreach ($l in $detachResult.StderrTail) { Write-Host "  stderr: $l" }
        exit $(if ($detachResult.Status -eq 'timeout') { 4 } else { 3 })
    }
    # </drain-detach-entry>
    # #338 review B2 — the proof-of-life handshake, written BEFORE any
    # network or container call: a busy proxy (activeStreams > 0) writes no
    # other drain.log line until the first zero sample — up to the whole
    # observe window — and the -Detach parent above treats this line (matched
    # on this child's pid) as the only proof that the launch worked.
    Write-DrainLog "START pid $PID — drained restart begins (reason: $Reason)"
    $ok = Invoke-ClaudishDrainedRestart -Reason $Reason -Recreate:$Recreate -EnvFile $EnvFile -RemoveCreatedTwins:$RemoveCreatedTwins
    exit $(if ($ok) { 0 } else { 1 })
}
