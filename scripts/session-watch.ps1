<#
session-watch.ps1 — Session surveillance organ (detector-first, journal-only by default).

Background replacement for the interactive tripwire cron (#362-P4 reconciled; user 07/10:
surveillance "devrait etre l'objet d'un organe que tu lances en bg"). Scheduled task
ClaudishSessionWatch, non-elevated jsboi/Interactive/Limited, every 15 min — same class
as the failover/docker-events collectors (an instrument, NOT a schtasks worker).

Per tick:
  1. live-session-scan.py --hours 0.3 --json  (short-window tripwire, #362)
  2. OPENAI-SHAPED sessions:
       - remote machine         -> journal 'remote-openai'    (owning lane relays/acts)
       - CoursIA-2 workspace AND its worktrees -> journal 'exempt' (user-authorized
         adjoint, cron coordinate-adjoint, principal gpt-6-sol declared — NEVER
         killed, NEVER posted; unconditional, dominance-independent — user
         arbitration 06/10 23:05. B3, CR 08/10: the frontier is the boundary match
         ^d--dev-CoursIA-2(--|$) — worktree project dirs carry a
         '--claude-worktrees-*' suffix and the exact -eq left them killable)
       - local, sonnet-majority -> journal 'sonnet-majority'  (never killed)
       - workspace identity unestablished (transcript under no project dir)
                            -> journal 'no-workspace-identity' and STOP (B3, CR
         08/10: an empty $projectName must never traverse into the kill branch —
         consent + binding would reach StopProcess on a session we cannot place)
       - session_id empty/short -> journal 'skip-unattributed' BEFORE anything else
         (B1, CR 07/10: [regex]::Escape('') matches EVERY claude.exe CommandLine, so a
         sid-less line would bind-and-kill all sessions on the host once consent is
         armed, and -Filter "$sid8*.jsonl" degenerates to '*.jsonl' which resolves the
         first project that answers — starving the CoursIA-2 exemption of its verdict)
       - local, sol > 50%       -> kill path, gated by consent file
         $ClaudishHome\session-watch.kill.enabled (ABSENT = detector only); no binding
         + capture < 2 min old -> 'no-binding-recent' (never conclude "already exited");
         never kill a process not bound to the sid.
         BINDING HONESTY (N1, CR 07/10): a real claude.exe command line carries NO
         session id — the one live kill (06/10) bound via transcript CreationTime <->
         process CreationTime correlation instead. The CommandLine-substring binding is
         therefore near-inoperant BY DESIGN: pre-B1 the only "binding" class was the
         sid-less line (it matched everything); post-B1 the branch almost always
         journals 'no-binding-*'. Until a correlation-based binder lands, an armed kill
         is a tripwire of last resort, not an operative control.
       - local, sol-minority    -> journal 'sol-minority'     (WARN-class at relay)
  3. MiniMax coding catalog watch: GET /v1/models (key read from the hub config.json,
     NEVER journaled, never printed); new/retired id vs baseline file -> journal
     'new-model' / 'model-gone' (e.g. a future M3.1 Flash appearing, or MiniMax-M3
     being retired — both change routing).
  4. split-brain-scan.ps1 hook: journaled digest when the script exists (PR #342
     pending merge at time of writing).

Journal: $ClaudishHome\session-watch.log — one NDJSON line per event
{ts(UTC), kind, sid, detail}. Relayed to the workspace dashboard by the /worker cycle
(watermark $ClaudishHome\session-watch-relay.ts), same pattern as model-version-events.log.
NEVER truncate the journal (durable trace, post-mortem evidence).

Exit code is always 0 — a crashed tick is worse than a skipped one; failures journal
kind='error'. Kill arming is a deliberate operator act: create the consent file only
after >=24h of clean journal (see SKILL.md relay notes).
#>

param(
    [string]$ClaudishHome = (Join-Path $env:USERPROFILE '.claudish'),
    [string]$ScanScript = '',
    [string]$PythonExe = "$env:USERPROFILE\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe",
    [string]$HubConfig = 'D:\claudish-shadow\config\config.json',
    [string]$RepoScripts = 'D:\dev\claudish\scripts',
    [double]$WindowHours = 0.3,
    [switch]$DryRun,
    # Injectable seams (CR B2): tests pass fixtures so a kill-capable organ can be
    # pinned WITHOUT touching a live process list. Absent = production default,
    # normalized just below. Hub-first defaults note (N2): $PythonExe/$HubConfig/
    # $RepoScripts target po-2025 (the hub) — on any other machine pass them
    # explicitly; an absent scan script or hub config then journals 'scan-skip'/
    # 'catalog-skip' (benign, distinct from 'error') instead of failing every tick.
    [scriptblock]$RunScan = $null,
    # Workspace identity source (B3, CR 08/10): the transcripts root the identity
    # resolution walks. Injectable so the suite can plant project dirs in a
    # sandbox — a pin must never depend on (or touch) the real ~/.claude\projects.
    [string]$ProjectsRoot = (Join-Path $env:USERPROFILE '.claude\projects'),
    [scriptblock]$GetProcesses = $null,
    [scriptblock]$StopProcess = $null,
    [scriptblock]$GetSchTasks = $null,
    [scriptblock]$FetchCatalog = $null
)

$ErrorActionPreference = 'Continue'
if (-not $ScanScript) { $ScanScript = Join-Path $ClaudishHome 'live-session-scan.py' }
$JournalPath = Join-Path $ClaudishHome 'session-watch.log'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# N2 (CR): NO default installer for $RunScan — installing one here made the
# `if ($RunScan)` branch below always true in production, so the scan-skip
# elseif was dead code and the docstring's promise ('absent scan script
# journals scan-skip') never fired. The seam stays injection-only; a
# non-injected run reaches the real path/existence checks.
if (-not $GetProcesses) { $GetProcesses = { Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue } }
if (-not $StopProcess)  { $StopProcess  = { param($ProcessId) Stop-Process -Id $ProcessId -Force -Confirm:$false -ErrorAction Stop } }
if (-not $GetSchTasks)  { $GetSchTasks  = { & schtasks.exe /Query /FO CSV /V 2>$null } }
if (-not $FetchCatalog) { $FetchCatalog = { param($Url,$Key) Invoke-RestMethod -Uri $Url -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 20 -ErrorAction Stop } }

function Write-Journal {
    param([string]$Kind, [string]$Sid = '', [string]$Detail = '')
    $entry = [ordered]@{
        ts    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        kind  = $Kind
        sid   = $Sid
        detail = $Detail
    }
    # AppendAllText (no BOM, share-friendly) — Add-Content UTF8 would write a BOM on
    # file creation and poison the first JSON line at relay time.
    [System.IO.File]::AppendAllText($JournalPath, ($entry | ConvertTo-Json -Compress) + "`n", $Utf8NoBom)
}

# --- 1. Tripwire scan -----------------------------------------------------------
$data = $null
try {
    $raw = $null
    if ($RunScan) {
        # injected seam (test): the caller provides the scan output, path checks moot
        $raw = & $RunScan $PythonExe $ScanScript $WindowHours
    } elseif (-not (Test-Path $ScanScript)) {
        Write-Journal 'scan-skip' '' ("scan script not found: $ScanScript (pass -ScanScript/-PythonExe on a non-hub machine)")
    } else {
        if (-not (Test-Path $PythonExe)) { throw "python not found: $PythonExe (Store-Python full path required, bare python = silent no-op)" }
        $raw = & $PythonExe $ScanScript --hours $WindowHours --top 12 --json 2>&1 | Out-String
    }
    if ($raw) { $data = $raw | ConvertFrom-Json }
} catch {
    Write-Journal 'error' '' ("scan failed: " + $_.Exception.Message)
    $data = $null
}

$solId = 'gpt-6-sol'
$localMachine = $env:COMPUTERNAME.ToLower()

if ($data -and $data.sessions) {
    foreach ($s in @($data.sessions)) {
        if (@($s.flags) -notcontains 'OPENAI-SHAPED') { continue }
        $sid = [string]$s.session_id

        # B1 (CR): refuse a sid-less line before ANYTHING can consume it — binding,
        # workspace resolution, consent path. The unattributed bucket keeps the
        # envelope machine, so it passes the local-machine test and would otherwise
        # reach the kill branch with an empty regex.
        if ([string]::IsNullOrWhiteSpace($sid) -or $sid.Length -lt 8) {
            Write-Journal 'skip-unattributed' '' ("machine=" + $s.machine + " total=" + $s.requests + " (session_id empty/short — never reaches binding)")
            continue
        }
        $sid8 = $sid.Substring(0, 8)

        if ([string]$s.machine -ne $localMachine) {
            Write-Journal 'remote-openai' $sid8 ("machine=" + $s.machine + " sol=" + $s.models.PSObject.Properties[$solId].Value + " total=" + $s.requests)
            continue
        }

        # Workspace resolution: the transcript lives under ~/.claude/projects/<project>/<sid8>*.jsonl
        $projectName = ''
        if (Test-Path $projectsRoot) {
            foreach ($d in (Get-ChildItem $projectsRoot -Directory -ErrorAction SilentlyContinue)) {
                if (Get-ChildItem -LiteralPath $d.FullName -Filter "$sid8*.jsonl" -ErrorAction SilentlyContinue) {
                    $projectName = $d.Name
                    break
                }
            }
        }

        # B3 (CR): the user-authorized exemption covers the main checkout AND its
        # worktrees. A worktree project dir is the main dir plus a
        # '--claude-worktrees-*' suffix (path separators flatten to '--'), so the
        # frontier is the boundary match ^<main>(--|$): the main checkout exactly,
        # every '--'-derived worktree of it, and NOT a different repo sharing the
        # prefix (d--dev-CoursIA-20) — a permissive contains draws no frontier.
        # -match is case-insensitive: project dirs arrive as D--dev-… or d--dev-…
        if ($projectName -and $projectName -match '^d--dev-CoursIA-2(--|$)') {
            Write-Journal 'exempt' $sid8 ("coursia-2 adjoint or worktree (user-authorized, principal gpt-6-sol declared): $projectName")
            continue
        }

        # B3 (CR): workspace identity unestablished => NO kill and no verdict that
        # could arm one. An empty $projectName must not traverse into the
        # sol-majority branch where consent + a positively-bound process would
        # reach StopProcess on a session we cannot place. Journal and stop.
        if (-not $projectName) {
            $solUnk = 0
            if ($s.models.PSObject.Properties[$solId]) { $solUnk = [int]$s.models.PSObject.Properties[$solId].Value }
            Write-Journal 'no-workspace-identity' $sid8 ("sol=$solUnk total=" + $s.requests + " (transcript not found under any project dir — identity unproven, no kill)")
            continue
        }

        $sol = 0
        if ($s.models.PSObject.Properties[$solId]) { $sol = [int]$s.models.PSObject.Properties[$solId].Value }
        $total = [int]$s.requests
        $sonnet = 0
        foreach ($p in $s.models.PSObject.Properties) {
            # By role, like the hub's roleFromModelName (substring, any case): since
            # #555 the fleet's settings name bare roles (`sonnet`), and a
            # `claude-sonnet*` prefix test counted them as zero.
            if ($p.Name -match 'sonnet') { $sonnet += [int]$p.Value }
        }

        if ($sonnet -gt ($total / 2)) {
            Write-Journal 'sonnet-majority' $sid8 ("sonnet=$sonnet total=$total project=$projectName")
            continue
        }

        if ($sol -gt ($total / 2)) {
            $consentFile = Join-Path $ClaudishHome 'session-watch.kill.enabled'
            if (-not (Test-Path $consentFile)) {
                Write-Journal 'kill-blocked-no-consent' $sid8 ("sol=$sol total=$total project=$projectName (consent file absent — detector only)")
                continue
            }
            if ($DryRun) {
                Write-Journal 'dryrun-kill' $sid8 ("sol=$sol total=$total project=$projectName")
                continue
            }
            $bound = @()
            try {
                $bound = @(& $GetProcesses |
                    Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($sid8)) })
            } catch { Write-Journal 'error' $sid8 ("process query failed: " + $_.Exception.Message) }
            if ($bound.Count -gt 0) {
                foreach ($p in $bound) {
                    try {
                        & $StopProcess $p.ProcessId
                        Write-Journal 'killed' $sid8 ("pid=" + $p.ProcessId + " sol=$sol total=$total project=$projectName")
                    } catch {
                        Write-Journal 'error' $sid8 ("kill failed pid=" + $p.ProcessId + ": " + $_.Exception.Message)
                    }
                }
            } else {
                $ageMin = ((Get-Date) - [datetime]$s.last).TotalMinutes
                if ($ageMin -lt 2) {
                    Write-Journal 'no-binding-recent' $sid8 ("last=" + $s.last + " (<2min — cannot conclude exited)")
                } else {
                    Write-Journal 'no-binding-stale' $sid8 ("last=" + $s.last + " (captures stopped, no process bound)")
                }
            }
        } else {
            Write-Journal 'sol-minority' $sid8 ("sol=$sol total=$total project=$projectName")
        }
    }
}

# --- 3. MiniMax coding catalog watch --------------------------------------------
try {
    if (-not (Test-Path $HubConfig)) {
        Write-Journal 'catalog-skip' '' ("hub config not found: $HubConfig (catalog watch is hub-only)")
    } else {
        $cfg = Get-Content $HubConfig -Raw -ErrorAction Stop | ConvertFrom-Json
        $apiKey = $cfg.apiKeys.MINIMAX_CODING_API_KEY
        if ($apiKey) {
            $resp = & $FetchCatalog 'https://api.minimax.io/v1/models' $apiKey
            $ids = @($resp.data | ForEach-Object { $_.id } | Sort-Object)
            $baselineFile = Join-Path $ClaudishHome 'session-watch-models.baseline.json'
            if (Test-Path $baselineFile) {
                # PS 5.1 vs 7 divergence: under 5.1 ConvertFrom-Json emits a JSON array as ONE
                # pipeline object, so @() alone nests it (count=1, element=the array) and every
                # -notcontains misfires (measured 07/10: new-model x8 + model-gone x1 on an
                # UNCHANGED catalog). Piping through ForEach-Object unrolls in BOTH interpreters.
                $old = @((Get-Content $baselineFile -Raw -ErrorAction Stop | ConvertFrom-Json) | ForEach-Object { "$_" })
                foreach ($id in $ids) { if ($old -notcontains $id) { Write-Journal 'new-model' '' ("minimax-coding now offers: $id") } }
                foreach ($id in $old) { if ($ids -notcontains $id) { Write-Journal 'model-gone' '' ("minimax-coding retired: $id") } }
            }
            [System.IO.File]::WriteAllText($baselineFile, (ConvertTo-Json -InputObject @($ids)), $Utf8NoBom)
        } else {
            Write-Journal 'catalog-error' '' 'MINIMAX_CODING_API_KEY absent from hub config'
        }
    }
} catch {
    Write-Journal 'catalog-error' '' ("catalog watch failed: " + $_.Exception.Message)
}

# --- 4. split-brain hook (activates when PR #342 merges) -------------------------
$splitBrain = Join-Path $RepoScripts 'split-brain-scan.ps1'
if (Test-Path $splitBrain) {
    try {
        $sbOut = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $splitBrain 2>&1 | Where-Object { $_ -and ("$_" -match '\S') })
        $digest = ($sbOut | Select-Object -Last 3) -join ' | '
        if ($digest) { Write-Journal 'split-brain' '' $digest }
    } catch {
        Write-Journal 'error' '' ("split-brain scan failed: " + $_.Exception.Message)
    }
}

# --- 5. rogue schtasks detector (po-2027 escalation 07/10) -----------------------
# An agent created a Windows scheduled task to carry its session cadence instead of
# CronCreate (split-brain class: launcher vs in-session scheduler drift apart). The
# criterion is the ACTION, never the name: a task whose command launches a claude
# session (claude.exe, --print, /continue, /coordinate). Our organs launch only
# powershell/wscript/python — no claude.exe — so the predicate needs no allowlist.
# Journal the task NAME only: a /TR line can carry credentials (docker-events #192
# lesson) and never enters the journal.
# DETECTOR BOUNDARY (N3, CR): the predicate sees only actions literally carrying
# claude.exe/--print//continue//coordinate — a cadence carried by a .vbs/.cmd launcher
# that reaches claude indirectly escapes it. A "clean" verdict from this detector is a
# WEAK negative (nothing of the SEEN class was found), never proof that no rogue exists.
try {
    $csv = & $GetSchTasks
    foreach ($ln in $csv) {
        if ($ln -notmatch 'claude') { continue }
        if ($ln -match 'claude\.exe|claude"?\s+--print|--print\b.*claude|/continue|/coordinate') {
            if ($ln -match '^"[^"]*","([^"]*)"') { $tn = $Matches[1] } else { $tn = '(unparsed)' }
            if ($tn -notmatch '\\Microsoft\\') {
                Write-Journal 'rogue-schtasks' '' ("task=$tn — action launches a claude session (split-brain class)")
            }
        }
    }
} catch {
    Write-Journal 'error' '' ("schtasks detector failed: " + $_.Exception.Message)
}

exit 0
