# Guard for #519: a .ps1/.psm1 under scripts/ that contains non-ASCII bytes
# MUST carry a UTF-8 BOM. Windows PowerShell 5.1 reads no-BOM files as the
# system ANSI codepage; on CP1252 seats a non-ASCII byte like 0x94 (from an
# em-dash) decodes to a typographic quote that TERMINATES the string and
# breaks the whole module parse (measured 2026-10-18: 416 test failures,
# exit 0). Pure ASCII files are exempt -- the BOM is only load-bearing when
# there is something to decode. This file itself is pure ASCII on purpose.
Describe 'Encoding guard (#519)' {
    It 'every non-ASCII .ps1/.psm1 under scripts/ carries a UTF-8 BOM' {
        $repoRoot = Split-Path -Parent $PSScriptRoot   # scripts/tests -> scripts
        $scriptDir = Split-Path -Parent $repoRoot      # scripts -> repo root
        $offenders = @()
        Get-ChildItem (Join-Path $scriptDir 'scripts') -Recurse -Include *.ps1, *.psm1 -File | ForEach-Object {
            $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
            $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
            $hasNonAscii = $false
            foreach ($b in $bytes) {
                if ($b -gt 0x7F) { $hasNonAscii = $true; break }
            }
            if ($hasNonAscii -and -not $hasBom) {
                $offenders += $_.FullName.Substring($scriptDir.Length + 1)
            }
        }
        $offenders | Should -Be @()
    }
}
