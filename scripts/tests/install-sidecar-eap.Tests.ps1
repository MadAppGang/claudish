<#
    Pester source-level guard for the PS 5.1 native-stderr class in
    install-sidecar.ps1 (#569, follow-up to #549).

    WHY SOURCE-LEVEL (AST, NOT REGEX)
    ---------------------------------
    The installer imports no module and cannot be executed inside the suite
    (it would clone/compose/exit). #569's review measured that reverting
    #549's clone fix left the whole suite green — nothing pinned the class.
    The sibling behavioural pin (claudish-drain.Tests.ps1, #257) covers the
    drain script's own compose call, not the installer.

    THE CLASS
    ---------
    Under Windows PowerShell 5.1 with $ErrorActionPreference = 'Stop' (the
    installer's script-wide setting), a native command writing to stderr
    throws a terminating NativeCommandError EVEN WHEN stderr is redirected
    (2>&1 / 2>$null). The house motif (#549): lower EAP to 'Continue' in a
    local scope, judge by $LASTEXITCODE, restore in finally.

    WHAT THE GUARD ASSERTS
    ----------------------
    Every native command in install-sidecar.ps1 that redirects stderr must
    sit inside that motif:
      1. an `$ErrorActionPreference = 'Continue'` assignment textually before
         it in one of its enclosing statement-blocks (both placements used in
         the file: before the try, or inside the try body — the compose block);
      2. an enclosing try whose finally reassigns $ErrorActionPreference.

    "Native" = git/docker by name (the installer's two natives, floor keeps
    the guard PATH-independent) plus anything resolving to an Application on
    this host. Script functions (Die, Write-Step, Invoke-Probe) never
    qualify. The Write-Host STRING LITERAL containing "2>&1" near the end of
    the script is not a CommandAst and is naturally invisible to the guard.

    All sources and mutation needles are newline-normalized to LF before
    matching, so the tests hold on both CRLF and LF checkouts.

    Run:  bun run test:scripts        (pwsh 7)
          bun run test:scripts:win51  (Windows PowerShell 5.1 — the fleet's)
#>

BeforeAll {
    $script:InstallerPath = Join-Path $PSScriptRoot "..\install-sidecar.ps1"

    function ConvertTo-Lf {
        param([string]$Text)
        return $Text -replace "`r`n", "`n"
    }

    function Get-NativeCommandNames {
        $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        [void]$names.Add('git'); [void]$names.Add('docker')
        foreach ($n in @('bun', 'node', 'npm', 'python', 'curl', 'wget')) {
            $resolved = Get-Command -Name $n -ErrorAction Ignore
            if ($resolved -and $resolved.CommandType -in @('Application', 'ExternalScript')) {
                [void]$names.Add($n)
            }
        }
        return $names
    }

    function Test-RhsIsLiteralValue {
        # `$x = 'lit'` parses the RHS as a CommandExpressionAst WRAPPING the
        # constant (CommandExpressionAst is a statement, not an ExpressionAst) —
        # accept both the wrapped and the bare form.
        param(
            [System.Management.Automation.Language.Ast]$Rhs,
            [string]$Value
        )
        $expr = $Rhs
        if ($expr -is [System.Management.Automation.Language.CommandExpressionAst]) {
            $expr = $expr.Expression
        }
        return ($expr -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $expr.Value -eq $Value)
    }

    function Get-EapViolations {
        param(
            [string]$Source,
            [System.Collections.Generic.HashSet[string]]$NativeNames
        )
        $tokens = $null; $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput(
            $Source, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) {
            throw "source does not parse: $($parseErrors[0].Extent.StartLineNumber): $($parseErrors[0].Message)"
        }

        $violations = @()
        foreach ($cmd in $ast.FindAll({ param($a)
                    $a -is [System.Management.Automation.Language.CommandAst] }, $true)) {
            $name = $cmd.GetCommandName()
            if (-not $name -or -not $NativeNames.Contains($name)) { continue }
            $stderrRedirect = @($cmd.Redirections |
                Where-Object { $_.FromStream -eq 2 }).Count -gt 0
            if (-not $stderrRedirect) { continue }

            $cmdOffset = $cmd.Extent.StartOffset
            $sawContinue = $false
            $sawGuardedTry = $false

            # Rule 1: a 'Continue' assignment before the command in an ENCLOSING
            # statement-block (innermost walk — containment, not file order, is
            # what keeps a wrap in a sibling branch from satisfying this).
            $node = $cmd
            while ($null -ne $node -and -not $sawContinue) {
                $stmtList = $null
                if ($node -is [System.Management.Automation.Language.StatementBlockAst] -or
                    $node -is [System.Management.Automation.Language.NamedBlockAst]) {
                    $stmtList = $node
                }
                if ($null -ne $stmtList) {
                    foreach ($stmt in $stmtList.Statements) {
                        if ($stmt.Extent.StartOffset -ge $cmdOffset) { break }
                        if ($stmt -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                            $stmt.Left -is
                                [System.Management.Automation.Language.VariableExpressionAst] -and
                            $stmt.Left.VariablePath.UserPath -eq 'ErrorActionPreference' -and
                            (Test-RhsIsLiteralValue -Rhs $stmt.Right -Value 'Continue')) {
                            $sawContinue = $true; break
                        }
                    }
                }
                $node = $node.Parent
            }

            # Rule 2: an ancestor try whose finally reassigns EAP (the restore).
            $node = $cmd
            while ($null -ne $node -and -not $sawGuardedTry) {
                if ($node -is [System.Management.Automation.Language.TryStatementAst] -and
                    $null -ne $node.Finally) {
                    $restore = $node.Finally.FindAll({ param($a)
                        $a -is [System.Management.Automation.Language.AssignmentStatementAst] -and
                        $a.Left -is
                            [System.Management.Automation.Language.VariableExpressionAst] -and
                        $a.Left.VariablePath.UserPath -eq 'ErrorActionPreference' }, $true)
                    if (@($restore).Count -gt 0) { $sawGuardedTry = $true }
                }
                $node = $node.Parent
            }

            if (-not ($sawContinue -and $sawGuardedTry)) {
                $violations += [pscustomobject]@{
                    Line = $cmd.Extent.StartLineNumber
                    Name = $name
                    Rule = if (-not $sawContinue) { 'no Continue scope' }
                           elseif (-not $sawGuardedTry) { 'no finally restore' }
                           else { '?' }
                    Text = ($cmd.Extent.Text -replace '\s+', ' ')
                }
            }
        }
        return ,@($violations)
    }

    $script:NativeNames = Get-NativeCommandNames
    $script:Source = ConvertTo-Lf (Get-Content -Raw $script:InstallerPath)
}

Describe "install-sidecar EAP guard (#569)" {
    It "the shipped installer has zero unscoped native stderr redirects" {
        $v = Get-EapViolations -Source $script:Source -NativeNames $script:NativeNames
        $detail = (@($v) | ForEach-Object { "$($_.Line):$($_.Name) $($_.Rule)" }) -join '; '
        @($v).Count | Should -Be 0 -Because "unscoped stderr redirects: $detail"
    }

    It "the Write-Host string literal containing 2>&1 is not parsed as a command" {
        # The literal must EXIST in the source, or this pin is vacuous.
        $script:Source | Should -Match 'Verify relay mode in logs'
        # Zero violations while the literal is present proves it was never
        # counted (a string literal is not a CommandAst).
        $v = Get-EapViolations -Source $script:Source -NativeNames $script:NativeNames
        @($v).Count | Should -Be 0
    }

    It "positive control: a bare native 2>&1 under script-wide Stop IS reported" {
        $synthetic = @'
$ErrorActionPreference = 'Stop'
docker logs foo 2>&1 | Out-Host
'@
        $v = Get-EapViolations -Source (ConvertTo-Lf $synthetic) -NativeNames $script:NativeNames
        @($v).Count | Should -Be 1
        $v[0].Name | Should -Be 'docker'
        $v[0].Rule | Should -Be 'no Continue scope'
    }

    It "positive control: a Continue assignment without a finally restore IS reported" {
        $synthetic = @'
$ErrorActionPreference = 'Stop'
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
docker logs foo 2>&1 | Out-Host
'@
        $v = Get-EapViolations -Source (ConvertTo-Lf $synthetic) -NativeNames $script:NativeNames
        @($v).Count | Should -Be 1
        $v[0].Rule | Should -Be 'no finally restore'
    }

    Context "mutations: each removed wrap must go red (the #549 revert stayed green pre-guard)" {
        It "unwrapping #549's clone block is caught" {
            $needle = ConvertTo-Lf @'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        git clone --branch main --depth 1 $RepoUrl $RepoDir 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { Die "git clone failed" }
    } finally { $ErrorActionPreference = $prevEap }
'@
            $replacement = ConvertTo-Lf @'
    git clone --branch main --depth 1 $RepoUrl $RepoDir 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "git clone failed" }
'@
            $mutated = $script:Source.Replace($needle, $replacement)
            $mutated | Should -Not -Be $script:Source  # the mutation matched
            $v = Get-EapViolations -Source $mutated -NativeNames $script:NativeNames
            @($v | Where-Object Name -eq 'git').Count | Should -BeGreaterThan 0
        }

        It "unwrapping the update-path block (git status/log/fetch/checkout/reset) is caught" {
            # Two-step unwrap: strip the opening (comment + assignments + try),
            # then the closing finally — leaving parseable bare git calls.
            $opening = ConvertTo-Lf @'
    # Windows PowerShell 5.1 turns native stderr into a terminating error under
    # 'Stop' — git writes progress and failure detail on stderr (status/fetch/
    # checkout). Same motif as #549's clone block: local EAP scoping, judged by
    # exit code only.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $dirty = @(git -C $RepoDir status --porcelain)
'@
            $openingBare = ConvertTo-Lf @'
    $dirty = @(git -C $RepoDir status --porcelain)
'@
            $closing = ConvertTo-Lf @'
        if ($LASTEXITCODE -ne 0) { Die "git pull failed in $RepoDir" }
    } finally { $ErrorActionPreference = $prevEap }
'@
            $closingBare = ConvertTo-Lf @'
    if ($LASTEXITCODE -ne 0) { Die "git pull failed in $RepoDir" }
'@
            $mutated = $script:Source.Replace($opening, $openingBare).Replace($closing, $closingBare)
            $mutated | Should -Not -Be $script:Source  # the mutation matched
            $v = Get-EapViolations -Source $mutated -NativeNames $script:NativeNames
            @($v | Where-Object Name -eq 'git').Count | Should -BeGreaterThan 0
        }

        It "unwrapping the docker-inspect helper is caught" {
            $needle = ConvertTo-Lf @'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Container 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
    } finally { $ErrorActionPreference = $prevEap }
'@
            $replacement = ConvertTo-Lf @'
    $raw = docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Container 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
'@
            $mutated = $script:Source.Replace($needle, $replacement)
            $mutated | Should -Not -Be $script:Source
            $v = Get-EapViolations -Source $mutated -NativeNames $script:NativeNames
            @($v | Where-Object Name -eq 'docker').Count | Should -BeGreaterThan 0
        }

        It "unwrapping the mode-assertion docker logs call is caught" {
            $needle = ConvertTo-Lf @'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $servedLocally = (docker logs --since 90s $ContainerName 2>&1 | Select-String -SimpleMatch "[Request]")
    } finally { $ErrorActionPreference = $prevEap }
'@
            $replacement = ConvertTo-Lf @'
    $servedLocally = (docker logs --since 90s $ContainerName 2>&1 | Select-String -SimpleMatch "[Request]")
'@
            $mutated = $script:Source.Replace($needle, $replacement)
            $mutated | Should -Not -Be $script:Source
            $v = Get-EapViolations -Source $mutated -NativeNames $script:NativeNames
            @($v | Where-Object Name -eq 'docker').Count | Should -BeGreaterThan 0
        }

        It "unwrapping #549's compose block is caught" {
            $needle = ConvertTo-Lf @'
$prevEap = $ErrorActionPreference
try {
    # Windows PowerShell 5.1 turns native stderr into a terminating error under
    # 'Stop' — docker compose prints build progress on stderr, so judge by exit code.
    $ErrorActionPreference = 'Continue'
    docker compose up -d --build 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { Die "docker compose up failed" }
} finally { $ErrorActionPreference = $prevEap; Pop-Location }
'@
            $replacement = ConvertTo-Lf @'
docker compose up -d --build 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Die "docker compose up failed" }
Pop-Location
'@
            $mutated = $script:Source.Replace($needle, $replacement)
            $mutated | Should -Not -Be $script:Source
            $v = Get-EapViolations -Source $mutated -NativeNames $script:NativeNames
            @($v | Where-Object Name -eq 'docker').Count | Should -BeGreaterThan 0
        }
    }
}
