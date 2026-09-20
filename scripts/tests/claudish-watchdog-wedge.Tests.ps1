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
