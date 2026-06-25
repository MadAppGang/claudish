# CaptureUtils.psm1 — Shared functions for claudish traffic analysis scripts

$ErrorActionPreference = 'Stop'

# Default capture directory (override with -Dir parameter)
$script:DefaultCaptureDir = 'D:\claudish-captures'

# 7-Zip path (same as compress-captures.ps1)
$script:SevenZip = 'D:\Apps\PortableApps\7-ZipPortable\App\7-Zip64\7z.exe'

function Get-CaptureRequests {
    <#
    .SYNOPSIS
    Enumerate and parse req-*.json capture files.
    #>
    [CmdletBinding()]
    param(
        [string]$Dir = $script:DefaultCaptureDir,
        [int]$Hours = 2,
        [switch]$All
    )

    $cutoff = if ($All) { [datetime]::MinValue } else { (Get-Date).AddHours(-$Hours) }

    Get-ChildItem (Join-Path $Dir 'req-*.json') -File |
        Where-Object { $All -or $_.LastWriteTime -gt $cutoff } |
        ForEach-Object {
            try {
                $raw = Get-Content $_.FullName -Raw -Encoding UTF8
                $j = $raw | ConvertFrom-Json -ErrorAction Stop

                # Extract metadata from body
                $workspace = Get-WorkspaceFromSystem $j.body.system
                $sessionInfo = Get-SessionIdFromMetadata $j.body.metadata
                $ccInfo = Get-CCVersionFromSystem $j.body.system
                $msgCount = if ($j.body.messages) { @($j.body.messages).Count } else { 0 }
                $toolCount = if ($j.body.tools) { @($j.body.tools).Count } else { 0 }

                # Extract filename counter for resp correlation
                $counter = if ($_.Name -match 'req-\d+-(\d+)-') { [int]$Matches[1] } else { 0 }

                [PSCustomObject]@{
                    File       = $_.Name
                    Timestamp  = $j.ts
                    Model      = if ($j.model) { $j.model } else { '(none)' }
                    Machine    = if ($j.machine) { $j.machine } else { '(unknown)' }
                    Workspace  = $workspace
                    SessionId  = $sessionInfo.SessionId
                    DeviceId   = $sessionInfo.DeviceId
                    AccountId  = $sessionInfo.AccountId
                    CCVersion  = $ccInfo.Version
                    Entrypoint = $ccInfo.Entrypoint
                    MsgCount   = $msgCount
                    ToolCount  = $toolCount
                    MaxTokens  = $j.body.max_tokens
                    Counter    = $counter
                    Size       = $_.Length
                    FileTime   = $_.LastWriteTime
                }
            } catch {
                # Skip unparseable files silently
            }
        }
}

function Get-WorkspaceFromSystem {
    <#
    .SYNOPSIS
    Extract the workspace path from the system prompt blocks.
    Looks for "Primary working directory:" in system[2].text.
    #>
    [CmdletBinding()]
    param($System)

    if (-not $System) { return '(no system)' }

    foreach ($block in $System) {
        if ($block.text -match 'Primary working directory:\s*(.+?)[\r\n]') {
            return $Matches[1].Trim()
        }
    }
    return '(no workspace)'
}

function Get-SessionIdFromMetadata {
    <#
    .SYNOPSIS
    Extract session_id, device_id, and account_uuid from metadata.user_id.
    Handles both formats:
      - JSON: {"device_id":"...","account_uuid":"...","session_id":"..."}
      - Flat: user_<hash>_account_<uuid>_session_<uuid>
    #>
    [CmdletBinding()]
    param($Metadata)

    $result = @{ SessionId = ''; DeviceId = ''; AccountId = '' }
    if (-not $Metadata -or -not $Metadata.user_id) { return $result }

    $uid = $Metadata.user_id

    # Try JSON format first
    try {
        $parsed = $uid | ConvertFrom-Json -ErrorAction Stop
        $result.SessionId = $parsed.session_id ?? ''
        $result.DeviceId = $parsed.device_id ?? ''
        $result.AccountId = $parsed.account_uuid ?? ''
        return $result
    } catch {
        # Not JSON, try flat format
    }

    # Flat format: user_<hash>_account_<uuid>_session_<uuid>
    if ($uid -match '_session_([0-9a-f-]+)') {
        $result.SessionId = $Matches[1]
    }
    if ($uid -match '_account_([0-9a-f-]+)') {
        $result.AccountId = $Matches[1]
    }

    return $result
}

function Get-CCVersionFromSystem {
    <#
    .SYNOPSIS
    Extract Claude Code version and entrypoint from system[0] billing header.
    #>
    [CmdletBinding()]
    param($System)

    $result = @{ Version = ''; Entrypoint = '' }
    if (-not $System -or $System.Count -eq 0) { return $result }

    $text = $System[0].text ?? $System[0] ?? ''

    if ($text -match 'cc_version=([^;\s]+)') {
        $result.Version = $Matches[1]
    }
    if ($text -match 'cc_entrypoint=([^;\s]+)') {
        $result.Entrypoint = $Matches[1]
    }

    return $result
}

function Get-ResponseForRequest {
    <#
    .SYNOPSIS
    Find the resp-*.sse file matching a request counter and extract token usage.
    #>
    [CmdletBinding()]
    param(
        [int]$Counter,
        [string]$Dir = $script:DefaultCaptureDir
    )

    $pattern = "resp-*-r$($Counter.ToString('0000'))-*.sse"
    $respFile = Get-ChildItem (Join-Path $Dir $pattern) -File | Select-Object -First 1

    if (-not $respFile) { return $null }

    # Parse header lines for stop_reason and elapsed_ms
    $header = Get-Content $respFile.FullName -TotalCount 10 -ErrorAction SilentlyContinue
    $result = @{ StopReason = ''; ElapsedMs = 0; InputTokens = 0; OutputTokens = 0 }

    foreach ($line in $header) {
        if ($line -match 'stop_reason["\s:]+(\w+)') { $result.StopReason = $Matches[1] }
        if ($line -match 'elapsed_ms=(\d+)') { $result.ElapsedMs = [int]$Matches[1] }
    }

    # Parse SSE data for token usage (last message_delta with usage)
    $content = Get-Content $respFile.FullName -Raw -ErrorAction SilentlyContinue
    $lastUsage = [regex]::Matches($content, '"usage":\{[^}]*"input_tokens":(\d+)[^}]*"output_tokens":(\d+)')
    if ($lastUsage.Count -gt 0) {
        $m = $lastUsage[$lastUsage.Count - 1]
        $result.InputTokens = [int]$m.Groups[1].Value
        $result.OutputTokens = [int]$m.Groups[2].Value
    }

    return $result
}

function Get-ArchivedDays {
    <#
    .SYNOPSIS
    List available archive dates in the archive directory.
    #>
    [CmdletBinding()]
    param([string]$Dir = $script:DefaultCaptureDir)

    $archiveDir = Join-Path $Dir 'archive'
    if (-not (Test-Path $archiveDir)) { return @() }

    Get-ChildItem (Join-Path $archiveDir 'captures-*.7z') -File |
        ForEach-Object {
            if ($_.Name -match 'captures-(\d{4}-\d{2}-\d{2})') {
                [PSCustomObject]@{
                    Date = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd', $null)
                    File = $_.FullName
                    Size = $_.Length
                }
            }
        } | Sort-Object Date
}

function Expand-ArchiveDay {
    <#
    .SYNOPSIS
    Extract a 7z archive to a temp directory and return the path.
    Caller is responsible for cleanup.
    #>
    [CmdletBinding()]
    param([string]$ArchivePath)

    if (-not (Test-Path $script:SevenZip)) {
        Write-Error "7-Zip not found at: $script:SevenZip"
        return $null
    }

    $tempDir = Join-Path $env:TEMP "claudish-archive-$(Get-Random)"
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    & $script:SevenZip x $ArchivePath "-o$tempDir" -y -bso0 -bsp0 2>$null | Out-Null

    if (Test-Path (Join-Path $tempDir 'req-*.json')) {
        return $tempDir
    }

    # Check for subdirectory (7z might extract into a folder)
    $subDir = Get-ChildItem $tempDir -Directory | Select-Object -First 1
    if ($subDir -and (Test-Path (Join-Path $subDir.FullName 'req-*.json'))) {
        return $subDir.FullName
    }

    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    return $null
}

# Device ID → machine name mapping (fallback for header-less requests).
# Primary attribution is the X-Claudish-Machine header; this map only fires
# when a request arrives WITHOUT that header. As of 2026-06, all interactive
# machines (po-2023, po-2025, po-2026, ai-01) send the header, so the only
# header-less source is ai-01's scheduled cron agents (mapped below). Add
# entries here only when a NEW machine is seen without the header — extract
# its device_id from metadata.user_id in a capture.
$script:DeviceMap = @{
    'a13baee2e6c8cc200e25ace229c9937ccbe20e7b66f4cda3f9dc0fc22e3650ae' = 'myia-po-2023'
    'b5909fd92642d80ee243e7c7377df756e4d09b683bfc45d625de53307df093c7' = 'myia-ai-01'
}

function Resolve-MachineFromDevice {
    <#
    .SYNOPSIS
    Resolve a machine name from device_id when the machine header is empty.
    #>
    [CmdletBinding()]
    param([string]$DeviceId)

    if ($script:DeviceMap.ContainsKey($DeviceId)) {
        return $script:DeviceMap[$DeviceId]
    }
    return "device:$($DeviceId.Substring(0,8))"
}

Export-ModuleMember -Function Get-CaptureRequests, Get-WorkspaceFromSystem, Get-SessionIdFromMetadata,
    Get-CCVersionFromSystem, Get-ResponseForRequest, Get-ArchivedDays, Expand-ArchiveDay, Resolve-MachineFromDevice
