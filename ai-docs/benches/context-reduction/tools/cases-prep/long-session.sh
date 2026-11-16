#!/bin/sh
# Case d: install the dependencies, and have both launchers export a 200,000
# token auto-compact window, so Claude Code compacts near 200K instead of 1M
# and claudish's history limit follows the same value.
set -eu
bun install --frozen-lockfile
mkdir -p "$HOME/.bench-compaction"
echo "CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000" >"$HOME/.bench-compaction/launch-env"
echo "prep: long-session: launch-env sets CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000"
