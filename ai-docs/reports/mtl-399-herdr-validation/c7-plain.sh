#!/bin/zsh
# Check 7: create_session from an environment with no herdr or herdr-core variables.
V=/Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/ai-docs/sessions/dev-feature-herdr-native-sessions-20261109-005218-9cfbb130/validation
CHECK=/Users/jack/.config/herdr/sessions/claudish-mtl399-check/herdr.sock
MAIN=/Users/jack/.config/herdr/herdr.sock
tabs() { HERDR_SOCKET_PATH=$1 /Users/jack/.local/bin/herdr tab list 2>/dev/null | jq -c '[.result.tabs[] | {tab_id,label,pane_count}]'; }
echo "before check: $(tabs $CHECK)" > $V/c7-plain.log
echo "before main:  $(tabs $MAIN)" >> $V/c7-plain.log
for v in ${(k)parameters[(I)HERDR_*]} ${(k)parameters[(I)HC_*]}; do unset $v; done
export TERM_PROGRAM=ghostty
cd /Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions || exit 1
start=$(date +%s)
{ echo 'call create_session {"model":"gpt-6-luna","effort":"low","work_dir":"/private/tmp/claude-501/-Users-jack-mag-claudish/333e429e-26e2-48f0-a63b-2ea2b4f1bc12/scratchpad/p7work"}'
  sleep 25; echo ls; sleep 1; echo quit; } | CLAUDISH_DEBUG=1 bun $V/driver.ts >> $V/c7-plain.log 2>&1
echo "after check:  $(tabs $CHECK)" >> $V/c7-plain.log
echo "after main:   $(tabs $MAIN)" >> $V/c7-plain.log
newest=$(ls -t logs/claudish_*.log | head -1)
echo "debug log: $newest" >> $V/c7-plain.log
echo "herdr lines in it: $(grep -c '\[herdr\]' $newest)" >> $V/c7-plain.log
cat $V/c7-plain.log
