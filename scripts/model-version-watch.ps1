# claudish — model version watch (runner)
#
# Watches the model versions the providers actually offer and keeps the hub's
# ROUTING on the latest MINOR of each family, automatically:
#   - minor bump available + acceptance probe (200 AND a terminal
#     'response.completed' in the body — a 200 alone can carry an in-stream
#     failure, #65 class) -> repin routing (config.json), per spelling.
#   - reload: DEFERRED to the daily drained restart while the old id still
#     serves; immediate detached drained restart only when the old id fails
#     its own probe (the minor was retired upstream — every request on the
#     in-memory config fails until reload). The minor-applied event names
#     which of the two happened.
#   - major bump available -> NO edit; event 'major-ask' (worker relays ASK on
#     the dashboard + registers the user question — the user arbitrates).
#   - routing CURRENT but CLAUDISH_FAILOVER_ROLE_MODELS missing a pattern for a
#     family it already tracks -> event 'role-alias-ask' (report-only). This is
#     the hole the routing repin leaves behind: parseRoleAliases matches a
#     lowercased SUBSTRING, so 'gpt-6-sol' does not cover 'gpt-6.1-sol' and a
#     client naming the current id loses the cascade entirely. The check runs
#     BEFORE the network phase (it needs only config + env) and dedupes its
#     asks by (id, suggested alias) against the events log — one ask per hole,
#     not two every 6 hours (CR #344).
#   - nothing new -> one info line, zero writes.
#
# Phase 1 provider: Codex / ChatGPT backend (where minor churn bites — the
# 2026-10-02 gpt-6-sol -> gpt-6.1-sol bump, applied by hand, is the driver).
# Additional providers join as their /models surfaces are probed; the diff and
# edit logic is provider-agnostic (scripts/lib/claudish-model-version.psm1).
#
# Cascades (CLAUDISH_FAILOVER_*, container env) and profiles are NOT touched:
# they need a recreate and stay operator acts — the events name them so the
# worker's report can say "cascade still on the old minor, deliberate".
#
# Gated OFF by default: <ClaudishHome>\model-version-watch.enabled must contain
# 'enabled' (Test-ClaudishOptIn). Every unknown fails safe: no file, no probe,
# no edit, no restart.
#
# Usage (scheduled task, every 6h):
#   powershell -ExecutionPolicy Bypass -File scripts\model-version-watch.ps1
# Optional: -DryRun (print decisions, write nothing) · -ConfigPath · -ClaudishHome
#
# Task account: non-elevated jsboi (InteractiveToken / Limited) — the armed
# ClaudishModelVersionWatch task. The drained restart it launches targets the
# HUB by default: the drain resolves container claudish-proxy and probe URL
# localhost:3000 from -ClaudishHome. This watch is hub-only today (its config
# and env paths live under D:\claudish-shadow); on a SIDECAR those drain
# defaults point at the wrong container (#372) — pass the drain explicit
# -ContainerName/-ProxyUrl before ever copying this there.
#
# Targets PowerShell 5.1.

param(
    [string]$ConfigPath = 'D:\claudish-shadow\config\config.json',
    [string]$ClaudishHome = 'C:\Users\jsboi\.claudish',
    [string]$OAuthPath = 'D:\claudish-shadow\config\codex-oauth.json',
    [string]$DrainScript = 'D:\dev\claudish\scripts\claudish-drain.ps1',
    # Hub env file — read ONLY for the CLAUDISH_FAILOVER_ROLE_MODELS line (never
    # logged beyond that value, which carries no secret; the file itself holds
    # CLAUDISH_PROXY_KEY and must never be dumped).
    [string]$EnvFile = 'D:\claudish-shadow\.env',
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$logTs = { param($m) Write-Output ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }
$eventsPath = Join-Path $ClaudishHome 'model-version-events.log'

try {
    Import-Module (Join-Path $PSScriptRoot 'lib\claudish-model-version.psm1') -Force
} catch {
    & $logTs "FATAL module load: $($_.Exception.Message)"
    exit 1
}

if (-not (Test-ClaudishOptIn -ClaudishHome $ClaudishHome -Token 'enabled')) {
    & $logTs "opt-in file absent/disabled — doing nothing (expected on machines that never enrolled)"
    exit 0
}

# --- 1. Config (needed by BOTH the alias check and the routing diff) --------

if (-not (Test-Path -LiteralPath $ConfigPath)) { & $logTs "no config at $ConfigPath"; exit 0 }
try { $config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json } catch {
    & $logTs "FATAL config parse: $($_.Exception.Message)"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family config -Detail "config parse failed — refusing to touch anything"
    exit 1
}

# --- 2a. Coverage (#635 AC 1) -----------------------------------------------
#
# Printed as early as the config allows, BEFORE every network path and every
# other exit: a run whose provider listing fails (no OAuth file, 5xx, shape
# drift — all of them exit 0 later) still states how much of the routing this
# organ could see. That is the whole point of the line: the blind spot has to
# be visible on the first run, not on the third manual re-pin.
#
# Phase 1 watches the Codex backend; the other prefixes join as their /models
# surfaces are probed (see #635). The line names its UNIT — targets vs entries
# — because this hub's routing is 25 keys but 29 targets, and a fraction
# quoted without its unit reads as a different claim.
$watchedProviders = @('cx@', 'codex@')
$coverage = Get-RoutingCoverage -Routing $config.routing -WatchedProviders $watchedProviders
& $logTs (Format-RoutingCoverageLine -Coverage $coverage)

# --- 2b. Provider probe coverage (#635 AC 2) --------------------------------
#
# The coverage line above counts what the Codex path can SEE. This block says
# what the seat can actually PROBE, which is a different number and a different
# claim: a prefix listed here as probed had its own `/models` read with its own
# credential; a prefix that 401s, times out, or has no declared surface says so
# and never reads as "current" (issue #635, AC 2).
#
# REPORT-ONLY, this grain: it probes and it logs, it never edits routing. The
# apply path (decisions -> Edit-RoutingForMinor) waits for its own grain, so a
# 15 s probe cannot become an auto-repin on the first run. Placement is
# deliberate: BEFORE the Codex phase, which exits 0 on an OAuth/5xx failure —
# the blind spot has to stay visible on a run where that path dies.
$probeTargets = Get-ProviderProbeTargets -Routing $config.routing -CustomEndpoints $config.customEndpoints -OAuthProviders $watchedProviders
$apiKeys = $null
if ($null -ne $config -and $null -ne $config.PSObject.Properties['apiKeys']) { $apiKeys = $config.apiKeys }
$envLookup = { param($name) [Environment]::GetEnvironmentVariable($name) }
$probeOutcomes = @(Invoke-ProviderCatalogProbe -Targets $probeTargets -ApiKeys $apiKeys -EnvLookup $envLookup)
& $logTs (Format-ProviderProbeLine -Outcomes $probeOutcomes)
foreach ($o in @($probeOutcomes | Where-Object { $_.Status -eq 'probed' })) {
    & $logTs ("[probe] {0} lists {1} ids: {2}" -f $o.Prefix, @($o.Ids).Count, ((@($o.Ids) | Sort-Object) -join ', '))
}
$probeSplit = Split-ProbeDecisions -Decisions @(Compare-ProbedProviderToFamilies -Routing $config.routing -Outcomes $probeOutcomes)
foreach ($d in @($probeSplit.Minors)) {
    & $logTs ("[probe] would-repin {0} [{1}] {2} -> {3} ({4}) — report-only" -f $d.Spelling, $d.Provider, $d.CurrentId, $d.LatestId, $d.Action)
}
# A major on a probed provider is an ASK, exactly as on the Codex path: no edit,
# one 'major-ask' event per family. The two paths cannot double-ask — probe
# targets exclude the OAuth prefixes by construction. Both event sites are
# DEDUPED by (kind, family, from, to, provider): a 6h cadence re-observes the
# same report-only fact every run and the relay would carry it forever
# otherwise. The provider (#665 r1) keeps two same-transition facts on two
# providers distinct; the family-grouped asks key on the family's
# representative provider ($d0.Provider — the one the detail line names).
foreach ($fam in @($probeSplit.Majors | Group-Object Family)) {
    $d0 = @($fam.Group)[0]
    $fromIds = @($fam.Group | ForEach-Object { "$($_.Spelling)=$($_.CurrentId)" }) -join ','
    $askFrom = (@($fam.Group | ForEach-Object { $_.CurrentId } | Select-Object -Unique) -join ',')
    & $logTs ("[probe] MAJOR available: {0} {1} -> {2} on {3} — NOT applied, user arbitrates" -f $fam.Name, $fromIds, $d0.LatestId, $d0.Provider)
    if (-not $DryRun -and -not (Test-VersionEventEmitted -EventsPath $eventsPath -Kind major-ask -Family $fam.Name -From $askFrom -To $d0.LatestId -Provider $d0.Provider)) {
        Write-VersionEvent -EventsPath $eventsPath -Kind major-ask -Family $fam.Name `
            -From $askFrom `
            -To $d0.LatestId -Provider $d0.Provider -Detail "probed on $($d0.Provider) — spellings: $fromIds"
    }
}
if (-not $DryRun -and @($probeSplit.Minors).Count -gt 0) {
    foreach ($d in @($probeSplit.Minors)) {
        if (Test-VersionEventEmitted -EventsPath $eventsPath -Kind info -Family $d.Family -From $d.CurrentId -To $d.LatestId -Provider $d.Provider) { continue }
        Write-VersionEvent -EventsPath $eventsPath -Kind info -Family $d.Family `
            -From $d.CurrentId -To $d.LatestId -Provider $d.Provider `
            -Detail "probe would-repin spelling $($d.Spelling) on $($d.Provider) ($($d.Action)) — report-only, not applied"
    }
}

# --- 2. Role-alias drift (needs NO network — runs before every network exit) -
#
# PLACEMENT IS LOAD-BEARING TWICE: the drift is the STEADY STATE (routing
# already current, alias table left behind by an earlier bump — measured
# 2026-10-05: gpt-6.1-sol repinned 02/10, ROLE_MODELS stale for three days),
# AND the check needs only config + env — an expired OAuth token or a
# chatgpt.com outage must not disable it (CR #344: six early exits used to sit
# in front of it, so a network hiccup silently skipped the check).
#
# REPORT-ONLY, deliberately: ROLE_MODELS lives in the hub's env, and changing
# it needs a drained recreate — an operator act, exactly like the cascades.
# The detector reads the ENV FILE, not the live container: after an edit
# without recreate it reports no drift while the running proxy still has the
# hole — the #141 drain guard owns that comparison at the next recreate.
$roleModels = ''
if (Test-Path -LiteralPath $EnvFile) {
    try {
        $envText = [System.IO.File]::ReadAllText($EnvFile)
        foreach ($line in @($envText -split "`n")) {
            $t = $line.Trim()
            if ($t -like 'export CLAUDISH_FAILOVER_ROLE_MODELS=*') { $t = $t.Substring(7) }
            if ($t -like 'CLAUDISH_FAILOVER_ROLE_MODELS=*') {
                $roleModels = $t.Substring($t.IndexOf('=') + 1).Trim()
                if ($roleModels.Length -ge 2 -and $roleModels[0] -eq $roleModels[$roleModels.Length - 1] -and
                    ($roleModels[0] -eq '"' -or $roleModels[0] -eq "'")) {
                    $roleModels = $roleModels.Substring(1, $roleModels.Length - 2)
                }
                break
            }
        }
    } catch { & $logTs "role-models read failed (non-fatal, check skipped): $($_.Exception.Message)" }
}
if ($roleModels) {
    $drift = @(Compare-RoleModelsToRouting -Routing $config.routing -RoleModels $roleModels)
    if ($drift.Count -eq 0) {
        & $logTs "role aliases: no drift — every tracked-family name a client can send resolves to a role"
    } else {
        foreach ($r in $drift) {
            & $logTs "ROLE-ALIAS DRIFT: a client naming '$($r.Id)' resolves to NO role (no keyword, no alias pattern covers it) and gets no cascade — suggest '$($r.Suggested)'"
            if (-not $DryRun) {
                if (Test-RoleAliasAskEmitted -EventsPath $eventsPath -Id $r.Id -Suggested $r.Suggested) {
                    & $logTs "role-alias-ask for '$($r.Id)' already emitted with the same suggestion — not re-asking (events log is the dedupe state)"
                } else {
                    Write-VersionEvent -EventsPath $eventsPath -Kind role-alias-ask -Family $r.Family `
                        -From $r.Suggested -To $r.Id `
                        -Detail "CLAUDISH_FAILOVER_ROLE_MODELS has no pattern covering the client-nameable id '$($r.Id)': roleFromModelName falls through keywords and aliases to null, so a client naming it loses the cascade entirely. Suggested addition: $($r.Suggested) — env change + drained recreate, operator act."
                }
            }
        }
    }
} else {
    & $logTs "role aliases: no CLAUDISH_FAILOVER_ROLE_MODELS line in $EnvFile (absent or unreadable) — drift check skipped"
}

# --- 3. Available versions (Codex backend, OAuth; token never logged) -------

if (-not (Test-Path -LiteralPath $OAuthPath)) {
    & $logTs "no OAuth file at $OAuthPath — provider skipped, nothing to compare"
    exit 0
}
try { $oauth = [System.IO.File]::ReadAllText($OAuthPath) | ConvertFrom-Json } catch {
    & $logTs "FATAL oauth parse: $($_.Exception.Message)"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family codex -Detail "oauth parse failed"
    exit 1
}
$token = $null; $accountId = $null
if ($oauth.tokens -and $oauth.tokens.access_token) { $token = $oauth.tokens.access_token }
elseif ($oauth.access_token) { $token = $oauth.access_token }
if ($oauth.account_id) { $accountId = $oauth.account_id }
elseif ($oauth.tokens -and $oauth.tokens.account_id) { $accountId = $oauth.tokens.account_id }
if (-not $token) {
    & $logTs "oauth file holds no access_token (keys: $($oauth.PSObject.Properties.Name -join ','))"
    exit 0
}

$headers = @{ Authorization = "Bearer $token" }
if ($accountId) { $headers['chatgpt-account-id'] = $accountId }

try {
    $resp = Invoke-RestMethod -Uri 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0' `
        -Headers $headers -Method Get -TimeoutSec 30
} catch {
    & $logTs "models list failed: $($_.Exception.Message)"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family codex -Detail "models list: $($_.Exception.Message)"
    exit 0   # a failed watch is a no-op, never an incident
}
# Unwrap the listing (measured shape: a wrapper object — unwrap .data/.models
# like the live bun probe does — never enumerate the wrapper itself, which
# yields zero ids and a silent no-op).
$list = $resp
if ($resp -is [pscustomobject] -and $resp.PSObject.Properties['data']) { $list = $resp.data }
elseif ($resp -is [pscustomobject] -and $resp.PSObject.Properties['models']) { $list = $resp.models }
$available = @($list | ForEach-Object { if ($_ -is [string]) { $_ } elseif ($_.id) { $_.id } elseif ($_.slug) { $_.slug } })
if ($available.Count -eq 0) {
    & $logTs "models listing parsed to 0 ids — treating as no-signal, no-op"
    Write-VersionEvent -EventsPath $eventsPath -Kind error -Family codex -Detail "models listing parsed to 0 ids (shape drifted?)"
    exit 0
}
& $logTs "provider lists $($available.Count) ids: $($available -join ', ')"

# --- 4. Diff against routing ------------------------------------------------

# $watchedProviders is defined once, in section 2a — the coverage line and this
# diff must never disagree about what "watched" means.
$decisions = Compare-RoutingToFamilies -Routing $config.routing -AvailableIds $available -WatchedProviders $watchedProviders
$pending = @($decisions | Where-Object { $_.Action -ne 'current' })
& $logTs ("decisions: " + (($decisions | ForEach-Object { "$($_.Family)/$($_.Action)[$($_.Spelling): $($_.CurrentId)->$($_.LatestId)]" }) -join ' ; '))

if ($pending.Count -eq 0) { exit 0 }

# Report-only (B1): a member of a tracked family on a provider this runner does
# NOT list/probe (or bare, whose chain the module cannot resolve) is never
# edited — repinning it to an id probed on the Codex backend would enter
# routing an unprobeable target. Reported so the omission is visible.
foreach ($d in @($pending | Where-Object { -not $_.Eligible })) {
    $shown = 'bare (default chain)'
    if ($d.Provider) { $shown = $d.Provider }
    & $logTs "REPORT-ONLY $($d.Family) [provider $shown]: $($d.CurrentId) -> $($d.LatestId) — not probed, not touched"
    # Same (kind, family, from, to, provider) dedup as the probe path: an
    # ineligible family is the same fact every 6h run until the operator
    # arbitrates — but the SAME family on several providers is several facts
    # (#665 r1: the provider-less key swallowed all but the first on run one).
    if (-not $DryRun -and -not (Test-VersionEventEmitted -EventsPath $eventsPath -Kind info -Family $d.Family -From $d.CurrentId -To $d.LatestId -Provider $shown)) {
        Write-VersionEvent -EventsPath $eventsPath -Kind info -Family $d.Family `
            -From $d.CurrentId -To $d.LatestId -Provider $shown `
            -Detail "same family on provider '$shown' (spelling $($d.Spelling)); not probed, not touched — eligibility scoped to the watched provider"
    }
}
$actionable = @($pending | Where-Object { $_.Eligible })
if ($actionable.Count -eq 0) { exit 0 }

# --- 3. Apply policy ---------------------------------------------------------
#
# Decisions are PER SPELLING (review #307 D2/D3): a family whose spellings sit
# on different majors yields minor for the on-latest-major spelling AND
# major-ask for the older one, in the same pass. Applied per FAMILY: one
# acceptance probe per family (all minor spellings of a family share the same
# LatestId), then one surgical edit carrying every spelling's own target.
#
# Only ELIGIBLE members are acted on (review #307 B1): eligibility is scoped to
# the provider this runner lists/probes. A member of a tracked family on any
# other provider (or bare) is report-only — an info event, never edited — so an
# id probed only on the Codex backend never enters routing under oai@/bare.

function Invoke-ModelProbe {
    # Networking ONLY: returns the raw HTTP status + accumulated body. The
    # ACCEPTANCE / RETIREMENT decisions are the pure Test-ProbeAccepted and
    # Test-ModelRetired in the module (review #307 B3) — a guard in glue can be
    # deleted silently. Probe constraints measured 2026-10-02: stream must be
    # true, max_output_tokens must be absent.
    param([Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)]$Headers)
    $probe = @{ StatusCode = 0; Content = '' }
    try {
        $body = @{
            model = $Id
            instructions = 'Reply with exactly: ok'
            input = @(@{ role = 'user'; content = @(@{ type = 'input_text'; text = 'say ok' }) })
            stream = $true
            store = $false
        } | ConvertTo-Json -Depth 8
        $resp = Invoke-WebRequest -Uri 'https://chatgpt.com/backend-api/codex/responses' `
            -Headers $Headers -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 90
        $probe.StatusCode = [int]$resp.StatusCode
        $probe.Content = [string]$resp.Content
    } catch {
        # Non-2xx throws: capture the status, and the body when the interpreter
        # exposes it (5.1 HttpWebResponse.GetResponseStream, pwsh 7
        # HttpResponseMessage.Content) so a 4xx naming the model is read.
        $r = $_.Exception.Response
        if ($r) {
            try { $probe.StatusCode = [int]$r.StatusCode } catch {}
            try {
                if ($r.GetResponseStream) {
                    $sr = New-Object System.IO.StreamReader($r.GetResponseStream())
                    $probe.Content = $sr.ReadToEnd()
                } elseif ($r.Content) {
                    $probe.Content = $r.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                }
            } catch {}
        }
    }
    return $probe
}

$majors = @($actionable | Where-Object Action -eq 'major')
foreach ($fam in @($majors | Group-Object Family)) {
    $d0 = @($fam.Group)[0]
    $fromIds = @($fam.Group | ForEach-Object { "$($_.Spelling)=$($_.CurrentId)" }) -join ','
    $askFrom = (@($fam.Group | ForEach-Object { $_.CurrentId } | Select-Object -Unique) -join ',')
    & $logTs "MAJOR available: $($fam.Name) $($fromIds) -> $($d0.LatestId) — NOT applied, user arbitrates"
    if (-not $DryRun -and -not (Test-VersionEventEmitted -EventsPath $eventsPath -Kind major-ask -Family $fam.Name -From $askFrom -To $d0.LatestId)) {
        Write-VersionEvent -EventsPath $eventsPath -Kind major-ask -Family $fam.Name `
            -From $askFrom `
            -To $d0.LatestId -Detail "spellings: $fromIds"
    }
}

$restartNow = $false
$restartWhy = @()
$minors = @($actionable | Where-Object Action -eq 'minor')
foreach ($fam in @($minors | Group-Object Family)) {
    $latestId = @($fam.Group)[0].LatestId
    $fromIds = (@($fam.Group | ForEach-Object { $_.CurrentId } | Select-Object -Unique) -join ',')

    # Acceptance probe BEFORE any edit — a listed id that does not serve never
    # enters routing (deepseek lesson: probe before trusting either direction).
    $accept = Invoke-ModelProbe -Id $latestId -Headers $headers
    if (-not (Test-ProbeAccepted -StatusCode $accept.StatusCode -Content $accept.Content)) {
        & $logTs "probe REFUSED for $latestId (HTTP $($accept.StatusCode)) — no edit (listed but not serving, or probe shape drifted)"
        if (-not $DryRun) {
            Write-VersionEvent -EventsPath $eventsPath -Kind probe-fail -Family $fam.Name -To $latestId `
                -Detail "acceptance probe did not complete 'response.completed' (HTTP $($accept.StatusCode)) — listed but not serving"
        }
        continue
    }

    $repins = @{}
    foreach ($d in $fam.Group) { $repins[$d.Spelling] = $d.NewTarget }
    # The new spelling takes a provider-qualified target when any spelling of
    # the family carries one; bare spellings repin bare (per-spelling, D1).
    $newTarget = ''
    foreach ($d in $fam.Group) { if ($d.Provider) { $newTarget = $d.NewTarget } }
    if (-not $newTarget) { $newTarget = $latestId }

    if ($DryRun) {
        & $logTs "DRYRUN would repin $($fam.Name): $(@($repins.GetEnumerator() | ForEach-Object { "$($_.Key) -> $($_.Value)" }) -join '; ') + register $latestId -> $newTarget"
        continue
    }
    $backup = Edit-RoutingForMinor -ConfigPath $ConfigPath -Family $fam.Name -Repins $repins `
        -NewSpelling $latestId -NewSpellingTarget $newTarget -ProviderPrefixes $watchedProviders
    if (-not $backup) {
        & $logTs "edit REFUSED for $($fam.Name) (parse/empty diff) — no restart"
        Write-VersionEvent -EventsPath $eventsPath -Kind error -Family $fam.Name -Detail "Edit-RoutingForMinor refused"
        continue
    }

    # Reload decision (D4): the config on disk has moved; whether the hub
    # reloads NOW or at the daily drained restart depends on whether the OLD
    # id still serves. All old ids still answering = nothing is broken by
    # serving from the in-memory config one more day — defer. An old id that
    # fails its own probe = the minor was retired upstream = every request
    # routed to it fails until reload — restart now, detached, drained.
    # Reload decision (D4 + review #307 non-blocking). Only an old id CONFIRMED
    # retired (a 4xx naming the model) forces an immediate restart — a restart
    # is a stream killer, so a 429/5xx/timeout on the old id is 'status unknown'
    # and defers. All old ids still serving => defer to the daily drained restart.
    $deadOld = @()
    $unknownOld = @()
    foreach ($oldId in @($fam.Group | ForEach-Object { $_.CurrentId } | Select-Object -Unique)) {
        $op = Invoke-ModelProbe -Id $oldId -Headers $headers
        if (Test-ProbeAccepted -StatusCode $op.StatusCode -Content $op.Content) { continue }   # still serves
        if (Test-ModelRetired -StatusCode $op.StatusCode -ModelId $oldId -Content $op.Content) {
            $deadOld += $oldId
        } else {
            $unknownOld += "$oldId(HTTP $($op.StatusCode))"
        }
    }
    $reloadMode = Get-ReloadMode -DeadOldIds $deadOld
    $reloadDetail = 'deferred-to-daily-restart'
    if ($reloadMode -eq 'restart-now') {
        $restartNow = $true
        $restartWhy += "$($fam.Name): old id(s) retired: $($deadOld -join ',')"
        $reloadDetail = "restart-now (old id(s) $($deadOld -join ',') retired)"
    } elseif ($unknownOld.Count -gt 0) {
        $reloadDetail = "deferred-to-daily-restart (old id status unknown: $($unknownOld -join ','))"
    }

    Write-VersionEvent -EventsPath $eventsPath -Kind minor-applied -Family $fam.Name -From $fromIds -To $latestId `
        -Detail "spellings repinned: $(@($repins.Keys) -join ','); reload: $reloadDetail; backup: $backup; cascades/profiles untouched (operator act)"
    & $logTs "MINOR applied: $($fam.Name) $fromIds -> $latestId (reload: $reloadDetail; backup $backup)"
}

# --- 4. Reload (config.json is bind-mounted: a drained docker RESTART re-reads
#        it; env is preserved, so cascades are safe — measured 2026-09-15) ----

if (-not $DryRun -and $restartNow) {
    if (-not (Test-Path -LiteralPath $DrainScript)) {
        & $logTs "old id retired but drain script not found at $DrainScript — reload deferred, escalate"
        Write-VersionEvent -EventsPath $eventsPath -Kind error -Family reload `
            -Detail "restart-now decided ($($restartWhy -join '; ')) but drain script absent — routing repinned, hub still on old id"
    } else {
        # Through the drain's OWN -Detach path (#352): the previous inline
        # Start-Process passed -Reason unquoted in -ArgumentList, the child
        # died at parameter binding, and the log still said "launching" —
        # the restart never happened. -Detach quotes every forwarded argument
        # itself and hands back a countable exit code; the OUTCOME is logged
        # and evented, never just the attempt. -ClaudishHome/-LogPath are
        # forwarded EXPLICITLY (CR #377): the drain otherwise resolves its
        # home from $env:USERPROFILE, which under this task's account is a
        # different directory — the probe URL, the freeze consent, drain.log
        # and the detach captures would all land where nobody reads them.
        $null = Invoke-DrainDetachedRestart -DrainScript $DrainScript `
            -Reason ("model-version-watch minor repin (old id retired): " + ($restartWhy -join '; ')) `
            -ClaudishHome $ClaudishHome `
            -LogPath (Join-Path $ClaudishHome 'drain.log') `
            -Log $logTs `
            -WriteEvent { param($kind, $family, $detail)
                Write-VersionEvent -EventsPath $eventsPath -Kind $kind -Family $family -Detail $detail }
    }
}
exit 0
