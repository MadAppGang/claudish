<#
.SYNOPSIS
  Split-brain / ghost-session scan for a Claude Code host (read-only).

.DESCRIPTION
  Answers four questions a fleet operator actually asks, each from a source
  that is authoritative for that question — never from a proxy signal:

    1. Which Claude sessions are LIVE on this machine right now?
       Source: transcript files under <ProjectsRoot>\<project>\<session>.jsonl,
       by mtime. A session id spread over MORE THAN ONE file is flagged
       DUPLICATE — the one shape a split brain leaves behind at rest, since a
       single live session owns exactly one transcript.

    2. Which processes are behind them, and did anything double-fire?
       Source: ONE unfiltered Win32_Process snapshot (CIM, not Get-Process —
       the latter fails silently on VS Code "utility-node" parents and invents
       ghost parents, measured 2026-10-04 po-2024). A claude.exe carries NO
       session id in its command line when VS Code spawns it (--output-format
       stream-json stdio), so process->session mapping is impossible by
       design: the session check is (1), the process check is the double-fire
       signature — THE SAME COMMAND STARTED TWICE BY THE SAME PARENT in the
       window — never a same-name burst: one Claude Code session legitimately
       launches several MCP servers at once (launcher+server node.exe each,
       DISTINCT command lines), so any name/threshold burst is in permanent
       alarm on a real host (measured on ai-01, review #342: rc=1, 20
       PROCESS-BURST flags on a healthy machine — 21:06:27Z session start,
       3 MCPs = 6 node.exe under explorer.exe); and never a
       same-command-different-parent burst either: after a host reboot + VS
       Code update, ELEVEN restored windows each launched an identical
       450-char claude.exe command under ELEVEN DISTINCT Code.exe parents and
       the (name, command) key flagged them all (rc=1, 35 flags, 2026-10-05
       20:40:17-20:41:54Z) — the parent pid joined the key after that. The
       single snapshot also serves root-ancestor
       resolution for the display — a per-process filtered query costs
       ~1.5 s each and a 40-process scan spent a minute on them (review #342).

    3. Are the scheduled launchers sane?
       Source: Get-ScheduledTask, EVERY action of each task (a task with
       several actions is inspected on each — a first-action-only read misses
       a direct claude launch hidden as action #2, review #342). Flags: an
       action launching `claude` WITHOUT the VBS/PowerShell indirection
       (repointing/leak signature, doctrine 2026-09-27), several actions
       sharing one target (real duplication — COUNT BY ACTION, NEVER BY NAME:
       one task with three triggers prints three identical rows in
       schtasks /v and is NOT a duplicate, measured 2026-10-05 po-2025), and
       a failing LastTaskResult in ANY state. Result codes are INTERPRETED,
       never tested by `!= 0`: the benign set is the NINE codes held in the
       code below (0 plus 0x800710E0 IgnoreNew-overlap and the SCHED_S_*
       status family 0x41300-0x41305, 0x41325 — READY, RUNNING, DISABLED,
       HAS_NOT_RUN, NO_MORE_RUNS, NOT_SCHEDULED, QUEUED are statuses, not
       failures); 0x41306 TERMINATED is deliberately NOT benign. Anything else
       non-zero flags — a Ready task whose last run died (LastTaskResult=1) is
       exactly the "ghost cron fails on every tick" shape the old Running-only
       test could not see.

    4. Which cron armings live in the session transcripts, and did two
       workspaces arm the same loop? (mandate #362, P2)
       Source: the CronCreate traces inside EVERY transcript under
       <ProjectsRoot>\<ws-dir>\<session>.jsonl — each arming is a
       "cron":"<expr>","prompt":"<text>" pair on a line that carries its own
       "timestamp". The roster keyed on (ws-dir, cron, prompt) keeps the LATEST
       arming per key: last= is what separates history from the living.
       Flags: DOUBLON — one prompt-root (first token of the prompt, e.g.
       /coordinate-adjoint) armed from MORE THAN ONE workspace dir with the
       dirs' latest armings within 48h of each other (the 2026-10-01 shape:
       CoursIA-2 worktrees armed their own /coordinate-adjoint while the main
       workspace held its — two simultaneous adjoint loops, the OpenAI burn).
       STALE — a prompt-root the CALLER declares alive (-AliveRoles) whose last
       arming exceeds -StaleDays (the /executor */30 secretary believed alive
       but last armed 2026-08-24). STALE is INFO and never flips the exit code:
       "reputed alive" is a belief the caller asserts, not something this scan
       measures, and an empty -AliveRoles (default) means the class never fires.

  READ-ONLY. No process, service, task or file is modified. A detector that
  acts on what it finds is the #173 shape (teardown without rebuild). The
  suite pins this with an AST guard.

  ⚠ Coverage limit, printed in the report: a NON-ELEVATED run is blind to
  SYSTEM-owned tasks (the #169 trap — an empty result is indistinguishable
  from absence). Run elevated for full task coverage; the session and process
  sections are complete either way.

  Exit codes: 0 = all three sources read, no flag · 1 = flags found ·
  2 = INCOMPLETE — a source was unreadable (ProjectsRoot absent, Win32_Process
  query failed, Get-ScheduledTask failed), so its section is blind and "no
  flag" there is a non-verdict. 2 outranks 1: a cron wrapper must never
  mistake blindness for clean.

  PROCESS-BURST flags a DOUBLE-FIRE only — the same command line started
  twice BY THE SAME PARENT within BurstWindowSec — because a burst of
  DISTINCT commands is what every healthy session start looks like, and the
  same command under distinct parents is what a VS Code window restore looks
  like (both measured on ai-01, review #342). A process whose command line is
  unreadable (access denied, non-elevated) is never grouped: two unknowns are
  not equal.

  Flags carry ISO 8601 UTC timestamps (machine-local times drift across hosts
  and against the hub's UTC logs).

.PARAMETER ActiveMinutes
  Transcript mtime window that counts as "live". Default 30.

.PARAMETER StaleDays
  Age beyond which a -AliveRoles prompt-root's last CronCreate arming prints an
  INFO STALE line. Default 14.

.PARAMETER AliveRoles
  Prompt-roots (first token of the cron prompt, e.g. '/executor') the caller
  declares alive. Empty (default) = the STALE class never fires: the belief
  that a role is alive is carried by the operator's roster, never discovered
  here.

.PARAMETER BurstWindowSec
  Birth window for the PROCESS-BURST double-fire signature: two or more
  processes launched BY ONE PARENT with an IDENTICAL command line within this
  many seconds. Default 3. A machine-wide co-birth count is ALSO printed
  unconditionally — raw visibility, no threshold.

.EXAMPLE
  pwsh -File scripts/split-brain-scan.ps1
  powershell -ExecutionPolicy Bypass -File scripts/split-brain-scan.ps1 -ActiveMinutes 120
  pwsh -File scripts/split-brain-scan.ps1 -AliveRoles '/executor','/coordinate-adjoint'
#>
[CmdletBinding()]
param(
    [int]$ActiveMinutes = 30,
    [string]$ProjectsRoot = (Join-Path $env:USERPROFILE '.claude\projects'),
    [int]$BurstWindowSec = 3,
    [int]$StaleDays = 14,
    [string[]]$AliveRoles = @()
)

$ErrorActionPreference = 'Continue'
$now = Get-Date
$flags = New-Object System.Collections.Generic.List[string]
$incomplete = New-Object System.Collections.Generic.List[string]

function Write-Section([string]$t) { Write-Output ''; Write-Output ("=== " + $t + " ===") }

# ---------------------------------------------------------------- 1. sessions
Write-Section "LIVE SESSIONS (transcripts touched in the last $ActiveMinutes min)"
$live = @()
if (Test-Path -LiteralPath $ProjectsRoot) {
    foreach ($proj in (Get-ChildItem -LiteralPath $ProjectsRoot -Directory -ErrorAction SilentlyContinue)) {
        foreach ($f in (Get-ChildItem -LiteralPath $proj.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)) {
            $age = ($now - $f.LastWriteTime).TotalMinutes
            if ($age -le $ActiveMinutes) {
                $live += [pscustomobject]@{
                    Session = $f.BaseName
                    Project = $proj.Name
                    AgeMin  = [math]::Round($age, 1)
                    SizeMB  = [math]::Round($f.Length / 1MB, 2)
                }
            }
        }
    }
} else {
    # Absent root = the whole section is blind, not "no sessions": the default
    # path can be reallocated by an env change, and an OK verdict built on an
    # unread source is the false-clean shape exit 2 exists for (review #342).
    $incomplete.Add("transcripts (no ProjectsRoot at '$ProjectsRoot')")
}
if ($live.Count -eq 0) {
    Write-Output "  (none)"
} else {
    $live | Sort-Object AgeMin | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
}

# the one at-rest split-brain shape: one session id, several transcript files
$dupes = $live | Group-Object Session | Where-Object { $_.Count -gt 1 }
foreach ($d in $dupes) {
    $flags.Add("DUPLICATE-SESSION: session $($d.Name) is live in $($d.Count) transcript files: " + (($d.Group | ForEach-Object { $_.Project }) -join ', '))
}
Write-Output ("  live sessions: {0}   distinct ids: {1}" -f $live.Count, ($live | Select-Object -ExpandProperty Session -Unique).Count)

# --------------------------------------------------------------- 2. processes
Write-Section "PROCESSES (claude / node / bun) and birth bursts"
$snap = @()
try {
    $snap = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
    Write-Output ("  (Win32_Process query failed: " + $_.Exception.Message + ")")
    $incomplete.Add('Win32_Process (process section blind)')
}
$allProcs = @{}
foreach ($p in $snap) { $allProcs[[int]$p.ProcessId] = $p }
$procs = @($snap | Where-Object { $_.Name -match '^(claude|node|bun)(\.exe)?$' })

function Get-RootAncestor([int]$procId) {
    # Walks the ONE snapshot — no per-process CIM round-trip. A parent pid
    # absent from the snapshot is gone-or-protected: the topmost reachable
    # node IS the root and is named. (The original branch queried the missing
    # parent and its catch was dead code — a filtered Win32_Process query for
    # a dead pid returns $null, it does not throw, so the "gone" case rendered
    # as an empty name; review #342.)
    $seen = @{}
    $cur = $procId
    while ($allProcs.ContainsKey($cur)) {
        if ($seen.ContainsKey($cur)) { return ("(cycle:" + $cur + ")") }
        $seen[$cur] = $true
        $par = [int]$allProcs[$cur].ParentProcessId
        if (-not $allProcs.ContainsKey($par)) {
            return ($allProcs[$cur].Name + "(" + $cur + ")")
        }
        $cur = $par
    }
    return ("(gone:" + $cur + ")")
}
$rows = @()
foreach ($p in $procs) {
    $rows += [pscustomobject]@{
        Pid       = [int]$p.ProcessId
        ParentPid = [int]$p.ParentProcessId
        Name      = $p.Name
        Started   = $p.CreationDate
        Cmd       = ("" + $p.CommandLine).Trim()
        Root      = (Get-RootAncestor ([int]$p.ProcessId))
    }
}
$rows | Sort-Object Started | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
Write-Output ("  total: {0}" -f $rows.Count)

# PROCESS-BURST = what a double-fire IS: THE SAME LAUNCHER starting THE SAME
# COMMAND twice in the window. Key = (parent pid, Name, command) — review
# #342, second pass. The first rework keyed on (Name, command) alone and the
# ai-01 live run refuted it: after the 19:56Z host reboot + VS Code update,
# ELEVEN restored windows each launched a Claude Code panel between
# 20:40:17 and 20:41:54Z — eleven claude.exe with the SAME 450-char command
# line (VS Code puts no session id on it) under ELEVEN DISTINCT Code.exe
# parents: 35 PROCESS-BURST flags, rc=1 at both interpreters, on a healthy
# machine. Measured on the same snapshot: (Name, command) groups 11 of them,
# (parent, Name, command) groups 0. A double-fire is the same LAUNCHER doing
# the same thing twice — an extension host opening two identical panels, a
# claude.exe launching one MCP server twice, two identical actions under one
# Schedule service — all still caught; two windows each restoring their panel
# is not that shape. The arguments are kept in the FLAG, exactly as DIRECT
# does; only equality is tested. Threshold 2: any second launch of an
# identical command by the same parent inside the window is a duplication,
# never a burst of distinct commands.
# A process whose CommandLine is UNREADABLE (access denied, non-elevated — 3
# on ai-01) enters NO equality group: "unavailable" is a rendering, not an
# identity, and two unknowns are not equal.
$groupable = @($rows | Where-Object { $_.Cmd })
foreach ($g in ($groupable | Group-Object ParentPid, Name, Cmd)) {
    $sorted = $g.Group | Sort-Object Started
    for ($i = 0; $i -lt $sorted.Count; $i++) {
        $j = $i
        while (($j + 1) -lt $sorted.Count -and (($sorted[$j + 1].Started - $sorted[$i].Started).TotalSeconds -le $BurstWindowSec)) { $j++ }
        if (($j - $i + 1) -ge 2) {
            # UTC ISO timestamp: machine-local times drift across hosts and
            # against the hub's UTC logs (review #342). The message is built
            # before Add(): `"..." -f a, b, c` inside a method call parses as
            # several Add() arguments and -f gets one arg for four
            # placeholders (measured 2026-10-05).
            $ts = ([datetime]$sorted[$i].Started).ToUniversalTime().ToString('o')
            $msg = "PROCESS-BURST: {0} x identical {1} command born within {2}s under parent {3} (first {4}) -> {5}" -f (($j - $i + 1), $sorted[$i].Name, $BurstWindowSec, $sorted[$i].ParentPid, $ts, $sorted[$i].Cmd)
            $flags.Add($msg)
            $i = $j
        }
    }
}

# Machine-wide co-birth count, printed unconditionally (info, never a flag):
# the per-parent grouping above answers "did ONE launcher start the same thing
# twice" and deliberately does NOT see the same command spawned by different
# parents — the legitimate VS Code window-restore shape (05/10) — so the raw
# number is what keeps that shape visible without flagging it.
$allSorted = @($rows | Sort-Object Started)
$maxCo = 0
for ($i = 0; $i -lt $allSorted.Count; $i++) {
    $j = $i
    while (($j + 1) -lt $allSorted.Count -and (($allSorted[$j + 1].Started - $allSorted[$i].Started).TotalSeconds -le $BurstWindowSec)) { $j++ }
    if (($j - $i + 1) -gt $maxCo) { $maxCo = ($j - $i + 1) }
}
Write-Output ("  machine-wide max co-births within {0}s (all roots): {1}" -f $BurstWindowSec, $maxCo)

# ------------------------------------------------------------------ 3. tasks
Write-Section "SCHEDULED TASKS (launcher shape and duplication)"
$tasks = @()
try {
    $tasks = Get-ScheduledTask -ErrorAction Stop
} catch {
    Write-Output ("  (Get-ScheduledTask failed: " + $_.Exception.Message + ")")
    $incomplete.Add('Get-ScheduledTask (task section blind)')
}

# ONE ROW PER MATCHING ACTION (review #342): a task with several actions is
# inspected on each — the first-action-only read missed a direct claude launch
# sitting as action #2 behind an innocent VBS action #1. Duplication below is
# counted by ACTION TARGET, never by task name and never by trigger count.
$info = @()
foreach ($t in $tasks) {
    foreach ($act in @($t.Actions)) {
        if (-not $act -or -not $act.Execute) { continue }
        $target = ("" + $act.Execute + " " + $act.Arguments).Trim()
        if ($target -notmatch 'claude|wscript|claude-hidden-launchers|compress-captures') { continue }
        # Per-task LastTaskResult may be unreadable (throttle/ACL): unknown is
        # NOT failed — the row stays with an empty cell, never a flag.
        $last = $null
        try { $last = (Get-ScheduledTaskInfo -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop).LastTaskResult } catch {}
        $wd = ''
        try { $wd = "" + $act.WorkingDirectory } catch {}
        $info += [pscustomobject]@{
            Name     = ($t.TaskPath + $t.TaskName)
            State    = ("" + $t.State)
            Triggers = (@($t.Triggers)).Count
            LastRes  = $last
            Target   = $target
            Execute  = ("" + $act.Execute)
            WorkDir  = $wd
        }
    }
}
# The table shows the EXECUTABLE and working directory, not the full target:
# arguments can carry tokens verbatim (the #192 healthcheck lesson). The
# PROCESS-BURST flag DOES echo the full command line — that is what the
# double-fire signature requires (review #342); a redaction seam here would
# have to be owned by the launcher conventions, which never embed secrets
# (the DirectSecretArg pin lives in the task section's tests).
$info | Sort-Object Name | Format-Table Name, State, Triggers, LastRes, Execute, WorkDir -AutoSize | Out-String -Width 220 | Write-Output
Write-Output ("  launcher-shaped actions visible: {0}   (a NON-ELEVATED run cannot see SYSTEM tasks)" -f $info.Count)

# real duplication = several actions sharing one target (NEVER by name alone —
# and same-target actions inside ONE task fire the launcher twice, which is a
# double-fire even though only one task name is involved)
foreach ($g in ($info | Group-Object Target | Where-Object { $_.Count -gt 1 })) {
    $names = @($g.Group | ForEach-Object { $_.Name } | Select-Object -Unique) -join ' | '
    $flags.Add("DUPLICATE-TASK: $($g.Count) actions share one target under: $names -> " + $g.Name)
}
# the repointing/leak signature: an action LAUNCHING the claude binary with no
# VBS/PowerShell indirection. Match a real launch, never a mere path that
# happens to contain "claude" (…\Temp\claude\<session>\… is a data path).
$launchesClaude = 'claude\.(exe|cmd|bat)\b|\bnpx\s+(@?anthropic[^\s]*\s+)?claude\b|(^|\s)claude\s+(-p|--print|--resume|--continue|--model)'
foreach ($t in $info) {
    if ($t.Target -match $launchesClaude -and $t.Target -notmatch 'wscript|\.vbs|\.ps1') {
        # Executable PATH only, arguments withheld — a task argument can carry
        # a credential in clear (review #342, the #192 healthcheck class).
        $flags.Add("DIRECT-CLAUDE-TASK: $($t.Name) launches the claude binary without the VBS/PowerShell indirection -> $($t.Execute) (arguments withheld — verify manually)")
    }
    # Task result codes are INTERPRETED, never tested by `!= 0` — benign
    # codes print a non-zero LastTaskResult on a perfectly healthy task
    # (0x800710E0 + 0x41301 measured 2026-10-05, po-2025; the SCHED_S_*
    # status family added on review #342, measured on ai-01: 82 tasks carry
    # 0x41303 — every freshly registered task flags until its first run):
    #   2147946720 = 0x800710E0  MultipleInstances=IgnoreNew refused a second
    #                            start while the previous instance still runs
    #                            (#199/#205) — the healthy overlap shape.
    #   267008     = 0x41300     SCHED_S_TASK_READY — a status, not a failure.
    #   267009     = 0x41301     SCHED_S_TASK_RUNNING = "still running".
    #   267010     = 0x41302     SCHED_S_TASK_DISABLED.
    #   267011     = 0x41303     SCHED_S_TASK_HAS_NOT_RUN — LastRunTime holds
    #                            the 1999 sentinel; not a ghost, not a failure.
    #   267012     = 0x41304     SCHED_S_TASK_NO_MORE_RUNS.
    #   267013     = 0x41305     SCHED_S_TASK_NOT_SCHEDULED.
    #   267045     = 0x41325     SCHED_S_TASK_QUEUED.
    # 0x41306 (267014) SCHED_S_TASK_TERMINATED is deliberately NOT benign —
    # a killed task is a signal. Any OTHER non-zero flags in ANY state
    # (review #342): the Running-only test was blind to a Ready task failing
    # on every tick.
    $benign = 0, 2147946720, 267008, 267009, 267010, 267011, 267012, 267013, 267045
    # Disabled tasks are skipped by STATE (#362 calibration, measured 15/10:
    # the machine-local \WMI-Startup-Capture, State=Disabled, carries a frozen
    # LastTaskResult=0xFFFD0000 and cried ~20 flags/day per machine, blocking
    # the kill-armament precondition). A task that cannot run reports frozen
    # history, never a live signal — and the skip stays state-scoped: #342's
    # "any state" intent holds for Ready/Running, so the same result code on
    # a Ready task still flags (pinned in the tests).
    if (($null -ne $t.LastRes) -and ($t.State -ne 'Disabled') -and ($benign -notcontains [long]$t.LastRes)) {
        $flags.Add(("TASK-NONZERO-RESULT: {0} State={1} LastTaskResult={2} (0x{3:X8})" -f $t.Name, $t.State, $t.LastRes, [long]$t.LastRes))
    }
}

# --------------------------------------------------------- 4. session roster
# Mandate #362 (session surveillance organ, P2): the cron roster is rebuilt
# from the transcripts themselves — every CronCreate a session ever issued is
# traced as a "cron":"<expr>","prompt":"<text>" pair on a line carrying its own
# "timestamp". Two anomaly classes, both measured 2026-10-06:
#   DOUBLON — CoursIA-2 worktrees armed their OWN /coordinate-adjoint while
#             the main workspace held its (2026-10-01: two adjoint loops
#             running simultaneously = the OpenAI burn);
#   STALE   — the /executor */30 secretary believed alive, whose last arming
#             dates from 2026-08-24.
Write-Section "SESSION-ROSTER (cron armings traced in transcripts)"
$roster = @{}
if (Test-Path -LiteralPath $ProjectsRoot) {
    foreach ($proj in (Get-ChildItem -LiteralPath $ProjectsRoot -Directory -ErrorAction SilentlyContinue)) {
        foreach ($f in (Get-ChildItem -LiteralPath $proj.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)) {
            # Deliberately NOT bounded by the mtime window of section 1: an
            # arming months old is exactly what the STALE class must see. The
            # prompt capture is capped at 90 chars and cut at the JSON
            # terminator '","' (defensive: the regex excludes quotes, so the
            # cut is a no-op on well-formed input) — the FULL prompt is never
            # kept, never printed: it is instruction text, not schedule data.
            foreach ($mi in (Select-String -LiteralPath $f.FullName -Pattern '"cron":"([^"]+)","prompt":"([^"]{0,90})"' -AllMatches -ErrorAction SilentlyContinue)) {
                $tsRaw = ''
                if ($mi.Line -match '"timestamp":"([^"]+)"') { $tsRaw = $Matches[1] }
                $ts = [datetime]::MinValue
                if ($tsRaw) {
                    try { $ts = [datetime]::Parse($tsRaw, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() } catch {}
                }
                foreach ($g in $mi.Matches) {
                    $pCut = $g.Groups[2].Value
                    # cut at the JSON terminator '","' (defensive: the capture's
                    # character class excludes quotes, so on well-formed input
                    # the cut never fires — it exists so the dedup key cannot
                    # grow a neighbor field even if the pattern is widened)
                    $cutIx = $pCut.IndexOf('","')
                    if ($cutIx -ge 0) { $pCut = $pCut.Substring(0, $cutIx) }
                    $pRoot = ($pCut -split '\s+')[0]
                    if (-not $pRoot) { continue }
                    $key = $proj.Name + '|' + $g.Groups[1].Value + '|' + $pCut
                    $e = $roster[$key]
                    if ($null -eq $e) {
                        $roster[$key] = [pscustomobject]@{ Ws = $proj.Name; Cron = $g.Groups[1].Value; Root = $pRoot; LastRaw = $tsRaw; Last = $ts }
                    } elseif ($ts -ge $e.Last) {
                        # LATEST arming wins per key — last= separates history
                        # from the living. An unparseable timestamp (MinValue)
                        # never displaces a good one.
                        $e.LastRaw = $tsRaw
                        $e.Last = $ts
                    }
                }
            }
        }
    }
} else {
    # Section 1 already flagged the absent root as INCOMPLETE — its blindness
    # covers this section too; do not double-count the source.
    Write-Output "  (skipped — no ProjectsRoot; already flagged INCOMPLETE above)"
}

# Per-root rollup: Dirs = distinct workspace dirs that ever armed the root,
# NewestLast = latest arming anywhere (the roster's "is this loop living?").
$rootRows = @()
$rootDirs = @{}
foreach ($g in ($roster.Values | Group-Object Root)) {
    $dirs = @{}
    foreach ($e in $g.Group) {
        if (-not $dirs.ContainsKey($e.Ws) -or $e.Last -gt $dirs[$e.Ws]) { $dirs[$e.Ws] = $e.Last }
    }
    $newest = [datetime]::MinValue
    foreach ($v in $dirs.Values) { if ($v -gt $newest) { $newest = $v } }
    $rootDirs[$g.Name] = $dirs
    # Cadences capped at 4 + counter: an auto-sized free-text column swallows
    # the whole table width and PowerShell DROPS the columns beyond it (measured
    # 2026-10-06 on the real projects dir: NewestLast — the one column the
    # operator needs — vanished behind /coordinate-adjoint's 15 cadences).
    $cads = @($g.Group | Select-Object -ExpandProperty Cron -Unique | Sort-Object)
    $cadTxt = if ($cads.Count -gt 4) { (($cads[0..3] -join ', ') + ('  +{0} more' -f ($cads.Count - 4))) } else { ($cads -join ', ') }
    $rootRows += [pscustomobject]@{
        Root       = $g.Name
        Dirs       = $dirs.Count
        Armings    = $g.Count
        NewestLast = $newest
        Cadences   = $cadTxt
    }
}
if ($rootRows.Count -eq 0) {
    Write-Output "  (no cron armings found in any transcript)"
} else {
    $rootRows | Sort-Object NewestLast -Descending |
        Format-Table Root, Dirs, Armings, @{L = 'NewestLast(UTC)'; E = { $_.NewestLast.ToString('yyyy-MM-ddTHH:mm') }}, Cadences -AutoSize |
        Out-String -Width 220 | Write-Output
}

# DOUBLON — same prompt-root armed from >1 workspace dir, the dirs' LATEST
# armings within 48h of the root's newest: two loops armed in the same window,
# the double-adjoint burn shape. A sibling dir whose last arming slid out of
# that 48h window is HISTORY, not a live double — that is what last= is for.
# Re-arming inside ONE dir (session restarts) is never a doublon.
foreach ($row in $rootRows) {
    $dirs = $rootDirs[$row.Root]
    if ($dirs.Count -lt 2) { continue }
    $live = @($dirs.GetEnumerator() | Where-Object { ($row.NewestLast - $_.Value).TotalHours -le 48 } | Sort-Object Value -Descending)
    if ($live.Count -lt 2) { continue }
    $names = ($live | ForEach-Object { '{0} (last {1})' -f $_.Key, $_.Value.ToString('o') }) -join '; '
    $msg = 'SESSION-ROSTER DOUBLON: prompt-root {0} armed from {1} workspace dirs within 48h: {2}' -f $row.Root, $live.Count, $names
    Write-Output ('  WARN ' + $msg)
    $flags.Add($msg)
}

# STALE — a prompt-root the CALLER declares alive (-AliveRoles) whose last
# arming exceeds -StaleDays. Opt-in by design: "reputed alive" is carried by
# the operator's roster, never discovered here, and an empty list means the
# class never fires. INFO severity — printed, never added to $flags: the
# discrepancy is real, but liveness was asserted, not measured.
foreach ($role in @($AliveRoles)) {
    $r = ('' + $role).Trim()
    if (-not $r) { continue }
    $entries = @($roster.Values | Where-Object { $_.Root -ieq $r })
    if ($entries.Count -eq 0) {
        Write-Output ('  INFO SESSION-ROSTER STALE: prompt-root {0} declared alive (-AliveRoles) but no CronCreate arming found in any transcript' -f $r)
        continue
    }
    $newest = ($entries | Sort-Object Last -Descending | Select-Object -First 1)
    $ageDays = ([datetime]::UtcNow - $newest.Last).TotalDays
    if ($ageDays -gt $StaleDays) {
        Write-Output ('  INFO SESSION-ROSTER STALE: prompt-root {0} declared alive (-AliveRoles) but last arming {1} ({2:N0} days ago, threshold {3} days)' -f $r, $newest.LastRaw, $ageDays, $StaleDays)
    }
}
Write-Output ('  roster: {0} distinct armings | {1} workspace dirs | {2} prompt roots (stale threshold {3} days, alive roles declared: {4})' -f $roster.Count, @($roster.Values | Select-Object -ExpandProperty Ws -Unique).Count, $rootRows.Count, $StaleDays, @($AliveRoles).Count)

# ----------------------------------------------------------------- 5. verdict
Write-Section "VERDICT"
if ($flags.Count -gt 0) {
    foreach ($f in $flags) { Write-Output ("  FLAG  " + $f) }
}
if ($incomplete.Count -gt 0) {
    foreach ($s in $incomplete) { Write-Output ("  INCOMPLETE SOURCE  " + $s) }
    Write-Output "  A blind source makes its section's 'no flag' a non-verdict — rerun with the source available (elevated for SYSTEM tasks)."
    exit 2
}
if ($flags.Count -eq 0) {
    # Scoped claim: this scan checks defined signatures; absence of a flag is
    # absence OF THOSE SIGNATURES, never proof that no split-brain exists.
    Write-Output "  OK - none of the checked signatures found (duplicate session, double-fired command, duplicate/direct launcher, failing task result, duplicate cron arming)."
}
Write-Output ""
Write-Output "  Sources: transcripts (live sessions), Win32_Process (bursts), Get-ScheduledTask (launchers), transcripts again (cron roster, #362)."
Write-Output "  Hub-side complement (which session burned which lane/model) lives in the #41 consumption organs, not here."
exit $(if ($flags.Count -gt 0) { 1 } else { 0 })
