#!/bin/sh
# The VariantCheck of a history-policy variant. Passes only when the
# claudish-compaction check passes AND claudish logged at least one
# "[compaction] history decision <policy>:" line, every one of them naming
# this variant's policy.
#
#   variant-check.sh <policy>
policy=$1
here=$(cd "$(dirname "$0")" && pwd)
fail=0
sh "$here/../claudish-compaction/variant-check.sh" || fail=1

launch=$(cat "$HOME/.bench-compaction/launch-dir" 2>/dev/null)
# The session's log can sit in an earlier launch folder of the same trial.
logs=$(sh "$here/../claudish-compaction/trial-logs.sh" "$launch")
if [ -z "$logs" ]; then
  echo "debug log: absent"
  exit 1
fi
all=$(cat $logs | grep -c '\[compaction\] history decision ')
mine=$(cat $logs | grep -c "\[compaction\] history decision $policy:")
echo "history decision lines: $all; naming policy $policy: $mine"
[ "$all" -gt 0 ] && [ "$all" -eq "$mine" ] || fail=1
exit "$fail"
