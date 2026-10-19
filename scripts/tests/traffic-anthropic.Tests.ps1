# traffic-anthropic.Tests.ps1 — pins for the #72 g2 sonnet split
#
# Run under BOTH interpreters (bun run test:scripts / test:scripts:win51) —
# production runs 5.1. Pure logic: temp corpus, no network, no docker.
#
# What these pins protect: a sonnet request is NOT proof of remap. The
# categorical "sonnet = remapped → not a leak" this file's subject used to
# render exonerated 40 native sonnet requests from a non-authorized WAN seat
# (measured 30/09–01/10) while the script's own billed-proof counter counted
# them. The fix pairs every sonnet request with its resp-* capture: paired
# native → verdict pipeline; composed/no-capture → informational.
#
# The corpus builder reproduces the g2-corpus shapes: req envelopes whose
# filename carries (pid, counter, ts) exactly as request-logger writes them,
# and resp captures named/parsed as createResponseCapture writes them.

BeforeAll {
    $script:ScriptsDir = Join-Path $PSScriptRoot '..'
    Import-Module (Join-Path $script:ScriptsDir 'CaptureUtils.psm1') -Force

    function New-G2Pair {
        # One req-*.json + one resp-*.sse pair, named exactly as production
        # writes them. $RespOffsetSec = response lag after the request.
        param(
            [string]$Dir, [int]$ProcId, [int]$Counter, [int]$ReqOffsetSec, [int]$RespOffsetSec,
            [string]$Src, [string]$Machine, [string]$Model, [string]$Label, [switch]$Subagent
        )
        $base = [datetime]::UtcNow.AddSeconds(-300)
        $reqT = $base.AddSeconds($ReqOffsetSec)
        $respT = $base.AddSeconds($ReqOffsetSec + $RespOffsetSec)
        $reqTs = $reqT.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
        $respTs = $respT.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')

        $billing = "x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=cli; cc_workload=interactive;"
        if ($Subagent) { $billing += ' cc_is_subagent=true;' }
        $envelope = @{
            ts      = $reqT.ToString('o')
            src     = '127.0.0.1'
            machine = $Machine
            model   = $Model
            pid     = $ProcId
            body    = @{
                metadata = @{ user_id = '{"customer_id":"cus_x","device_id":"a1b2c3d4e5f60708","session_id":"11111111-1111-1111-1111-111111111111"}' }
                system   = @(@{ type = 'text'; text = "You are Claude Code.`n$billing" })
                messages = @(@{ role = 'user'; content = 'hi' })
            }
        }
        $reqFile = Join-Path $Dir ('req-{0}-{1}-{2}-{3}.json' -f $ProcId, $Counter.ToString('0000'), $reqTs, $Src)
        [System.IO.File]::WriteAllText($reqFile, ($envelope | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))

        $respFile = Join-Path $Dir ('resp-{0}-r{1}-{2}-{3}-{4}.sse' -f $ProcId, $Counter.ToString('0000'), $respTs, $Label, $Model)
        $respText = "# claudish response capture`n# parser=$Label model=$Model reqN=$Counter pid=$ProcId`n# elapsed_ms=123 events~=2`n# ============================================================`n`ndata: {}`n"
        [System.IO.File]::WriteAllText($respFile, $respText, [System.Text.UTF8Encoding]::new($false))
        return @{ ReqTime = $reqT; ReqFile = $reqFile; RespFile = (Split-Path $respFile -Leaf) }
    }

    function New-G2Corpus {
        param([string]$Dir, [switch]$WithLeak)
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
        # ai-01 authorized native sonnet → [OK]
        New-G2Pair -Dir $Dir -ProcId 4102 -Counter 1 -ReqOffsetSec 100 -RespOffsetSec 2 -Src 'direct' -Machine 'myia-ai-01' -Model 'claude-sonnet-5-5' -Label 'native' | Out-Null
        # po-2027 NON-authorized native sonnet (the WAN-seat shape) → must be FLAGGED
        New-G2Pair -Dir $Dir -ProcId 4102 -Counter 2 -ReqOffsetSec 105 -RespOffsetSec 2 -Src 'wan-seat' -Machine 'myia-po-2027' -Model 'claude-sonnet-5-5' -Label 'native' | Out-Null
        # po-2024 composed-served sonnet → informational only
        New-G2Pair -Dir $Dir -ProcId 4102 -Counter 3 -ReqOffsetSec 110 -RespOffsetSec 3 -Src 'direct' -Machine 'myia-po-2024' -Model 'claude-sonnet-4-6' -Label 'openai' | Out-Null
        # Leak corpus: rogue Opus sub-agent on a non-authorized machine → [LEAK-SUBAGENT], exit 1
        if ($WithLeak) {
            New-G2Pair -Dir $Dir -ProcId 4102 -Counter 4 -ReqOffsetSec 115 -RespOffsetSec 2 -Src 'direct' -Machine 'myia-po-2026' -Model 'claude-opus-5' -Label 'native' -Subagent | Out-Null
        }
    }

    # Run the script in the SAME interpreter running this suite (the win51
    # runner must exercise the script under 5.1, where it runs in production).
    $script:PsExe = (Get-Process -Id $PID).Path
    $script:Script = Join-Path $script:ScriptsDir 'traffic-anthropic.ps1'

    $script:MainDir  = Join-Path $TestDrive 'g2-main'
    $script:LeakDir  = Join-Path $TestDrive 'g2-leak'
    New-G2Corpus -Dir $script:MainDir
    New-G2Corpus -Dir $script:LeakDir -WithLeak

    $script:MainOut = (& $script:PsExe -NoProfile -File $script:Script -Dir $script:MainDir -Hours 6 2>&1 | Out-String)
    $script:MainExit = $LASTEXITCODE
    $script:LeakOut = (& $script:PsExe -NoProfile -File $script:Script -Dir $script:LeakDir -Hours 6 2>&1 | Out-String)
    $script:LeakExit = $LASTEXITCODE
}

Describe 'Get-ResponseIndex / Find-PairedResponse pairing' {
    BeforeAll {
        $script:index = Get-ResponseIndex -Dir $script:MainDir
    }
    It 'indexes by (pid, counter) with the parser label from the filename' {
        $script:index.ContainsKey('4102/1') | Should -BeTrue
        $script:index['4102/1'][0].Label | Should -Be 'native'
        $script:index['4102/3'][0].Label | Should -Be 'openai'
    }
    It 'parses labels even when the model id contains dashes' {
        # claude-sonnet-5-5 as model: the lazy label match must stop at 'native'
        ($script:index['4102/1'][0].File -match '^resp-4102-r0001-\S+Z-native-claude-sonnet-5-5\.sse$') | Should -BeTrue
    }
    It 'agrees with Get-ResponseForRequest on the paired file (cross-pin)' {
        foreach ($ctr in 1, 2, 3) {
            $reqName = (Get-ChildItem (Join-Path $script:MainDir "req-4102-$('{0:d4}' -f $ctr)-*.json")).Name
            $reqT = [datetime]::ParseExact(($reqName -replace '^req-\d+-\d+-(.+Z)-.+$', '$1'), 'yyyy-MM-ddTHH-mm-ss-fffZ', $null, 'AssumeUniversal,AdjustToUniversal')
            $fast = Find-PairedResponse -Index $script:index -ProcId 4102 -Counter $ctr -RequestTime $reqT
            $slow = Get-ResponseForRequest -Counter $ctr -ProcId 4102 -RequestTime $reqT -Dir $script:MainDir
            $fast.File | Should -Be $slow.File
        }
    }
    It 'returns null for an out-of-window response (no licence to widen)' {
        $oowDir = Join-Path $TestDrive 'out-of-window'
        New-Item -ItemType Directory -Path $oowDir -Force | Out-Null
        New-G2Pair -Dir $oowDir -ProcId 4200 -Counter 1 -ReqOffsetSec 100 -RespOffsetSec 400 -Src 'direct' -Machine 'myia-ai-01' -Model 'claude-sonnet-5-5' -Label 'native' | Out-Null
        $index = Get-ResponseIndex -Dir $oowDir
        $reqName = (Get-ChildItem (Join-Path $oowDir 'req-4200-0001-*.json')).Name
        $reqT = [datetime]::ParseExact(($reqName -replace '^req-\d+-\d+-(.+Z)-.+$', '$1'), 'yyyy-MM-ddTHH-mm-ss-fffZ', $null, 'AssumeUniversal,AdjustToUniversal')
        Find-PairedResponse -Index $index -ProcId 4200 -Counter 1 -RequestTime $reqT | Should -BeNullOrEmpty
        Get-ResponseForRequest -Counter 1 -ProcId 4200 -RequestTime $reqT -Dir $oowDir | Should -BeNullOrEmpty
    }
}

Describe 'traffic-anthropic.ps1 sonnet split (#72 g2)' {
    It 'flags native-served sonnet from a non-authorized machine (WAN-seat shape)' {
        $script:MainOut | Should -Match 'myia-po-2027'
        $script:MainOut | Should -Match '\[REVIEW-INTERACTIVE\]'
    }
    It 'keeps authorized-machine native sonnet as OK' {
        $script:MainOut | Should -Match 'myia-ai-01.*claude-sonnet-5-5.*\[OK\]'
    }
    It 'keeps composed-served sonnet informational with its served-by label' {
        $script:MainOut | Should -Match 'myia-po-2024'
        $script:MainOut | Should -Match 'served-by: openai'
    }
    It 'never renders the categorical exoneration (regression pin)' {
        # The two strings the pre-fix script printed while exonerating native
        # sonnet — either reappearing means the split stopped discriminating.
        $script:MainOut | Should -Not -Match 'REMAPPED to glm'
        $script:MainOut | Should -Not -Match 'Hermes wire-forcing'
    }
    It 'counts native sonnet in the verdict line' {
        $script:MainOut | Should -Match 'native-served sonnet: 2 req'
    }
    It 'exits 0 without a sub-agent leak' {
        $script:MainExit | Should -Be 0
    }
    It 'still alarms (exit 1) on a rogue Opus sub-agent from a non-authorized machine' {
        $script:LeakOut | Should -Match '\[LEAK-SUBAGENT\]'
        $script:LeakExit | Should -Be 1
    }
}
