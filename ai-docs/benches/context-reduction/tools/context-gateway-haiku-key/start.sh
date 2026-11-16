#!/bin/sh
# Runs as a provision step before the agent starts. Starts the usage recorder
# and Context Gateway with this variant's config, then deletes the key file.
#
# The key arrives as ~/.config/context-gateway/.env, a file the Bench copies
# in. The gateway loads that file into its own environment at startup, so the
# key reaches the gateway process and nothing else: this script never reads
# it into a variable, starts the gateway with no inherited ANTHROPIC_API_KEY,
# and deletes the file before the agent starts.
#
# This variant has its own ports (gateway 18433, recorder 18434), so it never
# stops a gateway another variant left on 18431.
#
# Nothing stops a process a provision step leaves behind at sandbox level
# `home`, so three things bound its life: this script first stops a process an
# earlier run left on the ports, evidence.sh stops both after the agent, and a
# timer stops both after 100 minutes whatever happened.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
port=18433
rport=18434
gw=${CONTEXT_GATEWAY_BIN:-$HOME/.local/bin/context-gateway}
run="$HOME/.context-gateway-bench"
keyfile="$HOME/.config/context-gateway/.env"

# Fail closed. Without a key the gateway would sign its Haiku calls with
# Claude Code's login instead, which is a different variant.
if ! grep -qE '^ANTHROPIC_API_KEY=["'"'"']?sk-ant-' "$keyfile" 2>/dev/null; then
  echo "start: no ANTHROPIC_API_KEY line in $keyfile; pass gateway_env=<file>" >&2
  rm -f "$keyfile"
  exit 1
fi

for p in "$port" "$rport"; do
  stale=$(lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$stale" ]; then
    echo "start: stopping a process left on port $p (pid $stale)"
    kill $stale 2>/dev/null || true
    sleep 1
  fi
done

# When the run shares an output folder, the logs live there from the start:
# a Session that errors gets no Checks, and its sandbox, logs included, is
# deleted.
if [ -d "$HOME/.bench-out" ]; then
  live="$HOME/.bench-out/context-gateway-haiku-key-live-$(date +%Y%m%dT%H%M%S)"
  mkdir -p "$live"
  ln -sfn "$live" "$run"
  echo "start: logs in $live"
fi
mkdir -p "$run/logs"
cd "$run"

nohup bun "$here/usage-recorder.ts" "$rport" "$run/logs/haiku_calls.jsonl" \
  >"$run/recorder.out" 2>&1 </dev/null &
rpid=$!
echo "$rpid" >"$run/recorder.pid"

# The gateway loads the key file without overriding a variable that is
# already set, and a provision step inherits madbench's environment. So the
# gateway starts without ANTHROPIC_API_KEY, and the file is its only source.
nohup env -u ANTHROPIC_API_KEY "$gw" serve --config "$here/config.yaml" --no-banner \
  >"$run/gateway.out" 2>&1 </dev/null &
pid=$!
echo "$pid" >"$run/gateway.pid"

(sleep 6000; kill "$pid" "$rpid" 2>/dev/null) >/dev/null 2>&1 </dev/null &

ok=""
n=0
while [ "$n" -lt 40 ]; do
  if curl -fsS -o /dev/null "http://localhost:$port/health" 2>/dev/null &&
    curl -fsS -o /dev/null "http://127.0.0.1:$rport/health" 2>/dev/null; then
    ok=1
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null || ! kill -0 "$rpid" 2>/dev/null; then
    break
  fi
  n=$((n + 1))
  sleep 0.5
done

# The gateway read the file at startup; nothing needs it after this line.
rm -f "$keyfile"

if [ -z "$ok" ]; then
  echo "start: gateway or recorder did not answer" >&2
  tail -20 "$run/gateway.out" "$run/recorder.out" >&2 || true
  kill "$pid" "$rpid" 2>/dev/null || true
  exit 1
fi
echo "start: gateway pid $pid on port $port, recorder pid $rpid on port $rport; key file removed"
