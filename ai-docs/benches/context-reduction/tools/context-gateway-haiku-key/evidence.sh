#!/bin/sh
# Runs after the agent stopped. Prints the Haiku calls' usage from the
# recorder, the gateway's own counts (the shared script, which also copies the
# logs out and stops the gateway), and stops the recorder.
here=$(cd "$(dirname "$0")" && pwd)
run="$HOME/.context-gateway-bench"
calls="$run/logs/haiku_calls.jsonl"

if [ -f "$calls" ]; then
  bun -e '
    const lines = (await Bun.file(process.argv[1]).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sum = { calls: lines.length, status200: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    for (const c of lines) {
      if (c.status === 200) sum.status200++;
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) sum[k] += c.usage?.[k] ?? 0;
    }
    console.log("haiku_usage=" + JSON.stringify(sum));
  ' "$calls"
else
  echo "haiku_usage=absent"
fi

# The shared script's "summaries" counts every line of the compaction log,
# and the gateway writes one logger_initialized line at startup.
log="$run/logs/history_compaction.jsonl"
if [ -f "$log" ]; then
  echo "summary_events=$(grep -vc '"event":"logger_initialized"' "$log")"
else
  echo "summary_events=absent"
fi

sh "$here/../context-gateway/evidence.sh" context-gateway-haiku-key

if [ -f "$run/recorder.pid" ]; then
  kill "$(cat "$run/recorder.pid")" 2>/dev/null && echo "recorder stopped"
fi
exit 0
