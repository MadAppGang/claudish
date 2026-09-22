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

Describe 'Get-OffsiteWriteVerdict' {
    It 'allows the write when the destination is absent (the legitimate first upload)' {
        (Get-OffsiteWriteVerdict -DestExists $false -LocalBytes 100).Action | Should -Be 'write'
    }
    It 'treats an identical-size destination as an idempotent re-upload' {
        (Get-OffsiteWriteVerdict -DestExists $true -DestBytes 100 -LocalBytes 100).Action |
            Should -Be 'idempotent'
    }
    It 'REFUSES a different-size destination and names BOTH sizes (AC1)' {
        $v = Get-OffsiteWriteVerdict -DestExists $true -DestBytes 42 -LocalBytes 6
        $v.Action | Should -Be 'refuse'
        $v.Reason | Should -Match '42 bytes'
        $v.Reason | Should -Match '6 bytes'
    }
    It 'the refusal names the cause: another producer owns the name' {
        (Get-OffsiteWriteVerdict -DestExists $true -DestBytes 1 -LocalBytes 2).Reason |
            Should -Match 'another producer'
    }
}

Describe 'compress-captures.ps1 off-site overwrite guard (#208)' {
    BeforeAll {
        # A fake 7z as a .bat: batch receives the raw argument line (a .ps1 would
        # choke on the flag-looking args -t7z/-mx=9 at the parameter binder), and
        # `exit /b N` maps to $LASTEXITCODE. It writes a deterministic 6-byte
        # archive ("fake" + CRLF) on `a`, and answers `t` from file existence —
        # enough to drive the REAL script through compress -> upload -> re-upload
        # -> purge with no real 7z anywhere near the test.
        $script:FakeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-fake7z-{0}" -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $script:FakeRoot -Force | Out-Null
        $script:Fake7z = Join-Path $script:FakeRoot 'fake7z.bat'
        [System.IO.File]::WriteAllText($script:Fake7z, @'
@echo off
setlocal
set "MODE=%~1"
set "TARGET="
rem Match the archive by EXTENSION (%%~x), never by a fixed suffix length: the
rem last-4-chars test cannot match ".7z" (3 chars) on a real name - the last 4
rem chars of "x.7z" are "x.7z" - and native arg passing to a .bat splits
rem "-m0=lzma2" into two tokens, so flag-position assumptions do not survive
rem the interpreter either. Sandbox paths contain no spaces by construction.
for %%F in (%*) do if /i "%%~xF"==".7z" set "TARGET=%%~fF"
if /i "%MODE%"=="a" goto add
if /i "%MODE%"=="t" goto test
exit /b 1
:add
if not defined TARGET exit /b 1
echo fake> "%TARGET%"
exit /b 0
:test
if not defined TARGET exit /b 2
if not exist "%TARGET%" exit /b 2
exit /b 0
'@, (New-Object System.Text.ASCIIEncoding))

        # Runs the real script under the CURRENT interpreter in a caller-made
        # sandbox; everything (loose files, local archive, GDrive dir, log) lives
        # under $tmp. The fake archive is always exactly 6 bytes.
        function Invoke-CompactionRun {
            param([string]$CaptureDir, [string]$GDriveDir)
            & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath `
                -CaptureDir $CaptureDir -GDriveDir $GDriveDir `
                -ArchiveDir (Join-Path $CaptureDir 'archive') -MachineTag 'testbox' `
                -SevenZip $script:Fake7z -KeepLocalDays 0 *> $null
        }
        function New-GuardSandbox {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-guard-{0}" -f ([guid]::NewGuid().ToString('N')))
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'gd')  -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap\archive') -Force | Out-Null
            return $tmp
        }
        # One loose capture for yesterday, so the run reaches the compress loop
        # (with zero loose files the script exits long before the upload paths).
        function Add-LooseCapture {
            param([string]$CaptureDir, [int]$DaysBack)
            $day = (Get-Date).ToUniversalTime().Date.AddDays(-$DaysBack).ToString('yyyy-MM-dd')
            [System.IO.File]::WriteAllText((Join-Path $CaptureDir "req-1-1-$($day)T00-00-00.json"), 'loose')
            return $day
        }
    }
    AfterAll {
        Remove-Item -LiteralPath $script:FakeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'AC1+AC3+AC5: a different-size destination is REFUSED, untouched, local kept, loud log with both sizes' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $day  = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $dest = Join-Path $gd "captures-$($day)-testbox.7z"
            [System.IO.File]::WriteAllText($dest, ('x' * 42))   # another producer's 42-byte archive
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -BeGreaterThan 0     # the refusal counts as an error
            $log   | Should -Match 'REFUSE'             # loud, countable marker (AC5)
            $log   | Should -Match 'dest 42 bytes vs this run 6 bytes'   # both sizes (AC1)
            (Get-Item -LiteralPath $dest).Length | Should -Be 42         # destination NOT overwritten
            # AC3: the refused archive is still local — the purge requires an
            # exact size match, and 6 != 42, so nothing was deleted.
            Get-Item (Join-Path $cap "archive\captures-$($day)-testbox.7z") | Should -Not -BeNullOrEmpty
            # blast radius: the run logged inside the sandbox, not in production
            Test-Path (Join-Path $cap 'compaction.log') | Should -BeTrue
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'AC2: an identical-size destination is an idempotent success (retried nights do not start failing)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $day  = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $dest = Join-Path $gd "captures-$($day)-testbox.7z"
            [System.IO.File]::WriteAllText($dest, 'IDENTI')    # 6 bytes, same size as the fake archive
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -Be 0
            $log | Should -Match 'already current'
            $log | Should -Not -Match 'REFUSE'
            # same size but DIFFERENT bytes still there => no copy was performed
            [System.IO.File]::ReadAllText($dest) | Should -Be 'IDENTI'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'AC4 side 2: an empty namespace still receives its first upload (the guard has not eaten the feature)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $day  = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -Be 0
            $log | Should -Match 'GDRIVE .*uploaded'
            (Get-Item (Join-Path $gd "captures-$($day)-testbox.7z")).Length | Should -Be 6
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'the re-upload pass refuses a different-size destination too (second write site)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1      # today's work: uploads normally
            $oldDay = (Get-Date).ToUniversalTime().Date.AddDays(-2).ToString('yyyy-MM-dd')
            [System.IO.File]::WriteAllText((Join-Path $cap "archive\captures-$($oldDay)-testbox.7z"), ('y' * 30))
            [System.IO.File]::WriteAllText((Join-Path $gd "captures-$($oldDay)-testbox.7z"), ('z' * 7))
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -BeGreaterThan 0
            $log | Should -Match ("REFUSE captures-$($oldDay)-testbox")
            (Get-Item (Join-Path $gd "captures-$($oldDay)-testbox.7z")).Length | Should -Be 7
            Get-Item (Join-Path $cap "archive\captures-$($oldDay)-testbox.7z") | Should -Not -BeNullOrEmpty
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'wiring: the verdict is consulted BEFORE the Copy-Item at BOTH write sites' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        @([regex]::Matches($text, 'Get-OffsiteWriteVerdict')).Count | Should -Be 2
        $v1 = $text.IndexOf('Get-OffsiteWriteVerdict')
        $c1 = $text.IndexOf('Copy-Item -LiteralPath $archivePath')
        $v1 | Should -BeGreaterThan 0
        $c1 | Should -BeGreaterThan 0
        $v1 | Should -BeLessThan $c1
        $v2 = $text.IndexOf('Get-OffsiteWriteVerdict', $v1 + 1)
        $c2 = $text.IndexOf('Copy-Item -LiteralPath $arch.FullName')
        $v2 | Should -BeGreaterThan 0
        $c2 | Should -BeGreaterThan 0
        $v2 | Should -BeLessThan $c2
    }

    It 'AC3 wiring: the purge still requires an exact destination size match before any local delete' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        $purgeStart = $text.IndexOf('local retention purge')
        $purgeCheck = $text.IndexOf('(Get-Item -LiteralPath $dest).Length -eq $arch.Length', $purgeStart)
        $purgeDelete = $text.IndexOf('Remove-Item -LiteralPath $arch.FullName -Force', $purgeStart)
        $purgeStart  | Should -BeGreaterThan 0
        $purgeCheck  | Should -BeGreaterThan 0
        $purgeDelete | Should -BeGreaterThan 0
        $purgeCheck  | Should -BeLessThan $purgeDelete
    }
}
