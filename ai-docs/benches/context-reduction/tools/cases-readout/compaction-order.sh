#!/bin/sh
# A readout for case d: which compaction came first in the run. Claude
# Code's own compaction writes a compact_boundary record to its transcript;
# claudish's history summary writes "[compaction] history ..." lines to its
# debug log. Prints the first time of each, the limits claudish reported
# ("~N of LIMIT tokens") and the auto-compact window both launchers exported.
# Always exits 0: this is a measurement, not a grade.
launch=$(cat "$HOME/.bench-compaction/launch-dir" 2>/dev/null)
echo "launch_env=$(cat "$HOME/.bench-compaction/launch-env" 2>/dev/null || echo absent)"

cc=$(cat "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | grep '"compact_boundary"' | grep -o '"timestamp":"[^"]*"' | cut -d'"' -f4 | sort)
echo "claude_code_compactions=$(echo "$cc" | grep -c .)"
echo "claude_code_first=$(echo "$cc" | head -1)"

logs=$(ls "$launch"/debug/claudish_*.log 2>/dev/null)
if [ -n "$logs" ]; then
  first() { cat $logs | grep -- "$1" | head -1 | grep -o '^\[[^]]*\]' | tr -d '[]'; }
  echo "claudish_summary_started_first=$(first '\[compaction\] history summary started')"
  echo "claudish_swap_first=$(first '\[compaction\] history swap in session')"
  echo "claudish_swaps=$(cat $logs | grep -c '\[compaction\] history swap in session')"
  echo "claudish_replayed_lines=$(cat $logs | grep -c 'history replayed at')"
  echo "claudish_limits:"
  cat $logs | grep -o ' of [0-9]* tokens' | sort | uniq -c
else
  echo "claudish_debug_log=absent"
fi
exit 0
