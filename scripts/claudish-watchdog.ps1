# Claudish Watchdog — detects tool-call stream hangs and auto-restarts
#
# The proxy hangs on tool_call paths (WebSearch, GLM tool_use), not simple text.
# This watchdog tests the EXACT code path that degrades:
#   1. A streaming request WITH tools defined (triggers tool_use in the model)
#   2. Checks that the stream completes within timeout
#   3. Also checks container uptime — proactive restart at 11h before degradation
#
# Install (run as admin):
#   schtasks /create /tn "ClaudishWatchdog" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Dev\claudish\scripts\claudish-watchdog.ps1" /sc minute /mo 15 /ru SYSTEM /rl HIGHEST /f
#
# Logs to: C:\Users\jsboi\.claudish\watchdog.log

$ErrorActionPreference = "Stop"
$LogPath = "$env:USERPROFILE\.claudish\watchdog.log"
$ProxyUrl = "http://localhost:3000"
$ContainerName = "claudish-proxy"
$StreamTimeoutSec = 90
$ProactiveRestartHours = 11

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Host $line
}

function Test-ProxyWithTools {
    param([string]$Url, [int]$TimeoutSec)

    # This payload mimics a real Claude Code request WITH tools.
    # GLM will respond with tool_use or text — either way the stream must complete.
    # This exercises the exact code path (openai-sse tool_call handling) that hangs.
    $body = @{
        model = "glm-5.2"
        max_tokens = 100
        stream = $true
        tools = @(
            @{
                name = "Bash"
                description = "Run a bash command"
                input_schema = @{
                    type = "object"
                    properties = @{
                        command = @{ type = "string"; description = "The command" }
                    }
                    required = @("command")
                }
            },
            @{
                name = "Read"
                description = "Read a file"
                input_schema = @{
                    type = "object"
                    properties = @{
                        file_path = @{ type = "string"; description = "Path" }
                    }
                    required = @("file_path")
                }
            }
        )
        messages = @(
            @{
                role = "user"
                content = "List the current directory using Bash. Do it now."
            }
        )
    } | ConvertTo-Json -Depth 10

    try {
        $response = Invoke-WebRequest -Uri "$Url/v1/messages" `
            -Method POST `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec $TimeoutSec `
            -UseBasicParsing

        $content = $response.Content

        # Stream must contain a terminal event
        if ($content -match "message_stop") {
            $hasToolUse = $content -match "tool_use"
            $type = if ($hasToolUse) { "tool_use+end" } else { "text+end" }
            return @{ Ok = $true; Detail = "stream OK ($type, $($content.Length) bytes)" }
        } elseif ($content.Length -gt 100) {
            # Got data but no message_stop — suspicious but not fatal
            return @{ Ok = $false; Detail = "stream incomplete ($($content.Length) bytes, no message_stop)" }
        } elseif ($content.Length -gt 0) {
            return @{ Ok = $false; Detail = "short response ($($content.Length) bytes): $($content.Substring(0, [Math]::Min(200, $content.Length)))" }
        } else {
            return @{ Ok = $false; Detail = "EMPTY response — stream hung" }
        }
    }
    catch [System.Net.WebException] {
        return @{ Ok = $false; Detail = "HTTP error: $($_.Exception.Message)" }
    }
    catch {
        $msg = $_.Exception.Message
        if ($msg -match "timed? ?out" -or $msg -match "timeout") {
            return @{ Ok = $false; Detail = "TIMEOUT after ${TimeoutSec}s — stream hung" }
        }
        return @{ Ok = $false; Detail = "error: $msg" }
    }
}

# --- Main ---

Write-Log "=== Watchdog check ==="

# Step 1: Container running?
$containerStatus = docker inspect $ContainerName --format "{{.State.Status}}" 2>$null
if ($LASTEXITCODE -ne 0 -or $containerStatus -ne "running") {
    Write-Log "CRITICAL: Container not running (status=$containerStatus). Starting..."
    docker start $ContainerName 2>$null
    Start-Sleep -Seconds 15
    $recheck = docker inspect $ContainerName --format "{{.State.Status}}" 2>$null
    if ($recheck -eq "running") {
        Write-Log "RECOVERED: Container started"
    } else {
        Write-Log "FATAL: Container won't start (status=$recheck)"
        exit 1
    }
    exit 0
}

# Step 2: Uptime check
$startedAt = docker inspect $ContainerName --format "{{.State.StartedAt}}" 2>$null
$startTime = [DateTimeOffset]::Parse($startedAt)
$uptime = [DateTimeOffset]::UtcNow - $startTime
$uptimeHours = [Math]::Round($uptime.TotalHours, 1)

# Step 3: Proactive restart if uptime > threshold (prevent degradation BEFORE it happens)
if ($uptimeHours -ge $ProactiveRestartHours) {
    Write-Log "PROACTIVE: Uptime ${uptimeHours}h >= ${ProactiveRestartHours}h. Restarting to prevent degradation..."
    docker restart $ContainerName 2>$null
    Start-Sleep -Seconds 20
    $result = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec 60
    Write-Log "After proactive restart: $($result.Detail)"
    exit $(if ($result.Ok) { 0 } else { 1 })
}

# Step 4: Real tool-call streaming test
$result = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec $StreamTimeoutSec

if ($result.Ok) {
    Write-Log "OK (uptime=${uptimeHours}h). $($result.Detail)"
} else {
    Write-Log "FAIL (uptime=${uptimeHours}h): $($result.Detail)"
    Write-Log "ACTION: Restarting container..."
    docker restart $ContainerName 2>$null
    Start-Sleep -Seconds 20

    # Verify recovery
    $result2 = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec 60
    if ($result2.Ok) {
        Write-Log "RECOVERED: $($result2.Detail)"
    } else {
        Write-Log "CRITICAL: Still broken after restart: $($result2.Detail)"
        exit 1
    }
}
