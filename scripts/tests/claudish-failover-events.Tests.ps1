<#
    Pester 5/6 suite for the failover-events collector (jsboige/claudish#347).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    The hub's [Failover] markers (ARMED / DISARMED / walled / DWELL / CLOSED)
    die with the next recreate — docker log and process memory both. The
    collector persists them; these pins prove it can SEE them before its
    silence can mean anything, and prove the two properties that make the file
    trustworthy:

      - ALLOWLIST (the #192 lesson, applied BEFORE an incident this time): a
        docker-logs window contains request lines, body previews and
        Authorization-looking strings — none of it may ever reach the file;
      - WATERMARK HELD on a failed invocation (AC3): a collector that advances
        over a window it did not read silently writes off the unread range.

    The allowlist and watermark logic live as pure functions in
    scripts/lib/claudish-engine.psm1; the glue (docker call, state file,
    rotation) is failover-events-collect.ps1, guarded below by an AST walk
    with a positive control — collecting is not acting (#173).
#>

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force
    $script:ScriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

    # Real shapes. The [Failover] lines are the hub's own markers (CLAUDE.md
    # failover section spells them); the nano timestamps are what
    # `docker logs --timestamps` prefixes.
    $script:FailoverArmed = '2026-10-05T19:20:31.123456789Z [Failover] ARMED bucket glm-coding (sonnet nominal) ttl=10min'
    $script:FailoverDwell = '2026-10-05T19:21:02.987654321Z [Failover] DWELL sonnet session 8f2c…9a yielded — nominal recovered 74s ago'
    $script:RequestLine   = '2026-10-05T19:20:32.000000000Z [Request] pid=1 reqN=4188 model=glm-5.3 msgs=12 bytes=45678 ttft=812ms'
    $script:BodyPreview   = '2026-10-05T19:20:33.000000000Z [msg:0] "…user asks about D:\dev\claudish routing…"'
    $script:AuthLooking   = '2026-10-05T19:20:34.000000000Z authorization: Bearer sk-ant-api03-EXAMPLENOTAREALKEY0000000000000000'
    $script:DockerOwnErr  = 'Error response from daemon: No such container: claudish-proxy'
}

Describe 'ConvertFrom-DockerLogLine' {
    It 'splits a real --timestamps line into instant + text' {
        $e = ConvertFrom-DockerLogLine -Line $script:FailoverArmed
        $e.Ts | Should -Be '2026-10-05T19:20:31.123456789Z'
        $e.Rest | Should -Be '[Failover] ARMED bucket glm-coding (sonnet nominal) ttl=10min'
    }

    It 'accepts second-resolution instants too (docker renders both)' {
        $e = ConvertFrom-DockerLogLine -Line '2026-10-05T19:20:31Z hello'
        $e.Ts | Should -Be '2026-10-05T19:20:31Z'
        $e.Rest | Should -Be 'hello'
    }

    It 'yields $null for docker-owned noise and blanks — never a sink candidate' {
        foreach ($bad in @($script:DockerOwnErr, '', '   ', 'no prefix at all')) {
            ConvertFrom-DockerLogLine -Line $bad | Should -BeNullOrEmpty
        }
    }
}

Describe 'Select-FailoverLines (allowlist sink guard)' {
    It 'keeps ONLY the [Failover] lines from a mixed window — the #192 property' {
        $mixed = @(
            (ConvertFrom-DockerLogLine -Line $script:FailoverArmed)
            (ConvertFrom-DockerLogLine -Line $script:RequestLine)
            (ConvertFrom-DockerLogLine -Line $script:BodyPreview)
            (ConvertFrom-DockerLogLine -Line $script:AuthLooking)
            (ConvertFrom-DockerLogLine -Line $script:FailoverDwell)
        )
        $sel = Select-FailoverLines -Events $mixed
        @($sel.Kept).Count | Should -Be 2
        $sel.Dropped | Should -Be 3
        # positive control: what is kept really is the marker pair, ts intact
        @($sel.Kept)[0].Ts | Should -Be '2026-10-05T19:20:31.123456789Z'
        (@($sel.Kept)[1].Rest -match '\[Failover\] DWELL') | Should -Be $true
    }

    It 'an Authorization-looking string NEVER reaches the kept set' {
        $sel = Select-FailoverLines -Events @((ConvertFrom-DockerLogLine -Line $script:AuthLooking))
        @($sel.Kept).Count | Should -Be 0
        $sel.Dropped | Should -Be 1
    }

    It 'a body preview mentioning [Failover] in QUOTED prose is kept only if the marker is in the line text itself — the allowlist is a token, not semantics' {
        # Documented edge: the token test is textual by design. A prose echo
        # that literally contains "[Failover]" would be kept — the marker is
        # greppable in conversation text. That is accepted and counted here,
        # because the alternative (semantic filtering) cannot be a pure
        # function; the Dropped counter keeps the ratio visible in the state.
        $echo = '2026-10-05T19:22:00.000000000Z [msg:3] "as the rule says, a [Failover] ARMED line names its bucket"'
        $sel = Select-FailoverLines -Events @((ConvertFrom-DockerLogLine -Line $echo))
        @($sel.Kept).Count | Should -Be 1
    }
}

Describe 'Select-NewFailoverLines (window-boundary dedup)' {
    It 'drops a line already seen in a previous overlapping window' {
        $a = ConvertFrom-DockerLogLine -Line $script:FailoverArmed
        $first = Select-NewFailoverLines -Events @($a) -Seen @() -SeenCap 10
        @($first.Kept).Count | Should -Be 1
        # the SAME (ts, line) re-requested next window: skipped, not doubled
        $second = Select-NewFailoverLines -Events @($a) -Seen @($first.Seen) -SeenCap 10
        @($second.Kept).Count | Should -Be 0
        @($second.Skipped).Count | Should -Be 1
    }

    It 'keeps a DIFFERENT line at the same instant (fingerprint is ts AND line)' {
        $a = ConvertFrom-DockerLogLine -Line $script:FailoverArmed
        $b = ConvertFrom-DockerLogLine -Line $script:FailoverDwell
        $r = Select-NewFailoverLines -Events @($a, $b) -Seen @() -SeenCap 10
        @($r.Kept).Count | Should -Be 2
    }

    It 'bounds the fingerprint ring it carries forward' {
        $events = @()
        for ($i = 0; $i -lt 12; $i++) {
            # 19:30:00..19:41:00 — VALID HH:MM:SS; a malformed instant parses
            # to $null and the binding would throw (the glue filters nulls).
            $events += ConvertFrom-DockerLogLine -Line ("2026-10-05T19:{0:d2}:00.000000000Z [Failover] DISARMED bucket glm-coding -> probing nominals, tick {1}" -f (30 + $i), $i)
        }
        $r = Select-NewFailoverLines -Events $events -Seen @() -SeenCap 5
        @($r.Seen).Count | Should -Be 5
        # and the newest fingerprints are the ones kept
        @($r.Seen)[-1] | Should -Match 'tick 11'
    }
}

Describe 'Get-FailoverNextSince (watermark)' {
    It 'a successful window advances to the WINDOW START, not a later instant' {
        # Regression for the live hole of 05/10: the watermark is the instant
        # the window was OPENED (before the docker call), because the call
        # snapshots the log at that moment but only RETURNS seconds later. A
        # return-instant watermark excludes every line written in between —
        # absent from this snapshot, earlier than the watermark: read by
        # neither window, ever (measured: 22 markers lost at 15:57:18-25Z).
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:30:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:30:00.000Z'
        $w.Reason | Should -Be 'window-start'
    }

    It 'AC3: a FAILED invocation HOLDS the watermark — the window stays unread' {
        $w = Get-FailoverNextSince -InvocationOk $false -WindowStartUtc '2026-10-05T19:30:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:15:00.000Z'
        $w.Reason | Should -Be 'held-not-measured'
    }

    It 'never moves backwards (clock skew between host and state writer)' {
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:10:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:15:00.000Z'
        $w.Reason | Should -Be 'held-never-backwards'
    }

    It 'a success with no window start holds (defensive)' {
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '' -PreviousSinceUtc '2026-10-05T19:15:00.000Z'
        $w.SinceUtc | Should -Be '2026-10-05T19:15:00.000Z'
        $w.Reason | Should -Be 'held-no-window-start'
    }

    It 'a STALE coherence verdict holds the watermark under its OWN distinct reason — and beats the Ok window' {
        # The verdict outranks a successful invocation AND an otherwise-valid
        # window start: certifying a window served from the pre-rotation
        # segment is strictly worse than holding.
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:30:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z' -CoherenceVerdict 'stale'
        $w.SinceUtc | Should -Be '2026-10-05T19:15:00.000Z'
        $w.Reason | Should -Be 'held-since-served-stale-segment'
        ($w.Reason -ne 'held-not-measured') | Should -Be $true
    }

    It 'an untested or coherent verdict changes nothing to the legacy reasons' {
        foreach ($v in @('untested', 'coherent', 'coherent-silent')) {
            $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:30:00.000Z' -PreviousSinceUtc '2026-10-05T19:15:00.000Z' -CoherenceVerdict $v
            $w.SinceUtc | Should -Be '2026-10-05T19:30:00.000Z'
            $w.Reason | Should -Be 'window-start'
        }
    }
}

Describe 'Test-DockerLogsSinceCoherence (stale-segment probe)' {
    # The CR of PR #357 (2026-10-06): on the json-file driver after a rotation,
    # `docker logs --since` can serve the PREVIOUS segment instead of the
    # current one — no error, no warning (measured on ai-01 and po-2025 on
    # 06-07/09, three epochs, three times; reproduced on .46 on 04/10; po-203
    # does not have the defect; traffic-live.ps1 GOTCHA #2 carries a tail-depth
    # fallback against the same signature). The collector then receives old
    # lines or nothing, the bounded invocation renders Ok, an open-instant
    # watermark ADVANCES, and the tick certifies a window nobody read. The
    # discriminator is the one traffic-live.ps1 measured reliable: a SHORT
    # tail probe (`--tail 1 --timestamps`). Everything below runs on INJECTED
    # docker outputs — the verdict is pure logic, testable with no daemon.

    It 'BLOCKING CASE: window older than the tail-1 line => stale, watermark held under its own reason' {
        # The exact signature: the --since window (a stale segment) holds
        # lines whose newest is BEFORE --since, while the container's real
        # newest line (the tail probe) is at-or-after --since.
        $since = '2026-10-05T19:30:00.000Z'
        $staleWindow = @(
            '2026-10-05T19:14:02.000000000Z [Failover] ARMED bucket glm-coding (sonnet nominal) ttl=10min'
            '2026-10-05T19:14:59.000000000Z [Failover] DISARMED bucket glm-coding -> probing nominals'
        )
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @('2026-10-05T19:31:07.000000000Z [Request] pid=1 reqN=5001 model=glm-5.3 msgs=9 bytes=12345 ttft=900ms'); ErrorText = '' }

        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines $staleWindow -SinceUtc $since
        $c.Verdict | Should -Be 'stale'

        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:31:00.000Z' -PreviousSinceUtc $since -CoherenceVerdict $c.Verdict
        $w.SinceUtc | Should -Be $since
        $w.Reason | Should -Be 'held-since-served-stale-segment'
    }

    It 'stale ALSO fires on an EMPTY window whose tail line is inside the range — the photographed "quiet proxy" lie' {
        $since = '2026-10-05T19:30:00.000Z'
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @('2026-10-05T19:32:40.000000000Z [Request] pid=1 reqN=5002 model=glm-5.3 msgs=4 bytes=6789 ttft=400ms'); ErrorText = '' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines @() -SinceUtc $since
        $c.Verdict | Should -Be 'stale'
    }

    It 'a tail probe whose single line lands on the container STDERR is adjudicated by the EXIT CODE, not the events-verdict Ok (the permanent-wedge guard)' {
        # `docker logs` demuxes container stderr to the CLI's stderr — and the
        # hub's [Failover] markers ARE stderr-class. A verdict-Ok gate would
        # read this healthy probe as "docker refused" on every tick, hold the
        # watermark forever, and kill the collector by wedge. Exit 0 + the
        # merged streams is the transport truth.
        $since = '2026-10-05T19:30:00.000Z'
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @(); ErrorText = '2026-10-05T19:31:07.000000000Z [Failover] ARMED bucket glm-coding (sonnet nominal) ttl=10min' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines @() -SinceUtc $since
        $c.Verdict | Should -Be 'stale'
    }

    It 'the tail adjudication takes the NEWEST parseable instant across both probe streams' {
        # stdout holds an older timestamped line, stderr a newer one; --since
        # sits between them and the window is empty. Reading the OLDER would
        # say coherent-silent (missed stale); the newest says stale.
        $since = '2026-10-05T19:30:00.000Z'
        $tailProbe = @{
            Exited    = $true
            Code      = 0
            Lines     = @('2026-10-05T19:11:00.000000000Z [Request] pid=1 reqN=4998 model=glm-5.3 msgs=2 bytes=2222 ttft=150ms')
            ErrorText = '2026-10-05T19:33:12.000000000Z [Failover] DWELL sonnet session 8f2c…9a yielded — nominal recovered 74s ago'
        }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines @() -SinceUtc $since
        $c.Verdict | Should -Be 'stale'
    }

    It 'a genuinely quiet window is coherent-silent, NOT stale (the false-positive guard traffic-live measured)' {
        # traffic-live 2026-08-30: `--since 1h` returning 0 lines against a
        # newest line 4.5 h old is the RIGHT answer, not a defect — the
        # container truly emitted nothing in the window.
        $since = '2026-10-05T19:30:00.000Z'
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @('2026-10-05T19:14:59.000000000Z [Failover] DISARMED bucket glm-coding -> probing nominals'); ErrorText = '' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines @() -SinceUtc $since
        $c.Verdict | Should -Be 'coherent-silent'
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:45:00.000Z' -PreviousSinceUtc $since -CoherenceVerdict $c.Verdict
        $w.SinceUtc | Should -Be '2026-10-05T19:45:00.000Z'
    }

    It 'a window that itself holds a line at-or-after --since is coherent — the segment is the current one' {
        $since = '2026-10-05T19:30:00.000Z'
        $window = @(
            '2026-10-05T19:29:10.000000000Z [Request] pid=1 reqN=5000 model=glm-5.3 msgs=3 bytes=1111 ttft=200ms'
            '2026-10-05T19:30:41.000000000Z [Failover] ARMED bucket glm-coding (sonnet nominal) ttl=20min'
        )
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @('2026-10-05T19:31:07.000000000Z [Request] pid=1 reqN=5001 model=glm-5.3 msgs=9 bytes=12345 ttft=900ms'); ErrorText = '' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines $window -SinceUtc $since
        $c.Verdict | Should -Be 'coherent'
    }

    It 'the tolerance absorbs a boundary line slightly BEFORE --since (photograph skew)' {
        $since = '2026-10-05T19:30:00.000Z'
        $window = @('2026-10-05T19:29:58.500000000Z [Request] pid=1 reqN=5000 model=glm-5.3 msgs=3 bytes=1111 ttft=200ms')
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @('2026-10-05T19:31:07.000000000Z [Request] pid=1 reqN=5001 model=glm-5.3 msgs=9 bytes=12345 ttft=900ms'); ErrorText = '' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines $window -SinceUtc $since
        $c.Verdict | Should -Be 'coherent'
    }

    It 'a REFUSED tail probe (non-zero exit) is untested, and untested never downgrades a coherent window — but the GLUE holds on it' {
        $since = '2026-10-05T19:30:00.000Z'
        $window = @('2026-10-05T19:30:41.000000000Z [Failover] ARMED bucket glm-coding (sonnet nominal) ttl=20min')
        $tailProbe = @{ Exited = $true; Code = 1; Lines = @(); ErrorText = 'Error response from daemon: No such container: claudish-proxy' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines $window -SinceUtc $since
        $c.Verdict | Should -Be 'untested'
        # pure function: only 'stale' forces a hold
        $w = Get-FailoverNextSince -InvocationOk $true -WindowStartUtc '2026-10-05T19:45:00.000Z' -PreviousSinceUtc $since -CoherenceVerdict $c.Verdict
        $w.SinceUtc | Should -Be '2026-10-05T19:45:00.000Z'
    }

    It 'a timed-out tail probe (killed at the bound, no exit) is untested — the glue holds the watermark on it' {
        $since = '2026-10-05T19:30:00.000Z'
        $tailProbe = @{ Exited = $false; Code = -1; Lines = @(); ErrorText = '' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines @() -SinceUtc $since
        $c.Verdict | Should -Be 'untested'
    }

    It 'an unparseable tail line is untested, not coherent' {
        $since = '2026-10-05T19:30:00.000Z'
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @('no timestamp on this line at all'); ErrorText = '' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines @() -SinceUtc $since
        $c.Verdict | Should -Be 'untested'
    }

    It 'an unparseable --since instant is untested, not stale' {
        $tailProbe = @{ Exited = $true; Code = 0; Lines = @('2026-10-05T19:31:07.000000000Z [Request] pid=1 reqN=5001 model=glm-5.3'); ErrorText = '' }
        $c = Test-DockerLogsSinceCoherence -TailProbe $tailProbe -WindowLines @() -SinceUtc 'not-a-date'
        $c.Verdict | Should -Be 'untested'
    }

    It 'the glue CONSULTS the probe on every read window and CARRIES the verdict into the watermark decision (red if the probe is unwired)' {
        # The pure pins above stay green if someone deletes the glue's probe
        # call — this static pin is what goes red. Same discipline as the
        # zero-actuator AST guard: parse the file, assert the wiring.
        $path = Join-Path $script:ScriptsRoot 'failover-events-collect.ps1'
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs)
        $errs.Count | Should -Be 0

        $probeCalls = @($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] -and $x.GetCommandName() -eq 'Test-DockerLogsSinceCoherence' }, $true))
        $probeCalls.Count | Should -Be 1

        $nextCalls = @($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] -and $x.GetCommandName() -eq 'Get-FailoverNextSince' }, $true))
        $nextCalls.Count | Should -Be 1
        $carriesVerdict = $false
        foreach ($el in $nextCalls[0].CommandElements) {
            if ($el -is [System.Management.Automation.Language.CommandParameterAst] -and $el.ParameterName -eq 'CoherenceVerdict') { $carriesVerdict = $true }
        }
        $carriesVerdict | Should -Be $true

        # And the tick-exit gate keys on $measured (the probe verdict), not on
        # the docker verdict alone.
        $text = [System.IO.File]::ReadAllText($path)
        ($text -match '\$measured\s*=\s*\$res\.Ok\s*-and') | Should -Be $true
    }
}

Describe 'the collector contains no actuator' {
    # Same shape and reasoning as the docker-events guard (#192): collecting
    # is not acting (#173). Note: Remove-Item is deliberately NOT in the
    # forbidden set — rotation deletes the collector's OWN rotated files
    # (failover-events-*.log), filtered by name; that is housekeeping of its
    # own outputs, not an actuator.

    # Pester 6: a function defined in the Describe BODY dies at discovery
    # (each It runs in a new script scope) — define it in BeforeAll.
    BeforeAll {
        function Get-ActuatorOffenders([System.Management.Automation.Language.Ast]$Ast) {
            $offenders = @()
            foreach ($n in $Ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true)) {
                $name = $n.GetCommandName()
                if ($name -match '^(Restart|Stop|Start|Register|Unregister|Set|Suspend|Disable)-') {
                    $offenders += ('{0}: {1}' -f $n.Extent.StartLineNumber, $name)
                }
                if ($n.Extent.Text -match 'docker\s+(stop|restart|kill|rm|compose)\b') { $offenders += ('{0}: docker stop/restart/kill/rm/compose' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match '\btaskkill\b') { $offenders += ('{0}: taskkill' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match 'schtasks\s+/(change|create|delete|end|run)') { $offenders += ('{0}: schtasks actuator' -f $n.Extent.StartLineNumber) }
                if ($n.Extent.Text -match '-Verb\s+RunAs') { $offenders += ('{0}: -Verb RunAs' -f $n.Extent.StartLineNumber) }
            }
            return $offenders
        }
    }

    It 'no Restart-*/Stop-*/Start-* cmdlet, no docker actuator, no -Verb RunAs' {
        $path = Join-Path $script:ScriptsRoot 'failover-events-collect.ps1'
        (Test-Path -LiteralPath $path) | Should -Be $true
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs)
        $errs.Count | Should -Be 0
        $offenders = Get-ActuatorOffenders $ast
        $offenders | Should -BeNullOrEmpty
    }

    It 'AC8: the collector parses under 5.1 — no ?? / ?. / ternary (a production-only parse failure)' {
        # The scheduled task runs Windows PowerShell 5.1, which cannot parse
        # `??`, `?.` or a ternary — under 5.1 the ParseFile above already fails
        # (errs.Count), but under pwsh 7 those forms parse fine and the guard
        # would be a green line. So scan the TOKENS here too: it bites in both
        # interpreter runs, which is what makes it a guard and not a decoration.
        $path = Join-Path $script:ScriptsRoot 'failover-events-collect.ps1'
        $tokens = $null; $errs = $null
        [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs) | Out-Null
        $errs.Count | Should -Be 0
        $bad = @($tokens | Where-Object {
                $_.Kind -in @('QuestionQuestion', 'QuestionDot') -or
                ($_.Kind -eq 'Question' -and $_.Text -eq '?')
            })
        $bad | Should -BeNullOrEmpty
    }

    It 'the actuator detector actually detects (positive control)' {
        $bad = @'
Restart-Service claudish
Stop-Process -Id 1
Start-Process powershell -Verb RunAs
Register-ScheduledTask evil
docker restart claudish-proxy
docker compose up -d
docker rm claudish-proxy
taskkill /pid 7
schtasks /run /tn X
'@
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($bad, [ref]$tokens, [ref]$errs)
        $offenders = @(Get-ActuatorOffenders $ast)
        $offenders.Count | Should -BeGreaterOrEqual 9
        ($offenders -match 'docker stop/restart/kill/rm/compose').Count | Should -Be 3
        ($offenders -match 'schtasks actuator').Count | Should -Be 1
        ($offenders -match '-Verb RunAs').Count | Should -Be 1
    }
}
