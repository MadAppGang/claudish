#!/bin/sh
# The claudish proof, then compaction's own record: the launch log (key
# checks and bundle digest), the paths of the debug log and the session
# folders, and counts from the debug log. Prints no text from tool output.
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../claudish/evidence.sh"
echo "variant=claudish-compaction"

launch=$(cat "$HOME/.bench-compaction/launch-dir" 2>/dev/null)
echo "launch_dir=${launch:-absent}"
if [ -n "$launch" ] && [ -f "$launch/launch.log" ]; then
  cat "$launch/launch.log"
fi

# The session's log can sit in an earlier launch folder of the same trial.
logs=$(sh "$here/trial-logs.sh" "$launch")
echo "debug_logs=${logs:-absent}"
store=$(readlink "$HOME/.claudish/compaction" 2>/dev/null || echo "$HOME/.claudish/compaction")
echo "compaction_store=$store"
ls -1 "$store" 2>/dev/null | sed 's/^/session_folder=/'

if [ -n "$logs" ]; then
  c() { cat $logs | grep -c -- "$1"; }
  echo "calls=$(c '\[compaction\] Calling API')"
  echo "calls_x_api_key=$(cat $logs | grep '\[compaction\] Calling API' | grep -c 'auth: x-api-key')"
  echo "calls_by_purpose:"
  cat $logs | grep '\[compaction\] Calling API' | grep -o '(purpose: [a-z]* [a-z]*' | sed 's/(purpose: /  /' | sort | uniq -c
  echo "calls_by_model_auth:"
  cat $logs | grep '\[compaction\] Calling API' | grep -o 'model: [^,]*, auth: [a-z-]*' | sed 's/^/  /' | sort | uniq -c
  echo "answers_by_status:"
  cat $logs | grep '\[compaction\]' | grep -o ': HTTP [0-9]*' | sed 's/^: /  /' | sort | uniq -c
  tokens=$(cat $logs | grep -o 'HTTP [0-9]*, [0-9]* in / [0-9]* out tokens' | awk '{i+=$3; o+=$6; n++} END {printf "%d answers, %d in / %d out", n, i, o}')
  echo "haiku_tokens=$tokens"
  echo "sent_by_form:"
  cat $logs | grep -o 'sent=[a-z-]*' | sort | uniq -c
  echo "child_auth:"
  cat $logs | grep -o '\[claude-runner\] child auth: .*' | sort | uniq -c
  echo "call_failures:"
  cat $logs | grep '\[compaction\]' | grep -E ': (no answer within|no complete answer within|request failed:|cancelled at shutdown|HTTP [0-9]+ but the body)' | sed 's/^.*\[compaction\]/[compaction]/' | cut -c1-200 | sort | uniq -c
  echo "compaction_warnings:"
  cat $logs | grep '\[compaction\]' | grep -E 'off for|is ignored|could not|refused|warn' | cut -c1-240 | sort | uniq -c
  echo "compaction_on:"
  cat $logs | grep -o '\[compaction\] on: .*' | sort | uniq -c
  echo "history_started=$(c '\[compaction\] history summary started')"
  echo "history_ready=$(c '\[compaction\] history summary ready')"
  echo "history_failed=$(c '\[compaction\] history summary failed')"
  echo "history_swaps=$(c '\[compaction\] history swap in session')"
  echo "history_skipped=$(c '\[compaction\] history skipped')"
  # A build that logs a Read of a recovery file. The line comes from a scan
  # of each request, so the distinct keys are the re-expansions.
  echo "recovery_read_lines=$(c ': recovery read ')"
  echo "recovery_read_keys=$(cat $logs | grep -o ': recovery read [^ ]*' | sort -u | grep -c .)"
fi

bun "$here/transcripts.ts"
exit 0
