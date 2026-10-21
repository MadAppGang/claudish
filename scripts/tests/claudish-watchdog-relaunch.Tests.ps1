<#
    Gap 3 of jsboige/claudish#530: prove the engine-recovery relaunch path in
    tests, not on the day it is needed.

    Start-DockerEngine is the glue that decides, on engine-down, whether a
    Docker Desktop relaunch can be requested: engine probe -> service start ->
    GUI-presence check -> Test-EngineRelaunchReady -> Start-ScheduledTask ->
    bounded 12x10s recovery wait -> FATAL. Until the seam existed, none of
    this was executable anywhere but a production hub with a dead engine —
    the one situation where nobody wants to discover a wiring bug (the class
    of the 2026-08-29 relaunch that never worked and was only found when a
    human had to reboot a second time).

    The library suite (claudish-engine.Tests.ps1) already proves
    Test-EngineRelaunchReady in isolation and Invoke-RelaunchPreflightWatch's
    wiring in claudish-watchdog-wedge.Tests.ps1. This file pins the missing
    half: the watchdog's own recovery decision table.

    Every probe and actuator is injected, so nothing here touches Docker, the
    service manager, the task scheduler or any process. The recovery wait
    ticks a no-op, so no test sleeps real seconds. The watchdog is
    dot-sourced with a sandbox -ClaudishHome, and every case asserts on the
    SANDBOX log path — a sandboxed run that logs to production is lying about
    its blast radius (measured 2026-09-20, the drain dot-source lesson).
#>

BeforeAll {
    $script:WatchdogPath = (Resolve-Path (Join-Path $PSScriptRoot '..\claudish-watchdog.ps1')).Path
}

Describe 'Start-DockerEngine (wiring, #530 gap 3)' {
    BeforeEach {
        # Fresh sandbox home per test: the watchdog writes its log there, and
        # asserting on that path is what makes the sandbox claim true.
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null

        . $script:WatchdogPath -ClaudishHome $script:SandboxHome

        # Spies shared by the injected probes. Script-scoped because the probes
        # execute inside Start-DockerEngine, which was dot-sourced into this
        # same script scope.
        $script:Spies = @{
            EngineCalls  = 0
            ServiceStart = 0
            GuiCalls     = 0
            ReadyCalls   = 0
            TaskNames    = [System.Collections.Generic.List[string]]::new()
            Ticks        = 0
        }
        $script:EngineAlwaysUp    = { $script:Spies.EngineCalls++; $true }
        $script:EngineAlwaysDown  = { $script:Spies.EngineCalls++; $false }
        # Up from the Nth call on: call 1 = entry probe, then one per tick.
        $script:EngineUpAtCall4   = { $script:Spies.EngineCalls++; ($script:Spies.EngineCalls -ge 4) }
        $script:ServiceSpy        = { $script:Spies.ServiceStart++ }
        $script:GuiAbsent         = { $script:Spies.GuiCalls++; $null }
        $script:GuiPresent        = { $script:Spies.GuiCalls++; [PSCustomObject]@{ Name = 'Docker Desktop' } }
        $script:ReadyOk           = {
            $script:Spies.ReadyCalls++
            [PSCustomObject]@{ Ready = $true; Reason = 'all stages proven'; Checks = @('executable:OK', 'register:OK', 'verify:OK', 'execute:OK(result=0)') }
        }
        $script:ReadyNo           = {
            $script:Spies.ReadyCalls++
            [PSCustomObject]@{ Ready = $false; Reason = 'verify: task not readable'; Checks = @('executable:OK', 'register:OK') }
        }
        $script:TaskSpy           = { param($n) $script:Spies.TaskNames.Add($n) }
        $script:TaskThrows        = { param($n) throw 'rpc down' }
        $script:NoOpTick          = { $script:Spies.Ticks++ }
    }

    It 'fast path: engine already up returns immediately with zero recovery actions' {
        $r = Start-DockerEngine -EngineProbe $EngineAlwaysUp

        $r | Should -BeTrue
        $script:Spies.EngineCalls | Should -Be 1
        $script:Spies.ServiceStart | Should -Be 0
        $script:Spies.TaskNames.Count | Should -Be 0
        (Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw -ErrorAction SilentlyContinue) |
            Should -Not -Match 'ENGINE-DOWN'
    }

    It 'GUI ABSENT + relaunch ready: requests the ClaudishDockerDesktopStart task exactly once (the path that never worked until 2026-09-20)' {
        $r = Start-DockerEngine -EngineProbe $EngineUpAtCall4 -ServiceStarter $ServiceSpy `
            -GuiProcessProbe $GuiAbsent -RelaunchReady $ReadyOk -TaskStarter $TaskSpy -RecoveryTick $NoOpTick

        $r | Should -BeTrue
        $script:Spies.TaskNames.Count | Should -Be 1
        $script:Spies.TaskNames[0] | Should -Be 'ClaudishDockerDesktopStart'
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'ENGINE-DOWN'
        $log | Should -Match 'ENGINE: Docker Desktop launch requested in user session \(relaunch path proven'
        # Recovered on the 3rd wait iteration: entry probe = call 1, then one
        # call per tick — up at call 4, i.e. after 3 ticks (i=3 -> "30s").
        $log | Should -Match 'ENGINE: recovered after 30s'
        (Join-Path $SandboxHome 'watchdog.log') | Should -Exist
        $LogPath | Should -BeLike "$SandboxHome*"
    }

    It 'GUI PRESENT: never consults relaunch readiness, never requests a task — recovery waits it out' {
        # The GUI being up means the relaunch task would be a useless
        # single-instance forward (#205) — the branch must not even measure.
        # The witness is the probe itself: asserting only on the log would
        # pass with the check moved after the ready probe.
        $r = Start-DockerEngine -EngineProbe $EngineUpAtCall4 -ServiceStarter $ServiceSpy `
            -GuiProcessProbe $GuiPresent -RelaunchReady $ReadyOk -TaskStarter $TaskSpy -RecoveryTick $NoOpTick

        $r | Should -BeTrue
        $script:Spies.GuiCalls | Should -Be 1
        $script:Spies.ReadyCalls | Should -Be 0
        $script:Spies.TaskNames.Count | Should -Be 0
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'ENGINE: recovered after'
        $log | Should -Not -Match 'launch requested'
    }

    It 'relaunch NOT proven: names the broken stage, requests no task, still runs the bounded wait' {
        $r = Start-DockerEngine -EngineProbe $EngineUpAtCall4 -ServiceStarter $ServiceSpy `
            -GuiProcessProbe $GuiAbsent -RelaunchReady $ReadyNo -TaskStarter $TaskSpy -RecoveryTick $NoOpTick

        $r | Should -BeTrue
        $script:Spies.TaskNames.Count | Should -Be 0
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'relaunch path NOT proven \(verify: task not readable\)'
    }

    It 'a task start that throws is caught and logged, never escapes the recovery path' {
        { Start-DockerEngine -EngineProbe $EngineUpAtCall4 -ServiceStarter $ServiceSpy `
            -GuiProcessProbe $GuiAbsent -RelaunchReady $ReadyOk -TaskStarter $TaskThrows -RecoveryTick $NoOpTick } |
            Should -Not -Throw

        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'relaunch task proven but would not start \(rpc down\)'
    }

    It 'bounded wait: engine never answering costs exactly 12 ticks, then FATAL-$false — never an infinite hang' {
        $r = Start-DockerEngine -EngineProbe $EngineAlwaysDown -ServiceStarter $ServiceSpy `
            -GuiProcessProbe $GuiAbsent -RelaunchReady $ReadyOk -TaskStarter $TaskSpy -RecoveryTick $NoOpTick

        $r | Should -BeFalse
        $script:Spies.Ticks | Should -Be 12
        $script:Spies.TaskNames.Count | Should -Be 1
        $log = Get-Content (Join-Path $SandboxHome 'watchdog.log') -Raw
        $log | Should -Match 'ENGINE: still down after 120s — FATAL this cycle'
    }
}

Describe 'Start-DockerEngine (defaults stay live)' {
    It 'every seam falls back to the real call — the injection must not hollow out production' {
        # Without this, deleting a fallback would leave every wiring test green
        # and production calling a $null scriptblock. The positive control is
        # the parse itself: the function must exist and contain the live
        # commands in its fallback assignments. Each assertion is anchored on
        # ITS OWN assignment ($Var = { live command }), never on the whole
        # function text: a comment naming a seam (the watchdog's line-751
        # note names Test-EngineRelaunchReady) satisfied the old whole-source
        # match while the fallback line was deleted or hollowed (review
        # mutants M1/M2, 2026-10-19) — an assignment-shaped pattern cannot be
        # satisfied by a comment.
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:WatchdogPath, [ref]$tokens, [ref]$errs)

        $fn = $ast.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Name -eq 'Start-DockerEngine'
        }, $true) | Select-Object -First 1

        $fn | Should -Not -BeNullOrEmpty -Because 'the guard must have something to guard'
        $fn.Extent.Text | Should -Match '\$EngineProbe\s*=\s*\{\s*Test-DockerEngine\s*\}'
        $fn.Extent.Text | Should -Match '\$ServiceStarter\s*=\s*\{\s*try\s*\{\s*Start-Service\s+com\.docker\.service'
        $fn.Extent.Text | Should -Match '\$GuiProcessProbe\s*=\s*\{\s*Get-Process\s+"Docker Desktop"'
        $fn.Extent.Text | Should -Match '\$RelaunchReady\s*=\s*\{\s*Test-EngineRelaunchReady\s*\}'
        $fn.Extent.Text | Should -Match '\$TaskStarter\s*=\s*\{\s*param\(\$n\)\s*Start-ScheduledTask\s+-TaskName\s+\$n'
        $fn.Extent.Text | Should -Match '\$RecoveryTick\s*=\s*\{\s*Start-Sleep\s+-Seconds\s+10\s*\}'
    }
}

Describe 'Invoke-EngineZombieWatch (wiring, #530 gap 1)' {
    # The zombie-GUI watch: engine down while the Docker Desktop GUI process
    # is PRESENT, persisting across cycles. Detection default-on; the kill
    # behind its own consent file. The streak persists ACROSS cycles through
    # the state file — each It replays consecutive cycles by calling the watch
    # repeatedly in one sandbox, exactly what the 15-minute task does over
    # 45 minutes.
    BeforeEach {
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null

        . $script:WatchdogPath -ClaudishHome $script:SandboxHome

        $script:Spies = @{
            EngineCalls = 0
            GuiCalls    = 0
            Kills       = 0
        }
        $script:EngineUpSpy   = { $script:Spies.EngineCalls++; $true }
        $script:EngineDownSpy = { $script:Spies.EngineCalls++; $false }
        $script:GuiAbsentSpy  = { $script:Spies.GuiCalls++; $null }
        $script:GuiPresentSpy = { $script:Spies.GuiCalls++; [PSCustomObject]@{ Name = 'Docker Desktop' } }
        $script:KillSpy       = { $script:Spies.Kills++ }
        $script:KillThrows    = { throw 'access denied' }

        $script:LogPath     = Join-Path $SandboxHome 'watchdog.log'
        $script:StatePath   = Join-Path $SandboxHome 'watchdog-state.json'
        $script:ConsentPath = Join-Path $SandboxHome 'gui-zombie-kill.enabled'
    }

    It 'healthy cycle: one engine probe, streak reset to 0, no marker, no kill' {
        Invoke-EngineZombieWatch -EngineProbe $EngineUpSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy

        $script:Spies.EngineCalls | Should -Be 1
        $script:Spies.Kills | Should -Be 0
        # A no-op cycle writes no log line at all — the file may not exist, and
        # "no marker" must hold either way (no log file IS no marker).
        $log = Get-Content $LogPath -Raw -ErrorAction SilentlyContinue
        if (-not $log) { $log = '' }
        $log | Should -Not -Match 'zombie'
        (Get-Content $StatePath -Raw | ConvertFrom-Json).consecutiveGuiZombie | Should -Be 0
    }

    It 'engine down, GUI ABSENT: the relaunch path owns it — no count, no marker, no kill' {
        Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiAbsentSpy -GuiKiller $KillSpy

        $script:Spies.Kills | Should -Be 0
        $log = Get-Content $LogPath -Raw -ErrorAction SilentlyContinue
        if (-not $log) { $log = '' }
        $log | Should -Not -Match 'zombie'
        (Get-Content $StatePath -Raw | ConvertFrom-Json).consecutiveGuiZombie | Should -Be 0
    }

    It 'design matrix 3 — streak reaches the threshold with NO consent: marker + ESCALATE fire, ZERO kills' {
        1..2 | ForEach-Object {
            Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy
        }
        $log = Get-Content $LogPath -Raw
        $log | Should -Match 'ENGINE-ZOMBIE: engine down with GUI present \(1/3\)'
        $log | Should -Not -Match 'GUI zombie suspected'

        Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy

        $log = Get-Content $LogPath -Raw
        $log | Should -Match 'ENGINE: GUI zombie suspected \(streak=3\)'
        $log | Should -Match 'GUI zombie ESCALATE'
        $script:Spies.Kills | Should -Be 0
        (Get-Content $StatePath -Raw | ConvertFrom-Json).consecutiveGuiZombie | Should -Be 3
    }

    It 'design matrix 4 — threshold WITH consent: exactly ONE kill of the GUI, never the service' {
        1..2 | ForEach-Object {
            Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy
        }
        Set-Content -Path $ConsentPath -Value 'enabled' -NoNewline

        Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy

        $script:Spies.Kills | Should -Be 1
        $log = Get-Content $LogPath -Raw
        $log | Should -Match 'GUI zombie kill requested \(consent gui-zombie-kill\.enabled\)'
    }

    It 'wrong token in the consent file does NOT arm the kill — detection stands, hand stays off' {
        1..2 | ForEach-Object {
            Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy
        }
        Set-Content -Path $ConsentPath -Value 'yes please' -NoNewline

        Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy

        $log = Get-Content $LogPath -Raw
        $log | Should -Match 'GUI zombie suspected \(streak=3\)'
        $script:Spies.Kills | Should -Be 0
    }

    It 'reset on healthy: a zombie streak does not survive the engine coming back' {
        1..2 | ForEach-Object {
            Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy
        }
        Invoke-EngineZombieWatch -EngineProbe $EngineUpSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy
        (Get-Content $StatePath -Raw | ConvertFrom-Json).consecutiveGuiZombie | Should -Be 0

        # The next sighting starts over at 1 — the threshold is not inherited
        # across a recovery, or one transient + one real outage would escalate.
        Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy
        (Get-Content $LogPath -Raw) | Should -Match '\(1/3\)'
        $script:Spies.Kills | Should -Be 0
    }

    It 'a probe that throws is swallowed and logged — the watch can never kill the cycle' {
        { Invoke-EngineZombieWatch -EngineProbe { throw 'wmi broken' } -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy } |
            Should -Not -Throw

        (Get-Content $LogPath -Raw) | Should -Match 'ENGINE-ZOMBIE-WATCH: internal error, ignored \(wmi broken\)'
    }

    It 'a kill that throws is caught and logged — detection stands, no further action' {
        1..2 | ForEach-Object {
            Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillSpy
        }
        Set-Content -Path $ConsentPath -Value 'enabled' -NoNewline

        { Invoke-EngineZombieWatch -EngineProbe $EngineDownSpy -GuiProcessProbe $GuiPresentSpy -GuiKiller $KillThrows } |
            Should -Not -Throw

        (Get-Content $LogPath -Raw) | Should -Match 'GUI zombie kill failed \(access denied\)'
    }

    It 'defaults stay live: the seams fall back to the real engine probe, process probe and GUI kill' {
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:WatchdogPath, [ref]$tokens, [ref]$errs)

        $fn = $ast.FindAll({
            param($n)
            $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $n.Name -eq 'Invoke-EngineZombieWatch'
        }, $true) | Select-Object -First 1

        $fn | Should -Not -BeNullOrEmpty -Because 'the guard must have something to guard'
        $fn.Extent.Text | Should -Match 'Test-DockerEngine'
        $fn.Extent.Text | Should -Match 'Get-Process\s+"Docker Desktop"'
        $fn.Extent.Text | Should -Match 'Stop-Process\s+-Name\s+"Docker Desktop"'
    }
}
