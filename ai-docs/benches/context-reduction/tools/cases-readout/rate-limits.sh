#!/bin/sh
# Counts the rate-limit answers (HTTP 429, "rate_limit_error") in each claudish
# debug log given, with the time of the first one. A 429 answer shows in the
# log as an error body with "type": "rate_limit_error"; text such as "HTTP 429"
# inside a tool output does not match.
#
#   sh rate-limits.sh <claudish log>...
for log in "$@"; do
  n=$(grep -cE '"type": ?"rate_limit_error"' "$log")
  first=$(grep -nE '"type": ?"rate_limit_error"' "$log" | head -1 | cut -d: -f1)
  at=""
  if [ -n "$first" ]; then
    at=$(head -n "$first" "$log" | grep -o '^\[[0-9TZ:.-]*\]' | tail -1 | tr -d '[]')
  fi
  echo "$(basename "$(dirname "$(dirname "$log")")") rate_limit_errors=$n first=${at:--}"
done
