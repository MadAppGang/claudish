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

function Get-ClaudishOptInFileName { return $script:OptInFileName }
function Get-ClaudishOptInToken    { return $script:OptInToken }

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

function Test-WedgeWatchOptIn {
    <#
        Engine recovery is opt-in, per machine, through a file that must exist
        AND carry the literal token 'enabled'.

        Requiring content is deliberate: an empty file created by an accidental
        New-Item or a stray redirect does NOT arm a teardown of the host's
        container engine. The previous attempt's guard was a comparison between
        two strings that merely coincided; when they stopped coinciding, the
        teardown armed on every machine in the fleet.
    #>
    param([Parameter(Mandatory)][string]$ClaudishHome)

    $path = Join-Path $ClaudishHome $script:OptInFileName
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    try {
        $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction Stop)
    } catch { return $false }
    if ($null -eq $raw) { return $false }
    return ($raw.Trim() -eq $script:OptInToken)
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
        [int]$ExecuteProbeTimeoutMs = 5000
    )

    if (-not $PathTest)  { $PathTest  = { param($p) Test-Path -LiteralPath $p } }
    if (-not $Registrar) { $Registrar = { param($n, $exe, $u) New-EngineRelaunchRegistration -TaskName $n -ExecutablePath $exe -UserId $u } }
    if (-not $Verifier)  { $Verifier  = { param($n) [bool](Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) } }
    if (-not $DesktopProbe)   { $DesktopProbe   = { [bool](Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue) } }
    if (-not $TaskInvoker)    { $TaskInvoker    = { param($n) Start-ScheduledTask -TaskName $n } }
    if (-not $TaskInfoReader) { $TaskInfoReader = { param($n) Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue } }

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

    # 5. EXECUTE (#176). When the Desktop GUI is already running, invoking the
    #    relaunch task is a no-op for the engine (a second instance exits
    #    immediately), so the probe is free: run the task and read back its own
    #    LastTaskResult/LastRunTime. When the GUI is NOT running the probe is
    #    SKIPPED — invoking the task would START the engine, and a readiness
    #    check must never perform the action it is only asking about (AC2).
    #    A probe that throws is read as not-running for the same reason.
    try { $desktopRunning = [bool](& $DesktopProbe) } catch { $desktopRunning = $false }
    if (-not $desktopRunning) {
        $checks.Add('execute:SKIPPED(desktop-not-running)')
        return [PSCustomObject]@{
            Ready  = $true
            Reason = 'relaunch path proven (registration-only — Docker Desktop not running, execute probe skipped)'
            Checks = $checks.ToArray()
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
        $deadline = [DateTime]::Now.AddMilliseconds($ExecuteProbeTimeoutMs)
        $info = $null
        do {
            Start-Sleep -Milliseconds 250
            $info = & $TaskInfoReader $TaskName
            if ($null -ne $info -and $info.LastRunTime -ge $invokedAt.AddSeconds(-2) -and [int]$info.LastTaskResult -ne 267009) { break }
        } while ([DateTime]::Now -lt $deadline)

        if ($null -eq $info) {
            $checks.Add('execute:NO-INFO')
            return [PSCustomObject]@{ Ready = $false; Reason = "execute: could not read task '$TaskName' back after invoking it"; Checks = $checks.ToArray() }
        }
        if ($info.LastRunTime -lt $invokedAt.AddSeconds(-2)) {
            $checks.Add('execute:STALE')
            return [PSCustomObject]@{ Ready = $false; Reason = "execute: task '$TaskName' was invoked but LastRunTime never advanced (still $($info.LastRunTime))"; Checks = $checks.ToArray() }
        }
        $result = [int]$info.LastTaskResult
        if ($result -ne 0 -and $result -ne 267009) {
            $checks.Add("execute:FAILED(result=$result)")
            return [PSCustomObject]@{ Ready = $false; Reason = "execute: task '$TaskName' ran and its action failed (LastTaskResult=$result)"; Checks = $checks.ToArray() }
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
            $lines = @('[safe]') + @($safe | ForEach-Object { "`tdirectory = $_" })
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

Export-ModuleMember -Function @(
    'Get-ScriptProvenance'
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
    'Get-ClaudishServingBase'
    'Resolve-ClaudishProbeUrl'
    'Get-LoopbackProbeUrl'
    'Test-LoopbackListener'
    'Test-HttpAlive'
    'Test-WedgeWatchOptIn'
    'New-EngineRelaunchRegistration'
    'Get-InteractiveUserId'
    'ConvertFrom-QuserOutput'
    'Test-EngineRelaunchReady'
    'Get-WedgeDecision'
    'Get-ClaudishOptInFileName'
    'Get-ClaudishOptInToken'
)
