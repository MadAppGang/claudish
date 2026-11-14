#!/bin/sh
# Runs after the agent stopped. Prints the gateway's own counts, copies its logs
# out when the run shares an output folder, and stops the gateway.
run="$HOME/.context-gateway-bench"
echo "variant=context-gateway"
echo "tool=$("${CONTEXT_GATEWAY_BIN:-$HOME/.local/bin/context-gateway}" --version 2>&1 | grep -o 'context-gateway v[0-9.]*' | head -1)"

lines() { if [ -f "$1" ]; then wc -l <"$1" | tr -d ' '; else echo absent; fi; }
echo "compressions=$(lines "$run/logs/tool_output_compression.jsonl")"
echo "summaries=$(lines "$run/logs/history_compaction.jsonl")"
echo "telemetry=$(lines "$run/logs/telemetry.jsonl")"
if [ -f "$run/logs/session_stats.json" ]; then
  echo "session_stats:"
  tr -d '\n ' <"$run/logs/session_stats.json" | head -c 1200
  echo
fi

if [ -d "$HOME/.bench-out" ]; then
  out="$HOME/.bench-out/context-gateway-$(date +%Y%m%dT%H%M%S)"
  mkdir -p "$out" && cp -R "$run/logs" "$run/gateway.out" "$out/" 2>/dev/null
  echo "copied=$out"
fi

if [ -f "$run/gateway.pid" ]; then
  kill "$(cat "$run/gateway.pid")" 2>/dev/null && echo "gateway stopped"
fi
exit 0
