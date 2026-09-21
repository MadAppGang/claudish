#requires -Version 5.1
<#
    Capture-archive namespace policy (compress-captures.ps1 + claudish-engine).

    What these pin is a DATA-LOSS path, not a formatting preference: the off-site
    directory is shared across the fleet, the upload is a forced overwrite, and
    local retention deletes an archive as soon as the destination "matches" — a
    check a second producer satisfies by comparing against the file it has just
    written itself. Two machines under the legacy name therefore destroy each
    other's day, with no copy left anywhere.
#>

BeforeAll {
    $script:RepoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:ModulePath = Join-Path $script:RepoRoot 'scripts\lib\claudish-engine.psm1'
    Import-Module $script:ModulePath -Force -DisableNameChecking
    $script:ScriptPath = Join-Path $script:RepoRoot 'scripts\compress-captures.ps1'
}

Describe 'Get-CaptureArchiveName' {
    It 'keeps the legacy spelling when no tag is given' {
        Get-CaptureArchiveName -Day '2026-09-20' | Should -Be 'captures-2026-09-20.7z'
    }
    It 'keeps the legacy spelling for a whitespace-only tag' {
        Get-CaptureArchiveName -Day '2026-09-20' -MachineTag '   ' | Should -Be 'captures-2026-09-20.7z'
    }
    It 'qualifies the name with the machine tag' {
        Get-CaptureArchiveName -Day '2026-09-20' -MachineTag 'po-2025' |
            Should -Be 'captures-2026-09-20-po-2025.7z'
    }
    It 'refuses a day that is not yyyy-MM-dd' {
        { Get-CaptureArchiveName -Day '20-09-2026' } | Should -Throw
    }
    It 'refuses a tag that would escape the filename (path separator)' {
        { Get-CaptureArchiveName -Day '2026-09-20' -MachineTag '..\..\evil' } | Should -Throw
    }
    It 'refuses a tag with a space' {
        { Get-CaptureArchiveName -Day '2026-09-20' -MachineTag 'po 2025' } | Should -Throw
    }
    It 'produces DIFFERENT names for two machines on the same day (the whole point)' {
        $a = Get-CaptureArchiveName -Day '2026-09-20' -MachineTag 'hubbox'
        $b = Get-CaptureArchiveName -Day '2026-09-20' -MachineTag 'sidebox'
        $a | Should -Not -Be $b
    }
}

Describe 'Get-CaptureArchiveDay' {
    It 'parses a legacy untagged name' {
        Get-CaptureArchiveDay -Name 'captures-2026-09-20.7z' | Should -Be '2026-09-20'
    }
    It 'parses a tagged name' {
        Get-CaptureArchiveDay -Name 'captures-2026-09-20-po-2025.7z' | Should -Be '2026-09-20'
    }
    It 'returns nothing for a name that is not ours (purge must skip, never guess)' {
        Get-CaptureArchiveDay -Name 'lane-series.sqlite'        | Should -BeNullOrEmpty
        Get-CaptureArchiveDay -Name 'captures-latest.7z'        | Should -BeNullOrEmpty
        Get-CaptureArchiveDay -Name 'xcaptures-2026-09-20.7z'   | Should -BeNullOrEmpty
        Get-CaptureArchiveDay -Name 'captures-2026-09-20.7z.tmp'| Should -BeNullOrEmpty
    }
}

Describe 'Get-CaptureArchiveMachineTag' {
    It 'is empty for a legacy name' {
        Get-CaptureArchiveMachineTag -Name 'captures-2026-09-20.7z' | Should -Be ''
    }
    It 'returns the tag for a tagged name' {
        Get-CaptureArchiveMachineTag -Name 'captures-2026-09-20-po-2025.7z' | Should -Be 'po-2025'
    }
    It 'round-trips with Get-CaptureArchiveName' {
        $n = Get-CaptureArchiveName -Day '2026-09-20' -MachineTag 'ai-01'
        Get-CaptureArchiveMachineTag -Name $n | Should -Be 'ai-01'
        Get-CaptureArchiveDay        -Name $n | Should -Be '2026-09-20'
    }
}

Describe 'Get-CaptureArchivePolicy' {
    It 'REFUSES an untagged run against a shared off-site directory (the default, and the destructive case)' {
        $p = Get-CaptureArchivePolicy -GDriveDir 'G:\shared\claudish'
        $p.Ok     | Should -BeFalse
        $p.Reason | Should -Match 'MachineTag'
    }
    It 'allows an untagged run when the owner of the legacy namespace opts in explicitly' {
        (Get-CaptureArchivePolicy -GDriveDir 'G:\shared\claudish' -AllowUntaggedSharedArchive).Ok |
            Should -BeTrue
    }
    It 'allows a tagged run against a shared directory' {
        $p = Get-CaptureArchivePolicy -GDriveDir 'G:\shared\claudish' -MachineTag 'po-2024'
        $p.Ok         | Should -BeTrue
        $p.MachineTag | Should -Be 'po-2024'
    }
    It 'allows an untagged run when there is NO off-site directory (nothing is shared)' {
        (Get-CaptureArchivePolicy -GDriveDir '').Ok | Should -BeTrue
    }
    It 'refuses a tag that is not filename-safe, without throwing' {
        $p = Get-CaptureArchivePolicy -GDriveDir 'G:\shared\claudish' -MachineTag 'po/2024'
        $p.Ok     | Should -BeFalse
        $p.Reason | Should -Match 'filename-safe'
    }
    It 'trims the tag it returns so the caller cannot build a padded name' {
        (Get-CaptureArchivePolicy -GDriveDir 'G:\s' -MachineTag '  ai-01  ').MachineTag | Should -Be 'ai-01'
    }
}

Describe 'compress-captures.ps1 wiring' {
    It 'parses under this interpreter' {
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($script:ScriptPath, [ref]$null, [ref]$errors)
        @($errors).Count | Should -Be 0
    }

    It 'gates on the policy BEFORE it enumerates or archives anything' {
        $text  = Get-Content -LiteralPath $script:ScriptPath -Raw
        $gate  = $text.IndexOf('Get-CaptureArchivePolicy')
        $pack  = $text.IndexOf('$SevenZip a -t7z')
        $enum  = $text.IndexOf('enumerate loose captures')
        $gate | Should -BeGreaterThan 0
        $gate | Should -BeLessThan $enum
        $gate | Should -BeLessThan $pack
    }

    It 'no longer hardcodes the legacy archive name when building a path' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        # The literal may still appear in prose/params; what must be gone is the
        # constructed path that bypasses the helper.
        $text | Should -Not -Match 'Join-Path \$ArchiveDir "captures-\$day\.7z"'
    }

    It 'exits non-zero on a refused namespace (positive control: the gate is reachable)' {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-gate-{0}" -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        try {
            $exe = (Get-Process -Id $PID).Path
            # GDriveDir set + no tag + no opt-in => must refuse, and must do so
            # before touching 7z (which is deliberately pointed at a missing path:
            # if the gate did NOT fire first we would get the 7z FATAL, exit 2).
            & $exe -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath `
                -CaptureDir $tmp -GDriveDir $tmp -SevenZip (Join-Path $tmp 'nope.exe') *> $null
            $LASTEXITCODE | Should -Be 3
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'proceeds past the gate when a tag is supplied (negative control for the test above)' {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-gate-{0}" -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        try {
            $exe = (Get-Process -Id $PID).Path
            & $exe -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath `
                -CaptureDir $tmp -GDriveDir $tmp -MachineTag 'testbox' -SevenZip (Join-Path $tmp 'nope.exe') *> $null
            # 2 = the 7z precondition, i.e. the namespace gate let the run through.
            $LASTEXITCODE | Should -Be 2
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
