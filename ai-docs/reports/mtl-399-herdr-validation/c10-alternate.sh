#!/bin/zsh
# Check 10: pane-hooks.integration.test.ts, branch and origin/main alternating, N rounds (default 3), under herdr.
# usage: c10-alternate.sh [rounds]
BRANCH=/Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/packages/cli
MAIN=/private/tmp/claude-501/-Users-jack-mag-claudish/333e429e-26e2-48f0-a63b-2ea2b4f1bc12/scratchpad/main-baseline/packages/cli
rounds=${1:-3}
for i in $(seq 1 $rounds); do
  for side in branch main; do
    dir=$BRANCH; [[ $side == main ]] && dir=$MAIN
    load=$(uptime | sed 's/.*averages: //' | cut -d' ' -f1)
    out=$(cd $dir && bun test src/pane/pane-hooks.integration.test.ts 2>&1)
    pass=$(echo "$out" | grep -E '^ *[0-9]+ pass' | tr -dc 0-9)
    fail=$(echo "$out" | grep -E '^ *[0-9]+ fail' | tr -dc 0-9)
    secs=$(echo "$out" | grep -E '^Ran' | sed 's/.*\[//; s/\]//')
    echo "round $i $side load=$load pass=$pass fail=$fail time=$secs"
    echo "$out" | grep -E '^\(fail' | sed 's/^/    /' | cut -c1-160
  done
done
