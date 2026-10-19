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
                -CaptureDir $tmp -GDriveDir $tmp -SevenZip (Join-Path $tmp 'nope.exe') -NoSevenZipFallback *> $null
            $LASTEXITCODE | Should -Be 3
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'proceeds past the gate when a tag is supplied (negative control for the test above)' {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-gate-{0}" -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        try {
            $exe = (Get-Process -Id $PID).Path
            & $exe -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath `
                -CaptureDir $tmp -GDriveDir $tmp -MachineTag 'testbox' -SevenZip (Join-Path $tmp 'nope.exe') -NoSevenZipFallback *> $null
            # 2 = the 7z precondition, i.e. the namespace gate let the run through.
            $LASTEXITCODE | Should -Be 2
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Get-SevenZipCandidates' {
    It 'lists the verified PortableApps path FIRST' {
        (Get-SevenZipCandidates)[0] | Should -Be 'D:\PortableApps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe'
    }
    It 'still lists the legacy D:\Apps spelling as a fallback, not as the only entry' {
        $c = Get-SevenZipCandidates
        ($c -contains 'D:\Apps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe') | Should -BeTrue
        $c.Count | Should -BeGreaterThan 1
    }
    It 'appends caller-supplied -Extra paths LAST (a fallback, not a priority)' {
        $c = Get-SevenZipCandidates -Extra 'X:\custom\7z.exe'
        $c[-1] | Should -Be 'X:\custom\7z.exe'
    }
    It 'skips an empty -Extra entry' {
        (Get-SevenZipCandidates -Extra @('')).Count | Should -Be (Get-SevenZipCandidates).Count
    }
}

Describe 'Resolve-SevenZipPath (#214)' {
    BeforeAll {
        $script:existsNone = { param($p) $false }
        $script:existsOnly = { param($p) $p -eq 'C:\real\7z.exe' }
    }

    It 'uses the explicit path when it exists (source=explicit, tried names only it)' {
        $r = Resolve-SevenZipPath -Explicit 'C:\real\7z.exe' -Candidates @('C:\other\7z.exe') -Exists $script:existsOnly
        $r.Path | Should -Be 'C:\real\7z.exe'
        $r.Source | Should -Be 'explicit'
        $r.ExplicitMissing | Should -BeFalse
        $r.Tried | Should -Be @('C:\real\7z.exe')
    }

    It 'falls back to the candidate list when the explicit path is MISSING (the c.33 outage class)' {
        $r = Resolve-SevenZipPath -Explicit 'D:\Apps\wrong\7z.exe' -Candidates @('C:\real\7z.exe') -Exists $script:existsOnly
        $r.Path | Should -Be 'C:\real\7z.exe'
        $r.Source | Should -Be 'candidate'
        $r.ExplicitMissing | Should -BeTrue
    }

    It 'honours candidate order (first existing wins)' {
        $exists = { param($p) $p -in @('B', 'C') }
        (Resolve-SevenZipPath -Candidates @('A', 'B', 'C') -Exists $exists).Path | Should -Be 'B'
    }

    It 'skips empty and duplicate candidates' {
        $exists = { param($p) $p -eq 'C' }
        (Resolve-SevenZipPath -Candidates @('', 'C') -Exists $exists).Tried | Should -Be @('C')
        (Resolve-SevenZipPath -Candidates @('B', 'B') -Exists $exists).Tried | Should -Be @('B')
    }

    It 'with -NoFallback a missing explicit resolves to nothing (the FATAL stays reachable)' {
        $r = Resolve-SevenZipPath -Explicit 'C:\real\7z.exe' -Candidates @('C:\real\7z.exe') -NoFallback -Exists $script:existsNone
        $r.Path | Should -Be ''
        $r.Source | Should -Be 'none'
        $r.Tried | Should -Be @('C:\real\7z.exe')
    }

    It 'names EVERY path it tried when nothing resolves (the diagnostic contract)' {
        $r = Resolve-SevenZipPath -Explicit 'E:\x\7z.exe' -Candidates @('C:\a\7z.exe', 'C:\b\7z.exe') -Exists $script:existsNone
        $r.Path | Should -Be ''
        ($r.Tried -join '; ') | Should -Be 'E:\x\7z.exe; C:\a\7z.exe; C:\b\7z.exe'
    }
}

Describe 'compress-captures.ps1 7z resolution wiring (#214)' {
    It 'delegates resolution to the module instead of one hardcoded default' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        $text | Should -Match 'Resolve-SevenZipPath'
        $text | Should -Match 'Get-SevenZipCandidates'
        # the old single hardcoded DEFAULT must be gone (a caller may still PASS one)
        $text | Should -Not -Match '\[string\]\$SevenZip\s*=\s*"D:\\Apps\\PortableApps'
    }

    It 'logs every tried path on the FATAL branch' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        $text | Should -Match 'FATAL: 7z not found - tried:'
    }

    It 'warns instead of dying when an explicit -SevenZip is missing' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        $text | Should -Match 'does not exist -> resolved to'
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

Describe 'compress-captures.ps1 partial-archive quarantine + re-upload integrity gate (#322)' {
    # The 04/10 incident: 7z a failed mid-pack, the partial stayed under the
    # canonical name, and the re-upload pass shipped it off-site as a valid
    # archive (93 MB standing in for 22 GB). Two guards: the partial is
    # quarantined (renamed, suffix after .7z) the moment the pack fails, and
    # the re-upload pass requires `7z t` before shipping anything.
    BeforeAll {
        $script:FakeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-fake7z-{0}" -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $script:FakeRoot -Force | Out-Null
        $script:Fake7z = Join-Path $script:FakeRoot 'fake7z.bat'
        [System.IO.File]::WriteAllText($script:Fake7z, @'
@echo off
setlocal
set "MODE=%~1"
set "TARGET="
for %%F in (%*) do if /i "%%~xF"==".7z" set "TARGET=%%~fF"
if /i "%MODE%"=="a" goto add
if /i "%MODE%"=="t" goto test
exit /b 1
:add
if not defined TARGET exit /b 1
if "%CC_FAKE7Z_FAIL_ADD%"=="1" (
  echo partial> "%TARGET%"
  exit /b 2
)
echo fake> "%TARGET%"
exit /b 0
:test
if not defined TARGET exit /b 2
if not exist "%TARGET%" exit /b 2
if "%CC_FAKE7Z_FAIL_TEST%"=="1" exit /b 2
exit /b 0
'@, (New-Object System.Text.ASCIIEncoding))
        function Invoke-CompactionRun {
            param([string]$CaptureDir, [string]$GDriveDir)
            & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath `
                -CaptureDir $CaptureDir -GDriveDir $GDriveDir `
                -ArchiveDir (Join-Path $CaptureDir 'archive') -MachineTag 'testbox' `
                -SevenZip $script:Fake7z -KeepLocalDays 0 *> $null
        }
        function New-GuardSandbox {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-322-{0}" -f ([guid]::NewGuid().ToString('N')))
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'gd')  -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap\archive') -Force | Out-Null
            return $tmp
        }
        function Add-LooseCapture {
            param([string]$CaptureDir, [int]$DaysBack)
            $day = (Get-Date).ToUniversalTime().Date.AddDays(-$DaysBack).ToString('yyyy-MM-dd')
            [System.IO.File]::WriteAllText((Join-Path $CaptureDir "req-1-1-$($day)T00-00-00.json"), 'loose')
            return $day
        }
    }
    BeforeEach {
        # Inert unless a test sets its FAIL_* var (and always restored, so the
        # shared #208 fake semantics never leak across tests).
        $script:SavedFailAdd  = $env:CC_FAKE7Z_FAIL_ADD
        $script:SavedFailTest = $env:CC_FAKE7Z_FAIL_TEST
        $env:CC_FAKE7Z_FAIL_ADD  = $null
        $env:CC_FAKE7Z_FAIL_TEST = $null
    }
    AfterEach {
        $env:CC_FAKE7Z_FAIL_ADD  = $script:SavedFailAdd
        $env:CC_FAKE7Z_FAIL_TEST = $script:SavedFailTest
    }
    AfterAll {
        Remove-Item -LiteralPath $script:FakeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'a failed pack quarantines its partial instead of leaving the canonical name behind (#322 AC1)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $day  = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $env:CC_FAKE7Z_FAIL_ADD = '1'
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -BeGreaterThan 0          # the failed night is visible
            $log | Should -Match 'QUARANTINE'                 # loud, countable marker
            # The canonical name no longer exists...
            Test-Path (Join-Path $cap "archive\captures-$($day)-testbox.7z") | Should -BeFalse
            # ...the partial lives under a .7z-prefixed quarantine suffix, which
            # the captures-*.7z filter, the day parser and every reader exclude
            # structurally (nothing can ever ship or list it again).
            $q = Get-ChildItem (Join-Path $cap 'archive') -Filter "captures-$($day)-testbox.7z.partial-*" -File
            @($q).Count | Should -Be 1
            # Loose originals kept (KEEPING loose files): the next run re-packs from scratch.
            Test-Path (Join-Path $cap "req-1-1-$($day)T00-00-00.json") | Should -BeTrue
            # And nothing left the machine under the canonical name.
            Test-Path (Join-Path $gd "captures-$($day)-testbox.7z") | Should -BeFalse
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'the re-upload pass refuses a local archive that fails 7z t (#322 AC2 — the 04/10 shape)' {
        # Without the gate this run re-uploads the 30-byte unreadable archive
        # (destination absent = write verdict), which is exactly the incident.
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1     # today's pack: uploads normally
            $oldDay = (Get-Date).ToUniversalTime().Date.AddDays(-2).ToString('yyyy-MM-dd')
            [System.IO.File]::WriteAllText((Join-Path $cap "archive\captures-$($oldDay)-testbox.7z"), ('y' * 30))
            $env:CC_FAKE7Z_FAIL_TEST = '1'                            # every integrity test fails
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -BeGreaterThan 0
            # Refused, never renamed (old day: loose originals long gone, the
            # log line is the escalation), never uploaded.
            $log | Should -Match ("REFUSE captures-$($oldDay)-testbox: local archive fails 7z t")
            Test-Path (Join-Path $gd "captures-$($oldDay)-testbox.7z") | Should -BeFalse
            (Get-Item (Join-Path $cap "archive\captures-$($oldDay)-testbox.7z")).Length | Should -Be 30
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'wiring: the integrity gate runs BEFORE the re-upload Copy-Item' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        $reup  = $text.IndexOf('re-upload pass')
        $gate  = $text.IndexOf('& $SevenZip t', $reup)
        $copy  = $text.IndexOf('Copy-Item -LiteralPath $arch.FullName', $reup)
        $reup | Should -BeGreaterThan 0
        $gate | Should -BeGreaterThan 0
        $gate | Should -BeLessThan $copy
    }
}

Describe 'Get-CapturePartialInfo (#418) — the quarantine naming needs its own selector' {
    It 'recovers day, canonical name and tag from a tagged quarantine' {
        $i = Get-CapturePartialInfo -Name 'captures-2026-09-30-myia-po-2024.7z.partial-20261005T004716'
        $i.Day       | Should -Be '2026-09-30'
        $i.Canonical | Should -Be 'captures-2026-09-30-myia-po-2024.7z'
        $i.Tag       | Should -Be 'myia-po-2024'
    }

    It 'recovers the same facts from an untagged (legacy namespace) quarantine' {
        $i = Get-CapturePartialInfo -Name 'captures-2026-09-30.7z.partial-20261005T004716'
        $i.Day       | Should -Be '2026-09-30'
        $i.Canonical | Should -Be 'captures-2026-09-30.7z'
        $i.Tag       | Should -Be ''
    }

    It 'accepts the collision suffix the quarantine appends when a name is already taken' {
        (Get-CapturePartialInfo -Name 'captures-2026-09-30-myia-po-2024.7z.partial-20261005T004716-2').Canonical |
            Should -Be 'captures-2026-09-30-myia-po-2024.7z'
    }

    It 'returns nothing for a canonical archive (a live archive is never a corpse)' {
        Get-CapturePartialInfo -Name 'captures-2026-09-30-myia-po-2024.7z' | Should -BeNullOrEmpty
    }

    It 'returns nothing for a name that is not ours (never guess before deleting)' {
        Get-CapturePartialInfo -Name 'random.partial-20261005T004716'             | Should -BeNullOrEmpty
        Get-CapturePartialInfo -Name 'captures-2026-09-30.7z.partial-notats'      | Should -BeNullOrEmpty
        Get-CapturePartialInfo -Name 'captures-2026-09-30.7z.partial-20261005'    | Should -BeNullOrEmpty
    }

    It 'the canonical name it recovers is one the day parser accepts (the two must not drift)' {
        $i = Get-CapturePartialInfo -Name 'captures-2026-09-30-myia-po-2024.7z.partial-20261005T004716'
        Get-CaptureArchiveDay -Name $i.Canonical | Should -Be $i.Day
    }
}

Describe 'compress-captures.ps1 quarantined-partial purge (#418)' {
    # #322's quarantine renamed a failed pack's partial to `<name>.7z.partial-<ts>`,
    # which structurally hides it from the `captures-*.7z` selector — the SAME
    # selector the retention purge uses. So nothing ever removed one: the hub held
    # a 97 MB corpse 7 days after it was written. These pin the second, narrowly
    # scoped selector, and — just as important — that it removes ONLY provably
    # dead weight.
    BeforeAll {
        $script:FakeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-fake7z-{0}" -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $script:FakeRoot -Force | Out-Null
        $script:Fake7z = Join-Path $script:FakeRoot 'fake7z.bat'
        [System.IO.File]::WriteAllText($script:Fake7z, @'
@echo off
setlocal
set "MODE=%~1"
set "TARGET="
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
        function Invoke-CompactionRun {
            param([string]$CaptureDir, [string]$GDriveDir)
            & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath `
                -CaptureDir $CaptureDir -GDriveDir $GDriveDir `
                -ArchiveDir (Join-Path $CaptureDir 'archive') -MachineTag 'testbox' `
                -SevenZip $script:Fake7z -KeepLocalDays 0 *> $null
        }
        function New-GuardSandbox {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-418-{0}" -f ([guid]::NewGuid().ToString('N')))
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'gd')  -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap\archive') -Force | Out-Null
            return $tmp
        }
        # With zero loose files the script bails out long before the purge blocks,
        # so every case needs one: it rides the ordinary pack path and is not the
        # subject of these tests.
        function Add-LooseCapture {
            param([string]$CaptureDir, [int]$DaysBack)
            $day = (Get-Date).ToUniversalTime().Date.AddDays(-$DaysBack).ToString('yyyy-MM-dd')
            [System.IO.File]::WriteAllText((Join-Path $CaptureDir "req-1-1-$($day)T00-00-00.json"), 'loose')
            return $day
        }
        function Add-QuarantinedPartial {
            param([string]$CaptureDir, [string]$Day)
            $p = Join-Path $CaptureDir "archive\captures-$($Day)-testbox.7z.partial-20261005T004716"
            [System.IO.File]::WriteAllText($p, 'corpse')
            return $p
        }
        # The off-site evidence that makes a partial removable. The sha256 must be
        # the REAL hash: the nightly sha re-check re-hashes this file and would
        # flag content drift (a non-zero night) on a fabricated digest.
        function Add-OffsiteEvidence {
            param([string]$GDriveDir, [string]$Day, [int]$Bytes, [switch]$NoManifestRecord, [int]$RecordedBytes = -1)
            $name = "captures-$($Day)-testbox.7z"
            $live = Join-Path $GDriveDir $name
            [System.IO.File]::WriteAllText($live, ('v' * $Bytes))
            if (-not $NoManifestRecord) {
                if ($RecordedBytes -lt 0) { $RecordedBytes = $Bytes }
                $sha  = (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash
                $line = (@{ archive = $name; sha256 = $sha; bytes = $RecordedBytes; recorded = '2026-10-05T00:00:00Z' } | ConvertTo-Json -Compress)
                [System.IO.File]::WriteAllText((Join-Path $GDriveDir 'captures-sha256-testbox.jsonl'), $line, (New-Object System.Text.UTF8Encoding($false)))
            }
        }
    }
    AfterAll {
        Remove-Item -LiteralPath $script:FakeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'deletes a partial whose day is confirmed off-site at the recorded size (the hub corpse, removable today)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $oldDay  = (Get-Date).ToUniversalTime().Date.AddDays(-5).ToString('yyyy-MM-dd')
            $partial = Add-QuarantinedPartial -CaptureDir $cap -Day $oldDay
            Add-OffsiteEvidence -GDriveDir $gd -Day $oldDay -Bytes 500
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            Test-Path -LiteralPath $partial | Should -BeFalse
            $log | Should -Match 'QUARANTINE purge: 1 partial\(s\) deleted'
            $LASTEXITCODE | Should -Be 0            # clearing a corpse is not a failed night
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'KEEPS a partial whose day is NOT off-site (a failed pack is exactly when the day is least safe)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $oldDay  = (Get-Date).ToUniversalTime().Date.AddDays(-5).ToString('yyyy-MM-dd')
            $partial = Add-QuarantinedPartial -CaptureDir $cap -Day $oldDay
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd     # no off-site copy, no record
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            Test-Path -LiteralPath $partial | Should -BeTrue
            $log | Should -Match 'QUARANTINE purge: 0 partial\(s\) deleted, 1 kept \(day not off-site\)'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'KEEPS a partial whose off-site copy has no MATCHING deposit record (size unproven)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $oldDay  = (Get-Date).ToUniversalTime().Date.AddDays(-5).ToString('yyyy-MM-dd')
            $partial = Add-QuarantinedPartial -CaptureDir $cap -Day $oldDay
            Add-OffsiteEvidence -GDriveDir $gd -Day $oldDay -Bytes 500 -RecordedBytes 499
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            Test-Path -LiteralPath $partial | Should -BeTrue
            $log | Should -Match 'QUARANTINE purge: 0 partial\(s\) deleted, 0 kept \(day not off-site\), 1 kept \(no matching deposit record\)'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'never selects a live archive: the selector needs the .partial- suffix, not just the .7z prefix' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $oldDay = (Get-Date).ToUniversalTime().Date.AddDays(-5).ToString('yyyy-MM-dd')
            Add-OffsiteEvidence -GDriveDir $gd -Day $oldDay -Bytes 500
            # A live archive whose off-site copy exists — the retention purge's job
            # (KeepLocalDays 0 deletes it), never this pass's.
            [System.IO.File]::WriteAllText((Join-Path $cap "archive\captures-$($oldDay)-testbox.7z"), ('v' * 500))
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            (Get-Content (Join-Path $cap 'compaction.log') -Raw) | Should -Not -Match 'QUARANTINE purge:'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'relocates a canonical archive stranded in the capture ROOT (the same unreachable shape)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $oldDay = (Get-Date).ToUniversalTime().Date.AddDays(-5).ToString('yyyy-MM-dd')
            Add-OffsiteEvidence -GDriveDir $gd -Day $oldDay -Bytes 500
            $stray = Join-Path $cap "captures-$($oldDay)-testbox.7z"     # the ROOT, not archive\
            [System.IO.File]::WriteAllText($stray, ('v' * 500))
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $log | Should -Match "RELOCATE stranded archive captures-$($oldDay)-testbox.7z"
            Test-Path -LiteralPath $stray | Should -BeFalse          # gone from the ROOT
            # and the ordinary retention purge reclaimed it from the archive dir
            # (off-site copy confirmed at the same size) — count is not pinned: the
            # night's own freshly-packed archive is local at purge time too.
            @(Get-ChildItem (Join-Path $cap 'archive') -Filter "captures-$($oldDay)-testbox.7z" -File).Count | Should -Be 0
            $log | Should -Match 'PURGE retention=0d: [1-9][0-9]* local archive\(s\) deleted'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'leaves a stranded archive alone when the run does not own its name (never guess)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $oldDay = (Get-Date).ToUniversalTime().Date.AddDays(-5).ToString('yyyy-MM-dd')
            $stray = Join-Path $cap "captures-$($oldDay)-someothermachine.7z"
            [System.IO.File]::WriteAllText($stray, 'not ours')
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            Test-Path -LiteralPath $stray | Should -BeTrue
            (Get-Content (Join-Path $cap 'compaction.log') -Raw) | Should -Not -Match 'RELOCATE'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'refuses to relocate onto a namesake instead of overwriting it (never a silent merge)' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            $oldDay = (Get-Date).ToUniversalTime().Date.AddDays(-5).ToString('yyyy-MM-dd')
            $stray = Join-Path $cap "captures-$($oldDay)-testbox.7z"
            [System.IO.File]::WriteAllText($stray, 'root copy')
            $namesake = Join-Path $cap "archive\captures-$($oldDay)-testbox.7z"
            [System.IO.File]::WriteAllText($namesake, 'archive copy')
            # A different-size off-site copy makes the re-upload pass REFUSE (#208)
            # and the retention purge skip, so the namesake stays on disk for this
            # assertion — the point is that the relocation did not clobber it.
            [System.IO.File]::WriteAllText((Join-Path $gd "captures-$($oldDay)-testbox.7z"), ('z' * 999))
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $log | Should -Match 'WARN  stranded archive .* has a namesake in the archive dir'
            Test-Path -LiteralPath $stray | Should -BeTrue
            (Get-Content -LiteralPath $namesake -Raw) | Should -Be 'archive copy'   # untouched, not merged
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'wiring: the quarantine selector is the .partial- suffix, and the proof runs BEFORE the delete' {
        $text  = Get-Content -LiteralPath $script:ScriptPath -Raw
        $start = $text.IndexOf('quarantined-partial purge')
        $sel   = $text.IndexOf("-Filter 'captures-*.7z.partial-*'", $start)
        $guard = $text.IndexOf('$qRec.bytes -ne $qDestItem.Length', $start)
        $del   = $text.IndexOf('Remove-Item -LiteralPath $q.FullName -Force', $start)
        $start | Should -BeGreaterThan 0
        $sel   | Should -BeGreaterThan 0
        $guard | Should -BeGreaterThan 0
        $del   | Should -BeGreaterThan 0
        $guard | Should -BeLessThan $del
    }
}

Describe 'off-site sha256 manifest (#389) — engine functions' {
    It 'names the manifest per machine tag, mirroring the archive-name namespace' {
        Get-ShaManifestPath -GDriveDir 'G:\shared' -MachineTag 'po-2024' |
            Should -Be 'G:\shared\captures-sha256-po-2024.jsonl'
        Get-ShaManifestPath -GDriveDir 'G:\shared' |
            Should -Be 'G:\shared\captures-sha256.jsonl'
        # two machines never share one manifest file (same reason as #201)
        (Get-ShaManifestPath -GDriveDir 'G:\s' -MachineTag 'a') -ne (Get-ShaManifestPath -GDriveDir 'G:\s' -MachineTag 'b') |
            Should -BeTrue
    }

    It 'reads an absent manifest as empty (first run after the change has nothing recorded)' {
        $m = Read-ShaManifest -Path (Join-Path ([System.IO.Path]::GetTempPath()) ("no-such-{0}.jsonl" -f ([guid]::NewGuid().ToString('N'))))
        $m.Entries.Count | Should -Be 0
        $m.BadLines     | Should -Be 0
    }

    It 'upserts, replaces on re-upload, preserves siblings, and round-trips' {
        $p = Join-Path ([System.IO.Path]::GetTempPath()) ("sha-man-{0}.jsonl" -f ([guid]::NewGuid().ToString('N')))
        try {
            $null = Update-ShaManifest -Path $p -Archive 'captures-2026-10-05-po-2024.7z' -Sha256 ('a' * 64) -Bytes 6 -RecordedUtc '2026-10-06T02:47:11Z'
            $null = Update-ShaManifest -Path $p -Archive 'captures-2026-10-06-po-2024.7z' -Sha256 ('b' * 64) -Bytes 7 -RecordedUtc '2026-10-07T02:47:09Z'
            $m = Read-ShaManifest -Path $p
            $m.Entries.Count | Should -Be 2
            $m.Entries['captures-2026-10-05-po-2024.7z'].sha256 | Should -Be ('a' * 64)
            # a retried night re-uploads the SAME name: one hash per name, not two
            $null = Update-ShaManifest -Path $p -Archive 'captures-2026-10-05-po-2024.7z' -Sha256 ('c' * 64) -Bytes 6 -RecordedUtc '2026-10-07T03:12:00Z'
            $m2 = Read-ShaManifest -Path $p
            $m2.Entries.Count | Should -Be 2
            $m2.Entries['captures-2026-10-05-po-2024.7z'].sha256 | Should -Be ('c' * 64)
            $m2.Entries['captures-2026-10-06-po-2024.7z'].sha256 | Should -Be ('b' * 64)
            # no BOM: a BOM poisons the first line for every non-PowerShell reader.
            # The first line is the record's JSON, so byte 0 must be '{' (0x7B),
            # never the EF BB BF preamble.
            [System.IO.File]::ReadAllBytes($p)[0] | Should -Be 0x7B
        } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }

    It 'skips a torn manifest line and counts it, without blinding the rest' {
        $p = Join-Path ([System.IO.Path]::GetTempPath()) ("sha-man-{0}.jsonl" -f ([guid]::NewGuid().ToString('N')))
        try {
            [System.IO.File]::WriteAllLines($p, [string[]]@(
                '{"archive":"a.7z","sha256":"aaaa","bytes":1,"recorded":"t1"}',
                '>>> torn mid-write garbage <<<',
                '{"archive":"b.7z","sha256":"bbbb","bytes":2,"recorded":"t2"}'
            ), (New-Object System.Text.UTF8Encoding($false)))
            $m = Read-ShaManifest -Path $p
            $m.BadLines      | Should -Be 1
            $m.Entries.Count | Should -Be 2
            $m.Entries['b.7z'].sha256 | Should -Be 'bbbb'
        } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }

    It 'Select-ShaRotation: same seed picks the same entries (a re-run re-checks the same files)' {
        $names = @('a.7z','b.7z','c.7z','d.7z','e.7z','f.7z','g.7z')
        $seed  = [datetime]'2026-10-07T00:00:00Z'
        $x = Select-ShaRotation -Names $names -Count 3 -SeedDateUtc $seed
        $y = Select-ShaRotation -Names $names -Count 3 -SeedDateUtc $seed
        ($x -join ';') | Should -Be ($y -join ';')
        $x.Count | Should -Be 3
    }

    It 'Select-ShaRotation: every entry is re-checked within ceil(count/N) consecutive days' {
        $names = @('a.7z','b.7z','c.7z','d.7z','e.7z','f.7z','g.7z','h.7z')
        $seen  = @{}
        for ($d = 0; $d -lt 3; $d++) {
            $seed = ([datetime]'2026-10-01T00:00:00Z').AddDays($d)
            foreach ($n in (Select-ShaRotation -Names $names -Count 3 -SeedDateUtc $seed)) { $seen[$n] = $true }
        }
        $seen.Count | Should -Be $names.Count
    }

    It 'Select-ShaRotation: Count 0 disables (the escape hatch), empty names yields nothing' {
        (Select-ShaRotation -Names @('a.7z') -Count 0 -SeedDateUtc ([datetime]'2026-10-07T00:00:00Z')).Count | Should -Be 0
        (Select-ShaRotation -Names @()        -Count 3 -SeedDateUtc ([datetime]'2026-10-07T00:00:00Z')).Count | Should -Be 0
    }
}

Describe 'compress-captures.ps1 off-site sha manifest wiring (#389) — end to end' {
    BeforeAll {
        # Same fake-7z contract as the #208/#322 suites: `a` writes a deterministic
        # 6-byte archive ("fake" + CRLF), `t` answers from existence. The deposit
        # hash of that archive is therefore known and stable inside a sandbox.
        $script:FakeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-fake7z-{0}" -f ([guid]::NewGuid().ToString('N')))
        New-Item -ItemType Directory -Path $script:FakeRoot -Force | Out-Null
        $script:Fake7z = Join-Path $script:FakeRoot 'fake7z.bat'
        [System.IO.File]::WriteAllText($script:Fake7z, @'
@echo off
setlocal
set "MODE=%~1"
set "TARGET="
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
        function Invoke-CompactionRun {
            param([string]$CaptureDir, [string]$GDriveDir)
            & (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File $script:ScriptPath `
                -CaptureDir $CaptureDir -GDriveDir $GDriveDir `
                -ArchiveDir (Join-Path $CaptureDir 'archive') -MachineTag 'testbox' `
                -SevenZip $script:Fake7z -KeepLocalDays 0 *> $null
        }
        function New-GuardSandbox {
            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-389-{0}" -f ([guid]::NewGuid().ToString('N')))
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'gd')  -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $tmp 'cap\archive') -Force | Out-Null
            return $tmp
        }
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

    It 'a successful upload records the DESTINATION hash in the per-machine manifest' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $day = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $LASTEXITCODE | Should -Be 0
            $manifest = Join-Path $gd 'captures-sha256-testbox.jsonl'
            Test-Path $manifest | Should -BeTrue
            $m = Read-ShaManifest -Path $manifest
            $m.Entries.Count | Should -Be 1
            $rec = $m.Entries["captures-$($day)-testbox.7z"]
            $rec | Should -Not -BeNullOrEmpty
            $rec.bytes | Should -Be 6
            # the reference is the hash of what the DESTINATION holds, not a wish
            $rec.sha256 | Should -Be ((Get-FileHash -LiteralPath (Join-Path $gd "captures-$($day)-testbox.7z") -Algorithm SHA256).Hash)
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'THE #389 pin: content drift at EQUAL SIZE on the off-site copy is DETECTED by the next night' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $day1 = Add-LooseCapture -CaptureDir $cap -DaysBack 2
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd     # night 1: upload + record
            $LASTEXITCODE | Should -Be 0
            # --- the drift: same 6 bytes' worth of file, different bytes. Invisible
            # to #208 (sizes equal) and to 7z t is NOT even run off-site - only the
            # recorded hash can see it.
            [System.IO.File]::WriteAllText((Join-Path $gd "captures-$($day1)-testbox.7z"), 'DRIFT!')   # 6 bytes, different content
            (Get-Item -LiteralPath (Join-Path $gd "captures-$($day1)-testbox.7z")).Length | Should -Be 6
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd     # night 2: re-check runs
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -BeGreaterThan 0                  # loud, non-zero night
            $log | Should -Match 'SHA-CHECK captures-.*-testbox\.7z: CONTENT DRIFT'
            $log | Should -Match 'ERROR'                             # countable marker class
            # the drifted file is NEVER touched by the check - read-only verdict
            [System.IO.File]::ReadAllText((Join-Path $gd "captures-$($day1)-testbox.7z")) | Should -Be 'DRIFT!'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'control: an untampered history re-checks OK and the night stays zero' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 2
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -Be 0
            $log | Should -Match 'SHA-CHECK captures-.*-testbox\.7z: OK'
            $log | Should -Not -Match 'CONTENT DRIFT'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'a manifest entry whose file went ABSENT off-site is an error, never silently dropped' {
        $tmp = New-GuardSandbox
        try {
            $cap = Join-Path $tmp 'cap'; $gd = Join-Path $tmp 'gd'
            $day1 = Add-LooseCapture -CaptureDir $cap -DaysBack 2
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            Remove-Item -LiteralPath (Join-Path $gd "captures-$($day1)-testbox.7z") -Force
            $null = Add-LooseCapture -CaptureDir $cap -DaysBack 1
            Invoke-CompactionRun -CaptureDir $cap -GDriveDir $gd
            $log = Get-Content (Join-Path $cap 'compaction.log') -Raw
            $LASTEXITCODE | Should -BeGreaterThan 0
            $log | Should -Match 'recorded in manifest but ABSENT off-site'
        } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    }

    It 'wiring: the re-check block sits between the re-upload pass and the retention purge' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        $reup   = $text.IndexOf('re-upload pass')
        $chk    = $text.IndexOf('rotating off-site sha re-check')
        $purge  = $text.IndexOf('local retention purge')
        $reup  | Should -BeGreaterThan 0
        $chk   | Should -BeGreaterThan $reup
        $purge | Should -BeGreaterThan $chk
    }

    It 'wiring: the sha-deposit consult (Get-ShaManifestPath) exists at every site that needs it' {
        $text = Get-Content -LiteralPath $script:ScriptPath -Raw
        # 2 deposits (fresh + re-upload) + 2 readers (the nightly re-check, and the
        # #418 quarantine purge, which reuses the deposit record as its proof).
        @([regex]::Matches($text, 'Get-ShaManifestPath')).Count | Should -Be 4
    }
}
