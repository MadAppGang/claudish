<#
    State round-trip pins for claudish-sidecar-host-watchdog.ps1.

    Measured on myia-po-2028, 2026-10-24 (episode: engine hang 12:20Z, R3 at
    13:40Z): the old read cast the stored timestamp with a bare [datetime],
    which is Kind-broken on PowerShell 5.1 in BOTH directions - "...Z" is
    converted to local wall time, "+02:00" has its offset stripped unapplied.
    The downstream subtraction is Kind-blind, so the last engine action read
    2 h off and the 30-minute cooldown gate behaved as ~150 min
    (since_last_action_min printed -44..-81 against a past action).

    These tests dot-source the script (its guard makes that a no-op beyond
    defining functions) and pin that every ISO form round-trips to the same
    INSTANT, that the file always carries the "...Z" form, and that a missing
    state file yields the documented defaults.
#>

BeforeAll {
    $script:ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\claudish-sidecar-host-watchdog.ps1')).Path
    # Read/Write-WdState delegate to the pure codec in the module; the
    # dot-source guard stops the script before ITS import, so the suite
    # imports it here.
    Import-Module (Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1') -Force
}

Describe 'sidecar-host-watchdog state round-trip' {
    BeforeEach {
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null
        # Dot-source into this scope: defines the functions, runs nothing
        # (the guard returns before any exit-bearing block).
        . $script:ScriptPath -ClaudishHome $script:SandboxHome
        $script:StatePath = Join-Path $script:SandboxHome 'sidecar-host-watchdog.state.json'
    }

    It 'parses the "...Z" form to the exact instant (the -44 min episode shape)' {
        # 11:09:12.5Z is the exact form of the hand reset that produced
        # since_last_action_min=-44 at 12:25Z on 2026-10-24.
        @{ engineFailures = 1; lastEngineActionUtc = '2026-10-24T11:09:12.5000000Z'; engineActionsSinceDown = 0 } |
            ConvertTo-Json | Set-Content -Path $script:StatePath
        $s = Read-WdState
        $expected = [DateTimeOffset]::Parse('2026-10-24T11:09:12.5000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $s.LastEngineActionUtc | Should -Be $expected
        $s.LastEngineActionUtc.Kind | Should -Be 'Utc'
        $s.EngineFailures | Should -Be 1
        $s.EngineActionsSinceDown | Should -Be 0
    }

    It 'parses the "+02:00" offset form to the SAME instant (the -81 min episode shape)' {
        # 13:09:12.5+02:00 IS 11:09:12.5Z. The old cast stripped the offset
        # and read 13:09 literal - on the 15:40+02:00 write of that episode
        # the subtraction printed -81 min.
        @{ engineFailures = 2; lastEngineActionUtc = '2026-10-24T13:09:12.5000000+02:00'; engineActionsSinceDown = 1 } |
            ConvertTo-Json | Set-Content -Path $script:StatePath
        $s = Read-WdState
        $expected = [DateTimeOffset]::Parse('2026-10-24T11:09:12.5000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $s.LastEngineActionUtc | Should -Be $expected
    }

    It 'a missing or empty timestamp yields the MinValue default, never a cast of $null' {
        Set-Content -Path $script:StatePath -Value '{"engineFailures":0,"lastEngineActionUtc":null,"engineActionsSinceDown":0}'
        $s = Read-WdState
        $s.LastEngineActionUtc | Should -Be ([datetime]::MinValue)
        $s.EngineFailures | Should -Be 0
    }

    It 'no state file at all yields the documented defaults' {
        $s = Read-WdState
        $s.EngineFailures | Should -Be 0
        $s.LastEngineActionUtc | Should -Be ([datetime]::MinValue)
        $s.EngineActionsSinceDown | Should -Be 0
    }

    It 'an UNREADABLE state file yields $null, never silent defaults (review #639 point 1)' {
        # The old silent catch reset every counter on every run: R2/R3 were
        # unreachable on a fresh host, and a corrupted file would have re-armed
        # R2 inside an episode it already acted on. $null is the contract the
        # main block turns into state_read_error + an inert exit.
        Set-Content -Path $script:StatePath -Value '{"engineFailures":'
        $s = Read-WdState
        $s | Should -BeNullOrEmpty
    }

    It 'Write-WdState always emits the "...Z" form so any seat and any hand reset round-trips' {
        Write-WdState @{ EngineFailures = 3; LastEngineActionUtc = ([DateTimeOffset]::UtcNow).UtcDateTime; EngineActionsSinceDown = 1 }
        # Assert on the FILE TEXT: under pwsh 7, ConvertFrom-Json turns the stamp
        # into a DateTime, whose string form carries no "Z" whatever the file says.
        $text = Get-Content $script:StatePath -Raw
        $text | Should -Match '"lastEngineActionUtc"\s*:\s*"[^"]+Z"'
        # And the written form reads back to the same instant (write+read loop).
        $s = Read-WdState
        [Math]::Abs((([DateTimeOffset]::UtcNow).UtcDateTime - $s.LastEngineActionUtc).TotalSeconds) | Should -BeLessThan 120
    }

    It 'the dot-source guard ran no main cycle: no log line was written for this sandbox' {
        # The guard must return before ANY exit-bearing or machine-touching
        # block; the dot-source above proves it by this test still running.
        (Test-Path (Join-Path $script:SandboxHome 'sidecar-host-watchdog.log')) | Should -BeFalse
    }
}
