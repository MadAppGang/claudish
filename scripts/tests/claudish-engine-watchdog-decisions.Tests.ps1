<#
    Seam pins for the PURE decision half of the sidecar host watchdog
    (scripts/lib/claudish-engine.psm1), per review #639 point 5: the six
    defects found in production or by measurement lived in pure decisions
    that only a real wedge could exercise before this seam existed.

    Three surfaces, each with the episode it is named after:
      - the state codec: the Kind-broken [datetime] cast that read the last
        engine action 2 h off (myia-po-2028, 2026-10-24: since_last_action
        -44..-81 against a 30-min cooldown) and the null-cast exception that
        behind a silent catch reset EngineFailures to 0 on every run;
      - the engine ladder: order, once-per-episode, unknown-never-actuates,
        reset-on-up, dry-run-never-mutates;
      - the R1 squatter selection: nothing unless IPv4 is alive, loopback
        only, wslrelay only.

    Run under BOTH interpreters (bun run test:scripts / test:scripts:win51) -
    the Kind break is 5.1-specific and must stay red-proof there.
#>

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force

    # Fixed clock: the decision takes NowUtc injected, so every branch is
    # reachable without sleeping.
    $script:Now = [DateTimeOffset]::Parse('2026-10-24T14:00:00.0000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime

    function New-WdState {
        param([int]$Failures = 0, [int]$ActionsSinceDown = 0, [datetime]$Stamp = [datetime]::MinValue)
        return @{
            EngineFailures         = $Failures
            LastEngineActionUtc    = $Stamp
            EngineActionsSinceDown = $ActionsSinceDown
        }
    }
    # 60-min-old stamp: the 30-min cooldown is elapsed for every call.
    $script:StampAgo60 = [DateTimeOffset]::Parse('2026-10-24T13:00:00.0000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime

    function Invoke-Ladder {
        param(
            [hashtable]$State,
            [string]$EngineVerdict = 'down',
            [bool]$DrainInFlight = $false,
            [bool]$BackendPresent = $true,
            [string]$WslVerdict = 'ok',
            [bool]$HostWatchdogPresent = $false,
            [datetime]$NowUtc = $script:Now,
            [int]$ConsecutiveEngineFailures = 2,
            [int]$EngineCooldownMin = 30,
            [switch]$DryRun
        )
        return Get-EngineWatchdogDecision -State $State -EngineVerdict $EngineVerdict `
            -DrainInFlight $DrainInFlight -BackendPresent $BackendPresent `
            -WslVerdict $WslVerdict -HostWatchdogPresent $HostWatchdogPresent `
            -NowUtc $NowUtc -ConsecutiveEngineFailures $ConsecutiveEngineFailures `
            -EngineCooldownMin $EngineCooldownMin -DryRun:$DryRun
    }
}

Describe 'watchdog state codec' {
    It 'round-trips a UTC stamp to the same instant, file form "...Z"' {
        $s = New-WdState -Failures 2 -ActionsSinceDown 1 -Stamp $script:StampAgo60
        $json = ConvertTo-WatchdogStateJson -State $s
        $json | Should -Match '"lastEngineActionUtc":\s*"2026-10-24T13:00:00[^"]*Z"' -Because 'the file always carries the Z form so any seat and any hand reset round-trips'
        $back = ConvertFrom-WatchdogStateJson -Json $json
        $back.LastEngineActionUtc | Should -Be $script:StampAgo60
        $back.LastEngineActionUtc.Kind | Should -Be 'Utc'
        $back.EngineFailures | Should -Be 2
        $back.EngineActionsSinceDown | Should -Be 1
    }

    It 'round-trips a null stamp (the fresh-host shape) to MinValue, never a cast of $null' {
        # [datetime]$null THROWS on 5.1; behind the old silent catch that reset
        # every counter on every run - R2/R3 unreachable on a fresh host.
        $json = ConvertTo-WatchdogStateJson -State (New-WdState)
        $back = ConvertFrom-WatchdogStateJson -Json $json
        $back.LastEngineActionUtc | Should -Be ([datetime]::MinValue)
        $back.EngineFailures | Should -Be 0
    }

    It 'decodes the "+02:00" offset form to the SAME instant (the -81 min episode shape)' {
        # 13:09:12.5+02:00 IS 11:09:12.5Z. The old bare cast stripped the
        # offset unapplied and read 13:09 literal.
        $json = '{"engineFailures":2,"lastEngineActionUtc":"2026-10-24T13:09:12.5000000+02:00","engineActionsSinceDown":1}'
        $back = ConvertFrom-WatchdogStateJson -Json $json
        $expected = [DateTimeOffset]::Parse('2026-10-24T11:09:12.5000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $back.LastEngineActionUtc | Should -Be $expected
        $back.LastEngineActionUtc.Kind | Should -Be 'Utc'
    }

    It 'decodes the "...Z" form to the exact instant (the -44 min episode shape)' {
        $json = '{"engineFailures":1,"lastEngineActionUtc":"2026-10-24T11:09:12.5000000Z","engineActionsSinceDown":0}'
        $back = ConvertFrom-WatchdogStateJson -Json $json
        $expected = [DateTimeOffset]::Parse('2026-10-24T11:09:12.5000000Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $back.LastEngineActionUtc | Should -Be $expected
    }

    It 'defaults a missing counter to 0' {
        $back = ConvertFrom-WatchdogStateJson -Json '{"lastEngineActionUtc":null}'
        $back.EngineFailures | Should -Be 0
        $back.EngineActionsSinceDown | Should -Be 0
    }

    It 'THROWS on undecodable JSON - the caller must log state_read_error, never silently reset' {
        { ConvertFrom-WatchdogStateJson -Json 'not json at all' } | Should -Throw
        { ConvertFrom-WatchdogStateJson -Json '{"engineFailures":}' } | Should -Throw
    }
}

Describe 'engine watchdog ladder' {
    It 'engine up resets the counters and KEEPS the cooldown stamp' {
        $d = Invoke-Ladder -State (New-WdState -Failures 3 -ActionsSinceDown 1 -Stamp $script:StampAgo60) -EngineVerdict 'up'
        $d.Action | Should -Be 'reset'
        $d.NextState.EngineFailures | Should -Be 0
        $d.NextState.EngineActionsSinceDown | Should -Be 0
        $d.NextState.LastEngineActionUtc | Should -Be $script:StampAgo60 -Because 'a success must not erase the cooldown clock'
    }

    It 'an unknown probe (launch failure) neither increments nor actuates' {
        # Two down-on-launch-failure runs would terminate the distro of a
        # healthy engine - the review point 3 defect.
        $s = New-WdState -Failures 1 -ActionsSinceDown 1 -Stamp $script:StampAgo60
        $d = Invoke-Ladder -State $s -EngineVerdict 'unknown'
        $d.Action | Should -Be 'engine_unknown'
        $d.NextState.EngineFailures | Should -Be 1 -Because 'unknown never counts'
        $d.NextState.EngineActionsSinceDown | Should -Be 1
        $d.NextState.LastEngineActionUtc | Should -Be $script:StampAgo60
    }

    It 'a first failing sighting only counts (pending), even with every other condition ready to fire' {
        $d = Invoke-Ladder -State (New-WdState -Failures 0) -EngineVerdict 'down' -WslVerdict 'timeout' -BackendPresent $false
        $d.Action | Should -Be 'pending'
        $d.NextState.EngineFailures | Should -Be 1
    }

    It 'order: a drain in flight preempts the WSL wedge and everything past it' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -Stamp $script:StampAgo60) -EngineVerdict 'down' -DrainInFlight $true -WslVerdict 'timeout'
        $d.Action | Should -Be 'guard_drain'
        $d.NextState.LastEngineActionUtc | Should -Be $script:StampAgo60 -Because 'a guard never stamps'
    }

    It 'order: the cooldown preempts the WSL wedge' {
        $stamp10 = $script:Now.AddMinutes(-10)
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -Stamp $stamp10) -EngineVerdict 'down' -WslVerdict 'timeout'
        $d.Action | Should -Be 'guard_cooldown'
        [int]$d.SinceActionMin | Should -Be 10
    }

    It 'a fresh host (never acted, MinValue stamp) passes the cooldown gate' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1) -EngineVerdict 'down'
        $d.Action | Should -Be 'r2_terminate'
    }

    It 'the WSL service wedge escalates only, stamps the cooldown and resets the counter' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -Stamp $script:StampAgo60) -EngineVerdict 'down' -WslVerdict 'timeout'
        $d.Action | Should -Be 'r3_wsl_service_wedged'
        $d.NextState.LastEngineActionUtc | Should -Be $script:Now
        $d.NextState.EngineFailures | Should -Be 0
        $d.NextState.EngineActionsSinceDown | Should -Be 0
    }

    It 'R2 already fired this episode: r3_after_r2 even with the backend present (once per episode)' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -ActionsSinceDown 1 -Stamp $script:StampAgo60) -EngineVerdict 'down' -BackendPresent $true
        $d.Action | Should -Be 'r3_after_r2'
        $d.NextState.EngineActionsSinceDown | Should -Be 1 -Because 'escalation does not consume the R2 shot either'
    }

    It 'a host ClaudishWatchdog stands R2 down: r2_standalone, no teardown, no episode consumption' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -Stamp $script:StampAgo60) -EngineVerdict 'down' -HostWatchdogPresent $true -BackendPresent $true
        $d.Action | Should -Be 'r2_standalone'
        $d.NextState.EngineActionsSinceDown | Should -Be 0
        $d.NextState.LastEngineActionUtc | Should -Be $script:Now -Because 'the standdown still bounds its own log repeats'
    }

    It 'backend present: r2_terminate is the measured read path, once per episode' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -Stamp $script:StampAgo60) -EngineVerdict 'down' -BackendPresent $true
        $d.Action | Should -Be 'r2_terminate'
        $d.NextState.EngineActionsSinceDown | Should -Be 1
        $d.NextState.EngineFailures | Should -Be 0
        $d.NextState.LastEngineActionUtc | Should -Be $script:Now
    }

    It 'no backend to respawn the distro: r3_no_backend' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -Stamp $script:StampAgo60) -EngineVerdict 'down' -BackendPresent $false
        $d.Action | Should -Be 'r3_no_backend'
    }

    It 'sequence: pending, then R2 fires, then two fresh sightings escalate (once per episode)' {
        $s = New-WdState
        $d1 = Invoke-Ladder -State $s -EngineVerdict 'down'
        $d1.Action | Should -Be 'pending'
        $d2 = Invoke-Ladder -State $d1.NextState -EngineVerdict 'down'
        $d2.Action | Should -Be 'r2_terminate'
        # R2 is terminal: it resets the counter, so the next pair of sightings
        # re-confirms a PERSISTING outage before the escalation. Cooldown
        # elapsed again (fake a 40-min-old stamp on the state R2 wrote).
        $d2.NextState.LastEngineActionUtc = $script:Now.AddMinutes(-40)
        $d3 = Invoke-Ladder -State $d2.NextState -EngineVerdict 'down'
        $d3.Action | Should -Be 'pending'
        $d4 = Invoke-Ladder -State $d3.NextState -EngineVerdict 'down'
        $d4.Action | Should -Be 'r3_after_r2'
    }

    It 'recovery after a terminal action re-arms R2 for the NEXT episode' {
        $s = New-WdState -Failures 1 -ActionsSinceDown 1 -Stamp $script:StampAgo60
        $d = Invoke-Ladder -State $s -EngineVerdict 'up'
        $d.Action | Should -Be 'reset'
        $d.NextState.EngineActionsSinceDown | Should -Be 0
    }

    It 'hang and down share the same ladder' {
        $d = Invoke-Ladder -State (New-WdState -Failures 1 -Stamp $script:StampAgo60) -EngineVerdict 'hang'
        $d.Action | Should -Be 'r2_terminate'
    }

    It 'DryRun computes the same action but returns the input state UNCHANGED (never moves the state machine)' {
        $s = New-WdState -Failures 1 -ActionsSinceDown 0 -Stamp $script:StampAgo60
        $d = Invoke-Ladder -State $s -EngineVerdict 'down' -DryRun
        $d.Action | Should -Be 'r2_terminate'
        $d.NextState.EngineFailures | Should -Be 1 -Because 'a dry run must not count a failure the next real run would re-count'
        $d.NextState.EngineActionsSinceDown | Should -Be 0
        $d.NextState.LastEngineActionUtc | Should -Be $script:StampAgo60
        # And on the pending shape too: not even the counter increment.
        $d2 = Invoke-Ladder -State (New-WdState -Failures 0) -EngineVerdict 'down' -DryRun
        $d2.Action | Should -Be 'pending'
        $d2.NextState.EngineFailures | Should -Be 0
    }
}

Describe 'R1 squatter selection' {
    BeforeAll {
        $script:Conns = @(
            [PSCustomObject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 101 }
            [PSCustomObject]@{ LocalAddress = '::1'; OwningProcess = 101 }
            [PSCustomObject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 202 }
            [PSCustomObject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 101 }
            [PSCustomObject]@{ LocalAddress = '192.168.0.28'; OwningProcess = 101 }
        )
        $t0 = [DateTimeOffset]::Parse('2026-10-24T11:11:00Z', [System.Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $script:Procs = @{
            101 = [PSCustomObject]@{ ProcessName = 'wslrelay'; StartTime = $t0 }
            202 = [PSCustomObject]@{ ProcessName = 'com.docker.backend'; StartTime = $t0 }
        }
    }

    It 'the measured wedge shape selects the wslrelay loopback listeners only' {
        $sel = @(Select-WslrelaySquatters -Connections $script:Conns -Processes $script:Procs -Ipv4Alive $true)
        $sel.Count | Should -Be 2
        ($sel | ForEach-Object { $_.ProcId } | Sort-Object -Unique) -join ',' | Should -Be '101'
        $sel.LocalAddress | Should -Contain '127.0.0.1'
        $sel.LocalAddress | Should -Contain '::1'
    }

    It 'nothing is selected when IPv4 loopback is dead (engine-down / drained-recreate shape)' {
        $sel = @(Select-WslrelaySquatters -Connections $script:Conns -Processes $script:Procs -Ipv4Alive $false)
        $sel.Count | Should -Be 0
    }

    It 'a non-wslrelay owner is never selected (the Docker backend is untouchable)' {
        $sel = @(Select-WslrelaySquatters -Connections @([PSCustomObject]@{ LocalAddress = '::1'; OwningProcess = 202 }) -Processes $script:Procs -Ipv4Alive $true)
        $sel.Count | Should -Be 0
    }

    It 'a non-loopback address is never selected' {
        $sel = @(Select-WslrelaySquatters -Connections @(
            [PSCustomObject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 101 }
            [PSCustomObject]@{ LocalAddress = '192.168.0.28'; OwningProcess = 101 }
        ) -Processes $script:Procs -Ipv4Alive $true)
        $sel.Count | Should -Be 0
    }

    It 'an unknown owner (process gone) is never selected' {
        $sel = @(Select-WslrelaySquatters -Connections @([PSCustomObject]@{ LocalAddress = '::1'; OwningProcess = 999 }) -Processes $script:Procs -Ipv4Alive $true)
        $sel.Count | Should -Be 0
    }
}

Describe 'loopback verdict sees BOTH families (po-2028, 2026-10-25 - third wedge in three days)' {
    # The verdict read `if ($Ipv6Alive) { 'HEALTHY' }` for 16 h while
    # 127.0.0.1:3000 accepted TCP and answered nothing. Every client whose base
    # URL is http://127.0.0.1:3000 hung with no error to trip on.
    It 'IPv6 alive + IPv4 dead is a DEGRADED verdict, never HEALTHY' {
        Get-LoopbackVerdict -Ipv4Alive $false -Ipv6Alive $true | Should -Be 'LOOPBACK4_DOWN'
    }

    It 'both alive is the only HEALTHY shape' {
        Get-LoopbackVerdict -Ipv4Alive $true -Ipv6Alive $true | Should -Be 'HEALTHY'
    }

    It 'the R1 wedge shape (IPv4 alive, IPv6 dead) is unchanged' {
        Get-LoopbackVerdict -Ipv4Alive $true -Ipv6Alive $false | Should -Be 'LOOPBACK6_DOWN'
    }

    It 'both dead stays LOOPBACK_DEAD (engine down / drained recreate)' {
        Get-LoopbackVerdict -Ipv4Alive $false -Ipv6Alive $false | Should -Be 'LOOPBACK_DEAD'
    }
}

Describe 'curl http_code reading (the probe that never worked)' {
    # Measured 2026-10-24 -> 2026-10-25: every tick logged curl_http=000 AND
    # v6=True. Two defects: curl without --globoff reads the brackets of a
    # literal [::1] URL as a glob range and never connects ('000'), and the old
    # test (^\d{3}$) accepted '000' as a live status.
    It "'000' is no answer, never alive (curl never connected)" {
        Get-CurlHttpProbeVerdict -Raw '000' | Should -Be 'no_answer'
    }

    It 'a real status is alive whatever it is - 200, the documented 5.1-only 400, a 503' {
        Get-CurlHttpProbeVerdict -Raw '200' | Should -Be 'alive'
        Get-CurlHttpProbeVerdict -Raw '400' | Should -Be 'alive'
        Get-CurlHttpProbeVerdict -Raw '503' | Should -Be 'alive'
    }

    It 'empty or garbage output is unparsable, never alive' {
        Get-CurlHttpProbeVerdict -Raw ''        | Should -Be 'unparsable'
        Get-CurlHttpProbeVerdict -Raw 'curl: (3) bad range' | Should -Be 'unparsable'
        Get-CurlHttpProbeVerdict -Raw '00'      | Should -Be 'unparsable'
    }
}
