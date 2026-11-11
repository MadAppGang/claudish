#!/bin/zsh
# Check 10 control: the same test file with every HERDR_ and HC_ variable removed.
for v in ${(k)parameters[(I)HERDR_*]} ${(k)parameters[(I)HC_*]}; do unset $v; done
export TERM_PROGRAM=ghostty
cd /Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/packages/cli || exit 1
bun test src/pane/pane-hooks.integration.test.ts 2>&1
