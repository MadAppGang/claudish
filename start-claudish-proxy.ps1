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

# Start the proxy.
# Bind to 127.0.0.1 (loopback) — this proxy holds CLAUDISH_PROXY_KEY at runtime
# and relays to the hub. Binding to all interfaces (the default when --host is
# omitted) would expose the cluster proxy key to the LAN and beyond, and is the
# shape that triggers the Windows firewall prompt for bun.exe. Override with
# $env:CLAUDISH_HOST if a LAN bind is explicitly intended (rare; the sidecar
# role is the supported way to expose the proxy on the network, via the Docker
# container on its own port).
$proxyHost = if ($env:CLAUDISH_HOST) { $env:CLAUDISH_HOST } else { "127.0.0.1" }
Write-Log "Starting: bun packages/cli/src/fork/server/standalone-proxy.ts --port 3000 --host $proxyHost"
bun packages/cli/src/fork/server/standalone-proxy.ts --port 3000 --host $proxyHost 2>&1 | ForEach-Object {
    Write-Log $_
}
Write-Log "Claudish proxy exited."
