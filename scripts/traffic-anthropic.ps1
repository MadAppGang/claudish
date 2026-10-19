#!/usr/bin/env pwsh
<#
.SYNOPSIS
Answer the recurring question: "where does the Anthropic traffic come from?"
— broken down by MACHINE + WORKSPACE + MODEL, with an automatic leak verdict.

.DESCRIPTION
Anthropic-billed traffic (Opus / Fable / native Sonnet) is policy-restricted to
myia-ai-01 ONLY (binary by machine — see the leak-policy-binary-by-machine memory).
This script reads req-*.json captures from the last N hours and attributes every
Anthropic-native request to its machine AND workspace.

WORKSPACE IS THE PROOF, machine is only the signal. The workspace is extracted from
the environment updates carried in body.messages (Get-WorkspaceFromBody in
CaptureUtils), NOT from stdout — a machine header can be absent or spoofed, but the
session's own environment block names its real working directory. That is why this
script uses captures, never `docker logs`.

⚠ It is the LAST environment update that counts, and only the structured one. The
corpus contains transcripts that QUOTE other sessions' environment blocks, so a raw
text search over a capture is not a discriminator: measured 2026-09-08, the string
"Argumentum" appeared in 8986 of 9921 requests from three machines, while only 321
of them actually had it as their workspace.

What counts as "Anthropic" in THIS deployment:
  - opus (claude-opus-4-8 / -4-7) and fable (claude-fable-5) normally resolve
    to NativeHandler → api.anthropic.com.
  - UNDER THE WEEKLY WALL the opus/fable cascade (…→ gc@glm-5.3 → PAYG) serves
    those requests from budget lanes: a request named `claude-opus-5` is NOT
    proof of Anthropic spend. The billed proof is a `resp-*-native-*.sse`
    capture in the window; this script counts it separately ($NativeRespProof)
    and labels the rows "REQUESTED". Leak tags stay machine-level regardless.
  - sonnet is NOT categorically remapped. The hub's modelMap pins the sonnet
    role to a budget target, but a client naming claude-sonnet-* with an
    sk-ant- credential rides NativeHandler → api.anthropic.com and IS billed
    (ai-01 OAuth passthrough; WAN seats measured 30/09–01/10: 40 native calls
    from a non-authorized machine). Every sonnet request is paired with its
    resp-* capture and split: paired native → full verdict pipeline below;
    composed/no-capture → informational section.
  - haiku is REMAPPED to mmc@MiniMax-M3 → NOT Anthropic.
So the Anthropic filter defaults to the model pattern 'opus|fable', augmented by
every sonnet request PROVEN native-served by its paired capture. Remaining
sonnet is shown separately (informational, with its served-by label).

VERDICT per row:
  [OK]     machine is in -AnthropicMachines (authorized; default: myia-ai-01)
  [REVIEW] machine is in -ReviewMachines (may be an authorized Safari/CoursIA/EPITA
           workflow on po-2025 — confirm, do NOT auto-escalate; lesson 2026-06-21)
  [INFO]   fable during an active fleet-wide override window (-FableOverrideActive)
  [LEAK]   any other machine on Anthropic → investigate

Exit code: 0 = no leak, 1 = at least one [LEAK] row (handy for cron/alerting).

.PARAMETER Hours
Look-back window in hours (default: 3).

.PARAMETER Dir
Capture directory (default: D:\claudish-captures).

.PARAMETER AnthropicMachines
Comma/array list of machines authorized for Anthropic (default: myia-ai-01).

.PARAMETER ReviewMachines
Machines whose Anthropic traffic is [REVIEW] not [LEAK] (default: myia-po-2025).

.PARAMETER FableOverrideActive
When set, fable-5 from ANY machine is [INFO] (a credit-burn override window is open).
Off by default — the 2026-07-03 03:00 window has expired; enable only for a new one.

.PARAMETER AnthropicModelPattern
Regex identifying Anthropic-native models (default: 'opus|fable').

.EXAMPLE
.\traffic-anthropic.ps1                 # last 3h
.\traffic-anthropic.ps1 -Hours 6        # last 6h
.\traffic-anthropic.ps1 -FableOverrideActive   # during a Fable burn window
#>
[CmdletBinding()]
param(
    [int]$Hours = 3,
    [string]$Dir = 'D:\claudish-captures',
    [string[]]$AnthropicMachines = @('myia-ai-01'),
    [string[]]$ReviewMachines = @('myia-po-2025'),
    [switch]$FableOverrideActive,
    [string]$AnthropicModelPattern = 'opus|fable'
)

Import-Module (Join-Path $PSScriptRoot 'CaptureUtils.psm1') -Force

$requests = @(Get-CaptureRequests -Dir $Dir -Hours $Hours)

# Billed-proof: a resp-* capture carrying the native handler label in the
# window. Absent under the weekly wall even when opus/fable are being
# requested heavily (cascade serves them from budget lanes).
$winStart = (Get-Date).ToUniversalTime().AddHours(-$Hours)
$nativeResp = @(Get-ChildItem -Path $Dir -Filter 'resp-*-native-*.sse' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -ge $winStart })

Write-Host ""
Write-Host "=== Anthropic Traffic Attribution (last ${Hours}h) ===" -ForegroundColor Cyan
Write-Host "Captures scanned: $($requests.Count)   (workspace = proof, from system prompt)" -ForegroundColor Gray
Write-Host ""

if ($requests.Count -eq 0) {
    Write-Host "No capture files found in the last $Hours hours." -ForegroundColor Yellow
    exit 0
}

# ── Classify verdict for a single request ───────────────────────────────────
function Get-Verdict {
    param([string]$Machine, [string]$Model, [bool]$IsSubagent)
    # [string]-typed param coerces $null to '' — the `??` form was a PS7-only
    # parse error under the documented `powershell -File` (PS 5.1) invocation.
    $m = $Machine.ToLower()
    if ($AnthropicMachines -contains $m) { return @{ Tag = '[OK]';     Color = 'Green'  } }
    if ($ReviewMachines    -contains $m) { return @{ Tag = '[REVIEW]'; Color = 'Yellow' } }
    if ($FableOverrideActive -and $Model -match 'fable') {
        return @{ Tag = '[INFO]'; Color = 'Cyan' }
    }
    # Non-authorized machine on Anthropic. The distinction the policy hinges on:
    #   sub-agent  = the DANGEROUS rogue leak (Agent tool defaults to Opus)     → alarm
    #   interactive = a user-driven session (their own machine, their call)     → surface
    if ($IsSubagent) { return @{ Tag = '[LEAK-SUBAGENT]';      Color = 'Red'    } }
    return               @{ Tag = '[REVIEW-INTERACTIVE]'; Color = 'Yellow' }
}

# ── Sonnet pairing (#72 g2): a sonnet request is NOT proof of remap ─────────
# The hub's modelMap pins the sonnet role to a budget target, but a client
# naming claude-sonnet-* with an sk-ant- credential rides NativeHandler to
# api.anthropic.com — measured 30/09–01/10, 40 native sonnet requests from a
# WAN seat on a NON-authorized machine. The discriminator is the PAIRED
# response capture's parser label, never the model name: paired native →
# billed → verdict pipeline below; anything else → informational section.
# The categorical "sonnet = remapped → not a leak" this replaces exonerated
# those requests while the script's own billed-proof counter counted them.
$sonnetAll = @($requests | Where-Object { $_.Model -match 'sonnet' })
$respIndex = $null
if ($sonnetAll) { $respIndex = Get-ResponseIndex -Dir $Dir }
foreach ($r in $sonnetAll) {
    $r | Add-Member -NotePropertyName ServedBy -NotePropertyValue $null -Force
    if ($r.ProcId -le 0 -or $r.Counter -le 0 -or -not $r.ReqTime) { continue }
    $pair = Find-PairedResponse -Index $respIndex -ProcId $r.ProcId -Counter $r.Counter -RequestTime $r.ReqTime
    if ($pair) { $r.ServedBy = $pair.Label }
}
$nativeSonnet = @($sonnetAll | Where-Object { $_.ServedBy -eq 'native' })

# ── Anthropic-native rows: opus/fable by name + sonnet proven native ────────
$anthropic = @($requests | Where-Object { $_.Model -match $AnthropicModelPattern -and $_.Model -notmatch 'sonnet' }) + $nativeSonnet
foreach ($r in $anthropic) {
    $v = Get-Verdict -Machine $r.Machine -Model $r.Model -IsSubagent ([bool]$r.IsSubagent)
    $r | Add-Member -NotePropertyName VerdictTag   -NotePropertyValue $v.Tag   -Force
    $r | Add-Member -NotePropertyName VerdictColor -NotePropertyValue $v.Color -Force
}

Write-Host "--- ANTHROPIC-native (opus/fable requested + sonnet PROVEN native-served) ---" -ForegroundColor Yellow
Write-Host ("  billed-proof in window: {0} resp-*-native-* capture(s)" -f $nativeResp.Count) -ForegroundColor DarkGray
if (-not $anthropic) {
    Write-Host "  (none — 0 requests naming opus/fable in this window)" -ForegroundColor Green
} else {
    $groups = $anthropic |
        Group-Object Machine, Workspace, Model, VerdictTag |
        Sort-Object Count -Descending

    Write-Host ("  {0,5}  {1,-14} {2,-40} {3,-18} {4}" -f 'Count', 'Machine', 'Workspace', 'Model', 'Verdict')
    Write-Host ("  {0,5}  {1,-14} {2,-40} {3,-18} {4}" -f '-----', '-------', '---------', '-----', '-------')
    foreach ($g in $groups) {
        $s = $g.Group[0]
        Write-Host ("  {0,5}  {1,-14} {2,-40} {3,-18} " -f $g.Count, $s.Machine, $s.Workspace, $s.Model) -NoNewline
        Write-Host $s.VerdictTag -ForegroundColor $s.VerdictColor
    }
}
Write-Host ""

$leakCount   = @($anthropic | Where-Object { $_.VerdictTag -eq '[LEAK-SUBAGENT]' }).Count
$reviewInt   = @($anthropic | Where-Object { $_.VerdictTag -eq '[REVIEW-INTERACTIVE]' }).Count
$reviewCount = @($anthropic | Where-Object { $_.VerdictTag -eq '[REVIEW]' }).Count

# ── Rollup by machine ───────────────────────────────────────────────────────
if ($anthropic) {
    Write-Host "--- Rollup by machine ---" -ForegroundColor Yellow
    $byMachine = $anthropic | Group-Object Machine | Sort-Object Count -Descending
    foreach ($g in $byMachine) {
        $tags = ($g.Group | Select-Object -ExpandProperty VerdictTag -Unique) -join ' '
        $subN = @($g.Group | Where-Object { $_.IsSubagent }).Count
        $workspaces = ($g.Group | Select-Object -ExpandProperty Workspace -Unique) -join '; '
        Write-Host ("  {0,-14} {1,4} req  {2}  (subagent: {3})" -f $g.Name, $g.Count, $tags, $subN)
        Write-Host ("  {0,14}          ws: {1}" -f '', $workspaces) -ForegroundColor DarkGray
    }
    Write-Host ""
}

# ── Sonnet, informational: paired to a composed lane (or no capture) ────────
# These were served by a composed handler (label openai/anthropic/…) or left
# no response capture at all — NOT billed natively. Informational by design:
# the leak organ for native sonnet is the table above, where every
# native-served sonnet request carries its machine's verdict.
$sonnetOther = @($sonnetAll | Where-Object { $_.ServedBy -ne 'native' })
if ($sonnetOther) {
    Write-Host "--- sonnet (requested, served COMPOSED/no-capture → not billed) ---" -ForegroundColor DarkGray
    $sg = $sonnetOther | Group-Object Machine, Workspace, ServedBy | Sort-Object Count -Descending
    foreach ($g in $sg) {
        $s = $g.Group[0]
        $label = if ($s.ServedBy) { $s.ServedBy } else { 'no-resp' }
        Write-Host ("  {0,5}  {1,-14} {2,-40} served-by: {3}" -f $g.Count, $s.Machine, $s.Workspace, $label) -ForegroundColor DarkGray
    }
    Write-Host "  (no-resp = served by a path that writes no capture, or unanswered — informational only, carry no verdict)" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Final verdict ───────────────────────────────────────────────────────────
$opusFableReq = @($requests | Where-Object { $_.Model -match $AnthropicModelPattern }).Count
Write-Host "=== Verdict ===" -ForegroundColor Cyan
Write-Host ("  Opus/Fable REQUESTED: {0} req · native-served sonnet: {1} req · billed-proof (resp-*-native-*): {2}" -f $opusFableReq, $nativeSonnet.Count, $nativeResp.Count)
if ($opusFableReq -gt 0 -and $nativeResp.Count -eq 0) {
    Write-Host "  [NOT-BILLED] all opus/fable requests were served by the cascade (wall-active) — real Anthropic spend 0 in this window" -ForegroundColor DarkGray
}
if ($leakCount -gt 0) {
    Write-Host ("  [LEAK-SUBAGENT] {0} req — rogue Opus sub-agent on a non-authorized machine. INVESTIGATE." -f $leakCount) -ForegroundColor Red
} else {
    Write-Host "  No sub-agent leak (the dangerous kind)." -ForegroundColor Green
}
if ($reviewInt -gt 0) {
    Write-Host ("  [REVIEW-INTERACTIVE] {0} req — non-ai-01 interactive/user-driven session (your call, not alarmed)." -f $reviewInt) -ForegroundColor Yellow
}
if ($reviewCount -gt 0) {
    Write-Host ("  [REVIEW] {0} req — po-2025 (Safari/CoursIA/EPITA?). Confirm, do not auto-flag." -f $reviewCount) -ForegroundColor Yellow
}
Write-Host ""

# Exit 1 ONLY on a real sub-agent leak (cron/alert-friendly). Interactive/review = 0.
exit ($(if ($leakCount -gt 0) { 1 } else { 0 }))
