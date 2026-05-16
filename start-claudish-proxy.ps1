# Claudish Proxy - Windows Service Wrapper
# Run via Scheduled Task at system startup
# Logs to ~/.claudish/logs/proxy-*.log

$ErrorActionPreference = "Stop"
$LogFile = "$env:USERPROFILE\.claudish\logs\proxy-$(Get-Date -Format 'yyyy-MM-dd').log"
$LogDir = Split-Path $LogFile -Parent

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts  $Message" | Add-Content -Path $LogFile -Encoding utf8NoBOM
}

Write-Log "Claudish proxy service starting..."
Write-Log "Working dir: $PSScriptRoot"
Write-Log "Bun path: $(Get-Command bun -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"

Set-Location $PSScriptRoot

# Kill any existing proxy on port 3000
$existing = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($existing) {
    Write-Log "Killing existing process(es) on port 3000: $($existing -join ', ')"
    $existing | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

# Start the proxy
Write-Log "Starting: bun packages/cli/src/fork/server/standalone-proxy.ts --port 3000"
bun packages/cli/src/fork/server/standalone-proxy.ts --port 3000 2>&1 | ForEach-Object {
    Write-Log $_
}
Write-Log "Claudish proxy exited."
