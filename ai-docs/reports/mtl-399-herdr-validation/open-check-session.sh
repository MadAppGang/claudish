#!/bin/zsh
# Opens the Phase 7 herdr check session. Logs why herdr exited, if it does.
LOG=/Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions/ai-docs/sessions/dev-feature-herdr-native-sessions-20261109-005218-9cfbb130/validation/open-check-session.log
{ date; env | grep -E '^(HERDR_|HC_|TERM_PROGRAM)'; echo "---"; } > "$LOG"
unset HERDR_ENV HERDR_PANE_ID HERDR_SOCKET_PATH HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_BIN_PATH
cd /Users/jack/mag/claudish/.claude/worktrees/mtl-399-herdr-native-sessions || exit 1
/Users/jack/.local/bin/herdr --session claudish-mtl399-check 2>>"$LOG"
echo "herdr exited $?" >> "$LOG"
echo "herdr exited; see $LOG"
sleep 3600
