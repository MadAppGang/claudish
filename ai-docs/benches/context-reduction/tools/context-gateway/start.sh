#!/bin/sh
# Runs as a provision step before the agent starts. Starts Context Gateway on
# the port settings.json points Claude Code at, and waits until it answers.
#
# Nothing stops a process a provision step leaves behind at sandbox level
# `home`, so three things bound its life: this script first stops a gateway an
# earlier run left on the port, evidence.sh stops it after the agent, and a
# timer stops it after 100 minutes whatever happened.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
port=18431
gw=${CONTEXT_GATEWAY_BIN:-$HOME/.local/bin/context-gateway}
run="$HOME/.context-gateway-bench"

stale=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$stale" ]; then
  echo "start: stopping a gateway left on port $port (pid $stale)"
  kill $stale 2>/dev/null || true
  sleep 1
fi

mkdir -p "$run/logs"
cd "$run"
nohup "$gw" serve --config "$here/config.yaml" --no-banner \
  >"$run/gateway.out" 2>&1 </dev/null &
pid=$!
echo "$pid" >"$run/gateway.pid"

(sleep 6000; kill "$pid" 2>/dev/null) >/dev/null 2>&1 </dev/null &

n=0
while [ "$n" -lt 40 ]; do
  if curl -fsS -o /dev/null "http://localhost:$port/health" 2>/dev/null; then
    echo "start: gateway pid $pid answers on port $port"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "start: gateway exited before it answered" >&2
    tail -20 "$run/gateway.out" >&2 || true
    exit 1
  fi
  n=$((n + 1))
  sleep 0.5
done
echo "start: gateway did not answer on port $port in 20 s" >&2
tail -20 "$run/gateway.out" >&2 || true
exit 1
