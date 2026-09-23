<#
    Pester 5 suite for claudish-drain.ps1 (#233).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    2026-09-23, hub: a `docker compose up` that failed or was interrupted left
    the old container STOPPED with no rename/start ever issued — two gaps
    (16 min + 11 min), fleet-wide AUTONOMOUS episodes, recovery by watchdog
    or by hand. The wrapper returned $false having stopped the hub itself.
    #233 adds: rollback start on compose failure (AC1), a leftover-twin
    preflight refuse (AC2), a terminal OUTCOME line on every exit plus
    PREVIOUS RUN INTERRUPTED detection (AC3).

    HOW THE DOCKER SHIM WORKS
    -------------------------
    A throwaway docker.cmd is prepended to PATH for the lifetime of this
    suite. Every invocation appends its arguments to docker-calls.log — that
    log IS the assertion surface for "zero stop calls" (a stop happens inside
    `compose`, so asserting no compose invocation asserts nothing was
    stopped). Responses are driven by fixture files in the shim dir:
      ps_out.txt        lines "name state" returned by `docker ps -a` (SPACE
                        separator: PowerShell does not quote a "|" argument
                        handed to a .cmd shim, and cmd re-parses it as a
                        pipe operator — the script's --format avoids "|" for
                        exactly that reason)
      inspect_out.txt   returned by every `docker inspect` (armed-env guard,
                        rollback State.Running probe — the tests choose values
                        that keep the two uses consistent)
      compose_exit.txt  exit code for `docker compose` (absent = 0)
    The batch file uses labels instead of parenthesized blocks: `exit /b %CE%`
    inside an `if (...)` block would expand %CE% BEFORE `set /p` runs (classic
    delayed-expansion trap).
#>

BeforeAll {
    $script:ScriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:DrainScript = Join-Path $script:ScriptsRoot 'claudish-drain.ps1'

    $script:TestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("claudish-drain-tests-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:TestDir -Force | Out-Null
    $script:ShimDir = Join-Path $script:TestDir 'shim'
    New-Item -ItemType Directory -Path $script:ShimDir -Force | Out-Null
    $script:TestLog = Join-Path $script:TestDir 'drain.log'
    $script:CallsLog = Join-Path $script:TestDir 'docker-calls.log'
    $script:EnvFile = Join-Path $script:TestDir 'test.env'
    [System.IO.File]::WriteAllText($script:EnvFile, "CLAUDISH_FAILOVER_SONNET=example@model`n", (New-Object System.Text.UTF8Encoding($false)))

    $shim = @'
@echo off
if "%SHIM_LOG%"=="" exit /b 1
echo %* >> "%SHIM_LOG%"
if "%1"=="ps" goto :ps
if "%1"=="inspect" goto :inspect
if "%1"=="start" goto :start
if "%1"=="rm" goto :rm
if "%1"=="compose" goto :compose
exit /b 0

:ps
if exist "%SHIM_DIR%\ps_out.txt" type "%SHIM_DIR%\ps_out.txt"
exit /b 0

:inspect
if exist "%SHIM_DIR%\inspect_out.txt" (type "%SHIM_DIR%\inspect_out.txt") else (echo true)
exit /b 0

:start
if not exist "%SHIM_DIR%\start_exit.txt" exit /b 0
set /p SE=<"%SHIM_DIR%\start_exit.txt"
exit /b %SE%

:rm
exit /b 0

:compose
echo compose-stopping-old-container >> "%SHIM_LOG%"
if not exist "%SHIM_DIR%\compose_exit.txt" exit /b 0
set /p CE=<"%SHIM_DIR%\compose_exit.txt"
exit /b %CE%
'@
    [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'docker.cmd'), $shim, (New-Object System.Text.ASCIIEncoding))

    $env:SHIM_DIR = $script:ShimDir
    $env:SHIM_LOG = $script:CallsLog
    $script:OldPath = $env:Path
    $env:Path = "$script:ShimDir;$env:Path"

    # Dot-source defines the functions only (standalone guard sees '.').
    # The script's param() then runs here with defaults — reassign the ones
    # the functions resolve dynamically so the suite never touches the real
    # ~/.claudish (same clobber the watchdog saves/restores around).
    . $script:DrainScript
    $LogPath = $script:TestLog

    function Reset-DrainFixture {
        Remove-Item -LiteralPath $script:CallsLog -Force -ErrorAction SilentlyContinue
        foreach ($f in 'ps_out.txt', 'inspect_out.txt', 'compose_exit.txt', 'start_exit.txt') {
            Remove-Item -LiteralPath (Join-Path $script:ShimDir $f) -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $script:TestLog -Force -ErrorAction SilentlyContinue
    }

    function Get-DrainLogText {
        if (Test-Path -LiteralPath $script:TestLog) { return (Get-Content -LiteralPath $script:TestLog) -join "`n" }
        return ''
    }

    function Get-CallsText {
        if (Test-Path -LiteralPath $script:CallsLog) { return (Get-Content -LiteralPath $script:CallsLog) -join "`n" }
        return ''
    }
}

AfterAll {
    $env:Path = $script:OldPath
    Remove-Item -LiteralPath $script:TestDir -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Invoke-ClaudishDrainedRestart — -Recreate guards (#233)' {
    It 'refuses -Recreate without -EnvFile and writes a terminal OUTCOME line' {
        Reset-DrainFixture
        $r = Invoke-ClaudishDrainedRestart -Reason 'guard-test' -Url 'http://127.0.0.1:1' -Recreate
        $r | Should -BeFalse
        (Get-DrainLogText) | Should -Match 'OUTCOME refused'
        (Get-DrainLogText) | Should -Match 'requires -EnvFile'
        Get-CallsText | Should -Be ''   # nothing docker-shaped happened at all
    }

    It 'refuses when leftover twins exist — zero compose calls, exact removal command named' {
        Reset-DrainFixture
        # Target running + one Created twin. inspect answers PATH only, so the
        # armed-cascade guard sees 0 armed in the container and passes.
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nabc123_claudish-proxy created", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'twin-refuse' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeFalse
        $log = Get-DrainLogText
        $log | Should -Match "leftover twin 'abc123_claudish-proxy' \(state=created\)"
        $log | Should -Match 'docker rm abc123_claudish-proxy'
        $log | Should -Match 'OUTCOME refused'
        # AC2: refuse BEFORE stopping anything. compose is where the stop
        # happens; it must never have been invoked.
        $calls = Get-CallsText
        $calls | Should -Not -Match '(?m)^compose'
        $calls | Should -Not -Match '(?m)^rm'
    }

    It 'positive control: the shim actually captured the ps call (a silent shim would pass every zero-call assertion)' {
        $calls = Get-CallsText
        $calls | Should -Match 'ps -a --filter'
        $calls | Should -Match 'inspect'
    }

    It '-RemoveCreatedTwins removes Created twins and proceeds to the recreate' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nabc123_claudish-proxy created", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'twin-autorm' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile -RemoveCreatedTwins
        $r | Should -BeTrue
        $calls = Get-CallsText
        $calls | Should -Match '(?m)^rm abc123_claudish-proxy'
        $calls | Should -Match '(?m)^compose'
        (Get-DrainLogText) | Should -Match "removed Created-state twin 'abc123_claudish-proxy'"
        (Get-DrainLogText) | Should -Match 'OUTCOME success'
    }

    It '-RemoveCreatedTwins still refuses when a non-Created twin is present' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running`nx1_claudish-proxy created`nx2_claudish-proxy exited", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "PATH=/usr/bin", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'twin-mixed' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile -RemoveCreatedTwins
        $r | Should -BeFalse
        $calls = Get-CallsText
        $calls | Should -Not -Match '(?m)^rm'
        $calls | Should -Not -Match '(?m)^compose'
        (Get-DrainLogText) | Should -Match 'only covers Created-state twins'
    }
}

Describe 'Invoke-ClaudishDrainedRestart — rollback on compose failure (#233 AC1)' {
    It 'starts the stopped container again after compose fails — hub serving previous image' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "false", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'compose_exit.txt'), "1", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'rollback' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeFalse
        $calls = Get-CallsText
        $calls | Should -Match '(?m)^start claudish-proxy'
        $log = Get-DrainLogText
        $log | Should -Match 'ROLLBACK started claudish-proxy'
        $log | Should -Match 'OUTCOME failed'
        $log | Should -Match 'ROLLBACK started, hub serving previous image'
    }

    It 'does not start anything when compose failed but the container still runs' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'inspect_out.txt'), "true", (New-Object System.Text.ASCIIEncoding))
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'compose_exit.txt'), "1", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'norollback' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeFalse
        Get-CallsText | Should -Not -Match '(?m)^start'
        (Get-DrainLogText) | Should -Match 'still running'
    }
}

Describe 'Invoke-ClaudishDrainedRestart — terminal OUTCOME lines (#233 AC3)' {
    It 'success path writes OUTCOME success' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText((Join-Path $script:ShimDir 'ps_out.txt'), "claudish-proxy running", (New-Object System.Text.ASCIIEncoding))

        $r = Invoke-ClaudishDrainedRestart -Reason 'happy' -Url 'http://127.0.0.1:1' -Recreate -EnvFile $script:EnvFile
        $r | Should -BeTrue
        (Get-DrainLogText) | Should -Match 'OUTCOME success'
    }

    It 'a previous RECREATE with no OUTCOME after it logs PREVIOUS RUN INTERRUPTED' {
        Reset-DrainFixture
        # The 09:35Z shape: a RECREATE line (compose output carries the same
        # prefix) and then nothing.
        [System.IO.File]::WriteAllText($script:TestLog, "[2026-09-23 11:35:54] RECREATE (manual): compose-stopping-old-container`n", (New-Object System.Text.UTF8Encoding($false)))

        $r = Invoke-ClaudishDrainedRestart -Reason 'after-crash' -Url 'http://127.0.0.1:1' -Recreate
        $r | Should -BeFalse
        (Get-DrainLogText) | Should -Match 'PREVIOUS RUN INTERRUPTED'
        (Get-DrainLogText) | Should -Match 'OUTCOME refused'
    }

    It 'previous-run detection stays silent when the last run reached an OUTCOME' {
        Reset-DrainFixture
        [System.IO.File]::WriteAllText($script:TestLog, "[2026-09-23 10:00:00] RECREATE (manual): started`n[2026-09-23 10:01:00] OUTCOME success (deploy)`n", (New-Object System.Text.UTF8Encoding($false)))

        $r = Invoke-ClaudishDrainedRestart -Reason 'after-clean' -Url 'http://127.0.0.1:1' -Recreate
        $r | Should -BeFalse
        (Get-DrainLogText) | Should -Not -Match 'PREVIOUS RUN INTERRUPTED'
    }
}
