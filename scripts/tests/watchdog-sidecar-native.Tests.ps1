<#
    Tests for watchdog-sidecar-native.ps1 (the process-native sidecar watchdog).

    Two layers, same split as the fleet watchdog:
      - the DECISION table (pure): what to do given (alive, healthy, counter);
      - the WIRING: that a full tick reads state, calls the right injected probes,
        logs, persists the counter, starts the launcher only when the decision
        says so, kills only on the confirmed-zombie path — and never touches a
        real process, port or scheduled task (everything side-effectful is a
        stub with a witness flag).
#>

BeforeAll {
    $script:WatchdogPath = (Resolve-Path (Join-Path $PSScriptRoot '..\watchdog-sidecar-native.ps1')).Path
}

Describe 'Get-NativeWatchdogDecision (decision table)' {
    BeforeAll {
        . $script:WatchdogPath -ClaudishHome $env:TEMP   # load functions only (dot-source guard)
    }

    It 'ABSENT process -> start immediately (nothing to drain, nothing to confirm)' {
        Get-NativeWatchdogDecision -ProcessAlive $false -HealthOk $false -ConsecutiveUnhealthy 0 -KillThreshold 3 |
            Should -Be 'start'
    }

    It 'absent outranks a stale healthy reading' {
        Get-NativeWatchdogDecision -ProcessAlive $false -HealthOk $true -ConsecutiveUnhealthy 2 -KillThreshold 3 |
            Should -Be 'start'
    }

    It 'alive + healthy -> ok' {
        Get-NativeWatchdogDecision -ProcessAlive $true -HealthOk $true -ConsecutiveUnhealthy 5 -KillThreshold 3 |
            Should -Be 'ok'
    }

    It 'first KO tick -> warn, no kill (may be booting)' {
        Get-NativeWatchdogDecision -ProcessAlive $true -HealthOk $false -ConsecutiveUnhealthy 0 -KillThreshold 3 |
            Should -Be 'warn'
    }

    It 'KO tick below threshold -> warn' {
        Get-NativeWatchdogDecision -ProcessAlive $true -HealthOk $false -ConsecutiveUnhealthy 1 -KillThreshold 3 |
            Should -Be 'warn'
    }

    It 'KO tick reaching threshold -> kill-restart (counter is pre-increment: 2 stored + 1 = 3)' {
        Get-NativeWatchdogDecision -ProcessAlive $true -HealthOk $false -ConsecutiveUnhealthy 2 -KillThreshold 3 |
            Should -Be 'kill-restart'
    }

    It 'threshold 1 kills on the first KO tick (operator opted into hair-trigger)' {
        Get-NativeWatchdogDecision -ProcessAlive $true -HealthOk $false -ConsecutiveUnhealthy 0 -KillThreshold 1 |
            Should -Be 'kill-restart'
    }
}

Describe 'Invoke-NativeWatchdogCycle (wiring)' {
    BeforeEach {
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null
        . $script:WatchdogPath -ClaudishHome $script:SandboxHome

        # Fake process rows shaped like Win32_Process (ProcessId + CommandLine).
        $script:FakeProcs = ,([PSCustomObject]@{ ProcessId = 4242; CommandLine = "bun packages/cli/src/fork/server/standalone-proxy.ts --port 3914 --host 127.0.0.1" })
        $script:Started   = $false
        $script:Killed    = $false
        $script:Launcher  = { param($lp) $script:Started = $true; $true }
        $script:Killer    = { param($procs) $script:Killed = $true }
    }

    It 'nominal tick: logs OK, resets the counter, no action' {
        $rc = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) $script:FakeProcs } -HealthProbe { param($p, $t) $true } `
            -LauncherAction $Launcher -KillAction $Killer -StartWaitSec 2

        $rc | Should -Be 0
        $script:Started | Should -BeFalse
        $script:Killed | Should -BeFalse
        (Get-WatchdogState).consecutiveUnhealthy | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog-sidecar.log') -Raw) | Should -Match 'OK \(pid=4242'
    }

    It 'isolated KO: warns, persists counter 1, kills nothing' {
        $rc = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) $script:FakeProcs } -HealthProbe { param($p, $t) $false } `
            -LauncherAction $Launcher -KillAction $Killer -StartWaitSec 2

        $rc | Should -Be 0
        $script:Started | Should -BeFalse
        $script:Killed | Should -BeFalse
        (Get-WatchdogState).consecutiveUnhealthy | Should -Be 1
        (Get-Content (Join-Path $SandboxHome 'watchdog-sidecar.log') -Raw) | Should -Match 'UNHEALTHY 1/3'
    }

    It 'process ABSENT: starts the launcher, confirms health, exit 0' {
        $rc = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) @() } -HealthProbe { param($p, $t) $true } `
            -LauncherAction $Launcher -KillAction $Killer -StartWaitSec 2

        $rc | Should -Be 0
        $script:Started | Should -BeTrue
        $script:Killed | Should -BeFalse
        (Get-Content (Join-Path $SandboxHome 'watchdog-sidecar.log') -Raw) | Should -Match 'RECOVERED'
    }

    It 'process ABSENT and never comes up: FATAL, exit 1 (next tick retries)' {
        $rc = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) @() } -HealthProbe { param($p, $t) $false } `
            -LauncherAction $Launcher -KillAction $Killer -StartWaitSec 2

        $rc | Should -Be 1
        $script:Started | Should -BeTrue
        $log = Get-Content (Join-Path $SandboxHome 'watchdog-sidecar.log') -Raw
        $log | Should -Match 'CRITICAL: no process'
        $log | Should -Match 'FATAL: sidecar not healthy'
    }

    It 'confirmed zombie (KO x3): kills FIRST, then starts, resets counter' {
        Set-WatchdogState -ConsecutiveUnhealthy 2
        $script:Order = @()
        # The probe models the real sequence: the zombie does not answer (first
        # call, pre-decision), the restarted sidecar does (post-start check).
        # A constantly-true probe would make the decision 'ok' and exercise
        # nothing — the mistake this toggle exists to prevent.
        $script:HealthCalls = 0
        $rc = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) $script:FakeProcs } `
            -HealthProbe { param($p, $t) $script:HealthCalls++; if ($script:HealthCalls -le 1) { $false } else { $true } } `
            -LauncherAction { param($lp) $script:Order += 'start'; $true } `
            -KillAction     { param($procs) $script:Order += 'kill' } `
            -StartWaitSec 2

        $rc | Should -Be 0
        # Kill precedes start: launching the launcher while the zombie holds the
        # port would spawn a bun that dies on EADDRINUSE and a launcher that
        # outlives it — the double-bun failure this threshold exists to avoid.
        $script:Order[0] | Should -Be 'kill'
        $script:Order[1] | Should -Be 'start'
        (Get-WatchdogState).consecutiveUnhealthy | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog-sidecar.log') -Raw) | Should -Match 'ZOMBIE CONFIRMED 3/3'
    }

    It 'a healthy tick after warnings resets the counter (fresh episode)' {
        Set-WatchdogState -ConsecutiveUnhealthy 2
        $null = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) $script:FakeProcs } -HealthProbe { param($p, $t) $true } `
            -LauncherAction $Launcher -KillAction $Killer -StartWaitSec 2
        (Get-WatchdogState).consecutiveUnhealthy | Should -Be 0
    }

    It 'missing launcher: FATAL before any start attempt, exit 1' {
        $rc = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) @() } -HealthProbe { param($p, $t) $true } `
            -LauncherAction { param($lp) Start-SidecarDetached -Path $lp } `
            -KillAction $Killer -StartWaitSec 2

        $rc | Should -Be 1
        (Get-Content (Join-Path $SandboxHome 'watchdog-sidecar.log') -Raw) | Should -Match 'FATAL: launcher not found'
    }

    It 'log carries no BOM (5.1 Add-Content trap — first bytes must not be EF BB BF)' {
        $null = Invoke-NativeWatchdogCycle -Port 3914 -LauncherPath 'x:\nowhere.ps1' `
            -ProcessProbe { param($p) $script:FakeProcs } -HealthProbe { param($p, $t) $true } `
            -LauncherAction $Launcher -KillAction $Killer -StartWaitSec 2

        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $SandboxHome 'watchdog-sidecar.log'))
        if ($bytes.Length -ge 3) {
            ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) | Should -BeFalse
        }
    }
}

Describe 'Get-SidecarProcesses (identity: bun.exe + live pid + pattern)' {
    BeforeAll {
        . $script:WatchdogPath -ClaudishHome $env:TEMP
    }

    It 'returns the real sidecar row (bun.exe, pid, pattern, port)' {
        $rows = @(
            [PSCustomObject]@{ ProcessId = 7; Name = 'bun.exe'; CommandLine = "bun packages/cli/src/fork/server/standalone-proxy.ts --port 3914 --host 127.0.0.1" }
        )
        $hit = @(Get-SidecarProcesses -Port 3914 -Processes $rows)
        $hit.Count | Should -Be 1
        $hit[0].ProcessId | Should -Be 7
    }

    It 'REGRESSION (kill-test 27/09): an EMPTY result is 0 processes, not one phantom' {
        # `return ,@()` emits the empty array AS AN OBJECT: the caller's @(...)
        # then counts 1 "process" with a $null ProcessId and the watchdog
        # believes the sidecar is alive while it is dead. This is the measured
        # cause of the kill-test FAIL (log line "(pid=)").
        @(Get-SidecarProcesses -Port 3914 -Processes @()).Count | Should -Be 0
    }

    It 'REGRESSION (kill-test 27/09): a non-bun process carrying the pattern in its command line is NOT the sidecar' {
        # The production failure: a transient process (git show / diagnostic
        # one-liner) matched the command-line pattern while the sidecar lay
        # dead — the watchdog read "alive" and never started the launcher.
        $rows = @(
            [PSCustomObject]@{ ProcessId = 11; Name = 'git.exe'; CommandLine = "git show origin/main:scripts/standalone-proxy.ts --port 3914" },
            [PSCustomObject]@{ ProcessId = 12; Name = 'powershell.exe'; CommandLine = "powershell -Command Get-CimInstance ... -match 'standalone-proxy.ts.*--port 3914'" }
        )
        @(Get-SidecarProcesses -Port 3914 -Processes $rows).Count | Should -Be 0
    }

    It 'a row with an unreadable ProcessId is rejected even if it is a bun with the pattern' {
        # The kill-test log showed "(pid=)" — a matched row whose ProcessId
        # would not read back. An unreadable pid cannot be killed, reported or
        # trusted; it must not make the sidecar look alive.
        $rows = @(
            [PSCustomObject]@{ ProcessId = $null; Name = 'bun.exe'; CommandLine = "bun standalone-proxy.ts --port 3914" },
            [PSCustomObject]@{ ProcessId = 0; Name = 'bun.exe'; CommandLine = "bun standalone-proxy.ts --port 3914" }
        )
        @(Get-SidecarProcesses -Port 3914 -Processes $rows).Count | Should -Be 0
    }

    It 'matches standalone-proxy on the exact port, not any bun' {
        $rows = @(
            [PSCustomObject]@{ ProcessId = 1; Name = 'bun.exe'; CommandLine = "bun packages/cli/src/fork/server/standalone-proxy.ts --port 3914 --host 127.0.0.1" },
            [PSCustomObject]@{ ProcessId = 2; Name = 'bun.exe'; CommandLine = "bun packages/cli/src/fork/server/standalone-proxy.ts --port 3915 --host 127.0.0.1" },
            [PSCustomObject]@{ ProcessId = 3; Name = 'bun.exe'; CommandLine = "bun run dev" },
            [PSCustomObject]@{ ProcessId = 4; Name = 'bun.exe'; CommandLine = $null }
        )
        $hit = @(Get-SidecarProcesses -Port 3914 -Processes $rows)
        $hit.Count | Should -Be 1
        $hit[0].ProcessId | Should -Be 1
    }
}
