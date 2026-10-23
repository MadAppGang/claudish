<#
    Gap 2 of jsboige/claudish#530: consecutive FATALs escalate instead of
    scrolling past in watchdog.log.

    On 2026-10-18 the hub's engine was down for 73 minutes. The watchdog logged
    four FATALs, one per cycle, and exited 1 each time: no seat-side signal,
    no marker, nothing a later organ could read. The fleet learned the hub was
    dead from relay heartbeats before the hub seat said anything.

    The watchdog cannot open a network channel from a SYSTEM scheduled task, so
    the escalation is a MARKER JOURNAL under ~/.claudish/ — the shape the
    worker cycle already relays with watermark discipline. Two invariants carry
    the value and are pinned here:

      1. one line per CROSSING, never per cycle (a stuck engine must not rewrite
         the journal every 15 minutes, or the relay reports one crossing for
         ever and the operator cannot tell a new outage from an old one),
      2. recovery CLEARS the marker, or a healthy fleet keeps reading an outage
         that ended hours ago.

    Every case dot-sources the real watchdog into a sandbox -ClaudishHome and
    asserts on the SANDBOX log path: a sandboxed run that logs to production is
    lying about its blast radius (measured 2026-09-20, the drain dot-source
    lesson).
#>

BeforeAll {
    $script:WatchdogPath = (Resolve-Path (Join-Path $PSScriptRoot '..\claudish-watchdog.ps1')).Path
    Import-Module (Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1') -Force
}

Describe 'Get-EngineFatalStreakDecision (#530 gap 2: pure crossing rule)' {
    It 'stays quiet below the threshold and writes no marker' {
        $d = Get-EngineFatalStreakDecision -ConsecutiveFatal 0
        $d.Action | Should -Be 'arm'
        $d.Streak | Should -Be 1
        $d.WriteMarker | Should -BeFalse
    }

    It 'escalates exactly at the threshold and marks that crossing' {
        $d = Get-EngineFatalStreakDecision -ConsecutiveFatal 1
        $d.Action | Should -Be 'escalate'
        $d.Streak | Should -Be 2
        $d.WriteMarker | Should -BeTrue
    }

    It 'stays escalated ABOVE the threshold but marks nothing further' {
        # The measured failure this prevents: one outage, thirty cycles, thirty
        # journal lines — indistinguishable from thirty outages.
        foreach ($prev in 2, 3, 17) {
            $d = Get-EngineFatalStreakDecision -ConsecutiveFatal $prev
            $d.Action | Should -Be 'escalate'
            $d.Streak | Should -Be ($prev + 1)
            $d.WriteMarker | Should -BeFalse
        }
    }

    It 'honours an explicit threshold (the knob is real, not decorative)' {
        $d = Get-EngineFatalStreakDecision -ConsecutiveFatal 2 -Threshold 4
        $d.Action | Should -Be 'arm'
        $d.WriteMarker | Should -BeFalse
    }
}

Describe 'Register-EngineFatal / Reset-EngineFatalStreak (#530 gap 2: the watchdog half)' {
    BeforeEach {
        $script:SandboxHome = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $script:SandboxHome -Force | Out-Null
        . $script:WatchdogPath -ClaudishHome $script:SandboxHome
        $script:StatePath = Join-Path $script:SandboxHome 'watchdog-state.json'
        $script:MarkerPath = Join-Path $script:SandboxHome (Get-EngineFatalStreakMarkerName)
        $script:WatchdogLog = Join-Path $script:SandboxHome 'watchdog.log'
    }

    It 'the sandbox is real: log, state and marker all land under the sandbox home' {
        # Without this, every assertion below could be reading production.
        # $LogPath is the dot-sourced script's own variable (unscoped, like the
        # existing relaunch suite); a $script:-scoped copy would be a different variable.
        $LogPath | Should -Be (Join-Path $script:SandboxHome 'watchdog.log')
        Register-EngineFatal 'unit probe'
        Test-Path $script:StatePath | Should -BeTrue
        (Join-Path $script:SandboxHome 'watchdog.log') | Should -Exist
    }

    It 'cycle 1: counts the streak, writes no marker, claims no escalation' {
        Register-EngineFatal 'engine did not recover'

        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 1
        Test-Path $script:MarkerPath | Should -BeFalse

        $log = Get-Content $script:WatchdogLog -Raw
        $log | Should -Match 'ENGINE-FATAL-STREAK: 1 consecutive FATAL'
        $log | Should -Not -Match 'ENGINE-FATAL-ESCALATE'
    }

    It 'cycle 2: crosses the threshold, writes the marker ONCE' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'

        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 2
        Test-Path $script:MarkerPath | Should -BeTrue
        @(Get-Content $script:MarkerPath).Count | Should -Be 1
        (Get-Content $script:MarkerPath -Raw) | Should -Match 'streak=2'
        (Get-Content $script:WatchdogLog -Raw) | Should -Match 'ENGINE-FATAL-ESCALATE'
    }

    It 'cycle 3+: stays escalated but does NOT rewrite the journal' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        $before = Get-Content $script:MarkerPath -Raw

        Register-EngineFatal 'third'
        Register-EngineFatal 'fourth'

        (Get-Content $script:MarkerPath -Raw) | Should -Be $before
        @(Get-Content $script:MarkerPath).Count | Should -Be 1
        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 4
    }

    It 'the marker carries no BOM (Windows PowerShell 5.1 writes one by default)' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        $bytes = [System.IO.File]::ReadAllBytes($script:MarkerPath)
        # EF BB BF would make a naive downstream parser treat the first
        # timestamp as part of a key.
        ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) | Should -BeFalse
    }

    It 'recovery resets the counter AND clears the marker' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        Test-Path $script:MarkerPath | Should -BeTrue

        Reset-EngineFatalStreak

        $state = Get-Content $script:StatePath -Raw | ConvertFrom-Json
        $state.consecutiveEngineFatal | Should -Be 0
        Test-Path $script:MarkerPath | Should -BeFalse
        (Get-Content $script:WatchdogLog -Raw) | Should -Match 'reset after an engine-healthy cycle \(was 2\)'
    }

    It 'a reset with nothing to reset is silent (no line per healthy cycle)' {
        Reset-EngineFatalStreak
        $log = if (Test-Path $script:WatchdogLog) { Get-Content $script:WatchdogLog -Raw } else { '' }
        $log | Should -Not -Match 'ENGINE-FATAL-STREAK: reset'
    }

    It 'a second crossing after a recovery journals again (new outage, new line)' {
        Register-EngineFatal 'first'
        Register-EngineFatal 'second'
        Reset-EngineFatalStreak
        Register-EngineFatal 'third'
        Register-EngineFatal 'fourth'

        @(Get-Content $script:MarkerPath).Count | Should -Be 1
        (Get-Content $script:MarkerPath -Raw) | Should -Match 'reason=fourth'
    }

    It 'never throws: an unwritable marker degrades to a log line' {
        # The FATAL exit belongs to the call site; the escalation helper must
        # not turn a diagnosable outage into an unhandled exception.
        { Register-EngineFatal 'first'; Register-EngineFatal 'second' } | Should -Not -Throw
    }
}

Describe 'Main wiring AST guard (#618 review: the wiring IS the feature)' {
    # Every case above calls Register/Reset DIRECTLY — none runs Main. Two
    # regressions would stay silent under that: a FATAL exit 1 that forgets
    # to Register (the 18/10 class goes quiet again), and a healthy path
    # that forgets to Reset (a marker survives recovery and the worker
    # relays a phantom outage forever). "Parameter tested directly !=
    # parameter passed" — pinned statically, wedge-guard style, with the
    # line named in every failure and synthetic positive controls through
    # the SAME detector.

    BeforeAll {
        # Detects wiring gaps in any parsed script. Returns gap strings
        # naming file:line. Two rules:
        #  R1: a Main-level `exit 1` whose enclosing block logs FATAL or
        #      calls Start-DockerEngine must be preceded, in that same
        #      block, by Register-EngineFatal (the two engine-failed exits
        #      carry no FATAL line of their own — Start-DockerEngine is
        #      their marker; the post-restart CRITICAL exit is deliberately
        #      exempt: the engine answered, that is a serving failure).
        #  R2: the running-path `if ($inspect.Ok ... "running")` body must
        #      contain Reset-EngineFatalStreak, and so must the
        #      "RECOVERED: Container started" block (it exits before the
        #      early reset).
        function Find-EngineFatalWiringGaps {
            param([System.Management.Automation.Language.Ast]$Root, [string]$Name)

            $gaps = @()
            $funcs = @($Root.FindAll({
                param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]
            }, $true))

            foreach ($exitCmd in @($Root.FindAll({
                # `exit 1` parses as an ExitStatementAst (NOT a CommandAst —
                # measured on pwsh 7.6: zero CommandAst named exit in a file
                # full of them); the extent text is exactly `exit 1`, so an
                # `exit $(...)` or `exit 0` never matches.
                param($n)
                $n -is [System.Management.Automation.Language.ExitStatementAst] -and
                $n.Extent.Text -match '^exit\s+1\s*$'
            }, $true))) {
                $insideFn = $false
                foreach ($f in $funcs) {
                    if ($f.Extent.StartOffset -le $exitCmd.Extent.StartOffset -and
                        $exitCmd.Extent.EndOffset -le $f.Extent.EndOffset) { $insideFn = $true; break }
                }
                if ($insideFn) { continue }

                $block = $exitCmd.Parent
                while ($block -and $block -isnot [System.Management.Automation.Language.StatementBlockAst]) {
                    $block = $block.Parent
                }
                if (-not $block) { continue }
                # Search the enclosing STATEMENT subtree, not just the block:
                # the two Start-DockerEngine-failed exits carry their marker in
                # the if CONDITION (`if (-not (Start-DockerEngine)) { …; exit 1 }`),
                # which is outside the body block's own subtree.
                $stmt = $block.Parent
                if (-not $stmt) { $stmt = $block }

                $logsFatal = $false; $callsEngineStart = $false; $registerBefore = $false
                foreach ($cmd in $stmt.FindAll({
                    param($n) $n -is [System.Management.Automation.Language.CommandAst]
                }, $true)) {
                    $cname = $cmd.GetCommandName()
                    if ($cname -eq 'Write-Log' -and $cmd.CommandElements.Count -ge 2 -and
                        $cmd.CommandElements[1].Extent.Text -match 'FATAL') { $logsFatal = $true }
                    if ($cname -eq 'Start-DockerEngine') { $callsEngineStart = $true }
                    if ($cname -eq 'Register-EngineFatal' -and
                        $cmd.Extent.StartLineNumber -lt $exitCmd.Extent.StartLineNumber) { $registerBefore = $true }
                }
                if (($logsFatal -or $callsEngineStart) -and -not $registerBefore) {
                    $gaps += ('{0}: exit 1 at line {1} (FATAL/engine-fail block) has no Register-EngineFatal before it' -f
                        $Name, $exitCmd.Extent.StartLineNumber)
                }
                if ($logsFatal -or $callsEngineStart) { $script:RequiredExits++ }
            }

            # R2 — the two load-bearing resets, found structurally.
            # Clauses are Tuple<Condition, Body>: .Item1 the condition,
            # .Item2 the body — there is no .Condition/.Body property (the
            # same API surface on 5.1 and 7.x). The condition is matched by
            # `-eq "running"` AND the absence of `-ne "running"`: the
            # NOT-running branch one screen up contains both substrings and
            # its body legitimately holds the RECOVERED reset — matching it
            # made this guard blind to the early reset's deletion (measured:
            # M2 mutant survived until the -ne exclusion).
            $runningIf = @($Root.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.IfStatementAst] -and
                $n.Clauses[0].Item1.Extent.Text -match '\$inspect\.Ok' -and
                $n.Clauses[0].Item1.Extent.Text -match '-eq "running"' -and
                $n.Clauses[0].Item1.Extent.Text -notmatch '-ne "running"'
            }, $true))
            if ($runningIf.Count -eq 0) {
                $gaps += "${Name}: the running-path if (`$inspect.Ok ...) is gone — no early Reset found"
            } else {
                $body = $runningIf[0].Clauses[0].Item2
                $hasReset = @($body.FindAll({
                    param($n)
                    $n -is [System.Management.Automation.Language.CommandAst] -and
                    $n.GetCommandName() -eq 'Reset-EngineFatalStreak'
                }, $true)).Count -gt 0
                if (-not $hasReset) {
                    $gaps += ('{0}: the running-path if body (line {1}) lost its Reset-EngineFatalStreak' -f
                        $Name, $runningIf[0].Extent.StartLineNumber)
                }
            }
            $recoveredLog = @($Root.FindAll({
                param($n)
                $n -is [System.Management.Automation.Language.CommandAst] -and
                $n.GetCommandName() -eq 'Write-Log' -and
                $n.CommandElements.Count -ge 2 -and
                $n.CommandElements[1].Extent.Text -match 'RECOVERED: Container started'
            }, $true))
            if ($recoveredLog.Count -eq 0) {
                $gaps += "${Name}: the RECOVERED: Container started log line is gone"
            } else {
                $block = $recoveredLog[0].Parent
                while ($block -and $block -isnot [System.Management.Automation.Language.StatementBlockAst]) {
                    $block = $block.Parent
                }
                $hasReset = $block -and @($block.FindAll({
                    param($n)
                    $n -is [System.Management.Automation.Language.CommandAst] -and
                    $n.GetCommandName() -eq 'Reset-EngineFatalStreak'
                }, $true)).Count -gt 0
                if (-not $hasReset) {
                    $gaps += ('{0}: the RECOVERED block (line {1}) lost its Reset-EngineFatalStreak' -f
                        $Name, $recoveredLog[0].Extent.StartLineNumber)
                }
            }
            return $gaps
        }

        $tokens = $null; $errs = $null
        $script:WdAst = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:WatchdogPath, [ref]$tokens, [ref]$errs)
        $script:RequiredExits = 0
        $script:Gaps = Find-EngineFatalWiringGaps -Root $script:WdAst -Name 'claudish-watchdog.ps1'
        # Snapshot: the positive-control Its below call the detector too and
        # would move the live counter — pin the count of the REAL file.
        $script:RequiredCount = $script:RequiredExits
    }

    It 'R1: every FATAL / engine-fail exit 1 registers before it; R2: both recovery resets exist' {
        $script:Gaps | Should -BeNullOrEmpty
    }

    It 'the guard sees the four register sites (not matching nothing)' {
        # The detector must have something to guard — a filter that silently
        # matches zero blocks passes R1 for the wrong reason.
        $script:RequiredCount | Should -Be 4 -Because 'four FATAL/engine-fail exit 1 blocks exist in Main'
    }

    It 'positive control: a FATAL exit without Register is flagged, with the line' {
        $bad = @'
if (-not (Start-DockerEngine)) {
    Write-Log "FATAL: engine did not recover"
    exit 1
}
'@
        $tokens = $null; $errs = $null
        $badAst = [System.Management.Automation.Language.Parser]::ParseInput($bad, [ref]$tokens, [ref]$errs)
        $gaps = Find-EngineFatalWiringGaps -Root $badAst -Name 'synthetic'
        # R2's "if gone / RECOVERED gone" gaps also fire on a bare snippet —
        # the R1 hit is asserted by exact message.
        $gaps | Should -Contain 'synthetic: exit 1 at line 3 (FATAL/engine-fail block) has no Register-EngineFatal before it'
    }

    It 'positive control: a running-path if without Reset is flagged' {
        $bad = @'
if ($inspect.Ok -and $containerStatus -eq "running") { Write-Log "up" }
'@
        $tokens = $null; $errs = $null
        $badAst = [System.Management.Automation.Language.Parser]::ParseInput($bad, [ref]$tokens, [ref]$errs)
        $gaps = Find-EngineFatalWiringGaps -Root $badAst -Name 'synthetic2'
        $gaps | Should -Not -BeNullOrEmpty
        $gaps[0] | Should -Match 'running-path if body \(line 1\)'
    }
}
