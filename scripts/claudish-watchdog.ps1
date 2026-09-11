# Claudish Watchdog — detects tool-call stream hangs and auto-restarts
#
# The proxy hangs on tool_call paths (WebSearch, GLM tool_use), not simple text.
# This watchdog tests the EXACT code path that degrades:
#   1. A streaming request WITH tools defined (triggers tool_use in the model)
#   2. Checks that the stream completes within timeout
#   3. Also checks container uptime — proactive restart at 11h before degradation
#
# Every ambiguous stop logs one DIAG[...] line (Write-DiagLine): is the published
# port actually bound, and does the host have commit headroom. The 02/09 outage
# (host commit exhaustion — nothing listened on :3000, docker.exe would not
# launch) had to be reconstructed from the Windows event log after the fact;
# those two facts now self-classify the incident as it happens.
#
# Install (run as admin):
#   schtasks /create /tn "ClaudishWatchdog" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Dev\claudish\scripts\claudish-watchdog.ps1" /sc minute /mo 15 /ru SYSTEM /rl HIGHEST /f
#
# On a machine whose operator is not `jsboi`, append the home to that -File
# argument:  -File D:\Dev\claudish\scripts\claudish-watchdog.ps1 -ClaudishHome C:\Users\<op>\.claudish
#
# Logs to: <ClaudishHome>\watchdog.log

param(
    # Root of the .claudish directory this watchdog logs and checkpoints into.
    #
    # It cannot be derived at runtime: the scheduled task runs as SYSTEM, whose
    # $env:USERPROFILE is the system profile, where no .claudish exists. So the
    # install line passes it, and the default is the hub operator's home — which
    # leaves every existing install byte-identical.
    [string]$ClaudishHome = "C:\Users\jsboi\.claudish"
)

$ErrorActionPreference = "Stop"

# Fail loudly rather than log nowhere. With $ErrorActionPreference = "Stop" an
# unwritable log path kills this script at its first Add-Content, before it can
# say why — which on a scheduled task is indistinguishable from "the
# watchdog is fine and quiet". This one line is the difference between a
# diagnosable install and a silent one.
if (-not (Test-Path $ClaudishHome)) {
    throw "ClaudishHome '$ClaudishHome' does not exist. Pass -ClaudishHome <path> in the scheduled-task command line."
}

$LogPath = "$ClaudishHome\watchdog.log"
$ProxyUrl = "http://localhost:3000"
$ContainerName = "claudish-proxy"
$StreamTimeoutSec = 90
# Every docker CLI call is bounded by this. Unbounded was the real failure on
# 2026-09-02 (see Invoke-DockerBounded).
$DockerTimeoutSec = 20
$ProactiveRestartHours = 11
# A restart kills every in-flight SSE stream mid-body; the client reports
# "Connection lost mid-response" and the agent turn is lost. So: drain first,
# never restart for a cause a restart cannot fix, and confirm before acting.
# Two budgets, because the two restarts are not the same situation. A proactive
# restart is elective: it can afford to hunt for a quiet moment. A hang recovery
# is not — the proxy is already serving nobody, so waiting only extends the
# outage.
$DrainMaxWaitProactiveSec = 300
$DrainMaxWaitHangSec = 120
$StateFile = "$ClaudishHome\watchdog-state.json"
$QuietHourStart = 3             # local hour; proactive restarts only in [start,end)
$QuietHourEnd = 6

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

    # The hub authenticates /v1/messages with the cluster proxy key. Read it at
    # runtime from the deployment .env — never hardcode it here (the script is
    # committed). Absolute path: the scheduled task runs as SYSTEM, where
    # $env:USERPROFILE points at the wrong profile.
    $proxyKey = $null
    try {
        $envLine = Select-String -Path "D:\Dev\claudish\.env" -Pattern '^\s*CLAUDISH_PROXY_KEY\s*=\s*(.+)\s*$' | Select-Object -First 1
        if ($envLine) { $proxyKey = $envLine.Matches[0].Groups[1].Value.Trim('"', "'") }
    } catch {}
    $headers = @{}
    if ($proxyKey) { $headers["x-proxy-key"] = $proxyKey }

    # Wall-clock bound — and why this is NOT `Invoke-WebRequest -TimeoutSec`.
    # That parameter bounds only *establishing* the response; it does not bound
    # reading a streaming body. The proxy sends headers immediately and then
    # streams, so against a wedged pipeline the cmdlet blocks in the body read
    # with no timer running at all. On 2026-09-02 that is exactly what happened:
    # ten consecutive 15-minute probes entered here and none ever returned, so
    # the HANG SIGNAL 1/2 -> HANG CONFIRMED 2/2 -> restart path was never reached
    # during a 2h27 fleet-wide outage. A watchdog that cannot conclude is not a
    # watchdog.
    #
    # HttpClient.Timeout covers the whole operation, content read included
    # (SendAsync defaults to HttpCompletionOption.ResponseContentRead), and the
    # hard Wait() ceiling below guarantees this function returns even if that
    # timer itself fails to fire.
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $client = $null
    try {
        $client = [System.Net.Http.HttpClient]::new()
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)

        $req = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Post, "$Url/v1/messages")
        $req.Content = [System.Net.Http.StringContent]::new(
            $body, [System.Text.Encoding]::UTF8, "application/json")
        foreach ($k in $headers.Keys) {
            [void]$req.Headers.TryAddWithoutValidation($k, $headers[$k])
        }

        $sendTask = $client.SendAsync($req)
        if (-not $sendTask.Wait(($TimeoutSec + 15) * 1000)) {
            # The ceiling fired, so the client's own timer did not. Reporting a
            # hang beats blocking here forever, which is the failure being fixed.
            return @{ Ok = $false; Hang = $true; Detail = "TIMEOUT after ${TimeoutSec}s (hard ceiling) - stream hung" }
        }
        $response = $sendTask.Result
        $status = [int]$response.StatusCode

        # HttpClient does not throw on a non-2xx (Invoke-WebRequest did), so the
        # wall/wiring verdicts are decided inline instead of in a catch. Same
        # verdicts, same reasoning: when every cascade step is walled the proxy
        # correctly answers 429/402, and GLM walls ~2x/day (median 57 min).
        # Restarting the container cannot lift an upstream quota wall - it only
        # drops every agent mid-stream.
        if ($status -ge 400) {
            if ($status -eq 402 -or $status -eq 429 -or $status -eq 529) {
                return @{ Ok = $false; Hang = $false; Detail = "upstream wall HTTP $status - not a hang, no restart" }
            }
            if ($status -lt 500) {
                return @{ Ok = $false; Hang = $false; Detail = "client/wiring error HTTP $status - a restart would not fix it" }
            }
            return @{ Ok = $false; Hang = $true; Detail = "HTTP error $status" }
        }

        # Already fully buffered by ResponseContentRead, so this does not block.
        $content = $response.Content.ReadAsStringAsync().Result
        if ($null -eq $content) { $content = "" }

        # Stream must contain a terminal event
        if ($content -match "message_stop") {
            $hasToolUse = $content -match "tool_use"
            $type = if ($hasToolUse) { "tool_use+end" } else { "text+end" }
            return @{ Ok = $true; Hang = $false; Detail = "stream OK ($type, $($content.Length) bytes)" }
        } elseif ($content.Length -gt 100) {
            # Got data but no message_stop - suspicious but not fatal
            return @{ Ok = $false; Hang = $true; Detail = "stream incomplete ($($content.Length) bytes, no message_stop)" }
        } elseif ($content.Length -gt 0) {
            return @{ Ok = $false; Hang = $true; Detail = "short response ($($content.Length) bytes): $($content.Substring(0, [Math]::Min(200, $content.Length)))" }
        } else {
            return @{ Ok = $false; Hang = $true; Detail = "EMPTY response - stream hung" }
        }
    }
    catch {
        # The real cause is buried: PS wraps a failing .Wait()/.Result in a
        # MethodInvocationException, around an AggregateException, around the
        # TaskCanceledException a timeout actually raises. So walk the whole
        # chain, and decide on the TYPE - the message is localized (PS 5.1 on a
        # French host says "Une ou plusieurs erreurs se sont produites") and
        # would never match an English "timeout".
        $chain = @()
        $ex = $_.Exception
        while ($ex -and $chain.Count -lt 10) {
            $chain += $ex
            if ($ex -is [System.AggregateException] -and $ex.InnerExceptions.Count -ge 1) {
                $ex = $ex.InnerExceptions[0]
            } else {
                $ex = $ex.InnerException
            }
        }
        $timedOut = $false
        foreach ($e in $chain) { if ($e -is [System.OperationCanceledException]) { $timedOut = $true } }
        $msg = $chain[$chain.Count - 1].Message   # innermost: the informative one
        if ($timedOut -or $msg -match "timed? ?out" -or $msg -match "timeout") {
            return @{ Ok = $false; Hang = $true; Detail = "TIMEOUT after ${TimeoutSec}s - stream hung" }
        }
        # Connection refused / socket reset land here: the proxy is not answering
        # at all, which a restart CAN fix.
        return @{ Ok = $false; Hang = $true; Detail = "error: $msg" }
    }
    finally {
        if ($client) { $client.Dispose() }
    }
}

# The drain logic is shared with any other scheduled restart (ClaudishDailyRestart
# calls the same file standalone), so it lives in one place rather than being
# copied here.
. "$PSScriptRoot\claudish-drain.ps1"

# Dot-sourcing executes drain.ps1's param() DEFAULTS in this scope, which
# reassigns $LogPath to ...\.claudish\drain.log — silently misdirecting this
# script's log when run as the user, and fatally (missing dir + Stop) when run
# by the SYSTEM scheduled task (2026-08-30: exit 1, no log). Re-pin it.
$LogPath = "$ClaudishHome\watchdog.log"

function Get-State {
    if (Test-Path $StateFile) {
        try { return Get-Content $StateFile -Raw | ConvertFrom-Json } catch {}
    }
    return [PSCustomObject]@{ consecutiveHangs = 0 }
}

function Set-State {
    param([int]$ConsecutiveHangs)
    $dir = Split-Path $StateFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    @{ consecutiveHangs = $ConsecutiveHangs } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

function Invoke-DockerBounded {
    # Runs a docker command with a hard wall-clock bound.
    #
    # Why. On 2026-09-02 ten consecutive runs wrote "=== Watchdog check ===" and
    # then nothing at all - for 2h30, across the whole outage. Nothing else can
    # produce that trace: the very next statement is Step 1's `docker inspect`,
    # and every branch after it logs. So the CLI itself never answered, and the
    # stream probe below - however carefully bounded - was never reached. A
    # watchdog is only as bounded as its FIRST unbounded call.
    #
    # Output goes to files, not pipes: a redirected pipe that fills would block
    # the child before it exits, reintroducing the same hang through the back
    # door. The commands here emit a few bytes, but the failure being fixed is
    # precisely the one nobody expected.
    param([string[]]$DockerArgs, [int]$TimeoutSec = $DockerTimeoutSec)

    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath "docker" -ArgumentList $DockerArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        # Touching .Handle caches the process handle. Without it, -PassThru hands
        # back an object whose .ExitCode stays $null after WaitForExit, so every
        # successful call would read as a failure - and Step 1 would "recover" an
        # engine that was fine, on every cycle. Caught only by running it.
        $null = $p.Handle
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            try { $p.Kill() } catch {}
            return @{ Ok = $false; TimedOut = $true; Code = -1; Out = "" }
        }
        $out = ""
        try { $out = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue) } catch {}
        if ($null -eq $out) { $out = "" }
        return @{ Ok = ($p.ExitCode -eq 0); TimedOut = $false; Code = $p.ExitCode; Out = $out.Trim() }
    }
    catch {
        # Start-Process itself failed: docker.exe never launched. That is the
        # 02/09 signature — under host commit exhaustion the CLI cannot start,
        # which is how ten runs wrote a banner and nothing else.
        return @{ Ok = $false; TimedOut = $false; Code = -1; Out = ""; Error = $_.Exception.Message; LaunchFail = $true }
    }
    finally {
        Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
}

function Test-PortListen {
    param([string]$HostName = "localhost", [int]$Port = 3000, [int]$TimeoutMs = 3000)

    # TcpClient + a bounded Wait, not Test-NetConnection: TNC takes seconds,
    # writes progress records, and does its own allocations — all bad in a
    # watchdog that must conclude, possibly on a starved host. Everything is
    # guarded: with $ErrorActionPreference = Stop a throwing probe would kill
    # the cycle, and a probe that cannot run on a sick host is worthless.
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        try {
            $connect = $tcp.ConnectAsync($HostName, $Port)
            try {
                if (-not $connect.Wait($TimeoutMs)) {
                    # No answer within budget: black-holed, not merely absent.
                    return @{ Listening = $false; Detail = "no-answer ${TimeoutMs}ms" }
                }
            }
            catch [System.AggregateException] {
                # Task.Wait() rethrows the task's own fault. A fast refusal is
                # the healthy "nothing is bound here" answer — SocketException
                # in the chain means refused/reset, not a probe failure.
                $refused = $false
                $ex = $_.Exception
                while ($ex) {
                    if ($ex -is [System.Net.Sockets.SocketException]) { $refused = $true }
                    if ($ex -is [System.AggregateException] -and $ex.InnerExceptions.Count -ge 1) { $ex = $ex.InnerExceptions[0] } else { $ex = $ex.InnerException }
                }
                if ($refused) { return @{ Listening = $false; Detail = "refused" } }
                return @{ Listening = $false; Detail = "connect error: $($_.Exception.InnerException.Message)" }
            }
            if ($tcp.Connected) { return @{ Listening = $true } }
            return @{ Listening = $false; Detail = "completed but not connected" }
        }
        finally { $tcp.Dispose() }
    }
    catch {
        return @{ Listening = $false; Detail = "error: $($_.Exception.Message)" }
    }
}

function Get-HostCommit {
    # Commit charge vs commit limit — the Id 26 "insufficient virtual memory"
    # early-warning, read in-process (no child process to launch; launching is
    # exactly what dies under commit exhaustion). Win32_OperatingSystem's
    # "virtual memory" IS the commit charge pair.
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem `
            -Property @("TotalVirtualMemorySize", "FreeVirtualMemory") -ErrorAction Stop
        $limitKB = [double]$os.TotalVirtualMemorySize
        $freeKB = [double]$os.FreeVirtualMemory
        if ($limitKB -gt 0) {
            return @{
                Ok      = $true
                UsedPct = [Math]::Round((($limitKB - $freeKB) / $limitKB) * 100, 1)
                UsedGB  = [Math]::Round(($limitKB - $freeKB) / 1MB, 1)
                LimitGB = [Math]::Round($limitKB / 1MB, 1)
            }
        }
    }
    catch {}
    return @{ Ok = $false }
}

function Write-DiagLine {
    # One line at every ambiguous stop, naming both facts the 02/09 postmortem
    # had to reconstruct after the fact: is the published port bound, and does
    # the host have commit headroom. Together they self-classify the incident:
    #   deaf + commit >= 95%  -> host commit exhaustion (container restart useless)
    #   deaf + headroom       -> engine/port-forwarder, not the container
    #   listening             -> wiring is fine; suspect the pipeline/upstream
    param([string]$Tag)

    $port = 3000
    try { $port = ([uri]$ProxyUrl).Port } catch {}
    $p = Test-PortListen -Port $port
    $c = Get-HostCommit

    $portTxt = if ($p.Listening) { "port ${port} LISTENING" } else { "port ${port} DEAF ($($p.Detail))" }
    $commitTxt = if ($c.Ok) { "commit $($c.UsedPct)% ($($c.UsedGB)/$($c.LimitGB) GB)" } else { "commit n/a" }
    $verdict = if (-not $p.Listening -and $c.Ok -and $c.UsedPct -ge 95) {
        "-> host commit exhaustion signature: container restart is useless"
    }
    elseif (-not $p.Listening) {
        "-> port deaf with commit headroom: engine/port-forwarder, not the container"
    }
    else {
        "-> port answers: wiring fine, suspect pipeline/upstream"
    }
    Write-Log "DIAG[$Tag]: $portTxt, $commitTxt $verdict"
}

# --- Main ---

Write-Log "=== Watchdog check ==="

# Step 0: Engine recovery. After a reboot the Docker Desktop backend can die
# outright ("backend process exited") — docker CLI then fails with rc 28/125 and
# `docker start` is useless. Observed 2026-08-29: the first reboot of the hub
# machine came back with no container for exactly this reason, and a human had
# to reboot a second time. Start the service, then launch Docker Desktop in the
# interactive user session via a helper task (SYSTEM cannot own the GUI app),
# then wait, bounded, for the engine to answer.
function Test-DockerEngine {
    return (Invoke-DockerBounded @("version")).Ok
}

function Start-DockerEngine {
    if (Test-DockerEngine) { return $true }
    Write-Log "ENGINE-DOWN: docker CLI cannot reach the engine — recovering"
    Write-DiagLine "engine-down"
    try { Start-Service com.docker.service -ErrorAction SilentlyContinue } catch {}
    if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue)) {
        try {
            $helper = "ClaudishDockerDesktopStart"
            $action = New-ScheduledTaskAction -Execute "C:\Program Files\Docker\Docker\Docker Desktop.exe"
            Register-ScheduledTask -TaskName $helper -Action $action `
                -User "$env:COMPUTERNAME\jsboige" -LogonType Interactive -RunLevel Highest -Force | Out-Null
            Start-ScheduledTask -TaskName $helper
            Write-Log "ENGINE: Docker Desktop launch requested in user session"
        } catch {
            Write-Log "ENGINE: could not launch Docker Desktop ($($_.Exception.Message))"
        }
    }
    for ($i = 1; $i -le 12; $i++) {
        Start-Sleep -Seconds 10
        if (Test-DockerEngine) {
            Write-Log "ENGINE: recovered after $($i * 10)s"
            return $true
        }
    }
    Write-Log "ENGINE: still down after 120s — FATAL this cycle (next run retries)"
    return $false
}

# Step 1: Container running?
$inspect = Invoke-DockerBounded @("inspect", $ContainerName, "--format", "{{.State.Status}}")
if ($inspect.TimedOut) {
    # The 2026-09-02 signature, now named instead of deduced from an absence.
    # No answer at all is an engine fault, which the recovery path can act on.
    Write-Log "DOCKER-TIMEOUT: inspect did not answer within ${DockerTimeoutSec}s — engine not responding"
    Write-DiagLine "docker-timeout"
    if (-not (Start-DockerEngine)) { exit 1 }
    $inspect = Invoke-DockerBounded @("inspect", $ContainerName, "--format", "{{.State.Status}}")
    if ($inspect.TimedOut) {
        Write-Log "FATAL: docker still not answering after engine recovery"
        exit 1
    }
}
$containerStatus = $inspect.Out
if (-not $inspect.Ok -or $containerStatus -ne "running") {
    if ($inspect.LaunchFail) {
        # Distinguished from a CLI error: the process never started at all.
        # On 02/09 this fired 3x (docker.exe) and 6x (cmd.exe) silently.
        Write-Log "DOCKER-LAUNCH-FAIL: docker.exe would not start ($($inspect.Error)) — commit-exhaustion signature"
        Write-DiagLine "docker-launch-fail"
    }
    if (-not $inspect.Ok) {
        # CLI answered but failed — engine down, not just the container.
        if (-not (Start-DockerEngine)) { exit 1 }
    }
    Write-Log "CRITICAL: Container not running (status=$containerStatus). Starting..."
    # A start can legitimately take a while; bound it well above that, not at 20s.
    [void](Invoke-DockerBounded @("start", $ContainerName) -TimeoutSec 120)
    Start-Sleep -Seconds 15
    $recheck = (Invoke-DockerBounded @("inspect", $ContainerName, "--format", "{{.State.Status}}")).Out
    if ($recheck -eq "running") {
        Write-Log "RECOVERED: Container started"
    } else {
        Write-Log "FATAL: Container won't start (status=$recheck)"
        exit 1
    }
    exit 0
}

# Step 2: Uptime check
$startedAtRes = Invoke-DockerBounded @("inspect", $ContainerName, "--format", "{{.State.StartedAt}}")
if (-not $startedAtRes.Ok) {
    Write-Log "DOCKER: uptime unreadable (timedOut=$($startedAtRes.TimedOut) code=$($startedAtRes.Code)) — skipping the proactive branch this cycle"
    $startedAtRes.Out = [DateTimeOffset]::UtcNow.ToString("o")
}
$startedAt = $startedAtRes.Out
$startTime = [DateTimeOffset]::Parse($startedAt)
$uptime = [DateTimeOffset]::UtcNow - $startTime
$uptimeHours = [Math]::Round($uptime.TotalHours, 1)

# Step 3: Proactive restart if uptime > threshold (prevent degradation BEFORE it happens)
# An uptime THRESHOLD drifts through the clock: an 11h period restarts at 09:00,
# then 20:00, then 07:00... landing mid-workday roughly every other time. Gate it
# on a quiet local window instead, so the one unavoidable daily restart never
# happens while the fleet is working.
$nowHour = (Get-Date).Hour
$inQuietWindow = ($nowHour -ge $QuietHourStart -and $nowHour -lt $QuietHourEnd)
if ($uptimeHours -ge $ProactiveRestartHours) {
    if (-not $inQuietWindow) {
        Write-Log "PROACTIVE: uptime ${uptimeHours}h >= ${ProactiveRestartHours}h but outside the quiet window ${QuietHourStart}h-${QuietHourEnd}h — deferring (a healthy proxy is not an emergency)"
    } else {
        Write-Log "PROACTIVE: uptime ${uptimeHours}h >= ${ProactiveRestartHours}h, quiet window — draining then restarting..."
        Invoke-ClaudishDrainedRestart -Reason "proactive uptime ${uptimeHours}h" -Container $ContainerName -Url $ProxyUrl -MaxWait $DrainMaxWaitProactiveSec
        $result = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec 60
        Write-Log "After proactive restart: $($result.Detail)"
        Set-State -ConsecutiveHangs 0
        exit $(if ($result.Ok) { 0 } else { 1 })
    }
}

# Step 4: Real tool-call streaming test
$result = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec $StreamTimeoutSec

$state = Get-State
$consecutive = [int]$state.consecutiveHangs

if ($result.Ok) {
    Write-Log "OK (uptime=${uptimeHours}h). $($result.Detail)"
    Set-State -ConsecutiveHangs 0
    exit 0
}

if (-not $result.Hang) {
    # Real failure, wrong remedy. Log it loudly and leave the container alone.
    Write-Log "DEGRADED (uptime=${uptimeHours}h): $($result.Detail) — NO restart (a restart cannot fix this)"
    Set-State -ConsecutiveHangs 0
    exit 0
}

# Hang signal. One failed 90s probe is not proof: the proxy may simply be under
# load. Require two consecutive cycles (~15 min apart), mirroring the relay's own
# failover hysteresis, before paying the cost of dropping every live stream.
$consecutive = $consecutive + 1
if ($consecutive -lt 2) {
    Write-Log "HANG SIGNAL 1/2 (uptime=${uptimeHours}h): $($result.Detail) — waiting for confirmation next cycle, NO restart"
    Write-DiagLine "hang-signal"
    Set-State -ConsecutiveHangs $consecutive
    exit 0
}

Write-Log "HANG CONFIRMED 2/2 (uptime=${uptimeHours}h): $($result.Detail)"
Write-DiagLine "hang-confirmed"
Invoke-ClaudishDrainedRestart -Reason "confirmed hang" -Container $ContainerName -Url $ProxyUrl -MaxWait $DrainMaxWaitHangSec
Set-State -ConsecutiveHangs 0

$result2 = Test-ProxyWithTools -Url $ProxyUrl -TimeoutSec 60
if ($result2.Ok) {
    Write-Log "RECOVERED: $($result2.Detail)"
} else {
    Write-Log "CRITICAL: Still broken after restart: $($result2.Detail)"
    Write-DiagLine "post-restart-fail"
    exit 1
}
