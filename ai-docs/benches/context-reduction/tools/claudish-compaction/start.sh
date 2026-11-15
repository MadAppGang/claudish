#!/bin/sh
# Sets up the run's ~/.claudish as for claudish-baseline, then replaces its
# config.json with the file the claudish_config param named. That file holds
# the Anthropic API key compaction signs with and the compaction block. It is
# not passed with --config, because claudish exports a --config path to
# Claude Code as CLAUDISH_CONFIG.
#
# The compaction store, ~/.claudish/compaction, becomes a link into
# ~/.bench-out, so the session folder outlives an errored trial.
set -u
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish/start.sh" "$here/../claudish-baseline" || exit 1

src="$HOME/.bench-compaction/config.json"
# Presence checks only: nothing from the file is printed.
if ! grep -q '"compaction"' "$src" 2>/dev/null || ! grep -q '"sk-ant-' "$src" 2>/dev/null; then
  echo "start: no claudish config with a compaction block and a key; pass --param claudish_config=<file>" >&2
  exit 1
fi
cp "$src" "$HOME/.claudish/config.json"
chmod 600 "$HOME/.claudish/config.json"
# The run's second copy goes; the source outside the run stays.
rm -f "$src"
echo "start: claudish config from the claudish_config param, mode $(stat -f '%Lp' "$HOME/.claudish/config.json")"

live=$(readlink "$HOME/.claudish/logs" 2>/dev/null || true)
if [ -n "$live" ]; then
  mkdir -p "$live/compaction"
  chmod 700 "$live/compaction"
  ln -sfn "$live/compaction" "$HOME/.claudish/compaction"
  echo "start: compaction store in $live/compaction"
fi
