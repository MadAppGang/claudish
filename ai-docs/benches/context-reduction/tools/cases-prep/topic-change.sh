#!/bin/sh
# The topic-change case: as long-session (dependencies, a 200,000-token
# auto-compact window), plus the Ollama address claudish's embed decider
# reads from the environment, and a reachability test of that address from
# inside the sandbox.
#
# The test never stops the trial: every variant runs this prep, and only the
# topic+embed variant needs Ollama. The result goes to
# ~/.bench-compaction/ollama-status ("reachable <model>" or "unreachable
# <reason>"), which that variant's variant check reads.
set -eu
bun install --frozen-lockfile
mkdir -p "$HOME/.bench-compaction"
host=http://127.0.0.1:11434
{
  echo "CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000"
  echo "OLLAMA_HOST=$host"
} >"$HOME/.bench-compaction/launch-env"
echo "prep: topic-change: launch-env sets CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000 and OLLAMA_HOST=$host"

status="unreachable no answer from $host/api/embed"
answer=$(curl -s -m 20 "$host/api/embed" -d '{"model":"nomic-embed-text","input":"reachability"}' 2>&1) || true
case "$answer" in
  *'"embeddings":[['*) status="reachable nomic-embed-text" ;;
  *'"error"'*) status="unreachable $(echo "$answer" | cut -c1-160)" ;;
esac
echo "$status" >"$HOME/.bench-compaction/ollama-status"
echo "prep: ollama $status"
