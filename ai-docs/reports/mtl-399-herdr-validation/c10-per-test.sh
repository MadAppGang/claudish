#!/bin/zsh
# Per-test durations of pane-hooks.integration.test.ts (JUnit reporter), branch then main, N rounds (default 2).
V=/Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/ai-docs/sessions/dev-feature-herdr-native-sessions-20261109-005218-9cfbb130/validation
BRANCH=/Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/packages/cli
MAIN=/private/tmp/claude-501/-Users-jack-mag-claudish/333e429e-26e2-48f0-a63b-2ea2b4f1bc12/scratchpad/main-baseline/packages/cli
for i in $(seq 1 ${1:-2}); do
  for side in branch main; do
    dir=$BRANCH; [[ $side == main ]] && dir=$MAIN
    (cd $dir && bun test src/pane/pane-hooks.integration.test.ts --reporter=junit --reporter-outfile=$V/c10-junit-$side-$i.xml > /dev/null 2>&1)
    echo "$side $i: load=$(uptime | sed 's/.*averages: //' | cut -d' ' -f1) $(grep -c '<testcase' $V/c10-junit-$side-$i.xml) tests"
  done
done
