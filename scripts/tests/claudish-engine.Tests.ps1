<#
    Pester 5 suite for scripts/lib/claudish-engine.psm1.

    Run:  pwsh -NoProfile -Command "Invoke-Pester ./scripts/tests -Output Detailed"

    These tests exist because the 2026-09-20 engine-recovery attempt shipped to
    the production hub with no way to exercise its logic except a real wedge.
    Every branch that mattered was reachable only in prod, so the one that threw
    was found by the host losing its container engine.

    The suite is deliberately heavy on REGRESSION tests, each named after the
    specific way a real instrument lied that day. A test named after a defect is
    worth more than a test named after a function.
#>

# A stand-in for the exception .NET raises on an HTTP error status: the thing
# that distinguishes "the server answered, with a status we did not want" from
# "nothing answered" is that the exception CARRIES a response object. Fabricating
# a real HttpWebResponse is not possible from script, and the property is all
# Test-HttpAlive looks at.
class ResponseBearingException : System.Exception {
    [object]$Response
    ResponseBearingException([string]$message, [object]$response) : base($message) {
        $this.Response = $response
    }
}

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force
    $script:ScriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

    # Scripts a scheduled task runs unattended. Production invokes these with
    # `powershell` (Windows PowerShell 5.1), so they must parse there.
    $script:ScheduledTaskScripts = @(
        'claudish-watchdog.ps1',
        'claudish-drain.ps1',
        'docker-events-collect.ps1',
        'lib\claudish-engine.psm1'
    )

    # Files that deliberately use pwsh-7-only syntax. Interactive analysis
    # tools only — never a scheduled task. Kept honest by a test below.
    $script:Pwsh7OnlyScripts = @('CaptureUtils.psm1')
}

Describe 'Get-ClaudishServingBase' {
    It 'returns $null when no base-url.txt exists (the fleet-wide default)' {
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -BeNullOrEmpty
    }

    It 'returns $null for an empty file rather than an empty URL' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value '' -NoNewline
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -BeNullOrEmpty
    }

    It 'returns $null for content that is not an http(s) URL' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value 'not-a-url'
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -BeNullOrEmpty
    }

    It 'reads a valid URL and strips the trailing slash' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value "http://192.168.0.50:3000/`n"
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -Be 'http://192.168.0.50:3000'
    }

    It 'takes only the first line of a multi-line file' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value "http://192.168.0.50:3000`n# a comment someone added"
        Get-ClaudishServingBase -ClaudishHome $TestDrive | Should -Be 'http://192.168.0.50:3000'
    }
}

Describe 'Resolve-ClaudishProbeUrl' {
    It 'falls back to localhost when nothing is configured (zero change by default)' {
        Resolve-ClaudishProbeUrl -ClaudishHome $TestDrive -Port 3000 | Should -Be 'http://localhost:3000'
    }

    It 'uses the configured host when base-url.txt is present' {
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value 'http://192.168.0.50:3000'
        Resolve-ClaudishProbeUrl -ClaudishHome $TestDrive -Port 3000 | Should -Be 'http://192.168.0.50:3000'
    }

    It 'REGRESSION (#110): takes the PORT from the caller, never from the override' {
        # A machine-wide base URL carrying :3000 must not make a sidecar on
        # :3002 probe the hub's port. Resolving a URL once, globally, is what
        # made a dot-sourced drain probe the wrong container on ai-01.
        Set-Content -Path (Join-Path $TestDrive 'base-url.txt') -Value 'http://192.168.0.50:3000'
        Resolve-ClaudishProbeUrl -ClaudishHome $TestDrive -Port 3002 | Should -Be 'http://192.168.0.50:3002'
    }
}

Describe 'Get-LoopbackProbeUrl' {
    It 'REGRESSION: names [::1] explicitly and never localhost' {
        # A localhost probe from pwsh 7 falls back IPv6 -> IPv4 fast enough to
        # answer 200 over 127.0.0.1 while ::1 is dead — blind to the exact
        # outage the probe exists to catch.
        $url = Get-LoopbackProbeUrl -Port 3000
        $url | Should -Be 'http://[::1]:3000'
        $url | Should -Not -Match 'localhost'
    }
}

Describe 'Test-LoopbackListener' {
    It 'is $true when the enumerator sees a [::1] listener' {
        Test-LoopbackListener -Port 3000 -Enumerator { param($p) @([PSCustomObject]@{ LocalAddress = '::1' }) } | Should -BeTrue
    }

    It 'is $false when nothing is listening on [::1]' {
        Test-LoopbackListener -Port 3000 -Enumerator { param($p) @() } | Should -BeFalse
    }

    It 'REGRESSION (mirrored trap): an enumerator that THROWS yields $false, not a verdict' {
        # Under networkingMode=mirrored the Windows TCP table cannot enumerate
        # the mirrored netns. "Not visible" must never be read as "not serving":
        # that misreading is what produced a published-then-retracted verdict.
        Test-LoopbackListener -Port 3000 -Enumerator { param($p) throw 'table not enumerable' } | Should -BeFalse
    }
}

Describe 'Test-HttpAlive' {
    It 'is $true on a clean response' {
        Test-HttpAlive -Url 'http://x/health' -Requester { param($u, $t) } | Should -BeTrue
    }

    It 'REGRESSION (5.1): an HTTP 400 counts as ALIVE, not as a wedge' {
        # Measured on the hub: Windows PowerShell 5.1 gets HTTP 400 from
        # http://[::1]:3000/health at the same moment pwsh 7 gets 200 from the
        # same address. A 400 is proof the forwarder carried the request and
        # brought an answer back. Requiring 200 turned a healthy machine into a
        # phantom wedge under the production interpreter — a defect that no
        # amount of testing under pwsh 7 could have found.
        #
        # The distinguishing fact is that the exception CARRIES a response
        # object, which is what both interpreters do on an HTTP error status.
        Test-HttpAlive -Url 'http://x/health' -Requester {
            param($u, $t)
            throw [ResponseBearingException]::new('(400) Bad Request', 'an HttpWebResponse')
        } | Should -BeTrue
    }

    It 'is $false only when NO response object came back (transport failure)' {
        Test-HttpAlive -Url 'http://x/health' -Requester { param($u, $t) throw 'connection refused' } |
            Should -BeFalse
    }
}

Describe 'Test-RelaunchPreflightOptIn (#188 review: its own consent, same semantics)' {
    It 'is off with no file, and off on an empty or wrong-content file' {
        Test-RelaunchPreflightOptIn -ClaudishHome $TestDrive | Should -BeFalse
        Set-Content -Path (Join-Path $TestDrive (Get-RelaunchPreflightOptInFileName)) -Value '' -NoNewline
        Test-RelaunchPreflightOptIn -ClaudishHome $TestDrive | Should -BeFalse
        Set-Content -Path (Join-Path $TestDrive (Get-RelaunchPreflightOptInFileName)) -Value 'yes please'
        Test-RelaunchPreflightOptIn -ClaudishHome $TestDrive | Should -BeFalse
    }

    It 'arms on the literal token, tolerating surrounding whitespace' {
        Set-Content -Path (Join-Path $TestDrive (Get-RelaunchPreflightOptInFileName)) -Value "  $(Get-ClaudishOptInToken)  `n"
        Test-RelaunchPreflightOptIn -ClaudishHome $TestDrive | Should -BeTrue
    }

    It 'REGRESSION: the preflight consent is NOT the wedge-watch consent' {
        # The whole point of the #188 review: one consent must not carry the
        # other. Written against the real files so a future "let's reuse the
        # wedge file" refactor goes red here.
        $drive = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $drive -Force | Out-Null

        Set-Content -Path (Join-Path $drive (Get-ClaudishOptInFileName)) -Value 'enabled'
        Test-RelaunchPreflightOptIn -ClaudishHome $drive | Should -BeFalse

        Remove-Item (Join-Path $drive (Get-ClaudishOptInFileName)) -Force
        Set-Content -Path (Join-Path $drive (Get-RelaunchPreflightOptInFileName)) -Value 'enabled'
        Test-WedgeWatchOptIn -ClaudishHome $drive | Should -BeFalse
        Test-RelaunchPreflightOptIn -ClaudishHome $drive | Should -BeTrue
    }
}

Describe 'Test-WedgeWatchOptIn' {
    It 'is $false on a machine with no opt-in file (the default everywhere)' {
        Test-WedgeWatchOptIn -ClaudishHome $TestDrive | Should -BeFalse
    }

    It 'REGRESSION: an EMPTY opt-in file does not arm a teardown' {
        # The previous guard armed on an accidental condition. An accidental
        # `New-Item` or stray redirect must not enable tearing down the host's
        # container engine.
        Set-Content -Path (Join-Path $TestDrive (Get-ClaudishOptInFileName)) -Value '' -NoNewline
        Test-WedgeWatchOptIn -ClaudishHome $TestDrive | Should -BeFalse
    }

    It 'is $false when the file exists with the wrong content' {
        Set-Content -Path (Join-Path $TestDrive (Get-ClaudishOptInFileName)) -Value 'yes please'
        Test-WedgeWatchOptIn -ClaudishHome $TestDrive | Should -BeFalse
    }

    It 'is $true only for the exact token, whitespace-tolerant' {
        Set-Content -Path (Join-Path $TestDrive (Get-ClaudishOptInFileName)) -Value "  $(Get-ClaudishOptInToken)  `n"
        Test-WedgeWatchOptIn -ClaudishHome $TestDrive | Should -BeTrue
    }
}

Describe 'ConvertFrom-QuserOutput / Get-InteractiveUserId' {
    It 'REGRESSION (locale): parses the FRENCH quser output captured on the hub' {
        # Verbatim from po-2025, 2026-09-20. A parser keying on the word
        # "Active" finds nobody here — the headers and the state column are
        # localized. Only the session-name column ("console", "rdp-tcp#N") is
        # a stable literal.
        $fr = @"
 UTILISATEUR           SESSION            ID  ÉTAT    TEMPS INACT TEMPS SESSION
>jsboi                 rdp-tcp#1           2  Actif           2  20/09/2026 12:27
"@
        ConvertFrom-QuserOutput -QuserText $fr | Should -Be 'jsboi'
    }

    It 'parses English console output too' {
        $en = @"
 USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME
 operator              console             1  Active      none   9/20/2026 8:02 AM
"@
        ConvertFrom-QuserOutput -QuserText $en | Should -Be 'operator'
    }

    It 'returns $null on empty or header-only output' {
        ConvertFrom-QuserOutput -QuserText '' | Should -BeNullOrEmpty
        ConvertFrom-QuserOutput -QuserText 'No User exists for *' | Should -BeNullOrEmpty
    }

    It 'REGRESSION (RDP): falls through an EMPTY Win32_ComputerSystem.UserName to quser' {
        # Measured on the hub: that property reports the CONSOLE session only,
        # and the operator is on RDP, so it comes back empty. Believing it
        # would make the preflight fail forever and the recovery path dead code
        # on the one machine it was written for.
        $id = Get-InteractiveUserId -Probe { '' } -QuserProbe {
            " UTILISATEUR   SESSION      ID  ÉTAT`n>jsboi         rdp-tcp#1     2  Actif"
        }
        $id | Should -Be ("{0}\jsboi" -f $env:COMPUTERNAME)
    }

    It 'prefers the console-session answer when it is available' {
        Get-InteractiveUserId -Probe { 'MACHINE\someone' } -QuserProbe { 'should not be reached' } |
            Should -Be 'MACHINE\someone'
    }

    It 'falls all the way through to the process-owner probe' {
        Get-InteractiveUserId -Probe { '' } -QuserProbe { '' } -ProcessOwnerProbe { 'MACHINE\viaexplorer' } |
            Should -Be 'MACHINE\viaexplorer'
    }

    It 'returns $null when every probe fails or throws (fail-safe)' {
        Get-InteractiveUserId -Probe { throw 'wmi down' } -QuserProbe { throw 'no quser' } -ProcessOwnerProbe { throw 'denied' } |
            Should -BeNullOrEmpty
    }
}

Describe 'Test-EngineRelaunchReady (the no-teardown-without-a-proven-rebuild gate)' {
    BeforeAll {
        $script:okPath  = { param($p) $true }
        $script:okUser  = { 'MACHINE\operator' }   # a full resolver, not one probe
        $script:okReg   = { param($n, $exe, $u) }
        $script:okVerif = { param($n) $true }
        # #176: stage 5 must not leak to the live machine. Without this stub
        # the default probe runs a real Get-Process, and on a machine where
        # Docker Desktop IS running the preflight proceeds to invoke the REAL
        # Start-ScheduledTask — a unit test reaching for the scheduler.
        $script:okDesktop = { $false }
    }

    It 'is Ready when every stage succeeds' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser -Registrar $okReg -Verifier $okVerif -DesktopProbe $okDesktop
        $r.Ready | Should -BeTrue
        $r.Checks | Should -Contain 'register:OK'
        $r.Checks | Should -Contain 'verify:OK'
    }

    It 'refuses when the executable is missing' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest { param($p) $false } -UserResolver $okUser -Registrar $okReg -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Reason | Should -Match 'executable'
    }

    It 'refuses when no interactive user can be resolved' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver { $null } -Registrar $okReg -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Reason | Should -Match 'user'
    }

    It 'REGRESSION (13:18): a registration that THROWS yields Ready=$false, not an assumption' {
        # This is the exact failure that cost the host its engine:
        #   "Register-ScheduledTask: cannot find a parameter named LogonType"
        # thrown AFTER the teardown. Here it is thrown BEFORE, and it is fatal
        # to the decision instead of fatal to the machine.
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser `
            -Registrar { param($n, $exe, $u) throw 'Cannot find a parameter named LogonType' } -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'register:FAILED'
        $r.Reason | Should -Match 'LogonType'
    }

    It 'REGRESSION: a NON-TERMINATING registration error is not read as success' {
        # Found by running the preflight for real, unelevated, on the hub:
        # Register-ScheduledTask emits "Access denied" as a non-terminating
        # error, so the enclosing try/catch never fired and the preflight
        # recorded register:OK for a task that was never created. Only the
        # read-back caught it. A gate must not depend on its own backstop.
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser `
            -Registrar { param($n, $exe, $u) Write-Error 'Access denied.' } -Verifier $okVerif
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'register:FAILED'
        $r.Checks | Should -Not -Contain 'register:OK'
    }

    It 'refuses when the task cannot be read back after a "successful" registration' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser -Registrar $okReg -Verifier { param($n) $false }
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'verify:ABSENT'
    }

    It 'treats an exception from the verifier as not-ready' {
        $r = Test-EngineRelaunchReady -TaskName 'T' -PathTest $okPath -UserResolver $okUser -Registrar $okReg -Verifier { param($n) throw 'rpc down' }
        $r.Ready | Should -BeFalse
    }
}

Describe 'New-EngineRelaunchRegistration (cmdlet surface)' {
    It 'REGRESSION: Register-ScheduledTask has no -LogonType parameter' {
        # The fact the code on main got wrong, pinned directly against the
        # installed cmdlet rather than against a memory of it.
        (Get-Command Register-ScheduledTask).Parameters.Keys | Should -Not -Contain 'LogonType'
        (Get-Command Register-ScheduledTask).Parameters.Keys | Should -Contain 'Principal'
    }

    It 'builds an Interactive principal without admin rights (the corrected shape)' {
        $p = New-ScheduledTaskPrincipal -UserId 'MACHINE\operator' -LogonType Interactive -RunLevel Highest
        $p.LogonType | Should -Be 'Interactive'
    }
}

Describe 'Test-EngineRelaunchReady execute probe (#176)' {
    BeforeAll {
        # A preflight whose first four stages are green by injection, with the
        # execute-probe seams as the only moving parts. Nothing here touches
        # the scheduler (dispatch bound: the logic is proven by injection this
        # cycle; the live exercise is a separate, announced step).
        # $script:InvokeCount witnesses WHETHER the task was invoked at all —
        # AC2's "never" is about the invocation, not just the verdict.
        function Invoke-ReadyPreflight {
            param(
                [bool]$DesktopRunning = $true,
                [int]$TaskResult = 0,
                [switch]$StaleRunTime,
                [switch]$NoInfo,
                [switch]$InvokerThrows,
                [switch]$ReaderThrows,
                [switch]$ProbeThrows,
                [int]$TimeoutMs = 400
            )
            $script:InvokeCount = 0
            $runTime = if ($StaleRunTime) { [DateTime]::Now.AddDays(-1) } else { [DateTime]::Now }
            Test-EngineRelaunchReady -PathTest { param($p) $true } `
                -UserId 'PO-2025\jsboige' `
                -Registrar { param($n, $e, $u) 'registered' } `
                -Verifier { param($n) $true } `
                -DesktopProbe {
                    if ($ProbeThrows) { throw 'desktop probe dead' }
                    $DesktopRunning
                } `
                -TaskInvoker {
                    param($n)
                    if ($InvokerThrows) { throw 'scheduler refused' }
                    $script:InvokeCount++
                } `
                -TaskInfoReader {
                    param($n)
                    if ($ReaderThrows) { throw 'reader blew up' }
                    if ($NoInfo) { return $null }
                    [PSCustomObject]@{ LastTaskResult = $TaskResult; LastRunTime = $runTime }
                } `
                -ExecuteProbeTimeoutMs $TimeoutMs
        }
    }

    It 'AC1: invokes the registered task and reports execute:OK on a clean completion' {
        $r = Invoke-ReadyPreflight -DesktopRunning $true -TaskResult 0
        $r.Ready | Should -BeTrue
        $r.Checks | Should -Contain 'execute:OK(result=0)'
        $r.Reason | Should -Match 'executed'
        $script:InvokeCount | Should -Be 1
    }

    It 'AC1: LastTaskResult 267009 (action launched, still running) also counts as executed' {
        # A GUI exe that keeps running leaves 267009 behind: the action
        # demonstrably launched and is alive. That is execution, not failure.
        $r = Invoke-ReadyPreflight -DesktopRunning $true -TaskResult 267009
        $r.Ready | Should -BeTrue
        $r.Checks | Should -Contain 'execute:OK(result=267009)'
    }

    It 'AC2: skips the probe and NEVER invokes the task when Docker Desktop is not running' {
        $r = Invoke-ReadyPreflight -DesktopRunning $false
        $r.Ready | Should -BeTrue
        $r.Checks | Should -Contain 'execute:SKIPPED(desktop-not-running)'
        $r.Reason | Should -Match 'registration-only'
        $script:InvokeCount | Should -Be 0
    }

    It 'AC2: a DesktopProbe that THROWS skips too (fail-safe on the side of not invoking)' {
        $r = Invoke-ReadyPreflight -ProbeThrows
        $r.Ready | Should -BeTrue
        $r.Checks | Should -Contain 'execute:SKIPPED(desktop-not-running)'
        $script:InvokeCount | Should -Be 0
    }

    It 'AC3 POSITIVE CONTROL: a deliberately broken action (LastTaskResult=1) is REFUSED' {
        # exit 1 is exactly what a wrong executable path or a policy-blocked
        # action leaves in LastTaskResult. The whole point of #176: a task that
        # registers cleanly and fails on execution must not read as ready.
        $r = Invoke-ReadyPreflight -DesktopRunning $true -TaskResult 1
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'execute:FAILED(result=1)'
        $r.Reason | Should -Match 'execute:'
    }

    It 'AC3: a task that never ran (stale LastRunTime) is refused, not assumed' {
        $r = Invoke-ReadyPreflight -DesktopRunning $true -StaleRunTime
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'execute:STALE'
        $r.Reason | Should -Match 'STALE|never advanced'
    }

    It 'AC3: a reader that returns nothing is not-ready (NO-INFO), never a guess' {
        $r = Invoke-ReadyPreflight -DesktopRunning $true -NoInfo
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'execute:NO-INFO'
    }

    It 'AC4 + fail-safe: an invoker that THROWS yields execute:ERROR, and the preflight never throws' {
        $r = Invoke-ReadyPreflight -DesktopRunning $true -InvokerThrows
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'execute:ERROR'
        $r.Reason | Should -Match 'execute:'
    }

    It 'AC4 + fail-safe: a reader that THROWS is execute:ERROR, not a crash' {
        $r = Invoke-ReadyPreflight -DesktopRunning $true -ReaderThrows
        $r.Ready | Should -BeFalse
        $r.Checks | Should -Contain 'execute:ERROR'
    }
}

Describe 'Get-WedgeDecision (pure decision table)' {
    BeforeAll {
        # Shorthand: a fully-armed, three-probe call with only the interesting
        # inputs varying. Opt-in defaults to $true because the gate has its own
        # dedicated tests — leaving it implicit everywhere would mean every
        # other test passed for the same, uninteresting reason.
        #
        # It lives in BeforeAll, not directly in the Describe: Pester runs the
        # Describe body in its DISCOVERY phase, and a function declared there is
        # gone by the time an It runs.
        function Invoke-Decision {
            param($V6, $V4, $Serving, $Listening = $true, $Wedge = 0, $OptIn = $true)
            Get-WedgeDecision -LoopbackV6Healthy $V6 -LoopbackV4Healthy $V4 `
                -ServingHealthy $Serving -LoopbackListening $Listening `
                -ConsecutiveWedge $Wedge -OptIn $OptIn
        }
    }

    It 'AC5: the gate is off by default — a machine that did not opt in is not measured' {
        $d = Invoke-Decision -V6 $false -V4 $true -Serving $true -Wedge 5 -OptIn $false
        $d.Action | Should -Be 'none'
        $d.Signature | Should -Be 'disabled'
        $d.Reason | Should -Match 'not enabled'
    }

    It 'AC5: the gate is proven in the other direction too — opted in, the same inputs escalate' {
        # A gate tested in one direction only proves the code can say no.
        $d = Invoke-Decision -V6 $false -V4 $true -Serving $true -Wedge 5 -OptIn $true
        $d.Action | Should -Be 'escalate'
    }

    It 'does nothing and resets when [::1] answers' {
        $d = Invoke-Decision -V6 $true -V4 $true -Serving $true -Wedge 1
        $d.Action | Should -Be 'none'
        $d.Signature | Should -Be 'healthy'
        $d.Wedge | Should -Be 0
    }

    It 'DISCRIMINANT: [::1] dead while 127.0.0.1 answers is a WEDGE' {
        $d = Invoke-Decision -V6 $false -V4 $true -Serving $false -Wedge 1
        $d.Signature | Should -Be 'wedge'
        $d.Action | Should -Be 'escalate'
    }

    It 'DISCRIMINANT: [::1] dead while only the LAN answers is a WEDGE' {
        $d = Invoke-Decision -V6 $false -V4 $false -Serving $true -Wedge 1
        $d.Signature | Should -Be 'wedge'
    }

    It 'DISCRIMINANT: all three families dead is the HUB, not a wedge' {
        # The mirror image of the 2026-09-20 mistake. Calling this a wedge would
        # send an operator hunting the forwarder during an ordinary outage, and
        # the hang/restart path — which CAN fix it — would never run.
        $d = Invoke-Decision -V6 $false -V4 $false -Serving $false -Wedge 1
        $d.Action | Should -Be 'none'
        $d.Signature | Should -Be 'hub-down'
        $d.Reason | Should -Match 'hang path'
    }

    It 'fails safe when no [::1] listener is visible (mirrored: "not visible" is not "not serving")' {
        $d = Invoke-Decision -V6 $false -V4 $true -Serving $true -Listening $false -Wedge 5
        $d.Action | Should -Be 'none'
        $d.Signature | Should -Be 'inconclusive'
    }

    It 'arms on the first sighting without escalating (1 of 2)' {
        $d = Invoke-Decision -V6 $false -V4 $true -Serving $true -Wedge 0
        $d.Action | Should -Be 'arm'
        $d.Wedge | Should -Be 1
    }

    It 'CORE GUARD: the terminal verdict is escalate — no input produces an actuator' {
        # Exhaustive over every boolean combination and a range of counters.
        # There must be no reachable verdict past 'escalate': #172 AC4, and the
        # reason 13:18 happened at all. This is the test that must fail if
        # anyone ever adds a fifth action.
        foreach ($v6 in @($true, $false)) {
        foreach ($v4 in @($true, $false)) {
        foreach ($sv in @($true, $false)) {
        foreach ($li in @($true, $false)) {
        foreach ($oi in @($true, $false)) {
        foreach ($wc in @(0, 1, 2, 17)) {
            $d = Invoke-Decision -V6 $v6 -V4 $v4 -Serving $sv -Listening $li -Wedge $wc -OptIn $oi
            $d.Action | Should -BeIn @('none', 'arm', 'escalate')
            $d.Reason | Should -Not -BeNullOrEmpty
            $d.Signature | Should -BeIn @('disabled', 'healthy', 'hub-down', 'inconclusive', 'wedge')
        }}}}}}
    }

    It 'REGRESSION: a confirmed wedge says container restarts cannot fix it' {
        # The operative fact. 13 restarts were attempted because nothing told
        # the operator they were useless; the escalation must carry that.
        $d = Invoke-Decision -V6 $false -V4 $true -Serving $true -Wedge 1
        $d.Reason | Should -Match 'CANNOT fix'
        $d.Reason | Should -Match 'host reboot'
    }
}

Describe 'Static guardrails over scripts/' {
    It 'REGRESSION: no script passes -LogonType to Register-ScheduledTask' {
        # Pins the defect tree-wide, not just in the module that fixed it.
        #
        # This walks the AST rather than grepping the text, deliberately. The
        # first draft of this test was a regex, and it reported three offenders:
        # the one real call plus this file and the module, which merely DISCUSS
        # the defect in prose. An instrument that cannot tell a call from a
        # comment about a call produces exactly the wrong-but-plausible number
        # this repo has been bitten by before (counting armed cascades by name,
        # reading an empty TCP table as a verdict). The AST sees commands.
        $offenders = @()
        Get-ChildItem -Path $script:ScriptsRoot -Filter '*.ps*1' -Recurse -File | ForEach-Object {
            $tokens = $null; $errs = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errs)
            $calls = $ast.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.CommandAst] -and
                $n.GetCommandName() -eq 'Register-ScheduledTask'
            }, $true)
            foreach ($call in $calls) {
                $params = $call.CommandElements |
                    Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
                    ForEach-Object { $_.ParameterName }
                if ($params -contains 'LogonType') { $offenders += ('{0}:{1}' -f $_.Name, $call.Extent.StartLineNumber) }
            }
        }
        $offenders | Should -BeNullOrEmpty
    }

    It 'the AST offender-detector actually detects (positive control)' {
        # A guard that matches nothing passes for the wrong reason. Same role as
        # the 24 controller.close() hits that prove the never-hang filter still
        # matches something.
        $tokens = $null; $errs = $null
        $bad = [System.Management.Automation.Language.Parser]::ParseInput(
            'Register-ScheduledTask -TaskName T -Action $a -User "x\y" -LogonType Interactive -Force',
            [ref]$tokens, [ref]$errs)
        $calls = $bad.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.CommandAst] -and
            $n.GetCommandName() -eq 'Register-ScheduledTask'
        }, $true)
        $calls.Count | Should -Be 1
        ($calls[0].CommandElements |
            Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
            ForEach-Object { $_.ParameterName }) | Should -Contain 'LogonType'
    }

    It 'AC4: the wedge detection path contains no actuator' {
        # jsboige/claudish#172 AC4, made executable: "a reviewer must be able to
        # grep the diff and find no Restart-*, no Stop-*, no -Verb RunAs".
        #
        # Scoped to the wedge functions rather than the whole file, because the
        # watchdog legitimately restarts the CONTAINER on the hang path — that
        # predates all of this and is the correct remedy for a hang. What must
        # never appear is an actuator on the WEDGE path, where no restart helps.
        # The scope is stated so the number cannot go stale silently.
        $wdPath = Join-Path $script:ScriptsRoot 'claudish-watchdog.ps1'
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($wdPath, [ref]$tokens, [ref]$errs)

        $wedgeFns = $ast.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Name -match 'Wedge'
        }, $true)
        $wedgeFns.Count | Should -BeGreaterThan 0 -Because 'the guard must have something to guard'

        $offenders = @()
        foreach ($fn in $wedgeFns) {
            foreach ($call in $fn.FindAll({
                param($n) $n -is [System.Management.Automation.Language.CommandAst]
            }, $true)) {
                $name = $call.GetCommandName()
                if ($name -and ($name -match '^(Restart-|Stop-)' -or $name -eq 'wsl.exe' -or $name -eq 'wsl')) {
                    $offenders += ('{0}:{1} {2}' -f $fn.Name, $call.Extent.StartLineNumber, $name)
                }
                $flags = $call.CommandElements |
                    Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
                    ForEach-Object { $_.ParameterName }
                if ($flags -contains 'Verb') { $offenders += ('{0}:{1} -Verb' -f $fn.Name, $call.Extent.StartLineNumber) }
            }
            # `docker stop` is not a Stop-* cmdlet — it is an external command
            # whose actuator lives in its argument, which an AST command-name
            # check walks straight past.
            if ($fn.Extent.Text -match 'docker\s+(stop|restart|kill)') {
                $offenders += ('{0}: docker stop/restart/kill' -f $fn.Name)
            }
        }
        $offenders | Should -BeNullOrEmpty
    }

    It 'AC4: the actuator detector actually detects (positive control)' {
        # Without this, deleting the wedge functions would make the guard above
        # pass for the wrong reason.
        $tokens = $null; $errs = $null
        $bad = [System.Management.Automation.Language.Parser]::ParseInput(
            'function Invoke-WedgeThing { Stop-Service com.docker.service -Force; docker stop c }',
            [ref]$tokens, [ref]$errs)
        $fn = $bad.FindAll({
            param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]
        }, $true)[0]

        $hits = @($fn.FindAll({
            param($n) $n -is [System.Management.Automation.Language.CommandAst]
        }, $true) | Where-Object { $_.GetCommandName() -match '^(Restart-|Stop-)' })
        $hits.Count | Should -BeGreaterThan 0
        $fn.Extent.Text | Should -Match 'docker\s+(stop|restart|kill)'
    }

    It 'AC3 (#185): the healthy-cycle relaunch-preflight path contains no actuator' {
        # jsboige/claudish#185 AC3, same rules as the wedge guard above, plus
        # the watchdog's own engine entry points: calling
        # Invoke-ClaudishDrainedRestart or Start-DockerEngine from the
        # preflight watch would be an engine action by indirection. The probe
        # deliberately MAY register and invoke the ClaudishEngineRelaunch task
        # (that is the measurement), which launches a GUI exe — a launch is
        # not a teardown and is not in the forbidden set.
        $wdPath = Join-Path $script:ScriptsRoot 'claudish-watchdog.ps1'
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($wdPath, [ref]$tokens, [ref]$errs)

        $fns = $ast.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Name -match 'RelaunchPreflight'
        }, $true)
        $fns.Count | Should -BeGreaterThan 0 -Because 'the guard must have something to guard'

        $offenders = @()
        foreach ($fn in $fns) {
            foreach ($call in $fn.FindAll({
                param($n) $n -is [System.Management.Automation.Language.CommandAst]
            }, $true)) {
                $name = $call.GetCommandName()
                if ($name -and ($name -match '^(Restart-|Stop-)' -or $name -eq 'wsl.exe' -or $name -eq 'wsl' -or
                    $name -eq 'Invoke-ClaudishDrainedRestart' -or $name -eq 'Start-DockerEngine')) {
                    $offenders += ('{0}:{1} {2}' -f $fn.Name, $call.Extent.StartLineNumber, $name)
                }
                $flags = $call.CommandElements |
                    Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } |
                    ForEach-Object { $_.ParameterName }
                if ($flags -contains 'Verb') { $offenders += ('{0}:{1} -Verb' -f $fn.Name, $call.Extent.StartLineNumber) }
            }
            if ($fn.Extent.Text -match 'docker\s+(stop|restart|kill)') {
                $offenders += ('{0}: docker stop/restart/kill' -f $fn.Name)
            }
        }
        $offenders | Should -BeNullOrEmpty
    }

    It 'AC3 (#185): the preflight actuator detector actually detects (positive control)' {
        # Without this, deleting the preflight watch would make the guard above
        # pass for the wrong reason — the same discipline as the wedge guard.
        $tokens = $null; $errs = $null
        $bad = [System.Management.Automation.Language.Parser]::ParseInput(
            'function Invoke-RelaunchPreflightBad { Invoke-ClaudishDrainedRestart -Reason x; Stop-Service com.docker.service -Force; docker stop c }',
            [ref]$tokens, [ref]$errs)
        $fn = $bad.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Name -match 'RelaunchPreflight'
        }, $true)[0]

        $hits = @($fn.FindAll({
            param($n) $n -is [System.Management.Automation.Language.CommandAst]
        }, $true) | Where-Object {
            $_.GetCommandName() -match '^(Restart-|Stop-)' -or $_.GetCommandName() -eq 'Invoke-ClaudishDrainedRestart'
        })
        $hits.Count | Should -BeGreaterThan 0
        $fn.Extent.Text | Should -Match 'docker\s+(stop|restart|kill)'
    }

    It 'AC1: no probe path names localhost' {
        # pwsh 7 falls back IPv6->IPv4 fast enough that a `localhost` probe
        # reports healthy straight through the wedge it exists to catch. The
        # probe and the client must see the same network.
        $wdPath = Join-Path $script:ScriptsRoot 'claudish-watchdog.ps1'
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($wdPath, [ref]$tokens, [ref]$errs)
        $fn = $ast.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Name -eq 'Invoke-LoopbackWedgeWatch'
        }, $true)
        $fn.Count | Should -Be 1
        # Strip comments: the prose explains WHY localhost is forbidden, and an
        # instrument that cannot tell a call from a comment about a call is the
        # exact failure this suite already has a scar from.
        $code = ($fn[0].Extent.Text -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
        $code | Should -Not -Match 'localhost'
    }

    It 'the watchdog gates the wedge watch on the explicit opt-in helper, not on a string comparison' {
        $wd = Get-Content -LiteralPath (Join-Path $script:ScriptsRoot 'claudish-watchdog.ps1') -Raw
        if ($wd -match 'Get-WedgeDecision') {
            $wd | Should -Match 'Test-WedgeWatchOptIn'
            $wd | Should -Not -Match 'Invoke-EngineWedgeRecovery'
        }
    }

    It 'REGRESSION (5.1): every scheduled-task script parses under THIS interpreter' {
        # The scheduled tasks invoke `powershell -ExecutionPolicy Bypass -File`,
        # which is Windows PowerShell 5.1 — NOT pwsh 7. A pwsh-7-only construct
        # (`??`, `?.`, ternary) in any of these files is a parse failure that
        # occurs only in production, on a machine nobody is watching, and takes
        # the watchdog out entirely. It is the same shape of defect as the
        # HTTP 400 one: correct under the interpreter used for development,
        # broken under the interpreter used for the job. Run this suite under
        # BOTH interpreters — under 5.1 it is the assertion that matters.
        $errors = @()
        foreach ($rel in $script:ScheduledTaskScripts) {
            $path = Join-Path $script:ScriptsRoot $rel
            $path | Should -Exist
            $e = $null; $t = $null
            [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$t, [ref]$e) | Out-Null
            if ($e -and $e.Count -gt 0) { $errors += ('{0}: {1}' -f $rel, $e[0].Message) }
        }
        $errors | Should -BeNullOrEmpty
    }

    It 'every other script in scripts/ parses, except the documented pwsh-7-only ones' {
        # CaptureUtils.psm1 uses `??` deliberately and its consumers are
        # documented as requiring pwsh ("traffic-anthropic.ps1 exige pwsh").
        # That is a supported choice for an interactive analysis tool, and a
        # different thing from an unattended scheduled task. The exclusion is
        # scoped to 5.1 only, so under pwsh 7 these files are still asserted —
        # an exclusion that hides a file from every interpreter hides a defect.
        $skip = if ($PSVersionTable.PSVersion.Major -lt 7) { $script:Pwsh7OnlyScripts } else { @() }
        $errors = @()
        Get-ChildItem -Path $script:ScriptsRoot -Filter '*.ps*1' -Recurse -File |
            Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
                $e = $null; $t = $null
                [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$e) | Out-Null
                if ($e -and $e.Count -gt 0) { $errors += ('{0}: {1}' -f $_.Name, $e[0].Message) }
            }
        $errors | Should -BeNullOrEmpty
    }

    It 'the pwsh-7-only list is accurate and not a dumping ground' {
        # A skip list nobody maintains grows until it covers the file that
        # actually broke. Under pwsh 7 every listed file must parse (proving the
        # entry is about interpreter version, not about a real syntax error),
        # and no scheduled-task script may ever appear on it.
        foreach ($name in $script:Pwsh7OnlyScripts) {
            $script:ScheduledTaskScripts | ForEach-Object { (Split-Path $_ -Leaf) | Should -Not -Be $name }
        }
        if ($PSVersionTable.PSVersion.Major -ge 7) {
            foreach ($name in $script:Pwsh7OnlyScripts) {
                $f = Get-ChildItem -Path $script:ScriptsRoot -Filter $name -Recurse -File | Select-Object -First 1
                $f | Should -Not -BeNullOrEmpty -Because "$name is listed as pwsh-7-only but does not exist"
                $e = $null; $t = $null
                [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e) | Out-Null
                $e | Should -BeNullOrEmpty -Because "$name must be valid pwsh 7, merely not 5.1"
            }
        }
    }
}

Describe 'Get-ScriptProvenance — name the artifact that is actually executing' {
    # Measured 2026-09-20 across the fleet: the scheduled tasks run these scripts
    # DIRECTLY from a git working tree, so an edit is in production at the next
    # tick, with no deployment step and no review gate. This is the
    # identification step only — no guard, no actuator. Every test drives the
    # injectable git seam, so none of them touches a real repository.

    BeforeAll {
        # A fake git: answers from a table keyed on the joined arguments, so each
        # failure shape is reachable without breaking a real tree.
        function New-FakeGit {
            param([hashtable]$Answers)
            return {
                param($a)
                $key = ($a -join ' ')
                if ($Answers.ContainsKey($key)) { return $Answers[$key] }
                return @{ Ok = $false; Out = ''; Reason = 'exit 128' }
            }.GetNewClosure()
        }
        $script:FullSha = 'de74d6c1111111111111111111111111111111111'
        $script:AncestorKey = "merge-base --is-ancestor $script:FullSha origin/main"
        $script:CleanTree = @{
            'rev-parse HEAD'              = @{ Ok = $true; Out = $script:FullSha; Reason = 'exit 0' }
            'rev-parse --abbrev-ref HEAD' = @{ Ok = $true; Out = 'main'; Reason = 'exit 0' }
            'status --porcelain'          = @{ Ok = $true; Out = ''; Reason = 'exit 0' }
        }
    }

    It 'a clean tree on main reports ref, short sha and clean' {
        $answers = $script:CleanTree.Clone()
        $answers[$script:AncestorKey] = @{ Ok = $true; Out = ''; Reason = 'exit 0' }
        $p = Get-ScriptProvenance -ScriptRoot 'D:\claudish\scripts' -GitInvoker (New-FakeGit $answers)
        $p.Versioned | Should -BeTrue
        $p.Ref | Should -Be 'main'
        $p.Sha | Should -Be 'de74d6c'
        $p.Dirty | Should -BeFalse
        $p.InOriginMain | Should -Be 'yes'
        $p.Summary | Should -Match 'PROVENANCE: ref=main sha=de74d6c tree=clean in-origin/main=yes'
    }

    It 'UNTRACKED-only dirt is reported as such — the executed files are still the committed ones' {
        # po-2025's measured state on 2026-09-20: 3 untracked entries, 0 tracked
        # modified. It matters because the sha still identifies the artifact.
        $answers = $script:CleanTree.Clone()
        $answers['rev-parse --abbrev-ref HEAD'] = @{ Ok = $true; Out = 'fix/watchdog-forwarder-wedge'; Reason = 'exit 0' }
        $answers['status --porcelain'] = @{ Ok = $true; Reason = 'exit 0'; Out = (@(
            '?? .env.rogue-relay-20260919'
            '?? .mcp.json'
            '?? .playwright-mcp/'
        ) -join "`n") }
        $p = Get-ScriptProvenance -ScriptRoot 'D:\Dev\claudish\scripts' -GitInvoker (New-FakeGit $answers)
        $p.TrackedDirty | Should -Be 0
        $p.UntrackedDirty | Should -Be 3
        $p.Dirty | Should -BeTrue
        $p.Summary | Should -Match 'tree=untracked-only\(3\)'
        # -CMatch, not -Match: PowerShell's -Match is CASE-INSENSITIVE, so
        # 'TRACKED' matches inside "unTRACKED-only" and this assertion failed
        # against correct code on the first run. The loud marker is the uppercase
        # one, so the assertion has to be case-sensitive to mean what it says.
        # Same family as `-split` being case-insensitive (`-csplit` exists for
        # the same reason).
        $p.Summary | Should -Not -CMatch 'TRACKED\('
    }

    It 'a modified TRACKED file is shouted, because then the running artifact exists in no commit' {
        $answers = $script:CleanTree.Clone()
        $answers['status --porcelain'] = @{ Ok = $true; Reason = 'exit 0'; Out = (@(
            ' M scripts/claudish-watchdog.ps1'
            'M  scripts/lib/claudish-engine.psm1'
            '?? notes.txt'
        ) -join "`n") }
        $p = Get-ScriptProvenance -ScriptRoot 'D:\Dev\claudish\scripts' -GitInvoker (New-FakeGit $answers)
        $p.TrackedDirty | Should -Be 2
        $p.UntrackedDirty | Should -Be 1
        $p.Summary | Should -Match 'tree=TRACKED\(2\)\+untracked\(1\)'
    }

    It 'POSITIVE CONTROL — the tracked/untracked split actually discriminates' {
        # Same function, two inputs differing ONLY in the porcelain prefix. If the
        # parser matched nothing (or everything), both would land in one bucket
        # and the distinction this line exists to carry would be silently fake.
        $a = $script:CleanTree.Clone()
        $a['status --porcelain'] = @{ Ok = $true; Out = '?? one'; Reason = 'exit 0' }
        $b = $script:CleanTree.Clone()
        $b['status --porcelain'] = @{ Ok = $true; Out = ' M one'; Reason = 'exit 0' }
        $pa = Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker (New-FakeGit $a)
        $pb = Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker (New-FakeGit $b)
        $pa.UntrackedDirty | Should -Be 1
        $pa.TrackedDirty   | Should -Be 0
        $pb.UntrackedDirty | Should -Be 0
        $pb.TrackedDirty   | Should -Be 1
    }

    It 'a detached HEAD is named, not reported as a branch' {
        $answers = $script:CleanTree.Clone()
        $answers['rev-parse --abbrev-ref HEAD'] = @{ Ok = $false; Out = ''; Reason = 'exit 128' }
        $p = Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker (New-FakeGit $answers)
        $p.Versioned | Should -BeTrue
        $p.Ref | Should -Be '(detached)'
        $p.Sha | Should -Be 'de74d6c'
    }

    It 'in-origin/main is a HINT with three states, never a silent boolean' {
        # `no` can mean "unreviewed" OR "origin/main not fetched recently" — this
        # function does no network git on purpose. Collapsing the third state into
        # `no` would turn a missing fetch into an accusation.
        $yes = $script:CleanTree.Clone()
        $yes[$script:AncestorKey] = @{ Ok = $true; Out = ''; Reason = 'exit 0' }
        $no = $script:CleanTree.Clone()
        $no[$script:AncestorKey] = @{ Ok = $false; Out = ''; Reason = 'exit 1' }
        (Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker (New-FakeGit $yes)).InOriginMain | Should -Be 'yes'
        (Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker (New-FakeGit $no)).InOriginMain  | Should -Be 'no'
        # No entry at all -> the fake returns exit 128 -> neither yes nor no.
        (Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker (New-FakeGit $script:CleanTree)).InOriginMain | Should -Be 'unknown'
    }

    It 'REGRESSION: git absent from PATH degrades to unversioned WITH a reason, and does not throw' {
        # The expected case under a SYSTEM principal, whose PATH is not the
        # operator's. A watchdog must survive it.
        $git = { param($a) return @{ Ok = $false; Out = ''; Reason = 'git not launchable' } }
        $p = Get-ScriptProvenance -ScriptRoot 'D:\claudish\scripts' -GitInvoker $git
        $p.Versioned | Should -BeFalse
        $p.Summary | Should -Match 'unversioned \(git not launchable\)'
        $p.Summary | Should -Match ([regex]::Escape('root=D:\claudish\scripts'))
    }

    It 'REGRESSION (mirrored trap): an invoker that THROWS yields unversioned, not an exception' {
        # Same shape as the quser regression: a probe fails by throwing as often
        # as by returning a bad value, and observability must not propagate it.
        $git = { param($a) throw 'access denied' }
        { Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker $git } | Should -Not -Throw
        (Get-ScriptProvenance -ScriptRoot 'X:\t' -GitInvoker $git).Versioned | Should -BeFalse
    }

    It 'an empty script root is unversioned, and says so' {
        $p = Get-ScriptProvenance -ScriptRoot '' -GitInvoker { param($a) throw 'never called' }
        $p.Versioned | Should -BeFalse
        $p.Summary | Should -Match 'no script root'
    }

    It 'the watchdog logs provenance once per cycle, inside a guard' {
        # The wiring, asserted statically: an unguarded observability call is the
        # one that turns a healthy cycle into a crash.
        $wd = Get-Content -LiteralPath (Join-Path $script:ScriptsRoot 'claudish-watchdog.ps1') -Raw
        $wd | Should -Match 'Get-ScriptProvenance'
        $wd | Should -Match 'PROVENANCE: unavailable'
        ([regex]::Matches($wd, 'Get-ScriptProvenance')).Count | Should -Be 1
    }
}

Describe 'Invoke-GitBounded — dubious ownership (SYSTEM vs operator tree)' {
    # Measured on po-2025, 2026-09-20: the watchdog task runs under SYSTEM, git
    # refuses the operator-owned tree (exit 128), and every PROVENANCE line
    # reads "unversioned" on the exact machine that motivated #177. These
    # tests use the REAL Invoke-GitBounded against a REAL scratch repository —
    # no injected git seam — under GIT_TEST_ASSUME_DIFFERENT_OWNER=1, which is
    # git's own switch for "behave as if the repo were owned by someone else".
    BeforeEach {
        $script:Repo = Join-Path $TestDrive 'repo'
        New-Item -ItemType Directory -Path $script:Repo -Force | Out-Null
        git -C $script:Repo init 2>&1 | Out-Null
        git -C $script:Repo -c user.name=t -c user.email=t@t commit --allow-empty -m x 2>&1 | Out-Null
        $script:PrevOwner = $env:GIT_TEST_ASSUME_DIFFERENT_OWNER
        $env:GIT_TEST_ASSUME_DIFFERENT_OWNER = '1'
    }
    AfterEach {
        if ($null -ne $script:PrevOwner) { $env:GIT_TEST_ASSUME_DIFFERENT_OWNER = $script:PrevOwner }
        else { Remove-Item Env:GIT_TEST_ASSUME_DIFFERENT_OWNER -ErrorAction SilentlyContinue }
    }

    It 'POSITIVE CONTROL: without the workaround, foreign ownership IS refused (exit 128)' {
        # If this ever passes, GIT_TEST_ASSUME_DIFFERENT_OWNER stopped being
        # honored and the regression below is vacuous — a dead instrument
        # pretending to guard. This control is what keeps it honest.
        $p = Start-Process -FilePath 'git' -ArgumentList @('-C', $script:Repo, 'rev-parse', 'HEAD') `
            -NoNewWindow -PassThru -Wait
        $p.ExitCode | Should -Be 128
    }

    It 'REGRESSION (exit 128): Invoke-GitBounded succeeds on a tree it does not own' {
        $r = Invoke-GitBounded -WorkDir $script:Repo -GitArgs @('rev-parse', 'HEAD')
        $r.Ok | Should -BeTrue
        $r.Out | Should -Not -BeNullOrEmpty
    }

    It 'REGRESSION: Get-ScriptProvenance resolves Versioned on a foreign-owned tree' {
        $prov = Get-ScriptProvenance -ScriptRoot $script:Repo
        $prov.Versioned | Should -BeTrue
        $prov.Summary | Should -Not -Match 'exit 128'
    }

    It 'leaves GIT_CONFIG_GLOBAL exactly as it found it' {
        $null = Invoke-GitBounded -WorkDir $script:Repo -GitArgs @('rev-parse', 'HEAD')
        $env:GIT_CONFIG_GLOBAL | Should -BeNullOrEmpty

        $env:GIT_CONFIG_GLOBAL = 'some-pre-existing-value'
        $null = Invoke-GitBounded -WorkDir $script:Repo -GitArgs @('rev-parse', 'HEAD')
        $env:GIT_CONFIG_GLOBAL | Should -Be 'some-pre-existing-value'
        Remove-Item Env:GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue
    }

    # ------------------------------------------------------------------
    # #184 — the temp config ADDS to the operator's global config.
    #
    # Before #184 it REPLACED it, so core.excludesFile stopped applying to
    # these calls and the PROVENANCE line read untracked-only(2) where plain
    # git said 1: two numbers for the same tree, with nothing on the line
    # telling the reader which to believe. The fix routes through [include],
    # and the AC2 measurement (2026-09-21, scratch repo under
    # GIT_TEST_ASSUME_DIFFERENT_OWNER=1) is what makes it safe to do: git
    # still honors the [safe] grant that way (exit 0, where a no-route
    # control exits 128 on the same tree) AND the included ignore file still
    # applies. Without that measurement the honest close was to document the
    # divergence instead — a fix that silently failed to apply safe.directory
    # would regress #183 straight back to exit 128.
    # ------------------------------------------------------------------
    It 'CONTROL for the #184 pin: a globally-ignored file IS visible without the operator config' {
        # Otherwise the pin below could pass for the wrong reason (a local
        # .gitignore, a name git never reports). Same tree, no global config:
        # both untracked files must be counted.
        Set-Content -Path (Join-Path $script:Repo 'noise.globalignored') -Value 'n' -Encoding ascii
        Set-Content -Path (Join-Path $script:Repo 'real.txt') -Value 'r' -Encoding ascii
        $prov = Get-ScriptProvenance -ScriptRoot $script:Repo
        $prov.Versioned | Should -BeTrue
        $prov.UntrackedDirty | Should -Be 2
    }

    It 'REGRESSION (#184): the operator global config survives — untracked-only(1), not (2)' {
        $globalIgnore = Join-Path $TestDrive 'global-ignore'
        Set-Content -Path $globalIgnore -Value 'noise.globalignored' -Encoding ascii
        $operatorCfg = Join-Path $TestDrive 'operator.gitconfig'
        @('[core]', "`texcludesFile = $($globalIgnore.Replace('\', '/'))") -join "`n" |
            Set-Content -Path $operatorCfg -Encoding ascii

        Set-Content -Path (Join-Path $script:Repo 'noise.globalignored') -Value 'n' -Encoding ascii
        Set-Content -Path (Join-Path $script:Repo 'real.txt') -Value 'r' -Encoding ascii

        $prevCfg = $env:GIT_CONFIG_GLOBAL
        $env:GIT_CONFIG_GLOBAL = $operatorCfg
        try {
            $prov = Get-ScriptProvenance -ScriptRoot $script:Repo
            # The [safe] grant still lands through the include — this is the
            # half that would have been lost by a fix that switched routes
            # without measuring, and it fails as `unversioned (exit 128)`.
            $prov.Versioned | Should -BeTrue
            $prov.Summary | Should -Not -Match 'exit 128'
            # ...and the operator's global gitignore is back in force.
            $prov.Summary | Should -Match 'tree=untracked-only\(1\)'
            $prov.UntrackedDirty | Should -Be 1
        }
        finally {
            if ($null -ne $prevCfg) { $env:GIT_CONFIG_GLOBAL = $prevCfg }
            else { Remove-Item Env:GIT_CONFIG_GLOBAL -ErrorAction SilentlyContinue }
        }
    }
}
