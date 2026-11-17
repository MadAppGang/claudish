#!/bin/sh
# The claudish-compaction evidence, then the variant's policy and every history
# decision line (numbers and reasons only; no message text is in them).
#
#   evidence.sh <policy>
policy=$1
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish-compaction/evidence.sh"
echo "policy_arm=$policy"
echo "policy_started=$(cat "$HOME/.bench-compaction/policy" 2>/dev/null || echo absent)"
launch=$(cat "$HOME/.bench-compaction/launch-dir" 2>/dev/null)
logs=$(ls "$launch"/debug/claudish_*.log 2>/dev/null)
if [ -n "$logs" ]; then
  echo "history_decisions:"
  cat $logs | grep -o '\[compaction\] history decision .*' | cut -c1-300
fi
exit 0
