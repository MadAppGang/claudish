# claudish-model-version.psm1 — model version watch (pure logic, no network, no
# docker — the ONE exception is Invoke-DrainDetachedRestart, which runs the
# drain's own -Detach parent synchronously; every path it touches is passed in)
#
# Mandate (user, 2026-10-02): an organ that watches the versions each provider
# actually offers, auto-repins ROUTING on MINOR bumps (same major), escalates
# MAJOR bumps for user arbitration, and notifies in every case.
#
# Scope, phase 1: the Codex/ChatGPT backend lane (the family where minor churn
# actually bites — gpt-6-sol -> gpt-6.1-sol measured 2026-10-02). The module's
# parsing/diff/edit logic is provider-agnostic; the runner adds providers as
# their /models surfaces are probed. Cascades (container env) and profiles are
# REPORT-ONLY here: repinning those needs a recreate and stays an operator act.
#
# Safety rules encoded (each one is load-bearing):
#   - Only the `routing` object of config.json is ever written; apiKeys and the
#     rest round-trip untouched, and a backup is taken before any write.
#   - A new id is repinned ONLY after an acceptance probe answered 200 — a
#     listed-but-unprobeable id never enters routing (deepseek lesson: probe
#     before trusting either direction).
#   - Unparseable config = refuse, never guess.
#   - Kill switch: <ClaudishHome>\model-version-watch.enabled must contain
#     'enabled' before anything runs (same consent-file discipline as
#     wedge-watch — a missing file means "do nothing", not "arm by default").
#
# Targets PowerShell 5.1 (scheduled tasks run powershell, not pwsh): no ??,
# no ?., no ternary.

Set-StrictMode -Version 2

# --- Id parsing -------------------------------------------------------------

function ConvertTo-ModelVersion {
    # 'gpt-6.1-sol' -> @{ Family='gpt-sol'; Major=6; Minor=1; Id='gpt-6.1-sol' }
    # 'gpt-6-sol'   -> gpt-sol 6.0   'glm-5.3' -> glm 5.3
    # 'deepseek-v4.1-flash' -> deepseek-flash 4.1   'qwen3.8-max' -> qwen-max 3.8
    # Non-versioned ids (gpt-reserve, MiniMax-M3, kimi-for-coding, mistral-
    # medium-latest, the rolling deepseek-flash alias) -> $null: no family, no
    # bump policy. A rolling alias is already "latest" by construction.
    param([Parameter(Mandatory = $true)][string]$Id)

    if ($Id -match '^(?<base>[a-z]+)-?v?(?<maj>\d+)(?:\.(?<min>\d+))?(?<suffix>-[a-z0-9.-]+)?$') {
        $family = $Matches['base']
        if ($Matches['suffix']) { $family = $family + $Matches['suffix'] }
        $minor = 0
        if ($Matches['min']) { $minor = [int]$Matches['min'] }
        return @{
            Family = $family
            Major  = [int]$Matches['maj']
            Minor  = $minor
            Id     = $Id
        }
    }
    return $null
}

function Get-LatestFamilyVersion {
    # Highest (Major, Minor) among the parseable ids of one family.
    # Returns the version object of the winner, or $null.
    param([Parameter(Mandatory = $true)][string]$Family, [string[]]$AvailableIds)

    $best = $null
    foreach ($id in $AvailableIds) {
        $v = ConvertTo-ModelVersion -Id $id
        if ($null -eq $v -or $v.Family -ne $Family) { continue }
        if ($null -eq $best -or $v.Major -gt $best.Major -or
            ($v.Major -eq $best.Major -and $v.Minor -gt $best.Minor)) {
            $best = $v
        }
    }
    return $best
}

# --- Routing diff -----------------------------------------------------------

function Compare-RoutingToFamilies {
    # One decision per (spelling, family) PAIR — never per family (review #307
    # D2/D3): a family-level decision keyed on the FIRST target seen made the
    # answer depend on key order (a-old/b-new both-repinned vs a-old-stuck
    # forever on the same two entries), and an older-major spelling masked the
    # minor bump of its newer sibling (5.6 pinned + 6.0 pinned + 6.1 available
    # => 'major', 6.0->6.1 never applied). Per spelling, each entry is compared
    # to the family latest on its own version: same major + lower minor =>
    # 'minor' (auto), older major => 'major' (ask), at or ahead of latest =>
    # 'current' (never downgrade). Order-independent by construction.
    #
    # Each decision also carries NewTarget (D1): the provider prefix is kept
    # ONLY from a value that actually contains '@' — deriving it from a bare
    # value fabricated 'gpt-6-sol@gpt-6.1-sol', an invalid target the
    # acceptance probe (which names only the id) cannot catch. A bare spelling
    # repins to the bare id.
    #   @{ Family; Spelling; CurrentId; Provider; Eligible; LatestId; NewTarget; Action }
    # Eligible (B1): the member's provider is one the runner actually lists and
    # probes. Only eligible members may ever be edited — an oai@/bare member of
    # a tracked family is REPORT-ONLY (the runner emits an info event), because
    # repinning it to an id probed on the Codex backend would enter routing an
    # unprobeable target, breaking the "listed-but-unprobeable never enters
    # routing" rule.
    # $Routing is the parsed routing object (requested-spelling -> target[]).
    param(
        [Parameter(Mandatory = $true)]$Routing,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$AvailableIds,
        # Phase 1 watches the Codex backend; other providers join as their
        # /models surfaces are probed (cx@/codex@ are the two spellings of it).
        [string[]]$WatchedProviders = @('cx@', 'codex@')
    )

    $decisions = @()
    $latestCache = @{}
    foreach ($prop in $Routing.PSObject.Properties) {
        foreach ($target in @($prop.Value)) {
            $model = ($target -split '@')[-1]
            $v = ConvertTo-ModelVersion -Id $model
            if ($null -eq $v) { continue }
            if (-not $latestCache.ContainsKey($v.Family)) {
                $latestCache[$v.Family] = Get-LatestFamilyVersion -Family $v.Family -AvailableIds $AvailableIds
            }
            $latest = $latestCache[$v.Family]
            if ($null -eq $latest) { continue }
            $action = 'current'
            if ($latest.Major -gt $v.Major) { $action = 'major' }
            elseif ($latest.Major -eq $v.Major -and $latest.Minor -gt $v.Minor) { $action = 'minor' }
            $provider = ''
            $at = ([string]$target).IndexOf('@')
            if ($at -gt 0) { $provider = ([string]$target).Substring(0, $at + 1) }
            $decisions += @{
                Family    = $v.Family
                Spelling  = $prop.Name
                CurrentId = $model
                Provider  = $provider
                Eligible  = ($WatchedProviders -contains $provider)
                LatestId  = $latest.Id
                NewTarget = $provider + $latest.Id
                Action    = $action
            }
        }
    }
    return $decisions
}

function Compare-RoleModelsToRouting {
    # CLAUDISH_FAILOVER_ROLE_MODELS maps a REQUESTING-model pattern to a role so
    # a client that names the nominal model (instead of a role keyword) still
    # gets cascade protection. Measured 2026-10-05: routing was repinned to
    # gpt-6.1-sol while ROLE_MODELS still carried the older spellings, so every
    # client naming the CURRENT id resolved to no role and had NO cascade.
    #
    # CRITICAL (CR #344, c.5993885265): the proxy derives the role from what
    # the CLIENT asked for — roleFromModelName (failover.ts) checks the role
    # KEYWORDS first ('opus','sonnet','haiku','fable' as substrings, lowercased)
    # and only then the alias patterns, FIRST match wins, invalid-role entries
    # skipped at parse (parseRoleAliases). This detector therefore reasons on
    # the CLIENT-NAMEABLE names — the routing KEYS — in that exact order:
    #
    #   keyword in name  -> covered (a keyword-bearing name needs no alias);
    #   alias pattern is a substring of the name -> covered;
    #   otherwise       -> drift, but ONLY when the alias table already tracks
    #                       the name's family (an untracked family is not work
    #                       this check may invent).
    #
    # The pre-CR shape iterated the routing TARGETS instead, which missed a
    # drift behind a remap (C2: key gpt-6.1-sol -> cx@gpt-6-sol, alias covers
    # only the target spelling), invented one behind a keyword key (C3: a
    # claude-haiku-* key aimed at an unrelated model suggested the wrong
    # role), missed provider-only entries (C4: value 'gc' with no model), and
    # picked its suggested role by hashtable iteration order — interpreter-
    # dependent under PS 5.1 (C6). Duplicate patterns keep the FIRST entry,
    # like roleFromModelName; a provider-prefixed pattern ('cx@gpt-6.1-sol')
    # is a legitimate pattern that only ever matches an equally prefixed name
    # (C7) — exactly what the proxy does with it.
    #   @{ Spelling; Id; Family; Suggested }  — one row per uncovered key.
    param(
        [Parameter(Mandatory = $true)]$Routing,
        [AllowEmptyString()][string]$RoleModels = ''
    )

    # Parse aliases IN ORDER, mirroring parseRoleAliases: split ',', trim, drop
    # empties, split ':' once, lowercase both sides, skip anything malformed —
    # including a role outside opus/sonnet/haiku/fable (C1: the entry does not
    # exist for the proxy either). FIRST occurrence of a pattern wins.
    $keywords = @('opus', 'sonnet', 'haiku', 'fable')
    $aliases = @()
    $seenPat = @{}
    foreach ($piece in @($RoleModels -split ',')) {
        $p = ([string]$piece).Trim()
        if (-not $p) { continue }
        $parts = $p -split ':', 2
        if ($parts.Count -lt 2) { continue }
        $pat = $parts[0].Trim().ToLower()
        $role = $parts[1].Trim().ToLower()
        if (-not $pat -or -not $role) { continue }
        if ($keywords -notcontains $role) { continue }
        if ($seenPat.ContainsKey($pat)) { continue }
        $seenPat[$pat] = $true
        $aliases += , @{ Pattern = $pat; Role = $role }
    }

    # Family -> role from the FIRST alias of that family in ROLE_MODELS order
    # (deterministic under both interpreters; a hashtable key order is not).
    # A provider-prefixed pattern ('cx@gpt-6.1-sol') tracks the family of its
    # MODEL portion — the pattern only ever matches prefixed names, but the
    # family intent is the same, and the bare key needs it to get a suggestion.
    $familyRole = @{}
    foreach ($a in $aliases) {
        $candidate = $a.Pattern
        if ($candidate.Contains('@')) { $candidate = ($candidate -split '@', 2)[1] }
        $v = ConvertTo-ModelVersion -Id $candidate
        if ($null -eq $v) { continue }
        if (-not $familyRole.ContainsKey($v.Family)) { $familyRole[$v.Family] = $a.Role }
    }

    $rows = @()
    foreach ($key in @($Routing.PSObject.Properties.Name)) {
        $low = $key.ToLower()
        # 1. role keywords, in roleFromModelName order.
        $hasKeyword = $false
        foreach ($kw in $keywords) {
            if ($low.Contains($kw)) { $hasKeyword = $true; break }
        }
        if ($hasKeyword) { continue }
        # 2. alias patterns, substring, first wins.
        $covered = $false
        foreach ($a in $aliases) {
            if ($low.Contains($a.Pattern)) { $covered = $true; break }
        }
        if ($covered) { continue }
        # 3. no role at all: a drift iff the family is tracked.
        $v = ConvertTo-ModelVersion -Id $key
        if ($null -eq $v) { continue }
        if (-not $familyRole.ContainsKey($v.Family)) { continue }
        $rows += @{
            Spelling  = $key
            Id        = $key
            Family    = $v.Family
            Suggested = ($key + ':' + $familyRole[$v.Family])
        }
    }
    return $rows
}

function Test-RoleAliasAskEmitted {
    # Dedupe state for the 6h ask cadence: the events log itself. Without this,
    # every run re-emits one role-alias-ask per uncovered id and the worker
    # relays it — 2 asks every 6 hours, forever, for a hole the operator has
    # already seen (CR #344). One ask per (id, suggested alias) until the log
    # is cleared; a DIFFERENT suggestion for the same id (family role edited)
    # is a new question and does ask again.
    param(
        [Parameter(Mandatory = $true)][string]$EventsPath,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Suggested
    )
    if (-not (Test-Path -LiteralPath $EventsPath)) { return $false }
    foreach ($line in @([System.IO.File]::ReadAllLines($EventsPath))) {
        $t = $line.Trim()
        if (-not $t) { continue }
        try { $evt = $t | ConvertFrom-Json } catch { continue }
        if ($evt.kind -eq 'role-alias-ask' -and $evt.to -eq $Id -and $evt.from -eq $Suggested) {
            return $true
        }
    }
    return $false
}

# --- Config surgery ---------------------------------------------------------

function Edit-RoutingForMinor {
    # Repin ONE family in routing. $Repins maps each requested-spelling of that
    # family to its own new target (per-spelling, review #307: a bare spelling
    # repins bare, a provider-qualified one keeps its prefix — one uniform
    # $NewTarget fabricated 'gpt-6-sol@gpt-6.1-sol' for a bare entry). Surgical
    # per family: within a spelling that holds SEVERAL targets (multi-lane
    # routing entries), only the members whose model id parses to $Family move;
    # the other families' members are preserved in place — a whole-array
    # overwrite would silently drop them. The new id is registered as its own
    # spelling. One timestamped backup per call. Returns the backup path, or
    # $null on any refusal (parse failure, missing file, empty diff).
    #
    # A member moves only when its family matches AND its provider prefix is in
    # $ProviderPrefixes (review #307 B1/B2). Two members of one family on
    # different providers in the same spelling stay independent: the watched
    # one moves to <its own prefix><new model>, the other is left in place —
    # the old single-target-per-spelling write duplicated the survivor and
    # deleted the lane. The target is rebuilt per member from $Repins' model id
    # so a codex@ member keeps codex@, not the cx@ the repin named.
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$Family,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Repins,      # spelling -> new target
        [Parameter(Mandatory = $true)][string]$NewSpelling,                        # e.g. 'gpt-6.1-sol'
        [Parameter(Mandatory = $true)][string]$NewSpellingTarget,                  # target for the new entry
        [Parameter(Mandatory = $true)][string[]]$ProviderPrefixes                  # e.g. @('cx@','codex@')
    )

    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($ConfigPath)
    try { $config = $raw | ConvertFrom-Json } catch { return $null }
    if ($null -eq $config.routing) { return $null }

    $changed = $false
    foreach ($sp in @($Repins.Keys)) {
        if ($config.routing.PSObject.Properties.Name -notcontains $sp) { continue }
        $newModel = (([string]$Repins[$sp]) -split '@')[-1]   # model id, prefix-free
        $vals = @($config.routing.$sp)
        for ($i = 0; $i -lt $vals.Count; $i++) {
            $member = [string]$vals[$i]
            $memberModel = ($member -split '@')[-1]
            $memberPrefix = ''
            $at = $member.IndexOf('@')
            if ($at -gt 0) { $memberPrefix = $member.Substring(0, $at + 1) }
            $mv = ConvertTo-ModelVersion -Id $memberModel
            if ($null -ne $mv -and $mv.Family -eq $Family -and
                ($ProviderPrefixes -contains $memberPrefix)) {
                $want = $memberPrefix + $newModel
                if ($member -ne $want) { $vals[$i] = $want; $changed = $true }
            }
        }
        if ($vals.Count -eq 1) {
            $config.routing.$sp = $vals[0]   # keep single-entry spellings scalar
        } else {
            $config.routing.$sp = $vals
        }
    }
    if ($config.routing.PSObject.Properties.Name -contains $NewSpelling) {
        if ((@($config.routing.$NewSpelling) -join '|') -ne $NewSpellingTarget) {
            $config.routing.$NewSpelling = @($NewSpellingTarget)
            $changed = $true
        }
    } else {
        $config.routing | Add-Member -MemberType NoteProperty -Name $NewSpelling -Value @($NewSpellingTarget)
        $changed = $true
    }
    if (-not $changed) { return $null }

    $backup = "$ConfigPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
    $out = $config | ConvertTo-Json -Depth 64
    [System.IO.File]::WriteAllText($ConfigPath, $out, (New-Object System.Text.UTF8Encoding($false)))
    return $backup
}

# --- Events & state ---------------------------------------------------------

function Write-VersionEvent {
    # NDJSON append, no BOM (5.1 Add-Content -Encoding UTF8 writes one).
    # Consumed by the worker cycle, which relays pending events to the
    # workspace dashboard — a scheduled task cannot call the MCP itself.
    # `provider` (#665 r1) is part of the fact's identity for the per-provider
    # report-only kinds: the same transition on two providers is TWO facts.
    # Family-grouped sites (Codex major-ask) leave it ''.
    param(
        [Parameter(Mandatory = $true)][string]$EventsPath,
        [Parameter(Mandatory = $true)][ValidateSet('minor-applied', 'major-ask', 'role-alias-ask', 'probe-fail', 'error', 'info')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Family,
        [string]$From = '',
        [string]$To = '',
        [string]$Provider = '',
        [string]$Detail = ''
    )
    $evt = @{
        ts      = (Get-Date).ToUniversalTime().ToString('o')
        kind    = $Kind
        family  = $Family
        from    = $From
        to      = $To
        provider = $Provider
        detail  = $Detail
    } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($EventsPath, $evt + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Test-VersionEventEmitted {
    # Dedup for the 6h cadence, the Test-RoleAliasAskEmitted model generalized:
    # an event already in the log with the same (kind, family, from, to,
    # provider) is the SAME FACT re-observed — report-only decisions never
    # change the state they describe, so re-emitting them every run floods the
    # relay channel forever. The run LOG still prints every observation; only
    # the EVENT is suppressed. The identifying tuple is the transition
    # (from -> to) PLUS the provider it was observed on: two providers carrying
    # the same transition are two facts, and #665 r1 measured the provider-less
    # key swallowing the second one on its very FIRST run. Family-grouped sites
    # (Codex major-ask) dedup at the family level with provider ''.
    # Legacy lines written before the field existed read as provider '' via the
    # guarded property access — a missing property must not throw under
    # Set-StrictMode, and a legacy fact stays a fact.
    param(
        [Parameter(Mandatory = $true)][string]$EventsPath,
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Family,
        [string]$From = '',
        [string]$To = '',
        [string]$Provider = ''
    )
    if (-not (Test-Path -LiteralPath $EventsPath)) { return $false }
    foreach ($line in @([System.IO.File]::ReadAllLines($EventsPath))) {
        $t = $line.Trim()
        if (-not $t) { continue }
        try { $evt = $t | ConvertFrom-Json } catch { continue }
        if ($null -eq $evt) { continue }
        $evtProvider = ''
        $prop = $evt.PSObject.Properties['provider']
        if ($null -ne $prop) { $evtProvider = "$($prop.Value)" }
        if ("$($evt.kind)" -eq $Kind -and "$($evt.family)" -eq $Family -and "$($evt.from)" -eq $From -and "$($evt.to)" -eq $To -and $evtProvider -eq $Provider) {
            return $true
        }
    }
    return $false
}

function Invoke-DrainDetachedRestart {
    <#
        .SYNOPSIS
        Launch the drained restart through claudish-drain.ps1's OWN -Detach
        path (#352) and report the OUTCOME, never just the attempt.

        .DESCRIPTION
        The previous inline launch was a raw `Start-Process -ArgumentList`
        with an unquoted -Reason VALUE: Start-Process joins the array with
        spaces and does not quote (the same class claudish-engine's
        Invoke-DockerBounded documents), so the child received `-Reason
        model-version-watch minor repin (old id retired)`, every word after
        the first bound positionally, `(old` failed to convert for the
        drain's [int]$MaxWaitSec, and the child died at parameter binding
        with stderr uncaptured — the log said "launching" while no restart
        ever ran (#352, same silent-death shape as #312).

        This function runs the drain's OWN -Detach parent SYNCHRONOUSLY: that
        path quotes every forwarded argument itself, captures the child's
        stdout+stderr, and returns on the child's proof of life, handing us a
        countable exit code to branch on:
          0 = child alive (its START line was seen) — restart in flight;
          3 = launch failed — no drain is running, relaunching is safe;
          4 = mute child — do NOT relaunch, a second drain would race the
              first.
        The -Detach parent itself exits within its startup window (default
        45 s); the hidden drain child keeps running independently, so the
        synchronous wait here is bounded and cheap. $Log receives one line
        per message (the watch's $logTs contract); $WriteEvent receives
        (kind, family, detail) and is expected to call Write-VersionEvent.
        Both callbacks run in the CALLER's scope (scriptblocks bind to where
        they were defined), so $eventsPath and friends stay visible.

        -ClaudishHome and -LogPath are MANDATORY and forwarded verbatim
        (CR #377): left to its own defaults the drain resolves everything
        from $env:USERPROFILE\.claudish — under an account other than the
        watch's that is a DIFFERENT home, and four things silently follow it
        there: the probe URL (base-url.txt), the drain-freeze consent file,
        drain.log (whose START line the -Detach handshake reads) and the
        drain-detach capture files. The outcome would then be written where
        nobody looks for it — the same "exists but invisible" class as #352
        itself. ops-scripts.md's rule for -Detach applies here too: pass
        both, always.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$DrainScript,
        [Parameter(Mandatory = $true)][string]$Reason,
        [Parameter(Mandatory = $true)][string]$ClaudishHome,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [Parameter(Mandatory = $true)][scriptblock]$Log,
        [Parameter(Mandatory = $true)][scriptblock]$WriteEvent
    )
    & $Log ("launching detached drained restart via -Detach: " + $Reason)
    $out = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $DrainScript -Detach -Reason $Reason -ClaudishHome $ClaudishHome -LogPath $LogPath 2>&1)
    $rc = $LASTEXITCODE
    foreach ($line in $out) { & $Log ("  [drain-detach] " + $line) }
    switch ($rc) {
        0 {
            & $Log "drain -Detach: child alive (START line seen) — restart in flight"
            & $WriteEvent 'info' 'reload' ("drain -Detach launched (exit 0) — poll '" + $LogPath + "' for the first OUTCOME after this run's START; reason: " + $Reason)
        }
        3 {
            & $Log "drain -Detach: launch FAILED (exit 3 — child died at launch/binding, or start failed) — relaunching is safe"
            & $WriteEvent 'error' 'reload' ("drain -Detach FAILED (exit 3 — child died at launch or binding) — routing repinned, hub still on the old id; relaunch safe; reason: " + $Reason)
        }
        4 {
            & $Log "drain -Detach: child MUTE within the startup window (exit 4) — do NOT relaunch"
            & $WriteEvent 'error' 'reload' ("drain -Detach mute (exit 4 — no START line, child may still run) — do NOT relaunch, a second drain would race the first; reason: " + $Reason)
        }
        default {
            & $Log ("drain -Detach: unexpected exit code " + $rc)
            & $WriteEvent 'error' 'reload' ("drain -Detach unexpected exit code " + $rc + "; reason: " + $Reason)
        }
    }
    return $rc
}

function Test-ClaudishOptIn {
    # Consent gate, shared semantics with wedge-watch: the file must exist and
    # contain 'enabled'. Anything else — missing, empty, wrong word — means
    # "do nothing". A guard that arms on accidental content is not a guard.
    param([Parameter(Mandatory = $true)][string]$ClaudishHome, [Parameter(Mandatory = $true)][string]$Token)
    $p = Join-Path $ClaudishHome 'model-version-watch.enabled'
    if (-not (Test-Path -LiteralPath $p)) { return $false }
    $content = ''
    try { $content = ([System.IO.File]::ReadAllText($p)).Trim() } catch { return $false }
    return ($content -eq $Token)
}

# --- Probe verdicts (pure) --------------------------------------------------
# Extracted from the runner's glue (review #307 B3): both guards decide
# something expensive — one gates an automatic edit of the hub's shared config,
# the other decides whether the hub gets a restart (a stream killer). A guard
# that lives only in a runner the suite does not load can be deleted silently.

function Test-ProbeAccepted {
    # Acceptance for a NEW id before any edit. A 200 alone is NOT acceptance
    # (review #307 D5): this wire answers 200 with an in-stream error body
    # (#65 class), so the accumulated body must carry a terminal
    # 'response.completed' event.
    param(
        [Parameter(Mandatory = $true)][int]$StatusCode,
        [AllowEmptyString()][string]$Content = ''
    )
    if ($StatusCode -ne 200) { return $false }
    if ($Content -notmatch 'response\.completed') { return $false }
    return $true
}

function Test-ModelRetired {
    # Did an OLD id really disappear upstream? (review #307 non-blocking: a
    # restart is a stream killer, so only a 4xx that NAMES the model — or says
    # it is unknown/not-found/retired — counts as retired. A 429, a 5xx or a
    # timeout is 'status unknown' and must NOT trigger a restart.)
    param(
        [Parameter(Mandatory = $true)][int]$StatusCode,
        [Parameter(Mandatory = $true)][string]$ModelId,
        [AllowEmptyString()][string]$Content = ''
    )
    if ($StatusCode -lt 400 -or $StatusCode -ge 500) { return $false }
    # Auth (401/403), timeout (408) and rate-limit (429) are transient or
    # credential states, not model retirement — the model's status is UNKNOWN
    # and a restart must not be triggered even when the body names the model.
    if (@(401, 403, 408, 429) -contains $StatusCode) { return $false }
    if ($Content -match [regex]::Escape($ModelId)) { return $true }
    if ($Content -match '(?i)(unknown\s+model|model[^\n]{0,40}not\s+found|does\s+not\s+exist|invalid\s+model|unsupported\s+model|retired)') { return $true }
    return $false
}

function Get-ReloadMode {
    # 'restart-now' only when at least one old id is CONFIRMED retired, else
    # 'deferred' — the daily drained restart reloads the edited config (review
    # #307 B3/D4). The caller passes only ids it has classified retired.
    param([AllowEmptyCollection()][string[]]$DeadOldIds = @())
    if (@($DeadOldIds).Count -gt 0) { return 'restart-now' }
    return 'deferred'
}

# --- Routing coverage (#635 AC 1) -------------------------------------------

function Get-RoutingCoverage {
    # How much of the live routing surface this watch can actually see.
    # Pure: it parses the routing object and nothing else.
    #
    # Units are counted SEPARATELY and deliberately (#635): the hub's routing
    # is 25 KEYS but 29 TARGETS (4 keys carry several targets), so a fraction
    # quoted without its unit reads as a different claim — '21/25 routes' and
    # '25/29 targets' are both true and are not the same number. Coverage is
    # reported on TARGETS (the thing a watch can repin) with the entry count
    # carried alongside, never instead.
    #
    # A target with no '@' lands in '(unprefixed)' — a bare model id (no
    # backend to bind to) and a provider-only value ('gc') are NOT told apart
    # on purpose: the watcher can bind neither, and guessing which is which is
    # how an instrument starts inventing. A malformed '@model' is counted in
    # Targets but assigned no prefix.
    param(
        $Routing,
        [string[]]$WatchedProviders = @('cx@', 'codex@')
    )
    $entries = 0
    $targets = 0
    $byPrefix = @{}
    if ($null -ne $Routing) {
        foreach ($prop in $Routing.PSObject.Properties) {
            $entries++
            foreach ($target in @($prop.Value)) {
                $targets++
                $s = [string]$target
                $at = $s.IndexOf('@')
                if ($s.Length -eq 0 -or $at -eq 0) { continue }
                $prefix = '(unprefixed)'
                if ($at -gt 0) { $prefix = $s.Substring(0, $at + 1) }
                if (-not $byPrefix.ContainsKey($prefix)) {
                    $byPrefix[$prefix] = @{
                        Prefix  = $prefix
                        Routes  = 0
                        Watched = ($WatchedProviders -contains $prefix)
                    }
                }
                $byPrefix[$prefix].Routes++
            }
        }
    }
    $watchedRoutes = 0
    $watchedPrefixes = 0
    foreach ($k in @($byPrefix.Keys)) {
        if ($byPrefix[$k].Watched) {
            $watchedRoutes += $byPrefix[$k].Routes
            $watchedPrefixes++
        }
    }
    return @{
        Entries         = $entries
        Targets         = $targets
        ByPrefix        = @($byPrefix.Values | Sort-Object -Property @{ Expression = { $_.Routes }; Descending = $true }, @{ Expression = { $_.Prefix } })
        WatchedPrefixes = $watchedPrefixes
        WatchedRoutes   = $watchedRoutes
        InvisibleRoutes = ($targets - $watchedRoutes)
    }
}

function Format-RoutingCoverageLine {
    # The run-log line (#635 AC 1 — 'a run prints its coverage'). Pinned by a
    # test because the contract is on the TEXT: the numbers must name their
    # unit, and the invisible prefixes must carry their own counts, otherwise
    # the next reader re-derives a fraction from the wrong denominator.
    param([Parameter(Mandatory = $true)]$Coverage)
    $all = @($Coverage.ByPrefix)
    $invisible = @($all | Where-Object { -not $_.Watched } | ForEach-Object { "$($_.Prefix) $($_.Routes)" })
    $tail = 'none'
    if ($invisible.Count -gt 0) { $tail = ($invisible -join ', ') }
    return ("[coverage] version watch sees {0}/{1} providers, {2}/{3} routing targets ({4} entries) — invisible: {5}" -f `
            $Coverage.WatchedPrefixes, $all.Count, $Coverage.WatchedRoutes, $Coverage.Targets, `
            $Coverage.Entries, $tail)
}

# --- Cascade visibility (#635 AC 3) ------------------------------------------
#
# The watch read `routing` only, so every armed cascade was invisible — and
# both manual re-pins of that week happened inside that blind spot (`kc@k3` ->
# `kc@k3.1-pro` in the sonnet cascade, 24/10; the Aliyun lane, 20/10). Cascades
# stay OPERATOR acts (they live in the env; changing one needs a recreate) —
# this layer only makes them visible, by NAMES.
#
# Names only is a hard rule, not a style: a step that does not parse as
# `provider@model` / `role:<r>` is counted at its POSITION and its text is
# never echoed. An unparseable cascade value is whatever an operator pasted —
# and this log travels to a public repo.

function Read-EnvFileValues {
    # The ONE reader for an env file. Callers ask for KEYS by name and never
    # enumerate the file into a log: on the hub it also carries
    # CLAUDISH_PROXY_KEY. Returns a hashtable of the requested names that are
    # PRESENT (an absent key is absent from the result, not ''). A file that
    # exists but cannot be read (lock, ACL) returns $null: "unreadable" and
    # "absent" are different claims, and an empty hashtable would let a caller
    # print "none declared" on a blind eye.
    #
    # Handles both `KEY=value` and `export KEY=value`, and strips ONE layer of
    # matching single or double quotes — the same rules the inline ROLE_MODELS
    # reader used before this function existed (a value like `>>>` keeps its
    # own '=' signs: only the FIRST '=' splits).
    param(
        [Parameter(Mandatory = $true)][string]$EnvFile,
        [Parameter(Mandatory = $true)][string[]]$Names
    )
    $out = @{}
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $out }
    $wanted = @{}
    foreach ($n in $Names) { $wanted[$n] = $true }
    try { $lines = [System.IO.File]::ReadAllLines($EnvFile) } catch { return $null }
    foreach ($line in $lines) {
        $t = $line.Trim()
        if ($t -like 'export *') { $t = $t.Substring(7).Trim() }
        $eq = $t.IndexOf('=')
        if ($eq -le 0) { continue }
        $key = $t.Substring(0, $eq).Trim()
        if (-not $wanted.ContainsKey($key)) { continue }
        if ($out.ContainsKey($key)) { continue }   # first declaration wins
        $val = $t.Substring($eq + 1).Trim()
        if ($val.Length -ge 2 -and $val[0] -eq $val[$val.Length - 1] -and ($val[0] -eq '"' -or $val[0] -eq "'")) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        $out[$key] = $val
    }
    return $out
}

function ConvertFrom-FailoverCascadeEnv {
    # Each declared role's cascade, as NAMES. The grammar is the proxy's own
    # (packages/cli/src/fork/failover.ts), mirrored here rather than guessed:
    #   value split on '>', trimmed, empties dropped; a trailing `!<class>` is
    #   stripped BEFORE the grammar parses (`!own` is kept for display, an
    #   unknown class is stripped and counted — the proxy's rule); then
    #   `role:<r>` (a delegation, #274) or `provider@model[:concurrency]`.
    #
    # A BARE step (no '@', not a role:) is legal on the proxy wire but is
    # indistinguishable from a pasted secret, so it is reported as
    # `bare-step #k` — its position, never its text. A `role:` form naming
    # something outside the four roles is `unknown-role #k` (the operator meant
    # a delegation — the most confusable mistake), anything else
    # `unnamed-step #k`.
    param($Values)   # role -> raw cascade value (the caller read the env)
    $roles = @('fable', 'opus', 'sonnet', 'haiku')
    $out = @()
    foreach ($role in $roles) {
        $raw = ''
        if ($Values -is [System.Collections.IDictionary]) {
            if ($Values.Contains($role)) { $raw = [string]$Values[$role] }
        } elseif ($null -ne $Values) {
            $p = $Values.PSObject.Properties[$role]
            if ($null -ne $p) { $raw = [string]$p.Value }
        }
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }

        $steps = @()
        $prefixes = @()
        $delegations = @()
        $unparsed = 0
        $k = 0
        foreach ($piece in ($raw -split '>')) {
            $t = $piece.Trim()
            if (-not $t) { continue }
            $k++
            $class = ''
            $mClass = [regex]::Match($t, '^(.*?)!([A-Za-z0-9_-]+)$')
            if ($mClass.Success) {
                $t = $mClass.Groups[1].Value.Trim()
                if ($mClass.Groups[2].Value -eq 'own') { $class = '!own' }
            }
            if ($t -match '^role\s*:\s*(?<r>[A-Za-z]+)$') {
                $r = $Matches['r'].ToLower()
                if ($roles -contains $r) {
                    $steps += "role:$r"
                    $delegations += $r
                    continue
                }
                # A `role:` form naming something that is not one of the four
                # roles. Reported as its own shape: `bare-step` would hide that
                # the operator MEANT a delegation, the most confusable mistake.
                $steps += ("unknown-role #{0}" -f $k)
                $unparsed++
                continue
            }
            if ($t -match '^(?<p>[A-Za-z0-9._-]+)@(?<m>[A-Za-z0-9._:/-]+)$') {
                $p = $Matches['p'] + '@'
                $steps += ("{0}{1}{2}" -f $p, $Matches['m'], $class)
                $prefixes += $p
                continue
            }
            if ($t -match '^[A-Za-z0-9._:/-]+$') {
                $steps += ("bare-step #{0}" -f $k)
                $unparsed++
                continue
            }
            $steps += ("unnamed-step #{0}" -f $k)
            $unparsed++
        }
        $out += @{
            Role        = $role
            Steps       = @($steps)
            Prefixes    = @($prefixes | Select-Object -Unique)
            Delegations = @($delegations | Select-Object -Unique)
            Unparsed    = $unparsed
        }
    }
    return $out
}

function Format-CascadeCoverageLine {
    # One line, NAMES only: which role diverts through which prefixes/models,
    # and which arms are live. The raw env values are never printed — the
    # arms are re-rendered from their `role@machine` pieces, and anything that
    # does not match that shape is counted (`unnamed-arm #k`).
    param(
        $Cascades,
        [string]$ArmedEnv = '',
        [string]$AutoEnv = ''
    )
    $list = @($Cascades)
    if ($list.Count -eq 0) {
        return '[coverage] cascades (env file): none declared in the env file — no role has a failover step to divert to'
    }
    $stepCount = 0
    foreach ($c in $list) { $stepCount += @($c.Steps).Count }
    $prefixes = @($list | ForEach-Object { $_.Prefixes } | Where-Object { $_ } | Select-Object -Unique | Sort-Object)
    $parts = foreach ($c in $list) { "{0}: {1}" -f $c.Role, ((@($c.Steps)) -join ' > ') }
    # "(env file)" is load-bearing: the line reads the FILE, not the running
    # container — after an edit without a recreate it shows the next state.
    $rendered = "[coverage] cascades (env file): {0} roles, {1} steps, prefixes {2} — {3}" -f `
        $list.Count, $stepCount, ($(if ($prefixes.Count -gt 0) { $prefixes -join ',' } else { 'none' })), ($parts -join ' | ')

    $arms = @()
    $k = 0
    # Mirrors the proxy's CLAUDE_FAILOVER_ACTIVE parse exactly
    # (fork/failover.ts): lower-cased whole, `none` arms nothing, split on
    # [,\s]+, and a piece the proxy would DISCARD (unknown role, empty or
    # malformed machine) is reported by position and never echoed.
    $activeRaw = ([string]$ArmedEnv).Trim().ToLowerInvariant()
    if ($activeRaw -and $activeRaw -ne 'none') {
        foreach ($piece in ($activeRaw -split '[,\s]+')) {
            if (-not $piece) { continue }
            $k++
            $at = $piece.IndexOf('@')
            $role = if ($at -ge 0) { $piece.Substring(0, $at) } else { $piece }
            $machine = if ($at -ge 0) { $piece.Substring($at + 1) } else { $null }
            $flaw = if ($role -notin @('opus', 'sonnet', 'haiku', 'fable')) { 'unknown role' }
            elseif ($machine -eq '') { 'empty machine' }
            elseif ($null -ne $machine -and $machine.Contains('@')) { 'malformed machine' }
            else { $null }
            if ($flaw) {
                # The proxy logs and ignores this piece; so does the line, by
                # position — a role word is not secret-shaped, but a discarded
                # piece may be anything, so it is never echoed.
                $arms += ("ignored-arm #{0}" -f $k)
                continue
            }
            if ($null -ne $machine) { $arms += ("{0}@{1}" -f $role, $machine) }
            else { $arms += ("{0} (all machines)" -f $role) }
        }
    }
    if ($arms.Count -gt 0) { $rendered += ' — armed: ' + ($arms -join ',') } else { $rendered += ' — armed: none' }
    if (-not [string]::IsNullOrWhiteSpace($AutoEnv)) {
        # Same regex the proxy uses for CLAUDE_FAILOVER_AUTO (failover.ts): only
        # 1/true/yes/on (any case) is on — `AUTO=true` must not read "off".
        if ($AutoEnv.Trim() -match '^(1|true|yes|on)$') { $rendered += ' (auto=on)' } else { $rendered += ' (auto=off)' }
    }
    return $rendered
}

# --- Provider probe layer (#635 AC 2) ---------------------------------------
#
# The Codex OAuth path above can only enumerate chatgpt.com. Every other family
# lives behind a provider whose `/models` surface has to be probed with that
# provider's OWN credential — and an id listed by backend A must never enter
# routing under backend B.
#
# Three rules are structural here, not conventions:
#   1. A probe outcome is 'probed' or 'not probed'. There is no third value and
#      no 'current': a 401, a timeout and a missing credential all mean "we did
#      not see this catalogue", which must never read as "this catalogue is
#      up to date" (issue #635, AC 2).
#   2. Targets come from what the CONFIG declares (custom endpoints carry their
#      own url + key reference). A prefix with no declared surface is reported
#      as such — this module never invents a base URL for a builtin provider.
#   3. Decisions are computed per provider, over that provider's OWN ids
#      (`Compare-ProbedProviderToFamilies`). `Compare-RoutingToFamilies` already
#      gates on the target prefix, so a decision can only exist when the routing
#      target and the listing backend are the same one.

function Get-ModelsUrl {
    # `<base>/v1` + `/chat/completions` (simple) or a bare base + the full
    # `/v1/chat/completions` path (complex) — same rule the proxy uses in
    # providers/context-limit-derivation.ts, so the watch and the proxy cannot
    # disagree about where a catalogue lives.
    param([string]$BaseUrl, [string]$ApiPath)
    if ([string]::IsNullOrWhiteSpace($BaseUrl)) { return '' }
    $base = $BaseUrl.TrimEnd('/')
    $path = '/chat/completions'
    if (-not [string]::IsNullOrWhiteSpace($ApiPath)) { $path = $ApiPath.TrimEnd('/') }
    foreach ($suffix in @('/chat/completions', '/messages')) {
        if ($path.EndsWith($suffix)) { return $base + $path.Substring(0, $path.Length - $suffix.Length) + '/models' }
    }
    return $base + '/v1/models'
}

function Get-ProviderProbeTargets {
    # Every provider prefix the routing actually uses, classified by whether
    # this seat can probe it and why not when it cannot. Pure: config in,
    # targets out — no network, no env read (credential NAME only here).
    param(
        $Routing,
        $CustomEndpoints,
        [string[]]$OAuthProviders = @('cx@', 'codex@'),
        # #635 AC 3: prefixes reached ONLY through an armed cascade
        # (`CLAUDISH_FAILOVER_*`). A cascade is how the fleet actually diverts
        # when a plan walls, so a provider that appears there and nowhere in
        # `routing` is exactly the one nobody watches (`kc@` was re-pinned by
        # hand for that reason, 24/10).
        [string[]]$CascadePrefixes = @()
    )
    $byPrefix = @{}
    $routingSet = @{}
    if ($null -ne $Routing) {
        foreach ($prop in $Routing.PSObject.Properties) {
            foreach ($target in @($prop.Value)) {
                $s = [string]$target
                $at = $s.IndexOf('@')
                if ($at -le 0) { continue }
                $prefix = $s.Substring(0, $at + 1)
                if (-not $byPrefix.ContainsKey($prefix)) { $byPrefix[$prefix] = $null }
                $routingSet[$prefix] = $true
            }
        }
    }
    $cascadeSet = @{}
    foreach ($p in @($CascadePrefixes)) {
        $q = [string]$p
        if ([string]::IsNullOrWhiteSpace($q)) { continue }
        if (-not $q.EndsWith('@')) { $q += '@' }
        $cascadeSet[$q] = $true
        if (-not $byPrefix.ContainsKey($q)) { $byPrefix[$q] = $null }
    }

    $targets = @()
    foreach ($prefix in @($byPrefix.Keys | Sort-Object)) {
        $name = $prefix.TrimEnd('@')
        $inRouting = $routingSet.ContainsKey($prefix)
        $inCascade = $cascadeSet.ContainsKey($prefix)
        $source = 'routing'
        if ($inCascade -and -not $inRouting) { $source = 'cascade' }
        elseif ($inCascade -and $inRouting) { $source = 'both' }
        if ($OAuthProviders -contains $prefix) {
            $targets += @{
                Prefix    = $prefix
                Probeable = $false
                Kind      = 'oauth'
                Url       = ''
                KeyName   = ''
                KeyInline = ''
                Source    = $source
                Reason    = 'listed by the Codex OAuth path, not by this probe'
            }
            continue
        }

        $entry = $null
        if ($null -ne $CustomEndpoints -and $CustomEndpoints.PSObject.Properties[$name]) {
            $entry = $CustomEndpoints.PSObject.Properties[$name].Value
        }
        if ($null -eq $entry) {
            $reason = 'no probe surface declared in config (builtin provider URL lives in the CLI, not here)'
            if ($source -eq 'cascade') { $reason += '; reached only from a CLAUDISH_FAILOVER_* cascade' }
            $targets += @{
                Prefix    = $prefix
                Probeable = $false
                Kind      = 'unknown'
                Url       = ''
                KeyName   = ''
                KeyInline = ''
                Source    = $source
                Reason    = $reason
            }
            continue
        }

        $baseUrl = ''
        $apiPath = ''
        if ($entry.PSObject.Properties['url']) { $baseUrl = [string]$entry.url }
        elseif ($entry.PSObject.Properties['baseUrl']) { $baseUrl = [string]$entry.baseUrl }
        if ($entry.PSObject.Properties['apiPath']) { $apiPath = [string]$entry.apiPath }

        # Wire detection mirrors the loader's: simple entries key on `format`,
        # complex on `transport`. The wire decides the auth-header DEFAULT —
        # an explicit authScheme always wins. This mirrors the
        # complex-anthropic and openai-bearer paths the live config uses, NOT
        # every transport shape: an OpenAI-transport endpoint is always served
        # Bearer regardless of authScheme (OpenAIProviderTransport.getHeaders
        # ignores the field), and simple endpoints are hard-coded bearer in
        # buildProviderDefinition — neither shape exists on the hub today; if
        # one appears, align the probe with the TRANSPORT, not the config.
        $wire = ''
        if ($entry.PSObject.Properties['format']) { $wire = [string]$entry.format }
        elseif ($entry.PSObject.Properties['transport']) { $wire = [string]$entry.transport }
        $authScheme = ''
        if ($entry.PSObject.Properties['authScheme']) { $authScheme = [string]$entry.authScheme }
        if ([string]::IsNullOrWhiteSpace($authScheme)) {
            if ($wire -eq 'anthropic') { $authScheme = 'x-api-key' } else { $authScheme = 'bearer' }
        }
        # Only complex endpoints may carry `headers` (extra request headers,
        # applied AFTER the auth header — the transports merge in that order).
        $extraHeaders = $null
        if ($null -ne $entry.PSObject.Properties['headers'] -and $null -ne $entry.headers) {
            $extraHeaders = $entry.headers
        }

        # `${VAR}` is a reference; anything else is the literal key. The literal
        # is carried for the probe and NEVER logged (see Format-ProviderProbeLine).
        $keyName = ''
        $keyInline = ''
        $apiKey = ''
        if ($entry.PSObject.Properties['apiKey']) { $apiKey = [string]$entry.apiKey }
        if ($apiKey -match '^\$\{([A-Za-z0-9_]+)\}$') { $keyName = $Matches[1] }
        elseif ($apiKey.Length -gt 0) { $keyInline = $apiKey }

        $targets += @{
            Prefix       = $prefix
            Probeable    = $true
            Kind         = 'custom'
            Url          = (Get-ModelsUrl -BaseUrl $baseUrl -ApiPath $apiPath)
            KeyName      = $keyName
            KeyInline    = $keyInline
            AuthScheme   = $authScheme
            ExtraHeaders = $extraHeaders
            Source       = $source
            Reason       = ''
        }
    }
    return $targets
}

function Get-ProbeHeaders {
    # Pure header build, mirroring the transports the proxy itself uses
    # (anthropic-compat.ts getHeaders): the auth header comes from
    # $AuthScheme — 'bearer' -> Authorization: Bearer, anything else ->
    # x-api-key — and $ExtraHeaders apply AFTER it (Object.assign order: an
    # extra header may legitimately override the auth header). Pure so the
    # suite can pin every shape without touching the wire.
    param(
        [string]$Key,
        [string]$AuthScheme = 'bearer',
        $ExtraHeaders = $null
    )
    $headers = @{ Accept = 'application/json' }
    if ($Key.Length -gt 0) {
        if ($AuthScheme -eq 'x-api-key') { $headers['x-api-key'] = $Key }
        else { $headers['Authorization'] = "Bearer $Key" }
    }
    if ($null -ne $ExtraHeaders) {
        foreach ($p in @($ExtraHeaders.PSObject.Properties)) {
            $headers[[string]$p.Name] = [string]$p.Value
        }
    }
    return $headers
}

function Invoke-ProbeHttpGet {
    # Default transport. Separated so the suite can inject a fake and stay off
    # the wire (production: 5.1, hence -UseBasicParsing). Header contract:
    # Get-ProbeHeaders (authScheme + extra headers, same as the proxy).
    param(
        [string]$Url,
        [string]$Key,
        [int]$TimeoutSec = 15,
        [string]$AuthScheme = 'bearer',
        $ExtraHeaders = $null
    )
    $headers = Get-ProbeHeaders -Key $Key -AuthScheme $AuthScheme -ExtraHeaders $ExtraHeaders
    $resp = Invoke-WebRequest -Uri $Url -Headers $headers -Method Get -TimeoutSec $TimeoutSec -UseBasicParsing
    return @{ Status = [int]$resp.StatusCode; Body = [string]$resp.Content }
}

function Get-ProbeIds {
    # Accepts the shapes actually served: `{data:[…]}`, `{models:[…]}` and a
    # bare array; each item may be a string or an object with id/slug.
    param($Body)
    $parsed = $null
    try { $parsed = $Body | ConvertFrom-Json } catch { return @() }
    $list = $parsed
    if ($parsed -is [pscustomobject] -and $parsed.PSObject.Properties['data']) { $list = $parsed.data }
    elseif ($parsed -is [pscustomobject] -and $parsed.PSObject.Properties['models']) { $list = $parsed.models }
    $ids = @()
    foreach ($item in @($list)) {
        if ($item -is [string]) { $ids += $item }
        elseif ($null -ne $item -and $item.PSObject.Properties['id']) { $ids += [string]$item.id }
        elseif ($null -ne $item -and $item.PSObject.Properties['slug']) { $ids += [string]$item.slug }
    }
    return @($ids | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-ApiKeyValue {
    # A credential by NAME, from whatever shape the config arrived in: a
    # hashtable (tests, callers that build one) or a PSCustomObject (what
    # ConvertFrom-Json actually hands the runner). Measured 24/10 on the live
    # config under PS 5.1: `$ApiKeys[$name]` on a PSObject fails with
    # "Cannot index an object of type PSObject" — the probe would have thrown on
    # the FIRST provider that carries a credential name, on the seat it ships to.
    param($ApiKeys, [string]$Name)
    if ($null -eq $ApiKeys -or [string]::IsNullOrEmpty($Name)) { return '' }
    if ($ApiKeys -is [System.Collections.IDictionary]) {
        if ($ApiKeys.Contains($Name)) { return [string]$ApiKeys[$Name] }
        return ''
    }
    $prop = $ApiKeys.PSObject.Properties[$Name]
    if ($null -ne $prop -and $null -ne $prop.Value) { return [string]$prop.Value }
    return ''
}

function Invoke-ProviderCatalogProbe {
    # One outcome per probeable target. Never throws: a probe failure is a
    # reported "not probed", never an incident and never an edit.
    #
    # $ApiKeys is config.apiKeys (name -> value); $EnvApiKeys is a lookup
    # scriptblock for names absent from that table (production: process env).
    param(
        $Targets,
        $ApiKeys,
        [scriptblock]$EnvLookup = $null,
        [scriptblock]$Fetcher = $null,
        [int]$TimeoutSec = 15
    )
    if ($null -eq $Fetcher) { $Fetcher = { param($u, $k, $t, $s, $h) Invoke-ProbeHttpGet -Url $u -Key $k -TimeoutSec $t -AuthScheme $s -ExtraHeaders $h } }
    $outcomes = @()
    foreach ($t in @($Targets)) {
        if (-not $t.Probeable) {
            $outcomes += @{ Prefix = $t.Prefix; Status = 'not probed'; Ids = @(); Reason = $t.Reason; Kind = $t.Kind }
            continue
        }

        $key = ''
        if (-not [string]::IsNullOrEmpty($t.KeyInline)) { $key = $t.KeyInline }
        elseif (-not [string]::IsNullOrEmpty($t.KeyName)) {
            if ($null -ne $ApiKeys) { $key = Get-ApiKeyValue -ApiKeys $ApiKeys -Name $t.KeyName }
            if ([string]::IsNullOrEmpty($key) -and $null -ne $EnvLookup) { $key = [string](& $EnvLookup $t.KeyName) }
            if ([string]::IsNullOrEmpty($key)) {
                $outcomes += @{
                    Prefix = $t.Prefix; Status = 'not probed'; Ids = @(); Kind = $t.Kind
                    Reason = "no credential ($($t.KeyName) is neither in config.apiKeys nor in the environment)"
                }
                continue
            }
        }

        try {
            # AuthScheme/ExtraHeaders are read shape-safely: a target built
            # before #661 (or by a fixture) lacks the keys, and under strict
            # mode a bare $t.AuthScheme throws on a missing key — the probe
            # would read "request failed" instead of authenticating.
            $scheme = ''
            $extras = $null
            if ($t -is [System.Collections.IDictionary]) {
                if ($t.Contains('AuthScheme')) { $scheme = [string]$t['AuthScheme'] }
                if ($t.Contains('ExtraHeaders')) { $extras = $t['ExtraHeaders'] }
            } else {
                $sp = $t.PSObject.Properties['AuthScheme']
                if ($null -ne $sp) { $scheme = [string]$sp.Value }
                $hp = $t.PSObject.Properties['ExtraHeaders']
                if ($null -ne $hp) { $extras = $hp.Value }
            }
            $r = & $Fetcher $t.Url $key $TimeoutSec $scheme $extras
            $status = 0
            if ($null -ne $r -and $null -ne $r.Status) { $status = [int]$r.Status }
            if ($status -eq 401 -or $status -eq 403) {
                $outcomes += @{
                    Prefix = $t.Prefix; Status = 'not probed'; Ids = @(); Kind = $t.Kind
                    Reason = "HTTP $status — credential refused (not probed, NOT current)"
                }
                continue
            }
            if ($status -lt 200 -or $status -ge 300) {
                $outcomes += @{ Prefix = $t.Prefix; Status = 'not probed'; Ids = @(); Kind = $t.Kind; Reason = "HTTP $status" }
                continue
            }
            $ids = @(Get-ProbeIds -Body $r.Body)
            if ($ids.Count -eq 0) {
                $outcomes += @{
                    Prefix = $t.Prefix; Status = 'not probed'; Ids = @(); Kind = $t.Kind
                    Reason = 'HTTP 200 but no model entries (shape drifted? — no-signal, not "current")'
                }
                continue
            }
            $outcomes += @{ Prefix = $t.Prefix; Status = 'probed'; Ids = $ids; Kind = $t.Kind; Reason = '' }
        } catch {
            # The transport may throw a plain RuntimeException (timeout, DNS) or
            # a WebException/HttpRequestException carrying a response. Probing
            # for the property instead of reading it is what keeps this block
            # from turning a network failure into a second, unrelated crash —
            # and it is the same code path under 5.1 and 7 (measured: the naive
            # `$_.Exception.Response.StatusCode` throws PropertyNotFound under
            # StrictMode for the plain shape).
            $msg = $_.Exception.Message
            $code = 0
            if ($null -ne $_.Exception) {
                $responseProp = $_.Exception.PSObject.Properties['Response']
                if ($null -ne $responseProp -and $null -ne $responseProp.Value) {
                    $resp = $responseProp.Value
                    if ($null -ne $resp.PSObject.Properties['StatusCode']) { $code = [int]$resp.StatusCode }
                }
            }
            if ($code -eq 401 -or $code -eq 403) { $msg = "HTTP $code — credential refused (not probed, NOT current)" }
            elseif ($code -gt 0) { $msg = "HTTP $code" }
            else {
                # No HTTP status: a transport failure. Normalise the two shapes
                # that carry meaning into a stable English token, because the
                # platform message is LOCALISED — measured 24/10 on this seat,
                # PS 5.1: `vllm-myia@ (Le délai de l'opération a expiré.)` in a
                # run log otherwise written in English. The corpus is grepped by
                # the fleet; a French line is invisible to an English filter.
                $timedOut = $false
                if ($_.Exception -is [System.TimeoutException]) { $timedOut = $true }
                else {
                    $statusProp = $_.Exception.PSObject.Properties['Status']
                    if ($null -ne $statusProp -and "$($statusProp.Value)" -eq 'Timeout') { $timedOut = $true }
                }
                if ($timedOut) { $msg = "timed out after ${TimeoutSec}s" }
                else { $msg = "request failed: $($_.Exception.Message)" }
            }
            $outcomes += @{ Prefix = $t.Prefix; Status = 'not probed'; Ids = @(); Kind = $t.Kind; Reason = $msg }
        }
    }
    return $outcomes
}

function Format-ProviderProbeLine {
    # The run-log line (#635 AC 2). Contract is on the TEXT: every prefix is
    # accounted for, a failure names its reason in the refusal vocabulary, and
    # no credential can appear (only names and counts are formatted).
    param($Outcomes)
    $all = @($Outcomes)
    if ($all.Count -eq 0) { return '[probe] no provider prefix in routing — nothing to probe' }
    $probed = @($all | Where-Object { $_.Status -eq 'probed' })
    $idCount = 0
    foreach ($p in $probed) { $idCount += @($p.Ids).Count }
    $missing = @($all | Where-Object { $_.Status -ne 'probed' } | ForEach-Object { "$($_.Prefix) ($($_.Reason))" })
    $tail = 'none'
    if ($missing.Count -gt 0) { $tail = ($missing -join ', ') }
    return ("[probe] providers probed {0}/{1} (ids {2}) — not probed: {3}" -f `
            $probed.Count, $all.Count, $idCount, $tail)
}

function Compare-ProbedProviderToFamilies {
    # Decisions from a set of probe outcomes, each provider judged against ITS
    # OWN catalogue only. This is where "an id probed on one backend is never
    # written under another" stops being a rule and becomes impossible: the
    # only ids handed to the diff are the ones that provider just listed, and
    # the diff itself drops members whose prefix differs (`Eligible`).
    param($Routing, $Outcomes)
    $decisions = @()
    foreach ($o in @($Outcomes)) {
        if ($o.Status -ne 'probed') { continue }
        $ids = @($o.Ids)
        if ($ids.Count -eq 0) { continue }
        $d = Compare-RoutingToFamilies -Routing $Routing -AvailableIds $ids -WatchedProviders @($o.Prefix)
        $decisions += @($d | Where-Object { $_.Eligible })
    }
    return $decisions
}

function Split-ProbeDecisions {
    # The SAME policy the Codex path applies, stated once for the probe: a minor
    # becomes a report-only 'would-repin' (this grain never edits routing), a
    # major becomes an ASK ('major-ask' event) because a major bump is never
    # auto-applied, and 'current' yields nothing at all. Keeping the split here
    # — rather than as a Where-Object inline in the runner — is what lets it be
    # pinned: a runner-shaped filter can only be grepped, never exercised.
    #
    # The two paths cannot double-ask for one family: probe targets exclude the
    # OAuth prefixes by construction (they are reported with Kind 'oauth' and an
    # outcome of 'not probed', so no decision is ever produced for them).
    param($Decisions)
    $minors = @()
    $majors = @()
    foreach ($d in @($Decisions)) {
        if ($null -eq $d) { continue }
        if ($d.Action -eq 'minor') { $minors += $d }
        elseif ($d.Action -eq 'major') { $majors += $d }
    }
    return @{ Minors = $minors; Majors = $majors }
}

Export-ModuleMember -Function `
    ConvertTo-ModelVersion, Get-LatestFamilyVersion, Compare-RoutingToFamilies, `
    Compare-RoleModelsToRouting, Test-RoleAliasAskEmitted, `
    Edit-RoutingForMinor, Write-VersionEvent, Test-ClaudishOptIn, `
    Test-ProbeAccepted, Test-ModelRetired, Get-ReloadMode, `
    Get-RoutingCoverage, Format-RoutingCoverageLine, `
    Get-ModelsUrl, Get-ProviderProbeTargets, Invoke-ProviderCatalogProbe, `
    Format-ProviderProbeLine, Compare-ProbedProviderToFamilies, Get-ProbeIds, `
    Split-ProbeDecisions, Get-ApiKeyValue, `
    Get-ProbeHeaders, Test-VersionEventEmitted, `
    Read-EnvFileValues, ConvertFrom-FailoverCascadeEnv, Format-CascadeCoverageLine, `
    Invoke-DrainDetachedRestart
