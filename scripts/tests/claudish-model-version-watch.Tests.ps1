# claudish-model-version-watch.Tests.ps1 — pins for the version-watch organ
#
# Run under BOTH interpreters (bun run test:scripts / test:scripts:win51) —
# production runs 5.1. Pure logic: no network, no docker, no scheduled task.
# The networked runner is exercised by its -DryRun mode + the live arming
# procedure, not by this suite.
#
# Pester 5/6 structure: fixtures live in BeforeAll ($script: scope) — a
# Describe-level plain variable is NOT visible inside It blocks, which is
# exactly the failure shape the first draft had (empty $ids -> "expected X,
# got $null" everywhere while the functions were correct).

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\lib\claudish-model-version.psm1') -Force
}

Describe 'ConvertTo-ModelVersion parsing' {
    It 'parses minor-versioned family ids' {
        $v = ConvertTo-ModelVersion -Id 'gpt-6.1-sol'
        $v.Family | Should -Be 'gpt-sol'
        $v.Major | Should -Be 6
        $v.Minor | Should -Be 1
    }
    It 'treats a version without minor as .0' {
        $v = ConvertTo-ModelVersion -Id 'gpt-6-sol'
        $v.Family | Should -Be 'gpt-sol'
        $v.Minor | Should -Be 0
    }
    It 'keeps older-major spellings in the same family (alias precedent)' {
        (ConvertTo-ModelVersion -Id 'gpt-5.6-sol').Family | Should -Be 'gpt-sol'
    }
    It 'parses v-prefixed and suffix families' {
        $v = ConvertTo-ModelVersion -Id 'deepseek-v4.1-flash'
        $v.Family | Should -Be 'deepseek-flash'
        $v.Major | Should -Be 4
        $v.Minor | Should -Be 1
    }
    It 'parses dashless version schemes (qwen3.8-max)' {
        $v = ConvertTo-ModelVersion -Id 'qwen3.8-max'
        $v.Family | Should -Be 'qwen-max'
        $v.Major | Should -Be 3
        $v.Minor | Should -Be 8
    }
    It 'parses bare versioned families (glm-5.3)' {
        $v = ConvertTo-ModelVersion -Id 'glm-5.3'
        $v.Family | Should -Be 'glm'
        $v.Major | Should -Be 5
        $v.Minor | Should -Be 3
    }
    It 'returns null for rolling/unversioned ids' {
        foreach ($id in @('gpt-reserve', 'MiniMax-M3', 'kimi-for-coding', 'mistral-medium-latest', 'deepseek-flash', 'codex-auto-review')) {
            (ConvertTo-ModelVersion -Id $id) | Should -BeNullOrEmpty
        }
    }
    It 'treats a second variant as a DIFFERENT family (astra is not sol)' {
        (ConvertTo-ModelVersion -Id 'gpt-6-astra').Family | Should -Be 'gpt-astra'
    }
}

Describe 'Get-LatestFamilyVersion' {
    BeforeAll {
        $script:ids = @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-reserve')
    }
    It 'picks the highest minor within one family' {
        (Get-LatestFamilyVersion -Family 'gpt-sol' -AvailableIds $script:ids).Id | Should -Be 'gpt-6.1-sol'
    }
    It 'ignores other families and unparseable ids' {
        (Get-LatestFamilyVersion -Family 'gpt-luna' -AvailableIds $script:ids).Id | Should -Be 'gpt-6-luna'
        (Get-LatestFamilyVersion -Family 'gpt-terra' -AvailableIds $script:ids) | Should -BeNullOrEmpty
    }
}

Describe 'Compare-RoutingToFamilies decisions' {
    BeforeAll {
        $script:routing = [pscustomobject]@{
            'gpt-6-sol'   = @('cx@gpt-6-sol')
            'gpt-5.6-sol' = @('cx@gpt-5.6-sol')
            'gpt-6.1-sol' = @('cx@gpt-6.1-sol')
            'gpt-6-astra' = @('cx@gpt-6-astra')
            'glm-5.3'     = @('gc@glm-5.3')
        }
        $script:available = @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'glm-5.3')
    }
    It 'yields ONE decision PER SPELLING, each judged on its own version' {
        $d = @(Compare-RoutingToFamilies -Routing $script:routing -AvailableIds $script:available)
        $sol = @($d | Where-Object Family -eq 'gpt-sol')
        $sol.Count | Should -Be 3   # three spellings, three decisions — not one per family
        (@($sol | Where-Object Spelling -eq 'gpt-6-sol')[0].Action) | Should -Be 'minor'     # 6.0 -> 6.1
        (@($sol | Where-Object Spelling -eq 'gpt-5.6-sol')[0].Action) | Should -Be 'major'   # 5.6 -> 6
        (@($sol | Where-Object Spelling -eq 'gpt-6.1-sol')[0].Action) | Should -Be 'current'
    }
    It 'is order-independent: same entries in any key order give the same decision set (D2)' {
        $a = [pscustomobject][ordered]@{ 'stale' = @('cx@gpt-6-sol'); 'fresh' = @('cx@gpt-6.1-sol') }
        $b = [pscustomobject][ordered]@{ 'fresh' = @('cx@gpt-6.1-sol'); 'stale' = @('cx@gpt-6-sol') }
        $avail = @('gpt-6.1-sol', 'gpt-6-sol')
        # Compare as spelling->action maps, never as ordered lists: the test
        # must be order-agnostic by construction. (A first draft compared
        # Sort-Object output — under 5.1 Sort-Object does not see hashtable
        # properties, sorted on a null key and flipped one of the two orders.)
        $mapA = @{}; foreach ($d in @(Compare-RoutingToFamilies -Routing $a -AvailableIds $avail)) { $mapA[$d.Spelling] = $d.Action }
        $mapB = @{}; foreach ($d in @(Compare-RoutingToFamilies -Routing $b -AvailableIds $avail)) { $mapB[$d.Spelling] = $d.Action }
        $mapA.Count | Should -Be 2
        $mapB.Count | Should -Be 2
        # The defect this pins: first-seen-family keyed 'fresh' as stale when
        # 'stale' came first — 'fresh' must be CURRENT in BOTH orders.
        $mapA['fresh'] | Should -Be 'current'
        $mapB['fresh'] | Should -Be 'current'
        $mapA['stale'] | Should -Be 'minor'
        $mapB['stale'] | Should -Be 'minor'
    }
    It 'mixed majors in one family: minor for the on-major spelling, major for the older (D3)' {
        $r = [pscustomobject]@{ 'a' = @('cx@gpt-6-sol'); 'b' = @('cx@gpt-5.6-sol') }
        $d = Compare-RoutingToFamilies -Routing $r -AvailableIds @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol')
        (@($d | Where-Object Spelling -eq 'a')[0].Action) | Should -Be 'minor'
        (@($d | Where-Object Spelling -eq 'b')[0].Action) | Should -Be 'major'
    }
    It 'keeps the provider prefix ONLY from a value that has one (D1)' {
        $r = [pscustomobject]@{ 'qualified' = @('cx@gpt-6-sol'); 'bare' = @('gpt-6-sol') }
        $d = Compare-RoutingToFamilies -Routing $r -AvailableIds @('gpt-6.1-sol', 'gpt-6-sol')
        (@($d | Where-Object Spelling -eq 'qualified')[0].NewTarget) | Should -Be 'cx@gpt-6.1-sol'
        # The defect this pins: bare values used to fabricate 'gpt-6-sol@gpt-6.1-sol'.
        (@($d | Where-Object Spelling -eq 'bare')[0].NewTarget) | Should -Be 'gpt-6.1-sol'
        (@($d | Where-Object Spelling -eq 'bare')[0].Provider) | Should -Be ''
        (@($d | Where-Object Spelling -eq 'qualified')[0].Eligible) | Should -Be $true    # cx@ is watched
        (@($d | Where-Object Spelling -eq 'bare')[0].Eligible) | Should -Be $false        # bare is report-only
    }
    It 'scopes eligibility to the watched provider (B1): cx@ eligible, oai@/bare report-only' {
        $r = [pscustomobject][ordered]@{
            'via-codex'      = @('cx@gpt-6-sol')
            'via-openai-api' = @('oai@gpt-6-sol')
            'bare'           = @('gpt-6-sol')
        }
        $d = Compare-RoutingToFamilies -Routing $r -AvailableIds @('gpt-6.1-sol', 'gpt-6-sol') -WatchedProviders @('cx@', 'codex@')
        (@($d | Where-Object Spelling -eq 'via-codex')[0].Eligible)      | Should -Be $true
        (@($d | Where-Object Spelling -eq 'via-openai-api')[0].Eligible) | Should -Be $false
        (@($d | Where-Object Spelling -eq 'bare')[0].Eligible)           | Should -Be $false
        # eligibility gates the EDIT, not the computation: all three still read 'minor'
        (@($d | Where-Object Spelling -eq 'via-openai-api')[0].Action)   | Should -Be 'minor'
    }
    It 'reports current when routing already points at the latest' {
        $d = Compare-RoutingToFamilies -Routing $script:routing -AvailableIds $script:available
        (@($d | Where-Object Family -eq 'gpt-astra')[0].Action) | Should -Be 'current'
        (@($d | Where-Object Family -eq 'glm')[0].Action) | Should -Be 'current'
    }
    It 'never proposes a downgrade (routing ahead of the listing stays current)' {
        $r = [pscustomobject]@{ 'ahead' = @('cx@gpt-6.2-sol') }
        $d = Compare-RoutingToFamilies -Routing $r -AvailableIds @('gpt-6.1-sol')
        (@($d | Where-Object Spelling -eq 'ahead')[0].Action) | Should -Be 'current'
    }
}

Describe 'Edit-RoutingForMinor surgery' {
    BeforeAll {
        $script:tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mvw-{0}.json" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
        $script:config = @{
            apiKeys  = @{ DEMO_KEY = 'value-that-must-survive' }
            routing  = @{
                'gpt-6-sol' = @('cx@gpt-6-sol')
                'gpt-5.6-sol' = @('cx@gpt-5.6-sol')
                'glm-5.3'   = @('gc@glm-5.3')
            }
            profiles = @{ default = @{ models = @{ sonnet = 'glm-5.3' } } }
        }
    }
    BeforeEach {
        [System.IO.File]::WriteAllText($script:tmp, ($script:config | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
    }
    AfterAll {
        if (Test-Path $script:tmp) { Remove-Item $script:tmp -Force }
        Get-ChildItem "$($script:tmp).bak-*" -ErrorAction SilentlyContinue | Remove-Item -Force
    }

    It 'repins each spelling to its OWN target and registers the new spelling' {
        $backup = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol'; 'gpt-5.6-sol' = 'cx@gpt-6.1-sol' } `
            -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' -ProviderPrefixes @('cx@')
        $backup | Should -Not -BeNullOrEmpty
        (Test-Path $backup) | Should -Be $true
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'gpt-6-sol' | Should -Be 'cx@gpt-6.1-sol'
        $after.routing.'gpt-5.6-sol' | Should -Be 'cx@gpt-6.1-sol'
        $after.routing.'gpt-6.1-sol' | Should -Be 'cx@gpt-6.1-sol'
    }
    It 'LEAVES a bare member in place — report-only, never edited (B1)' {
        # A bare value resolves through the default chain, which this runner
        # does not list/probe; editing it would enter an unprobeable target.
        $r = @{ routing = @{ 'gpt-6-sol' = @('gpt-6-sol') } }
        [System.IO.File]::WriteAllText($script:tmp, ($r | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'gpt-6.1-sol' `
            -ProviderPrefixes @('cx@')
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'gpt-6-sol' | Should -Be 'gpt-6-sol'   # untouched
    }
    It 'moves ONLY the watched-provider member of a same-family chain; the other stays in place (B2)' {
        # The defect this pins: a single target per spelling was written into
        # EVERY member of the family, duplicating the survivor and deleting the
        # oai@ lane (cx@gpt-6-sol, oai@gpt-6-sol -> oai@gpt-6.1-sol x2).
        $r = @{ routing = @{ 'sonnet' = @('cx@gpt-6-sol', 'oai@gpt-6-sol') } }
        [System.IO.File]::WriteAllText($script:tmp, ($r | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'sonnet' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' `
            -ProviderPrefixes @('cx@')
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        @($after.routing.sonnet).Count | Should -Be 2
        @($after.routing.sonnet)[0] | Should -Be 'cx@gpt-6.1-sol'   # cx@ member moved
        @($after.routing.sonnet)[1] | Should -Be 'oai@gpt-6-sol'    # oai@ member untouched, in place
    }
    It 'keeps the member OWN prefix when it differs from the repin (codex@ stays codex@)' {
        $r = @{ routing = @{ 'gpt-6-sol' = @('codex@gpt-6-sol') } }
        [System.IO.File]::WriteAllText($script:tmp, ($r | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' `
            -ProviderPrefixes @('cx@', 'codex@')
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'gpt-6-sol' | Should -Be 'codex@gpt-6.1-sol'
    }
    It 'preserves the OTHER-family member of a multi-target spelling' {
        $r = @{ routing = @{ 'sonnet' = @('cx@gpt-6-sol', 'gc@glm-5.3') } }
        [System.IO.File]::WriteAllText($script:tmp, ($r | ConvertTo-Json -Depth 16), (New-Object System.Text.UTF8Encoding($false)))
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'sonnet' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' -ProviderPrefixes @('cx@')
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        @($after.routing.sonnet).Count | Should -Be 2
        @($after.routing.sonnet)[0] | Should -Be 'cx@gpt-6.1-sol'   # gpt-sol member moved
        @($after.routing.sonnet)[1] | Should -Be 'gc@glm-5.3'       # glm member preserved in place
    }
    It 'leaves other families, apiKeys and profiles intact in value' {
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' -ProviderPrefixes @('cx@')
        $after = [System.IO.File]::ReadAllText($script:tmp) | ConvertFrom-Json
        $after.routing.'glm-5.3' | Should -Be 'gc@glm-5.3'
        $after.apiKeys.DEMO_KEY | Should -Be 'value-that-must-survive'
        $after.profiles.default.models.sonnet | Should -Be 'glm-5.3'
    }
    It 'refuses on unparseable config (returns null, file untouched)' {
        [System.IO.File]::WriteAllText($script:tmp, 'this is not json {{{', (New-Object System.Text.UTF8Encoding($false)))
        $before = [System.IO.File]::ReadAllText($script:tmp)
        $r = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' -ProviderPrefixes @('cx@')
        $r | Should -BeNullOrEmpty
        [System.IO.File]::ReadAllText($script:tmp) | Should -Be $before
    }
    It 'refuses on a missing file' {
        (Edit-RoutingForMinor -ConfigPath "$($script:tmp)-absent" -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' -ProviderPrefixes @('cx@')) | Should -BeNullOrEmpty
    }
    It 'is idempotent when the target already holds the value (no diff, no backup)' {
        $null = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' -ProviderPrefixes @('cx@')
        $b1 = (Get-ChildItem "$($script:tmp).bak-*").Count
        # Second call with the same targets: every spelling and the new-spelling
        # entry already hold the value — $changed stays false, null returned,
        # NO second backup. (Pinned because the first draft set $changed
        # unconditionally and wrote a fresh backup every run.)
        $r2 = Edit-RoutingForMinor -ConfigPath $script:tmp -Family 'gpt-sol' `
            -Repins @{ 'gpt-6-sol' = 'cx@gpt-6.1-sol' } -NewSpelling 'gpt-6.1-sol' -NewSpellingTarget 'cx@gpt-6.1-sol' -ProviderPrefixes @('cx@')
        $r2 | Should -BeNullOrEmpty
        (Get-ChildItem "$($script:tmp).bak-*").Count | Should -Be $b1
    }
}

Describe 'Test-ProbeAccepted (B3/D5 acceptance gate, extracted from the runner)' {
    It 'refuses a 200 whose body has no terminal response.completed (in-stream error, #65 class)' {
        # The defect this pins: the runner accepted on StatusCode alone, so a
        # 200 carrying an in-stream failure passed the gate before an edit.
        (Test-ProbeAccepted -StatusCode 200 -Content '{"type":"error","error":{"message":"invalid_prompt"}}') | Should -Be $false
    }
    It 'accepts only a 200 carrying a terminal response.completed' {
        (Test-ProbeAccepted -StatusCode 200 -Content 'data: {"type":"response.completed"}') | Should -Be $true
    }
    It 'refuses any non-200 even with the marker present' {
        (Test-ProbeAccepted -StatusCode 429 -Content 'response.completed') | Should -Be $false
        (Test-ProbeAccepted -StatusCode 0 -Content 'response.completed') | Should -Be $false
    }
}

Describe 'Test-ModelRetired + Get-ReloadMode (B3/D4 reload decision, extracted)' {
    It 'a 4xx naming the model is retired' {
        (Test-ModelRetired -StatusCode 404 -ModelId 'gpt-6-sol' -Content '{"detail":"model gpt-6-sol not found"}') | Should -Be $true
    }
    It 'a 4xx that says unknown/not-found/unretired-marker is retired' {
        (Test-ModelRetired -StatusCode 400 -ModelId 'gpt-6-sol' -Content '{"error":"unknown model"}') | Should -Be $true
    }
    It 'a 429 is NOT retired — status unknown, no restart (stream killer)' {
        (Test-ModelRetired -StatusCode 429 -ModelId 'gpt-6-sol' -Content 'rate limit exceeded for gpt-6-sol') | Should -Be $false
    }
    It 'a 5xx is NOT retired' {
        (Test-ModelRetired -StatusCode 503 -ModelId 'gpt-6-sol' -Content 'gpt-6-sol unavailable') | Should -Be $false
    }
    It 'auth/timeout 4xx are NOT retired even when the body names the model (401/403/408/429 excluded)' {
        (Test-ModelRetired -StatusCode 403 -ModelId 'gpt-6-sol' -Content '{"detail":"forbidden: gpt-6-sol"}') | Should -Be $false
        (Test-ModelRetired -StatusCode 408 -ModelId 'gpt-6-sol' -Content 'timeout waiting for gpt-6-sol') | Should -Be $false
    }
    It 'a 4xx neither naming the model nor using a retirement marker is NOT retired' {
        (Test-ModelRetired -StatusCode 400 -ModelId 'gpt-6-sol' -Content '{"error":"malformed request"}') | Should -Be $false
    }
    It 'Get-ReloadMode: empty -> deferred, any confirmed-dead id -> restart-now' {
        (Get-ReloadMode -DeadOldIds @()) | Should -Be 'deferred'
        (Get-ReloadMode -DeadOldIds @('gpt-6-sol')) | Should -Be 'restart-now'
    }
}

Describe 'model-version-watch.ps1 runner wiring (B1/B3)' {
    BeforeAll { $script:RunnerPath = Join-Path $PSScriptRoot '..\model-version-watch.ps1' }
    It 'parses under this interpreter (production runs 5.1)' {
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($script:RunnerPath, [ref]$null, [ref]$errors)
        @($errors).Count | Should -Be 0
    }
    It 'consults the PURE guards, never re-implements them in glue (B3)' {
        $text = Get-Content -LiteralPath $script:RunnerPath -Raw
        $text | Should -Match 'Test-ProbeAccepted'
        $text | Should -Match 'Test-ModelRetired'
        $text | Should -Match 'Get-ReloadMode'
        # the old status-only acceptance glue must be gone
        $text | Should -Not -Match '\$resp\.Content -notmatch'
    }
    It 'scopes eligibility and the edit to the watched providers (B1)' {
        $text = Get-Content -LiteralPath $script:RunnerPath -Raw
        $text | Should -Match '-WatchedProviders \$watchedProviders'
        $text | Should -Match '-ProviderPrefixes \$watchedProviders'
        $text | Should -Match 'REPORT-ONLY'
    }
    It 'role-alias drift check runs BEFORE the first OAuth early-exit - checked on every run (CR c.6005492851 M1)' {
        # The check needs only config + env. If its call sat after the OAuth /
        # probe / pending exits, an expired Codex OAuth or a chatgpt.com outage
        # would silently disable a check that needs neither network nor token
        # (CR #344 "checked on every run"). Textual order pin: the call must
        # precede the first OAuthPath TEST — red under the M1 mutation that
        # moves the block past the pending exit.
        $text = Get-Content -LiteralPath $script:RunnerPath -Raw
        $callIdx = $text.IndexOf('Compare-RoleModelsToRouting -Routing')
        $oauthTestIdx = $text.IndexOf('Test-Path -LiteralPath $OAuthPath')
        ($callIdx -ge 0) | Should -Be $true
        ($oauthTestIdx -ge 0) | Should -Be $true
        ($oauthTestIdx -gt $callIdx) | Should -Be $true
    }
}

Describe 'Write-VersionEvent / Test-ClaudishOptIn' {
    BeforeAll {
        $script:dir = Join-Path ([System.IO.Path]::GetTempPath()) ("mvw-{0}" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
        New-Item -ItemType Directory -Path $script:dir | Out-Null
        $script:evts = Join-Path $script:dir 'events.log'
    }
    AfterAll { Remove-Item $script:dir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'appends one parseable NDJSON line per event, no BOM' {
        Write-VersionEvent -EventsPath $script:evts -Kind minor-applied -Family gpt-sol -From gpt-6-sol -To gpt-6.1-sol -Detail test
        Write-VersionEvent -EventsPath $script:evts -Kind major-ask -Family gpt-sol -From gpt-6-sol -To gpt-7-sol
        $lines = @(Get-Content $script:evts)
        $lines.Count | Should -Be 2
        ($lines[0] | ConvertFrom-Json).kind | Should -Be 'minor-applied'
        ($lines[1] | ConvertFrom-Json).to | Should -Be 'gpt-7-sol'
        $bytes = [System.IO.File]::ReadAllBytes($script:evts)
        ($bytes[0] -eq 0xEF) | Should -Be $false
    }
    It 'opt-in gate: absent file, empty file and wrong word all refuse; only the exact token arms' {
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $false
        Set-Content (Join-Path $script:dir 'model-version-watch.enabled') ''
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $false
        Set-Content (Join-Path $script:dir 'model-version-watch.enabled') 'yes'
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $false
        Set-Content (Join-Path $script:dir 'model-version-watch.enabled') 'enabled'
        (Test-ClaudishOptIn -ClaudishHome $script:dir -Token 'enabled') | Should -Be $true
    }
}

Describe 'Test-VersionEventEmitted (#661 b - one event per fact, not one per 6h run)' {
    # Generalizes Test-RoleAliasAskEmitted to the report-only event kinds: a
    # 6h cadence re-observes the SAME pending fact every run (major-ask,
    # probe would-repin info, ineligible info) and would re-emit it forever.
    # The identifying tuple is the TRANSITION (kind, family, from, to): once
    # the operator arbitrates, the tuple changes and the new fact emits.
    BeforeAll {
        $script:dedupDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mvwdedup-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:dedupDir -Force | Out-Null
        $script:dedupEv = Join-Path $script:dedupDir 'events.log'
        Write-VersionEvent -EventsPath $script:dedupEv -Kind major-ask -Family gpt-sol -From 'gpt-6-sol' -To 'gpt-7-sol' -Detail 'spellings: gpt-6-sol=gpt-6-sol'
        Write-VersionEvent -EventsPath $script:dedupEv -Kind info -Family swift -From 'swift-1.5' -To 'swift-1.6' -Detail 'probe would-repin'
    }
    AfterAll { Remove-Item $script:dedupDir -Recurse -Force -ErrorAction SilentlyContinue }

    It 'the same (kind, family, from, to) is a re-observation - suppressed' {
        (Test-VersionEventEmitted -EventsPath $script:dedupEv -Kind major-ask -Family gpt-sol -From 'gpt-6-sol' -To 'gpt-7-sol') | Should -Be $true
        (Test-VersionEventEmitted -EventsPath $script:dedupEv -Kind info -Family swift -From 'swift-1.5' -To 'swift-1.6') | Should -Be $true
    }
    It 'a changed tuple is a new fact - emitted' {
        (Test-VersionEventEmitted -EventsPath $script:dedupEv -Kind major-ask -Family gpt-sol -From 'gpt-6.1-sol' -To 'gpt-7-sol') | Should -Be $false
        (Test-VersionEventEmitted -EventsPath $script:dedupEv -Kind major-ask -Family gpt-sol -From 'gpt-6-sol' -To 'gpt-7.1-sol') | Should -Be $false
        (Test-VersionEventEmitted -EventsPath $script:dedupEv -Kind info -Family gpt-sol -From 'gpt-6-sol' -To 'gpt-7-sol') | Should -Be $false
    }
    It 'a missing log or a garbage line never claims a duplicate' {
        (Test-VersionEventEmitted -EventsPath (Join-Path $script:dedupDir 'nope.log') -Kind major-ask -Family gpt-sol -From 'gpt-6-sol' -To 'gpt-7-sol') | Should -Be $false
        $garb = Join-Path $script:dedupDir 'garbage.log'
        [System.IO.File]::WriteAllText($garb, "not json`n" + '{"kind":"major-ask","family":"gpt-sol","from":"gpt-6-sol","to":"gpt-7-sol"}' + "`n")
        (Test-VersionEventEmitted -EventsPath $garb -Kind major-ask -Family gpt-sol -From 'gpt-6-sol' -To 'gpt-7-sol') | Should -Be $true
    }
    It '#665 r1: two same-tuple facts on two providers are two facts — both emit on run one, neither on the rerun' {
        # The r1 finding, restated as a pin: the provider-less key swallowed the
        # SECOND provider's fact before it had ever been emitted once. Here both
        # facts share (kind, family, from, to) and differ only by provider.
        $two = Join-Path $script:dedupDir 'two-providers.log'
        $d1 = @{ EventsPath = $two; Kind = 'info'; Family = 'glm'; From = 'glm-5.3'; To = 'glm-5.3.1'; Provider = 'zai' }
        $d2 = @{ EventsPath = $two; Kind = 'info'; Family = 'glm'; From = 'glm-5.3'; To = 'glm-5.3.1'; Provider = 'glm-coding' }
        # Empty log: BOTH facts are new — 2 events on the first run.
        (Test-VersionEventEmitted @d1) | Should -Be $false
        (Test-VersionEventEmitted @d2) | Should -Be $false
        Write-VersionEvent -EventsPath $two -Kind info -Family glm -From 'glm-5.3' -To 'glm-5.3.1' -Provider 'zai' -Detail 'probe would-repin spelling zai@glm-5.3 on zai'
        Write-VersionEvent -EventsPath $two -Kind info -Family glm -From 'glm-5.3' -To 'glm-5.3.1' -Provider 'glm-coding' -Detail 'probe would-repin spelling glm-coding@glm-5.3 on glm-coding'
        # Rerun: both are now known facts — 0 new events. And each fact does
        # NOT dedup the other's provider.
        (Test-VersionEventEmitted @d1) | Should -Be $true
        (Test-VersionEventEmitted @d2) | Should -Be $true
    }
    It 'legacy lines written before the provider field existed stay facts, and never satisfy a provider-scoped query' {
        $legacy = Join-Path $script:dedupDir 'legacy.log'
        [System.IO.File]::WriteAllText($legacy, '{"ts":"2026-10-24T00:00:00.0000000Z","kind":"info","family":"glm","from":"glm-5.3","to":"glm-5.3.1","detail":"pre-#665 line"}' + "`n")
        # Same tuple, no provider in the query → the legacy fact dedups (same key: '').
        (Test-VersionEventEmitted -EventsPath $legacy -Kind info -Family glm -From 'glm-5.3' -To 'glm-5.3.1') | Should -Be $true
        # A provider-scoped query is a DIFFERENT fact — never satisfied by a legacy line.
        (Test-VersionEventEmitted -EventsPath $legacy -Kind info -Family glm -From 'glm-5.3' -To 'glm-5.3.1' -Provider 'zai') | Should -Be $false
    }
}

Describe 'Compare-RoleModelsToRouting (role-alias drift, 2026-10-05, reworked CR c.5993885265)' {
    # The drift this hunts: routing repinned to a newer MINOR while
    # CLAUDE_FAILOVER_ROLE_MODELS kept the older spelling. parseRoleAliases
    # matches a lowercased SUBSTRING, so the old pattern does NOT cover the new
    # id and a client naming the current id gets no cascade at all.
    #
    # CRITICAL (CR #344): the proxy derives the role from the CLIENT-REQUESTED
    # name (keywords first, then aliases, first match wins, invalid-role
    # entries skipped at parse). The pre-CR detector iterated routing TARGETS
    # instead; every C-case below was replayed by the coordinator against the
    # real module next to a TS port of the resolution, and each is pinned here.
    BeforeAll {
        $script:routing = [pscustomobject]@{
            'gpt-6-sol'   = @('cx@gpt-6.1-sol')   # spelling old, served id NEW
            'gpt-5.6-sol' = @('cx@gpt-6.1-sol')
            'gpt-6.1-sol' = @('cx@gpt-6.1-sol')
            'gpt-6-astra' = @('cx@gpt-6-astra')
            'glm-5.3'     = @('gc@glm-5.3')
        }
        # The live hub value on 2026-10-05, BEFORE the fix.
        $script:staleRoles = 'glm-5.2:sonnet,glm-5.3:sonnet,minimax-m3:haiku,gpt-6-sol:opus,gpt-5.6-sol:opus,gpt-6-astra:fable'
        $script:aliasDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mvalias-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:aliasDir -Force | Out-Null
        # Build the file path HERE, not inside the It: under Pester 6 a
        # Describe's BeforeAll and its It blocks do not share the same script
        # scope for a variable first assigned inside an It, so a path made in
        # the It reached Write-VersionEvent as $null and the assert then read an
        # empty file (measured; the file header warns about exactly this shape
        # for fixtures, it applies to paths too).
        $script:aliasEv = Join-Path $script:aliasDir 'evt-alias.log'
    }
    It 'THE INCIDENT: gpt-6-sol does not cover gpt-6.1-sol (substring semantics) - drift reported with a concrete suggestion' {
        $d = @(Compare-RoleModelsToRouting -Routing $script:routing -RoleModels $script:staleRoles)
        $ids = @($d | ForEach-Object { $_.Id })
        ($ids -contains 'gpt-6.1-sol') | Should -Be $true
        $row = @($d | Where-Object { $_.Id -eq 'gpt-6.1-sol' })[0]
        $row.Family | Should -Be 'gpt-sol'
        # Role inherited from the family's existing alias (gpt-6-sol:opus)
        $row.Suggested | Should -Be 'gpt-6.1-sol:opus'
    }
    It 'POSITIVE CONTROL: adding the exact suggested alias silences it' {
        $fixed = $script:staleRoles + ',gpt-6.1-sol:opus'
        $d = @(Compare-RoleModelsToRouting -Routing $script:routing -RoleModels $fixed)
        (@($d | Where-Object { $_.Id -eq 'gpt-6.1-sol' }).Count) | Should -Be 0
    }
    It 'C1: an alias with an INVALID role does not exist for the proxy either - the drift is still reported' {
        # 'gpt-6.1-sol:opsu' is skipped at parse (role not in opus/sonnet/haiku/
        # fable), exactly like parseRoleAliases logs-and-skips, so the key is
        # uncovered and the family (gpt-6-sol:opus) suggests the fix.
        $r = [pscustomobject]@{ 'gpt-6.1-sol' = @('cx@gpt-6.1-sol') }
        $d = @(Compare-RoleModelsToRouting -Routing $r -RoleModels 'gpt-6-sol:opus,gpt-6.1-sol:opsu')
        (@($d | Where-Object { $_.Id -eq 'gpt-6.1-sol' }).Count) | Should -Be 1
        (@($d | Where-Object { $_.Id -eq 'gpt-6.1-sol' })[0].Suggested) | Should -Be 'gpt-6.1-sol:opus'
    }
    It 'C2: coverage of the routing TARGET never covers the requested NAME (drift behind a remap)' {
        # Key gpt-6.1-sol remapped to cx@gpt-6-sol; the alias covers only the
        # target spelling. A client naming the KEY still resolves to null.
        $r = [pscustomobject]@{ 'gpt-6.1-sol' = @('cx@gpt-6-sol') }
        $d = @(Compare-RoleModelsToRouting -Routing $r -RoleModels 'gpt-6-sol:opus')
        (@($d | Where-Object { $_.Id -eq 'gpt-6.1-sol' }).Count) | Should -Be 1
    }
    It 'C3: a keyword-bearing NAME has a role regardless of where it routes - never a drift, never the wrong suggestion' {
        # claude-haiku-4-5 aimed at gc@glm-4.7: roleFromModelName says haiku by
        # keyword. The pre-CR detector suggested glm-4.7:sonnet from the target.
        $r = [pscustomobject]@{ 'claude-haiku-4-5' = @('gc@glm-4.7') }
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels 'glm-5.3:sonnet').Count) | Should -Be 0
    }
    It 'C4: a provider-only routing entry (value with no model) is judged on its KEY' {
        $r = [pscustomobject]@{ 'glm-5.1' = @('gc') }
        $d = @(Compare-RoleModelsToRouting -Routing $r -RoleModels 'glm-5.3:sonnet')
        (@($d | Where-Object { $_.Id -eq 'glm-5.1' }).Count) | Should -Be 1
        (@($d | Where-Object { $_.Id -eq 'glm-5.1' })[0].Suggested) | Should -Be 'glm-5.1:sonnet'
    }
    It 'C6: the suggested role comes from the FIRST family alias in ROLE_MODELS order - deterministic under both interpreters' {
        # gpt-6-sol:opus first, gpt-5.6-sol:sonnet second: same family, the
        # suggestion must be opus whatever the hashtable iteration order does.
        $r = [pscustomobject]@{ 'gpt-6.1-sol' = @('cx@gpt-6.1-sol') }
        $d = @(Compare-RoleModelsToRouting -Routing $r -RoleModels 'gpt-6-sol:opus,gpt-5.6-sol:sonnet')
        $d[0].Suggested | Should -Be 'gpt-6.1-sol:opus'
    }
    It 'C7: a provider-prefixed pattern matches only a provider-prefixed name - no drift either way' {
        # The proxy resolves a client naming cx@gpt-6.1-sol to opus via the
        # prefixed pattern; a client naming the bare id resolves to null and
        # gets the family suggestion. Both halves pinned.
        $r = [pscustomobject]@{
            'cx@gpt-6.1-sol' = @('cx@gpt-6.1-sol')
            'gpt-6.1-sol'    = @('cx@gpt-6.1-sol')
        }
        $d = @(Compare-RoleModelsToRouting -Routing $r -RoleModels 'cx@gpt-6.1-sol:opus')
        (@($d | ForEach-Object { $_.Id }) -join ',') | Should -Be 'gpt-6.1-sol'
        $d[0].Suggested | Should -Be 'gpt-6.1-sol:opus'
    }
    It 'duplicate pattern keeps the FIRST entry (roleFromModelName returns on first match)' {
        # glm-5.2 twice with different roles: the family suggestion for a new
        # member must come from the first (sonnet), not the last (haiku).
        $r = [pscustomobject]@{ 'glm-9.9' = @('gc@glm-9.9') }
        $d = @(Compare-RoleModelsToRouting -Routing $r -RoleModels 'glm-5.2:sonnet,glm-5.2:haiku')
        $d[0].Suggested | Should -Be 'glm-9.9:sonnet'
    }
    It 'says nothing about families the alias table does not track (no invented work)' {
        # Untracked AND versioned (llama): silent even though it is a real
        # family shape - the table does not intend to cover it.
        $r = [pscustomobject]@{ 'llama-4.9' = @('ll@llama-4.9') }
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels $script:staleRoles).Count) | Should -Be 0
        # Unversioned alias shape (mistral-*-latest): silent, never a crash.
        $r2 = [pscustomobject]@{ 'mistral-medium-latest' = @('mm@mistral-medium-latest') }
        (@(Compare-RoleModelsToRouting -Routing $r2 -RoleModels $script:staleRoles).Count) | Should -Be 0
    }
    It 'substring coverage: a pattern covers LONGER names that contain it (glm-5.3 covers glm-5.3-flash)' {
        # The live routing has glm-5.3-flash as its own key; the proxy covers it
        # through the glm-5.3 pattern. An exact-equality or reversed-inclusion
        # rewrite of the match would report a false drift here (CR M2/M3).
        $r = [pscustomobject]@{ 'glm-5.3-flash' = @('gc@glm-5.3-flash') }
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels 'glm-5.3:sonnet').Count) | Should -Be 0
    }
    It 'keyword precedence holds even when the keyword-bearing family IS tracked (no false drift)' {
        # Keywords win BEFORE aliases (roleFromModelName), so a name carrying
        # 'sonnet' has a role whatever the family alias says — silent. The
        # family here IS tracked (pattern glm-5.2-sonnet versions to the same
        # glm-sonnet family as the key), so removing the keyword block turns
        # this into a FALSE drift row (CR C3) — the pin is not vacuous.
        $r = [pscustomobject]@{ 'glm-5.3-sonnet' = @('gc@glm-5.3-sonnet') }
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels 'glm-5.2-sonnet:haiku').Count) | Should -Be 0
    }
    It 'matching is case-insensitive on both sides (MiniMax-M3 key vs minimax-m3 pattern)' {
        # parseRoleAliases lowercases the pattern and roleFromModelName the
        # requested name; the live routing key is spelled MiniMax-M3 (CR M5).
        $r = [pscustomobject]@{ 'MiniMax-M3' = @('mmc@MiniMax-M3') }
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels 'minimax-m3:haiku').Count) | Should -Be 0
    }
    It 'CR c.6005492851 M2: a pattern that is a substring WITHOUT the family prefix still covers the name (substring, not equality)' {
        # The two fixtures the re-review refuted as "non-constructible". The
        # proxy covers gpt-6.1-sol here via requested.toLowerCase().includes
        # ('6.1-sol'). Under the equality mutant ($low -eq $a.Pattern) neither
        # 'gpt-6-sol' nor '6.1-sol' EQUALS the key, the family guard does not
        # save it (gpt-sol is tracked by gpt-6-sol) and a FALSE drift row gets
        # through — replayed by the coordinator on both interpreters.
        $r = [pscustomobject]@{ 'gpt-6.1-sol' = @('cx@gpt-6.1-sol') }
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels 'gpt-6-sol:opus,6.1-sol:opus').Count) | Should -Be 0
    }
    It 'CR c.6005492851 M5: an UPPERCASE routing key is covered by the lowercase alias (the key is lowercased BEFORE matching)' {
        # Under the no-lowercase mutant ($low = $key) the .Contains comparisons
        # turn case-sensitive, 'GPT-6.1-SOL' matches neither alias pattern, and
        # the tracked family lets a FALSE drift ('GPT-6.1-SOL:opus') through.
        $r = [pscustomobject]@{ 'GPT-6.1-SOL' = @('cx@gpt-6.1-sol') }
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels 'gpt-6-sol:opus,gpt-6.1-sol:opus').Count) | Should -Be 0
    }
    It 'reports once per family member, not once per spelling (3 spellings of one id -> 1 row)' {
        $d = @(Compare-RoleModelsToRouting -Routing $script:routing -RoleModels $script:staleRoles)
        (@($d | Where-Object { $_.Id -eq 'gpt-6.1-sol' }).Count) | Should -Be 1
    }
    It 'unreadable/empty alias string is not a drift signal (fail safe, never a false report)' {
        (@(Compare-RoleModelsToRouting -Routing $script:routing -RoleModels '').Count) | Should -Be 0
        (@(Compare-RoleModelsToRouting -Routing $script:routing -RoleModels ',:,:bogus,').Count) | Should -Be 0
    }
    It 'a pattern covering an unrelated id does not silence a gap (each id judged on its own substring)' {
        # 'glm-5.3:sonnet' must not be read as covering anything but glm-5.3.
        $r = [pscustomobject]@{ 'glm-5.4' = @('gc@glm-5.4') }
        $roles = 'glm-5.3:sonnet'
        (@(Compare-RoleModelsToRouting -Routing $r -RoleModels $roles).Count) | Should -Be 1
    }
    It 'role-alias-ask is an accepted event kind (consumer parity with major-ask)' {
        Write-VersionEvent -EventsPath $script:aliasEv -Kind role-alias-ask -Family gpt-sol -From 'gpt-6.1-sol:opus' -To 'gpt-6.1-sol' -Detail 'suggest gpt-6.1-sol:opus'
        # @() is load-bearing: Get-Content on a ONE-LINE file returns a STRING,
        # and indexing a string yields its first character ('{'), which
        # ConvertFrom-Json reports as "Unexpected end when reading JSON" - a
        # misleading failure that costs a debug cycle. The sibling block gets
        # away with (Get-Content ...)[0] only because it writes TWO lines.
        (@(Get-Content $script:aliasEv)[0] | ConvertFrom-Json).kind | Should -Be 'role-alias-ask'
    }
    It 'Test-RoleAliasAskEmitted dedupes by (id, suggested) - one ask per hole, not two per 6h run' {
        (Test-RoleAliasAskEmitted -EventsPath $script:aliasEv -Id 'gpt-6.1-sol' -Suggested 'gpt-6.1-sol:opus') | Should -Be $true
        # A DIFFERENT suggestion for the same id is a new question.
        (Test-RoleAliasAskEmitted -EventsPath $script:aliasEv -Id 'gpt-6.1-sol' -Suggested 'gpt-6.1-sol:sonnet') | Should -Be $false
        # Another id is a different hole.
        (Test-RoleAliasAskEmitted -EventsPath $script:aliasEv -Id 'glm-5.1' -Suggested 'glm-5.1:sonnet') | Should -Be $false
        # Absent log: nothing emitted yet.
        (Test-RoleAliasAskEmitted -EventsPath (Join-Path $script:aliasDir 'nope.log') -Id 'x' -Suggested 'x:opus') | Should -Be $false
    }
}

Describe 'Invoke-DrainDetachedRestart (#352) — the drain child is launched through the drain''s own -Detach, and the OUTCOME is logged' {
    # The defect was BETWEEN Start-Process and the child's parameter binding:
    # an unquoted -Reason value split at the first space, every further word
    # bound positionally, `(old` failed to convert for [int]$MaxWaitSec and
    # the child died at binding with stderr uncaptured — the log said
    # "launching" while no restart ever ran. A unit test of the argument list
    # cannot see that; these fixtures run the REAL chain (powershell.exe ->
    # module function -> powershell.exe fixture drain), each fixture carrying
    # the REAL drain param() block (bounded subset — copy-only fidelity, so a
    # pin would go red if the module function name or invocation form moved).
    # CR #377 adds the home question to the same chain: the fixture's
    # -ClaudishHome/-LogPath defaults are EMPTY, so a module that stops
    # forwarding either is caught by value, not by presence.
    BeforeAll {
        $script:detachFixDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mvw-detach-{0}" -f ([guid]::NewGuid().ToString('N').Substring(0, 8)))
        New-Item -ItemType Directory $script:detachFixDir -Force | Out-Null
        $global:MVWDetach = @{ Log = @(); Events = @() }
        # The PRODUCTION Reason (runner line: prefix + restartWhy joined by
        # ';', each family 'name: old id(s) retired: id,id') — colons, commas,
        # semicolons, TWO families and TWO ids, the shapes that died at
        # binding pre-#352 and that a bare-prefix pin would never exercise.
        $script:prodReason = 'model-version-watch minor repin (old id retired): openai: old id(s) retired: gpt-6-sol,gpt-6-astra; glm: old id(s) retired: glm-5.2'
        # Sentinel home — deliberately NOT any real profile dir: the fixture
        # compares by VALUE, so a dropped forward fails even though the real
        # drain would have happily resolved $env:USERPROFILE\.claudish.
        $script:detachHome = 'C:\MVWWatchHome'
        $script:detachLog = 'C:\MVWWatchHome\drain.log'
        # The drain's real param(), trimmed to the params the watch can reach,
        # with EXACTLY those names/types — the binding defect the pins
        # reproduce lives there (fix fixtures are prefixed SB- to never
        # collide with the module's imported function names).
        $script:drainParamSubset = @'
param(
    [string]$ContainerName = "claudish-proxy",
    [int]$MaxWaitSec = 600,
    [string]$Reason = "manual",
    [string]$ClaudishHome = "",
    [string]$LogPath = "",
    [switch]$Detach
)
'@
        Set-Content -LiteralPath (Join-Path $script:detachFixDir 'fixture-drain.ps1') -Encoding UTF8 -Value @"
$script:drainParamSubset
# fixture: exits 0 only when -Detach reached us, the Reason is the PRODUCTION
# form, and BOTH home params carry the caller's values (unquoted, the binding
# above DIES before any of this runs - that WAS #352)
if (-not `$Detach) { Write-Error 'FIXTURE: -Detach missing' ; exit 7 }
if (`$Reason -ne '$($script:prodReason)') { Write-Error "FIXTURE: mangled Reason: <`$Reason>" ; exit 8 }
if (`$ClaudishHome -ne '$($script:detachHome)') { Write-Error "FIXTURE: ClaudishHome not forwarded: <`$ClaudishHome>" ; exit 9 }
if (`$LogPath -ne '$($script:detachLog)') { Write-Error "FIXTURE: LogPath not forwarded: <`$LogPath>" ; exit 9 }
'[DrainDetach] child PID 4242 alive — START pid 4242 line present in fixture.log'
exit 0
"@
        Set-Content -LiteralPath (Join-Path $script:detachFixDir 'fixture-drain-exit3.ps1') -Encoding UTF8 -Value @"
$script:drainParamSubset
# fixture: simulate a launch failure INSIDE -Detach (rc=3, relaunch safe)
'[DrainDetach] child PID 4243 EXITED rc=1 — launch FAILED — stderr evidence: fixture.err'
exit 3
"@
        Set-Content -LiteralPath (Join-Path $script:detachFixDir 'fixture-drain-exit4.ps1') -Encoding UTF8 -Value @"
$script:drainParamSubset
# fixture: simulate the mute-child window (rc=4, do NOT relaunch)
'[DrainDetach] child PID 4244 still running but wrote no START line within 45s — do NOT relaunch'
exit 4
"@
    }
    BeforeEach {
        $global:MVWDetach.Log = @()
        $global:MVWDetach.Events = @()
    }
    AfterAll {
        Remove-Item -LiteralPath $script:detachFixDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Variable -Name MVWDetach -Scope Global -ErrorAction SilentlyContinue
    }

    It 'the real entry point: -Detach forwarded, PRODUCTION Reason (two families, two ids, colons/commas/semicolons) SURVIVES binding, exit 0 -> info event' {
        $drain = Join-Path $script:detachFixDir 'fixture-drain.ps1'
        $rc = Invoke-DrainDetachedRestart -DrainScript $drain `
            -Reason $script:prodReason `
            -ClaudishHome $script:detachHome `
            -LogPath $script:detachLog `
            -Log { param($m) $global:MVWDetach.Log += $m } `
            -WriteEvent { param($k, $f, $d) $global:MVWDetach.Events += (@{ kind = $k; family = $f; detail = $d }) }
        $rc | Should -Be 0
        ($global:MVWDetach.Events.Count) | Should -Be 1
        ($global:MVWDetach.Events[0].kind) | Should -Be 'info'
        ($global:MVWDetach.Events[0].family) | Should -Be 'reload'
        ($global:MVWDetach.Events[0].detail) | Should -Match 'exit 0'
        # the info event NAMES the drain.log the operator must poll (CR #377:
        # under another account that file is not $env:USERPROFILE's)
        ($global:MVWDetach.Events[0].detail) | Should -Match ([regex]::Escape($script:detachLog))
        # the outcome was LOGGED, not just attempted (issue #352's demand)
        (@($global:MVWDetach.Log) -match 'child alive').Count | Should -Be 1
        # the drain's own output was relayed to the caller's log
        (@($global:MVWDetach.Log) -match '\[drain-detach\]').Count | Should -BeGreaterOrEqual 1
    }

    It 'the drain runs in the WATCH home, not its own $env:USERPROFILE default (CR #377): both home params forwarded BY VALUE' {
        # Distinct sentinel values: if the module ever drops -ClaudishHome or
        # -LogPath from the invocation, the fixture's own EMPTY defaults see
        # something else and it exits 9 — rc lands in the default branch, the
        # event is an error, and this pin goes red. (The real drain resolves
        # `$env:USERPROFILE\.claudish` when not told otherwise — under a
        # SYSTEM task that is a different directory, and probe URL, freeze
        # consent, drain.log and detach captures all follow it there.)
        $drain = Join-Path $script:detachFixDir 'fixture-drain.ps1'
        $rc = Invoke-DrainDetachedRestart -DrainScript $drain `
            -Reason $script:prodReason `
            -ClaudishHome $script:detachHome `
            -LogPath $script:detachLog `
            -Log { param($m) $global:MVWDetach.Log += $m } `
            -WriteEvent { param($k, $f, $d) $global:MVWDetach.Events += (@{ kind = $k; family = $f; detail = $d }) }
        $rc | Should -Be 0
        ($global:MVWDetach.Events[0].kind) | Should -Be 'info'
        (@($global:MVWDetach.Log) -match 'not forwarded').Count | Should -Be 0
        (@($global:MVWDetach.Log) -match 'unexpected exit code').Count | Should -Be 0
    }

    It 'exit 3 (launch failed) -> ERROR event naming the failure and that a relaunch is safe' {
        $drain = Join-Path $script:detachFixDir 'fixture-drain-exit3.ps1'
        $rc = Invoke-DrainDetachedRestart -DrainScript $drain `
            -Reason $script:prodReason `
            -ClaudishHome $script:detachHome `
            -LogPath $script:detachLog `
            -Log { param($m) $global:MVWDetach.Log += $m } `
            -WriteEvent { param($k, $f, $d) $global:MVWDetach.Events += (@{ kind = $k; family = $f; detail = $d }) }
        $rc | Should -Be 3
        ($global:MVWDetach.Events[0].kind) | Should -Be 'error'
        ($global:MVWDetach.Events[0].detail) | Should -Match 'FAILED.*exit 3'
        ($global:MVWDetach.Events[0].detail) | Should -Match 'relaunch safe'
        (@($global:MVWDetach.Log) -match 'launch FAILED .*exit 3').Count | Should -Be 1
    }

    It 'exit 4 (mute child) -> ERROR event forbidding a relaunch' {
        $drain = Join-Path $script:detachFixDir 'fixture-drain-exit4.ps1'
        $rc = Invoke-DrainDetachedRestart -DrainScript $drain `
            -Reason $script:prodReason `
            -ClaudishHome $script:detachHome `
            -LogPath $script:detachLog `
            -Log { param($m) $global:MVWDetach.Log += $m } `
            -WriteEvent { param($k, $f, $d) $global:MVWDetach.Events += (@{ kind = $k; family = $f; detail = $d }) }
        $rc | Should -Be 4
        ($global:MVWDetach.Events[0].kind) | Should -Be 'error'
        ($global:MVWDetach.Events[0].detail) | Should -Match 'do NOT relaunch'
        (@($global:MVWDetach.Log) -match 'MUTE').Count | Should -Be 1
    }

    It 'runner wiring: the inline unquoted Start-Process launch is GONE, -Detach invoked through the module function WITH both home params' {
        $text = Get-Content -LiteralPath $script:RunnerPath -Raw
        $text | Should -Not -Match 'Start-Process powershell'
        $text | Should -Match 'Invoke-DrainDetachedRestart -DrainScript \$DrainScript'
        # no bare -Reason array element left behind by the old call
        $text | Should -Not -Match "'-Reason', 'model-version-watch minor repin \(old id retired\)'"
        # the runner forwards its OWN $ClaudishHome and derives LogPath from
        # it — never lets the drain fall back to $env:USERPROFILE (CR #377)
        $text | Should -Match '-ClaudishHome \$ClaudishHome'
        $text | Should -Match '-LogPath \(Join-Path \$ClaudishHome ''drain\.log''\)'
    }
}

Describe 'Get-RoutingCoverage (#635 AC 1 — the watch states what it cannot see)' {
    BeforeAll {
        # Fixture chosen to DISCRIMINATE units: cx@ carries 3 targets across 2
        # keys, so counting keys instead of targets yields 2 instead of 3 and
        # the pins go red. A one-target-per-key fixture would pass both ways.
        $script:covRouting = [pscustomobject]@{}
        Add-Member -InputObject $script:covRouting -NotePropertyName 'a' -NotePropertyValue @('cx@gpt-6.1-sol', 'cx@gpt-6-sol')
        Add-Member -InputObject $script:covRouting -NotePropertyName 'b' -NotePropertyValue @('cx@gpt-6.1-sol', 'gc@glm-5.3')
        Add-Member -InputObject $script:covRouting -NotePropertyName 'c' -NotePropertyValue @('gc@glm-5.3')
        Add-Member -InputObject $script:covRouting -NotePropertyName 'd' -NotePropertyValue @('gpt-6.1-sol')
        Add-Member -InputObject $script:covRouting -NotePropertyName 'e' -NotePropertyValue @('frognano')
        Add-Member -InputObject $script:covRouting -NotePropertyName 'f' -NotePropertyValue @('@broken')
        $script:cov = Get-RoutingCoverage -Routing $script:covRouting -WatchedProviders @('cx@', 'codex@')
    }

    It 'counts entries (keys) and targets separately — 6 keys, 8 targets here' {
        $script:cov.Entries | Should -Be 6
        $script:cov.Targets | Should -Be 8
    }

    It 'counts a watched provider per TARGET, not per key (cx@ = 3 targets over 2 keys)' {
        $script:cov.WatchedRoutes | Should -Be 3
        $script:cov.WatchedPrefixes | Should -Be 1
    }

    It 'reports the invisible remainder against the target count' {
        $script:cov.InvisibleRoutes | Should -Be 5
    }

    It 'buckets every prefix with its own target count' {
        $gc = @($script:cov.ByPrefix | Where-Object { $_.Prefix -eq 'gc@' })[0]
        $gc.Routes | Should -Be 2
        $gc.Watched | Should -Be $false
    }

    It 'buckets a no-@ target as (unprefixed) — bare id and provider-only are NOT told apart on purpose' {
        $un = @($script:cov.ByPrefix | Where-Object { $_.Prefix -eq '(unprefixed)' })[0]
        $un.Routes | Should -Be 2
        $un.Watched | Should -Be $false
    }

    It 'counts a malformed @target in Targets but assigns it no prefix' {
        $assigned = 0
        foreach ($p in @($script:cov.ByPrefix)) { $assigned += $p.Routes }
        $assigned | Should -Be 7          # 8 targets minus the malformed one
        $script:cov.Targets | Should -Be 8
    }

    It 'degrades to zeros on a null routing — never throws' {
        $empty = Get-RoutingCoverage -Routing $null
        $empty.Entries | Should -Be 0
        $empty.Targets | Should -Be 0
        $empty.WatchedRoutes | Should -Be 0
        $empty.InvisibleRoutes | Should -Be 0
        (@($empty.ByPrefix).Count) | Should -Be 0
    }

    It 'formats a line that NAMES its unit and lists the invisible prefixes with their counts' {
        $line = Format-RoutingCoverageLine -Coverage $script:cov
        $line | Should -Match '^\[coverage\] version watch sees 1/3 providers'
        $line | Should -Match '3/8 routing targets'
        $line | Should -Match '6 entries'
        $line | Should -Match 'gc@ 2'
        $line | Should -Match '\(unprefixed\) 2'
    }

    It 'says "none" when every prefix in use is watched (no empty tail)' {
        $all = Get-RoutingCoverage -Routing $script:covRouting -WatchedProviders @('cx@', 'gc@', '(unprefixed)')
        $line = Format-RoutingCoverageLine -Coverage $all
        $line | Should -Match '3/3 providers'
        $line | Should -Match 'invisible: none'
    }

    It 'runner wiring: the coverage line is emitted before every network exit' {
        $text = Get-Content -LiteralPath $script:RunnerPath -Raw
        $text | Should -Match 'Get-RoutingCoverage -Routing \$config\.routing'
        $text | Should -Match 'Format-RoutingCoverageLine'
        # positioned ahead of the section that owns the network calls and its
        # three `exit 0` paths
        $covAt = $text.IndexOf('Format-RoutingCoverageLine')
        $netAt = $text.IndexOf('--- 3. Available versions')
        $covAt | Should -BeGreaterThan 0
        $netAt | Should -BeGreaterThan 0
        $covAt | Should -BeLessThan $netAt
        # one definition only — the diff and the line must not drift apart
        ([regex]::Matches($text, "(?m)^\`$watchedProviders = @\(")).Count | Should -Be 1
    }
}

Describe 'Get-ModelsUrl / Get-ProviderProbeTargets (#635 AC 2 - what this seat can probe)' {
    BeforeAll {
        # A routing surface shaped like the hub's, plus the two custom-endpoint
        # shapes the config actually carries (simple url + ${VAR}, complex
        # baseUrl + apiPath).
        $script:routing = [pscustomobject]@{
            'glm-5.3'           = @('gc@glm-5.3')
            'deepseek-v4-flash' = @('ds@deepseek-v4-flash', 'qwen-token-plan@deepseek-v4.1-flash')
            'swift-1.5-27b'     = @('vllm-myia@swift-1.5-27b')
            'MiniMax-M3'        = @('mmc@MiniMax-M3')
            'gpt-6.1-sol'       = @('cx@gpt-6.1-sol')
            'bare-model'        = @('bare-model')
        }
        $script:endpoints = [pscustomobject]@{
            'vllm-myia'       = [pscustomobject]@{ kind = 'simple'; url = 'http://h:5002/v1'; apiKey = '${VLLM_API_KEY}' }
            'qwen-token-plan' = [pscustomobject]@{
                kind = 'complex'; baseUrl = 'https://qwen.example'; apiPath = '/v1/messages'
                apiKey = '${QWEN_TOKEN_PLAN_API_KEY}'; authScheme = 'x-api-key'
            }
        }
    }

    It 'derives the catalogue URL the same way the proxy does' {
        Get-ModelsUrl -BaseUrl 'http://127.0.0.1:5002/v1' -ApiPath '/chat/completions' | Should -Be 'http://127.0.0.1:5002/v1/models'
        Get-ModelsUrl -BaseUrl 'http://h:8000/' -ApiPath '/v1/chat/completions' | Should -Be 'http://h:8000/v1/models'
        Get-ModelsUrl -BaseUrl 'https://qwen.example' -ApiPath '/v1/messages' | Should -Be 'https://qwen.example/v1/models'
        # No recognisable terminal segment: the OpenAI convention, never a guess
        Get-ModelsUrl -BaseUrl 'http://host/api' -ApiPath '/custom/chat' | Should -Be 'http://host/api/v1/models'
    }

    It 'classifies every prefix in routing exactly once, and never invents a builtin URL' {
        $t = Get-ProviderProbeTargets -Routing $script:routing -CustomEndpoints $script:endpoints
        @($t).Count | Should -Be 6   # gc@ ds@ qwen-token-plan@ vllm-myia@ mmc@ cx@  (bare model ignored)
        @($t | Where-Object { $_.Prefix -eq 'vllm-myia@' })[0].Probeable | Should -BeTrue
        @($t | Where-Object { $_.Prefix -eq 'qwen-token-plan@' })[0].Url | Should -Be 'https://qwen.example/v1/models'
        @($t | Where-Object { $_.Prefix -eq 'qwen-token-plan@' })[0].KeyName | Should -Be 'QWEN_TOKEN_PLAN_API_KEY'
        # cx@ is the OAuth path - reported as such, not as a gap
        @($t | Where-Object { $_.Prefix -eq 'cx@' })[0].Kind | Should -Be 'oauth'
        # gc@/ds@/mmc@ have no surface in this config: reported, never given a URL
        foreach ($p in @('gc@', 'ds@', 'mmc@')) {
            $one = @($t | Where-Object { $_.Prefix -eq $p })[0]
            $one.Probeable | Should -BeFalse
            $one.Url | Should -BeNullOrEmpty
            $one.Reason | Should -Match 'no probe surface'
        }
    }

    It 'carries the auth scheme and extra headers the proxy transport would use (#661 a)' {
        # Defaults mirror custom-endpoints-loader.ts: the WIRE decides — openai
        # 'bearer' (hardcoded there), anthropic 'x-api-key' — and an explicit
        # authScheme always wins. Only complex entries may carry headers.
        $rt = [pscustomobject]@{
            'm1' = @('simple-oai@m1')
            'm2' = @('simple-ant@m2')
            'm3' = @('complex-oai@m3')
            'm4' = @('complex-ant-default@m4')
            'm5' = @('complex-explicit@m5')
        }
        $eps = [pscustomobject]@{
            'simple-oai'          = [pscustomobject]@{ kind = 'simple'; url = 'http://a/v1'; apiKey = '${A}' }
            'simple-ant'          = [pscustomobject]@{ kind = 'simple'; url = 'http://b/v1'; apiKey = '${B}'; format = 'anthropic' }
            'complex-oai'         = [pscustomobject]@{ kind = 'complex'; baseUrl = 'http://c'; apiPath = '/v1/chat/completions'; apiKey = '${C}'; transport = 'openai'; headers = [pscustomobject]@{ 'X-Org' = 'org1' } }
            'complex-ant-default' = [pscustomobject]@{ kind = 'complex'; baseUrl = 'http://d'; apiPath = '/v1/messages'; apiKey = '${D}'; transport = 'anthropic' }
            'complex-explicit'    = [pscustomobject]@{ kind = 'complex'; baseUrl = 'http://e'; apiPath = '/v1/messages'; apiKey = '${E}'; transport = 'anthropic'; authScheme = 'bearer' }
        }
        $t = Get-ProviderProbeTargets -Routing $rt -CustomEndpoints $eps
        $byP = @{}
        foreach ($x in @($t)) { $byP[$x.Prefix] = $x }
        $byP['simple-oai@'].AuthScheme | Should -Be 'bearer'            # no format declared: openai default
        $byP['simple-ant@'].AuthScheme | Should -Be 'x-api-key'        # format anthropic
        $byP['complex-oai@'].AuthScheme | Should -Be 'bearer'          # transport openai
        $byP['complex-oai@'].ExtraHeaders.'X-Org' | Should -Be 'org1'
        $byP['complex-ant-default@'].AuthScheme | Should -Be 'x-api-key'   # transport anthropic, nothing explicit
        $byP['complex-ant-default@'].ExtraHeaders | Should -BeNullOrEmpty  # no headers declared
        $byP['complex-explicit@'].AuthScheme | Should -Be 'bearer'         # explicit beats the wire default
        $byP['simple-oai@'].ExtraHeaders | Should -BeNullOrEmpty           # simple entries carry no headers
    }
}

Describe 'Get-ProbeHeaders (#661 a - the probe authenticates like the transport it stands in for)' {
    # Header contract mirrors anthropic-compat.ts getHeaders: auth header from
    # the scheme, extras applied AFTER it (Object.assign order — an extra may
    # override auth). Pure, so every shape pins without touching the wire.
    It 'bearer by default (and on an empty scheme), x-api-key when declared' {
        $h = Get-ProbeHeaders -Key 'k1'
        $h['Authorization'] | Should -Be 'Bearer k1'
        ($h.ContainsKey('x-api-key')) | Should -Be $false
        # a target built without AuthScheme arrives as '' — same wire as bearer
        $hEmpty = Get-ProbeHeaders -Key 'k1' -AuthScheme ''
        $hEmpty['Authorization'] | Should -Be 'Bearer k1'
        $h2 = Get-ProbeHeaders -Key 'k2' -AuthScheme 'x-api-key'
        $h2['x-api-key'] | Should -Be 'k2'
        ($h2.ContainsKey('Authorization')) | Should -Be $false
    }
    It 'an empty key sends no auth header at all (Accept stays)' {
        $h = Get-ProbeHeaders -Key ''
        ($h.ContainsKey('Authorization')) | Should -Be $false
        ($h.ContainsKey('x-api-key')) | Should -Be $false
        $h['Accept'] | Should -Be 'application/json'
    }
    It 'extra headers apply AFTER the auth header and may override it' {
        $h = Get-ProbeHeaders -Key 'k' -AuthScheme 'bearer' -ExtraHeaders ([pscustomobject]@{ Authorization = 'Basic z'; 'X-Org' = 'o1' })
        $h['Authorization'] | Should -Be 'Basic z'
        $h['X-Org'] | Should -Be 'o1'
        $h['Accept'] | Should -Be 'application/json'
    }
}

Describe 'Invoke-ProviderCatalogProbe (#635 AC 2 - "not probed" is never "current")' {
    BeforeAll {
        $script:targets = @(
            @{ Prefix = 'vllm-myia@'; Probeable = $true; Kind = 'custom'; Url = 'http://v1/models'; KeyName = 'VLLM_API_KEY'; KeyInline = ''; Reason = '' },
            @{ Prefix = 'qwen-token-plan@'; Probeable = $true; Kind = 'custom'; Url = 'http://q/models'; KeyName = 'QWEN_TOKEN_PLAN_API_KEY'; KeyInline = ''; Reason = '' },
            @{ Prefix = 'gc@'; Probeable = $false; Kind = 'unknown'; Url = ''; KeyName = ''; KeyInline = ''; Reason = 'no probe surface declared in config (builtin provider URL lives in the CLI, not here)' }
        )
        $script:keys = @{ VLLM_API_KEY = 'k-vllm'; QWEN_TOKEN_PLAN_API_KEY = 'k-qwen' }
        $script:noEnv = { param($n) '' }
    }

    It 'a 200 with ids is the ONLY shape that counts as probed' {
        $f = { param($u, $k, $t) @{ Status = 200; Body = '{"data":[{"id":"swift-1.5-27b"},{"id":"qwen3.6-35b-a3b"}]}' } }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[0]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'probed'
        @($o[0].Ids).Count | Should -Be 2
    }

    It 'a 401 says "credential refused" and NEVER reads as current' {
        # BOTH transport shapes: a returned 401 and a thrown one. Pinning only
        # the thrown shape leaves the status branch free to call a refusal
        # "probed" (measured: the first mutant survived this pin exactly so).
        $fReturned = { param($u, $k, $t) @{ Status = 401; Body = '{"error":"unauthorized"}' } }
        $oRet = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[1]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $fReturned)
        $oRet[0].Status | Should -Be 'not probed'
        $oRet[0].Reason | Should -Match 'credential refused'

        $f = { param($u, $k, $t) throw 'Response status code does not indicate success: 401 (Unauthorized).' }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[1]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'not probed'
        $o[0].Reason | Should -Match '401'
        # the killed mutant: any status other than a 2xx-with-ids must not claim coverage
        $o[0].Status | Should -Not -Be 'probed'
        $o[0].Status | Should -Not -Be 'current'
    }

    It 'a 403 is the same refusal class; a plain 500 is a bare status' {
        $f403 = { param($u, $k, $t) @{ Status = 403; Body = '{}' } }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[1]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f403)
        $o[0].Status | Should -Be 'not probed'
        $o[0].Reason | Should -Match 'credential refused'

        $f500 = { param($u, $k, $t) @{ Status = 500; Body = '{}' } }
        $o2 = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[1]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f500)
        $o2[0].Status | Should -Be 'not probed'
        $o2[0].Reason | Should -Be 'HTTP 500'
    }

    It 'a 200 with no ids is no-signal, not coverage' {
        $f = { param($u, $k, $t) @{ Status = 200; Body = '{"object":"list","data":[]}' } }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[0]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'not probed'
        $o[0].Reason | Should -Match 'no model entries'
    }

    It 'a missing credential is reported by NAME - the probe is never sent unauthenticated' {
        $script:sent = 0
        $f = { param($u, $k, $t) $script:sent++; @{ Status = 200; Body = '{"data":[{"id":"x"}]}' } }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[0]) -ApiKeys @{} -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'not probed'
        $o[0].Reason | Should -Match 'VLLM_API_KEY'
        $script:sent | Should -Be 0
    }

    It 'a credential may come from the environment when config.apiKeys lacks it' {
        $envHit = { param($n) if ($n -eq 'VLLM_API_KEY') { 'k-from-env' } else { '' } }
        $script:seenKey = ''
        $f = { param($u, $k, $t) $script:seenKey = $k; @{ Status = 200; Body = '{"models":[{"slug":"m"}]}' } }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[0]) -ApiKeys @{} -EnvLookup $envHit -Fetcher $f)
        $o[0].Status | Should -Be 'probed'
        $script:seenKey | Should -Be 'k-from-env'
    }

    It 'reads a credential from a PSCustomObject - the shape ConvertFrom-Json actually produces' {
        # MEASURED 24/10 on the live config (PS 5.1): `$ApiKeys[$name]` on the
        # object ConvertFrom-Json returns throws "Cannot index an object of type
        # PSObject". Every pin here used a hashtable, so the suite was green on
        # a shape the shipping runner never has.
        $cfgKeys = '{"QWEN_TOKEN_PLAN_API_KEY":"k-json","VLLM_API_KEY":"k2"}' | ConvertFrom-Json
        Get-ApiKeyValue -ApiKeys $cfgKeys -Name 'QWEN_TOKEN_PLAN_API_KEY' | Should -Be 'k-json'
        $script:seenKey = ''
        $f = { param($u, $k, $t) $script:seenKey = $k; @{ Status = 200; Body = '{"data":[{"id":"m"}]}' } }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[1]) -ApiKeys $cfgKeys -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'probed'
        $script:seenKey | Should -Be 'k-json'
        # the same function still serves the hashtable shape used everywhere else
        Get-ApiKeyValue -ApiKeys $script:keys -Name 'QWEN_TOKEN_PLAN_API_KEY' | Should -Be 'k-qwen'
    }

    It 'a timeout/connection error is a reason, not a throw' {
        $f = { param($u, $k, $t) throw 'The operation has timed out.' }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[0]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'not probed'
        $o[0].Reason | Should -Match 'timed out'
    }

    It 'a TimeoutException is normalised to English, not passed through in the platform language' {
        # MEASURED 24/10 on this seat (PS 5.1, French locale): the live probe
        # logged `vllm-myia@ (Le délai de l'opération a expiré.)` into a run log
        # the fleet greps in English.
        $f = { param($u, $k, $t) throw (New-Object System.TimeoutException 'Le délai de l''opération a expiré.') }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[0]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f -TimeoutSec 7)
        $o[0].Status | Should -Be 'not probed'
        $o[0].Reason | Should -Be 'timed out after 7s'
    }

    It 'a non-probeable target is reported without any wire call' {
        $f = { param($u, $k, $t) throw 'must not be called' }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[2]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'not probed'
        $o[0].Reason | Should -Match 'no probe surface'
    }

    It 'one failing provider does not stop the next one' {
        $f = { param($u, $k, $t)
            if ($u -like '*v*') { throw 'HTTP 401 - nope' }
            @{ Status = 200; Body = '{"data":[{"id":"qq"}]}' }
        }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($script:targets[0], $script:targets[1]) -ApiKeys $script:keys -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'not probed'
        $o[1].Status | Should -Be 'probed'
    }

    It 'threads the target auth scheme and extra headers to the fetcher (#661 a)' {
        # The threading is the part that can silently break: Get-ProbeHeaders
        # could be perfect and the call site still drop the two new values.
        $script:seenFetch = $null
        $f = { param($u, $k, $t, $s, $h)
            $script:seenFetch = @{ Url = $u; Key = $k; Scheme = "$s"; Extras = $h }
            @{ Status = 200; Body = '{"data":[{"id":"x"}]}' }
        }
        $tgt = @{ Prefix = 'p@'; Probeable = $true; Kind = 'custom'; Url = 'http://p/models'; KeyName = 'P_KEY'; KeyInline = ''; AuthScheme = 'x-api-key'; ExtraHeaders = [pscustomobject]@{ 'X-Org' = 'o9' }; Reason = '' }
        $o = @(Invoke-ProviderCatalogProbe -Targets @($tgt) -ApiKeys @{ P_KEY = 'pk' } -EnvLookup $script:noEnv -Fetcher $f)
        $o[0].Status | Should -Be 'probed'
        $script:seenFetch.Scheme | Should -Be 'x-api-key'
        $script:seenFetch.Extras.'X-Org' | Should -Be 'o9'
        # a target built WITHOUT the fields (pre-#661 shape) reads as empty
        # scheme (bearer on the wire), never as a break
        $tgtOld = @{ Prefix = 'q@'; Probeable = $true; Kind = 'custom'; Url = 'http://q/models'; KeyName = 'P_KEY'; KeyInline = ''; Reason = '' }
        $o2 = @(Invoke-ProviderCatalogProbe -Targets @($tgtOld) -ApiKeys @{ P_KEY = 'pk' } -EnvLookup $script:noEnv -Fetcher $f)
        $o2[0].Status | Should -Be 'probed'
        $script:seenFetch.Scheme | Should -Be ''
        $null | Should -Be $script:seenFetch.Extras
    }
}

Describe 'Format-ProviderProbeLine (#635 AC 2 - the line names every prefix, and no secret)' {
    It 'accounts for every provider and names each reason' {
        $o = @(
            @{ Prefix = 'vllm-myia@'; Status = 'probed'; Ids = @('a', 'b'); Reason = '' },
            @{ Prefix = 'ds@'; Status = 'not probed'; Ids = @(); Reason = 'HTTP 401 - credential refused (not probed, NOT current)' },
            @{ Prefix = 'gc@'; Status = 'not probed'; Ids = @(); Reason = 'no probe surface declared in config' }
        )
        $line = Format-ProviderProbeLine -Outcomes $o
        $line | Should -Match 'providers probed 1/3'
        $line | Should -Match 'ids 2'
        $line | Should -Match 'ds@ \(HTTP 401'
        $line | Should -Match 'gc@ \(no probe surface'
        # the vocabulary rule: a failed provider never joins the probed count and
        # the line never claims full coverage ('current' may appear only inside a
        # refusal reason that says NOT current)
        $line | Should -Not -Match 'not probed: none'
        $line | Should -Not -Match '\(ids \d+\) — not probed: none'
    }

    It 'says "none" when everything was probed, and refuses to invent a prefix' {
        $o = @(@{ Prefix = 'vllm-myia@'; Status = 'probed'; Ids = @('a'); Reason = '' })
        (Format-ProviderProbeLine -Outcomes $o) | Should -Match 'not probed: none'
        (Format-ProviderProbeLine -Outcomes @()) | Should -Match 'nothing to probe'
    }

    It 'never formats a credential - only names and counts cross this function' {
        $o = @(@{ Prefix = 'ds@'; Status = 'not probed'; Ids = @(); Reason = 'no credential (DEEPSEEK_API_KEY is neither in config.apiKeys nor in the environment)' })
        $line = Format-ProviderProbeLine -Outcomes $o
        $line | Should -Match 'DEEPSEEK_API_KEY'   # the NAME is the useful part
        $line | Should -Not -Match 'sk-'
    }
}

Describe 'Compare-ProbedProviderToFamilies (#635 AC 2 - binding is structural)' {
    BeforeAll {
        $script:routing2 = [pscustomobject]@{
            'deepseek-v4-flash' = @('qwen-token-plan@deepseek-v4-flash')
            'other'             = @('ds@deepseek-v4-flash')
        }
    }

    It 'a newer minor on a probed provider yields a minor decision bound to THAT provider' {
        $o = @(@{ Prefix = 'qwen-token-plan@'; Status = 'probed'; Ids = @('deepseek-v4.1-flash'); Reason = '' })
        $d = @(Compare-ProbedProviderToFamilies -Routing $script:routing2 -Outcomes $o)
        @($d).Count | Should -Be 1
        $d[0].Provider | Should -Be 'qwen-token-plan@'
        $d[0].Action | Should -Be 'minor'
        $d[0].NewTarget | Should -Be 'qwen-token-plan@deepseek-v4.1-flash'
    }

    It 'an id listed by one backend is NEVER proposed under another' {
        # TWO backends probed at once, with disjoint catalogues - the only shape
        # that can tell a per-provider diff from one merged diff. ds@ lists the
        # newer id; qwen-token-plan@ lists only the pinned one. Its routing key
        # must stay put: a merged diff would repin it to ds@'s id, entering
        # routing a target the qwen backend never listed.
        $o = @(
            @{ Prefix = 'qwen-token-plan@'; Status = 'probed'; Ids = @('deepseek-v4-flash'); Reason = '' },
            @{ Prefix = 'ds@'; Status = 'probed'; Ids = @('deepseek-v4.1-flash'); Reason = '' }
        )
        $d = @(Compare-ProbedProviderToFamilies -Routing $script:routing2 -Outcomes $o)
        @($d).Count | Should -Be 2
        $qwen = @($d | Where-Object { $_.Provider -eq 'qwen-token-plan@' })[0]
        $qwen.Action | Should -Be 'current'
        $qwen.NewTarget | Should -Be 'qwen-token-plan@deepseek-v4-flash'
        $ds = @($d | Where-Object { $_.Provider -eq 'ds@' })[0]
        $ds.Action | Should -Be 'minor'
        $ds.NewTarget | Should -Be 'ds@deepseek-v4.1-flash'
    }

    It 'a "not probed" outcome contributes no decision at all' {
        $o = @(@{ Prefix = 'qwen-token-plan@'; Status = 'not probed'; Ids = @('deepseek-v4.1-flash'); Reason = 'HTTP 401' })
        @(Compare-ProbedProviderToFamilies -Routing $script:routing2 -Outcomes $o).Count | Should -Be 0
    }
}

Describe 'Split-ProbeDecisions (#635 AC 2 - minor is a report, major is an ASK)' {
    BeforeAll {
        $script:routing3 = [pscustomobject]@{
            'gpt-6-sol'   = @('vllm-myia@gpt-6-sol')
            'gpt-5.6-sol' = @('vllm-myia@gpt-5.6-sol')
        }
        $script:outcome3 = @(@{ Prefix = 'vllm-myia@'; Status = 'probed'; Ids = @('gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'); Reason = '' })
        $script:split3 = Split-ProbeDecisions -Decisions @(Compare-ProbedProviderToFamilies -Routing $script:routing3 -Outcomes $script:outcome3)
    }

    It 'a newer minor lands in Minors, an older major in Majors' {
        @($script:split3.Minors).Count | Should -Be 1
        (@($script:split3.Minors)[0].Spelling) | Should -Be 'gpt-6-sol'
        @($script:split3.Majors).Count | Should -Be 1
        (@($script:split3.Majors)[0].Spelling) | Should -Be 'gpt-5.6-sol'
        (@($script:split3.Majors)[0].Action) | Should -Be 'major'
    }

    It 'a current spelling goes to neither bucket' {
        # gpt-6.1-sol is the family latest; a routing key sitting on it must
        # produce no bucket entry at all (no would-repin, no ask)
        $r = [pscustomobject]@{ 'pinned' = @('vllm-myia@gpt-6.1-sol') }
        $s = Split-ProbeDecisions -Decisions @(Compare-ProbedProviderToFamilies -Routing $r -Outcomes $script:outcome3)
        @($s.Minors).Count | Should -Be 0
        @($s.Majors).Count | Should -Be 0
    }

    It 'nothing to decide yields two empty buckets, never $null' {
        $s = Split-ProbeDecisions -Decisions @()
        $null -eq $s.Minors | Should -BeFalse
        $null -eq $s.Majors | Should -BeFalse
        @($s.Minors).Count | Should -Be 0
        @($s.Majors).Count | Should -Be 0
    }
}

Describe 'model-version-watch.ps1 - the probe runs before the Codex network phase, report-only' {
    It 'probes before section 3 and never applies a probe decision' {
        $text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\model-version-watch.ps1'))
        $probeAt = $text.IndexOf('Format-ProviderProbeLine')
        $netAt = $text.IndexOf('--- 3. Available versions')
        $probeAt | Should -BeGreaterThan 0
        $netAt | Should -BeGreaterThan 0
        $probeAt | Should -BeLessThan $netAt
        # report-only this grain: the probe's decisions may be logged, never edited
        $text | Should -Match 'would-repin'
        $probeDecisionsAt = $text.IndexOf('Compare-ProbedProviderToFamilies')
        $probeDecisionsAt | Should -BeGreaterThan $probeAt
        $applyAt = $text.IndexOf('Edit-RoutingForMinor -ConfigPath', $probeDecisionsAt)
        if ($applyAt -gt 0) { $applyAt | Should -BeGreaterThan $netAt }
        # AC 2's second half: a major on a probed provider is an ASK, emitted in
        # this same report-only section (before the Codex network phase), never
        # an edit.
        $splitAt = $text.IndexOf('Split-ProbeDecisions')
        $splitAt | Should -BeGreaterThan $probeAt
        $askAt = $text.IndexOf('-Kind major-ask', $splitAt)
        $askAt | Should -BeGreaterThan $splitAt
        $askAt | Should -BeLessThan $netAt
        # bounded to the probe section: the Codex path legitimately edits later
        $probeSection = $text.Substring($splitAt, $netAt - $splitAt)
        $probeSection | Should -Not -Match 'Edit-RoutingForMinor'
    }

    It 'every report-only event site is dedup-gated; the observation log lines stay (#661 b)' {
        $text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\model-version-watch.ps1'))
        # four re-observed report-only sites, each gated on (kind, family,
        # from, to, provider):
        # probe major-ask, probe would-repin info, Codex ineligible info, Codex major-ask
        ([regex]::Matches($text, 'Test-VersionEventEmitted -EventsPath \$eventsPath')).Count | Should -Be 4
        # the gate suppressed the EVENT, never the per-run LOG observation — an
        # operator reading the run log still sees every cycle's state
        $text | Should -Match '\[probe\] would-repin'
        $text | Should -Match 'REPORT-ONLY'
        $text | Should -Match 'MAJOR available'
        # gating did not remove or duplicate any event site (anchored on the
        # WRITE call — the gate calls carry the same -Kind argument)
        ([regex]::Matches($text, 'Write-VersionEvent -EventsPath \$eventsPath -Kind major-ask')).Count | Should -Be 2
        ([regex]::Matches($text, 'Write-VersionEvent -EventsPath \$eventsPath -Kind info')).Count | Should -Be 2
    }
}
