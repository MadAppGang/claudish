#!/bin/sh
# Shared by the claudish variants. Prints how many requests claudish's own
# always-on log recorded, as proof that the session went through claudish.
echo "route=claudish"
logs=$(ls "$HOME"/.claudish/logs/claudish_*.log 2>/dev/null)
if [ -n "$logs" ]; then
  echo "claudish_logs=$(echo "$logs" | wc -l | tr -d ' ')"
  echo "claudish_proxy_lines=$(cat $logs | grep -c '\[Proxy\]')"
else
  echo "claudish_logs=0"
fi
exit 0
