#!/bin/zsh
# Runs the branch's pane-hooks test until one run fails (at most 4), keeping each run's full output.
V=/Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/ai-docs/sessions/dev-feature-herdr-native-sessions-20261109-005218-9cfbb130/validation
cd /Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/packages/cli || exit 1
for i in 1 2 3 4; do
  out=$V/c10-full-$i.log
  bun test src/pane/pane-hooks.integration.test.ts > $out 2>&1
  fail=$(grep -E '^ *[0-9]+ fail' $out | tr -dc 0-9)
  echo "run $i load=$(uptime | sed 's/.*averages: //' | cut -d' ' -f1) fail=$fail -> $out"
  [[ "$fail" != "0" ]] && break
done
