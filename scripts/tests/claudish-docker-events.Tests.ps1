<#
    Pester 5 suite for the docker-events collector (jsboige/claudish#169).

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — what the task runs)

    WHY THIS EXISTS
    ---------------
    During the 2026-09-20 hub incident (5-6 restart windows 03:49Z→09:07Z plus a
    recreate at 09:13Z) nobody could say WHO restarted what, or with which exit
    code: `docker events` evicts its ring buffer in ~35 min, and RestartCount
    stayed 0 because the gestures were manual `compose up/start`, not the restart
    policy. The information existed while the event was happening and nobody
    wrote it down. This collector writes it down.

    The numbers asserted below come from REAL captures taken on po-2024 while
    building this (2026-09-20): a throwaway container was created and removed,
    and the bounded window returned exactly these two JSON lines. They are the
    positive control for the whole instrument — the collector must be shown able
    to SEE an event before its silence on a window can mean anything.

    MEASURED, on Docker Desktop 29.8.0 (po-2024, 2026-09-20), four argument
    forms, each killed at 12s with 0 lines and no error:
        docker events --since <rfc3339> --until <rfc3339>
        docker events --since <rfc3339>            (follow mode expected)
        docker events --since 30m --until 29m
        docker events --since ... --format "{{json .}}"
    => `docker events` DOES NOT SELF-TERMINATE here, even with an explicit past
    `--until`. The collector therefore BOUNDS the process and treats the kill as
    the window close — the inverse of Invoke-DockerBounded, where TimedOut means
    failure. On a stock Linux daemon the same code is still correct: the process
    exits on its own and the verdict simply reads 'closed-by-until'.

    Also measured, and each already produced a wrong answer before being fixed:
      - `--until now` is REJECTED ("failed to parse value as time or duration").
      - Start-Process -ArgumentList with '{{json .}}' (a SPACE inside) is split
        into two bare arguments and docker answers "'docker events' accepts no
        arguments". The existing Invoke-DockerBounded calls never hit this
        because their formats ({{.State.Status}}) contain no space.
#>

BeforeAll {
    $script:ModulePath = Join-Path $PSScriptRoot '..\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force
    $script:ScriptsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

    # Real captures. Provenance guards below assert the numbers, so a silently
    # replaced sample fails loudly instead of being asserted as if it were these.
    $script:RealCreateLine = '{"Type":"container","Action":"create","Actor":{"ID":"d15c57124d682e7f32917e76e5c0092c8f81f062795295cb685605d9a4bc0f1d","Attributes":{"desktop.docker.io/ports.scheme":"v2","image":"python:3.11","name":"claudish-events-probe"}},"scope":"local","time":1789925336,"timeNano":1789925336873320889}'
    $script:RealDestroyLine = '{"Type":"container","Action":"destroy","Actor":{"ID":"d15c57124d682e7f32917e76e5c0092c8f81f062795295cb685605d9a4bc0f1d","Attributes":{"desktop.docker.io/ports.scheme":"v2","image":"python:3.11","name":"claudish-events-probe"}},"scope":"local","time":1789925337,"timeNano":1789925337128952114}'
    # Shape of a die event, which is where the exit code the issue asks for lives.
    $script:RealDieShape = '{"Type":"container","Action":"die","Actor":{"ID":"1927f99cbb06aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Attributes":{"exitCode":"137","image":"coursia-lean-runner:2.337.0","name":"lean_cli_111b5c999b1245ce9a1eda10461a348a"}},"scope":"local","time":1789925400,"timeNano":1789925400000000000}'
}

Describe 'ConvertFrom-DockerEventLine' {
    It 'parses a REAL capture and keeps the fields attribution needs' {
        $e = ConvertFrom-DockerEventLine -Line $script:RealCreateLine
        # Provenance guard: if the sample is ever replaced, fail here rather than
        # assert the new file's numbers as if they were these.
        $e.TimeNano | Should -Be 1789925336873320889
        $e.Action | Should -Be 'create'
        $e.Type | Should -Be 'container'
        $e.ContainerId | Should -Be 'd15c57124d682e7f32917e76e5c0092c8f81f062795295cb685605d9a4bc0f1d'
        $e.Name | Should -Be 'claudish-events-probe'
        $e.Image | Should -Be 'python:3.11'
    }

    It 'surfaces the exit code on a die event — the field the issue could not recover' {
        $e = ConvertFrom-DockerEventLine -Line $script:RealDieShape
        $e.Action | Should -Be 'die'
        $e.ExitCode | Should -Be '137'
    }

    It 'leaves ExitCode empty when the event carries none (create/destroy do not)' {
        (ConvertFrom-DockerEventLine -Line $script:RealCreateLine).ExitCode | Should -BeNullOrEmpty
    }

    It 'returns $null for empty, whitespace and non-JSON lines instead of throwing' {
        foreach ($bad in @('', '   ', 'not json at all', '[1,2,3]', '{"no":"action"}')) {
            ConvertFrom-DockerEventLine -Line $bad | Should -BeNullOrEmpty
        }
    }

    It 'never throws on a line that is valid JSON but the wrong shape' {
        { ConvertFrom-DockerEventLine -Line '{"Type":"container","Actor":"not-an-object"}' } | Should -Not -Throw
    }
}

Describe 'Get-DockerEventGroupVerdict — the 2026-08-30 attribution discipline' {
    # The error this encodes: 38 containers with StartedAt inside 0.4s was read
    # as a targeted action, when simultaneity across many containers IS the
    # signature of a host/daemon event. The verdict must never name an actor:
    # the file records what happened, a human attributes it.

    It 'calls a tight multi-container burst a shared cause, and names no actor' {
        # The measured 2026-08-30 shape shrunk to 8: 38 containers inside 0.4 s.
        $events = @()
        foreach ($i in 1..8) {
            $id = ('{0:x2}' -f $i) * 32
            $events += ConvertFrom-DockerEventLine -Line ('{"Type":"container","Action":"die","Actor":{"ID":"' + $id + '","Attributes":{"exitCode":"0","name":"c' + $i + '"}},"timeNano":' + (1789925400000000000 + $i * 40000000) + '}')
        }
        $v = Get-DockerEventGroupVerdict -Events $events -GroupSpanMs 1000 -MinContainers 5
        $v.Verdict | Should -Be 'shared-cause'
        $v.DistinctContainers | Should -Be 8
        $v.Reason | Should -Match 'within'
        # No actor identity is ever surfaced by the verdict object.
        ($v | Get-Member -MemberType NoteProperty | ForEach-Object Name) | Should -Not -Contain 'Actor'
    }

    It 'counts DISTINCT containers, so eight events from one container is targeted' {
        $events = @()
        foreach ($i in 1..8) {
            $events += ConvertFrom-DockerEventLine -Line ('{"Type":"container","Action":"start","Actor":{"ID":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Attributes":{"name":"one"}},"timeNano":' + (1789925400000000000 + $i * 1000000) + '}')
        }
        $v = Get-DockerEventGroupVerdict -Events $events -GroupSpanMs 1000 -MinContainers 5
        $v.Verdict | Should -Be 'targeted'
        $v.DistinctContainers | Should -Be 1
    }

    It 'classifies eight DISTINCT containers inside the span as shared-cause' {
        $events = @()
        foreach ($i in 1..8) {
            $id = ('{0:x2}' -f $i) * 32
            $events += ConvertFrom-DockerEventLine -Line ('{"Type":"container","Action":"die","Actor":{"ID":"' + $id + '","Attributes":{"exitCode":"0","name":"c' + $i + '"}},"timeNano":' + (1789925400000000000 + $i * 40000000) + '}')
        }
        $v = Get-DockerEventGroupVerdict -Events $events -GroupSpanMs 1000 -MinContainers 5
        $v.Verdict | Should -Be 'shared-cause'
        $v.DistinctContainers | Should -Be 8
    }

    It 'an EMPTY window is none, never targeted — silence is not evidence of intent' {
        (Get-DockerEventGroupVerdict -Events @() -GroupSpanMs 1000 -MinContainers 5).Verdict | Should -Be 'none'
    }

    It 'spread-out events are targeted even with many distinct containers' {
        $events = @()
        foreach ($i in 1..8) {
            $id = ('{0:x2}' -f $i) * 32
            $events += ConvertFrom-DockerEventLine -Line ('{"Type":"container","Action":"die","Actor":{"ID":"' + $id + '","Attributes":{"name":"c' + $i + '"}},"timeNano":' + (1789925400000000000 + $i * 900000000) + '}')
        }
        (Get-DockerEventGroupVerdict -Events $events -GroupSpanMs 1000 -MinContainers 5).Verdict | Should -Be 'targeted'
    }
}

Describe 'Select-NewDockerEvents — cross-window dedupe' {
    # The window boundary is why this exists: the watermark cannot be assumed
    # exclusive (see Get-DockerEventsNextSince), so the same event can arrive in
    # two consecutive windows. Re-emitting it would double-count a restart.

    It 'keeps a brand-new event' {
        $e = ConvertFrom-DockerEventLine -Line $script:RealCreateLine
        $r = Select-NewDockerEvents -Events @($e) -Seen @()
        $r.Kept.Count | Should -Be 1
        $r.Skipped.Count | Should -Be 0
    }

    It 'skips the boundary duplicate and reports it as skipped, not as absent' {
        $e = ConvertFrom-DockerEventLine -Line $script:RealCreateLine
        $fp = Get-DockerEventFingerprint -Event $e
        $r = Select-NewDockerEvents -Events @($e) -Seen @($fp)
        $r.Kept.Count | Should -Be 0
        $r.Skipped.Count | Should -Be 1
    }

    It 'the fingerprint distinguishes two events of the same action on the same container' {
        $a = ConvertFrom-DockerEventLine -Line $script:RealCreateLine
        $b = ConvertFrom-DockerEventLine -Line $script:RealDestroyLine
        (Get-DockerEventFingerprint -Event $a) | Should -Not -Be (Get-DockerEventFingerprint -Event $b)
    }

    It 'the seen-ring is bounded, newest last, oldest dropped' {
        $seen = @()
        foreach ($i in 1..5) { $seen += "fp$i" }
        $r = Select-NewDockerEvents -Events @() -Seen $seen -SeenCap 3
        $r.Seen.Count | Should -Be 3
        $r.Seen | Should -Be @('fp3', 'fp4', 'fp5')
    }
}

Describe 'ConvertTo-DockerSinceInstant — the state-file round-trip' {
    # FOUND BY RUNNING IT, not by reading it (po-2024, 2026-09-20). The first
    # live tick wrote `"2026-09-20T17:34:59.356Z"` to the state file; the second
    # tick read it back and passed `--since "09/20/2026 17:34:59"` to docker,
    # which answered "failed to parse value as time or duration". ConvertFrom-Json
    # returns a [datetime], and [string] renders it in the AMBIENT culture.
    # Tick 1 looks perfect and the damage only lands on tick 2, fifteen minutes
    # later, on a machine nobody is watching. Hence this regression.

    It 'renders a JSON round-tripped DateTime as invariant RFC3339, not ambient culture' {
        $roundTripped = ('{"SinceUtc":"2026-09-20T17:34:59.356Z"}' | ConvertFrom-Json).SinceUtc
        # The value must be re-rendered invariantly whatever type came back.
        ConvertTo-DockerSinceInstant -Value $roundTripped | Should -Be '2026-09-20T17:34:59.356Z'
    }

    It 'the ambient culture cannot leak in — proven under a non-US culture' {
        # Under fr-FR a DateTime renders "20/09/2026 17:34:59"; docker accepts
        # neither spelling. The formatter pins InvariantCulture, so the result is
        # identical whichever culture is ambient.
        $prev = [System.Threading.Thread]::CurrentThread.CurrentCulture
        try {
            [System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('fr-FR')
            ConvertTo-DockerSinceInstant -Value ([datetime]::Parse('2026-09-20T17:34:59.356Z')) | Should -Be '2026-09-20T17:34:59.356Z'
            ([string]([datetime]::Parse('2026-09-20T17:34:59.356Z'))) | Should -Not -Be '2026-09-20T17:34:59.356Z'
        } finally {
            [System.Threading.Thread]::CurrentThread.CurrentCulture = $prev
        }
    }

    It 'accepts the string shape too (a hand-written or older state file)' {
        ConvertTo-DockerSinceInstant -Value '2026-09-20T17:34:59.356Z' | Should -Be '2026-09-20T17:34:59.356Z'
    }

    It 'converts a non-UTC offset to UTC rather than keeping the local wall clock' {
        ConvertTo-DockerSinceInstant -Value '2026-09-20T19:34:59.356+02:00' | Should -Be '2026-09-20T17:34:59.356Z'
    }

    It 'returns $null for unreadable input, so the caller falls back to re-reading' {
        # Fails toward the LOOKBACK (re-reads a window), never toward dropping it.
        foreach ($bad in @($null, '', '   ', 'not a date', 'garbage')) {
            ConvertTo-DockerSinceInstant -Value $bad | Should -BeNullOrEmpty
        }
    }
}

Describe 'Get-DockerEventsNextSince — the watermark' {
    # A watermark that moves BACKWARDS re-reads forever; one that jumps to 'now'
    # when events existed silently drops whatever the daemon had not flushed.

    It 'advances to the newest event seen' {
        $a = ConvertFrom-DockerEventLine -Line $script:RealCreateLine
        $b = ConvertFrom-DockerEventLine -Line $script:RealDestroyLine
        $r = Get-DockerEventsNextSince -Events @($b, $a) -KillInstantUtc '2026-09-20T18:00:00.000Z' -PreviousSinceUtc '2026-09-20T17:00:00.000Z'
        # 1789925337128952114 -> 2026-09-20T17:28:57.128Z
        $r.SinceUtc | Should -Match '^2026-09-20T17:28:57'
        $r.Reason | Should -Match 'newest event'
    }

    It 'falls back to the kill instant when the window saw nothing' {
        $r = Get-DockerEventsNextSince -Events @() -KillInstantUtc '2026-09-20T18:00:00.000Z' -PreviousSinceUtc '2026-09-20T17:00:00.000Z'
        $r.SinceUtc | Should -Be '2026-09-20T18:00:00.000Z'
        $r.Reason | Should -Match 'no events'
    }

    It 'NEVER goes backwards, even when handed an older event than the previous since' {
        $r = Get-DockerEventsNextSince -Events @($script:RealCreateLine | ForEach-Object { ConvertFrom-DockerEventLine -Line $_ }) -KillInstantUtc '2026-09-20T18:00:00.000Z' -PreviousSinceUtc '2026-09-20T19:00:00.000Z'
        ([datetime]::Parse($r.SinceUtc).ToUniversalTime()) | Should -BeGreaterOrEqual ([datetime]::Parse('2026-09-20T19:00:00.000Z').ToUniversalTime())
        $r.Reason | Should -Match 'monotone'
    }

    It 'is a no-op-safe on garbage input rather than throwing' {
        { Get-DockerEventsNextSince -Events $null -KillInstantUtc 'garbage' -PreviousSinceUtc 'also garbage' } | Should -Not -Throw
    }

    It 'a FAILED invocation holds the watermark — it must not write off an unread window' {
        # Measured 2026-09-20: a tick that failed on a malformed `--since` still
        # reported `next=...17:35:18.176Z`, permanently dropping the interval it
        # had just failed to read. Silence-as-absence is the defect class #169
        # exists to end; its own error path must not reintroduce it.
        $r = Get-DockerEventsNextSince -Events @() -KillInstantUtc '2026-09-20T18:00:00.000Z' -PreviousSinceUtc '2026-09-20T17:34:59.356Z' -InvocationOk $false
        $r.SinceUtc | Should -Be '2026-09-20T17:34:59.356Z'
        $r.Reason | Should -Match 'held'
        $r.SinceUtc | Should -Not -Be '2026-09-20T18:00:00.000Z'
    }

    It 'a failed invocation holds even when the window DID carry events' {
        $e = ConvertFrom-DockerEventLine -Line $script:RealDestroyLine
        $r = Get-DockerEventsNextSince -Events @($e) -KillInstantUtc '2026-09-20T18:00:00.000Z' -PreviousSinceUtc '2026-09-20T17:00:00.000Z' -InvocationOk $false
        $r.SinceUtc | Should -Be '2026-09-20T17:00:00.000Z'
    }

    It 'an OK invocation still advances normally (the guard is not a blanket hold)' {
        $r = Get-DockerEventsNextSince -Events @() -KillInstantUtc '2026-09-20T18:00:00.000Z' -PreviousSinceUtc '2026-09-20T17:00:00.000Z' -InvocationOk $true
        $r.SinceUtc | Should -Be '2026-09-20T18:00:00.000Z'
    }
}

Describe 'Get-DockerEventsInvocationVerdict — inverted semantics, stated' {
    # Invoke-DockerBounded calls TimedOut a FAILURE. Here a kill is how a healthy
    # window CLOSES (measured: docker events never self-terminates), so treating
    # it as failure would make every successful tick look broken.

    It 'a killed process WITH output is a success' {
        $v = Get-DockerEventsInvocationVerdict -Exited $false -ExitCode -1 -LineCount 2 -ErrorText ''
        $v.Ok | Should -Be $true
        $v.Reason | Should -Be 'closed-by-kill'
    }

    It 'a self-exit with output is a success too (the Linux daemon path)' {
        $v = Get-DockerEventsInvocationVerdict -Exited $true -ExitCode 0 -LineCount 3 -ErrorText ''
        $v.Ok | Should -Be $true
        $v.Reason | Should -Be 'closed-by-until'
    }

    It 'a killed process with NO output is still Ok — silence is a measurement, not a failure' {
        $v = Get-DockerEventsInvocationVerdict -Exited $false -ExitCode -1 -LineCount 0 -ErrorText ''
        $v.Ok | Should -Be $true
        $v.Reason | Should -Be 'closed-by-kill-silent'
    }

    It 'a docker that never launched is a failure, and carries why' {
        $v = Get-DockerEventsInvocationVerdict -Exited $true -ExitCode -1 -LineCount 0 -ErrorText 'docker: command not found'
        $v.Ok | Should -Be $false
        $v.Reason | Should -Match 'command not found'
    }

    It 'a non-zero exit WITH error text is a failure, not a rendered window' {
        $v = Get-DockerEventsInvocationVerdict -Exited $true -ExitCode 1 -LineCount 0 -ErrorText "docker: 'docker events' accepts no arguments"
        $v.Ok | Should -Be $false
        $v.Reason | Should -Match 'accepts no arguments'
    }
}

Describe 'Get-DockerEventsRotationPlan' {
    It 'does nothing while the log is under the cap' {
        (Get-DockerEventsRotationPlan -CurrentBytes 1000 -MaxBytes 5000000 -ExistingRotatedCount 0 -KeepRotated 5).Rotate | Should -Be $false
    }

    It 'rotates once over the cap and keeps the newest K' {
        $p = Get-DockerEventsRotationPlan -CurrentBytes 6000000 -MaxBytes 5000000 -ExistingRotatedCount 7 -KeepRotated 5
        $p.Rotate | Should -Be $true
        $p.Keep | Should -Be 5
    }

    It 'a zero or negative cap never rotates (a guard, not a rotation storm)' {
        (Get-DockerEventsRotationPlan -CurrentBytes 999999 -MaxBytes 0 -ExistingRotatedCount 0 -KeepRotated 5).Rotate | Should -Be $false
    }
}

Describe 'Add-DockerEventsTickRecord' {
    It 'records a silent tick, so a dead collector cannot read as a quiet one' {
        $s = Add-DockerEventsTickRecord -State $null -Record ([PSCustomObject]@{ AtUtc = '2026-09-20T18:00:00Z'; EventCount = 0; Reason = 'closed-by-kill-silent' }) -HistoryCap 48
        $s.History.Count | Should -Be 1
        $s.History[0].EventCount | Should -Be 0
    }

    It 'bounds the history, newest first' {
        $s = $null
        foreach ($i in 1..5) {
            $s = Add-DockerEventsTickRecord -State $s -Record ([PSCustomObject]@{ AtUtc = "2026-09-20T18:0$i`:00Z"; EventCount = $i; Reason = 'r' }) -HistoryCap 3
        }
        $s.History.Count | Should -Be 3
        $s.History[0].EventCount | Should -Be 5
        $s.History[2].EventCount | Should -Be 3
    }
}

Describe 'the collector never persists a command line (incident 2026-09-21)' {
    # WHAT THIS GUARDS. The first version filtered on `type=container` alone,
    # which admits exec_create/exec_start — and docker puts the EXECUTED COMMAND
    # LINE in their Action field. Any healthcheck passing a secret as an argument
    # was copied in clear text into the persisted, rotated log every 15 minutes,
    # including containers belonging to other workspaces on the same host.
    # Measured on ai-01 in a dry-run before installing: 328 events in 8s,
    # 328 of 328 carrying a command line, lifecycle events 0 of 328.
    #
    # The sample below is the SHAPE of the leak with a placeholder where the
    # secret was. Nothing observed is reproduced here: a test fixture is a
    # published artifact, and a redacted secret in a repo is still a disclosure
    # of where to look.

    BeforeAll {
        $script:ExecLeakShape = '{"Type":"container","Action":"exec_create: /bin/sh -c mysqladmin ping -h localhost -u root -pPLACEHOLDER-NOT-A-REAL-SECRET","Actor":{"ID":"aa27f99cbb06aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Attributes":{"image":"mariadb:11","name":"some-other-workspace-db"}},"scope":"local","time":1789925500,"timeNano":1789925500000000000}'
    }

    It 'strips the payload docker appends after the colon' {
        # Without this the membership test never matches and the verb sails
        # through an allowlist that names it.
        Get-DockerEventActionName -Action 'exec_create: /bin/sh -c secret' | Should -Be 'exec_create'
        Get-DockerEventActionName -Action 'health_status: healthy' | Should -Be 'health_status'
        Get-DockerEventActionName -Action 'start' | Should -Be 'start'
        Get-DockerEventActionName -Action '' | Should -Be ''
    }

    It 'the lifecycle allowlist names no exec_* action' {
        $actions = @(Get-DockerEventLifecycleActions)
        $actions.Count | Should -BeGreaterThan 5
        @($actions | Where-Object { $_ -like 'exec*' }) | Should -BeNullOrEmpty
        # The events the 2026-09-20 incident could not recover must be in it.
        $actions | Should -Contain 'die'
        $actions | Should -Contain 'start'
        $actions | Should -Contain 'destroy'
    }

    It 'the daemon-side filter asks for each lifecycle action and never for exec_*' {
        $filterArgs = @(Get-DockerEventsFilterArgs)
        # Positive control: the filter the original version had is still there,
        # so a test that matches nothing cannot pass by matching nothing.
        $filterArgs | Should -Contain 'type=container'
        foreach ($a in @(Get-DockerEventLifecycleActions)) {
            $filterArgs | Should -Contain ("event={0}" -f $a)
        }
        @($filterArgs | Where-Object { $_ -match 'exec' }) | Should -BeNullOrEmpty
    }

    It 'drops an exec event carrying a command line, keeps the lifecycle event' {
        $leak = ConvertFrom-DockerEventLine -Line $script:ExecLeakShape
        $leak | Should -Not -BeNullOrEmpty   # it parses — that is why it leaked
        $ok = ConvertFrom-DockerEventLine -Line $script:RealCreateLine

        $sel = Select-LifecycleDockerEvents -Events @($leak, $ok)
        @($sel.Kept).Count | Should -Be 1
        $sel.Kept[0].Action | Should -Be 'create'
        @($sel.Dropped).Count | Should -Be 1
        # And the dropped one is counted, never written: "filtered" must stay
        # distinguishable from "the daemon was quiet".
        $sel.Dropped[0].Action | Should -BeLike 'exec_create*'
    }

    It 'refuses exec_* EVEN IF an operator widens the allowlist' {
        # The allowlist says which events are useful. This says which are never
        # safe to write down. Different questions, so widening one must not
        # silently answer the other.
        $leak = ConvertFrom-DockerEventLine -Line $script:ExecLeakShape
        $sel = Select-LifecycleDockerEvents -Events @($leak) -Actions @('create', 'exec_create', 'exec_start')
        @($sel.Kept) | Should -BeNullOrEmpty
        @($sel.Dropped).Count | Should -Be 1
    }

    It 'exec noise cannot manufacture the shared-cause verdict' {
        # 5 distinct containers inside one second is the host-wide-event signal.
        # Healthchecks fire on every container at once, so unfiltered exec events
        # would make the collector report a shared cause on a perfectly calm host
        # — inventing the very evidence it exists to supply.
        $events = @()
        foreach ($i in 1..6) {
            $line = $script:ExecLeakShape -replace 'aa27f99cbb06', ('bb{0}7f99cbb06' -f $i)
            $events += (ConvertFrom-DockerEventLine -Line $line)
        }
        # Positive control: unfiltered, this population DOES read as shared-cause.
        (Get-DockerEventGroupVerdict -Events $events -GroupSpanMs 1000 -MinContainers 5).Verdict |
            Should -Be 'shared-cause'
        # Filtered, there is nothing left to draw a verdict from.
        $kept = @((Select-LifecycleDockerEvents -Events $events).Kept)
        $kept | Should -BeNullOrEmpty
    }

    It 'the collector filters at the source AND guards at the sink' {
        $path = Join-Path $script:ScriptsRoot 'docker-events-collect.ps1'
        $src = Get-Content -LiteralPath $path -Raw
        $src | Should -Match 'Get-DockerEventsFilterArgs'
        $src | Should -Match 'Select-LifecycleDockerEvents'
        # The bare filter is what leaked. It must no longer be the only one, i.e.
        # it must not appear as a hardcoded argument list in the invocation.
        $src | Should -Not -Match "@\('events',\s*'--since',\s*\`$sinceUtc,\s*'--filter',\s*'type=container'"
        # And the guard must run BEFORE the write, not after it.
        $guardAt = $src.IndexOf('Select-LifecycleDockerEvents -Events')
        $writeAt = $src.IndexOf('Write-EventsAppend -JsonLines')
        $guardAt | Should -BeGreaterThan 0
        $writeAt | Should -BeGreaterThan 0
        $guardAt | Should -BeLessThan $writeAt
    }
}

Describe 'the collector contains no actuator' {
    # Same shape and the same reasoning as the wedge path's AC4 test: collecting
    # is not acting. A collector that "helpfully" restarts something on a
    # suspicious event is how a remediation tears down a component it cannot
    # rebuild (#173).

    It 'no Restart-*/Stop-* cmdlet and no docker stop/restart/kill in the collector' {
        $path = Join-Path $script:ScriptsRoot 'docker-events-collect.ps1'
        (Test-Path -LiteralPath $path) | Should -Be $true
        $tokens = $null; $errs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errs)
        $offenders = @()
        foreach ($n in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true)) {
            $name = $n.GetCommandName()
            if ($name -match '^(Restart|Stop|Start)-') { $offenders += ('{0}: {1}' -f $n.Extent.StartLineNumber, $name) }
            if ($n.Extent.Text -match 'docker\s+(stop|restart|kill)\b') { $offenders += ('{0}: docker stop/restart/kill' -f $n.Extent.StartLineNumber) }
            if ($n.Extent.Text -match '-Verb\s+RunAs') { $offenders += ('{0}: -Verb RunAs' -f $n.Extent.StartLineNumber) }
        }
        $offenders | Should -BeNullOrEmpty
    }

    It 'the actuator detector actually detects (positive control)' {
        $tokens = $null; $errs = $null
        $bad = [System.Management.Automation.Language.Parser]::ParseInput(
            'docker restart claudish-proxy', [ref]$tokens, [ref]$errs)
        $hits = @($bad.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true) |
            Where-Object { $_.Extent.Text -match 'docker\s+(stop|restart|kill)\b' })
        $hits.Count | Should -Be 1
    }
}
