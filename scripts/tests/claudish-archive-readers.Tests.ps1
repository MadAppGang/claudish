#requires -Version 5.1
<#
    Reader-side archive enumeration (claudish #203).

    Since #201 a machine writes `captures-<day>-<tag>.7z` off-site so two
    producers cannot overwrite each other's day. The readers then have to see
    BOTH spellings — and an archive a reader cannot see does not look like a
    defect, it looks like a quiet day. Measured on the live corpus 2026-09-22,
    before the fix: the off-site directory held 141 archives of which 105 were
    visible (34 of 105 days under-counted), and the local archive directory of
    this post-#201 machine held 14 archives of which ZERO were visible.

    The asymmetry with the WRITER side is deliberate and must survive: on the
    writer side `Get-CaptureArchiveDay` is strict and returns nothing for a name
    it cannot parse, because there it gates a DELETE ("purge must skip, never
    guess"). Here the same strictness is the defect, because it gates a READ.
    Do not unify the two parsers: a strict parser is right where it guards a
    destructive action and wrong where it guards an enumeration.

    Every case carries a positive control. A matcher that silently matched
    nothing, or one broken wide open, would otherwise pass an "it did not
    crash" check.
#>

BeforeAll {
    $script:RepoRoot    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:ModulePath  = Join-Path $script:RepoRoot 'scripts\CaptureUtils.psm1'
    $script:HistoryPath = Join-Path $script:RepoRoot 'scripts\traffic-history.ps1'

    if ($PSVersionTable.PSVersion.Major -ge 7) {
        Import-Module $script:ModulePath -Force -DisableNameChecking
    }

    function New-ArchiveSandbox {
        param([string[]]$Names)
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("archive-readers-" + [guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path (Join-Path $tmp 'archive') -Force
        foreach ($n in $Names) {
            [System.IO.File]::WriteAllText((Join-Path $tmp "archive\$n"), 'x')
        }
        $tmp
    }
}

# CaptureUtils.psm1 uses `??` deliberately and is the documented pwsh-7-only
# module (pinned by claudish-engine.Tests.ps1). Under 5.1 it cannot even be
# parsed, so these cases are skipped there — and the skip is itself measured,
# one Describe below, so it can never quietly become a green line hiding a
# real defect.
Describe 'Get-ArchivedDays' -Skip:($PSVersionTable.PSVersion.Major -lt 7) {

    It 'returns BOTH producers of a day when both spellings are present (#203 AC)' {
        $tmp = New-ArchiveSandbox @('captures-2026-09-20.7z', 'captures-2026-09-20-ai-01.7z')
        try {
            $got = @(Get-ArchivedDays -Dir $tmp)
            $got.Count | Should -Be 2
            @($got | Where-Object { $_.Date -eq [datetime]'2026-09-20' }).Count | Should -Be 2
            @($got | Where-Object { $_.Tag -eq 'ai-01' }).Count | Should -Be 1
            @($got | Where-Object { -not $_.Tag }).Count        | Should -Be 1
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'sees a directory where EVERY archive is tagged (the post-#201 local corpus)' {
        # This is the case that returned nothing at all before the fix, which is
        # indistinguishable from an empty archive directory.
        $tmp = New-ArchiveSandbox @('captures-2026-09-18-ai-01.7z', 'captures-2026-09-19-po-2025.7z')
        try {
            $got = @(Get-ArchivedDays -Dir $tmp)
            $got.Count | Should -Be 2
            ($got | ForEach-Object { $_.Tag }) -join ',' | Should -Be 'ai-01,po-2025'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'still enumerates a Drive-duplicate name, whose suffix is not a tag' {
        # Regression on this fix's own first draft: anchoring the date pattern so
        # it also carried the tag looked equivalent and was not — measured
        # against the live off-site directory it dropped `captures-<day> (1).7z`,
        # a real producer's day. Which files are ENUMERATED must never depend on
        # parsing the suffix; the Tag is allowed to come back $null.
        $tmp = New-ArchiveSandbox @('captures-2026-09-05.7z', 'captures-2026-09-05 (1).7z')
        try {
            $got = @(Get-ArchivedDays -Dir $tmp)
            $got.Count | Should -Be 2
            @($got | Where-Object { $_.File -like '*(1).7z' }).Count | Should -Be 1
            ($got | Where-Object { $_.File -like '*(1).7z' }).Tag    | Should -BeNullOrEmpty
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'refuses a name that is not ours (negative control on a permissive matcher)' {
        $tmp = New-ArchiveSandbox @('captures-2026-09-20.7z', 'captures-latest.7z', 'captures-notes.7z')
        try {
            $got = @(Get-ArchivedDays -Dir $tmp)
            $got.Count | Should -Be 1
            $got[0].Date | Should -Be ([datetime]'2026-09-20')
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'orders by day then producer, so repeated runs print the same sequence' {
        $tmp = New-ArchiveSandbox @(
            'captures-2026-09-20-zz.7z', 'captures-2026-09-19.7z', 'captures-2026-09-20-aa.7z')
        try {
            $got = @(Get-ArchivedDays -Dir $tmp)
            ($got | ForEach-Object { Get-ArchiveDayLabel -Archive $_ }) -join ' | ' |
                Should -Be '2026-09-19 | 2026-09-20 [aa] | 2026-09-20 [zz]'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'returns nothing when the archive directory does not exist (and does not throw)' {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
        @(Get-ArchivedDays -Dir $tmp).Count | Should -Be 0
    }
}

Describe 'Get-ArchiveDayLabel' -Skip:($PSVersionTable.PSVersion.Major -lt 7) {

    It 'keeps the legacy spelling untouched for an untagged archive' {
        # A fleet that never tagged anything must see byte-identical output.
        $a = [pscustomobject]@{ Date = [datetime]'2026-09-20'; Tag = $null }
        Get-ArchiveDayLabel -Archive $a | Should -BeExactly '2026-09-20'
    }

    It 'names the producer for a tagged archive' {
        $a = [pscustomobject]@{ Date = [datetime]'2026-09-20'; Tag = 'po-2025' }
        Get-ArchiveDayLabel -Archive $a | Should -BeExactly '2026-09-20 [po-2025]'
    }

    It 'gives DIFFERENT labels to two producers of one day (the whole point)' {
        $x = [pscustomobject]@{ Date = [datetime]'2026-09-20'; Tag = 'ai-01' }
        $y = [pscustomobject]@{ Date = [datetime]'2026-09-20'; Tag = $null }
        (Get-ArchiveDayLabel -Archive $x) | Should -Not -Be (Get-ArchiveDayLabel -Archive $y)
    }

    It 'is exported, or every consumer breaks at runtime' {
        # CaptureUtils has an explicit Export-ModuleMember list: a function added
        # to the file but not to that list is invisible to importers, and the
        # failure surfaces only when the script is actually run.
        (Get-Command Get-ArchiveDayLabel -Module CaptureUtils -ErrorAction SilentlyContinue) |
            Should -Not -BeNullOrEmpty
    }
}

Describe 'traffic-history wiring (text only: runs under BOTH interpreters)' {

    It 'routes every per-day print through the shared label' {
        $text = Get-Content -LiteralPath $script:HistoryPath -Raw
        # Positive control first: the two print sites still exist under the names
        # this assertion depends on. Without it, a rename would make the
        # "no bare date" assertion pass vacuously.
        $text | Should -Match 'Processing \{0\}'
        $text | Should -Match 'Archives to process'
        @([regex]::Matches($text, 'Get-ArchiveDayLabel')).Count | Should -Be 2
        # And no site formats the date itself any more.
        $text | Should -Not -Match "Date\.ToString\('yyyy-MM-dd'\)"
    }
}

Describe 'the pwsh-7-only skip is measured, not assumed' {

    It 'CaptureUtils really is unparseable under Windows PowerShell 5.1' -Skip:($PSVersionTable.PSVersion.Major -ge 7) {
        # The cases above are skipped under 5.1. A skip nobody justifies is worse
        # than a missing test: it is a green line. This asserts the skip's cause
        # is the interpreter and nothing else.
        $e = $null; $t = $null
        [System.Management.Automation.Language.Parser]::ParseFile($script:ModulePath, [ref]$t, [ref]$e) | Out-Null
        $e | Should -Not -BeNullOrEmpty -Because 'if it parses under 5.1, the skip above is hiding the tests for no reason'
    }

    It 'CaptureUtils parses cleanly under pwsh 7, where the cases above DO run' -Skip:($PSVersionTable.PSVersion.Major -lt 7) {
        $e = $null; $t = $null
        [System.Management.Automation.Language.Parser]::ParseFile($script:ModulePath, [ref]$t, [ref]$e) | Out-Null
        $e | Should -BeNullOrEmpty
    }
}
