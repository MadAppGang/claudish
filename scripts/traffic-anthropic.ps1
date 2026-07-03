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
the request's system prompt (Get-WorkspaceFromSystem in CaptureUtils), NOT from
stdout — a machine header can be absent/spoofed, but the system prompt names the
real working directory. That is why this script uses captures, never `docker logs`.

What counts as "Anthropic" in THIS deployment:
  - opus (claude-opus-4-8 / -4-7) and fable (claude-fable-5) are BARE NATIVE names
    → NativeHandler → api.anthropic.com. These ARE Anthropic traffic.
  - claude-sonnet-4-6 is REMAPPED to gc@glm-5.2 (ComposedHandler) → NOT Anthropic.
  - haiku is REMAPPED to mmc@MiniMax-M3 → NOT Anthropic.
So the Anthropic filter defaults to the model pattern 'opus|fable'. Sonnet is shown
separately (informational) so you can see it was requested-but-remapped, not billed.

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
    $m = ($Machine ?? '').ToLower()
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

# ── Anthropic-native rows (opus/fable), tagged per request, then grouped ────
$anthropic = @($requests | Where-Object { $_.Model -match $AnthropicModelPattern })
foreach ($r in $anthropic) {
    $v = Get-Verdict -Machine $r.Machine -Model $r.Model -IsSubagent ([bool]$r.IsSubagent)
    $r | Add-Member -NotePropertyName VerdictTag   -NotePropertyValue $v.Tag   -Force
    $r | Add-Member -NotePropertyName VerdictColor -NotePropertyValue $v.Color -Force
}

Write-Host "--- ANTHROPIC-native (opus/fable → api.anthropic.com) ---" -ForegroundColor Yellow
if (-not $anthropic) {
    Write-Host "  (none — 0 Anthropic-billed requests in this window)" -ForegroundColor Green
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

# ── sonnet-4-6 (requested but REMAPPED → glm, NOT Anthropic) ─────────────────
$sonnet = $requests | Where-Object { $_.Model -match 'sonnet' }
if ($sonnet) {
    Write-Host "--- sonnet-4-6 (requested, REMAPPED to glm → NOT Anthropic) ---" -ForegroundColor DarkGray
    $sg = $sonnet | Group-Object Machine, Workspace | Sort-Object Count -Descending
    foreach ($g in $sg) {
        Write-Host ("  {0,5}  {1,-14} {2}" -f $g.Count, $g.Group[0].Machine, $g.Group[0].Workspace) -ForegroundColor DarkGray
    }
    Write-Host "  (unknown/no-workspace sonnet = Hermes wire-forcing pattern → glm; not a leak)" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Final verdict ───────────────────────────────────────────────────────────
$totalAnthropic = @($anthropic).Count
Write-Host "=== Verdict ===" -ForegroundColor Cyan
Write-Host ("  Anthropic-billed total: {0} req" -f $totalAnthropic)
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
