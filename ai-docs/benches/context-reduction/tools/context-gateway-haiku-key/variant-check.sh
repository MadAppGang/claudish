#!/bin/sh
# The graded Check for this variant. Passes only when all of these hold:
#   1. Claude Code's own requests went through the gateway signed with the
#      subscription, and every one went upstream that way: each telemetry
#      record has auth_mode_initial and auth_mode_effective "subscription",
#      and none has auth_fallback_used.
#   2. The gateway never switched a session to the API key: gateway.out has
#      no "auth_fallback" line.
#   3. The gateway's own model calls ran on claude-haiku-5-5 with the key: the
#      recorder saw at least one answer with status 200, every answered call
#      names claude-haiku-5-5, and no call came signed with a Bearer token.
#   4. The gateway compressed at least one tool output.
run="$HOME/.context-gateway-bench"
tel="$run/logs/telemetry.jsonl"
calls="$run/logs/haiku_calls.jsonl"
stats="$run/logs/session_stats.json"
fail=0

n() { if [ -f "$2" ]; then grep -c -- "$1" "$2"; else echo 0; fi; }

total=$(if [ -f "$tel" ]; then grep -c . "$tel"; else echo 0; fi)
sub=$(n '"auth_mode_initial":"subscription","auth_mode_effective":"subscription"' "$tel")
fb=$(n '"auth_fallback_used":true' "$tel")
echo "main requests: total=$total subscription=$sub fallback=$fb"
[ "$total" -gt 0 ] && [ "$sub" -eq "$total" ] && [ "$fb" -eq 0 ] || fail=1

switched=$(n 'auth_fallback' "$run/gateway.out")
echo "gateway auth_fallback lines: $switched"
[ "$switched" -eq 0 ] || fail=1

ncalls=$(if [ -f "$calls" ]; then grep -c . "$calls"; else echo 0; fi)
ok=$(n '"status":200' "$calls")
bearer=$(n '"auth":"bearer"' "$calls")
models=$(if [ -f "$calls" ]; then grep -oE '"model":"[^"]*"' "$calls" | sort | uniq -c; fi)
other=$(if [ -f "$calls" ]; then grep -oE '"model":"[^"]*"' "$calls" | grep -vc '"model":"claude-haiku-5-5"'; else echo 0; fi)
echo "haiku calls: total=$ncalls status200=$ok bearer=$bearer"
echo "answered by model:"
echo "${models:-  none}"
[ "$ok" -gt 0 ] && [ "$bearer" -eq 0 ] && [ "$other" -eq 0 ] || fail=1

compressed=$(if [ -f "$stats" ]; then tr -d '\n ' <"$stats" | grep -oE '"tool_output":\{[^}]*' | grep -oE '"compressed":[0-9]+' | head -1 | cut -d: -f2; fi)
echo "tool outputs compressed: ${compressed:-absent}"
[ "${compressed:-0}" -gt 0 ] || fail=1

exit "$fail"
