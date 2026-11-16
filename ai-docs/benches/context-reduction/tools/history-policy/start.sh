#!/bin/sh
# Starts a history-policy arm: the claudish-compaction setup, then a check
# that the config from --param claudish_config names this arm's policy in
# compaction.history.policy. A config for another policy stops the trial
# here, before any spend.
#
#   start.sh <policy>      policy: threshold | early | cost
#
# Reads one field of the config; prints no other part of it.
set -u
policy=$1
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish-compaction/start.sh" || exit 1

got=$(bun -e 'const c = await Bun.file(process.argv[1]).json(); console.log(c?.compaction?.history?.policy ?? "absent")' "$HOME/.claudish/config.json" 2>/dev/null)
echo "start: compaction.history.policy in the config: ${got:-unreadable}; this arm: $policy"
if [ "$got" != "$policy" ]; then
  echo "start: the config is for another policy; pass this arm's config" >&2
  exit 1
fi
mkdir -p "$HOME/.bench-compaction"
echo "$policy" >"$HOME/.bench-compaction/policy"
