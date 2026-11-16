#!/bin/sh
# Runs after the agent stopped. Prints which models answered the subagents'
# calls. The variant's subagent, output-digest, must run on claude-haiku-5-5.
here=$(cd "$(dirname "$0")" && pwd)
echo "variant=haiku-subagent"
echo "tool=output-digest on claude-haiku-5-5"
sh "$here/model-check.sh"
exit 0
