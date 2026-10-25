<#
    claudish-engine — shared, testable primitives for the watchdog and the drain.

    This module exists because of 2026-09-20. The Docker Desktop localhost
    forwarder (`wslrelay`) wedged three times that day on the hub machine, and
    the first attempt to automate a recovery caused a WORSE outage than the
    wedge it targeted: it tore down the Docker backend and the WSL VM, then
    could not relaunch Docker Desktop, leaving the host with no engine at all.

    The root cause of that failure is still present on `main` and is fixed here:
    `Register-ScheduledTask` has NO `-LogonType` parameter (it belongs to
    `New-ScheduledTaskPrincipal`), so `Start-DockerEngine`'s relaunch has never
    worked on any machine — it has always thrown, been swallowed by its own
    catch, and logged "could not launch Docker Desktop". That is also the most
    likely explanation for 2026-08-29, when the hub came back from a reboot with
    no container and a human had to reboot a second time.

    Three rules are encoded here rather than written down, because a rule that
    lives only in a doc gets re-broken:

      1. NO TEARDOWN WITHOUT A PROVEN REBUILD — and here, no teardown at all.
         The wedge path has NO actuator: its terminal verdict is 'escalate'
         (jsboige/claudish#172 AC4, and a static test in scripts/tests pins it —
         a reviewer can grep the wedge path and find no Restart-*, no Stop-*, no
         -Verb RunAs). A container restart cannot fix a forwarder wedge; 13 were
         tried on 2026-09-20 and only a host reboot rebuilt it. Where an engine
         action does already exist — Start-DockerEngine, which predates all of
         this — Test-EngineRelaunchReady now guards it by registering the
         relaunch task and reading it back, so the 13:18 failure is unreachable
         by construction: the registration that blew up is the thing that must
         succeed first.
      2. A GUARD IS AN EXPLICIT FLAG, NEVER AN ACCIDENTAL EQUALITY. The previous
         attempt disarmed itself with `if ($loopbackUrl -ne $ProxyUrl)`, which
         held only because the two strings happened to be equal on a machine
         that had not opted in. Changing the probe from `localhost` to `[::1]`
         made equality impossible, and the watch armed on every machine at once.
         Opt-in is now a file with required content.
      3. EVERY UNKNOWN FAILS SAFE. Each instrument that lied that day now
         degrades to "do nothing" rather than to a verdict.
#>

Set-StrictMode -Version Latest

$script:DefaultRelaunchTaskName = 'ClaudishDockerDesktopStart'
$script:OptInFileName           = 'wedge-watch.enabled'
$script:OptInToken              = 'enabled'
# A SECOND opt-in file, deliberately not shared with the wedge watch (review of
# #188). The two sit on different gestures: the wedge watch only issues HTTP GETs,
# while the relaunch preflight registers a scheduled task and invokes it, which
# launches an elevated Docker Desktop in the operator's session. One consent
# covering both would let a machine that armed the harmless one inherit the
# task-registering one silently — the sequencing collapse #172 AC4 exists to
# prevent.
$script:RelaunchPreflightOptInFileName = 'relaunch-preflight.enabled'
# A THIRD opt-in file (#530 gap 1). The zombie-GUI DETECTION is default-on and
# touches nothing (one bounded docker probe + one process-table read); this
# consent arms only the KILL half — Stop-Process on the Docker Desktop GUI —
# because killing a user-session GUI from a SYSTEM scheduled task is invasive
# and must never be a default, even though the process it kills has, by the
# time it fires, been proven useless across three consecutive cycles.
$script:GuiZombieKillOptInFileName = 'gui-zombie-kill.enabled'
# #530 gap 2: consecutive-FATAL escalation. A FATAL line in watchdog.log is
# log-only — four of them over the 73-min outage of 2026-10-18 stayed silent
# seat-side while the fleet noticed via relay heartbeats first. Past a streak
# threshold the watchdog writes a MARKER file (a journal the worker cycle
# already relays with watermark discipline) instead of inventing a network
# channel from a SYSTEM scheduled task. Honest latency bound: escalation
# arrives at the worker cadence (<=5 h), not inside the outage — the org rule
# ("an outage detected is an outage escalated in the same cycle") binds the
# detecting organ, and no hub-side organ has an outbound channel today.
$script:EngineFatalStreakThreshold  = 2
$script:EngineFatalStreakMarkerName = 'engine-fatal-streak'

function Get-ClaudishOptInFileName { return $script:OptInFileName }
function Get-ClaudishOptInToken    { return $script:OptInToken }
function Get-RelaunchPreflightOptInFileName { return $script:RelaunchPreflightOptInFileName }
function Get-GuiZombieKillOptInFileName     { return $script:GuiZombieKillOptInFileName }

function Get-ClaudishMachineName {
    <#
        Canonical fleet id for a raw hostname (#345): 'MYIA-PO-2023' -> 'myia-po-2023'.
        Lowercased and prefixed with 'myia-' unless the name already carries it.

        Mirrors verify-machine-header.py's detect_local_machine() EXACTLY — the
        reader and the producer must agree, or the header we now send would land
        as an unknown name and fork attribution (the very defect that script
        catches). Returns $null for anything unusable, and the caller then sends
        NO header rather than a wrong one: a wrong machine id is worse than none.
    #>
    param([string]$Name)
    if (-not $Name) { return $null }
    $n = $Name.Trim().ToLowerInvariant()
    if (-not $n) { return $null }
    if ($n.StartsWith('myia-')) { return $n }
    return "myia-$n"
}

function Get-ClaudishServingBase {
    <#
        Reads the per-machine serving base URL from <ClaudishHome>\base-url.txt,
        or $null when the file is absent, empty or not an http(s) URL.

        Why a file and not a constant: on po-2025 the wedge kills ONLY the
        loopback path — com.docker.backend's [::]:3000 wildcard keeps serving
        127.0.0.1, the LAN and the ARR throughout. A watchdog that probes the
        dead path concludes the proxy is down and restarts the container, which
        fixes nothing (measured: 13 consecutive useless restarts over 6h47).
        Probing the SURVIVING path instead makes the watchdog agree with reality.

        No file = localhost = zero change. That is the default on every machine
        that has not opted in, and it is why this is safe to ship fleet-wide.
    #>
    param([Parameter(Mandatory)][string]$ClaudishHome)

    $path = Join-Path $ClaudishHome 'base-url.txt'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction Stop)
    } catch { return $null }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }

    $candidate = $raw.Trim() -split "`n" | Select-Object -First 1
    $candidate = $candidate.Trim().TrimEnd('/')
    if ($candidate -notmatch '^https?://[^\s/]+$') { return $null }
    return $candidate
}

function Resolve-ClaudishProbeUrl {
    <#
        Composes the probe URL for a container: the host authority comes from
        base-url.txt when present, the PORT always comes from the caller.

        The port must not be inherited from the override: ports are per
        container (#110 — ai-01's sidecar publishes :3002), so a machine-wide
        base URL carrying a port would silently probe the wrong container.
    #>
    param(
        [Parameter(Mandatory)][string]$ClaudishHome,
        [Parameter(Mandatory)][int]$Port,
        [string]$FallbackUrl = 'http://localhost'
    )

    $base = Get-ClaudishServingBase -ClaudishHome $ClaudishHome
    if (-not $base) { return ('{0}:{1}' -f $FallbackUrl.TrimEnd('/'), $Port) }

    $u = [uri]$base
    return ('{0}://{1}:{2}' -f $u.Scheme, $u.Host, $Port)
}

function Get-LoopbackProbeUrl {
    <#
        The loopback probe MUST name [::1] explicitly. It can never be
        `localhost`.

        wslrelay owns [::1]:<port> alone; com.docker.backend owns the [::]
        wildcard and keeps serving 127.0.0.1. .NET 5+ (pwsh 7) connects to
        `localhost` in dual-mode with a fast IPv6 -> IPv4 fallback, so a
        `localhost` probe answers 200 over 127.0.0.1 straight through the
        outage — blind to the exact wedge it exists to catch. A Node client,
        which resolves ::1 first, takes an immediate ConnectionRefused.
    #>
    param([Parameter(Mandatory)][int]$Port)
    return ('http://[::1]:{0}' -f $Port)
}

function Test-LoopbackListener {
    <#
        Is anything LISTENING on [::1]:<port>?

        This is the discriminant that keeps the wedge watch from crying wolf on
        machines that do not route localhost through a WSL relay: no [::1]
        listener means there is nothing to wedge, and the watch stays silent
        instead of logging a false banner every 15 minutes.

        It also fails safe through a known instrument trap. Under
        networkingMode=mirrored, listening sockets live in the mirrored WSL
        netns and the Windows TCP table never enumerates them, so this returns
        $false — "not visible", which is NOT "not serving". Returning $false
        routes the decision to 'none', i.e. do nothing, which is the correct
        behaviour under an instrument that cannot see. (Reading an empty table
        as a verdict is what produced a published-then-retracted conclusion on
        2026-09-20 — the same class of error as counting armed failover cascades
        by NAME instead of by VALUE.)
    #>
    param(
        [Parameter(Mandatory)][int]$Port,
        [scriptblock]$Enumerator = $null
    )

    if (-not $Enumerator) {
        $Enumerator = {
            param($p)
            try {
                @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop |
                    Where-Object { $_.LocalAddress -eq '::1' })
            } catch { @() }
        }
    }
    try { return (@(& $Enumerator $Port).Count -gt 0) } catch { return $false }
}

function Test-HttpAlive {
    <#
        Did this address carry an HTTP request and return ANY status?

        The wedge signature is "TCP accepts, HTTP never answers". So the correct
        discriminant is the presence of a response, NOT a 200. Checking for 200
        produced a false wedge on the hub the first time this ran under the
        production interpreter: Windows PowerShell 5.1 (.NET Framework) sends a
        request to http://[::1]:3000/health that comes back **HTTP 400**, while
        pwsh 7 (.NET 7) gets 200 from the same address at the same moment. A 400
        proves the forwarder is working perfectly — it carried the request and
        brought back an answer — yet a 200-only check reads it as a dead
        loopback and would have logged a phantom wedge every 15 minutes, then
        escalated one that never existed.

        Interpreter-dependent formatting of a Host header is not a health
        signal. Only a transport failure — no response object at all — is.
    #>
    param(
        [Parameter(Mandatory)][string]$Url,
        [int]$TimeoutSec = 5,
        [scriptblock]$Requester = $null
    )

    if (-not $Requester) {
        $Requester = { param($u, $t) $null = Invoke-WebRequest -Uri $u -TimeoutSec $t -UseBasicParsing }
    }
    try {
        & $Requester $Url $TimeoutSec
        return $true
    } catch {
        # Both interpreters expose the server's answer on the exception when one
        # arrived: HttpWebResponse on 5.1, HttpResponseMessage on 7+. Either way,
        # non-null means the pipe worked.
        $resp = $null
        try { $resp = $_.Exception.Response } catch { }
        return ($null -ne $resp)
    }
}

function Test-ClaudishOptIn {
    <#
        Opt-in, per machine, through a file that must exist AND carry the
        literal token 'enabled'.

        Requiring content is deliberate: an empty file created by an accidental
        New-Item or a stray redirect does NOT arm a teardown of the host's
        container engine. The previous attempt's guard was a comparison between
        two strings that merely coincided; when they stopped coinciding, the
        teardown armed on every machine in the fleet.

        One implementation, one token semantics, two distinct files (see the
        $script:*OptInFileName declarations): the gesture behind each consent is
        what differs, and the semantics of "armed" must not.
    #>
    param(
        [Parameter(Mandatory)][string]$ClaudishHome,
        [string]$FileName = ''
    )

    if ([string]::IsNullOrEmpty($FileName)) { $FileName = $script:OptInFileName }

    $path = Join-Path $ClaudishHome $FileName
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    try {
        $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction Stop)
    } catch { return $false }
    if ($null -eq $raw) { return $false }
    return ($raw.Trim() -eq $script:OptInToken)
}

function Test-WedgeWatchOptIn {
    # The wedge watch's consent: HTTP GETs only, no task, no process launched.
    param([Parameter(Mandatory)][string]$ClaudishHome)
    return (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -FileName $script:OptInFileName)
}

function Test-RelaunchPreflightOptIn {
    <#
        The relaunch preflight's consent, on its OWN file (#188 review).

        This is a SEQUENCING device, not a permanent restriction: opt in on one
        machine, obtain the real execute-probe answer (LastTaskResult 0 vs
        267009 — the two readings mean different things and the fleet has
        measured neither), then widen the measurement deliberately.
    #>
    param([Parameter(Mandatory)][string]$ClaudishHome)
    return (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -FileName $script:RelaunchPreflightOptInFileName)
}

function Test-GuiZombieKillOptIn {
    <#
        The zombie-GUI kill's consent, on its OWN file (#530 gap 1) — same
        token semantics as the other two ('enabled', trimmed).

        Deliberately does NOT gate the detection: a machine that never opted in
        still gets the ENGINE: GUI zombie markers naming the state; it just
        never has its GUI killed. The kill is the invasive half, the naming is
        free.
    #>
    param([Parameter(Mandatory)][string]$ClaudishHome)
    return (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -FileName $script:GuiZombieKillOptInFileName)
}

function Enable-DrainAdmissionFreeze {
    <#
        #306 — pose the drain's admission-freeze flag, ONLY on consent.

        The flag file (<ClaudishHome>\drain-freeze) is what the proxy reads
        (mtime, not bytes — the content below is for humans) to answer new
        /v1/messages and /v1/chat/completions admissions with 503 +
        Retry-After while the restart gesture runs. The consent file
        (drain-freeze.enabled, literal token 'enabled') keeps the whole
        feature OFF on machines that never opted in — same bar as
        wedge-watch / relaunch-preflight. Returns $true only when the flag
        was actually written: a machine without consent freezes nothing.
    #>
    param([Parameter(Mandatory)][string]$ClaudishHome)
    if (-not (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -FileName 'drain-freeze.enabled')) { return $false }
    $flagPath = Join-Path $ClaudishHome 'drain-freeze'
    [System.IO.File]::WriteAllText($flagPath, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
    return (Test-Path -LiteralPath $flagPath)
}

function Disable-DrainAdmissionFreeze {
    <#
        #306 — remove the flag, unconditionally and idempotently. Called in
        the drain's finally path: a drain killed mid-gesture leaves the flag
        behind, and the proxy's own mtime expiry (900 s) is the belt to
        these suspenders.
    #>
    param([Parameter(Mandatory)][string]$ClaudishHome)
    $flagPath = Join-Path $ClaudishHome 'drain-freeze'
    if (Test-Path -LiteralPath $flagPath) {
        Remove-Item -LiteralPath $flagPath -Force -Confirm:$false
    }
}

function New-EngineRelaunchRegistration {
    <#
        Registers (without starting) the task that relaunches Docker Desktop in
        the interactive user session. SYSTEM cannot own a GUI app, hence the
        indirection through a task with an Interactive principal.

        THE BUG THIS FIXES: Register-ScheduledTask has no -LogonType parameter.
        The call on `main`

            Register-ScheduledTask -TaskName $h -Action $a `
                -User "$env:COMPUTERNAME\jsboige" -LogonType Interactive ...

        throws ParameterBindingException on EVERY machine and has never once
        relaunched anything — its own catch swallows the error and logs "could
        not launch Docker Desktop". -LogonType belongs to
        New-ScheduledTaskPrincipal, which builds the principal passed below.

        Pinned by the static test "no script passes -LogonType to
        Register-ScheduledTask", so the shape cannot come back anywhere.
    #>
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$ExecutablePath,
        [Parameter(Mandatory)][string]$UserId
    )

    # -ErrorAction Stop on all three is load-bearing, not decoration.
    # Register-ScheduledTask reports "Access denied" as a NON-TERMINATING error:
    # without this, it prints the failure, the enclosing try/catch never fires,
    # and a registration that did nothing is recorded as a success. Measured on
    # the hub 2026-09-20 in an unelevated shell — the preflight returned
    # 'register:OK' for a task that was never created, and only the read-back
    # caught it. A gate that depends on its own backstop is one refactor away
    # from being the 13:18 failure again.
    $action    = New-ScheduledTaskAction -Execute $ExecutablePath -ErrorAction Stop
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest -ErrorAction Stop
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Force -ErrorAction Stop | Out-Null
}

function ConvertFrom-QuserOutput {
    <#
        Extracts the logged-on user name from `quser` output.

        Pure and injectable because `quser` is LOCALIZED: on this fleet it
        prints "UTILISATEUR / SESSION / ID / ÉTAT / TEMPS INACT", so any parser
        keying on the word "Active" silently finds nobody. The session-name
        column is not localized, though — "console" and "rdp-tcp#N" are literals
        — so that is what this keys on. The ">" prefix marks the caller's own
        session and is meaningless under SYSTEM, hence stripped, never required.

        Returns the bare user name (no domain) or $null.
    #>
    param([string]$QuserText)

    if ([string]::IsNullOrWhiteSpace($QuserText)) { return $null }
    foreach ($line in ($QuserText -split "`r?`n")) {
        if ($line -notmatch '(?i)(console|rdp-tcp#\d+)') { continue }
        $candidate = ($line.TrimStart('>', ' ') -split '\s+') | Where-Object { $_ } | Select-Object -First 1
        if ($candidate -and $candidate -notmatch '(?i)^(console|rdp-tcp)') { return $candidate }
    }
    return $null
}

function Get-InteractiveUserId {
    <#
        The account to relaunch Docker Desktop as.

        Not hardcoded: "$env:COMPUTERNAME\jsboige" on `main` is the same
        operator-hardcoding trap as the watchdog's log path, and it makes the
        relaunch wrong-by-construction on any machine whose operator is someone
        else. $env:USERNAME is useless here (under SYSTEM it is the machine
        account), so ask the OS who is actually logged on.

        Three probes, because the obvious one is not enough. Measured on the hub
        2026-09-20: Win32_ComputerSystem.UserName came back EMPTY, because it
        reports the CONSOLE session only and the operator was connected over
        RDP (rdp-tcp#1). Taking that empty answer at face value would have made
        the preflight fail forever and the whole recovery path dead code on the
        one machine it was written for — fail-safe, but useless. `quser` sees
        RDP sessions; the process-owner probe is the last resort and needs
        elevation, which the scheduled task (SYSTEM) has and a dev shell
        does not.
    #>
    param(
        [scriptblock]$Probe = $null,
        [scriptblock]$QuserProbe = $null,
        [scriptblock]$ProcessOwnerProbe = $null
    )

    if (-not $Probe) {
        $Probe = { (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).UserName }
    }
    try {
        $u = & $Probe
        if ($null -ne $u -and -not [string]::IsNullOrWhiteSpace([string]$u)) { return ([string]$u).Trim() }
    } catch { }

    if (-not $QuserProbe) { $QuserProbe = { (& quser.exe 2>&1 | Out-String) } }
    try {
        $name = ConvertFrom-QuserOutput -QuserText ([string](& $QuserProbe))
        if ($name) { return ('{0}\{1}' -f $env:COMPUTERNAME, $name) }
    } catch { }

    if (-not $ProcessOwnerProbe) {
        $ProcessOwnerProbe = {
            $p = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop | Select-Object -First 1
            if (-not $p) { return $null }
            $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
            if ($o.ReturnValue -ne 0) { return $null }
            return ('{0}\{1}' -f $o.Domain, $o.User)
        }
    }
    try {
        $owner = & $ProcessOwnerProbe
        if ($owner -and -not [string]::IsNullOrWhiteSpace([string]$owner)) { return ([string]$owner).Trim() }
    } catch { }

    return $null
}

function Test-EngineRelaunchReady {
    <#
        PREFLIGHT — the single most important function in this module.

        It answers one question: "if I tear the engine down right now, can I
        actually bring it back?" And it answers it by DOING the rebuild-path
        registration and reading the task back, not by reasoning about it.

        On 2026-09-20 the teardown half was tested and the rebuild half never
        was. Everything that was verified — the probe does not fire when
        healthy, four addresses at 200, one real cycle exiting 0 — was true, and
        none of it could have caught a rebuild that throws on its first
        statement. Proof of teardown is not proof of recovery.

        Returns @{ Ready = <bool>; Reason = <string>; Checks = @(...) }. Any
        check that fails, for any reason INCLUDING an unexpected exception,
        yields Ready = $false — an unprovable rebuild is treated exactly like a
        failed one.
    #>
    param(
        [string]$TaskName = $script:DefaultRelaunchTaskName,
        [string]$ExecutablePath = 'C:\Program Files\Docker\Docker\Docker Desktop.exe',
        [string]$UserId = $null,
        [scriptblock]$PathTest = $null,
        [scriptblock]$Registrar = $null,
        [scriptblock]$Verifier = $null,
        # The WHOLE user resolution, injected as one unit. An earlier shape took
        # only the first of Get-InteractiveUserId's three probes, so a test that
        # stubbed "no user" still fell through to the live machine and resolved
        # a real one — a stub that does not stub is worse than none.
        [scriptblock]$UserResolver = $null,
        # Execute probe (#176). Registration-plus-readback proves the task can
        # be CREATED, not that running it starts Docker Desktop — which was the
        # exact shape of the -LogonType defect: a call that reported fine and
        # an action that never ran. When the Desktop GUI is already running,
        # the preflight also INVOKES the task it just registered and reads back
        # LastTaskResult/LastRunTime, so the verdict means "the task runs and
        # its action executes". All three seams are injectable so the suite
        # proves the logic without touching the scheduler.
        [scriptblock]$DesktopProbe = $null,
        [scriptblock]$TaskInvoker = $null,
        [scriptblock]$TaskInfoReader = $null,
        # Refusal-vs-failure discriminator. The two arrive as the same
        # LastTaskResult shape and mean opposite things, so the task's STATE is
        # read as well: 0x800710E0 beside a live instance is "there was nothing
        # to exercise", and the same code with no instance is a genuine refusal
        # that must not be swallowed.
        [scriptblock]$TaskStateReader = $null,
        [int]$ExecuteProbeTimeoutMs = 5000
    )

    if (-not $PathTest)  { $PathTest  = { param($p) Test-Path -LiteralPath $p } }
    if (-not $Registrar) { $Registrar = { param($n, $exe, $u) New-EngineRelaunchRegistration -TaskName $n -ExecutablePath $exe -UserId $u } }
    if (-not $Verifier)  { $Verifier  = { param($n) [bool](Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) } }
    if (-not $DesktopProbe)   { $DesktopProbe   = { [bool](Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) } }
    if (-not $TaskInvoker)    { $TaskInvoker    = { param($n) Start-ScheduledTask -TaskName $n } }
    if (-not $TaskInfoReader) { $TaskInfoReader = { param($n) Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue } }
    if (-not $TaskStateReader) {
        $TaskStateReader = { param($n)
            $s = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
            if ($s) { [string]$s.State } else { '' }
        }
    }

    $checks = New-Object System.Collections.Generic.List[string]

    # 1. The thing we would relaunch must exist.
    try {
        if (-not (& $PathTest $ExecutablePath)) {
            $checks.Add('executable:MISSING')
            return [PSCustomObject]@{ Ready = $false; Reason = "executable: not found at '$ExecutablePath'"; Checks = $checks.ToArray() }
        }
    } catch {
        $checks.Add('executable:ERROR')
        return [PSCustomObject]@{ Ready = $false; Reason = "executable: $($_.Exception.Message)"; Checks = $checks.ToArray() }
    }
    $checks.Add('executable:OK')

    # 2. An interactive account must be resolvable, or the principal is a guess.
    if ([string]::IsNullOrWhiteSpace($UserId)) {
        if (-not $UserResolver) { $UserResolver = { Get-InteractiveUserId } }
        try { $UserId = [string](& $UserResolver) } catch { $UserId = $null }
    }
    if ([string]::IsNullOrWhiteSpace($UserId)) {
        $checks.Add('user:UNRESOLVED')
        return [PSCustomObject]@{ Ready = $false; Reason = 'user: no interactive user could be resolved'; Checks = $checks.ToArray() }
    }
    $checks.Add('user:OK')

    # 3. The registration itself must SUCCEED. This is the step that would have
    #    caught -LogonType, and the step whose absence cost a host its engine.
    try {
        # Merge the error stream into the output and inspect it, rather than
        # relying on $ErrorActionPreference.
        #
        # Setting $ErrorActionPreference = 'Stop' here does NOT work and looked
        # like it did: a scriptblock invoked with & runs in a child of ITS OWN
        # definition scope, not the caller's, so the preference never reaches an
        # injected registrar. The live (unelevated) run passed anyway, because
        # the real registrar carries its own -ErrorAction Stop — and the unit
        # test with an injected Write-Error failed. Two instruments disagreeing
        # is what surfaced it; believing the passing one would have shipped a
        # gate that is blind to exactly the error it exists to catch.
        $captured = & $Registrar $TaskName $ExecutablePath $UserId 2>&1
        $errRecords = @($captured | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
        if ($errRecords.Count -gt 0) { throw $errRecords[0].Exception.Message }
    } catch {
        $checks.Add('register:FAILED')
        return [PSCustomObject]@{ Ready = $false; Reason = "register: $($_.Exception.Message)"; Checks = $checks.ToArray() }
    }
    $checks.Add('register:OK')

    # 4. And it must be READABLE BACK. A registration that reports success but
    #    leaves nothing queryable is not a rebuild path.
    try {
        if (-not (& $Verifier $TaskName)) {
            $checks.Add('verify:ABSENT')
            return [PSCustomObject]@{ Ready = $false; Reason = "verify: task '$TaskName' not found after registration"; Checks = $checks.ToArray() }
        }
    } catch {
        $checks.Add('verify:ERROR')
        return [PSCustomObject]@{ Ready = $false; Reason = "verify: $($_.Exception.Message)"; Checks = $checks.ToArray() }
    }
    $checks.Add('verify:OK')

    # 5. EXECUTE (#176, INVERTED by the #205 arbitration). The invoke condition
    #    is the OPPOSITE of the first design: GUI RUNNING => do NOT invoke;
    #    GUI ABSENT => invoke, because that is the only branch where the
    #    measurement means anything. Two measured facts forced the inversion:
    #
    #    (a) Invoking while the GUI runs returns 0 by single-instance FORWARD,
    #        not by exercising the rebuild path. Measured po-2025, 2026-09-21:
    #        the process born at invocation is a renderer CHILD of the live GUI
    #        (parent = the pre-existing GUI, --type=renderer), the exe hands
    #        over and exits, and nothing about the cold-start path ran. A `0`
    #        obtained that way proves "the scheduler can start the action",
    #        never "the action can raise a cold engine" — and the latter is the
    #        ONE defect this preflight exists to catch (-LogonType threw for
    #        this function's whole existence while its catch logged success).
    #        A GUI-up invocation is therefore a FALSE GREEN, and it leaves a
    #        resident renderer behind as a side effect. It reports the honest
    #        SKIPPED form #199 established: no success claimed, no failure
    #        invented — and carries Skipped=$true so the caller knows the day
    #        was not measured (a skip that consumed the daily budget would
    #        certify a probe that never ran — the same false green, one level
    #        up).
    #    (b) With the GUI absent, invoking the just-registered task cold-starts
    #        the engine. The first design skipped this branch ("a readiness
    #        check must never perform the action it is only asking about"), but
    #        a probe that only ever fires while the GUI is up can never measure
    #        the only thing it exists to measure: post-reboot, after a GUI
    #        crash, is precisely when the rebuild path must be proven. The
    #        #205 arbitration inverts it — on an opt-in machine, a once-a-day
    #        launch of an engine that is down is the measurement, not a side
    #        effect to avoid.
    #
    #    A DesktopProbe that THROWS is read as not-running, i.e. toward the
    #    branch that observes real behaviour — an unreadable process table must
    #    not become a reason to measure nothing.
    try { $desktopRunning = [bool](& $DesktopProbe) } catch { $desktopRunning = $false }
    if ($desktopRunning) {
        $checks.Add('execute:SKIPPED(gui-running)')
        return [PSCustomObject]@{
            Ready   = $true
            Skipped = $true
            Reason  = 'relaunch path not re-proven (Docker Desktop GUI is running — an invocation would single-instance-forward and exercise nothing: no fresh exercise performed)'
            Checks  = $checks.ToArray()
        }
    }

    # Note for operators: this preflight leaves a registered, trigger-less task
    # behind (fixed name, -Force, so it does not accumulate). That is by
    # design; it is not a rogue Docker Desktop autostart.
    try {
        $invokedAt = [DateTime]::Now
        $null = & $TaskInvoker $TaskName

        # Poll, bounded. 267009 = "task currently running": for a GUI exe that
        # is proof the action launched and is alive, so both it and 0 count as
        # executed. Anything else — 1 from a broken action, a file-not-found
        # code — is a task that ran and its action failed.
        #
        # ⚠ Read as [long], never [int]. Every real Windows failure code is an
        # HRESULT with the high bit set (0x800710E0 = 2147946720), and a [int]
        # cast of one THROWS rather than wrapping — so the poll loop died and
        # the check degraded to `execute:ERROR`, which reads as "the instrument
        # broke", never as the failure the value actually names. The unit suite
        # missed it because its only failing fixture was result=1: the code and
        # its fixtures were both Int32-shaped.
        $deadline = [DateTime]::Now.AddMilliseconds($ExecuteProbeTimeoutMs)
        $info = $null
        do {
            Start-Sleep -Milliseconds 250
            $info = & $TaskInfoReader $TaskName
            if ($null -ne $info -and $info.LastRunTime -ge $invokedAt.AddSeconds(-2) -and [long]$info.LastTaskResult -ne 267009) { break }
        } while ([DateTime]::Now -lt $deadline)

        if ($null -eq $info) {
            $checks.Add('execute:NO-INFO')
            return [PSCustomObject]@{ Ready = $false; Reason = "execute: could not read task '$TaskName' back after invoking it"; Checks = $checks.ToArray() }
        }
        if ($info.LastRunTime -lt $invokedAt.AddSeconds(-2)) {
            $checks.Add('execute:STALE')
            return [PSCustomObject]@{ Ready = $false; Reason = "execute: task '$TaskName' was invoked but LastRunTime never advanced (still $($info.LastRunTime))"; Checks = $checks.ToArray() }
        }
        $result = [long]$info.LastTaskResult

        # 0x800710E0 = the scheduler refused to start the task. Beside a LIVE
        # instance that is the already-running signature measured on po-2025
        # (2026-09-21 11:02Z): nothing was exercised, and nothing failed. Report
        # it as such — a FAILED + ESCALATE here would raise a daily alarm on a
        # perfectly healthy host, and a bare pass would claim a proof this run
        # never performed. The state guard is what keeps the mapping from
        # swallowing a genuine refusal that happens to carry the same code.
        if ($result -eq 2147946720) {
            $taskState = ''
            try { $taskState = [string](& $TaskStateReader $TaskName) } catch { $taskState = '' }
            if ($taskState -eq 'Running') {
                $checks.Add('execute:SKIPPED(already-running)')
                return [PSCustomObject]@{
                    Ready  = $true
                    Reason = "relaunch path proven (registration-only — task '$TaskName' is already running, so the second start was refused with 0x800710E0: no fresh exercise performed)"
                    Checks = $checks.ToArray()
                }
            }
        }

        if ($result -ne 0 -and $result -ne 267009) {
            $checks.Add("execute:FAILED(result=$result)")
            return [PSCustomObject]@{ Ready = $false; Reason = ("execute: task '{0}' ran and its action failed (LastTaskResult={1} / 0x{1:X8})" -f $TaskName, $result); Checks = $checks.ToArray() }
        }
        $checks.Add("execute:OK(result=$result)")
    } catch {
        $checks.Add('execute:ERROR')
        return [PSCustomObject]@{ Ready = $false; Reason = "execute: $($_.Exception.Message)"; Checks = $checks.ToArray() }
    }

    return [PSCustomObject]@{ Ready = $true; Reason = 'relaunch path proven (registered, read back and executed)'; Checks = $checks.ToArray() }
}

function Get-WedgeDecision {
    <#
        PURE decision function: no I/O, no clock, no network. Every input is
        injected, so every branch below is reachable from a unit test — which is
        the point. The previous attempt's logic could only be exercised by
        shipping it to the production hub and waiting for a real wedge.

        DETECTION ONLY — there is no actuator, by construction and by mandate
        (#172 AC4). The terminal verdict is 'escalate'. A container restart
        cannot fix a forwarder wedge (13 were tried on 2026-09-20, all useless)
        and an engine teardown is what turned a wedge into a host with no engine
        at all. The only thing that rebuilds the forwarder is a host reboot,
        which is a human's decision, so the correct output is a loud line.

        Returns @{ Action = 'none'|'arm'|'escalate'; Wedge = <int>;
                   Signature = 'disabled'|'healthy'|'hub-down'|'inconclusive'|'wedge';
                   Reason = <string> }

          none      nothing to act on; reset the counter. `Signature` says why,
                    because "nothing" has five different causes here and an
                    operator needs to know which one.
          arm       first sighting; count it, log it, touch nothing (1 of 2)
          escalate  confirmed wedge. Log with a greppable label and escalate to
                    a human. THIS IS THE TERMINAL STATE.

        Every verdict names the condition that decided it. A verdict that does
        not say which of its conditions failed is how "one probe of two is dead"
        became "everything is dead" on 2026-09-20.
    #>
    param(
        [Parameter(Mandatory)][bool]$LoopbackV6Healthy,
        [Parameter(Mandatory)][bool]$LoopbackV4Healthy,
        [Parameter(Mandatory)][bool]$ServingHealthy,
        [Parameter(Mandatory)][bool]$LoopbackListening,
        [int]$ConsecutiveWedge = 0,
        [bool]$OptIn = $false,
        [int]$ConfirmCycles = 2
    )

    $none = {
        param($Reason, $Signature)
        [PSCustomObject]@{ Action = 'none'; Wedge = 0; Signature = $Signature; Reason = $Reason }
    }

    # AC5: the watch is gated on an explicit flag and is OFF by default, so a
    # machine that never asked for it is untouched — including by the probes.
    # This gate is FIRST on purpose: the 2026-09-20 arming happened because a
    # probe change could reach machines that had not opted in.
    if (-not $OptIn) {
        return & $none "wedge watch not enabled on this machine (create <ClaudishHome>\$($script:OptInFileName) containing '$($script:OptInToken)')" 'disabled'
    }

    # Healthy: the door everything local goes through answers. Nothing else
    # matters, so nothing else is consulted.
    if ($LoopbackV6Healthy) {
        return & $none 'loopback [::1] healthy' 'healthy'
    }

    # THE DISCRIMINANT (#172). v6 is dead. What the OTHER families say is what
    # separates the two outages that look identical from an operator's seat:
    #
    #   v6 dead + v4/LAN alive  -> forwarder wedge. No container action helps;
    #                              13 restarts proved it on 2026-09-20.
    #   v6 dead + v4/LAN dead   -> the hub itself. The hang/restart path owns
    #                              it, and claiming a wedge here would send an
    #                              operator chasing the forwarder during an
    #                              ordinary outage — the mirror image of the
    #                              mistake this detector exists to prevent.
    if (-not ($LoopbackV4Healthy -or $ServingHealthy)) {
        return & $none 'all families dead ([::1], 127.0.0.1, serving) — the hub itself, not a forwarder wedge; the hang path owns this' 'hub-down'
    }

    # Fail-safe. No visible [::1] listener means either this machine does not
    # route localhost through a WSL relay, or the TCP table cannot enumerate it
    # (networkingMode=mirrored, where empty means "not visible", NEVER "not
    # serving"). An instrument that cannot see does not get to conclude.
    if (-not $LoopbackListening) {
        return & $none 'no [::1] listener visible — nothing to wedge, or the TCP table cannot enumerate it (mirrored)' 'inconclusive'
    }

    $wedge = $ConsecutiveWedge + 1
    $alive = @()
    if ($LoopbackV4Healthy) { $alive += '127.0.0.1' }
    if ($ServingHealthy)    { $alive += 'serving' }
    $detail = "[::1] listening but not answering while $($alive -join '+') answer"

    if ($wedge -lt $ConfirmCycles) {
        return [PSCustomObject]@{
            Action = 'arm'; Wedge = $wedge; Signature = 'wedge'
            Reason = "$detail ($wedge/$ConfirmCycles) — counting, no action"
        }
    }

    # The terminal verdict. There is deliberately nothing past this point:
    # escalation IS the outcome, per #172 AC4. A container restart cannot fix a
    # wedge and an engine teardown is what turned a wedge into a dead host at
    # 13:18 on 2026-09-20, so the correct actuator is a human reading this line.
    return [PSCustomObject]@{
        Action = 'escalate'; Wedge = $wedge; Signature = 'wedge'
        Reason = "confirmed ${wedge}/${ConfirmCycles}: $detail — container restarts CANNOT fix this (13 tried 2026-09-20); only a host reboot rebuilds the forwarder. Escalating, no action taken."
    }
}

function Get-EngineZombieDecision {
    <#
        PURE decision function, same shape as Get-WedgeDecision: no I/O, no
        clock, no process table — every input injected, every branch reachable
        from a unit test.

        Names the state that until #530 was invisible: the engine is down, the
        Docker Desktop GUI process is PRESENT, and this has persisted across
        cycles. A GUI that is up while its engine stays dead is not a recovery
        in progress — it is a zombie holding the only recovery lever the
        watchdog has: the proven GUI-absent relaunch path cannot fire while
        the process exists (the 2026-08-29 lesson — the "relaunch" that ran
        was a useless single-instance forward, and a human had to reboot a
        second time).

        Returns @{ Action = 'none'|'arm'|'escalate'; Streak = <int>;
                  Kill = <bool>; Reason = <string> }

          none      nothing zombie-shaped; reset the streak. `Reason` says
                    which non-zombie state decided it — engine healthy, or
                    engine down with the GUI ABSENT (that one belongs to the
                    relaunch path, not to this watch).
          arm       sighting below threshold: counted, logged, touched nothing.
          escalate  the streak reached $ZombieThreshold while the GUI held.
                    Marker + escalation.
          Kill      $true ONLY on escalate AND $KillArmed — the caller's
                    Test-GuiZombieKillOptIn consent. The kill is Stop-Process
                    on the GUI alone, never the service, so the GUI-absent
                    relaunch path fires on the NEXT cycle and does the real
                    recovery. This function only computes the verdict; the
                    actuator lives in the watchdog, behind the consent.
    #>
    param(
        [Parameter(Mandatory)][bool]$EngineUp,
        [Parameter(Mandatory)][bool]$GuiPresent,
        [int]$ConsecutiveZombie = 0,
        [bool]$KillArmed = $false,
        [int]$ZombieThreshold = 3
    )

    if ($EngineUp) {
        return [PSCustomObject]@{
            Action = 'none'; Streak = 0; Kill = $false
            Reason = 'engine healthy'
        }
    }
    if (-not $GuiPresent) {
        return [PSCustomObject]@{
            Action = 'none'; Streak = 0; Kill = $false
            Reason = 'engine down, GUI absent — the relaunch path owns this, not a zombie'
        }
    }

    $streak = $ConsecutiveZombie + 1
    if ($streak -lt $ZombieThreshold) {
        return [PSCustomObject]@{
            Action = 'arm'; Streak = $streak; Kill = $false
            Reason = "engine down with GUI present ($streak/$ZombieThreshold) — counting, no action"
        }
    }

    return [PSCustomObject]@{
        Action = 'escalate'; Streak = $streak; Kill = $KillArmed
        Reason = "GUI present but engine down across $streak consecutive cycles — the GUI holds the relaunch path dead"
    }
}

function Get-EngineFatalStreakThreshold { return $script:EngineFatalStreakThreshold }
function Get-EngineFatalStreakMarkerName { return $script:EngineFatalStreakMarkerName }

function Get-EngineFatalStreakDecision {
    <#
        #530 gap 2 — the pure half of the consecutive-FATAL escalation.

        Input is the streak ALREADY stored (cycles before this one); the
        decision counts THIS cycle in. Three outcomes:
          arm       below threshold — count, log, no marker.
          escalate  this cycle reaches the threshold.
          (escalate continues) above threshold — still escalated, but the
                    marker is NOT written again: once per CROSSING, not per
                    cycle, or a stuck engine would rewrite the journal at every
                    tick and the relay would report the same crossing for ever.

        `WriteMarker` is therefore true on exactly one value of the streak.
        Deliberately no reset case here: recovery is not a failure decision and
        the caller owns it (a reset must also remove the marker, which this
        pure function must not know how to do).
    #>
    param(
        [int]$ConsecutiveFatal = 0,
        [int]$Threshold = $script:EngineFatalStreakThreshold
    )

    $streak = $ConsecutiveFatal + 1
    if ($streak -lt $Threshold) {
        return [PSCustomObject]@{
            Action = 'arm'; Streak = $streak; WriteMarker = $false
            Reason = "engine FATAL ($streak/$Threshold) — counting, no escalation yet"
        }
    }
    return [PSCustomObject]@{
        Action = 'escalate'; Streak = $streak; WriteMarker = ($streak -eq $Threshold)
        Reason = "engine FATAL across $streak consecutive cycles — an engine down >30 min on the hub is a fleet event"
    }
}

function ConvertTo-WatchdogStateJson {
    <#
        .SYNOPSIS
            Pure codec half: sidecar-host-watchdog state hashtable -> file JSON.

        The stamp is normalized to Kind=Utc before formatting, so the file
        always carries the "...Z" form whatever Kind a caller stored — every
        reader (any seat, any hand reset) round-trips to the same instant.
        MinValue is the documented "never acted" sentinel and serializes as
        null.
    #>
    param(
        [Parameter(Mandatory)][hashtable]$State
    )
    $last = $null
    if ($null -ne $State.LastEngineActionUtc -and $State.LastEngineActionUtc -ne [datetime]::MinValue) {
        $last = $State.LastEngineActionUtc.ToUniversalTime().ToString('o')
    }
    $obj = @{
        engineFailures        = [int]$State.EngineFailures
        lastEngineActionUtc   = $last
        engineActionsSinceDown = [int]$State.EngineActionsSinceDown
    }
    return ($obj | ConvertTo-Json)
}

function ConvertFrom-WatchdogStateJson {
    <#
        .SYNOPSIS
            Pure codec half: state-file JSON -> state hashtable.

        THROWS on anything undecodable — the caller must surface that as
        state_read_error and an inert run, never a silent reset of the
        counters (a fresh-looking state re-arms R2 inside an episode it
        already acted on). The parse itself is instant-exact: a bare
        [datetime] cast is Kind-broken on 5.1 in BOTH directions ("...Z"
        converts to local wall time, "+02:00" has the offset stripped
        unapplied), which read the last engine action 2 h off in production
        (myia-po-2028, 2026-10-24: since_last_action -44..-81 against a
        30-min cooldown). [DateTimeOffset]::Parse yields the correct instant
        for both forms; .UtcDateTime is Kind=Utc, making the downstream
        subtraction sound.

        A null or empty stamp decodes to [datetime]::MinValue — never a cast
        of $null (which throws on 5.1, and behind a silent catch reset
        EngineFailures to 0 on every run: R2/R3 unreachable on a fresh host).
        Missing counters default to 0.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Json
    )
    $raw = $Json | ConvertFrom-Json
    $lastAction = [datetime]::MinValue
    # Property access is defensive on purpose: the module runs under
    # Set-StrictMode, and a hand-written or partially-written state file must
    # decode to the documented defaults, not throw on a missing key.
    $stampRaw = $null
    if ($raw.PSObject.Properties['lastEngineActionUtc']) { $stampRaw = $raw.lastEngineActionUtc }
    if ($null -ne $stampRaw -and "$stampRaw" -ne '') {
        if ($stampRaw -is [datetime]) {
            # PowerShell 7's ConvertFrom-Json has ALREADY parsed the ISO string
            # (Kind=Utc for "...Z", Local for an offset form). Its [string] form
            # is "10/24/2026 10:00:00": no offset, no sub-second part, so a
            # re-parse lands on local wall time, 2 h off on a UTC+2 seat
            # (measured on 7.6.6 / fr-FR, review #639 r2). Keep the instant.
            $lastAction = $stampRaw.ToUniversalTime()
        } elseif ($stampRaw -is [DateTimeOffset]) {
            $lastAction = $stampRaw.UtcDateTime
        } else {
            # Windows PowerShell 5.1 leaves the stamp a String.
            $lastAction = [DateTimeOffset]::Parse([string]$stampRaw, [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        }
    }
    $failures = 0
    if ($raw.PSObject.Properties['engineFailures'] -and $null -ne $raw.engineFailures) { $failures = [int]$raw.engineFailures }
    $sinceDown = 0
    if ($raw.PSObject.Properties['engineActionsSinceDown'] -and $null -ne $raw.engineActionsSinceDown) { $sinceDown = [int]$raw.engineActionsSinceDown }
    return @{
        EngineFailures         = $failures
        LastEngineActionUtc    = $lastAction
        EngineActionsSinceDown = $sinceDown
    }
}

function Get-EngineWatchdogDecision {
    <#
        .SYNOPSIS
            PURE ladder of the sidecar host watchdog: one failing sighting in,
            one action + next state out. No I/O, no clock (NowUtc injected),
            no network, no actuation.

        Order is load-bearing, each rung named for what preempts it:
          up                    reset counters (stamp kept: a success must not
                                erase the cooldown clock)
          unknown               the probe could not even LAUNCH (PATH drift,
                                docker.exe unresolvable). Not a liveness
                                verdict: no increment, no actuation. Acting on
                                it let R2 terminate the distro of a healthy
                                engine (review #639 point 3).
          pending               failures < threshold: count, log, touch nothing
          guard_drain           a claudish-drain owns the lifecycle right now
          guard_cooldown        the last engine action is younger than the
                                cooldown
          r3_wsl_service_wedged the WSL service class (measured 2026-10-24
                                afternoon): no Docker rung can reach it,
                                escalate only
          r3_after_r2           R2 already fired once this episode (once per
                                episode, never a repeated teardown — the
                                rebuild half held 1 of 2, #172 AC4)
          r2_standalone         a host ClaudishWatchdog task exists: single
                                observer per failure path — R2 stands down,
                                escalations stay
          r2_terminate          the measured read path: terminate the
                                docker-desktop distro, Desktop respawns it
          r3_no_backend         no Desktop backend to respawn: escalate only

        Terminal rungs stamp the cooldown clock and reset the failure counter
        (they said their line; the cooldown bounds the repeats). DryRun
        computes the same action but returns the input state UNCHANGED: a dry
        run measures, it must not move the state machine.
    #>
    param(
        [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)][ValidateSet('up', 'down', 'hang', 'unknown')][string]$EngineVerdict,
        [Parameter(Mandatory)][bool]$DrainInFlight,
        [Parameter(Mandatory)][bool]$BackendPresent,
        [Parameter(Mandatory)][ValidateSet('ok', 'timeout')][string]$WslVerdict,
        [Parameter(Mandatory)][bool]$HostWatchdogPresent,
        [Parameter(Mandatory)][datetime]$NowUtc,
        [int]$ConsecutiveEngineFailures = 2,
        [int]$EngineCooldownMin = 30,
        [switch]$DryRun
    )

    $next = @{
        EngineFailures         = [int]$State.EngineFailures
        LastEngineActionUtc    = $State.LastEngineActionUtc
        EngineActionsSinceDown = [int]$State.EngineActionsSinceDown
    }

    if ($EngineVerdict -eq 'up') {
        $next.EngineFailures = 0
        $next.EngineActionsSinceDown = 0
        return [PSCustomObject]@{ Action = 'reset'; NextState = $next; SinceActionMin = $null; Reason = 'engine up' }
    }

    if ($EngineVerdict -eq 'unknown') {
        return [PSCustomObject]@{
            Action = 'engine_unknown'; NextState = $next; SinceActionMin = $null
            Reason = 'engine probe could not launch — not a liveness verdict, not this watchdog class'
        }
    }

    $next.EngineFailures++
    $sinceAction = ($NowUtc - $State.LastEngineActionUtc).TotalMinutes

    if ($next.EngineFailures -lt $ConsecutiveEngineFailures) {
        $action = 'pending'; $reason = "engine failing ($($next.EngineFailures)/$ConsecutiveEngineFailures) — counting"
    } elseif ($DrainInFlight) {
        $action = 'guard_drain'; $reason = 'a claudish-drain owns the container lifecycle — recovery of a deliberate gesture is not this watchdog'
    } elseif ($sinceAction -lt $EngineCooldownMin) {
        $action = 'guard_cooldown'; $reason = "last engine action ${sinceAction} min ago < ${EngineCooldownMin} min"
    } elseif ($WslVerdict -eq 'timeout') {
        $action = 'r3_wsl_service_wedged'; $reason = 'WSL service wedge: no Docker rung can reach the host<->VM channel — escalate only'
    } elseif ($State.EngineActionsSinceDown -ge 1) {
        $action = 'r3_after_r2'; $reason = 'R2 already fired once this outage episode — escalate, never a repeated teardown'
    } elseif ($HostWatchdogPresent) {
        $action = 'r2_standalone'; $reason = 'a host ClaudishWatchdog task exists — single observer per failure path, R2 stands down'
    } elseif ($BackendPresent) {
        $action = 'r2_terminate'; $reason = 'backend present: the measured read path — terminate the distro, Desktop respawns it'
        $next.EngineActionsSinceDown++
    } else {
        $action = 'r3_no_backend'; $reason = 'no Desktop backend to respawn the distro — escalate only'
    }

    if ($action -notin @('pending', 'guard_drain', 'guard_cooldown')) {
        # Terminal: said its line; the cooldown bounds the repeats.
        $next.LastEngineActionUtc = ([DateTimeOffset]$NowUtc).UtcDateTime
        $next.EngineFailures = 0
    }
    if ($DryRun) {
        # A dry run measures; it must not move the state machine (its failure
        # counters and cooldown would fire on the next real run as if work
        # had been done). The action above is still the honest one.
        $next = @{
            EngineFailures         = [int]$State.EngineFailures
            LastEngineActionUtc    = $State.LastEngineActionUtc
            EngineActionsSinceDown = [int]$State.EngineActionsSinceDown
        }
    }
    return [PSCustomObject]@{ Action = $action; NextState = $next; SinceActionMin = $sinceAction; Reason = $reason }
}

function Select-WslrelaySquatters {
    <#
        .SYNOPSIS
            PURE selection of the wslrelay loopback squatters for R1.

        Inputs are injected tables (a connections list shaped like
        Get-NetTCPConnection rows, a pid -> process object map), so the three
        safety rules are pinnable without touching the machine:
          - nothing is selected unless IPv4 loopback is ALIVE: the measured R1
            wedge shape is "v6 dead while 127.0.0.1 serves". Both dead is a
            different class (engine down, drained recreate) where killing the
            relay fixes nothing and tears down a listener that may be
            legitimate;
          - only loopback addresses (127.0.0.1 / ::1) are ever considered;
          - only a process NAMED wslrelay is ever selected — never the Docker
            backend, never anything else that took the port.
    #>
    param(
        [Parameter(Mandatory)][object[]]$Connections,
        [Parameter(Mandatory)][hashtable]$Processes,
        [Parameter(Mandatory)][bool]$Ipv4Alive
    )
    $selected = @()
    if (-not $Ipv4Alive) { return $selected }
    foreach ($c in $Connections) {
        if ($null -eq $c) { continue }
        if ($c.LocalAddress -ne '127.0.0.1' -and $c.LocalAddress -ne '::1') { continue }
        $p = $Processes[[int]$c.OwningProcess]
        if ($null -eq $p -or $p.ProcessName -ne 'wslrelay') { continue }
        $selected += [PSCustomObject]@{ ProcId = [int]$c.OwningProcess; LocalAddress = $c.LocalAddress; StartTime = $p.StartTime }
    }
    return $selected
}

function Get-LoopbackVerdict {
    <#
        .SYNOPSIS
            PURE verdict over the TWO loopback families.

        The verdict used to read `if ($Ipv6Alive) { 'HEALTHY' } ...`, so a dead
        IPv4 leg was invisible. Measured 2026-10-25 on myia-po-2028 (third
        wedge in three days): 127.0.0.1:3000 accepted TCP and never answered
        while [::1]:3000 served 200 in 8 ms, and the organ logged HEALTHY with
        v4=False for 16 h. The class matters because a client that resolves
        `localhost` to 127.0.0.1 does not get an error - the connection
        ESTABLISHES - so there is no timeout to trip and the agent hangs.

        LOOPBACK4_DOWN is therefore a DEGRADED verdict, never a healthy one.
    #>
    param(
        [Parameter(Mandatory)][bool]$Ipv4Alive,
        [Parameter(Mandatory)][bool]$Ipv6Alive
    )
    if ($Ipv6Alive -and $Ipv4Alive) { return 'HEALTHY' }
    if ($Ipv6Alive) { return 'LOOPBACK4_DOWN' }
    if ($Ipv4Alive) { return 'LOOPBACK6_DOWN' }
    return 'LOOPBACK_DEAD'
}

function Get-CurlHttpProbeVerdict {
    <#
        .SYNOPSIS
            PURE reading of curl's -w '%{http_code}' output.

        '000' is curl's NO-RESPONSE code. The old belt accepted any three-digit
        string (`-match '^\d{3}$'`), so a failed probe was read as "IPv6 alive"
        - measured 2026-10-25: every tick logged `curl_http=000` AND `v6=True`,
        i.e. this bug alone kept the verdict healthy.

        Root cause of the 000 itself, measured the same day: without
        --globoff, curl reads the brackets of a literal `[::1]` URL as a glob
        range and never connects (`-g` on the same URL, same second: 200). Both
        halves are fixed - the invocation and this reading - because either one
        alone would let the other regress silently.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Raw)
    $code = ([string]$Raw).Trim()
    if ($code -match '^0{3}$') { return 'no_answer' }
    if ($code -match '^[1-5]\d{2}$') { return 'alive' }
    return 'unparsable'
}

function Invoke-GitBounded {
    <#
    .SYNOPSIS
        Run one git command, bounded, never throwing.
    .DESCRIPTION
        Same shape as the watchdog's Invoke-DockerBounded, and for the same
        reason: an unbounded child process is how a 15-minute watchdog turns
        into a permanently stuck one. git in particular can block on a locked
        index while another process writes the tree.

        Touching .Handle before WaitForExit is load-bearing — without it,
        -PassThru hands back an object whose .ExitCode stays $null, so every
        successful call reads as a failure. That trap already cost a cycle on
        2026-09-02 in the docker equivalent.
    #>
    param(
        [string]$WorkDir,
        [string[]]$GitArgs,
        [int]$TimeoutSec = 10
    )

    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    $safeCfg = $null
    $prevGlobal = $env:GIT_CONFIG_GLOBAL
    try {
        # git refuses any repository whose owner differs from the invoking
        # principal (exit 128, "dubious ownership") BEFORE answering anything —
        # exactly the case of a SYSTEM scheduled task running scripts from an
        # operator-owned tree. Measured on po-2025, 2026-09-20: every PROVENANCE
        # line read "unversioned (exit 128)" while the tree was clean on main,
        # so the one observability line this module has said nothing, on the
        # one machine that motivated it.
        #
        # The toplevel cannot be asked from git (it refuses first), so every
        # ANCESTOR of the work dir is declared safe: safe.directory matches
        # exact paths only, so this trusts a repo rooted at one of those
        # specific directories and nothing else. safe.directory is deliberately
        # ignored in repository config and via -c, which is why the config file
        # rides GIT_CONFIG_GLOBAL scoped to this child process — the only route
        # that needs no elevation and no write to SYSTEM's profile.
        #
        # The config REPLACES the user's global config for these calls only;
        # the commands here are read-only provenance queries, and under SYSTEM
        # the global config was empty anyway.
        try {
            $safe = New-Object System.Collections.Generic.List[string]
            $dir = [System.IO.Path]::GetFullPath($WorkDir)
            # The separator is built from [char]92 rather than written as a
            # literal: a lone backslash inside a string literal has already
            # been eaten once by an escaping layer (python read ' as an
            # escaped quote and left Replace('', '/'), which throws on an
            # empty oldValue and silently disarmed this whole workaround).
            $bsep = [string][char]92
            while ($true) {
                $safe.Add($dir.Replace($bsep, '/'))
                $parent = Split-Path -Parent $dir
                if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { break }
                $dir = $parent
            }
            $safeCfg = [System.IO.Path]::GetTempFileName()
            # #184: the temp config ADDS safe.directory instead of REPLACING the
            # operator's global config. Pointing GIT_CONFIG_GLOBAL at a [safe]
            # block alone silently dropped core.excludesFile, so the operator's
            # global gitignore stopped applying to these calls and the
            # PROVENANCE line read untracked-only(2) where plain git said 1 —
            # two different numbers for the same tree, with nothing on the line
            # telling the reader which one to believe.
            #
            # `[include]` is the route that keeps both, MEASURED 2026-09-21 under
            # GIT_TEST_ASSUME_DIFFERENT_OWNER=1 in a scratch repo: with the [safe]
            # grant in the MAIN file and the operator's config included, git
            # exits 0 (a no-route control exits 128 on the same tree) AND the
            # included core.excludesFile still applies — `status --porcelain`
            # listed only the real untracked file, where the replace route listed
            # two. Two fixture traps were hit measuring it, and both are worth
            # keeping: a raw Windows backslash inside an include value is a PARSE
            # error ("bad config line 2"), and so is a `key = value` line without
            # its section header. In each case git answers nothing, and its
            # `fatal:` line was itself counted as a status line by the probe.
            #
            # Only files that EXIST are included, in git's own precedence order:
            # $GIT_CONFIG_GLOBAL, then $XDG_CONFIG_HOME/git/config, then
            # ~/.gitconfig. Under SYSTEM none of them exists, so the config
            # carries the [safe] block alone — byte-identical to the behaviour
            # before this change, which is the case #183 was built for.
            $includeTargets = New-Object System.Collections.Generic.List[string]
            if (-not [string]::IsNullOrWhiteSpace($prevGlobal)) { $includeTargets.Add($prevGlobal) }
            $xdgHome = $env:XDG_CONFIG_HOME
            if ([string]::IsNullOrWhiteSpace($xdgHome)) { $xdgHome = Join-Path $HOME '.config' }
            $includeTargets.Add((Join-Path $xdgHome 'git/config'))
            $includeTargets.Add((Join-Path $HOME '.gitconfig'))
            $includeLines = New-Object System.Collections.Generic.List[string]
            foreach ($target in $includeTargets) {
                if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
                    $includeLines.Add("`tpath = " + $target.Replace($bsep, '/'))
                }
            }
            $lines = @()
            if ($includeLines.Count -gt 0) { $lines += @('[include]') + $includeLines.ToArray() }
            $lines += @('[safe]') + @($safe | ForEach-Object { "`tdirectory = $_" })
            [System.IO.File]::WriteAllText($safeCfg, ($lines -join "`n") + "`n")
            $env:GIT_CONFIG_GLOBAL = $safeCfg
        } catch {
            # Without the workaround the call behaves exactly as before this
            # change: run, and let dubious ownership surface as exit 128.
            $safeCfg = $null
            if ($null -ne $prevGlobal) { $env:GIT_CONFIG_GLOBAL = $prevGlobal } else { Remove-Item Env:GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue }
        }

        $all = @('-C', $WorkDir) + $GitArgs
        $p = Start-Process -FilePath 'git' -ArgumentList $all -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $null = $p.Handle
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            try { $p.Kill() } catch {}
            return @{ Ok = $false; Out = ''; Reason = 'git timed out' }
        }
        $out = ''
        try { $out = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue) } catch {}
        if ($null -eq $out) { $out = '' }
        return @{ Ok = ($p.ExitCode -eq 0); Out = $out.Trim(); Reason = "exit $($p.ExitCode)" }
    }
    catch {
        # git.exe never launched: absent from PATH is the expected case under a
        # SYSTEM principal, whose PATH is not the operator's.
        return @{ Ok = $false; Out = ''; Reason = 'git not launchable' }
    }
    finally {
        if ($null -ne $prevGlobal) { $env:GIT_CONFIG_GLOBAL = $prevGlobal } else { Remove-Item Env:GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue }
        if ($safeCfg) { Remove-Item $safeCfg -Force -ErrorAction SilentlyContinue }
        Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

function ConvertFrom-DockerEventLine {
    <#
    .SYNOPSIS
        Parse one `docker events --format "{{json .}}"` line into the fields
        attribution actually needs.
    .DESCRIPTION
        The line is EVIDENCE, so the parser is deliberately forgiving: a line
        that cannot be read returns $null rather than throwing, because this runs
        on every tick of a scheduled task where an exception costs the whole
        window. What it must never do is read a line as an event when it is not
        one, so `Action` is required — everything else defaults.

        `ExitCode` comes from Actor.Attributes and is the field the 2026-09-20
        incident could not recover at all (the die events were already evicted).
        It is a STRING, not a number: docker reports it as a string and a
        missing key must stay distinguishable from a 0 — an exit code of 0 and no
        exit code are different facts about a restart.

        Property access is guarded rather than dotted: the module runs under
        Set-StrictMode -Version Latest, where a missing property on a
        PSCustomObject is a terminating error, and a provider-shaped line from a
        different docker version must degrade to a $null event, never to a dead
        collector.
    #>
    param([string]$Line)

    if ([string]::IsNullOrWhiteSpace($Line)) { return $null }

    $obj = $null
    try { $obj = $Line | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
    if ($null -eq $obj) { return $null }

    $props = @{}
    try { foreach ($p in $obj.PSObject.Properties) { $props[$p.Name] = $p.Value } } catch { }
    $action = ''
    if ($props.ContainsKey('Action')) { $action = [string]$props['Action'] }
    if ([string]::IsNullOrWhiteSpace($action)) { return $null }

    $type = ''
    if ($props.ContainsKey('Type')) { $type = [string]$props['Type'] }
    $tn = 0
    if ($props.ContainsKey('timeNano')) { try { $tn = [int64]$props['timeNano'] } catch { $tn = 0 } }

    $id = ''; $name = ''; $image = ''; $exitCode = ''
    if ($props.ContainsKey('Actor') -and $null -ne $props['Actor']) {
        $actor = $props['Actor']
        $actorProps = @{}
        try { foreach ($p in $actor.PSObject.Properties) { $actorProps[$p.Name] = $p.Value } } catch { }
        if ($actorProps.ContainsKey('ID')) { $id = [string]$actorProps['ID'] }
        if ($actorProps.ContainsKey('Attributes') -and $null -ne $actorProps['Attributes']) {
            $attrs = $actorProps['Attributes']
            $attrProps = @{}
            try { foreach ($p in $attrs.PSObject.Properties) { $attrProps[$p.Name] = $p.Value } } catch { }
            if ($attrProps.ContainsKey('name'))     { $name = [string]$attrProps['name'] }
            if ($attrProps.ContainsKey('image'))    { $image = [string]$attrProps['image'] }
            if ($attrProps.ContainsKey('exitCode')) { $exitCode = [string]$attrProps['exitCode'] }
        }
    }

    return [PSCustomObject]@{
        TimeNano    = $tn
        Action      = $action
        Type        = $type
        ContainerId = $id
        Name        = $name
        Image       = $image
        ExitCode    = $exitCode
    }
}

function Get-DockerEventFingerprint {
    <#
        The identity of one event, for cross-window dedupe.

        A fingerprint rather than a bare id because a container produces MANY
        events: start, die, destroy and create all share an actor, so keying on
        the id alone would silently drop every event after the first for that
        container. timeNano gives nanosecond resolution, which is what makes two
        events of the same action on the same container distinguishable.
    #>
    param($Event)

    if ($null -eq $Event) { return '' }
    return ('{0}|{1}|{2}' -f $Event.TimeNano, $Event.Action, $Event.ContainerId)
}

function Get-DockerEventActionName {
    <#
    .SYNOPSIS
        The bare action verb, stripped of the payload docker appends after a colon.
    .DESCRIPTION
        Docker writes two shapes into the same field: a bare verb (`start`, `die`)
        and `verb: payload`. The payload is what makes this function necessary —
        for `exec_create` and `exec_start` it is THE FULL COMMAND LINE, so any
        membership test written against the raw field silently fails to match and
        the event sails through an allowlist that names the verb.
    #>
    param([string]$Action)

    if ([string]::IsNullOrWhiteSpace($Action)) { return '' }
    $idx = $Action.IndexOf(':')
    if ($idx -lt 0) { return $Action.Trim() }
    return $Action.Substring(0, $idx).Trim()
}

function Get-DockerEventLifecycleActions {
    <#
    .SYNOPSIS
        The container actions this collector exists to preserve — the single
        source of truth for both the daemon-side filter and the sink guard.
    .DESCRIPTION
        `health_status` is deliberately ABSENT despite carrying no command line.
        With a healthcheck every 30s across the ~38 containers measured on these
        hosts it would dominate the file, and the 5 MB rotation would then evict
        the restart events #169 exists to keep. A collector whose noise pushes out
        its own signal has the defect it was built to fix.
    #>
    return @(
        'create'
        'start'
        'stop'
        'die'
        'kill'
        'restart'
        'destroy'
        'oom'
        'pause'
        'unpause'
        'rename'
        'update'
    )
}

function Get-DockerEventsFilterArgs {
    <#
    .SYNOPSIS
        The `--filter` arguments that keep command-bearing events INSIDE the
        daemon, so they are never read, let alone written.
    .DESCRIPTION
        Built from Get-DockerEventLifecycleActions so the wire filter and the sink
        guard cannot drift apart — two lists naming the same policy is how one of
        them ends up stale. Repeated `--filter event=` is an OR on docker's side.
    #>
    param([string[]]$Actions = @(Get-DockerEventLifecycleActions))

    $out = @('--filter', 'type=container')
    foreach ($a in @($Actions)) {
        if ([string]::IsNullOrWhiteSpace($a)) { continue }
        $out += '--filter'
        $out += ("event={0}" -f $a)
    }
    return $out
}

function Select-LifecycleDockerEvents {
    <#
    .SYNOPSIS
        Refuse to persist anything outside the lifecycle allowlist — enforced at
        the sink, independently of the daemon-side filter.
    .DESCRIPTION
        WHY THIS IS NOT REDUNDANT WITH THE FILTER (incident 2026-09-21). Before
        this, the only filter was `type=container`, which admits `exec_create` and
        `exec_start` — and docker puts the executed COMMAND LINE in their Action
        field. Every Docker healthcheck that passes a secret as an argument was
        therefore copied verbatim into a persisted, rotated log, every 15 minutes.
        Measured on ai-01 in a dry-run: 328 events in 8s, 328 of them carrying a
        command line, several belonging to OTHER workspaces' containers — and
        lifecycle events: 0 of 328. The collector captured none of what it exists
        for and all of what it must never touch, from one missing filter.

        So the filter is the fix and this is the guard: a server-side filter is a
        REQUEST, honored by whatever docker version is installed, and the thing it
        protects is third-party secrets. The guard holds on the one machine whose
        daemon answers differently, and it is testable without docker at all.

        `exec_*` is refused unconditionally, even if an operator widens -Actions:
        the allowlist expresses which events are useful, this expresses which are
        never safe to write down. Those are different questions.
    #>
    param(
        $Events,
        [string[]]$Actions = @(Get-DockerEventLifecycleActions)
    )

    $allow = @{}
    foreach ($a in @($Actions)) { if ($a) { $allow[$a.ToLowerInvariant()] = $true } }

    $kept = @()
    $dropped = @()
    foreach ($e in @($Events)) {
        if ($null -eq $e) { continue }
        $name = (Get-DockerEventActionName -Action $e.Action).ToLowerInvariant()
        # Unconditional: these carry the command line in the Action payload.
        if ($name.StartsWith('exec_')) { $dropped += $e; continue }
        if ($allow.ContainsKey($name)) { $kept += $e } else { $dropped += $e }
    }

    return [PSCustomObject]@{
        Kept    = $kept
        Dropped = $dropped
    }
}

function Select-NewDockerEvents {
    <#
    .SYNOPSIS
        Drop events already emitted in a previous window, and carry a bounded
        ring of fingerprints forward.
    .DESCRIPTION
        The window boundary is why this exists. The watermark advances to the
        newest event SEEN (see Get-DockerEventsNextSince), so an event the daemon
        had not yet flushed when the previous process was killed is re-requested
        in the next window — arriving twice. Without this, one restart reads as
        two, and the count is the thing an investigator trusts.

        Skipped is returned separately from kept, so a reader can tell
        "deduplicated" from "nothing arrived" — the same distinction the whole
        issue is about.
    #>
    param(
        $Events,
        [string[]]$Seen = @(),
        [int]$SeenCap = 200
    )

    # Plain arrays, NOT List[object]: `@($someListOfObject)` throws
    # "Argument types do not match" on BOTH interpreters (pwsh 7.5 and Windows
    # PowerShell 5.1.26100 — measured 2026-09-20), while `@($listOfString)` is
    # fine. The type ARGUMENT is what matters, not the version. A collector whose
    # output object cannot be constructed would have shipped as "the collector
    # ran and produced nothing" — the exact silent-failure class #169 exists to
    # end. Found by running it, not by reading it.
    $kept = @()
    $skipped = @()
    $ring = New-Object System.Collections.Generic.List[string]
    foreach ($s in @($Seen)) { if ($s) { $ring.Add($s) } }

    $known = @{}
    foreach ($s in $ring) { $known[$s] = $true }

    foreach ($e in @($Events)) {
        if ($null -eq $e) { continue }
        $fp = Get-DockerEventFingerprint -Event $e
        if ([string]::IsNullOrWhiteSpace($fp) -or $fp -eq '0||') { continue }
        if ($known.ContainsKey($fp)) { $skipped += $e; continue }
        $known[$fp] = $true
        $ring.Add($fp)
        $kept += $e
    }

    if ($SeenCap -gt 0) {
        while ($ring.Count -gt $SeenCap) { $ring.RemoveAt(0) }
    }

    return [PSCustomObject]@{
        Kept    = @($kept)
        Skipped = @($skipped)
        Seen    = @($ring)
    }
}

function Get-DockerEventsNextSince {
    <#
    .SYNOPSIS
        The watermark for the next window: newest event seen, else the instant
        the window closed — and NEVER backwards.
    .DESCRIPTION
        Three rules, each against a way the collector silently loses data:

          - Newest event SEEN, not 'now'. The process is killed rather than
            allowed to exit (measured: `docker events` never self-terminates on
            Docker Desktop 29.x), so the last instant of the window is unknowable
            from the process itself. Adjacent windows therefore overlap slightly
            when the daemon was behind, and Select-NewDockerEvents removes the
            duplicate. Jumping to 'now' would instead DROP whatever had not been
            flushed yet — silently, which is the defect class this collector
            exists to end.
          - No events -> the window close. Nothing existed in the interval, so
            the next window starts where this one ended.
          - Monotone. A watermark that moves backwards re-reads the same range
            forever, and one that moves backwards past already-emitted events
            also fights the dedupe ring until it overflows. Newer wins; an older
            candidate is discarded and the Reason says so.
    #>
    param(
        $Events,
        [string]$KillInstantUtc,
        [string]$PreviousSinceUtc,
        [bool]$InvocationOk = $true
    )

    # A FAILED invocation must not move the watermark. The window never rendered,
    # so everything inside it is unread; advancing to the window close would drop
    # that range permanently and silently — the exact data-loss class this
    # collector exists to end, reintroduced by its own error path. Measured
    # 2026-09-20: a tick that failed on a malformed `--since` still reported
    # `next=...17:35:18.176Z`, i.e. it wrote off the interval it had just failed
    # to read.
    if (-not $InvocationOk) {
        $heldTxt = ''
        try { $heldTxt = ([datetime]::Parse($PreviousSinceUtc)).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture) } catch { $heldTxt = [string]$PreviousSinceUtc }
        return [PSCustomObject]@{ SinceUtc = $heldTxt; Reason = 'invocation failed — watermark held so the next tick re-reads this range' }
    }

    $prev = $null
    try { $prev = [datetime]::Parse($PreviousSinceUtc).ToUniversalTime() } catch { $prev = $null }
    $kill = $null
    try { $kill = [datetime]::Parse($KillInstantUtc).ToUniversalTime() } catch { $kill = $null }

    $fmt = 'yyyy-MM-ddTHH:mm:ss.fffZ'
    $inv = [System.Globalization.CultureInfo]::InvariantCulture

    $prevTxt = ''
    if ($null -ne $prev) { $prevTxt = $prev.ToString($fmt, $inv) }

    $newest = $null
    foreach ($e in @($Events)) {
        if ($null -eq $e) { continue }
        $tn = 0
        try { $tn = [int64]$e.TimeNano } catch { $tn = 0 }
        if ($tn -le 0) { continue }
        try {
            $candidate = [System.DateTimeOffset]::FromUnixTimeMilliseconds([int64][math]::Floor($tn / 1000000)).UtcDateTime
        } catch { continue }
        if ($null -eq $newest -or $candidate -gt $newest) { $newest = $candidate }
    }

    if ($null -eq $newest) {
        if ($null -ne $kill) {
            return [PSCustomObject]@{ SinceUtc = $kill.ToString($fmt, $inv); Reason = 'no events in window — advancing to the window close' }
        }
        if ($null -ne $prev) {
            return [PSCustomObject]@{ SinceUtc = $prevTxt; Reason = 'no events and no readable window close — watermark held' }
        }
        return [PSCustomObject]@{ SinceUtc = $fmt; Reason = 'no watermark and no clock — next run will use its lookback' }
    }

    $newestTxt = $newest.ToString($fmt, $inv)
    if ($null -ne $prev -and $newest -lt $prev) {
        return [PSCustomObject]@{ SinceUtc = $prevTxt; Reason = 'monotone guard: newest event predates the previous watermark — watermark held' }
    }
    return [PSCustomObject]@{ SinceUtc = $newestTxt; Reason = 'advanced to the newest event seen' }
}

function ConvertTo-DockerSinceInstant {
    <#
    .SYNOPSIS
        Render any stored watermark value as an INVARIANT RFC3339 UTC instant,
        or $null when it is not readable. PURE.
    .DESCRIPTION
        This exists because the state file round-trip broke the collector in
        production the first time it ran (measured po-2024, 2026-09-20):

            docker refused or could not run: failed to parse value as time or
            duration: "09/20/2026 17:34:59"

        `ConvertFrom-Json` turns an ISO-8601-looking string back into a
        [datetime], and `[string]` on that DateTime renders it in the AMBIENT
        culture — so the watermark we wrote as `2026-09-20T17:34:59.356Z` came
        back as a US short date docker cannot parse, and every tick after the
        first was broken. A collector is exactly where this hides: tick 1 looked
        perfect, wrote plausible state, and the damage only appears on tick 2,
        fifteen minutes later.

        So the value is never stringified through the ambient culture. Both
        storage shapes are accepted (DateTime from a JSON round-trip, string from
        a hand-written file) and anything unreadable returns $null — the caller
        falls back to its lookback, i.e. fails toward RE-READING. Never toward
        dropping.
    #>
    param($Value)

    if ($null -eq $Value) { return $null }

    $dt = $null
    if ($Value -is [datetime]) { $dt = $Value }
    elseif ($Value -is [System.DateTimeOffset]) { $dt = $Value.UtcDateTime }
    else {
        $s = [string]$Value
        if ([string]::IsNullOrWhiteSpace($s)) { return $null }
        $styles = [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal
        try { $dt = [datetime]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture, $styles) } catch { return $null }
    }

    return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-DockerEventsInvocationVerdict {
    <#
    .SYNOPSIS
        Classify one bounded `docker events` invocation. PURE.
    .DESCRIPTION
        THE SEMANTICS ARE INVERTED against Invoke-DockerBounded, deliberately and
        with a measurement behind it. There, TimedOut means failure — a `docker
        inspect` that does not answer is a defect. Here, being killed IS how a
        healthy window closes: measured on Docker Desktop 29.8.0 (po-2024,
        2026-09-20), `docker events` did not self-terminate in ANY of four
        argument forms, including an explicit past `--until`, so a collector that
        called the kill a failure would report every successful tick as broken.

        A silent window is a MEASUREMENT, not a failure: it means no events
        existed. Only a docker that could not run, or that refused the arguments,
        is a failure — and both of those carry error text.
    #>
    param(
        [bool]$Exited,
        [int]$ExitCode,
        [int]$LineCount,
        [string]$ErrorText
    )

    if ($LineCount -gt 0) {
        if ($Exited) { return [PSCustomObject]@{ Ok = $true;  Reason = 'closed-by-until' } }
        return [PSCustomObject]@{ Ok = $true; Reason = 'closed-by-kill' }
    }

    if (-not [string]::IsNullOrWhiteSpace($ErrorText)) {
        return [PSCustomObject]@{ Ok = $false; Reason = ('docker refused or could not run: ' + $ErrorText.Trim()) }
    }

    if ($Exited -and $ExitCode -ne 0) {
        return [PSCustomObject]@{ Ok = $false; Reason = ("docker exited $ExitCode with no output") }
    }

    if ($Exited) { return [PSCustomObject]@{ Ok = $true; Reason = 'closed-by-until-silent' } }
    return [PSCustomObject]@{ Ok = $true; Reason = 'closed-by-kill-silent' }
}

function Get-DockerEventGroupVerdict {
    <#
    .SYNOPSIS
        Read a window's events as a GROUP, and refuse to name an actor. PURE.
    .DESCRIPTION
        This is the 2026-08-30 error made un-repeatable. A window holding 38
        containers whose StartedAt all fit inside 0.4 s was read as a targeted
        action, and attributed to a lane that had done nothing — when
        simultaneity ACROSS containers is the signature of a host or daemon
        event, not of a person.

        So the classifier answers one question — did many distinct containers
        move together? — and never a second one. The verdict object carries no
        actor field at all: the file records what happened, a human attributes
        it. Naming an actor from a grouped event is exactly the mistake this
        function exists to prevent, and the test asserts the object has no such
        property so it cannot creep back.

        `none` is distinct from `targeted` on purpose: an empty window says
        nothing about intent, and "no events" must never read as "no cause".
    #>
    param(
        $Events,
        [int]$GroupSpanMs = 1000,
        [int]$MinContainers = 5
    )

    $list = @(@($Events) | Where-Object { $null -ne $_ })
    if ($list.Count -eq 0) {
        return [PSCustomObject]@{
            Verdict            = 'none'
            DistinctContainers = 0
            EventCount         = 0
            SpanMs             = 0
            Reason             = 'no events in window — silence is not evidence of intent'
        }
    }

    $ids = @($list | ForEach-Object { $_.ContainerId } | Where-Object { $_ } | Select-Object -Unique)
    $times = @($list | ForEach-Object { $_.TimeNano } | Where-Object { $_ -gt 0 } | Sort-Object)
    $spanMs = 0
    if ($times.Count -ge 2) { $spanMs = [math]::Round(($times[$times.Count - 1] - $times[0]) / 1000000.0, 1) }

    if ($ids.Count -ge $MinContainers -and $spanMs -le $GroupSpanMs) {
        return [PSCustomObject]@{
            Verdict            = 'shared-cause'
            DistinctContainers = $ids.Count
            EventCount         = $list.Count
            SpanMs             = $spanMs
            Reason             = ("{0} distinct containers within {1}ms — simultaneity across containers is a host/daemon signature; do NOT attribute this to a targeted action" -f $ids.Count, $spanMs)
        }
    }

    return [PSCustomObject]@{
        Verdict            = 'targeted'
        DistinctContainers = $ids.Count
        EventCount         = $list.Count
        SpanMs             = $spanMs
        Reason             = ("{0} distinct container(s) over {1}ms — not a grouped burst" -f $ids.Count, $spanMs)
    }
}

function Get-DockerEventsRotationPlan {
    <#
        Append-only means unbounded unless something bounds it, and an unbounded
        log on a machine that restarts is how a disk fills silently. Size-based,
        never time-based: the log's growth rate is a property of the machine, and
        a byte cap is the only bound that does not depend on predicting it.
    #>
    param(
        [long]$CurrentBytes,
        [long]$MaxBytes,
        [int]$ExistingRotatedCount = 0,
        [int]$KeepRotated = 5
    )

    if ($MaxBytes -le 0) {
        return [PSCustomObject]@{ Rotate = $false; Keep = 0; Reason = 'no cap configured — rotation disabled' }
    }
    if ($CurrentBytes -le $MaxBytes) {
        return [PSCustomObject]@{ Rotate = $false; Keep = $KeepRotated; Reason = ("{0} bytes is within the {1} cap" -f $CurrentBytes, $MaxBytes) }
    }
    return [PSCustomObject]@{
        Rotate = $true
        Keep   = $KeepRotated
        Reason = ("{0} bytes exceeds the {1} cap — rotate and keep the newest {2} (currently {3})" -f $CurrentBytes, $MaxBytes, $KeepRotated, $ExistingRotatedCount)
    }
}

function Add-DockerEventsTickRecord {
    <#
    .SYNOPSIS
        Build the state object for one tick, with a BOUNDED history. PURE.
    .DESCRIPTION
        The history is the answer to the question the issue actually asks: "was
        the collector even running at 03:49Z?" A log with no events in it looks
        identical whether the daemon was quiet or the task has been dead for
        three days — the same trap as a `grep -L` on a zero-byte capture, which
        reads as a violation when it is an absence of data. One record per tick,
        bounded, makes the two separable from a file.
    #>
    param(
        $State,
        $Record,
        [int]$HistoryCap = 48
    )

    # Plain arrays for the same measured reason as Select-NewDockerEvents:
    # `@()` on a List[object] is a terminating error on both interpreters.
    $history = @()
    if ($null -ne $Record) { $history += $Record }
    if ($null -ne $State) {
        $prev = @()
        try { $prev = @($State.History) } catch { $prev = @() }
        foreach ($h in $prev) { if ($null -ne $h) { $history += $h } }
    }
    if ($HistoryCap -gt 0 -and $history.Count -gt $HistoryCap) {
        $history = @($history | Select-Object -First $HistoryCap)
    }

    return [PSCustomObject]@{
        Last    = $Record
        History = @($history)
    }
}

function Invoke-DockerEventsBounded {
    <#
    .SYNOPSIS
        Run a bounded `docker events` window and return its rendered lines.
    .DESCRIPTION
        Same process discipline as Invoke-GitBounded — output to FILES, never
        pipes (a full pipe blocks the child before it exits, reintroducing the
        hang through the back door), and .Handle touched before WaitForExit so
        ExitCode is not $null — with ONE measured addition:

        ARGUMENTS CONTAINING A SPACE MUST BE QUOTED. Start-Process -ArgumentList
        joins the array into a command line, so '{{json .}}' arrives as two bare
        arguments and docker answers "'docker events' accepts no arguments",
        in 0.2s, with zero output — a collector that reads as "quiet daemon"
        while it has never once run. The existing Invoke-DockerBounded calls
        never met this because their formats ({{.State.Status}}) contain no space.
        Measured po-2024, Docker Desktop 29.8.0, 2026-09-20.

        A timeout is NOT an error here: it is the normal way a window closes
        (Get-DockerEventsInvocationVerdict carries the reasoning).
    #>
    param(
        [string[]]$DockerArgs,
        [int]$TimeoutSec = 20
    )

    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $quoted = @()
        foreach ($a in @($DockerArgs)) {
            if ($null -ne $a -and $a -match '\s') { $quoted += ('"{0}"' -f $a) }
            else { $quoted += $a }
        }
        $p = Start-Process -FilePath 'docker' -ArgumentList $quoted -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $null = $p.Handle
        $exited = $p.WaitForExit($TimeoutSec * 1000)
        if (-not $exited) { try { $p.Kill() } catch {} }

        $lines = @()
        try { $lines = @(Get-Content -LiteralPath $outFile -ErrorAction SilentlyContinue) } catch { $lines = @() }
        $errText = ''
        try {
            $raw = Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue
            if ($null -ne $raw) { $errText = [string]$raw }
        } catch { $errText = '' }

        $code = -1
        try { if ($exited) { $code = $p.ExitCode } } catch { $code = -1 }

        $verdict = Get-DockerEventsInvocationVerdict -Exited $exited -ExitCode $code -LineCount $lines.Count -ErrorText $errText

        return @{
            Ok         = $verdict.Ok
            Reason     = $verdict.Reason
            Exited     = $exited
            Code       = $code
            Lines      = $lines
            ErrorText  = $errText
        }
    }
    catch {
        # docker.exe never launched: absent from PATH, or the CLI cannot start
        # (the 02/09 commit-exhaustion signature). Same shape as the git twin.
        return @{ Ok = $false; Reason = ('docker not launchable: ' + $_.Exception.Message); Exited = $false; Code = -1; Lines = @(); ErrorText = $_.Exception.Message }
    }
    finally {
        # [System.IO.File]::Delete, not Remove-Item: measured 2026-09-20, a
        # restricted host refuses Remove-Item on the system temp path ("system
        # path '*' is blocked"), and the refusal surfaces as if the collector had
        # died — while the real defect is only a temp file left behind.
        foreach ($f in @($outFile, $errFile)) {
            try { [System.IO.File]::Delete($f) } catch { }
        }
    }
}

function Get-ScriptProvenance {
    <#
    .SYNOPSIS
        Identify the artifact that is ACTUALLY executing: ref, HEAD sha and dirty
        state of the tree this script runs from.
    .DESCRIPTION
        Measured across the fleet on 2026-09-20, after a watchdog remediation
        took a host's Docker engine down: the scheduled tasks execute their
        scripts DIRECTLY from a git working tree, so an edit is in production at
        the next tick with no deployment step and no review gate. po-2025 runs
        `claudish-watchdog.ps1` from `D:\Dev\claudish\scripts\` every 15 min;
        po-2023 runs `compress-captures.ps1` from the same kind of tree nightly
        at 02:47. That is how the code that killed the engine reached production
        — not by a decision to deploy, but by being edited.

        The property is symmetric, which is exactly why nobody noticed it: the
        withdrawal took effect just as instantly as the defect. A mechanism that
        makes both errors and fixes immediate never announces itself with a
        lasting outage. It announces itself with one bad day.

        So the first step is not a guard, it is identification: you cannot govern
        what you cannot name. One line per cycle turns "what is armed here?" from
        a question needing elevation and two blind instruments into a grep.

        TRACKED vs UNTRACKED is the distinction that carries the meaning, and it
        is the one both peers reported unprompted. Untracked-only dirt means the
        EXECUTED files are exactly the committed ones, so the sha identifies the
        artifact. A modified tracked file means the running artifact exists
        nowhere in git and no sha can identify it.

        InOriginMain is a HINT, never a fact: origin/main is only as fresh as the
        last fetch, and this function deliberately does NO network git — a
        watchdog must not reach the network to log a line. 'no' can therefore
        mean "not fetched recently" as easily as "unreviewed". The sha is the
        fact; this field only tells you where to look.

        Never throws. Every unknown degrades to Versioned=$false with a stated
        reason, because a watchdog that crashes on its own observability line is
        worse than one that logs nothing.
    #>
    param(
        [string]$ScriptRoot,
        # Injectable so the whole decision table is exercisable without git, and
        # so tests can drive the failure shapes (absent, timeout, detached HEAD).
        [scriptblock]$GitInvoker = $null
    )

    $unknown = @{
        Versioned = $false; Ref = ''; Sha = ''
        Dirty = $false; TrackedDirty = 0; UntrackedDirty = 0
        InOriginMain = 'unknown'; Root = $ScriptRoot
    }

    if ([string]::IsNullOrWhiteSpace($ScriptRoot)) {
        $unknown.Summary = 'PROVENANCE: unversioned (no script root)'
        return [PSCustomObject]$unknown
    }

    if (-not $GitInvoker) {
        $GitInvoker = { param($a) Invoke-GitBounded -WorkDir $ScriptRoot -GitArgs $a }
    }

    $invoke = {
        param($a)
        try { return (& $GitInvoker $a) }
        catch { return @{ Ok = $false; Out = ''; Reason = 'invoker threw' } }
    }

    $sha = & $invoke @('rev-parse', 'HEAD')
    if (-not $sha.Ok -or [string]::IsNullOrWhiteSpace($sha.Out)) {
        $why = 'not a git tree'
        if ($sha.Reason) { $why = $sha.Reason }
        $unknown.Summary = "PROVENANCE: unversioned ($why) root=$ScriptRoot"
        return [PSCustomObject]$unknown
    }

    $full = $sha.Out.Trim()
    $short = $full
    if ($full.Length -ge 7) { $short = $full.Substring(0, 7) }

    $ref = '(detached)'
    $refRes = & $invoke @('rev-parse', '--abbrev-ref', 'HEAD')
    if ($refRes.Ok -and -not [string]::IsNullOrWhiteSpace($refRes.Out)) {
        $ref = $refRes.Out.Trim()
    }

    $tracked = 0
    $untracked = 0
    $statusRes = & $invoke @('status', '--porcelain')
    if ($statusRes.Ok -and -not [string]::IsNullOrWhiteSpace($statusRes.Out)) {
        foreach ($line in ($statusRes.Out -split "`r?`n")) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            if ($line.StartsWith('??')) { $untracked++ } else { $tracked++ }
        }
    }

    # Best effort only, and never a fetch. See the InOriginMain note above.
    $inMain = 'unknown'
    $ancestor = & $invoke @('merge-base', '--is-ancestor', $full, 'origin/main')
    if ($ancestor.Ok) { $inMain = 'yes' }
    elseif ($ancestor.Reason -eq 'exit 1') { $inMain = 'no' }

    $dirtyTxt = 'clean'
    if ($tracked -gt 0 -and $untracked -gt 0) {
        $dirtyTxt = "TRACKED($tracked)+untracked($untracked)"
    }
    elseif ($tracked -gt 0) {
        $dirtyTxt = "TRACKED($tracked)"
    }
    elseif ($untracked -gt 0) {
        $dirtyTxt = "untracked-only($untracked)"
    }

    return [PSCustomObject]@{
        Versioned      = $true
        Ref            = $ref
        Sha            = $short
        FullSha        = $full
        Dirty          = (($tracked + $untracked) -gt 0)
        TrackedDirty   = $tracked
        UntrackedDirty = $untracked
        InOriginMain   = $inMain
        Root           = $ScriptRoot
        Summary        = "PROVENANCE: ref=$ref sha=$short tree=$dirtyTxt in-origin/main=$inMain root=$ScriptRoot"
    }
}

#region capture-archive naming ------------------------------------------------
# The off-site archive namespace is SHARED: every machine's `compress-captures.ps1`
# copies into the same Google Drive folder. The archive name carried no machine
# dimension (`captures-<day>.7z`), and the upload is `Copy-Item -Force`, so a
# SECOND producer arming the script with default parameters would:
#   1. write its own (small) archive over the first machine's (large) one,
#   2. "confirm" the upload by comparing the destination size to the file it had
#      just written itself — a check that can only ever pass,
#   3. purge its local copy (KeepLocalDays=0 makes off-site the ONLY home),
# while the first machine had already purged its own copy the night before.
# The day is then gone everywhere. That is a data-loss path, not a gap, and it
# opens exactly when a fleet starts serving requests locally on more than one
# machine — i.e. the moment sidecar archives become worth consolidating.
#
# The remedy is structural rather than procedural: give every archive a name
# that cannot collide, and refuse to run at all when a run would otherwise join
# a shared namespace anonymously. An unconfigured machine fails LOUDLY instead
# of destroying; the single historical producer keeps its exact names behind an
# explicit opt-in, so nothing that reads `captures-<day>.7z` changes.

function Get-CaptureArchiveName {
    <#
        Archive file name for one day, optionally qualified by machine.

        An empty tag yields the legacy `captures-<day>.7z`. That spelling is
        kept — not deprecated — because the existing history is stored under it
        and every reader (traffic-history.ps1, lane-matrix.py) matches it.
    #>
    param(
        [Parameter(Mandatory)][string]$Day,
        [string]$MachineTag = ''
    )
    if ($Day -notmatch '^\d{4}-\d{2}-\d{2}$') {
        throw "Get-CaptureArchiveName: Day must be yyyy-MM-dd, got '$Day'"
    }
    if ([string]::IsNullOrWhiteSpace($MachineTag)) { return "captures-$Day.7z" }
    if ($MachineTag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "Get-CaptureArchiveName: MachineTag must match ^[A-Za-z0-9][A-Za-z0-9._-]*$, got '$MachineTag'"
    }
    return "captures-$Day-$MachineTag.7z"
}

function Get-CaptureArchiveDay {
    <#
        The day an archive name encodes, tagged or not; $null when the name is
        not one of ours. The retention purge keys on this, so a name it cannot
        parse must be SKIPPED rather than guessed at — deleting on a guess is
        the failure this whole region exists to prevent.
    #>
    param([Parameter(Mandatory)][string]$Name)
    if ($Name -match '^captures-(\d{4}-\d{2}-\d{2})(?:-[A-Za-z0-9._-]+)?\.7z$') { return $matches[1] }
    return $null
}

function Get-CaptureArchiveMachineTag {
    <# The machine tag an archive name carries, or '' for a legacy untagged name. #>
    param([Parameter(Mandatory)][string]$Name)
    if ($Name -match '^captures-\d{4}-\d{2}-\d{2}-([A-Za-z0-9._-]+)\.7z$') { return $matches[1] }
    return ''
}

function Get-CapturePartialInfo {
    <#
        A quarantined partial (#322) is named `<canonical>.7z.partial-<ts>`,
        where <canonical> is a full `captures-<day>[-<tag>].7z` name. The suffix
        is placed AFTER the `.7z` on purpose: it is what keeps the corpse out of
        the `captures-*.7z` selector that drives the re-upload scan. The cost is
        that it is ALSO out of the retention purge, which uses the same filter —
        so nothing ever removed one (#418, measured: a 97 MB corpse still on the
        hub 7 days after it was written).

        Recovers the two facts a quarantine purge needs — the day it belongs to,
        and the canonical name whose off-site copy is the proof it is dead
        weight — or $null when the name is not a quarantine of ours. A name this
        cannot parse must be SKIPPED, never guessed at: the caller deletes on
        what comes back.
    #>
    param([Parameter(Mandatory)][string]$Name)
    if ($Name -notmatch '^(captures-\d{4}-\d{2}-\d{2}(?:-[A-Za-z0-9._-]+)?\.7z)\.partial-\d{8}T\d{6}(?:-\d+)?$') {
        return $null
    }
    # Capture the group BEFORE calling out — the nested -match below resets $matches.
    $canonical = $matches[1]
    $day = Get-CaptureArchiveDay -Name $canonical
    if (-not $day) { return $null }
    return [pscustomobject]@{
        Day       = $day
        Canonical = $canonical
        Tag       = Get-CaptureArchiveMachineTag -Name $canonical
    }
}

function Get-CaptureArchivePolicy {
    <#
        Decides whether a run may write into the off-site namespace, BEFORE it
        archives or copies anything.

        Rules, in the order they are checked:
          - No off-site directory  -> local compaction only, nothing is shared,
                                      any tag (including none) is fine.
          - A machine tag          -> names cannot collide. Allowed.
          - No tag, opt-in passed  -> the single historical producer, keeping
                                      its existing names. Allowed, explicitly.
          - No tag, no opt-in      -> REFUSED. This is the destructive case, and
                                      it is also the default, which is why the
                                      refusal has to be the default too.

        Returns an object rather than throwing so the caller can log one clean
        FATAL line and exit non-zero; a thrown exception in an unattended job
        tends to be read as a transient failure and retried.
    #>
    param(
        [string]$GDriveDir = '',
        [string]$MachineTag = '',
        [switch]$AllowUntaggedSharedArchive
    )
    $tag = $MachineTag
    if ($null -eq $tag) { $tag = '' }
    $tag = $tag.Trim()

    if ($tag -ne '' -and $tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        return [pscustomobject]@{
            Ok         = $false
            MachineTag = $tag
            Reason     = "MachineTag '$tag' is not filename-safe (expected ^[A-Za-z0-9][A-Za-z0-9._-]*$)"
        }
    }
    if ([string]::IsNullOrWhiteSpace($GDriveDir)) {
        return [pscustomobject]@{ Ok = $true; MachineTag = $tag; Reason = 'local-only: no shared namespace' }
    }
    if ($tag -ne '') {
        return [pscustomobject]@{ Ok = $true; MachineTag = $tag; Reason = "tagged: archives are named captures-<day>-$tag.7z" }
    }
    if ($AllowUntaggedSharedArchive) {
        return [pscustomobject]@{ Ok = $true; MachineTag = ''; Reason = 'untagged shared namespace, explicitly allowed' }
    }
    return [pscustomobject]@{
        Ok         = $false
        MachineTag = ''
        Reason     = 'refusing to write captures-<day>.7z into a shared off-site directory without -MachineTag: a second producer overwrites the first machine archive and then purges its own local copy, losing the day everywhere. Pass -MachineTag <name>, or -AllowUntaggedSharedArchive on the one machine that owns the untagged namespace.'
    }
}

function Get-OffsiteWriteVerdict {
    <#
        Decides whether THIS run may overwrite a file that already exists at the
        off-site destination, read as it exists PRIOR to the write (#208).

        Get-CaptureArchivePolicy guards the namespace at the name level (which
        spelling this run may use); this guards the write itself. The two compose,
        and this one is strictly stronger than a tag: it holds even when two
        machines are configured to write the SAME name, which is exactly the
        14-day loss the tag could not prevent (the allowed untagged producer
        overwrote the other producer's archive nightly, then confirmed the copy
        against the bytes it had just written itself — a check that cannot fail).

        Rules:
          - Destination absent        -> write. The legitimate first upload.
          - Same size as this run's   -> idempotent re-upload, fine as-is (a
                                         retried night must not start failing).
          - Different size            -> REFUSE, naming both sizes. A different
                                         size on a name this run owns means
                                         another producer wrote it; there is no
                                         benign interpretation, and the correct
                                         action is never to overwrite.

        Returns an object (Action: write | idempotent | refuse) rather than
        throwing, same contract as Get-CaptureArchivePolicy.
    #>
    param(
        [bool]$DestExists = $false,
        [long]$DestBytes = 0,
        [long]$LocalBytes = 0
    )
    if (-not $DestExists) {
        return [pscustomobject]@{ Action = 'write'; Reason = 'destination absent' }
    }
    if ($DestBytes -eq $LocalBytes) {
        return [pscustomobject]@{
            Action = 'idempotent'
            Reason = ("destination already holds these exact {0} bytes" -f $LocalBytes)
        }
    }
    return [pscustomobject]@{
        Action = 'refuse'
        Reason = ("destination exists with a DIFFERENT size (dest {0} bytes vs this run {1} bytes) - another producer owns this name; overwriting would destroy it" -f $DestBytes, $LocalBytes)
    }
}
# --- off-site sha256 manifest (#389) -----------------------------------------
# Measured 07/10: a content drift at EQUAL size on an off-site archive is
# invisible to every guard above - #208 compares sizes, #322 tests readability,
# and neither knows what the bytes SHOULD be. The remedy is a reference: hash
# the destination at deposit time into a per-machine manifest, then re-verify a
# rotating sample of it every night. Drift then surfaces as a loud non-zero
# night instead of a silent corrupted history (the po-2026 finding).
# The manifest name carries the machine tag for the same reason the archive
# name does: GDriveDir is a SHARED namespace (#201) and two producers must
# never edit one manifest file.

function Get-ShaManifestPath {
    <#
        The per-machine manifest path inside the shared off-site directory.
        Tagged machines get captures-sha256-<tag>.jsonl; the one untagged
        namespace owner gets captures-sha256.jsonl - mirroring
        Get-CaptureArchiveName exactly, so the two can never disagree about
        which namespace a run writes to.
    #>
    param(
        [Parameter(Mandatory)] [string]$GDriveDir,
        [string]$MachineTag = ""
    )
    $leaf = if ($MachineTag) { "captures-sha256-$MachineTag.jsonl" } else { "captures-sha256.jsonl" }
    return (Join-Path $GDriveDir $leaf)
}

function Read-ShaManifest {
    <#
        Parses a manifest into a hashtable archive-name -> record. A torn or
        hand-edited line is skipped and counted in BadLines, never fatal: the
        manifest is a reference for the re-check, and one unparseable line must
        not blind the check to the other entries. Absent file -> empty manifest
        (first run after this change has nothing recorded yet - legitimate).
    #>
    param([Parameter(Mandatory)] [string]$Path)
    $out = @{}
    $bad = 0
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Entries = $out; BadLines = 0 }
    }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $t = $line.Trim()
        if (-not $t) { continue }
        try {
            $o = $t | ConvertFrom-Json
            if ($o.archive) { $out[$o.archive] = $o } else { $bad++ }
        } catch { $bad++ }
    }
    return [pscustomobject]@{ Entries = $out; BadLines = $bad }
}

function Update-ShaManifest {
    <#
        Upserts one archive's record: same archive name replaces (a retried
        night re-uploads and must not leave two hashes for one name), other
        entries are preserved byte-for-byte in their recorded order. Written
        UTF-8 WITHOUT BOM - the same discipline as the 7z @listfile: a BOM
        poisons readers of the first line.
    #>
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Archive,
        [Parameter(Mandatory)] [string]$Sha256,
        [Parameter(Mandatory)] [long]$Bytes,
        [Parameter(Mandatory)] [string]$RecordedUtc
    )
    $m = Read-ShaManifest -Path $Path
    $names = @($m.Entries.Keys | Sort-Object)
    if ($names -notcontains $Archive) { $names = @($names + $Archive | Sort-Object) }
    $rec = [pscustomobject]@{
        archive = $Archive; sha256 = $Sha256; bytes = $Bytes; recorded = $RecordedUtc
    }
    $lines = foreach ($n in $names) {
        if ($n -eq $Archive) { ($rec | ConvertTo-Json -Compress) } else { ($m.Entries[$n] | ConvertTo-Json -Compress) }
    }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllLines($Path, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ Entries = $names.Count; Archive = $Archive }
}

function Select-ShaRotation {
    <#
        The nightly re-check sample: deterministic, so two runs on the same UTC
        day pick the same entries (a re-run after a transient failure re-checks
        the same files, not a fresh random three), and advancing one day
        advances the window by the sample count, so every recorded entry is
        re-verified in ceil(count/N) nights. Seed = UTC date as an OADate int.
        Pure: takes the entry list, returns the selected names.
    #>
    param(
        [string[]]$Names = @(),
        [int]$Count = 3,
        [Parameter(Mandatory)] [datetime]$SeedDateUtc
    )
    if ($Count -le 0 -or $Names.Count -eq 0) { return @() }
    $seed = [int][Math]::Floor($SeedDateUtc.ToUniversalTime().Date.ToOADate())
    $picked = for ($i = 0; $i -lt [Math]::Min($Count, $Names.Count); $i++) {
        $Names[([Math]::Abs($seed * $Count + $i)) % $Names.Count]
    }
    return @($picked | Select-Object -Unique)
}
# --- 7-Zip resolution (#214) -------------------------------------------------
# The compaction night of 2026-09-22 died because the launcher hardcoded a path
# that did not exist, and the script's own fallback hardcoded a DIFFERENT one
# that did not exist either - two independent wrong values, neither resolved
# dynamically. The remedy is a candidate LIST, and a failure that NAMES every
# path tried, so the next occurrence is diagnosable from the log alone.

function Get-SevenZipCandidates {
    <#
        The built-in candidate list, most-likely first. Pure (no filesystem), so
        its order and contents are pinnable. `-Extra` appends caller-supplied
        paths LAST: a path the caller names is a fallback of last resort, never a
        priority that could displace a verified one.
    #>
    param(
        [string]$PortableRoot = 'D:\PortableApps\PortableApps',
        [string]$LegacyRoot   = 'D:\Apps\PortableApps',
        [string[]]$Extra = @()
    )
    $list = @(
        (Join-Path $PortableRoot '7-ZipPortable\App\7-Zip64\7z.exe'),
        (Join-Path $LegacyRoot   '7-ZipPortable\App\7-Zip64\7z.exe'),
        'C:\Program Files\7-Zip\7z.exe',
        'C:\Program Files (x86)\7-Zip\7z.exe'
    )
    foreach ($e in @($Extra)) { if ($e) { $list += $e } }
    return $list
}

function Resolve-SevenZipPath {
    <#
        Resolves the 7z binary from an optional explicit value plus a candidate
        list, without ever touching the filesystem itself (the existence probe is
        injected, so the whole decision is testable with no 7z installed).

        Contract:
          - An explicit value that EXISTS wins outright (source='explicit').
          - An explicit value that is MISSING is not fatal: it is reported via
            ExplicitMissing=$true and the candidates are tried. This is the c.33
            outage class - a churned launcher hardcoding a stale path must not
            kill the night when a verified binary sits right there.
          - With -NoFallback, a missing explicit yields Path='' (the caller keeps
            a reachable FATAL path).
          - Nothing resolving yields Path='' with Tried naming EVERY path probed,
            which is what the caller logs.
    #>
    param(
        [AllowEmptyString()][string]$Explicit = '',
        [AllowEmptyCollection()][string[]]$Candidates = @(),
        [switch]$NoFallback,
        [scriptblock]$Exists = $null
    )
    if ($null -eq $Exists) { $Exists = { param($p) Test-Path -LiteralPath $p } }

    $tried = New-Object System.Collections.Generic.List[string]
    $explicitMissing = $false

    if ($Explicit) {
        [void]$tried.Add($Explicit)
        if (& $Exists $Explicit) {
            return [pscustomobject]@{ Path = $Explicit; Source = 'explicit'; Tried = @($tried); ExplicitMissing = $false }
        }
        $explicitMissing = $true
    }

    if (-not $NoFallback) {
        foreach ($c in @($Candidates)) {
            if (-not $c) { continue }
            if ($tried.Contains($c)) { continue }
            [void]$tried.Add($c)
            if (& $Exists $c) {
                return [pscustomobject]@{ Path = $c; Source = 'candidate'; Tried = @($tried); ExplicitMissing = $explicitMissing }
            }
        }
    }

    return [pscustomobject]@{ Path = ''; Source = 'none'; Tried = @($tried); ExplicitMissing = $explicitMissing }
}

#region failover-events collector (#347, pure logic)
# Companion of the docker-events block above, for the proxy's own [Failover]
# log lines (ARMED / DISARMED / walled / failed / DWELL / CLOSED / RECOVERED).
# Same doctrine: a window watermark, a dedup ring, an allowlist at the SINK,
# and zero actuator anywhere. The glue is scripts/failover-events-collect.ps1.

function ConvertFrom-DockerLogLine {
    <#
    .SYNOPSIS
        Split a `docker logs --timestamps` line into its instant and its text.
    .DESCRIPTION
        With --timestamps, docker prefixes every line (stdout AND stderr of the
        container) with an RFC3339 instant: `2026-10-05T19:20:31.123456789Z …`.
        Lines without the prefix (docker's own errors, blank lines) yield $null
        — they are not container log lines and must never reach the sink.
    #>
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line)
    if ($Line -match '^(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(?<rest>.*)$') {
        return @{ Ts = $Matches['ts']; Rest = $Matches['rest'] }
    }
    return $null
}

function Select-FailoverLines {
    <#
    .SYNOPSIS
        ALLOWLIST sink guard: keep only parsed log lines carrying the exact
        `[Failover]` token, drop everything else. PURE.
    .DESCRIPTION
        The #192 lesson applied from the start: a filter that admits more than
        it needs ends up persisting what must never be written down. A `docker
        logs` window contains request lines, body previews with user text, and
        Authorization-looking strings; NONE of it may reach a persisted,
        rotated file. The marker token is the allowlist — a line without it is
        dropped unconditionally, whatever it looks like. Consumes the OUTPUT of
        ConvertFrom-DockerLogLine ({Ts, Rest} records) so the kept lines keep
        their own timestamps.
    #>
    param([Parameter(Mandatory = $true)]$Events)
    $kept = @()
    $dropped = 0
    foreach ($e in @($Events)) {
        if ($null -ne $e -and ([string]$e.Rest).IndexOf('[Failover]') -ge 0) {
            $kept += $e
        } else {
            $dropped++
        }
    }
    return @{ Kept = $kept; Dropped = $dropped }
}

function Get-FailoverLineFingerprint {
    # (ts, line) — the pair AC4 of #347 names. Two windows that overlap
    # re-request the boundary line; the fingerprint makes the re-read a skip.
    param([Parameter(Mandatory = $true)]$Event)
    return ('{0}|{1}' -f $Event.Ts, $Event.Rest)
}

function Select-NewFailoverLines {
    <#
    .SYNOPSIS
        Drop lines already written in a previous window, carry a bounded ring
        of fingerprints forward. PURE.
    .DESCRIPTION
        Same window-boundary reasoning as Select-NewDockerEvents, with the
        semantics the #347 live fix actually installed: the watermark is the
        instant the current window was OPENED (measured BEFORE the docker call
        — see Get-FailoverNextSince), NOT the instant the docker-logs process
        returned. The overlap of the call's own latency is therefore DELIBERATE:
        the next window re-requests every line flushed after the snapshot but
        before the return, and this function is what makes the re-read a skip —
        a line written once is written to the file exactly once. Without it one
        wall reads as two, and without the open-instant anchor the same lines
        would be read by neither window (the hole measured live 05/10: 22
        markers lost at 15:57:18-25Z, fixed the same day). The ring is bounded
        (SeenCap) so the state file carries a window's worth of fingerprints,
        not the whole history.
    #>
    param(
        [Parameter(Mandatory = $true)]$Events,
        $Seen = @(),
        [int]$SeenCap = 200
    )
    $ring = @()
    foreach ($s in @($Seen)) { if ($null -ne $s) { $ring += [string]$s } }
    $kept = @()
    $skipped = @()
    foreach ($e in @($Events)) {
        $fp = Get-FailoverLineFingerprint -Event $e
        if ($ring -contains $fp) { $skipped += $fp; continue }
        $kept += $e
        $ring += $fp
    }
    if ($ring.Count -gt $SeenCap) {
        $ring = $ring[($ring.Count - $SeenCap)..($ring.Count - 1)]
    }
    return @{ Kept = $kept; Skipped = $skipped; Seen = $ring }
}

function Get-FailoverNextSince {
    <#
    .SYNOPSIS
        The watermark for the next window — and NEVER backwards. PURE.
    .DESCRIPTION
        The watermark is the instant the CURRENT window was opened (measured
        BEFORE the docker call), NOT the instant it returned. The difference is
        load-bearing: `docker logs --since` snapshots the log when the daemon is
        asked but returns seconds later while it streams the dump, so a line
        written in between is absent from this window AND earlier than a
        return-instant watermark — read by neither, ever (measured on the live
        hub 05/10: 22 markers at 15:57:18-25Z, tick opened 15:57:16.5 and
        returned 15:57:29). Anchoring on the open instant makes the next window
        overlap this one by the call's own latency; the dedup ring drops the
        re-read.
        A FAILED invocation holds the previous watermark (AC3 of #347): a
        collector that advances over a window it did not read silently writes
        off the unread range. Never-backwards guards a clock skew between the
        host and whatever wrote the previous state.
        A window the coherence probe (Test-DockerLogsSinceCoherence) ruled
        INCOHERENT holds the watermark too, under a DISTINCT reason
        (`held-since-served-stale-segment`): the tick is not measured, the
        range stays unread for the next tick — a stale segment is a hole the
        file must not certify as quiet. The stale verdict is FATAL (never
        swallowed): a "measured" tick built on the previous rotation's segment
        is strictly worse than a held one — it certifies a window nobody read.
    #>
    param(
        [Parameter(Mandatory = $true)][bool]$InvocationOk,
        [string]$WindowStartUtc = '',
        [string]$PreviousSinceUtc = '',
        [string]$CoherenceVerdict = 'untested'
    )
    if ($CoherenceVerdict -eq 'stale') {
        return @{ SinceUtc = $PreviousSinceUtc; Reason = 'held-since-served-stale-segment' }
    }
    if (-not $InvocationOk) { return @{ SinceUtc = $PreviousSinceUtc; Reason = 'held-not-measured' } }
    if ([string]::IsNullOrWhiteSpace($WindowStartUtc)) {
        return @{ SinceUtc = $PreviousSinceUtc; Reason = 'held-no-window-start' }
    }
    if (-not [string]::IsNullOrWhiteSpace($PreviousSinceUtc) -and
        $WindowStartUtc -lt $PreviousSinceUtc) {
        return @{ SinceUtc = $PreviousSinceUtc; Reason = 'held-never-backwards' }
    }
    return @{ SinceUtc = $WindowStartUtc; Reason = 'window-start' }
}

function Test-DockerLogsSinceCoherence {
    <#
    .SYNOPSIS
        Refuse to certify a `--since` window that docker served from a stale
        (pre-rotation) segment. PURE.
    .DESCRIPTION
        The third hole in the "collector dead / proxy calm" ambiguity AC5 was
        written to close — this one measured, not supposed: on the json-file
        driver after a rotation, `docker logs --since` can serve the PREVIOUS
        segment instead of the current one, with no error and no warning
        (measured on ai-01 and po-2025 on 06-07/09, three epochs, three times;
        reproduced on .46 on 04/10; po-203 does NOT have the defect;
        traffic-live.ps1 carries a tail-depth fallback against the same
        signature, GOTCHA #2). In that case the collector receives old lines
        or nothing: Invoke-DockerEventsBounded returns Ok, an open-instant
        watermark ADVANCES, and the tick records itself as a healthy quiet
        window — the range is lost forever, by a third path.

        The discriminator is the one traffic-live.ps1 measured reliable:
        a SHORT tail probe. `docker logs <c> --tail 1 --timestamps` answers
        "what is the newest line the container REALLY holds?" — tail never
        lies where --since can. Fed HERE as injected data, so the verdict is
        testable with no docker at all:

          - the tail probe's newest instant is at-or-after SinceUtc, AND the
            --since window holds NO parsed line at-or-after SinceUtc
            (ToleranceSec of slack, for the photograph skew between the two
            calls),          -> 'stale'   : NOT MEASURED, watermark held;
          - newest instant BEFORE SinceUtc -> 'coherent-silent': a genuinely
            quiet window — the right answer, traffic-live measured exactly
            this (a `--since 1h` returning 0 lines against a newest line 4.5 h
            old is correct, not a defect);
          - the window itself holds a line at-or-after SinceUtc -> 'coherent':
            the segment is the current one, stale is impossible;
          - the probe itself failed, or the tail line cannot be parsed ->
            'untested': hold the watermark too. A tick not measured costs one
            tick; a swallowed window costs the history — so an inconclusive
            probe is NEVER read as coherent.

        TRANSPORT TRUTH IS THE EXIT CODE, NOT Invoke-DockerEventsBounded's
        verdict Ok. That verdict was built for `docker events`, where error
        text means docker refused; `docker logs` DEMUXES the container's
        stderr to the CLI's stderr (the traffic-live GOTCHA — and the hub's
        [Failover] markers are stderr-class), so a perfectly healthy one-line
        tail probe can return Lines=@(), ErrorText=<the marker line> and a
        verdict of "docker refused or could not run". Gating the probe on the
        verdict would wedge the collector permanently: whenever the log's
        newest line is a stderr line, every tick would be 'untested' and the
        watermark would never advance again. Exited + Code 0 IS the transport
        truth here; both probe streams are merged before parsing, and the
        NEWEST parseable instant wins (docker gives no cross-stream ordering
        guarantee). WindowLines must be the MERGED window (stdout + stderr):
        the hub's markers are stderr-class, so adjudicating stdout alone
        would call a window that legitimately holds them 'stale'.
    #>
    param(
        [Parameter(Mandatory = $true)]$TailProbe,   # the RAW Invoke-DockerEventsBounded result of `logs --tail 1 --timestamps` (@{ Exited; Code; Lines; ErrorText })
        [Parameter(Mandatory = $true)]$WindowLines, # string[] — the MERGED raw lines of the --since window (stdout + stderr, pre-parse)
        [Parameter(Mandatory = $true)][string]$SinceUtc,
        [int]$ToleranceSec = 3
    )

    if ($null -eq $TailProbe) {
        return @{ Verdict = 'untested'; Reason = 'tail probe absent — treated as not measured' }
    }
    $transportOk = $false
    try { $transportOk = ([bool]$TailProbe.Exited -and [int]$TailProbe.Code -eq 0) } catch { $transportOk = $false }
    if (-not $transportOk) {
        return @{ Verdict = 'untested'; Reason = 'tail probe failed (not exited or non-zero) — treated as not measured' }
    }
    $tailPool = @($TailProbe.Lines)
    $tailErr = ''
    try { $tailErr = [string]$TailProbe.ErrorText } catch { $tailErr = '' }
    if (-not [string]::IsNullOrWhiteSpace($tailErr)) {
        $tailPool += @($tailErr -split "`r?`n" | Where-Object { $_ })
    }
    $tailParsed = $null
    $tailParsedDt = $null
    $styles = [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    foreach ($l in @($tailPool)) {
        $p = ConvertFrom-DockerLogLine -Line ([string]$l)
        if ($null -eq $p) { continue }
        $dt = $null
        try { $dt = [datetime]::Parse($p.Ts, $inv, $styles) } catch { $dt = $null }
        if ($null -eq $dt) { continue }
        if ($null -eq $tailParsedDt -or $dt -gt $tailParsedDt) { $tailParsed = $p; $tailParsedDt = $dt }
    }
    if ($null -eq $tailParsed) {
        return @{ Verdict = 'untested'; Reason = 'tail probe line not parseable — treated as not measured' }
    }

    $sinceDt = $null
    try { $sinceDt = [datetime]::Parse($SinceUtc, $inv, $styles) } catch { $sinceDt = $null }
    if ($null -eq $sinceDt) {
        return @{ Verdict = 'untested'; Reason = 'since instant not parseable — treated as not measured' }
    }

    $tailDt = $null
    try { $tailDt = [datetime]::Parse($tailParsed.Ts, $inv, $styles) } catch { $tailDt = $null }
    if ($null -eq $tailDt) {
        return @{ Verdict = 'untested'; Reason = 'tail instant not parseable — treated as not measured' }
    }

    $threshold = $sinceDt.AddSeconds(-1 * [Math]::Abs($ToleranceSec))

    if ($tailDt -lt $sinceDt) {
        return @{ Verdict = 'coherent-silent'; Reason = ('newest container line {0} predates --since {1} — a genuinely quiet window' -f $tailParsed.Ts, $SinceUtc) }
    }

    foreach ($l in @($WindowLines)) {
        $p = ConvertFrom-DockerLogLine -Line $l
        if ($null -eq $p) { continue }
        $dt = $null
        try { $dt = [datetime]::Parse($p.Ts, $inv, $styles) } catch { $dt = $null }
        if ($null -ne $dt -and $dt -ge $threshold) {
            return @{ Verdict = 'coherent'; Reason = ('window holds a line at {0} at-or-after --since {1}' -f $p.Ts, $SinceUtc) }
        }
    }

    return @{ Verdict = 'stale'; Reason = ('newest container line {0} is at-or-after --since {1}, but the --since window holds no such line — the pre-rotation segment was served' -f $tailParsed.Ts, $SinceUtc) }
}

function Test-ClaudishRestartWasNoOp {
    <#
        PURE decision function: no I/O, no clock, no network.

        Answers ONE question: after a restart verb returned 0, did the
        container actually start again? Docker reports `.State.StartedAt` for
        the CURRENT run — a verb that touched nothing leaves the old value in
        place.

        Measured 2026-10-22 01:27Z on the hub: `-Recreate -EnvFile …` ran
        `docker compose up -d`; compose found no service-definition change and
        returned 0 WITHOUT replacing the container (a config-only edit lives in
        a bind mount, which compose never compares). The drain then wrote
        `OUTCOME success` while the process still held the OLD config —
        StartedAt 7 h old, uptimeSec 25741, and the new inbound key it was
        meant to activate answered 401. A false success on a config change is
        worse than a failure: nobody retries it.

        CLOCK-FREE (review 2026-10-22): StartedAt comes from the Docker
        daemon's clock — inside the WSL2 VM on Docker Desktop, which is NOT
        the Windows host's clock and can drift after a host sleep. Comparing
        StartedAt with a host-side `Get-Date` made a genuine restart read as a
        no-op whenever the VM lagged past the tolerance, and the caller was
        then told to restart again: a second stream-killing gesture. Reading
        StartedAt immediately BEFORE the verb and again immediately AFTER it
        compares the daemon with itself — drift cancels, and any difference is
        a new run. Equal ⇒ no-op, whatever the clocks say.

        Returns $null when either timestamp cannot be read (shim/fixture text,
        a format this parser does not know, an inspect that failed): the
        caller keeps its previous behaviour rather than inventing a verdict
        from noise — an unreadable instrument must never be reported as "the
        gesture failed".

        - StartedAtBeforeRaw : raw `docker inspect --format '{{.State.StartedAt}}'`
                               value taken immediately BEFORE the verb
                               (RFC3339 with nanoseconds, e.g.
                               2026-10-21T23:43:20.912677448Z).
        - StartedAtAfterRaw  : the same inspect, immediately after the verb.

        A Docker zero-time on the after side (0001-01-01T00:00:00Z, "never
        started") is never a success: it yields the no-op verdict.
    #>
    param(
        [AllowEmptyString()][string]$StartedAtBeforeRaw,
        [AllowEmptyString()][string]$StartedAtAfterRaw
    )

    if (-not $StartedAtBeforeRaw -or -not $StartedAtAfterRaw) { return $null }

    # .NET Framework (PS 5.1) rejects 9 fractional digits — compare at
    # seconds, which also makes the comparison immune to how a fixture spells
    # the fractional part.
    $inv = [System.Globalization.CultureInfo]::InvariantCulture
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    $parsed = @{}
    foreach ($side in @('before', 'after')) {
        $raw = if ($side -eq 'before') { $StartedAtBeforeRaw } else { $StartedAtAfterRaw }
        $m = [regex]::Match($raw.Trim(), '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})')
        if (-not $m.Success) { return $null }
        $dt = [datetime]::MinValue
        if (-not [datetime]::TryParseExact($m.Groups[1].Value, 'yyyy-MM-ddTHH:mm:ss', $inv, $styles, [ref]$dt)) { return $null }
        $parsed[$side] = $dt
    }

    # Zero-time on the after side = the container never started: not a success.
    if ($parsed['after'] -eq [datetime]::MinValue) { return $true }

    # Both readings come from the same daemon clock: any difference is a new run.
    return ($parsed['before'] -eq $parsed['after'])
}
#endregion

Export-ModuleMember -Function @(
    'Get-ScriptProvenance'
    'Get-CaptureArchiveName'
    'Get-CaptureArchiveDay'
    'Get-CaptureArchiveMachineTag'
    'Get-CapturePartialInfo'
    'Get-CaptureArchivePolicy'
    'Get-OffsiteWriteVerdict'
    'Get-ShaManifestPath'
    'Read-ShaManifest'
    'Update-ShaManifest'
    'Select-ShaRotation'
    'Get-SevenZipCandidates'
    'Resolve-SevenZipPath'
    'Invoke-GitBounded'
    'ConvertFrom-DockerEventLine'
    'Get-DockerEventFingerprint'
    'Get-DockerEventActionName'
    'Get-DockerEventLifecycleActions'
    'Get-DockerEventsFilterArgs'
    'Select-LifecycleDockerEvents'
    'Select-NewDockerEvents'
    'ConvertTo-DockerSinceInstant'
    'Get-DockerEventsNextSince'
    'Get-DockerEventsInvocationVerdict'
    'Get-DockerEventGroupVerdict'
    'Get-DockerEventsRotationPlan'
    'Add-DockerEventsTickRecord'
    'Invoke-DockerEventsBounded'

    'ConvertFrom-DockerLogLine'
    'Select-FailoverLines'
    'Get-FailoverLineFingerprint'
    'Select-NewFailoverLines'
    'Get-FailoverNextSince'
    'Test-DockerLogsSinceCoherence'
    'Get-ClaudishServingBase'
    'Resolve-ClaudishProbeUrl'
    'Get-LoopbackProbeUrl'
    'Test-LoopbackListener'
    'Test-HttpAlive'
    'Test-WedgeWatchOptIn'
    'Test-ClaudishOptIn'
    'Test-RelaunchPreflightOptIn'
    'Get-RelaunchPreflightOptInFileName'
    'Test-GuiZombieKillOptIn'
    'Get-GuiZombieKillOptInFileName'
    'Get-EngineZombieDecision'
    'Get-EngineFatalStreakDecision'
    'Get-EngineFatalStreakThreshold'
    'Get-EngineFatalStreakMarkerName'
    'ConvertTo-WatchdogStateJson'
    'ConvertFrom-WatchdogStateJson'
    'Get-EngineWatchdogDecision'
    'Select-WslrelaySquatters'
    'Get-LoopbackVerdict'
    'Get-CurlHttpProbeVerdict'
    'Enable-DrainAdmissionFreeze'
    'Disable-DrainAdmissionFreeze'
    'New-EngineRelaunchRegistration'
    'Get-InteractiveUserId'
    'ConvertFrom-QuserOutput'
    'Test-EngineRelaunchReady'
    'Get-WedgeDecision'
    'Get-ClaudishOptInFileName'
    'Get-ClaudishOptInToken'
    'Get-ClaudishMachineName'
    'Test-ClaudishRestartWasNoOp'
)
