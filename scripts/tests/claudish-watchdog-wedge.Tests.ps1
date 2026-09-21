<#
    Integration tests for the wedge glue inside claudish-watchdog.ps1.

    The library suite proves the decision table. This one proves the WIRING: that
    the watchdog reads its state, calls the right probes, logs, persists the
    counter, and — above all — does not reach the engine unless every gate has
    opened. The previous attempt at this feature had no seam of any kind: the
    only way to execute its logic was to install it on the production hub and
    wait for a real wedge, which is how a teardown with a broken rebuild path
    reached a live machine.

    The watchdog is dot-sourced, so its main cycle does not run; the probes and
    the recovery action are injected, so nothing here touches Docker, WSL, the
    scheduled tasks or the network.
#>

BeforeAll {
    $script:WatchdogPath = (Resolve-Path (Join-Path $PSScriptRoot '..\claudish-watchdog.ps1')).Path
}

Describe 'Invoke-LoopbackWedgeWatch (wiring)' {
    BeforeEach {
        # A fresh sandbox home per test: the watchdog writes its log and state
        # there, and a shared one would let a counter leak between cases.
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null

        # Dot-source INTO this scope with the sandbox home. The guard added for
        # this purpose makes the load a no-op beyond defining functions.
        . $script:WatchdogPath -ClaudishHome $script:SandboxHome

        # A probe answers per ADDRESS now, not per call: the discriminant is
        # the disagreement between families, so a stub that returns one boolean
        # for every address could not express a wedge at all.
        $script:WedgeProbe  = { param($u) $u -notmatch '\[::1\]' }   # v6 dead, v4/LAN alive
        $script:AllAlive    = { param($u) $true }
        $script:AllDead     = { param($u) $false }
        $script:Listening    = { param($p) $true }
        $script:NotListening = { param($p) $false }

        # AC5: every case below needs the watch enabled, since off-by-default is
        # the whole point of the gate. The gate's own test opts OUT explicitly.
        Set-Content -Path (Join-Path $script:SandboxHome (Get-ClaudishOptInFileName)) -Value 'enabled'
    }

    It 'stays silent and resets when the loopback is healthy' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $AllAlive `
            -ListenerProbe $Listening

        (Get-State).consecutiveWedge | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw -ErrorAction SilentlyContinue) |
            Should -Not -Match 'FORWARDER-WEDGE'
    }

    It 'arms on the first sighting, persists the counter, and does not act' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $WedgeProbe `
            -ListenerProbe $Listening

        (Get-State).consecutiveWedge | Should -Be 1
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'FORWARDER-WEDGE'
        $log | Should -Match '1/2'
    }

    It 'CORE GUARD: a confirmed wedge escalates and tells the operator NOT to restart' {
        # This is the 13:18 scenario end to end, and the terminal state is a
        # log line. 13 container restarts were attempted that day because
        # nothing told the operator they could not work; the escalation must.
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $WedgeProbe `
            -ListenerProbe $Listening
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $WedgeProbe `
            -ListenerProbe $Listening

        (Get-State).consecutiveWedge | Should -Be 2
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'FORWARDER-WEDGE ESCALATE'
        $log | Should -Match 'do NOT restart the container'
        $log | Should -Match 'host reboot'
    }

    It 'DISCRIMINANT: all families dead is reported as the hub, never as a wedge' {
        # The mirror-image failure. Calling this a wedge would tell the operator
        # not to restart during an ordinary outage, where a restart is the fix.
        Invoke-LoopbackWedgeWatch -ServingHealthy $false -HealthProbe $AllDead `
            -ListenerProbe $Listening
        Invoke-LoopbackWedgeWatch -ServingHealthy $false -HealthProbe $AllDead `
            -ListenerProbe $Listening

        (Get-State).consecutiveWedge | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw -ErrorAction SilentlyContinue) |
            Should -Not -Match 'FORWARDER-WEDGE'
    }

    It 'AC5: a machine that has not opted in is not probed at all' {
        # Not merely "takes no action": the gate is checked BEFORE the probes
        # run, so an opted-out machine is not even measured. The witness is the
        # probe itself — asserting only on the counter would pass just as well
        # with the gate moved after the probes.
        Remove-Item (Join-Path $SandboxHome (Get-ClaudishOptInFileName)) -Force
        $script:Probed = $false
        Invoke-LoopbackWedgeWatch -ServingHealthy $true `
            -HealthProbe { $script:Probed = $true; $false } `
            -ListenerProbe $Listening

        $script:Probed | Should -BeFalse

        # No state file is written at all on this path, so Get-State is $null —
        # reading the field through the accessor is what the watchdog itself
        # does, and asserting `(Get-State).consecutiveWedge -eq 0` would fail on
        # $null for the most correct possible behaviour.
        [int](Get-StateField (Get-State) 'consecutiveWedge' 0) | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw -ErrorAction SilentlyContinue) |
            Should -Not -Match 'FORWARDER-WEDGE'
    }

    It 'clears the counter once the loopback comes back' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $WedgeProbe `
            -ListenerProbe $Listening
        (Get-State).consecutiveWedge | Should -Be 1

        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $AllAlive `
            -ListenerProbe $Listening
        (Get-State).consecutiveWedge | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw) | Should -Match 'cleared'
    }

    It 'does nothing when no [::1] listener is visible (mirrored fail-safe)' {
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $WedgeProbe `
            -ListenerProbe $NotListening

        (Get-State).consecutiveWedge | Should -Be 0
    }

    It 'never throws, even when a probe does' {
        # It runs on the success path of a healthy cycle. A watchdog that turns
        # a healthy cycle into a crash is worse than one that misses a wedge.
        { Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe { throw 'boom' } `
            -ListenerProbe $Listening } | Should -Not -Throw
    }

    It 'REGRESSION: the wedge counter survives a hang-counter write' {
        # Set-State used to replace the whole state object with a single field,
        # so writing one counter erased the other and a confirmation counter
        # could never reach 2.
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe $WedgeProbe `
            -ListenerProbe $Listening
        Set-State -ConsecutiveHangs 0
        (Get-State).consecutiveWedge | Should -Be 1
    }
}

Describe 'Watchdog sandboxing' {
    It 'REGRESSION: -ClaudishHome redirects the LOG, not just the state file' {
        # Dot-sourcing claudish-drain.ps1 executes its param() defaults in this
        # scope, clobbering $ClaudishHome. Measured 2026-09-20: the state file
        # honoured the sandbox (computed before the dot-source) while two log
        # lines went to the PRODUCTION log (computed after) — a sandboxed run
        # that was not sandboxed, which is how a test lies about its blast radius.
        $sandbox = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $sandbox -Force | Out-Null

        . $script:WatchdogPath -ClaudishHome $sandbox
        Write-Log 'sandbox probe line'

        (Join-Path $sandbox 'watchdog.log') | Should -Exist
        (Get-Content (Join-Path $sandbox 'watchdog.log') -Raw) | Should -Match 'sandbox probe line'
        $LogPath | Should -BeLike "$sandbox*"
        $StateFile | Should -BeLike "$sandbox*"
    }
}

Describe 'Invoke-RelaunchPreflightWatch (wiring, #185)' {
    # The #181 execute probe was unreachable in production: its only call site
    # required the Docker Desktop GUI to be DOWN while the probe needs it UP.
    # The fix is to exercise the preflight during a HEALTHY cycle. These tests
    # pin the wiring around it: rate limit (AC2), the one-line verdict (AC1),
    # escalate-without-acting (AC4) and never-block-the-cycle (AC5).
    #
    # Note there is deliberately NO wedge opt-in file here: the preflight watch
    # has its OWN consent (`relaunch-preflight.enabled`, review of #188) and is
    # not gated on wedge-watch consent — the two gestures differ (HTTP GETs vs
    # registering a task and launching a process), so the consents must not.
    BeforeEach {
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null
        . $script:WatchdogPath -ClaudishHome $script:SandboxHome

        # Opted in by default for the measurement tests below; the gate's own
        # test removes the file explicitly.
        Set-Content -Path (Join-Path $script:SandboxHome (Get-RelaunchPreflightOptInFileName)) -Value 'enabled'

        # Stubs defined in BeforeEach, never in the Describe body: a function
        # or assignment there is invisible to It blocks (Pester 5/6 discovery).
        $script:Invoked = 0
        $script:OkPreflight = {
            $script:Invoked++
            [PSCustomObject]@{
                Ready  = $true
                Reason = 'relaunch path proven (registered, read back and executed)'
                Checks = @('executable:OK', 'user:OK', 'register:OK', 'verify:OK', 'execute:OK(result=0)')
            }
        }
        $script:FailPreflight = {
            $script:Invoked++
            [PSCustomObject]@{
                Ready  = $false
                Reason = "execute: task 'ClaudishEngineRelaunch' ran and its action failed (LastTaskResult=1)"
                Checks = @('executable:OK', 'user:OK', 'register:OK', 'verify:OK', 'execute:FAILED(result=1)')
            }
        }
    }

    It 'AC2b: a machine that has not opted in is not measured, counted or written to' {
        # The reviewer's asymmetry, made executable: the wedge watch gates BEFORE
        # its probes for HTTP GETs; this one registers a task and launches a
        # process, so it must not be the ungated one. The witness is the probe
        # itself — asserting only on the log would pass with the gate moved
        # after the call.
        Remove-Item (Join-Path $SandboxHome (Get-RelaunchPreflightOptInFileName)) -Force

        Invoke-RelaunchPreflightWatch -Preflight { $script:Invoked++; [PSCustomObject]@{ Ready = $true; Reason = 'x'; Checks = @('execute:OK(result=0)') } }

        $script:Invoked | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw -ErrorAction SilentlyContinue) |
            Should -Not -Match 'RELAUNCH-PREFLIGHT'
        # No state file at all on this path, so Get-State is $null — read through
        # the accessor the watchdog itself uses.
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') | Should -Be ''
    }

    It 'AC2b: the two consents are independent (wedge file does not arm the preflight)' {
        # A machine that armed the harmless HTTP-GET watch must not silently
        # inherit the task-registering one.
        Remove-Item (Join-Path $SandboxHome (Get-RelaunchPreflightOptInFileName)) -Force
        Set-Content -Path (Join-Path $SandboxHome (Get-ClaudishOptInFileName)) -Value 'enabled'

        Invoke-RelaunchPreflightWatch -Preflight { $script:Invoked++; [PSCustomObject]@{ Ready = $true; Reason = 'x'; Checks = @('execute:OK(result=0)') } }

        $script:Invoked | Should -Be 0
        # ...and the converse: the preflight file does not arm the wedge watch.
        Remove-Item (Join-Path $SandboxHome (Get-ClaudishOptInFileName)) -Force
        Set-Content -Path (Join-Path $SandboxHome (Get-RelaunchPreflightOptInFileName)) -Value 'enabled'
        Invoke-LoopbackWedgeWatch -ServingHealthy $true -HealthProbe { param($u) $false } -ListenerProbe { param($p) $true }
        [int](Get-StateField (Get-State) 'consecutiveWedge' 0) | Should -Be 0
    }

    It 'is inert when a verdict was already measured today (AC2: 1/day)' {
        Set-State -RelaunchProbeDate ([DateTime]::UtcNow.ToString('yyyy-MM-dd'))

        Invoke-RelaunchPreflightWatch -Preflight $script:OkPreflight

        $script:Invoked | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw -ErrorAction SilentlyContinue) |
            Should -Not -Match 'RELAUNCH-PREFLIGHT'
    }

    It 'measures once, logs ONE line with verdict and checks, and consumes the day (AC1+AC2)' {
        Invoke-RelaunchPreflightWatch -Preflight $script:OkPreflight

        $script:Invoked | Should -Be 1
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        ($log -split "`n" | Where-Object { $_ -match 'RELAUNCH-PREFLIGHT: (OK|FAILED)' }).Count |
            Should -Be 1 -Because 'AC1 asks for one line per probe, countable over time'
        $log | Should -Match 'RELAUNCH-PREFLIGHT: OK — relaunch path proven'
        $log | Should -Match 'checks=\[executable:OK, ?user:OK, ?register:OK, ?verify:OK, ?execute:OK\(result=0\)\]'
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') |
            Should -Be ([DateTime]::UtcNow.ToString('yyyy-MM-dd'))

        # Second call the same day must not re-measure: 96 probes/day is churn.
        Invoke-RelaunchPreflightWatch -Preflight $script:OkPreflight
        $script:Invoked | Should -Be 1
    }

    It 'AC4: a failing verdict escalates IN THE LOG, takes no action, consumes the day' {
        Invoke-RelaunchPreflightWatch -Preflight $script:FailPreflight

        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'RELAUNCH-PREFLIGHT: FAILED'
        $log | Should -Match 'RELAUNCH-PREFLIGHT ESCALATE'
        $log | Should -Match 'NO action taken'
        # The escalation is detection-only: the string 'restart' may appear only
        # negated ("NO action taken"), never as a command. The AST guard in
        # claudish-engine.Tests.ps1 pins the structural half.
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') |
            Should -Be ([DateTime]::UtcNow.ToString('yyyy-MM-dd')) -Because 'a failed probe escalated 96x/day would be noise'

        Invoke-RelaunchPreflightWatch -Preflight $script:FailPreflight
        $script:Invoked | Should -Be 1
    }

    It 'AC5: a throw degrades to "not measured", never blocks, and retries next cycle' {
        { Invoke-RelaunchPreflightWatch -Preflight { throw 'boom' } } | Should -Not -Throw

        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'RELAUNCH-PREFLIGHT: not measured this cycle'
        $log | Should -Not -Match 'ESCALATE' -Because '"not ready" would read as a fault (AC5)'
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') | Should -Be '' -Because 'an unmeasured attempt must not consume the day'

        # Day unconsumed -> the next cycle retries and can succeed.
        Invoke-RelaunchPreflightWatch -Preflight $script:OkPreflight
        $script:Invoked | Should -Be 1
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw) | Should -Match 'RELAUNCH-PREFLIGHT: OK'
    }

    It 'AC5: a preflight returning no verdict is "not measured", not a fabricated failure' {
        Invoke-RelaunchPreflightWatch -Preflight { $null }

        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'not measured this cycle'
        $log | Should -Not -Match 'ESCALATE'
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') | Should -Be ''
    }

    It '#205 AC3: a gui-running SKIP logs its own line and does NOT consume the day' {
        $skipped = {
            [PSCustomObject]@{
                Ready   = $true
                Skipped = $true
                Reason  = 'relaunch path not re-proven (Docker Desktop GUI is running — an invocation would single-instance-forward and exercise nothing: no fresh exercise performed)'
                Checks  = @('executable:OK', 'user:OK', 'register:OK', 'verify:OK', 'execute:SKIPPED(gui-running)')
            }
        }
        Invoke-RelaunchPreflightWatch -Preflight $skipped

        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'RELAUNCH-PREFLIGHT: SKIPPED \(gui-running\)'
        $log | Should -Match 'no fresh exercise performed'
        $log | Should -Match 'day NOT consumed'
        $log | Should -Not -Match 'RELAUNCH-PREFLIGHT: OK' -Because 'a skip is neither a success claim nor routed through the OK line'
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') |
            Should -Be '' -Because 'on a GUI-autostart machine a consuming skip would certify a daily probe that never measured anything'

        # The behavioural half of AC3: the day being unconsumed means the very
        # next cycle can still measure. Skip-then-measure in one day works.
        Invoke-RelaunchPreflightWatch -Preflight $script:OkPreflight
        $script:Invoked | Should -Be 1
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw) | Should -Match 'RELAUNCH-PREFLIGHT: OK'
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') |
            Should -Be ([DateTime]::UtcNow.ToString('yyyy-MM-dd'))
    }

    It '#199 pin kept: SKIPPED(already-running) WITHOUT the Skipped property is still measured and consumes the day' {
        # The no-consume rule is scoped to the gui-running skip by the #205
        # arbitration. The already-running variant is a measured observation of
        # scheduler state (the refusal was real, the state read was real), so
        # it keeps consuming — and this pin keeps a future refactor from
        # widening the free-skip to every Ready verdict.
        $alreadyRunning = {
            [PSCustomObject]@{
                Ready  = $true
                Reason = "relaunch path proven (registration-only — task 'x' is already running, so the second start was refused with 0x800710E0: no fresh exercise performed)"
                Checks = @('executable:OK', 'user:OK', 'register:OK', 'verify:OK', 'execute:SKIPPED(already-running)')
            }
        }
        Invoke-RelaunchPreflightWatch -Preflight $alreadyRunning

        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'RELAUNCH-PREFLIGHT: OK'
        [string](Get-StateField (Get-State) 'relaunchProbeDate' '') |
            Should -Be ([DateTime]::UtcNow.ToString('yyyy-MM-dd'))
    }

    It 'wiring: the healthy branch calls the preflight watch right after the wedge watch' {
        # The healthy branch is the ONLY place the execute probe can run (it
        # needs the GUI up). This pins the call site so a refactor cannot
        # silently move it back behind a GUI-down guard. Anchored on the call
        # being followed by `exit 0`, because the function name also appears in
        # the comment right above it.
        $src = Get-Content $script:WatchdogPath -Raw
        $src | Should -Match ('Invoke-LoopbackWedgeWatch -ServingHealthy \$true' +
            '[\s\S]{0,400}?Invoke-RelaunchPreflightWatch\s*\r?\n\s*exit 0')
    }
}
