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

                # Extract metadata from body. The environment block ("Primary working
                # directory") is NOT in body.system — measured 2026-09-08 over the hub
                # corpus: body.system holds only the billing header, the identity line and
                # the system prompt. It lives in the env updates carried by body.messages.
                $workspace = Get-WorkspaceFromBody $j.body
                $sessionInfo = Get-SessionIdFromMetadata $j.body.metadata
                $ccInfo = Get-CCVersionFromSystem $j.body.system
                $msgCount = if ($j.body.messages) { @($j.body.messages).Count } else { 0 }
                $toolCount = if ($j.body.tools) { @($j.body.tools).Count } else { 0 }

                # The filename carries pid, counter AND request time:
                #   req-{pid}-{counter}-{ts}-{src}.json
                # All three are needed to pair a response. The counter alone is ambiguous
                # because it restarts with the proxy — 5001 counters were reused within the
                # single day of 2026-09-08. See Get-ResponseForRequest.
                $procId = 0; $counter = 0; $reqTime = $null
                if ($_.Name -match '^req-(\d+)-(\d+)-(.+Z)-') {
                    $procId  = [int]$Matches[1]
                    $counter = [int]$Matches[2]
                    try {
                        $reqTime = [datetime]::ParseExact($Matches[3], 'yyyy-MM-ddTHH-mm-ss-fffZ',
                                                          $null, 'AssumeUniversal,AdjustToUniversal')
                    } catch { $reqTime = $null }
                }

                [PSCustomObject]@{
                    File       = $_.Name
                    Timestamp  = $j.ts
                    Model      = if ($j.model) { $j.model } else { '(none)' }
                    # Attribution precedence: X-Claudish-Machine header (persisted in
                    # the capture body since 2026-07) -> device_id fingerprint fallback
                    # (header-less captures: cron agents, pre-2026-07 archives) -> unknown.
                    Machine    = if ($j.machine) { $j.machine }
                                 elseif ($sessionInfo.DeviceId) { Resolve-MachineFromDevice $sessionInfo.DeviceId }
                                 else { '(unknown)' }
                    Workspace  = $workspace
                    SessionId  = $sessionInfo.SessionId
                    DeviceId   = $sessionInfo.DeviceId
                    AccountId  = $sessionInfo.AccountId
                    CCVersion  = $ccInfo.Version
                    Entrypoint = $ccInfo.Entrypoint
                    IsSubagent = $ccInfo.IsSubagent
                    MsgCount   = $msgCount
                    ToolCount  = $toolCount
                    MaxTokens  = $j.body.max_tokens
                    Counter    = $counter
                    ProcId     = $procId
                    ReqTime    = $reqTime
                    Size       = $_.Length
                    FileTime   = $_.LastWriteTime
                }
            } catch {
                # Skip unparseable files silently
            }
        }
}

function Get-WorkspaceFromBody {
    <#
    .SYNOPSIS
    Extract the CURRENT workspace path of the session that issued a request.

    .DESCRIPTION
    The environment block ("Primary working directory: <path>") is NOT in body.system.
    Measured 2026-09-08 over the hub corpus: body.system carries exactly three blocks —
    the x-anthropic-billing-header, the one-line identity, and the system prompt — and
    none of them ever contains the path. It is injected as an environment UPDATE inside
    body.messages, either as an inline `role: "system"` message or copied into a
    tool_result. Scanning body.system therefore always returned '(no workspace)'.

    Environment updates are chronological, so the LAST one is the current cwd; earlier
    ones are the same path in different case ("D:\x" then "d:\x (was D:\x)").

    ⚠ The corpus contains transcripts that QUOTE other sessions' environment blocks, so a
    raw text search over the file is worthless as a discriminator: on 2026-09-08 the string
    "Argumentum" appeared in 8986 of 9921 requests from three machines, while only 321 had
    it as their actual workspace. Anchoring on message structure — and taking the last
    update — is what separates the session's own cwd from prose that mentions a path.
    #>
    [CmdletBinding()]
    param($Body)

    if (-not $Body) { return '(no body)' }

    $last = $null
    foreach ($m in @($Body.messages)) {
        foreach ($blk in @($m.content)) {
            $text = if ($blk -is [string]) { $blk }
                    elseif ($blk.type -eq 'text') { $blk.text }
                    elseif ($blk.type -eq 'tool_result') { "$($blk.content)" }
                    else { '' }
            if (-not $text) { continue }
            foreach ($hit in [regex]::Matches("$text", 'Primary working directory:\s*([^\r\n]+)')) {
                # "D:\x (was d:\x)" -> "D:\x": keep the current cwd, drop the previous one.
                $last = ($hit.Groups[1].Value -replace '\s*\(was\s.*$', '').Trim()
            }
        }
    }
    if ($last) { return $last }

    # Fallback for capture shapes that predate the inline env update.
    $fromSystem = Get-WorkspaceFromSystem $Body.system
    if ($fromSystem -notmatch '^\(') { return $fromSystem }
    return '(no workspace)'
}

function Get-WorkspaceFromSystem {
    <#
    .SYNOPSIS
    Scan the system prompt blocks for a workspace path. Kept for API compatibility.

    .DESCRIPTION
    ⚠ On current captures this ALWAYS returns '(not in system)': the environment block
    does not live in body.system. Use Get-WorkspaceFromBody instead. The marker is
    deliberately distinct from '(no workspace)' so a caller can tell "looked in the wrong
    place" apart from "looked in the right place and found nothing" — a silent empty
    string is what made this defect invisible for so long.
    #>
    [CmdletBinding()]
    param($System)

    if (-not $System) { return '(no system)' }

    foreach ($block in $System) {
        $text = if ($block -is [string]) { $block } else { $block.text }
        if ("$text" -match 'Primary working directory:\s*([^\r\n]+)') {
            return ($Matches[1] -replace '\s*\(was\s.*$', '').Trim()
        }
    }
    return '(not in system)'
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
    Extract Claude Code version, entrypoint, and sub-agent flag from system[0]
    billing header.

    IsSubagent distinguishes the DANGEROUS leak (a rogue Opus sub-agent spawned by
    the Agent tool, cc_is_subagent=true) from a benign interactive user session
    (cc_is_subagent absent). This is THE distinction the leak policy hinges on —
    see the leak-policy-binary-by-machine + sub-agent-opus-leak memories.
    #>
    [CmdletBinding()]
    param($System)

    $result = @{ Version = ''; Entrypoint = ''; IsSubagent = $false }
    if (-not $System -or $System.Count -eq 0) { return $result }

    $text = $System[0].text ?? $System[0] ?? ''

    if ($text -match 'cc_version=([^;\s]+)') {
        $result.Version = $Matches[1]
    }
    if ($text -match 'cc_entrypoint=([^;\s]+)') {
        $result.Entrypoint = $Matches[1]
    }
    if ($text -match 'cc_is_subagent=true') {
        $result.IsSubagent = $true
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
        [Parameter(Mandatory)][int]$Counter,
        [Parameter(Mandatory)][int]$ProcId,
        [Parameter(Mandatory)][datetime]$RequestTime,
        [string]$Dir = $script:DefaultCaptureDir,
        [int]$WindowSec = 180
    )

    # Pair on (pid, counter) AND a bounded delay. The rNNNN counter restarts with the
    # proxy, so (pid, counter) alone has several candidates spread across the day —
    # 5001 counters were reused within 2026-09-08 alone. The previous implementation
    # filtered on the counter only and took `Select-Object -First 1`; Get-ChildItem
    # yields alphabetical order, so that picked the OLDEST occurrence of the day,
    # frequently one written BEFORE the request. Measured consequence on 2026-09-08:
    # req-1-1819 (03:37:55Z) was credited a deepseek response captured at 08:34 — a
    # backend it never touched — while its real state (no response at all) was masked.
    #
    # The window is measured, not guessed: over 16629 pairable responses that day the
    # delay was p50 9.4s / p95 49.1s / p99 106.3s, and 180s covers 99.7% of them.
    # Widening to 300s recovers exactly one more.
    $pattern = "resp-$ProcId-r$($Counter.ToString('0000'))-*"
    $reqUtc = $RequestTime.ToUniversalTime()

    $respFile = Get-ChildItem (Join-Path $Dir $pattern) -File |
        ForEach-Object {
            if ($_.Name -notmatch '^resp-\d+-r\d+-(.+Z)-.+\.(sse|json)$') { return }
            try {
                $ts = [datetime]::ParseExact($Matches[1], 'yyyy-MM-ddTHH-mm-ss-fffZ',
                                             $null, 'AssumeUniversal,AdjustToUniversal')
            } catch { return }
            $lag = ($ts - $reqUtc).TotalSeconds
            if ($lag -lt -2 -or $lag -gt $WindowSec) { return }
            [PSCustomObject]@{ File = $_; Ts = $ts }
        } |
        Sort-Object Ts | Select-Object -First 1 -ExpandProperty File

    # No candidate inside the window is a RESULT — the request went unanswered, or was
    # served by a path that writes no capture (Codex/Gemini/Ollama: only native-handler,
    # anthropic-sse and openai-sse call createResponseCapture). It is never a licence to
    # relax the window until something matches.
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

function Get-OutageArchives {
    <#
    .SYNOPSIS
    List outage-reconciliation archives (outage-<machine>-<start>_<end>.7z).

    .DESCRIPTION
    Sidecar machines capture locally ONLY during a hub outage (in nominal relay
    mode the forward bypasses capture). reconcile-outage-captures.ps1 packs those
    outage-window captures into outage-<machine>-<start>_<end>.7z and drops them in
    a reconcile/ subfolder for the hub to merge. This enumerator parses those names.

    The machine group is non-greedy so machine names that contain dashes
    (myia-po-2024) are parsed correctly — it stops at the first position where the
    remainder matches -<start>_<end>.7z. Does NOT collide with the daily
    captures-YYYY-MM-DD.7z archives (different prefix).
    #>
    [CmdletBinding()]
    param([string]$Dir = $script:DefaultCaptureDir)

    if (-not (Test-Path -LiteralPath $Dir)) { return @() }

    $rx = '^outage-(?<machine>.+?)-(?<start>\d{8}T\d{6})_(?<end>\d{8}T\d{6})\.7z$'
    Get-ChildItem (Join-Path $Dir 'outage-*.7z') -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Name -match $rx) {
                [PSCustomObject]@{
                    Machine = $Matches['machine']
                    Start   = [datetime]::ParseExact($Matches['start'], 'yyyyMMddTHHmmss', $null)
                    End     = [datetime]::ParseExact($Matches['end'],   'yyyyMMddTHHmmss', $null)
                    File    = $_.FullName
                    Size    = $_.Length
                }
            }
        } | Sort-Object Start
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

Export-ModuleMember -Function Get-CaptureRequests, Get-WorkspaceFromBody, Get-WorkspaceFromSystem, Get-SessionIdFromMetadata,
    Get-CCVersionFromSystem, Get-ResponseForRequest, Get-ArchivedDays, Get-OutageArchives, Expand-ArchiveDay, Resolve-MachineFromDevice
