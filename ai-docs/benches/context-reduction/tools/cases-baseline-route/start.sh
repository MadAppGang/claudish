#!/bin/sh
# The baseline arm for a foreign model: the run's ~/.claudish as for
# claudish-baseline, then config.json replaced by the file --param
# claudish_config named, as the compaction arm does. That file holds the
# route's credential and no compaction block and no Anthropic key; anything
# else stops the trial here, before any spend.
#
# Presence checks only: nothing from the file is printed.
set -u
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish/start.sh" "$here/../claudish-baseline" || exit 1

src="$HOME/.bench-compaction/config.json"
if [ ! -s "$src" ] || ! grep -q '"apiKeys"' "$src" 2>/dev/null; then
  rm -f "$src"
  echo "start: no route config with apiKeys; pass --param claudish_config=<file>" >&2
  exit 1
fi
if grep -q '"compaction"' "$src" || grep -q '"sk-ant-' "$src"; then
  rm -f "$src"
  echo "start: the route config holds a compaction block or an Anthropic key; this arm takes neither" >&2
  exit 1
fi
cp "$src" "$HOME/.claudish/config.json"
chmod 600 "$HOME/.claudish/config.json"
rm -f "$src"
echo "start: claudish config from the claudish_config param (route credential only), mode $(stat -f '%Lp' "$HOME/.claudish/config.json")"
