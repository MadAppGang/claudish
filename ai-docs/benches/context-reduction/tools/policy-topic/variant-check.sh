#!/bin/sh
# The topic arm of the history-policy experiment. Passes only when the
# history-policy check passes for policy "topic" AND, when the run's config
# names the embed decider, the prep found Ollama reachable from inside the
# sandbox. Without Ollama the embed decider holds every time, and the arm
# would run as a plain threshold arm with nothing to say so.
#
# Reads the decider's name from ~/.claudish/config.json; prints no value of
# that file except the decider name.
here=$(cd "$(dirname "$0")" && pwd)
fail=0
sh "$here/../history-policy/variant-check.sh" topic || fail=1

decider=$(bun -e 'const c = await Bun.file(process.argv[1]).json(); console.log(c?.compaction?.history?.topic?.decider ?? "absent")' "$HOME/.claudish/config.json" 2>/dev/null)
ollama=$(cat "$HOME/.bench-compaction/ollama-status" 2>/dev/null)
echo "topic decider: ${decider:-unreadable}; ollama: ${ollama:-no status (prep was not topic-change)}"
if [ "$decider" = "embed" ]; then
  case "$ollama" in
    reachable*) ;;
    *) fail=1 ;;
  esac
fi
exit "$fail"
